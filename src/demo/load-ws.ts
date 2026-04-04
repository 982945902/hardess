import { HardessClient, type ClientProtocolModule } from "../sdk/index.ts";

export {};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
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

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const wsUrl = env.process?.env?.WS_URL ?? "ws://127.0.0.1:3000/ws";
const senderCount = envNumber("SENDERS", 10);
const receiverCount = envNumber("RECEIVERS", 10);
const messagesPerSender = envNumber("MESSAGES_PER_SENDER", 100);
const maxInflightPerSender = envNumber("MAX_INFLIGHT_PER_SENDER", 20);
const heartbeatIntervalMs = envNumber("HEARTBEAT_INTERVAL_MS", 25_000);
const authTimeoutMs = envNumber("AUTH_TIMEOUT_MS", 5_000);
const resultTimeoutMs = envNumber("RESULT_TIMEOUT_MS", 5_000);
const receiverProcessDelayMs = envNumber("RECEIVER_PROCESS_DELAY_MS", 0);
const ackMode = ((env.process?.env?.ACK_MODE ?? "recv") as "recv");

const senderPeerIds = Array.from({ length: senderCount }, (_, index) => `sender-${index + 1}`);
const receiverPeerIds = Array.from({ length: receiverCount }, (_, index) => `receiver-${index + 1}`);

const stats = {
  authenticated: 0,
  inboundMessages: 0,
  resultSeen: 0,
  resultPartialFailures: 0,
  sendSuccess: 0,
  sendFailure: 0,
  closeCodes: {} as Record<string, number>,
  systemErrors: {} as Record<string, number>,
  transportErrors: {} as Record<string, number>,
  sendFailureCodes: {} as Record<string, number>,
  routeFailureCodes: {} as Record<string, number>,
  latencies: [] as number[]
};

const receiverModule: ClientProtocolModule<
  { toPeerId: string; content: string },
  { fromPeerId: string; content: string }
> = {
  protocol: "chat",
  version: "1.0",
  inbound: {
    actions: {
      async message() {
        stats.inboundMessages += 1;
        if (receiverProcessDelayMs > 0) {
          await sleep(receiverProcessDelayMs);
        }
      }
    }
  }
};

const senderModule: ClientProtocolModule<
  { toPeerId: string; content: string },
  { fromPeerId: string; content: string }
> = {
  protocol: "chat",
  version: "1.0",
  outbound: {
    actions: {
      send(ctx) {
        ctx.setStream(`chat:${[ctx.payload.toPeerId].join(":")}`);
        return ctx.payload;
      }
    }
  }
};

async function connectClient(
  peerId: string,
  module: ClientProtocolModule<any, any>
): Promise<HardessClient> {
  let authResolved = false;
  let resolveAuth!: () => void;
  let rejectAuth!: (error: Error) => void;
  const authPromise = new Promise<void>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });

  const client = new HardessClient(wsUrl, {
    heartbeatIntervalMs,
    transport: {
      reconnect: {
        enabled: false
      }
    },
    systemHandlers: {
      onAuthOk() {
        authResolved = true;
        stats.authenticated += 1;
        resolveAuth();
      },
      onClose(info) {
        incrementCounter(stats.closeCodes, String(info.code ?? "unknown"));
        if (!authResolved) {
          rejectAuth(new Error(`socket closed before auth for ${peerId}`));
        }
      },
      onError(payload) {
        incrementCounter(stats.systemErrors, payload.code);
      },
      onTransportError(info) {
        incrementCounter(stats.transportErrors, info.message ?? "unknown");
        if (!authResolved) {
          rejectAuth(new Error(info.message ?? `transport error for ${peerId}`));
        }
      }
    }
  });

  client.use(module);
  client.connect(`demo:${peerId}`);
  await withTimeout(authPromise, authTimeoutMs, `auth ${peerId}`);
  return client;
}

async function runSender(client: HardessClient, senderPeerId: string, senderIndex: number): Promise<void> {
  let nextMessageIndex = 0;

  async function lane(): Promise<void> {
    while (true) {
      const localIndex = nextMessageIndex;
      nextMessageIndex += 1;

      if (localIndex >= messagesPerSender) {
        return;
      }

      const targetPeerId = receiverPeerIds[(senderIndex * messagesPerSender + localIndex) % receiverPeerIds.length];
      const startedAt = Date.now();

      try {
        const receipt = await client.emitAndWait(
          {
            protocol: "chat",
            version: "1.0",
            action: "send",
            payload: {
              toPeerId: targetPeerId,
              content: `load:${senderPeerId}:${localIndex}:${crypto.randomUUID()}`
            }
          },
          {
            ack: ackMode,
            resultTimeoutMs
          }
        );

        stats.sendSuccess += 1;
        stats.latencies.push(Date.now() - startedAt);

        if (receipt.result) {
          stats.resultSeen += 1;
          if (receipt.result.partialFailure) {
            stats.resultPartialFailures += 1;
          }
          for (const failure of receipt.result.failed) {
            incrementCounter(stats.routeFailureCodes, failure.code);
          }
        }
      } catch (error) {
        stats.sendFailure += 1;
        const key =
          error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code?: string }).code)
            : error instanceof Error
              ? error.message
              : String(error);
        incrementCounter(stats.sendFailureCodes, key);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxInflightPerSender, messagesPerSender) }, () => lane())
  );
}

const startedAt = Date.now();
const receiverClients = await Promise.all(
  receiverPeerIds.map((peerId) => connectClient(peerId, receiverModule))
);
const senderClients = await Promise.all(
  senderPeerIds.map((peerId) => connectClient(peerId, senderModule))
);

await Promise.all(
  senderClients.map((client, index) => runSender(client, senderPeerIds[index] ?? `sender-${index + 1}`, index))
);

await sleep(Math.max(receiverProcessDelayMs, 50));

for (const client of [...senderClients, ...receiverClients]) {
  client.close();
}

const elapsedMs = Date.now() - startedAt;
const attemptedMessages = senderCount * messagesPerSender;

console.log(JSON.stringify({
  type: "summary",
  wsUrl,
  ackMode,
  senderCount,
  receiverCount,
  messagesPerSender,
  attemptedMessages,
  maxInflightPerSender,
  authTimeoutMs,
  resultTimeoutMs,
  receiverProcessDelayMs,
  elapsedMs,
  messagesPerSecond: elapsedMs > 0 ? Number((attemptedMessages / (elapsedMs / 1_000)).toFixed(2)) : attemptedMessages,
  authenticated: stats.authenticated,
  inboundMessages: stats.inboundMessages,
  resultSeen: stats.resultSeen,
  resultPartialFailures: stats.resultPartialFailures,
  sendSuccess: stats.sendSuccess,
  sendFailure: stats.sendFailure,
  sendFailureCodes: stats.sendFailureCodes,
  routeFailureCodes: stats.routeFailureCodes,
  systemErrors: stats.systemErrors,
  transportErrors: stats.transportErrors,
  closeCodes: stats.closeCodes,
  latencyMs: {
    min: stats.latencies.length ? Math.min(...stats.latencies) : 0,
    p50: percentile(stats.latencies, 0.5),
    p95: percentile(stats.latencies, 0.95),
    p99: percentile(stats.latencies, 0.99),
    max: stats.latencies.length ? Math.max(...stats.latencies) : 0
  }
}, null, 2));
