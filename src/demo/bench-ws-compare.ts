export {};

import { HardessClient, type ClientProtocolModule } from "../sdk/index.ts";

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
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

type WsBenchSummary = {
  name: string;
  protocol: string;
  ackMode: "none" | "recv";
  attemptedMessages: number;
  succeeded: number;
  failed: number;
  deliveredMessages?: number;
  deliveryRatio?: number;
  messagesPerSecond: number;
  elapsedMs: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  failureCodes: Record<string, number>;
  routePartialFailures: number;
  routeFailureCodes: Record<string, number>;
};

async function runBareCase(
  name: string,
  wsUrl: string,
  clients: number,
  messagesPerClient: number
): Promise<WsBenchSummary> {
  const latencies: number[] = [];
  const failureCodes: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;

  await Promise.all(
    Array.from({ length: clients }, async (_, index) => {
      const socket = new WebSocket(wsUrl);
      const pending = new Map<string, { sentAt: number; resolve: () => void; reject: (error: Error) => void }>();
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`bare socket open failed for client-${index}`)), { once: true });
      });

      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data ?? "");
        const match = pending.get(data);
        if (!match) {
          return;
        }
        pending.delete(data);
        latencies.push(Date.now() - match.sentAt);
        match.resolve();
      });

      socket.addEventListener("close", () => {
        for (const [id, entry] of pending.entries()) {
          pending.delete(id);
          failed += 1;
          failureCodes["SOCKET_CLOSED"] = (failureCodes["SOCKET_CLOSED"] ?? 0) + 1;
          entry.reject(new Error(`socket closed before echo: ${id}`));
        }
      });

      for (let i = 0; i < messagesPerClient; i += 1) {
        const id = `c${index}-m${i}-${crypto.randomUUID()}`;
        const startedAt = Date.now();
        const result = new Promise<void>((resolve, reject) => {
          pending.set(id, {
            sentAt: startedAt,
            resolve,
            reject
          });
        });
        socket.send(id);

        try {
          await Promise.race([
            result,
            sleep(5000).then(() => {
              throw new Error("CLIENT_TIMEOUT");
            })
          ]);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          const key = error instanceof Error ? error.message : String(error);
          failureCodes[key] = (failureCodes[key] ?? 0) + 1;
          pending.delete(id);
        }
      }

      socket.close();
    })
  );

  const attemptedMessages = clients * messagesPerClient;
  const elapsedMs = latencies.length > 0 ? Math.max(...latencies) + 1 : 1;

  return {
    name,
    protocol: "bare",
    ackMode: "none",
    attemptedMessages,
    succeeded,
    failed,
    messagesPerSecond: Number((attemptedMessages / (elapsedMs / 1000)).toFixed(2)),
    elapsedMs,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0
    },
    failureCodes,
    routePartialFailures: 0,
    routeFailureCodes: {}
  };
}

async function connectHardessClient(
  wsUrl: string,
  peerId: string,
  module?: ClientProtocolModule<any, any>
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
      onTransportError(info) {
        rejectAuth(new Error(info.message ?? `transport error for ${peerId}`));
      },
      onClose(info) {
        rejectAuth(new Error(`close ${info.code ?? "unknown"} for ${peerId}`));
      }
    }
  });

  if (module) {
    client.use(module);
  }

  client.connect(`demo:${peerId}`);
  await Promise.race([
    authPromise,
    sleep(5000).then(() => {
      throw new Error(`auth timeout for ${peerId}`);
    })
  ]);
  return client;
}

