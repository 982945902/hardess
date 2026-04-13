const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

type EnvDefaults = Record<string, string>;

const clusterRuntimeProfiles: Record<string, EnvDefaults> = {
  default: {},
  high: {
    WS_RATE_LIMIT_MAX_MESSAGES: "2200",
    WS_OUTBOUND_MAX_QUEUE_MESSAGES: "8192",
    WS_OUTBOUND_MAX_QUEUE_BYTES: "8388608",
    CLUSTER_REQUEST_TIMEOUT_MS: "30000",
    CLUSTER_LOCATOR_CACHE_TTL_MS: "10000"
  }
};

const clusterBenchmarkProfiles: Record<string, EnvDefaults> = {
  default: {},
  high: {
    BENCH_CLUSTER_COMPLETION_TIMEOUT_MS: "420000"
  }
};

const clusterReleaseGateProfiles: Record<string, EnvDefaults> = {
  default: {},
  high: {
    CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS: "420000"
  }
};

function applyDefaults(defaults: EnvDefaults): void {
  const processEnv = env.process?.env;
  if (!processEnv) {
    return;
  }

  for (const [name, value] of Object.entries(defaults)) {
    if (processEnv[name] === undefined) {
      processEnv[name] = value;
    }
  }
}

function normalizeProfileName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "default";
}

export function applyClusterRuntimeProfile(profileName: string): string {
  const normalized = normalizeProfileName(profileName);
  applyDefaults(clusterRuntimeProfiles[normalized] ?? clusterRuntimeProfiles.default);
  return normalized;
}

export function applyClusterBenchmarkProfile(profileName: string): string {
  const normalized = applyClusterRuntimeProfile(profileName);
  applyDefaults(clusterBenchmarkProfiles[normalized] ?? clusterBenchmarkProfiles.default);
  return normalized;
}

export function applyClusterReleaseGateProfile(profileName: string): string {
  const normalized = applyClusterRuntimeProfile(profileName);
  applyDefaults(clusterReleaseGateProfiles[normalized] ?? clusterReleaseGateProfiles.default);
  return normalized;
}
