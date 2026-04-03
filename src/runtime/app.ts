import { DemoBearerAuthProvider } from "./auth/provider.ts";
import { RuntimeAuthService } from "./auth/service.ts";
import { ModuleConfigStore } from "./config/store.ts";
import { handleHttpRequest } from "./ingress/http.ts";
import { createWebSocketHandlers } from "./ingress/websocket.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
import { NoopMetrics, type Metrics } from "./observability/metrics.ts";
import { chatServerModule } from "./protocol/chat-module.ts";
import { demoServerModule } from "./protocol/demo-module.ts";
import { ServerProtocolRegistry } from "./protocol/registry.ts";
import { Dispatcher } from "./routing/dispatcher.ts";
import { InMemoryPeerLocator } from "./routing/peer-locator.ts";
import { invalidateWorkers } from "./workers/loader.ts";

export interface RuntimeAppOptions {
  configModulePath?: string;
  logger?: Logger;
  metrics?: Metrics;
  nodeId?: string;
  websocket?: {
    heartbeatIntervalMs?: number;
    staleAfterMs?: number;
    maxConnections?: number;
    maxConnectionsPerPeer?: number;
    rateLimit?: {
      windowMs: number;
      maxMessages: number;
    };
    outbound?: {
      maxQueueMessages: number;
      maxQueueBytes: number;
    };
  };
}

export interface UpgradeServerRef {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
}

export async function createRuntimeApp(options: RuntimeAppOptions = {}) {
  const logger = options.logger ?? new ConsoleLogger();
  const metrics = options.metrics ?? new NoopMetrics();
  const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
  const peerLocator = new InMemoryPeerLocator();
  const dispatcher = new Dispatcher(peerLocator);
  const registry = new ServerProtocolRegistry();
  const configStore = new ModuleConfigStore(
    options.configModulePath ?? "./config/hardess.config.ts",
    "hardessConfig",
    logger
  );

  registry.register(demoServerModule);
  registry.register(chatServerModule);
  await configStore.reload();
  let workerEntries = new Set(
    configStore.getConfig().pipelines
      .map((pipeline) => pipeline.worker?.entry)
      .filter((entry): entry is string => Boolean(entry))
  );
  const unsubscribeConfig = configStore.subscribe((config) => {
    const nextWorkerEntries = new Set(
      config.pipelines
        .map((pipeline) => pipeline.worker?.entry)
        .filter((entry): entry is string => Boolean(entry))
    );
    invalidateWorkers(Array.from(new Set([...workerEntries, ...nextWorkerEntries])));
    workerEntries = nextWorkerEntries;
  });
  configStore.watch();

  const websocket = createWebSocketHandlers({
    nodeId: options.nodeId ?? "local",
    authService,
    peerLocator,
    dispatcher,
    registry,
    logger,
    metrics,
    heartbeatIntervalMs: options.websocket?.heartbeatIntervalMs,
    staleAfterMs: options.websocket?.staleAfterMs,
    maxConnections: options.websocket?.maxConnections,
    maxConnectionsPerPeer: options.websocket?.maxConnectionsPerPeer,
    rateLimit: options.websocket?.rateLimit,
    outbound: options.websocket?.outbound
  });

  return {
    logger,
    metrics,
    authService,
    peerLocator,
    dispatcher,
    registry,
    configStore,
    websocket,
    dispose() {
      unsubscribeConfig();
      configStore.dispose();
      websocket.dispose();
    },
    async fetch(request: Request, serverRef: UpgradeServerRef): Promise<Response | undefined> {
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

        return new Response("WebSocket upgrade failed", { status: 426 });
      }

      return handleHttpRequest(request, {
        configStore,
        authService,
        logger,
        metrics
      });
    }
  };
}