async function runHardessEchoCase(
  name: string,
  wsUrl: string,
  clients: number,
  messagesPerClient: number,
  options: {
    protocol: string;
    routeMode: "self" | "paired";
    ackMode: "recv";
    includeMissingRecipient?: boolean;
  }
): Promise<WsBenchSummary> {
  const latencies: number[] = [];
  const failureCodes: Record<string, number> = {};
  const routeFailureCodes: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;
  let routePartialFailures = 0;

  const echoModule: ClientProtocolModule<
    { toPeerId?: string; peerIds?: string[]; content: string },
    { fromPeerId: string; content: string }
  > = {
    protocol: options.protocol,
    version: "1.0",
    inbound: {
      actions: {
        async message() {}
      }
    }
  };

  const receiverIds = Array.from({ length: clients }, (_, index) => `receiver-${name}-${index + 1}`);
  const senderIds = Array.from({ length: clients }, (_, index) => `sender-${name}-${index + 1}`);
  const pairedMode = options.routeMode === "paired";
  const receivers = pairedMode
    ? await Promise.all(receiverIds.map((peerId) => connectHardessClient(wsUrl, peerId, echoModule)))
    : [];
  const activePeerIds = pairedMode ? senderIds : Array.from({ length: clients }, (_, index) => `loop-${name}-${index + 1}`);
  const senders = await Promise.all(activePeerIds.map((peerId) => connectHardessClient(wsUrl, peerId, echoModule)));

  const startedAt = Date.now();
  try {
    await Promise.all(
      senders.map(async (client, index) => {
        for (let i = 0; i < messagesPerClient; i += 1) {
          const targetPeerId = pairedMode
            ? receiverIds[(index + i) % receiverIds.length] ?? receiverIds[0] ?? "receiver"
            : activePeerIds[index] ?? "self";
          const sentAt = Date.now();
          const payload = options.protocol === "fanout-bench"
            ? {
                peerIds: options.includeMissingRecipient
                  ? [targetPeerId, `missing-${index}-${i}`]
                  : [targetPeerId],
                content: `echo:${index}:${i}:${crypto.randomUUID()}`
              }
            : {
                toPeerId: targetPeerId,
                content: `echo:${index}:${i}:${crypto.randomUUID()}`
              };

          try {
            const receipt = await client.emitAndWait(
              {
                protocol: options.protocol,
                version: "1.0",
                action: "send",
                payload
              },
              {
                ack: options.ackMode,
                resultTimeoutMs: 5000
              }
            );
            succeeded += 1;
            latencies.push(Date.now() - sentAt);
            if (receipt.result?.partialFailure) {
              routePartialFailures += 1;
              for (const routeFailure of receipt.result.failed) {
                routeFailureCodes[routeFailure.code] = (routeFailureCodes[routeFailure.code] ?? 0) + 1;
              }
            }
          } catch (error) {
            failed += 1;
            const key =
              error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
                ? String((error as { code?: string }).code)
                : error instanceof Error
                  ? error.message
                  : String(error);
            failureCodes[key] = (failureCodes[key] ?? 0) + 1;
          }
        }
      })
    );
  } finally {
    for (const client of [...senders, ...receivers]) {
      client.close();
    }
  }

  const attemptedMessages = clients * messagesPerClient;
  const elapsedMs = Date.now() - startedAt;

  return {
    name,
    protocol: options.protocol,
    ackMode: options.ackMode,
    attemptedMessages,
    succeeded,
    failed,
    messagesPerSecond: elapsedMs > 0 ? Number((attemptedMessages / (elapsedMs / 1000)).toFixed(2)) : attemptedMessages,
    elapsedMs,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0
    },
    failureCodes,
    routePartialFailures,
    routeFailureCodes
  };
}

