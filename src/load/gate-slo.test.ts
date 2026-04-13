import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluateClusterWsGateSlo,
  evaluateHttpGateSlo,
  evaluateWsGateSlo,
  readClusterWsGateSloThresholds,
  readHttpGateSloThresholds,
  readWsGateSloThresholds
} from "./gate-slo.ts";

const SLO_ENV_KEYS = [
  "TEST_HTTP_MAX_P99_MS",
  "TEST_WS_MAX_RECV_ACK_P99_MS",
  "TEST_WS_MAX_HANDLE_ACK_P99_MS",
  "TEST_WS_MAX_SYS_ERR_COUNT",
  "TEST_WS_MAX_EGRESS_OVERFLOW_COUNT",
  "TEST_WS_MAX_EGRESS_BACKPRESSURE_COUNT",
  "TEST_CLUSTER_MAX_RECV_ACK_P99_MS",
  "TEST_CLUSTER_MAX_HANDLE_ACK_P99_MS",
  "TEST_CLUSTER_MAX_ROUTE_CACHE_RETRY_COUNT",
  "TEST_CLUSTER_MAX_HTTP_FALLBACK_COUNT",
  "TEST_CLUSTER_MAX_EGRESS_OVERFLOW_COUNT",
  "TEST_CLUSTER_MAX_EGRESS_BACKPRESSURE_COUNT",
  "TEST_CLUSTER_MAX_SYS_ERR_COUNT"
] as const;

const originalEnv = Object.fromEntries(
  SLO_ENV_KEYS.map((name) => [name, process.env[name]])
) as Record<(typeof SLO_ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const name of SLO_ENV_KEYS) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
      continue;
    }

    process.env[name] = value;
  }
});

describe("gate SLO evaluation", () => {
  test("reads layered SLO profiles and still allows env overrides", () => {
    process.env.TEST_HTTP_MAX_P99_MS = "88";
    process.env.TEST_WS_MAX_HANDLE_ACK_P99_MS = "222";
    process.env.TEST_CLUSTER_MAX_HTTP_FALLBACK_COUNT = "3";

    expect(readHttpGateSloThresholds("TEST_HTTP", "local")).toEqual({
      maxLatencyP99Ms: 88
    });
    expect(readWsGateSloThresholds("TEST_WS", "local")).toEqual({
      maxRecvAckP99Ms: 100,
      maxHandleAckP99Ms: 222,
      maxSysErrCount: 0,
      maxEgressOverflowCount: 0,
      maxEgressBackpressureCount: 0
    });
    expect(readClusterWsGateSloThresholds("TEST_CLUSTER", "high")).toEqual({
      maxRecvAckP99Ms: 450,
      maxHandleAckP99Ms: 600,
      maxSysErrCount: 0,
      maxRouteCacheRetryCount: 0,
      maxHttpFallbackCount: 3,
      maxEgressOverflowCount: 0,
      maxEgressBackpressureCount: 0
    });
  });

  test("passes when no thresholds are exceeded", () => {
    const result = evaluateWsGateSlo(
      {
        recvAckLatencyMs: { p99Ms: 50 },
        handleAckLatencyMs: { p99Ms: 80 },
        sysErrCodes: {},
        egressOverflowCount: 0,
        egressBackpressureCount: 0
      },
      {
        maxRecvAckP99Ms: 100,
        maxHandleAckP99Ms: 100,
        maxSysErrCount: 0,
        maxEgressOverflowCount: 0,
        maxEgressBackpressureCount: 1
      }
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("reports HTTP and WS threshold violations", () => {
    const httpResult = evaluateHttpGateSlo(
      {
        latencyMs: { p99Ms: 250 }
      },
      {
        maxLatencyP99Ms: 200
      }
    );
    const wsResult = evaluateWsGateSlo(
      {
        recvAckLatencyMs: { p99Ms: 120 },
        handleAckLatencyMs: { p99Ms: 220 },
        sysErrCodes: { ROUTE_NO_RECIPIENT: 2 },
        egressOverflowCount: 1,
        egressBackpressureCount: 4
      },
      {
        maxRecvAckP99Ms: 100,
        maxHandleAckP99Ms: 200,
        maxSysErrCount: 0,
        maxEgressOverflowCount: 0,
        maxEgressBackpressureCount: 2
      }
    );

    expect(httpResult.passed).toBe(false);
    expect(httpResult.violations).toEqual([
      { metric: "httpLatencyP99Ms", actual: 250, threshold: 200 }
    ]);
    expect(wsResult.passed).toBe(false);
    expect(wsResult.violations).toEqual([
      { metric: "recvAckP99Ms", actual: 120, threshold: 100 },
      { metric: "handleAckP99Ms", actual: 220, threshold: 200 },
      { metric: "sysErrCount", actual: 2, threshold: 0 },
      { metric: "egressOverflowCount", actual: 1, threshold: 0 },
      { metric: "egressBackpressureCount", actual: 4, threshold: 2 }
    ]);
  });

  test("reports cluster-only degradation counters", () => {
    const result = evaluateClusterWsGateSlo(
      {
        recvAckLatencyMs: { p99Ms: 30 },
        handleAckLatencyMs: { p99Ms: 40 },
        sysErrCodes: {},
        routeCacheRetryCount: 3,
        clusterHttpFallbackCount: 1,
        clusterEgressOverflowCount: 0,
        clusterEgressBackpressureCount: 4
      },
      {
        maxRecvAckP99Ms: 100,
        maxHandleAckP99Ms: 100,
        maxSysErrCount: 0,
        maxRouteCacheRetryCount: 1,
        maxHttpFallbackCount: 0,
        maxEgressOverflowCount: 0,
        maxEgressBackpressureCount: 2
      }
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      { metric: "routeCacheRetryCount", actual: 3, threshold: 1 },
      { metric: "clusterHttpFallbackCount", actual: 1, threshold: 0 },
      { metric: "clusterEgressBackpressureCount", actual: 4, threshold: 2 }
    ]);
  });
});
