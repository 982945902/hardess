import { describe, expect, test } from "bun:test";
import { evaluateClusterWsGateSlo, evaluateHttpGateSlo, evaluateWsGateSlo } from "./gate-slo.ts";

describe("gate SLO evaluation", () => {
  test("passes when no thresholds are exceeded", () => {
    const result = evaluateWsGateSlo(
      {
        recvAckLatencyMs: { p99Ms: 50 },
        handleAckLatencyMs: { p99Ms: 80 },
        sysErrCodes: {}
      },
      {
        maxRecvAckP99Ms: 100,
        maxHandleAckP99Ms: 100,
        maxSysErrCount: 0
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
        sysErrCodes: { ROUTE_NO_RECIPIENT: 2 }
      },
      {
        maxRecvAckP99Ms: 100,
        maxHandleAckP99Ms: 200,
        maxSysErrCount: 0
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
      { metric: "sysErrCount", actual: 2, threshold: 0 }
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