async function runHardessNoAckCase(
  name: string,
  wsUrl: string,
  clients: number,
  messagesPerClient: number
): Promise<WsBenchSummary> {
  let inboundMessages = 0;
  const failureCodes: Record<string, number> = {};
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

  const receiverIds = Array.from({ length: clients }, (_, index) => `receiver-${name}-${index + 1}`);
  const senderIds = Array.from({ length: clients }, (_, index) => `sender-${name}-${index + 1}`);
  const receivers = await Promise.all(receiverIds.map((peerId) => connectHardessClient(wsUrl, peerId, receiverModule)));
  const senders = await Promise.all(senderIds.map((peerId) => connectHardessClient(wsUrl, peerId, senderModule)));

  const attemptedMessages = clients * messagesPerClient;
  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;

  try {
    await Promise.all(
      senders.map(async (client, senderIndex) => {
        for (let i = 0; i < messagesPerClient; i += 1) {
          const targetPeerId = receiverIds[(senderIndex * messagesPerClient + i) % receiverIds.length] ?? receiverIds[0] ?? "receiver";
          try {
            client.emit({
              protocol: "demo",
              version: "1.0",
              action: "send",
              ack: "none",
              payload: {
                toPeerId: targetPeerId,
                content: `no-ack:${senderIndex}:${i}:${crypto.randomUUID()}`
              }
            });
            succeeded += 1;
          } catch (error) {
            failed += 1;
            const key = error instanceof Error ? error.message : String(error);
            failureCodes[key] = (failureCodes[key] ?? 0) + 1;
          }
        }
      })
    );

    await sleep(300);
  } finally {
    for (const client of [...senders, ...receivers]) {
      client.close();
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    name,
    protocol: "demo",
    ackMode: "none",
    attemptedMessages,
    succeeded,
    failed,
    deliveredMessages: inboundMessages,
    deliveryRatio: attemptedMessages > 0 ? Number((inboundMessages / attemptedMessages).toFixed(4)) : 0,
    messagesPerSecond: elapsedMs > 0 ? Number((attemptedMessages / (elapsedMs / 1000)).toFixed(2)) : attemptedMessages,
    elapsedMs,
    latencyMs: {
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0
    },
    failureCodes,
    routePartialFailures: 0,
    routeFailureCodes: {}
  };
}

const clients = envNumber("CLIENTS", 10);
const messagesPerClient = envNumber("MESSAGES_PER_CLIENT", 50);

const bare = spawnBun(["run", "src/demo/bench-ws-bare.ts"]);
const authOnly = spawnBun(["run", "src/demo/bench-ws-hardess-auth.ts"]);
const full = spawnBun(["run", "src/runtime/server.ts"]);

try {
  await waitForHttp("http://127.0.0.1:3201/", 10_000);
  await waitForHttp("http://127.0.0.1:3202/", 10_000);
  await waitForHttp("http://127.0.0.1:3000/demo/orders", 10_000);

  const [bareResult, noAckResult, authOnlyResult, fullRecvAckResult, fullChatResult, partialFailureResult] = await Promise.all([
    runBareCase("bun-ws-bare", "ws://127.0.0.1:3201/ws", clients, messagesPerClient),
    runHardessNoAckCase("hardess-ws-no-ack", "ws://127.0.0.1:3000/ws", clients, messagesPerClient),
    runHardessEchoCase("hardess-ws-auth-only", "ws://127.0.0.1:3202/ws", clients, messagesPerClient, {
      protocol: "loop",
      routeMode: "self",
      ackMode: "recv"
    }),
    runHardessEchoCase("hardess-ws-full-recvAck", "ws://127.0.0.1:3000/ws", clients, messagesPerClient, {
      protocol: "echo",
      routeMode: "paired",
      ackMode: "recv"
    }),
    runHardessEchoCase("hardess-ws-full-chat", "ws://127.0.0.1:3000/ws", clients, messagesPerClient, {
      protocol: "chat",
      routeMode: "paired",
      ackMode: "recv"
    }),
    runHardessEchoCase("hardess-ws-partial-failure", "ws://127.0.0.1:3000/ws", clients, messagesPerClient, {
      protocol: "fanout-bench",
      routeMode: "paired",
      ackMode: "recv",
      includeMissingRecipient: true
    })
  ]);

  const baselineMps = bareResult.messagesPerSecond || 1;
  const comparison = [bareResult, noAckResult, authOnlyResult, fullRecvAckResult, fullChatResult, partialFailureResult].map((entry) => ({
    name: entry.name,
    protocol: entry.protocol,
    ackMode: entry.ackMode,
    messagesPerSecond: entry.messagesPerSecond,
    mpsVsBare: Number((entry.messagesPerSecond / baselineMps).toFixed(4)),
    p50: entry.latencyMs.p50,
    p95: entry.latencyMs.p95,
    failed: entry.failed,
    routePartialFailures: entry.routePartialFailures,
    deliveredMessages: entry.deliveredMessages,
    deliveryRatio: entry.deliveryRatio
  }));

  console.log(JSON.stringify({
    type: "bench-ws-compare",
    clients,
    messagesPerClient,
    comparison,
    details: [bareResult, noAckResult, authOnlyResult, fullRecvAckResult, fullChatResult, partialFailureResult]
  }, null, 2));
} finally {
  for (const process of [bare, authOnly, full]) {
    process.kill();
    await process.exited;
  }
}
