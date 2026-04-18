import { createRuntimeApp } from "./app.ts";
import { parseRuntimeBootstrapConfig } from "./bootstrap-config.ts";
import { HostAgent } from "./control/host-agent.ts";
import { ArtifactStore } from "./control/artifact-store.ts";
import { RuntimeHostAdapter } from "./control/runtime-host-adapter.ts";
import { ServiceModuleManager } from "./control/service-module-manager.ts";
import { MetricsAlertMonitor, type MetricsAlertThresholds } from "./observability/alerts.ts";
import { ConsoleLogger } from "./observability/logger.ts";
import { InMemoryMetrics, WindowedMetrics, type MetricsSnapshotProvider } from "./observability/metrics.ts";
import { HardessAdminClient } from "../sdk/admin/client.ts";
import { HttpAdminTransport } from "../sdk/admin/http.ts";

declare const Bun: {
  serve(options: {
    port: number;
    idleTimeout?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMetricsSink(
  mode: "inmemory" | "windowed",
  maxTimingsPerMetric: number
): { sink: MetricsSnapshotProvider; mode: "inmemory" | "windowed" } {
  if (mode === "inmemory") {
    return {
      sink: new InMemoryMetrics(),
      mode
    };
  }

  return {
    sink: new WindowedMetrics(maxTimingsPerMetric),
    mode
  };
}

function hasAlertThresholds(thresholds: MetricsAlertThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== undefined);
}

try {
  const runtimeConfig = parseRuntimeBootstrapConfig(processEnv);
  const { sink: metrics, mode: metricsMode } = createMetricsSink(
    runtimeConfig.metrics.mode,
    runtimeConfig.metrics.maxTimingsPerMetric
  );
  const app = await createRuntimeApp({
    configModulePath: runtimeConfig.configModulePath,
    nodeId: runtimeConfig.nodeId,
    hostGroupId: runtimeConfig.hostGroupId,
    prometheusPrefix: runtimeConfig.prometheusPrefix,
    cluster: {
      peers: runtimeConfig.cluster.peers,
      sharedSecret: runtimeConfig.cluster.sharedSecret,
      requestTimeoutMs: runtimeConfig.cluster.requestTimeoutMs,
      outboundMaxQueueMessages: runtimeConfig.cluster.outboundMaxQueueMessages,
      outboundMaxQueueBytes: runtimeConfig.cluster.outboundMaxQueueBytes,
      outboundBackpressureRetryMs: runtimeConfig.cluster.outboundBackpressureRetryMs,
      locatorCacheTtlMs: runtimeConfig.cluster.locatorCacheTtlMs,
      transport: runtimeConfig.cluster.transport
    },
    metrics,
    websocket: {
      heartbeatIntervalMs: runtimeConfig.websocket.heartbeatIntervalMs,
      staleAfterMs: runtimeConfig.websocket.staleAfterMs,
      maxConnections: runtimeConfig.websocket.maxConnections,
      maxConnectionsPerPeer: runtimeConfig.websocket.maxConnectionsPerPeer,
      rateLimit: runtimeConfig.websocket.rateLimit,
      outbound: runtimeConfig.websocket.outbound,
      shutdownGraceMs: runtimeConfig.websocket.shutdownGraceMs
    },
    listeners: {
      business: {
        allowedPathPrefixes: runtimeConfig.listen.businessAllowedPathPrefixes
      },
      control: {
        allowedPathPrefixes: runtimeConfig.listen.controlAllowedPathPrefixes
      }
    },
    internalForward: runtimeConfig.internalForward
  });

  const businessServer = Bun.serve({
    port: runtimeConfig.listen.businessPort,
    idleTimeout: runtimeConfig.listen.serverIdleTimeoutSeconds,
    async fetch(request, serverRef) {
      return app.fetch(request, serverRef, {
        listener: runtimeConfig.listen.singleListenerName
      });
    },
    websocket: app.websocket
  });
  const controlServer = runtimeConfig.listen.controlPort === undefined
    ? undefined
    : Bun.serve({
        port: runtimeConfig.listen.controlPort,
        idleTimeout: runtimeConfig.listen.serverIdleTimeoutSeconds,
        async fetch(request, serverRef) {
          return app.fetch(request, serverRef, {
            listener: "control"
          });
        },
        websocket: app.websocket
      });
  const servers = [businessServer, controlServer].filter((server): server is typeof businessServer => server !== undefined);

  const alertWindowMs = runtimeConfig.alert.windowMs;
  const alertThresholds = runtimeConfig.alert.thresholds;
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
    singleListenerName: controlServer ? undefined : runtimeConfig.listen.singleListenerName,
    businessAllowedPathPrefixes: runtimeConfig.listen.businessAllowedPathPrefixes,
    controlAllowedPathPrefixes: runtimeConfig.listen.controlAllowedPathPrefixes,
    publicAllowedPathPrefixes: runtimeConfig.listen.businessAllowedPathPrefixes,
    internalAllowedPathPrefixes: runtimeConfig.listen.controlAllowedPathPrefixes,
    timeoutProfile: runtimeConfig.timeoutProfile,
    metricsMode,
    configModulePath: runtimeConfig.configModulePath ?? "./config/hardess.config.ts",
    nodeId: runtimeConfig.nodeId,
    hostGroupId: runtimeConfig.hostGroupId,
    clusterTransport: runtimeConfig.cluster.transport,
    clusterPeers: runtimeConfig.cluster.peers.map((peer) => peer.nodeId),
    serverIdleTimeoutSeconds: runtimeConfig.listen.serverIdleTimeoutSeconds,
    alertWindowMs: alertMonitor ? alertWindowMs : undefined
  });
  const adminBaseUrl = runtimeConfig.admin.baseUrl;
  const hostAgent = adminBaseUrl
    ? new HostAgent(
        new HardessAdminClient(
          new HttpAdminTransport({
            baseUrl: adminBaseUrl,
            headers: runtimeConfig.admin.bearerToken
              ? {
                  authorization: `Bearer ${runtimeConfig.admin.bearerToken}`
                }
              : undefined
          })
        ),
        (() => {
          const artifactStore = new ArtifactStore({
            rootDir: runtimeConfig.admin.artifactRootDir,
            logger: app.logger,
            metrics: app.metrics
          });
          const serviceModuleManager = new ServiceModuleManager({
            registry: app.registry,
            artifactStore,
            logger: app.logger,
            drainGraceMs: runtimeConfig.admin.serviceModuleDrainGraceMs
          });
          return new RuntimeHostAdapter({
            app,
            configStore: app.configStore,
            artifactStore,
            serviceModuleManager,
            topologyStore: app.topologyStore,
            hostId: runtimeConfig.admin.hostId,
            groupId: runtimeConfig.admin.groupId,
            nodeId: runtimeConfig.nodeId,
            runtimeVersion: processEnv.HARDESS_RUNTIME_VERSION ?? "v1",
            publicBaseUrl: runtimeConfig.admin.businessBaseUrl,
            internalBaseUrl: runtimeConfig.admin.controlBaseUrl,
            publicListenerEnabled: true,
            internalListenerEnabled: Boolean(runtimeConfig.listen.controlPort),
            staticLabels: runtimeConfig.admin.staticLabels,
            staticCapabilities: runtimeConfig.admin.staticCapabilities,
            staticCapacity: runtimeConfig.admin.staticCapacity,
            defaultConnectTimeoutMs: runtimeConfig.admin.defaultConnectTimeoutMs,
            defaultResponseTimeoutMs: runtimeConfig.admin.defaultResponseTimeoutMs,
            defaultWorkerTimeoutMs: runtimeConfig.admin.defaultWorkerTimeoutMs,
            registrationDynamicFields: runtimeConfig.admin.registrationDynamicFields,
            observedDynamicFields: runtimeConfig.admin.observedDynamicFields
          });
        })(),
        {
          logger: app.logger,
          defaultPollAfterMs: runtimeConfig.admin.pollAfterMs,
          retryPollAfterMs: runtimeConfig.admin.retryPollAfterMs
        }
      )
    : undefined;
  if (hostAgent) {
    hostAgent.start();
    app.logger.info("hardess host agent enabled", {
      adminBaseUrl,
      hostId: runtimeConfig.admin.hostId,
      hostGroupId: runtimeConfig.hostGroupId
    });
  }
  void app.clusterNetwork.warmConnections().catch((error) => {
    app.logger.error("cluster channel warmup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  let shutdownInFlight = false;
  const gracefulShutdownTimeoutMs = runtimeConfig.shutdown.timeoutMs;
  const shutdownDrainMs = runtimeConfig.shutdown.drainMs;
  const websocketShutdownGraceMs = runtimeConfig.websocket.shutdownGraceMs;

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
    configModulePath: processEnv.CONFIG_MODULE_PATH ?? "./config/hardess.config.ts"
  });
  env.process?.exit?.(1);
}
