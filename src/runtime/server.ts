import { createRuntimeApp, type RuntimeListenerName } from "./app.ts";
import { parseClusterPeersEnv, parseClusterTransportEnv } from "./cluster/schema.ts";
import { MetricsAlertMonitor, type MetricsAlertThresholds } from "./observability/alerts.ts";
import { ConsoleLogger } from "./observability/logger.ts";
import { InMemoryMetrics, WindowedMetrics, type MetricsSnapshotProvider } from "./observability/metrics.ts";

declare const Bun: {
  serve(options: {
    port: number;
    fetch(
      request: Request,
      server: {
        upgrade(
          request: Request,
          options?: {
            headers?: HeadersInit;
            data?: unknown;
          }
        ): boolean
      }
    ): Promise<Response | undefined> | Response | undefined;
    websocket: Record<string, unknown>;
  }): {
    port: number;
    stop(closeActiveConnections?: boolean): void | Promise<void>;
  };
};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    exit?(code?: number): never;
    on?(event: string, listener: (...args: unknown[]) => void): void;
  };
};
const processEnv = env.process?.env ?? {};
const bootstrapLogger = new ConsoleLogger();

function envNumber(name: string): number | undefined {
  const value = processEnv[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envString(name: string): string | undefined {
  return processEnv[name];
}

function envPathPrefixes(name: string): string[] | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseClusterPeers() {
  return parseClusterPeersEnv(envString("CLUSTER_PEERS_JSON"));
}

function parseClusterTransport() {
  return parseClusterTransportEnv(envString("CLUSTER_TRANSPORT"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMetricsSink(): { sink: MetricsSnapshotProvider; mode: "inmemory" | "windowed" } {
  const mode = processEnv.METRICS_SINK === "inmemory" ? "inmemory" : "windowed";
  if (mode === "inmemory") {
    return {
      sink: new InMemoryMetrics(),
      mode
    };
  }

  return {
    sink: new WindowedMetrics(envNumber("METRICS_MAX_TIMINGS_PER_METRIC") ?? 2048),
    mode
  };
}

function createAlertThresholds(): MetricsAlertThresholds {
  return {
    httpErrors: envNumber("ALERT_HTTP_ERRORS"),
    upstreamTimeouts: envNumber("ALERT_UPSTREAM_TIMEOUTS"),
    upstreamUnavailable: envNumber("ALERT_UPSTREAM_UNAVAILABLE"),
    workerErrors: envNumber("ALERT_WORKER_ERRORS"),
    wsErrors: envNumber("ALERT_WS_ERRORS"),
    wsBackpressureEvents: envNumber("ALERT_WS_BACKPRESSURE_EVENTS"),
    wsRateLimitExceeded: envNumber("ALERT_WS_RATE_LIMIT_EXCEEDED"),
    wsHeartbeatTimeouts: envNumber("ALERT_WS_HEARTBEAT_TIMEOUTS"),
    httpRequestP99Ms: envNumber("ALERT_HTTP_REQUEST_P99_MS"),
    upstreamP99Ms: envNumber("ALERT_UPSTREAM_P99_MS"),
    workerP99Ms: envNumber("ALERT_WORKER_P99_MS")
  };
}

function hasAlertThresholds(thresholds: MetricsAlertThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== undefined);
}

function createListenConfig(): {
  publicPort: number;
  internalPort?: number;
  publicAllowedPathPrefixes?: string[];
  internalAllowedPathPrefixes?: string[];
  singleListenerName: RuntimeListenerName;
} {
  const publicPort = envNumber("PUBLIC_PORT") ?? envNumber("PORT") ?? 3000;
  const internalPort = envNumber("INTERNAL_PORT");
  const publicAllowedPathPrefixes = envPathPrefixes("PUBLIC_ALLOWED_PATH_PREFIXES");
  const internalAllowedPathPrefixes = envPathPrefixes("INTERNAL_ALLOWED_PATH_PREFIXES");
  const hasNamedListenerConfig =
    processEnv.PUBLIC_PORT !== undefined ||
    processEnv.INTERNAL_PORT !== undefined ||
    publicAllowedPathPrefixes !== undefined ||
    internalAllowedPathPrefixes !== undefined;

  return {
    publicPort,
    internalPort: internalPort !== undefined && internalPort !== publicPort ? internalPort : undefined,
    publicAllowedPathPrefixes,
    internalAllowedPathPrefixes,
    singleListenerName: hasNamedListenerConfig ? "public" : "default"
  };
}

try {
  const { sink: metrics, mode: metricsMode } = createMetricsSink();
  const websocketShutdownGraceMs = envNumber("WS_SHUTDOWN_GRACE_MS") ?? 3_000;
  const listenConfig = createListenConfig();
  const app = await createRuntimeApp({
    configModulePath: processEnv.CONFIG_MODULE_PATH,
    nodeId: envString("NODE_ID") ?? "local",
    prometheusPrefix: envString("PROMETHEUS_METRIC_PREFIX") ?? "hardess",
    cluster: {
      peers: parseClusterPeers(),
      sharedSecret: envString("CLUSTER_SHARED_SECRET"),
      requestTimeoutMs: envNumber("CLUSTER_REQUEST_TIMEOUT_MS"),
      outboundMaxQueueMessages: envNumber("CLUSTER_OUTBOUND_MAX_QUEUE_MESSAGES"),
      outboundBackpressureRetryMs: envNumber("CLUSTER_OUTBOUND_BACKPRESSURE_RETRY_MS"),
      locatorCacheTtlMs: envNumber("CLUSTER_LOCATOR_CACHE_TTL_MS"),
      transport: parseClusterTransport()
    },
    metrics,
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
      outbound: processEnv.WS_OUTBOUND_MAX_QUEUE_MESSAGES ||
          processEnv.WS_OUTBOUND_MAX_QUEUE_BYTES ||
          processEnv.WS_OUTBOUND_MAX_SOCKET_BUFFER_BYTES ||
          processEnv.WS_OUTBOUND_BACKPRESSURE_RETRY_MS
        ? {
            maxQueueMessages: envNumber("WS_OUTBOUND_MAX_QUEUE_MESSAGES") ?? 256,
            maxQueueBytes: envNumber("WS_OUTBOUND_MAX_QUEUE_BYTES") ?? 512 * 1024,
            maxSocketBufferBytes: envNumber("WS_OUTBOUND_MAX_SOCKET_BUFFER_BYTES") ?? 512 * 1024,
            backpressureRetryMs: envNumber("WS_OUTBOUND_BACKPRESSURE_RETRY_MS") ?? 10
          }
        : undefined,
      shutdownGraceMs: websocketShutdownGraceMs
    },
    listeners: {
      public: {
        allowedPathPrefixes: listenConfig.publicAllowedPathPrefixes
      },
      internal: {
        allowedPathPrefixes: listenConfig.internalAllowedPathPrefixes
      }
    }
  });

  const publicServer = Bun.serve({
    port: listenConfig.publicPort,
    async fetch(request, serverRef) {
      return app.fetch(request, serverRef, {
        listener: listenConfig.singleListenerName
      });
    },
    websocket: app.websocket
  });
  const internalServer = listenConfig.internalPort === undefined
    ? undefined
    : Bun.serve({
        port: listenConfig.internalPort,
        async fetch(request, serverRef) {
          return app.fetch(request, serverRef, {
            listener: "internal"
          });
        },
        websocket: app.websocket
      });
  const servers = [publicServer, internalServer].filter((server): server is typeof publicServer => server !== undefined);

  const alertWindowMs = envNumber("ALERT_WINDOW_MS") ?? 30_000;
  const alertThresholds = createAlertThresholds();
  const alertMonitor = hasAlertThresholds(alertThresholds)
    ? new MetricsAlertMonitor({
        metrics,
        logger: app.logger,
        windowMs: alertWindowMs,
        thresholds: alertThresholds
      })
    : undefined;
  const alertTimer = alertMonitor
    ? setInterval(() => {
        alertMonitor.check();
      }, alertWindowMs)
    : undefined;

  app.logger.info("hardess runtime listening", {
    publicPort: publicServer.port,
    internalPort: internalServer?.port,
    listenerMode: internalServer ? "dual" : "single",
    singleListenerName: internalServer ? undefined : listenConfig.singleListenerName,
    publicAllowedPathPrefixes: listenConfig.publicAllowedPathPrefixes,
    internalAllowedPathPrefixes: listenConfig.internalAllowedPathPrefixes,
    metricsMode,
    configModulePath: processEnv.CONFIG_MODULE_PATH ?? "./config/hardess.config.ts",
    nodeId: envString("NODE_ID") ?? "local",
    clusterTransport: parseClusterTransport(),
    clusterPeers: parseClusterPeers().map((peer) => peer.nodeId),
    alertWindowMs: alertMonitor ? alertWindowMs : undefined
  });
  void app.clusterNetwork.warmConnections().catch((error) => {
    app.logger.error("cluster channel warmup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  let shutdownInFlight = false;
  const gracefulShutdownTimeoutMs = envNumber("SHUTDOWN_TIMEOUT_MS") ?? 10_000;
  const shutdownDrainMs = envNumber("SHUTDOWN_DRAIN_MS") ?? 250;

  async function shutdown(signal: "SIGINT" | "SIGTERM") {
    if (shutdownInFlight) {
      return;
    }

    shutdownInFlight = true;
    app.beginShutdown();
    app.logger.info("hardess runtime shutting down", {
      signal,
      gracefulShutdownTimeoutMs,
      shutdownDrainMs,
      websocketShutdownGraceMs
    });

    const forceStopTimer = setTimeout(() => {
      app.logger.info("forcing hardess runtime shutdown", { signal });
      void Promise.allSettled(servers.map((server) => server.stop(true)));
    }, gracefulShutdownTimeoutMs);

    try {
      if (shutdownDrainMs > 0) {
        await sleep(shutdownDrainMs);
      }
      const drained = await app.waitForHttpDrain({
        timeoutMs: Math.max(0, gracefulShutdownTimeoutMs - shutdownDrainMs),
        pollIntervalMs: 25
      });
      if (!drained) {
        app.logger.warn("hardess runtime drain deadline reached", {
          signal,
          inFlightHttpRequests: app.runtimeState().inFlightHttpRequests
        });
      }
      await Promise.all(servers.map((server) => server.stop()));
      app.logger.info("hardess runtime stopped", { signal });
    } catch (error) {
      app.logger.error("hardess runtime shutdown failed", {
        signal,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearTimeout(forceStopTimer);
      if (alertTimer) {
        clearInterval(alertTimer);
      }
      app.dispose();
      env.process?.exit?.(0);
    }
  }

  env.process?.on?.("SIGINT", () => {
    void shutdown("SIGINT");
  });

  env.process?.on?.("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  env.process?.on?.("unhandledRejection", (reason) => {
    app.logger.error("hardess runtime unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason)
    });
  });

  env.process?.on?.("uncaughtException", (error) => {
    app.logger.error("hardess runtime uncaught exception", {
      error: error instanceof Error ? error.message : String(error)
    });
    void shutdown("SIGTERM");
  });
} catch (error) {
  bootstrapLogger.error("hardess runtime failed to start", {
    error: error instanceof Error ? error.message : String(error),
    configModulePath: envString("CONFIG_MODULE_PATH") ?? "./config/hardess.config.ts"
  });
  env.process?.exit?.(1);
}
