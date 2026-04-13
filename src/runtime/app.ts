import { DemoBearerAuthProvider } from "./auth/provider.ts";
import { StaticClusterNetwork, type ClusterPeerNode, type ClusterSocket, type ClusterTransport } from "./cluster/network.ts";
import { DistributedPeerLocator } from "./cluster/peer-locator.ts";
import {
  parseClusterDeliverRequest,
  parseClusterHandleAckRequest,
  parseClusterLocateRequest
} from "./cluster/schema.ts";
import { RuntimeAuthService } from "./auth/service.ts";
import { ModuleConfigStore } from "./config/store.ts";
import { handleHttpRequest } from "./ingress/http.ts";
import { createWebSocketHandlers } from "./ingress/websocket.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
import { InMemoryMetrics, type Metrics, type MetricsSnapshotProvider } from "./observability/metrics.ts";
import { renderPrometheusMetrics } from "./observability/prometheus.ts";
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
  prometheusPrefix?: string;
  cluster?: {
    peers?: ClusterPeerNode[];
    sharedSecret?: string;
    requestTimeoutMs?: number;
    outboundMaxQueueMessages?: number;
    outboundBackpressureRetryMs?: number;
    locatorCacheTtlMs?: number;
    fetchFn?: typeof fetch;
    socketFactory?: (url: string) => ClusterSocket;
    transport?: ClusterTransport;
  };
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
      maxSocketBufferBytes?: number;
      backpressureRetryMs?: number;
    };
  };
}

export interface UpgradeServerRef {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
}

function isMetricsSnapshotProvider(metrics: Metrics): metrics is MetricsSnapshotProvider {
  return typeof (metrics as { snapshot?: unknown }).snapshot === "function";
}

