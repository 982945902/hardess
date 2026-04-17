import { createRuntimeApp, type RuntimeListenerName } from "./app.ts";
import { parseClusterPeersEnv, parseClusterTransportEnv } from "./cluster/schema.ts";
import { HostAgent } from "./control/host-agent.ts";
import { ArtifactStore } from "./control/artifact-store.ts";
import { RuntimeHostAdapter } from "./control/runtime-host-adapter.ts";
import { ServiceModuleManager } from "./control/service-module-manager.ts";
import { MetricsAlertMonitor, type MetricsAlertThresholds } from "./observability/alerts.ts";
import { ConsoleLogger } from "./observability/logger.ts";
import { InMemoryMetrics, WindowedMetrics, type MetricsSnapshotProvider } from "./observability/metrics.ts";
import { HardessAdminClient } from "../sdk/admin/client.ts";
import { HttpAdminTransport } from "../sdk/admin/http.ts";
import type { HostStaticCapacity } from "../shared/index.ts";

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

function envStringList(name: string): string[] | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }

  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : [];
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

function envJsonObject(name: string): Record<string, unknown> | undefined {
  const value = envString(name);
  if (!value) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${name}: expected a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function envStringRecord(name: string): Record<string, string> | undefined {
  const parsed = envJsonObject(name);
  if (!parsed) {
    return undefined;
  }

  const entries = Object.entries(parsed);
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(`Invalid ${name}: expected string value for key ${key}`);
    }
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function envStaticCapacity(name: string): HostStaticCapacity | undefined {
  const parsed = envJsonObject(name);
  if (!parsed) {
    return undefined;
  }

  const capacity: HostStaticCapacity = {};
  const knownKeys = [
    "maxHttpWorkerAssignments",
    "maxServiceModuleAssignments",
    "maxConnections",
    "maxInflightRequests"
  ] as const;
  for (const key of knownKeys) {
    const value = parsed[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${name}: expected non-negative number for key ${key}`);
    }
    capacity[key] = Math.trunc(value);
  }

  return capacity;
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
  businessPort: number;
  controlPort?: number;
  businessAllowedPathPrefixes?: string[];
  controlAllowedPathPrefixes?: string[];
  singleListenerName: RuntimeListenerName;
} {
  const businessPort =
    envNumber("BUSINESS_PORT") ?? envNumber("PUBLIC_PORT") ?? envNumber("PORT") ?? 3000;
  const controlPort = envNumber("CONTROL_PORT") ?? envNumber("INTERNAL_PORT");
  const businessAllowedPathPrefixes =
    envPathPrefixes("BUSINESS_ALLOWED_PATH_PREFIXES") ?? envPathPrefixes("PUBLIC_ALLOWED_PATH_PREFIXES");
  const controlAllowedPathPrefixes =
    envPathPrefixes("CONTROL_ALLOWED_PATH_PREFIXES") ?? envPathPrefixes("INTERNAL_ALLOWED_PATH_PREFIXES");
  const hasNamedListenerConfig =
    processEnv.BUSINESS_PORT !== undefined ||
    processEnv.CONTROL_PORT !== undefined ||
    processEnv.PUBLIC_PORT !== undefined ||
    processEnv.INTERNAL_PORT !== undefined ||
    businessAllowedPathPrefixes !== undefined ||
    controlAllowedPathPrefixes !== undefined;

  return {
    businessPort,
    controlPort: controlPort !== undefined && controlPort !== businessPort ? controlPort : undefined,
    businessAllowedPathPrefixes,
    controlAllowedPathPrefixes,
    singleListenerName: hasNamedListenerConfig ? "business" : "default"
  };
}

try {
  const { sink: metrics, mode: metricsMode } = createMetricsSink();
  const websocketShutdownGraceMs = envNumber("WS_SHUTDOWN_GRACE_MS") ?? 3_000;
  const listenConfig = createListenConfig();
  const app = await createRuntimeApp({
    configModulePath: processEnv.CONFIG_MODULE_PATH,
    nodeId: envString("NODE_ID") ?? "local",
    hostGroupId: envString("HOST_GROUP_ID"),
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
      business: {
        allowedPathPrefixes: listenConfig.businessAllowedPathPrefixes
      },
      control: {
        allowedPathPrefixes: listenConfig.controlAllowedPathPrefixes
      }
    }
  });

  const businessServer = Bun.serve({
    port: listenConfig.businessPort,
    async fetch(request, serverRef) {
      return app.fetch(request, serverRef, {
        listener: listenConfig.singleListenerName
      });
    },
    websocket: app.websocket
  });
  const controlServer = listenConfig.controlPort === undefined
    ? undefined
    : Bun.serve({
        port: listenConfig.controlPort,
        async fetch(request, serverRef) {
          return app.fetch(request, serverRef, {
            listener: "control"
          });
        },
        websocket: app.websocket
      });
  const servers = [businessServer, controlServer].filter((server): server is typeof businessServer => server !== undefined);

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
    businessPort: businessServer.port,
    controlPort: controlServer?.port,
    publicPort: businessServer.port,
    internalPort: controlServer?.port,
    listenerMode: controlServer ? "dual" : "single",
    singleListenerName: controlServer ? undefined : listenConfig.singleListenerName,
    businessAllowedPathPrefixes: listenConfig.businessAllowedPathPrefixes,
    controlAllowedPathPrefixes: listenConfig.controlAllowedPathPrefixes,
    publicAllowedPathPrefixes: listenConfig.businessAllowedPathPrefixes,
    internalAllowedPathPrefixes: listenConfig.controlAllowedPathPrefixes,
    metricsMode,
    configModulePath: processEnv.CONFIG_MODULE_PATH ?? "./config/hardess.config.ts",
    nodeId: envString("NODE_ID") ?? "local",
    hostGroupId: envString("HOST_GROUP_ID"),
    clusterTransport: parseClusterTransport(),
    clusterPeers: parseClusterPeers().map((peer) => peer.nodeId),
    alertWindowMs: alertMonitor ? alertWindowMs : undefined
  });
  const adminBaseUrl = envString("ADMIN_BASE_URL");
  const hostAgent = adminBaseUrl
    ? new HostAgent(
        new HardessAdminClient(
          new HttpAdminTransport({
            baseUrl: adminBaseUrl,
            headers: envString("ADMIN_BEARER_TOKEN")
              ? {
                  authorization: `Bearer ${envString("ADMIN_BEARER_TOKEN")}`
                }
              : undefined
          })
        ),
        (() => {
          const artifactStore = new ArtifactStore({
            rootDir: envString("ADMIN_ARTIFACT_ROOT_DIR") ?? ".hardess-admin-artifacts",
            logger: app.logger,
            metrics: app.metrics
          });
          const serviceModuleManager = new ServiceModuleManager({
            registry: app.registry,
            artifactStore,
            logger: app.logger,
            drainGraceMs: envNumber("SERVICE_MODULE_DRAIN_GRACE_MS") ?? 3_000
          });
          return new RuntimeHostAdapter({
            app,
            configStore: app.configStore,
            artifactStore,
            serviceModuleManager,
            topologyStore: app.topologyStore,
            hostId: envString("ADMIN_HOST_ID") ?? envString("NODE_ID") ?? "local",
            groupId: envString("HOST_GROUP_ID"),
            nodeId: envString("NODE_ID") ?? "local",
            runtimeVersion: envString("HARDESS_RUNTIME_VERSION") ?? "v1",
            publicBaseUrl: envString("ADMIN_BUSINESS_BASE_URL") ?? envString("ADMIN_PUBLIC_BASE_URL"),
            internalBaseUrl: envString("ADMIN_CONTROL_BASE_URL") ?? envString("ADMIN_INTERNAL_BASE_URL"),
            publicListenerEnabled: true,
            internalListenerEnabled: Boolean(listenConfig.controlPort),
            staticLabels: envStringRecord("ADMIN_STATIC_LABELS_JSON"),
            staticCapabilities:
              envStringList("ADMIN_STATIC_CAPABILITIES") ?? ["http_worker", "service_module"],
            staticCapacity: envStaticCapacity("ADMIN_STATIC_CAPACITY_JSON"),
            defaultConnectTimeoutMs: envNumber("ADMIN_DEFAULT_CONNECT_TIMEOUT_MS"),
            defaultResponseTimeoutMs: envNumber("ADMIN_DEFAULT_RESPONSE_TIMEOUT_MS"),
            defaultWorkerTimeoutMs: envNumber("ADMIN_DEFAULT_WORKER_TIMEOUT_MS"),
            registrationDynamicFields: envJsonObject("ADMIN_REGISTRATION_DYNAMIC_FIELDS_JSON"),
            observedDynamicFields: envJsonObject("ADMIN_OBSERVED_DYNAMIC_FIELDS_JSON")
          });
        })(),
        {
          logger: app.logger,
          defaultPollAfterMs: envNumber("ADMIN_POLL_AFTER_MS"),
          retryPollAfterMs: envNumber("ADMIN_RETRY_POLL_AFTER_MS")
        }
      )
    : undefined;
  if (hostAgent) {
    hostAgent.start();
    app.logger.info("hardess host agent enabled", {
      adminBaseUrl,
      hostId: envString("ADMIN_HOST_ID") ?? envString("NODE_ID") ?? "local",
      hostGroupId: envString("HOST_GROUP_ID")
    });
  }
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
    hostAgent?.stop();
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
      hostAgent?.stop();
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
