import type { ClusterPeerNode, ClusterTransport } from "./cluster/network.ts";
import { parseClusterPeersEnv, parseClusterTransportEnv } from "./cluster/schema.ts";
import type { RuntimeListenerName } from "./app.ts";
import type { MetricsAlertThresholds } from "./observability/alerts.ts";
import type { HostStaticCapacity } from "../shared/index.ts";

export const RUNTIME_DEFAULTS = {
  port: 3000,
  metricsMaxTimingsPerMetric: 2048,
  alertWindowMs: 30_000,
  websocketHeartbeatIntervalMs: 25_000,
  websocketStaleAfterMs: 60_000,
  websocketRateLimitWindowMs: 1_000,
  websocketRateLimitMaxMessages: 100,
  websocketOutboundMaxQueueMessages: 256,
  websocketOutboundMaxQueueBytes: 512 * 1024,
  websocketOutboundMaxSocketBufferBytes: 512 * 1024,
  websocketOutboundBackpressureRetryMs: 10,
  websocketShutdownGraceMs: 3_000,
  clusterRequestTimeoutMs: 10_000,
  clusterOutboundMaxQueueMessages: 16_384,
  clusterOutboundMaxQueueBytes: 8 * 1024 * 1024,
  clusterOutboundBackpressureRetryMs: 10,
  clusterLocatorCacheTtlMs: 250,
  clusterPeerProbeIntervalMs: 2_000,
  clusterPeerPingTimeoutMs: 1_000,
  clusterPeerSuspectTimeoutMs: 5_000,
  clusterPeerAntiEntropyIntervalMs: 15_000,
  internalForwardHttpTimeoutMs: 5_000,
  internalForwardWsConnectTimeoutMs: 5_000,
  shutdownDrainMs: 250,
  shutdownTimeoutMs: 10_000,
  adminPollAfterMs: 5_000,
  adminRetryPollAfterMs: 1_000,
  adminDefaultConnectTimeoutMs: 1_000,
  adminDefaultResponseTimeoutMs: 5_000,
  adminDefaultWorkerTimeoutMs: 1_000,
  serviceModuleDrainGraceMs: 3_000
} as const;

export interface RuntimeBootstrapConfig {
  configModulePath?: string;
  nodeId: string;
  hostGroupId?: string;
  prometheusPrefix: string;
  metrics: {
    mode: "inmemory" | "windowed";
    maxTimingsPerMetric: number;
  };
  listen: {
    businessPort: number;
    controlPort?: number;
    businessAllowedPathPrefixes?: string[];
    controlAllowedPathPrefixes?: string[];
    singleListenerName: RuntimeListenerName;
    serverIdleTimeoutSeconds?: number;
  };
  alert: {
    windowMs: number;
    thresholds: MetricsAlertThresholds;
  };
  cluster: {
    peers: ClusterPeerNode[];
    sharedSecret?: string;
    requestTimeoutMs: number;
    outboundMaxQueueMessages: number;
    outboundMaxQueueBytes: number;
    outboundBackpressureRetryMs: number;
    locatorCacheTtlMs: number;
    peerProbeIntervalMs: number;
    peerPingTimeoutMs: number;
    peerSuspectTimeoutMs: number;
    peerAntiEntropyIntervalMs: number;
    transport: ClusterTransport;
  };
  websocket: {
    heartbeatIntervalMs: number;
    staleAfterMs: number;
    maxConnections?: number;
    maxConnectionsPerPeer?: number;
    rateLimit: {
      windowMs: number;
      maxMessages: number;
    };
    outbound: {
      maxQueueMessages: number;
      maxQueueBytes: number;
      maxSocketBufferBytes: number;
      backpressureRetryMs: number;
    };
    shutdownGraceMs: number;
  };
  internalForward: {
    httpTimeoutMs: number;
    wsConnectTimeoutMs: number;
  };
  shutdown: {
    drainMs: number;
    timeoutMs: number;
  };
  admin: {
    baseUrl?: string;
    bearerToken?: string;
    hostId: string;
    groupId?: string;
    businessBaseUrl?: string;
    controlBaseUrl?: string;
    artifactRootDir: string;
    staticLabels?: Record<string, string>;
    staticCapabilities: string[];
    staticCapacity?: HostStaticCapacity;
    defaultConnectTimeoutMs: number;
    defaultResponseTimeoutMs: number;
    defaultWorkerTimeoutMs: number;
    pollAfterMs: number;
    retryPollAfterMs: number;
    serviceModuleDrainGraceMs: number;
    registrationDynamicFields?: Record<string, unknown>;
    observedDynamicFields?: Record<string, unknown>;
  };
  timeoutProfile: RuntimeTimeoutProfile;
}

