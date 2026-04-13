import { afterEach, describe, expect, test } from "bun:test";
import { applyClusterBenchmarkProfile, applyClusterReleaseGateProfile } from "./profiles.ts";

const PROFILE_ENV_KEYS = [
  "WS_RATE_LIMIT_MAX_MESSAGES",
  "WS_OUTBOUND_MAX_QUEUE_MESSAGES",
  "WS_OUTBOUND_MAX_QUEUE_BYTES",
  "CLUSTER_REQUEST_TIMEOUT_MS",
  "CLUSTER_LOCATOR_CACHE_TTL_MS",
  "BENCH_CLUSTER_COMPLETION_TIMEOUT_MS",
  "CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS"
] as const;

const originalEnv = Object.fromEntries(
  PROFILE_ENV_KEYS.map((name) => [name, process.env[name]])
) as Record<(typeof PROFILE_ENV_KEYS)[number], string | undefined>;

function restoreProfileEnv(): void {
  for (const name of PROFILE_ENV_KEYS) {
    const originalValue = originalEnv[name];
    if (originalValue === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = originalValue;
  }
}

afterEach(() => {
  restoreProfileEnv();
});

describe("load profiles", () => {
  test("applies high benchmark defaults without overriding explicit env", () => {
    delete process.env.WS_RATE_LIMIT_MAX_MESSAGES;
    delete process.env.BENCH_CLUSTER_COMPLETION_TIMEOUT_MS;
    process.env.CLUSTER_REQUEST_TIMEOUT_MS = "12345";

    const profileName = applyClusterBenchmarkProfile("high");

    expect(profileName).toBe("high");
    expect(process.env.WS_RATE_LIMIT_MAX_MESSAGES ?? "").toBe("2200");
    expect(process.env.BENCH_CLUSTER_COMPLETION_TIMEOUT_MS ?? "").toBe("420000");
    expect(process.env.CLUSTER_REQUEST_TIMEOUT_MS ?? "").toBe("12345");
  });

  test("applies high cluster release-gate defaults", () => {
    delete process.env.CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS;
    delete process.env.CLUSTER_LOCATOR_CACHE_TTL_MS;

    const profileName = applyClusterReleaseGateProfile("high");

    expect(profileName).toBe("high");
    expect(process.env.CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS ?? "").toBe("420000");
    expect(process.env.CLUSTER_LOCATOR_CACHE_TTL_MS ?? "").toBe("10000");
  });

  test("falls back to default profile for unknown names", () => {
    delete process.env.WS_RATE_LIMIT_MAX_MESSAGES;

    const profileName = applyClusterBenchmarkProfile("unknown");

    expect(profileName).toBe("unknown");
    expect(process.env.WS_RATE_LIMIT_MAX_MESSAGES).toBeUndefined();
  });
});
