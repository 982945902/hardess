type Config = {
  wsUrl: string;
  connections: number;
  messagesPerConnection: number;
  connectTimeoutMs: number;
};

type LatencySummary = {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
};

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0,
    };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    avgMs: total / values.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p99Ms: percentile(values, 0.99),
  };
}

function loadConfig(): Config {
  return {
    wsUrl: envString("WS_BENCH_URL", "ws://127.0.0.1:6190/ws"),
    connections: envNumber("WS_BENCH_CONNECTIONS", 50),
    messagesPerConnection: envNumber("WS_BENCH_MESSAGES_PER_CONNECTION", 200),
    connectTimeoutMs: envNumber("WS_BENCH_CONNECT_TIMEOUT_MS", 5_000),
  };
}

async function connectWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {}
      reject(new Error(`timed out connecting to ${url}`));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`websocket error while connecting to ${url}`));
    });
  });
}

async function runConnection(
  config: Config,
  connectionIndex: number,
  latenciesMs: number[],
): Promise<void> {
  const socket = await connectWebSocket(config.wsUrl, config.connectTimeoutMs);
  const pending = new Map<string, number>();
  let nextMessageIndex = 0;
  let completed = 0;

  const sendNext = () => {
    if (nextMessageIndex >= config.messagesPerConnection) {
      return;
    }
    const payload = `c${connectionIndex}-m${nextMessageIndex}`;
    pending.set(payload, performance.now());
    socket.send(payload);
    nextMessageIndex += 1;
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const payload = String(event.data ?? "");
      const sentAt = pending.get(payload);
      if (sentAt === undefined) {
        reject(new Error(`unexpected echo payload: ${payload}`));
        return;
      }
      pending.delete(payload);
      latenciesMs.push(performance.now() - sentAt);
      completed += 1;
      if (completed >= config.messagesPerConnection) {
        socket.close();
        resolve();
        return;
      }
      sendNext();
    });

    socket.addEventListener("close", (event) => {
      if (completed >= config.messagesPerConnection) {
        resolve();
        return;
      }
      reject(new Error(`socket closed early: code=${event.code} reason=${event.reason}`));
    });

    socket.addEventListener("error", () => {
      reject(new Error("websocket error during benchmark"));
    });

    sendNext();
  });
}

async function main() {
  const config = loadConfig();
  const latenciesMs: number[] = [];
  const startedAt = performance.now();

  await Promise.all(
    Array.from({ length: config.connections }, (_, index) =>
      runConnection(config, index, latenciesMs),
    ),
  );

  const elapsedMs = performance.now() - startedAt;
  const totalMessages = config.connections * config.messagesPerConnection;

  console.log(
    JSON.stringify(
      {
        kind: "ws_roundtrip_benchmark",
        config,
        summary: {
          totalMessages,
          elapsedMs,
          messagesPerSecond: elapsedMs > 0 ? (totalMessages * 1000) / elapsedMs : 0,
          latencyMs: summarize(latenciesMs),
        },
      },
      null,
      2,
    ),
  );
}

await main();
