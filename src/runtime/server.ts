import { createRuntimeApp } from "./app.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }): Promise<Response> | Response | undefined;
    websocket: Record<string, unknown>;
  }): { port: number };
};

const env = globalThis as { process?: { env?: Record<string, string | undefined> } };
const processEnv = env.process?.env ?? {};

function envNumber(name: string): number | undefined {
  const value = processEnv[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const app = await createRuntimeApp({
  configModulePath: processEnv.CONFIG_MODULE_PATH,
  websocket: {
    heartbeatIntervalMs: envNumber("WS_HEARTBEAT_INTERVAL_MS"),
    staleAfterMs: envNumber("WS_STALE_AFTER_MS"),
    maxConnections: envNumber("WS_MAX_CONNECTIONS"),
    maxConnectionsPerPeer: envNumber("WS_MAX_CONNECTIONS_PER_PEER"),
    rateLimit: processEnv.WS_RATE_LIMIT_WINDOW_MS || processEnv.WS_RATE_LIMIT_MAX_MESSAGES
      ? {
          windowMs: envNumber("WS_RATE_LIMIT_WINDOW_MS") ?? 1_000,
          maxMessages: envNumber("WS_RATE_LIMIT_MAX_MESSAGES") ?? 100
        }
      : undefined,
    outbound: processEnv.WS_OUTBOUND_MAX_QUEUE_MESSAGES || processEnv.WS_OUTBOUND_MAX_QUEUE_BYTES
      ? {
          maxQueueMessages: envNumber("WS_OUTBOUND_MAX_QUEUE_MESSAGES") ?? 256,
          maxQueueBytes: envNumber("WS_OUTBOUND_MAX_QUEUE_BYTES") ?? 512 * 1024
        }
      : undefined
  }
});

const server = Bun.serve({
  port: Number(processEnv.PORT ?? 3000),
  async fetch(request, serverRef) {
    return app.fetch(request, serverRef);
  },
  websocket: app.websocket
});

app.logger.info("hardess runtime listening", { port: server.port });
