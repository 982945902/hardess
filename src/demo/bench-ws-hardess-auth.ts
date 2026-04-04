export {};

import { DemoBearerAuthProvider } from "../runtime/auth/provider.ts";
import { RuntimeAuthService } from "../runtime/auth/service.ts";
import { ConsoleLogger } from "../runtime/observability/logger.ts";
import { NoopMetrics } from "../runtime/observability/metrics.ts";
import { createWebSocketHandlers } from "../runtime/ingress/websocket.ts";
import type { ServerProtocolModule } from "../shared/index.ts";
import { Dispatcher } from "../runtime/routing/dispatcher.ts";
import { InMemoryPeerLocator } from "../runtime/routing/peer-locator.ts";
import { ServerProtocolRegistry } from "../runtime/protocol/registry.ts";

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

const port = Number(env.process?.env?.PORT ?? 3202);
const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
const peerLocator = new InMemoryPeerLocator();
const dispatcher = new Dispatcher(peerLocator);
const registry = new ServerProtocolRegistry();
const loopServerModule: ServerProtocolModule<{ content: string }> = {
  protocol: "loop",
  version: "1.0",
  actions: {
    send: {
      resolveRecipients(ctx) {
        return [ctx.auth.peerId];
      },
      buildDispatch(ctx) {
        return {
          action: "message",
          payload: {
            fromPeerId: ctx.auth.peerId,
            content: ctx.payload.content
          },
          ack: "recv"
        };
      }
    }
  }
};
registry.register(loopServerModule);
const websocket = createWebSocketHandlers({
  nodeId: "bench-auth",
  authService,
  peerLocator,
  dispatcher,
  registry,
  logger: new ConsoleLogger(),
  metrics: new NoopMetrics()
});

const server = Bun.serve({
  port,
  async fetch(request, serverRef) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = serverRef.upgrade(request, {
        data: {
          connId: crypto.randomUUID()
        }
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("upgrade failed", { status: 426 });
    }

    return Response.json({ ok: true, mode: "hardess-ws-auth-only" });
  },
  websocket
});

console.log(`bench ws hardess auth listening on :${server.port}`);
