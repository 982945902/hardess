export {};

import { HardessClient, type ClientProtocolModule } from "../sdk/index.ts";

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
  };
};

declare const Bun: {
  spawn(options: {
    cmd: string[];
    cwd: string;
    stdout: "pipe";
    stderr: "pipe";
  }): {
    kill(): void;
    exited: Promise<number>;
  };
};

function envNumber(name: string, fallback: number): number {
  const raw = env.process?.env?.[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status >= 400) {
        return;
      }
    } catch {
      // ignore until ready
    }
    await sleep(200);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function spawnBun(args: string[]): ReturnType<typeof Bun.spawn> {
  const bunPath = env.process?.execPath ?? "bun";
  return Bun.spawn({
    cmd: [bunPath, ...args],
    cwd: "D:/code/hardess",
    stdout: "pipe",
    stderr: "pipe"
  });
}

async function connectHardessClient(
  wsUrl: string,
  peerId: string,
  module: ClientProtocolModule<any, any>,
  handlers: {
    onResult?: () => void;
    onError?: () => void;
    onTransportError?: () => void;
  } = {}
): Promise<HardessClient> {
  let resolveAuth!: () => void;
  let rejectAuth!: (error: Error) => void;
  const authPromise = new Promise<void>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });

  const client = new HardessClient(wsUrl, {
    transport: {
      reconnect: {
        enabled: false
      }
    },
    systemHandlers: {
      onAuthOk() {
        resolveAuth();
      },
      onResult() {
        handlers.onResult?.();
      },
      onError() {
        handlers.onError?.();
      },
      onTransportError(info) {
        handlers.onTransportError?.();
        rejectAuth(new Error(info.message ?? `transport error for ${peerId}`));
      },
      onClose(info) {
        rejectAuth(new Error(`close ${info.code ?? "unknown"} for ${peerId}`));
      }
    }
  });

  client.use(module);
  client.connect(`demo:${peerId}`);

  await Promise.race([
    authPromise,
    sleep(5000).then(() => {
      throw new Error(`auth timeout for ${peerId}`);
    })
  ]);

  return client;
}

const wsUrl = env.process?.env?.WS_URL ?? "ws://127.0.0.1:3000/ws";
const receiverCount = envNumber("RECEIVERS", 10);
const senderCount = envNumber("SENDERS", 10);
const messagesPerSender = envNumber("MESSAGES_PER_SENDER", 100);
const settleMs = envNumber("SETTLE_MS", 300);

const receiverIds = Array.from({ length: receiverCount }, (_, index) => `receiver-no-ack-${index + 1}`);
const senderIds = Array.from({ length: senderCount }, (_, index) => `sender-no-ack-${index + 1}`);

let inboundMessages = 0;
let senderResults = 0;
let senderErrors = 0;
let senderTransportErrors = 0;

const receiverModule: ClientProtocolModule<
  { toPeerId: string; content: string },
  { toPeerId: string; content: string }
> = {
  protocol: "demo",
  version: "1.0",
  inbound: {
    actions: {
      async send() {
        inboundMessages += 1;
      }
    }
  }
};

const senderModule: ClientProtocolModule<
  { toPeerId: string; content: string },
  never
> = {
  protocol: "demo",
  version: "1.0"
};

const runtime = spawnBun(["run", "src/runtime/server.ts"]);

try {
  await waitForHttp("http://127.0.0.1:3000/demo/orders", 10_000);

  const receivers = await Promise.all(
    receiverIds.map((peerId) => connectHardessClient(wsUrl, peerId, receiverModule))
  );
  const senders = await Promise.all(
    senderIds.map((peerId) =>
      connectHardessClient(wsUrl, peerId, senderModule, {
        onResult() {
          senderResults += 1;
        },
        onError() {
          senderErrors += 1;
        },
        onTransportError() {
          senderTransportErrors += 1;
        }
      })
    )
  );

  const attemptedMessages = senderCount * messagesPerSender;
  const startedAt = Date.now();

  await Promise.all(
    senders.map(async (client, senderIndex) => {
      for (let i = 0; i < messagesPerSender; i += 1) {
        const receiverId = receiverIds[(senderIndex * messagesPerSender + i) % receiverIds.length] ?? receiverIds[0] ?? "receiver";
        client.emit({
          protocol: "demo",
          version: "1.0",
          action: "send",
          ack: "none",
          payload: {
            toPeerId: receiverId,
            content: `no-ack:${senderIndex}:${i}:${crypto.randomUUID()}`
          }
        });
      }
    })
  );

  const sendLoopMs = Date.now() - startedAt;
  await sleep(settleMs);
  const elapsedMs = Date.now() - startedAt;

  console.log(JSON.stringify({
    type: "bench-ws-no-ack",
    wsUrl,
    senderCount,
    receiverCount,
    messagesPerSender,
    attemptedMessages,
    settleMs,
    sendLoopMs,
    elapsedMs,
    emittedPerSecond: sendLoopMs > 0 ? Number((attemptedMessages / (sendLoopMs / 1000)).toFixed(2)) : attemptedMessages,
    deliveredPerSecond: elapsedMs > 0 ? Number((inboundMessages / (elapsedMs / 1000)).toFixed(2)) : inboundMessages,
    inboundMessages,
    senderResults,
    senderErrors,
    senderTransportErrors,
    deliveryRatio: attemptedMessages > 0 ? Number((inboundMessages / attemptedMessages).toFixed(4)) : 0
  }, null, 2));

  for (const client of [...senders, ...receivers]) {
    client.close();
  }
} finally {
  runtime.kill();
  await runtime.exited;
}
