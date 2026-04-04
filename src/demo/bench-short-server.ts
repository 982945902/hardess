export {};

import { createRuntimeApp } from "../runtime/app.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }): Promise<Response> | Response | undefined;
    websocket: Record<string, unknown>;
  }): { port: number };
};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const port = Number(env.process?.env?.PORT ?? 3102);
const app = await createRuntimeApp({
  configModulePath: "./config/bench-short.config.ts"
});

const server = Bun.serve({
  port,
  async fetch(request, serverRef) {
    return app.fetch(request, serverRef);
  },
  websocket: app.websocket
});

app.logger.info("bench short runtime listening", { port: server.port });
