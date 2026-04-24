import { DemoBearerAuthProvider } from "./auth/provider.ts";
import { ClusterPeerHealthStore } from "./cluster/health.ts";
import { StaticClusterNetwork, type ClusterPeerNode, type ClusterSocket, type ClusterTransport } from "./cluster/network.ts";
import { DistributedPeerLocator } from "./cluster/peer-locator.ts";
import {
  parseClusterDeliverRequest,
  parseClusterHandleAckRequest,
  parseClusterLocateRequest
} from "./cluster/schema.ts";
import { RuntimeAuthService } from "./auth/service.ts";
import { ModuleConfigStore } from "./config/store.ts";
import { RuntimeTopologyStore } from "./control/topology-store.ts";
import { handleHttpRequest } from "./ingress/http.ts";
import { createWebSocketHandlers } from "./ingress/websocket.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
import { InMemoryMetrics, type Metrics, type MetricsSnapshotProvider } from "./observability/metrics.ts";
import { renderPrometheusMetrics } from "./observability/prometheus.ts";
import {
  UpstreamWebSocketProxyRuntime,
  type UpstreamWebSocketFactory
} from "./proxy/upstream-websocket.ts";
import { chatServerModule } from "./protocol/chat-module.ts";
import { demoServerModule } from "./protocol/demo-module.ts";
import { ServerProtocolRegistry } from "./protocol/registry.ts";
import { Dispatcher } from "./routing/dispatcher.ts";
import { InMemoryPeerLocator } from "./routing/peer-locator.ts";
import { buildRuntimeSummaryView } from "./runtime-summary.ts";
import { invalidateWorkers } from "./workers/loader.ts";
import type { ServiceModuleProtocolPackageRef } from "../shared/index.ts";

export interface RuntimeAppOptions {
  configModulePath?: string;
  logger?: Logger;
  metrics?: Metrics;
  nodeId?: string;
  hostGroupId?: string;
  listActiveProtocolPackages?: () => ServiceModuleProtocolPackageRef[];
  prometheusPrefix?: string;
  cluster?: {
    peers?: ClusterPeerNode[];
    sharedSecret?: string;
    requestTimeoutMs?: number;
    outboundMaxQueueMessages?: number;
    outboundMaxQueueBytes?: number;
    outboundBackpressureRetryMs?: number;
    locatorCacheTtlMs?: number;
    peerProbeIntervalMs?: number;
    peerPingTimeoutMs?: number;
    peerSuspectTimeoutMs?: number;
    peerAntiEntropyIntervalMs?: number;
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
    shutdownGraceMs?: number;
  };
  listeners?: {
    business?: {
      allowedPathPrefixes?: string[];
    };
    control?: {
      allowedPathPrefixes?: string[];
    };
    public?: {
      allowedPathPrefixes?: string[];
    };
    internal?: {
      allowedPathPrefixes?: string[];
    };
  };
  upstreamWebSocket?: {
    socketFactory?: UpstreamWebSocketFactory;
  };
  internalForward?: {
    httpTimeoutMs?: number;
    wsConnectTimeoutMs?: number;
  };
}

export interface UpgradeServerRef {
  upgrade(
    request: Request,
    options?: {
      headers?: HeadersInit;
      data?: unknown;
    }
  ): boolean;
}

export type RuntimeListenerName =
  | "default"
  | "business"
  | "control"
  | "public"
  | "internal";

interface RuntimeRequestContext {
  listener?: RuntimeListenerName;
}