export interface RuntimeTimeoutProfile {
  process: {
    serverIdleTimeoutSeconds?: number;
    shutdownDrainMs: number;
    shutdownTimeoutMs: number;
  };
  websocket: {
    heartbeatIntervalMs: number;
    staleAfterMs: number;
    shutdownGraceMs: number;
    outboundBackpressureRetryMs: number;
  };
  cluster: {
    requestTimeoutMs: number;
    locatorCacheTtlMs: number;
    outboundBackpressureRetryMs: number;
    peerProbeIntervalMs: number;
    peerPingTimeoutMs: number;
    peerSuspectTimeoutMs: number;
    peerAntiEntropyIntervalMs: number;
  };
  internalForward: {
    httpTimeoutMs: number;
    wsConnectTimeoutMs: number;
  };
  admin: {
    pollAfterMs: number;
    retryPollAfterMs: number;
    defaultConnectTimeoutMs: number;
    defaultResponseTimeoutMs: number;
    defaultWorkerTimeoutMs: number;
    serviceModuleDrainGraceMs: number;
  };
  pipelineConfig: {
    downstreamConnectTimeoutMs: "per-pipeline required";
    downstreamResponseTimeoutMs: "per-pipeline required";
    workerTimeoutMs: "per-pipeline optional";
  };
  sdkClient: {
    recvAckMs: "client option default 5000";
    handleAckMs: "client option default 15000";
    waitUntilReadyTimeoutMs: "client call option";
  };
}

type Env = Record<string, string | undefined>;

interface NumberOptions {
  integer?: boolean;
  min?: number;
  max?: number;
  description?: string;
}

function firstEnv(env: Env, names: string | string[]): { name: string; value: string } | undefined {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    const value = env[name];
    if (value !== undefined) {
      return { name, value };
    }
  }
  return undefined;
}

function envString(env: Env, name: string): string | undefined {
  return env[name];
}

function envStringFirst(env: Env, names: string | string[]): string | undefined {
  return firstEnv(env, names)?.value;
}

function parseNumber(env: Env, names: string | string[], options: NumberOptions = {}): number | undefined {
  const entry = firstEnv(env, names);
  if (!entry) {
    return undefined;
  }

  const parsed = Number(entry.value);
  const description = options.description ?? "a finite number";
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${entry.name}: expected ${description}`);
  }

  if (options.integer && !Number.isInteger(parsed)) {
    throw new Error(`Invalid ${entry.name}: expected an integer`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Invalid ${entry.name}: expected >= ${options.min}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Invalid ${entry.name}: expected <= ${options.max}`);
  }

  return parsed;
}

function parseInteger(
  env: Env,
  names: string | string[],
  options: Omit<NumberOptions, "integer"> = {}
): number | undefined {
  return parseNumber(env, names, {
    ...options,
    integer: true,
    description: options.description ?? "an integer"
  });
}

function parseRequiredPositiveMs(
  env: Env,
  names: string | string[],
  defaultValue: number
): number {
  return parseInteger(env, names, {
    min: 1,
    description: "a positive millisecond value"
  }) ?? defaultValue;
}

