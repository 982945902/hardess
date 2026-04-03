import { createRuntimeApp } from "./app.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }): Promise<Response> | Response | undefined;
    websocket: Record<string, unknown>;
  }): { port: number };
};

const env = globalThis as { process?: { env?: Record<string, string | undefined> } };
const app = await createRuntimeApp();

const server = Bun.serve({
  port: Number(env.process?.env?.PORT ?? 3000),
  async fetch(request, serverRef) {
    return app.fetch(request, serverRef);
  },
  websocket: app.websocket
});

app.logger.info("hardess runtime listening", { port: server.port });