export async function createRuntimeApp(options: RuntimeAppOptions = {}) {
  const logger = options.logger ?? new ConsoleLogger();
  const metrics = options.metrics ?? new InMemoryMetrics();
  const nodeId = options.nodeId ?? "local";
  const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
  const localPeerLocator = new InMemoryPeerLocator();
  const clusterNetwork = new StaticClusterNetwork(options.cluster?.peers ?? [], {
    nodeId,
    sharedSecret: options.cluster?.sharedSecret,
    requestTimeoutMs: options.cluster?.requestTimeoutMs,
    outboundMaxQueueMessages: options.cluster?.outboundMaxQueueMessages,
    outboundBackpressureRetryMs: options.cluster?.outboundBackpressureRetryMs,
    metrics,
    fetchFn: options.cluster?.fetchFn,
    socketFactory: options.cluster?.socketFactory,
    logger,
    transport: options.cluster?.transport
  });
  const peerLocator = new DistributedPeerLocator(
    localPeerLocator,
    clusterNetwork.hasPeers() ? clusterNetwork : undefined,
    options.cluster?.locatorCacheTtlMs
  );
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
  const startedAt = Date.now();
  let shuttingDown = false;
  let disposed = false;
  let inFlightHttpRequests = 0;

  const websocket = createWebSocketHandlers({
    nodeId,
    authService,
    peerLocator: localPeerLocator,
    dispatcher,
    clusterNetwork: clusterNetwork.hasPeers() ? clusterNetwork : undefined,
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
  clusterNetwork.setServerHandlers({
    deliver(payload) {
      return websocket.deliverCluster(payload);
    },
    handleAck(payload) {
      return websocket.forwardClusterHandleAck(payload);
    }
  });
  const runtimeWebsocket = {
    open(socket: { data?: Record<string, unknown> }) {
      if (socket.data?.kind === "cluster") {
        clusterNetwork.openServerSocket(socket as unknown as ClusterSocket);
        return;
      }

      websocket.open(socket as Parameters<typeof websocket.open>[0]);
    },
    async message(socket: { data?: Record<string, unknown> }, raw: string | ArrayBuffer | Uint8Array) {
      if (socket.data?.kind === "cluster") {
        await clusterNetwork.messageServerSocket(socket as unknown as ClusterSocket, raw);
        return;
      }

      await websocket.message(socket as Parameters<typeof websocket.message>[0], raw);
    },
    close(socket: { data?: Record<string, unknown> }) {
      if (socket.data?.kind === "cluster") {
        clusterNetwork.closeServerSocket(socket as unknown as ClusterSocket);
        return;
      }

      websocket.close(socket as Parameters<typeof websocket.close>[0]);
    }
  };

  function json(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body, null, 2), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...init?.headers
      }
    });
  }

  function runtimeState() {
    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      shuttingDown,
      disposed,
      ready: !shuttingDown && !disposed,
      inFlightHttpRequests
    };
  }

  return {
    logger,
    metrics,
    authService,
    peerLocator,
    localPeerLocator,
    clusterNetwork,
    dispatcher,
    registry,
    configStore,
    websocket: runtimeWebsocket,
    beginShutdown() {
      shuttingDown = true;
    },
    dispose() {
      shuttingDown = true;
      disposed = true;
      unsubscribeConfig();
      configStore.dispose();
      websocket.dispose();
      clusterNetwork.dispose();
    },
    async fetch(request: Request, serverRef: UpgradeServerRef): Promise<Response | undefined> {
      const url = new URL(request.url);

      if (url.pathname === "/__admin/health") {
        return json({
          ok: true,
          status: shuttingDown ? "shutting_down" : "ok",
          runtime: runtimeState()
        });
      }

      if (url.pathname === "/__admin/ready") {
        return json(
          {
            ok: !shuttingDown && !disposed,
            status: !shuttingDown && !disposed ? "ready" : "not_ready",
            runtime: runtimeState()
          },
          {
            status: !shuttingDown && !disposed ? 200 : 503
          }
        );
      }

      if (url.pathname === "/__admin/metrics") {
        if (!isMetricsSnapshotProvider(metrics)) {
          return json(
            {
              ok: false,
              error: "Metrics snapshot is not available for the configured metrics sink",
              runtime: runtimeState()
            },
            { status: 501 }
          );
        }

        return json({
          ok: true,
          runtime: runtimeState(),
          metrics: metrics.snapshot()
        });
      }

      if (url.pathname === "/__admin/metrics/prometheus") {
        if (!isMetricsSnapshotProvider(metrics)) {
          return json(
            {
              ok: false,
              error: "Metrics snapshot is not available for the configured metrics sink",
              runtime: runtimeState()
            },
            { status: 501 }
          );
        }

        return new Response(
          renderPrometheusMetrics(metrics.snapshot(), {
            prefix: options.prometheusPrefix
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8"
            }
          }
        );
      }

      if (url.pathname === "/__admin/cluster/peers") {
        return json({
          ok: true,
          nodeId,
          transport: options.cluster?.transport ?? "http",
          peers: clusterNetwork.listPeers()
        });
      }

      if (url.pathname === "/__cluster/locate" && request.method === "POST") {
        try {
          if (options.cluster?.sharedSecret && request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const payload = parseClusterLocateRequest(await request.json());
          const located = await localPeerLocator.findMany(payload.peerIds);

          return json({
            ok: true,
            peers: Object.fromEntries(Array.from(located.entries()))
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            },
            { status: 400 }
          );
        }
      }

      if (url.pathname === "/__cluster/ws") {
        const upgraded = serverRef.upgrade(request, {
          data: {
            kind: "cluster",
            clusterConnId: crypto.randomUUID()
          }
        });

        if (upgraded) {
          return undefined;
        }

        return new Response("Cluster websocket upgrade failed", { status: 426 });
      }

      if (url.pathname === "/__cluster/deliver" && request.method === "POST") {
        try {
          if (options.cluster?.sharedSecret && request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const payload = parseClusterDeliverRequest(await request.json());
          const deliveredConns = await websocket.deliverCluster(payload);
          return json({
            ok: true,
            deliveredConns
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            },
            { status: 400 }
          );
        }
      }

      if (url.pathname === "/__cluster/handle-ack" && request.method === "POST") {
        try {
          if (options.cluster?.sharedSecret && request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const payload = parseClusterHandleAckRequest(await request.json());
          const forwarded = await websocket.forwardClusterHandleAck(payload);
          return json({
            ok: true,
            forwarded
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            },
            { status: 400 }
          );
        }
      }

      if (shuttingDown || disposed) {
        return json(
          {
            ok: false,
            error: "Runtime is shutting down",
            runtime: runtimeState()
          },
          { status: 503 }
        );
      }

      if (url.pathname === "/ws") {
        const upgraded = serverRef.upgrade(request, {
          data: {
            kind: "client",
            connId: crypto.randomUUID()
          }
        });

        if (upgraded) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 426 });
      }

      inFlightHttpRequests += 1;
      try {
        return await handleHttpRequest(request, {
          configStore,
          authService,
          logger,
          metrics
        });
      } finally {
        inFlightHttpRequests -= 1;
      }
    }
  };
}