function parseNonNegativeMs(
  env: Env,
  names: string | string[],
  defaultValue: number
): number {
  return parseInteger(env, names, {
    min: 0,
    description: "a non-negative millisecond value"
  }) ?? defaultValue;
}

function parsePort(env: Env, names: string | string[], defaultValue?: number): number | undefined {
  return parseInteger(env, names, {
    min: 1,
    max: 65_535,
    description: "a TCP port between 1 and 65535"
  }) ?? defaultValue;
}

function parseStringList(env: Env, name: string): string[] | undefined {
  const value = envString(env, name);
  if (value === undefined) {
    return undefined;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseStringListFirst(env: Env, names: string[]): string[] | undefined {
  for (const name of names) {
    const parsed = parseStringList(env, name);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parsePathPrefixes(env: Env, names: string[]): string[] | undefined {
  const prefixes = parseStringListFirst(env, names);
  if (prefixes === undefined) {
    return undefined;
  }

  for (const prefix of prefixes) {
    if (!prefix.startsWith("/")) {
      throw new Error(`Invalid ${names.join("|")}: path prefix ${prefix} must start with '/'`);
    }
  }

  return prefixes;
}

function parseJsonObject(env: Env, name: string): Record<string, unknown> | undefined {
  const value = envString(env, name);
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

function parseStringRecord(env: Env, name: string): Record<string, string> | undefined {
  const parsed = parseJsonObject(env, name);
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

function parseStaticCapacity(env: Env, name: string): HostStaticCapacity | undefined {
  const parsed = parseJsonObject(env, name);
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

function assertUrl(name: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute URL`);
  }
}

function createAlertThresholds(env: Env): MetricsAlertThresholds {
  return {
    httpErrors: parseNumber(env, "ALERT_HTTP_ERRORS", { min: 0 }),
    upstreamTimeouts: parseNumber(env, "ALERT_UPSTREAM_TIMEOUTS", { min: 0 }),
    upstreamUnavailable: parseNumber(env, "ALERT_UPSTREAM_UNAVAILABLE", { min: 0 }),
    workerErrors: parseNumber(env, "ALERT_WORKER_ERRORS", { min: 0 }),
    wsErrors: parseNumber(env, "ALERT_WS_ERRORS", { min: 0 }),
    wsBackpressureEvents: parseNumber(env, "ALERT_WS_BACKPRESSURE_EVENTS", { min: 0 }),
    wsRateLimitExceeded: parseNumber(env, "ALERT_WS_RATE_LIMIT_EXCEEDED", { min: 0 }),
    wsHeartbeatTimeouts: parseNumber(env, "ALERT_WS_HEARTBEAT_TIMEOUTS", { min: 0 }),
    httpRequestP99Ms: parseNumber(env, "ALERT_HTTP_REQUEST_P99_MS", { min: 0 }),
    upstreamP99Ms: parseNumber(env, "ALERT_UPSTREAM_P99_MS", { min: 0 }),
    workerP99Ms: parseNumber(env, "ALERT_WORKER_P99_MS", { min: 0 })
  };
}

function createTimeoutProfile(config: Omit<RuntimeBootstrapConfig, "timeoutProfile">): RuntimeTimeoutProfile {
  return {
    process: {
      serverIdleTimeoutSeconds: config.listen.serverIdleTimeoutSeconds,
      shutdownDrainMs: config.shutdown.drainMs,
      shutdownTimeoutMs: config.shutdown.timeoutMs
    },
    websocket: {
      heartbeatIntervalMs: config.websocket.heartbeatIntervalMs,
      staleAfterMs: config.websocket.staleAfterMs,
      shutdownGraceMs: config.websocket.shutdownGraceMs,
      outboundBackpressureRetryMs: config.websocket.outbound.backpressureRetryMs
    },
    cluster: {
      requestTimeoutMs: config.cluster.requestTimeoutMs,
      locatorCacheTtlMs: config.cluster.locatorCacheTtlMs,
      outboundBackpressureRetryMs: config.cluster.outboundBackpressureRetryMs,
      peerProbeIntervalMs: config.cluster.peerProbeIntervalMs,
      peerPingTimeoutMs: config.cluster.peerPingTimeoutMs,
      peerSuspectTimeoutMs: config.cluster.peerSuspectTimeoutMs,
      peerAntiEntropyIntervalMs: config.cluster.peerAntiEntropyIntervalMs
    },
    internalForward: {
      httpTimeoutMs: config.internalForward.httpTimeoutMs,
      wsConnectTimeoutMs: config.internalForward.wsConnectTimeoutMs
    },
    admin: {
      pollAfterMs: config.admin.pollAfterMs,
      retryPollAfterMs: config.admin.retryPollAfterMs,
      defaultConnectTimeoutMs: config.admin.defaultConnectTimeoutMs,
      defaultResponseTimeoutMs: config.admin.defaultResponseTimeoutMs,
      defaultWorkerTimeoutMs: config.admin.defaultWorkerTimeoutMs,
      serviceModuleDrainGraceMs: config.admin.serviceModuleDrainGraceMs
    },
    pipelineConfig: {
      downstreamConnectTimeoutMs: "per-pipeline required",
      downstreamResponseTimeoutMs: "per-pipeline required",
      workerTimeoutMs: "per-pipeline optional"
    },
    sdkClient: {
      recvAckMs: "client option default 5000",
      handleAckMs: "client option default 15000",
      waitUntilReadyTimeoutMs: "client call option"
    }
  };
}

export function parseRuntimeBootstrapConfig(env: Env): RuntimeBootstrapConfig {
  const metricsModeValue = envString(env, "METRICS_SINK");
  if (
    metricsModeValue !== undefined &&
    metricsModeValue !== "inmemory" &&
    metricsModeValue !== "windowed"
  ) {
    throw new Error("Invalid METRICS_SINK: expected 'inmemory' or 'windowed'");
  }

  const businessPort = parsePort(
    env,
    ["BUSINESS_PORT", "PUBLIC_PORT", "PORT"],
    RUNTIME_DEFAULTS.port
  );
  const controlPort = parsePort(env, ["CONTROL_PORT", "INTERNAL_PORT"]);
  const businessAllowedPathPrefixes = parsePathPrefixes(env, [
    "BUSINESS_ALLOWED_PATH_PREFIXES",
    "PUBLIC_ALLOWED_PATH_PREFIXES"
  ]);
  const controlAllowedPathPrefixes = parsePathPrefixes(env, [
    "CONTROL_ALLOWED_PATH_PREFIXES",
    "INTERNAL_ALLOWED_PATH_PREFIXES"
  ]);
  const hasNamedListenerConfig =
    firstEnv(env, ["BUSINESS_PORT", "PUBLIC_PORT", "PORT"]) !== undefined ||
    firstEnv(env, ["CONTROL_PORT", "INTERNAL_PORT"]) !== undefined ||
    businessAllowedPathPrefixes !== undefined ||
    controlAllowedPathPrefixes !== undefined;

  const websocketHeartbeatIntervalMs = parseRequiredPositiveMs(
    env,
    "WS_HEARTBEAT_INTERVAL_MS",
    RUNTIME_DEFAULTS.websocketHeartbeatIntervalMs
  );
  const websocketStaleAfterMs = parseRequiredPositiveMs(
    env,
    "WS_STALE_AFTER_MS",
    RUNTIME_DEFAULTS.websocketStaleAfterMs
  );
  if (websocketStaleAfterMs <= websocketHeartbeatIntervalMs) {
    throw new Error("Invalid websocket timeout config: WS_STALE_AFTER_MS must be greater than WS_HEARTBEAT_INTERVAL_MS");
  }

  const shutdownDrainMs = parseNonNegativeMs(
    env,
    "SHUTDOWN_DRAIN_MS",
    RUNTIME_DEFAULTS.shutdownDrainMs
  );
  const shutdownTimeoutMs = parseRequiredPositiveMs(
    env,
    "SHUTDOWN_TIMEOUT_MS",
    RUNTIME_DEFAULTS.shutdownTimeoutMs
  );
  if (shutdownDrainMs > shutdownTimeoutMs) {
    throw new Error("Invalid shutdown timeout config: SHUTDOWN_DRAIN_MS must be <= SHUTDOWN_TIMEOUT_MS");
  }

  const clusterPeerPingTimeoutMs = parseRequiredPositiveMs(
    env,
    "CLUSTER_PEER_PING_TIMEOUT_MS",
    RUNTIME_DEFAULTS.clusterPeerPingTimeoutMs
  );
  const clusterPeerSuspectTimeoutMs = parseRequiredPositiveMs(
    env,
    "CLUSTER_PEER_SUSPECT_TIMEOUT_MS",
    RUNTIME_DEFAULTS.clusterPeerSuspectTimeoutMs
  );
  if (clusterPeerSuspectTimeoutMs <= clusterPeerPingTimeoutMs) {
    throw new Error(
      "Invalid cluster peer timing config: CLUSTER_PEER_SUSPECT_TIMEOUT_MS must be greater than CLUSTER_PEER_PING_TIMEOUT_MS"
    );
  }

  const adminBaseUrl = envString(env, "ADMIN_BASE_URL");
  const adminBusinessBaseUrl = envStringFirst(env, [
    "ADMIN_BUSINESS_BASE_URL",
    "ADMIN_PUBLIC_BASE_URL"
  ]);
  const adminControlBaseUrl = envStringFirst(env, [
    "ADMIN_CONTROL_BASE_URL",
    "ADMIN_INTERNAL_BASE_URL"
  ]);
  assertUrl("ADMIN_BASE_URL", adminBaseUrl);
  assertUrl("ADMIN_BUSINESS_BASE_URL|ADMIN_PUBLIC_BASE_URL", adminBusinessBaseUrl);
  assertUrl("ADMIN_CONTROL_BASE_URL|ADMIN_INTERNAL_BASE_URL", adminControlBaseUrl);

  const partialConfig: Omit<RuntimeBootstrapConfig, "timeoutProfile"> = {
    configModulePath: envString(env, "CONFIG_MODULE_PATH"),
    nodeId: envString(env, "NODE_ID") ?? "local",
    hostGroupId: envString(env, "HOST_GROUP_ID"),
    prometheusPrefix: envString(env, "PROMETHEUS_METRIC_PREFIX") ?? "hardess",
    metrics: {
      mode: metricsModeValue === "inmemory" ? "inmemory" : "windowed",
      maxTimingsPerMetric: parseInteger(env, "METRICS_MAX_TIMINGS_PER_METRIC", {
        min: 1,
        description: "a positive retained timing sample count"
      }) ?? RUNTIME_DEFAULTS.metricsMaxTimingsPerMetric
    },
    listen: {
      businessPort: businessPort ?? RUNTIME_DEFAULTS.port,
      controlPort:
        controlPort !== undefined && controlPort !== businessPort
          ? controlPort
          : undefined,
      businessAllowedPathPrefixes,
      controlAllowedPathPrefixes,
      singleListenerName: hasNamedListenerConfig ? "business" : "default",
      serverIdleTimeoutSeconds: parseInteger(env, "SERVER_IDLE_TIMEOUT_SECS", {
        min: 0,
        description: "a non-negative second value"
      })
    },
    alert: {
      windowMs: parseRequiredPositiveMs(env, "ALERT_WINDOW_MS", RUNTIME_DEFAULTS.alertWindowMs),
      thresholds: createAlertThresholds(env)
    },
    cluster: {
      peers: parseClusterPeersEnv(envString(env, "CLUSTER_PEERS_JSON")),
      sharedSecret: envString(env, "CLUSTER_SHARED_SECRET"),
      requestTimeoutMs: parseRequiredPositiveMs(
        env,
        "CLUSTER_REQUEST_TIMEOUT_MS",
        RUNTIME_DEFAULTS.clusterRequestTimeoutMs
      ),
      outboundMaxQueueMessages: parseInteger(env, "CLUSTER_OUTBOUND_MAX_QUEUE_MESSAGES", {
        min: 1,
        description: "a positive queue length"
      }) ?? RUNTIME_DEFAULTS.clusterOutboundMaxQueueMessages,
      outboundMaxQueueBytes: parseInteger(env, "CLUSTER_OUTBOUND_MAX_QUEUE_BYTES", {
        min: 1,
        description: "a positive byte count"
      }) ?? RUNTIME_DEFAULTS.clusterOutboundMaxQueueBytes,
      outboundBackpressureRetryMs: parseRequiredPositiveMs(
        env,
        "CLUSTER_OUTBOUND_BACKPRESSURE_RETRY_MS",
        RUNTIME_DEFAULTS.clusterOutboundBackpressureRetryMs
      ),
      locatorCacheTtlMs: parseNonNegativeMs(
        env,
        "CLUSTER_LOCATOR_CACHE_TTL_MS",
        RUNTIME_DEFAULTS.clusterLocatorCacheTtlMs
      ),
      peerProbeIntervalMs: parseRequiredPositiveMs(
        env,
        "CLUSTER_PEER_PROBE_INTERVAL_MS",
        RUNTIME_DEFAULTS.clusterPeerProbeIntervalMs
      ),
      peerPingTimeoutMs: clusterPeerPingTimeoutMs,
      peerSuspectTimeoutMs: clusterPeerSuspectTimeoutMs,
      peerAntiEntropyIntervalMs: parseNonNegativeMs(
        env,
        "CLUSTER_PEER_ANTI_ENTROPY_INTERVAL_MS",
        RUNTIME_DEFAULTS.clusterPeerAntiEntropyIntervalMs
      ),
      transport: parseClusterTransportEnv(envString(env, "CLUSTER_TRANSPORT"))
    },
    websocket: {
      heartbeatIntervalMs: websocketHeartbeatIntervalMs,
      staleAfterMs: websocketStaleAfterMs,
      maxConnections: parseInteger(env, "WS_MAX_CONNECTIONS", {
        min: 1,
        description: "a positive connection count"
      }),
      maxConnectionsPerPeer: parseInteger(env, "WS_MAX_CONNECTIONS_PER_PEER", {
        min: 1,
        description: "a positive per-peer connection count"
      }),
      rateLimit: {
        windowMs: parseRequiredPositiveMs(
          env,
          "WS_RATE_LIMIT_WINDOW_MS",
          RUNTIME_DEFAULTS.websocketRateLimitWindowMs
        ),
        maxMessages: parseInteger(env, "WS_RATE_LIMIT_MAX_MESSAGES", {
          min: 1,
          description: "a positive message count"
        }) ?? RUNTIME_DEFAULTS.websocketRateLimitMaxMessages
      },
      outbound: {
        maxQueueMessages: parseInteger(env, "WS_OUTBOUND_MAX_QUEUE_MESSAGES", {
          min: 1,
          description: "a positive queue length"
        }) ?? RUNTIME_DEFAULTS.websocketOutboundMaxQueueMessages,
        maxQueueBytes: parseInteger(env, "WS_OUTBOUND_MAX_QUEUE_BYTES", {
          min: 1,
          description: "a positive byte count"
        }) ?? RUNTIME_DEFAULTS.websocketOutboundMaxQueueBytes,
        maxSocketBufferBytes: parseInteger(env, "WS_OUTBOUND_MAX_SOCKET_BUFFER_BYTES", {
          min: 1,
          description: "a positive byte count"
        }) ?? RUNTIME_DEFAULTS.websocketOutboundMaxSocketBufferBytes,
        backpressureRetryMs: parseRequiredPositiveMs(
          env,
          "WS_OUTBOUND_BACKPRESSURE_RETRY_MS",
          RUNTIME_DEFAULTS.websocketOutboundBackpressureRetryMs
        )
      },
      shutdownGraceMs: parseNonNegativeMs(
        env,
        "WS_SHUTDOWN_GRACE_MS",
        RUNTIME_DEFAULTS.websocketShutdownGraceMs
      )
    },
    internalForward: {
      httpTimeoutMs: parseRequiredPositiveMs(
        env,
        "INTERNAL_FORWARD_HTTP_TIMEOUT_MS",
        RUNTIME_DEFAULTS.internalForwardHttpTimeoutMs
      ),
      wsConnectTimeoutMs: parseRequiredPositiveMs(
        env,
        "INTERNAL_FORWARD_WS_CONNECT_TIMEOUT_MS",
        RUNTIME_DEFAULTS.internalForwardWsConnectTimeoutMs
      )
    },
    shutdown: {
      drainMs: shutdownDrainMs,
      timeoutMs: shutdownTimeoutMs
    },
    admin: {
      baseUrl: adminBaseUrl,
      bearerToken: envString(env, "ADMIN_BEARER_TOKEN"),
      hostId: envString(env, "ADMIN_HOST_ID") ?? envString(env, "NODE_ID") ?? "local",
      groupId: envString(env, "HOST_GROUP_ID"),
      businessBaseUrl: adminBusinessBaseUrl,
      controlBaseUrl: adminControlBaseUrl,
      artifactRootDir: envString(env, "ADMIN_ARTIFACT_ROOT_DIR") ?? ".hardess-admin-artifacts",
      staticLabels: parseStringRecord(env, "ADMIN_STATIC_LABELS_JSON"),
      staticCapabilities: parseStringList(env, "ADMIN_STATIC_CAPABILITIES") ?? [
        "http_worker",
        "service_module"
      ],
      staticCapacity: parseStaticCapacity(env, "ADMIN_STATIC_CAPACITY_JSON"),
      defaultConnectTimeoutMs: parseRequiredPositiveMs(
        env,
        "ADMIN_DEFAULT_CONNECT_TIMEOUT_MS",
        RUNTIME_DEFAULTS.adminDefaultConnectTimeoutMs
      ),
      defaultResponseTimeoutMs: parseRequiredPositiveMs(
        env,
        "ADMIN_DEFAULT_RESPONSE_TIMEOUT_MS",
        RUNTIME_DEFAULTS.adminDefaultResponseTimeoutMs
      ),
      defaultWorkerTimeoutMs: parseRequiredPositiveMs(
        env,
        "ADMIN_DEFAULT_WORKER_TIMEOUT_MS",
        RUNTIME_DEFAULTS.adminDefaultWorkerTimeoutMs
      ),
      pollAfterMs: parseRequiredPositiveMs(
        env,
        "ADMIN_POLL_AFTER_MS",
        RUNTIME_DEFAULTS.adminPollAfterMs
      ),
      retryPollAfterMs: parseRequiredPositiveMs(
        env,
        "ADMIN_RETRY_POLL_AFTER_MS",
        RUNTIME_DEFAULTS.adminRetryPollAfterMs
      ),
      serviceModuleDrainGraceMs: parseNonNegativeMs(
        env,
        "SERVICE_MODULE_DRAIN_GRACE_MS",
        RUNTIME_DEFAULTS.serviceModuleDrainGraceMs
      ),
      registrationDynamicFields: parseJsonObject(env, "ADMIN_REGISTRATION_DYNAMIC_FIELDS_JSON"),
      observedDynamicFields: parseJsonObject(env, "ADMIN_OBSERVED_DYNAMIC_FIELDS_JSON")
    }
  };

  return {
    ...partialConfig,
    timeoutProfile: createTimeoutProfile(partialConfig)
  };
}