const INTERNAL_ONLY_PATH_PREFIXES = ["/__admin", "/__cluster"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneResponseWithBody(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

function isMetricsSnapshotProvider(metrics: Metrics): metrics is MetricsSnapshotProvider {
  return typeof (metrics as { snapshot?: unknown }).snapshot === "function";
}

function normalizeListenerName(listener: RuntimeListenerName): RuntimeListenerName {
  if (listener === "public") {
    return "business";
  }
  if (listener === "internal") {
    return "control";
  }
  return listener;
}

function resolveListenerAllowedPathPrefixes(
  options: RuntimeAppOptions,
  listener: RuntimeListenerName
): string[] | undefined {
  const normalized = normalizeListenerName(listener);
  if (normalized === "business") {
    return options.listeners?.business?.allowedPathPrefixes ?? options.listeners?.public?.allowedPathPrefixes;
  }
  if (normalized === "control") {
    return options.listeners?.control?.allowedPathPrefixes ?? options.listeners?.internal?.allowedPathPrefixes;
  }
  return undefined;
}

export async function createRuntimeApp(options: RuntimeAppOptions = {}) {
  const logger = options.logger ?? new ConsoleLogger();
  const metrics = options.metrics ?? new InMemoryMetrics();
  const nodeId = options.nodeId ?? "local";
  const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
  const localPeerLocator = new InMemoryPeerLocator();
  const topologyStore = new RuntimeTopologyStore();
  const clusterPeerHealth = new ClusterPeerHealthStore({
    suspectTimeoutMs: options.cluster?.peerSuspectTimeoutMs
  });
  const clusterNetwork = new StaticClusterNetwork(options.cluster?.peers ?? [], {
    nodeId,
    sharedSecret: options.cluster?.sharedSecret,
    requestTimeoutMs: options.cluster?.requestTimeoutMs,
    outboundMaxQueueMessages: options.cluster?.outboundMaxQueueMessages,
    outboundMaxQueueBytes: options.cluster?.outboundMaxQueueBytes,
    outboundBackpressureRetryMs: options.cluster?.outboundBackpressureRetryMs,
    peerProbeIntervalMs: options.cluster?.peerProbeIntervalMs,
    peerPingTimeoutMs: options.cluster?.peerPingTimeoutMs,
    peerAntiEntropyIntervalMs: options.cluster?.peerAntiEntropyIntervalMs,
    metrics,
    fetchFn: options.cluster?.fetchFn,
    socketFactory: options.cluster?.socketFactory,
    logger,
    transport: options.cluster?.transport,
    peerHealthObserver: clusterPeerHealth,
    peerHealthSnapshotProvider: () => clusterPeerHealth.list()
  });
  clusterPeerHealth.noteKnownPeers((options.cluster?.peers ?? []).map((peer) => peer.nodeId));
  const peerLocator = new DistributedPeerLocator(
    localPeerLocator,
    clusterNetwork.hasPeers() ? clusterNetwork : undefined,
    options.cluster?.locatorCacheTtlMs,
    undefined,
    (scope) => topologyStore.listClusterPeerNodeIds(nodeId, scope)
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
  const unsubscribeTopology = topologyStore.subscribe((topology) => {
    const dynamicPeers = topologyStore.listClusterPeers(nodeId);
    clusterPeerHealth.noteKnownPeers(dynamicPeers.map((peer) => peer.nodeId));
    topologyStore.clearRuntimePeerHealth(dynamicPeers.map((peer) => peer.nodeId));
    clusterNetwork.setPeers(dynamicPeers);
    logger.info("cluster topology peers updated", {
      nodeId,
      peers: dynamicPeers.map((peer) => peer.nodeId),
      membershipRevision: topology?.membership.revision,
      placementRevision: topology?.placement.revision
    });
  });
  const unsubscribeClusterPeerHealth = clusterPeerHealth.subscribe((snapshot) => {
    topologyStore.setRuntimePeerHealth(snapshot.nodeId, snapshot.status);
    metrics.increment("cluster.peer_health_update");
    metrics.increment(`cluster.peer_health_status.${snapshot.status}`);
    metrics.increment(`cluster.peer_health_source.${snapshot.source}`);
    logger.info("cluster peer health updated", {
      nodeId,
      peerNodeId: snapshot.nodeId,
      status: snapshot.status,
      detail: snapshot.detail,
      source: snapshot.source,
      reportedByNodeId: snapshot.reportedByNodeId
    });
    void clusterNetwork.broadcastPeerHealthRumor(snapshot, {
      excludeNodeIds: [
        snapshot.nodeId,
        ...(snapshot.reportedByNodeId ? [snapshot.reportedByNodeId] : [])
      ]
    }).catch((error) => {
      logger.warn("cluster peer health rumor broadcast failed", {
        nodeId,
        peerNodeId: snapshot.nodeId,
        status: snapshot.status,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (snapshot.status === "dead") {
      clusterNetwork.disconnectPeer(snapshot.nodeId, "cluster peer marked dead");
      peerLocator.invalidate();
    }
  });
  configStore.watch();
  const startedAt = Date.now();
  let shuttingDown = false;
  let disposed = false;
  let inFlightHttpRequests = 0;

  function beginTrackedHttpRequest(): () => void {
    inFlightHttpRequests += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inFlightHttpRequests -= 1;
    };
  }

  function trackHttpResponseLifecycle(
    response: Response | undefined,
    release: () => void
  ): Response | undefined {
    if (!response) {
      release();
      return response;
    }

    if (!response.body) {
      release();
      return response;
    }

    const reader = response.body.getReader();
    const trackedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            try {
              reader.releaseLock();
            } catch {}
            release();
            controller.close();
            return;
          }

          if (next.value) {
            controller.enqueue(next.value);
          }
        } catch (error) {
          try {
            reader.releaseLock();
          } catch {}
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
        release();
      }
    });

    return cloneResponseWithBody(response, trackedBody);
  }

  const websocket = createWebSocketHandlers({
    nodeId,
    hostGroupId: options.hostGroupId,
    authService,
    peerLocator: localPeerLocator,
    dispatcher,
    clusterNetwork: clusterNetwork.hasPeers() ? clusterNetwork : undefined,
    topologyStore,
    listActiveProtocolPackages: options.listActiveProtocolPackages,
    registry,
    logger,
    metrics,
    heartbeatIntervalMs: options.websocket?.heartbeatIntervalMs,
    staleAfterMs: options.websocket?.staleAfterMs,
    maxConnections: options.websocket?.maxConnections,
    maxConnectionsPerPeer: options.websocket?.maxConnectionsPerPeer,
    rateLimit: options.websocket?.rateLimit,
    outbound: options.websocket?.outbound,
    shutdownGraceMs: options.websocket?.shutdownGraceMs
  });
  const upstreamWebSocketProxy = new UpstreamWebSocketProxyRuntime({
    logger,
    metrics,
    socketFactory: options.upstreamWebSocket?.socketFactory
  });
  clusterNetwork.setServerHandlers({
    deliver(payload) {
      return websocket.deliverCluster(payload);
    },
    handleAck(payload) {
      return websocket.forwardClusterHandleAck(payload);
    }
  });
  clusterNetwork.startPeerProbes();
  const runtimeWebsocket = {
    open(socket: { data?: Record<string, unknown> }) {
      if (socket.data?.kind === "cluster") {
        clusterNetwork.openServerSocket(socket as unknown as ClusterSocket);
        return;
      }

      if (socket.data?.kind === "upstream_proxy") {
        upstreamWebSocketProxy.openClientSocket(socket as unknown as Parameters<typeof upstreamWebSocketProxy.openClientSocket>[0]);
        return;
      }

      websocket.open(socket as Parameters<typeof websocket.open>[0]);
    },
    async message(socket: { data?: Record<string, unknown> }, raw: string | ArrayBuffer | Uint8Array) {
      if (socket.data?.kind === "cluster") {
        await clusterNetwork.messageServerSocket(socket as unknown as ClusterSocket, raw);
        return;
      }

      if (socket.data?.kind === "upstream_proxy") {
        upstreamWebSocketProxy.clientMessage(
          socket as unknown as Parameters<typeof upstreamWebSocketProxy.clientMessage>[0],
          raw
        );
        return;
      }

      await websocket.message(socket as Parameters<typeof websocket.message>[0], raw);
    },
    close(socket: { data?: Record<string, unknown> }, code?: number, reason?: string) {
      if (socket.data?.kind === "cluster") {
        clusterNetwork.closeServerSocket(socket as unknown as ClusterSocket);
        return;
      }

      if (socket.data?.kind === "upstream_proxy") {
        upstreamWebSocketProxy.clientClose(
          socket as unknown as Parameters<typeof upstreamWebSocketProxy.clientClose>[0],
          code,
          reason
        );
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

  function isPathAllowedOnListener(pathname: string, listener: RuntimeListenerName): boolean {
    const normalizedListener = normalizeListenerName(listener);
    if (normalizedListener === "default") {
      return true;
    }

    const isInternalOnlyPath = INTERNAL_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    if (isInternalOnlyPath) {
      return normalizedListener === "control";
    }

    const allowedPathPrefixes = resolveListenerAllowedPathPrefixes(options, normalizedListener);

    if (allowedPathPrefixes === undefined) {
      return true;
    }

    return allowedPathPrefixes.some((prefix) => pathname.startsWith(prefix));
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
    topologyStore,
    websocket: runtimeWebsocket,
    runtimeState,
    beginShutdown() {
      shuttingDown = true;
      websocket.beginShutdown();
    },
    async waitForHttpDrain(options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {}): Promise<boolean> {
      const timeoutMs = options.timeoutMs ?? 0;
      const pollIntervalMs = options.pollIntervalMs ?? 25;

      if (inFlightHttpRequests === 0) {
        return true;
      }

      if (timeoutMs <= 0) {
        return false;
      }

      const deadline = Date.now() + timeoutMs;
      while (inFlightHttpRequests > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return false;
        }

        await sleep(Math.min(pollIntervalMs, remainingMs));
      }

      return true;
    },
    dispose() {
      shuttingDown = true;
      disposed = true;
      unsubscribeConfig();
      unsubscribeTopology();
      unsubscribeClusterPeerHealth();
      configStore.dispose();
      websocket.dispose();
      upstreamWebSocketProxy.dispose();
      clusterPeerHealth.dispose();
      clusterNetwork.dispose();
    },
    async fetch(
      request: Request,
      serverRef: UpgradeServerRef,
      context: RuntimeRequestContext = {}
    ): Promise<Response | undefined> {
      const url = new URL(request.url);
      const listener = context.listener ?? "default";

      if (!isPathAllowedOnListener(url.pathname, listener)) {
        return json(
          {
            ok: false,
            error: "Path is not exposed on this listener",
            listener
          },
          { status: 404 }
        );
      }

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

      if (url.pathname === "/__admin/runtime/summary") {
        return json({
          ok: true,
          runtime: runtimeState(),
          summary: buildRuntimeSummaryView({
            config: configStore.getConfig(),
            activeProtocolPackages: options.listActiveProtocolPackages?.() ?? []
          })
        });
      }

      if (url.pathname === "/__cluster/locate" && request.method === "POST") {
        try {
          if (options.cluster?.sharedSecret && request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const payload = parseClusterLocateRequest(await request.json());
          const located = await localPeerLocator.findMany(payload.peerIds, {
            groupId: payload.groupId
          });

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

      if (url.pathname === "/__cluster/ws-forward") {
        try {
          if (
            options.cluster?.sharedSecret &&
            request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret
          ) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const forwardedPath = request.headers.get("x-hardess-forward-path");
          if (!forwardedPath || !forwardedPath.startsWith("/")) {
            return json({ ok: false, error: "Missing x-hardess-forward-path" }, { status: 400 });
          }

          const forwardedHeaders = new Headers(request.headers);
          forwardedHeaders.delete("x-hardess-cluster-secret");
          forwardedHeaders.delete("x-hardess-forward-path");
          forwardedHeaders.set("connection", "Upgrade");
          forwardedHeaders.set("upgrade", "websocket");
          const forwardedRequest = new Request(`http://internal.forward${forwardedPath}`, {
            method: request.method,
            headers: forwardedHeaders,
            redirect: "manual"
          });

          return await handleHttpRequest(forwardedRequest, {
            configStore,
            authService,
            logger,
            metrics,
            nodeId,
            clusterSharedSecret: options.cluster?.sharedSecret,
            topologyStore,
            internalForward: options.internalForward,
            serverRef,
            upstreamWebSocketProxy
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

      if (url.pathname === "/__cluster/http-forward") {
        try {
          if (
            options.cluster?.sharedSecret &&
            request.headers.get("x-hardess-cluster-secret") !== options.cluster.sharedSecret
          ) {
            return json({ ok: false, error: "Unauthorized cluster request" }, { status: 401 });
          }

          const forwardedPath = request.headers.get("x-hardess-forward-path");
          if (!forwardedPath || !forwardedPath.startsWith("/")) {
            return json({ ok: false, error: "Missing x-hardess-forward-path" }, { status: 400 });
          }

          const forwardedHeaders = new Headers(request.headers);
          forwardedHeaders.delete("x-hardess-cluster-secret");
          forwardedHeaders.delete("x-hardess-forward-path");
          const forwardedRequest = new Request(`http://internal.forward${forwardedPath}`, {
            method: request.method,
            headers: forwardedHeaders,
            body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
            redirect: "manual"
          });

          const releaseHttpRequest = beginTrackedHttpRequest();
          try {
            const response = await handleHttpRequest(forwardedRequest, {
              configStore,
              authService,
              logger,
              metrics,
              nodeId,
              clusterSharedSecret: options.cluster?.sharedSecret,
              topologyStore,
              internalForward: options.internalForward,
              serverRef,
              upstreamWebSocketProxy
            });
            return trackHttpResponseLifecycle(response, releaseHttpRequest);
          } catch (error) {
            releaseHttpRequest();
            throw error;
          }
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

      const releaseHttpRequest = beginTrackedHttpRequest();
      try {
        const response = await handleHttpRequest(request, {
          configStore,
          authService,
          logger,
          metrics,
          nodeId,
          clusterSharedSecret: options.cluster?.sharedSecret,
          topologyStore,
          internalForward: options.internalForward,
          serverRef,
          upstreamWebSocketProxy
        });
        return trackHttpResponseLifecycle(response, releaseHttpRequest);
      } catch (error) {
        releaseHttpRequest();
        throw error;
      }
    }
  };
}
