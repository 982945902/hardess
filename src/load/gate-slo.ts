import { envNumberFirst } from "./shared.ts";

interface SloViolation {
  metric: string;
  actual: number;
  threshold: number;
}

export interface HttpGateSloThresholds {
  maxLatencyP99Ms?: number;
}

export interface WsGateSloThresholds {
  maxRecvAckP99Ms?: number;
  maxHandleAckP99Ms?: number;
  maxSysErrCount?: number;
}

export interface ClusterWsGateSloThresholds extends WsGateSloThresholds {
  maxRouteCacheRetryCount?: number;
  maxHttpFallbackCount?: number;
  maxEgressOverflowCount?: number;
  maxEgressBackpressureCount?: number;
}

export interface SloEvaluationResult {
  passed: boolean;
  violations: SloViolation[];
}

function checkThreshold(
  violations: SloViolation[],
  metric: string,
  actual: number,
  threshold: number | undefined
): void {
  if (threshold === undefined) {
    return;
  }
  if (actual > threshold) {
    violations.push({ metric, actual, threshold });
  }
}

function countValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

export function readHttpGateSloThresholds(prefix = "RELEASE_GATE_HTTP"): HttpGateSloThresholds {
  return {
    maxLatencyP99Ms: envNumberFirst([`${prefix}_MAX_P99_MS`], Number.NaN)
  };
}

export function readWsGateSloThresholds(prefix: string): WsGateSloThresholds {
  return {
    maxRecvAckP99Ms: envNumberFirst([`${prefix}_MAX_RECV_ACK_P99_MS`], Number.NaN),
    maxHandleAckP99Ms: envNumberFirst([`${prefix}_MAX_HANDLE_ACK_P99_MS`], Number.NaN),
    maxSysErrCount: envNumberFirst([`${prefix}_MAX_SYS_ERR_COUNT`], Number.NaN)
  };
}

export function readClusterWsGateSloThresholds(prefix = "CLUSTER_RELEASE_GATE_WS"): ClusterWsGateSloThresholds {
  return {
    ...readWsGateSloThresholds(prefix),
    maxRouteCacheRetryCount: envNumberFirst([`${prefix}_MAX_ROUTE_CACHE_RETRY_COUNT`], Number.NaN),
    maxHttpFallbackCount: envNumberFirst([`${prefix}_MAX_HTTP_FALLBACK_COUNT`], Number.NaN),
    maxEgressOverflowCount: envNumberFirst([`${prefix}_MAX_EGRESS_OVERFLOW_COUNT`], Number.NaN),
    maxEgressBackpressureCount: envNumberFirst([`${prefix}_MAX_EGRESS_BACKPRESSURE_COUNT`], Number.NaN)
  };
}

function normalizeThresholds<T extends object>(thresholds: T): T {
  return Object.fromEntries(
    Object.entries(thresholds).map(([key, value]) => [
      key,
      typeof value === "number" && Number.isFinite(value) ? value : undefined
    ])
  ) as T;
}

export function evaluateHttpGateSlo(
  summary: {
    latencyMs: {
      p99Ms: number;
    };
  },
  rawThresholds: HttpGateSloThresholds
): SloEvaluationResult {
  const thresholds = normalizeThresholds(rawThresholds);
  const violations: SloViolation[] = [];
  checkThreshold(violations, "httpLatencyP99Ms", summary.latencyMs.p99Ms, thresholds.maxLatencyP99Ms);
  return {
    passed: violations.length === 0,
    violations
  };
}

export function evaluateWsGateSlo(
  summary: {
    recvAckLatencyMs: { p99Ms: number };
    handleAckLatencyMs: { p99Ms: number };
    sysErrCodes: Record<string, number>;
  },
  rawThresholds: WsGateSloThresholds
): SloEvaluationResult {
  const thresholds = normalizeThresholds(rawThresholds);
  const violations: SloViolation[] = [];
  checkThreshold(violations, "recvAckP99Ms", summary.recvAckLatencyMs.p99Ms, thresholds.maxRecvAckP99Ms);
  checkThreshold(violations, "handleAckP99Ms", summary.handleAckLatencyMs.p99Ms, thresholds.maxHandleAckP99Ms);
  checkThreshold(violations, "sysErrCount", countValues(summary.sysErrCodes), thresholds.maxSysErrCount);
  return {
    passed: violations.length === 0,
    violations
  };
}

export function evaluateClusterWsGateSlo(
  summary: {
    recvAckLatencyMs: { p99Ms: number };
    handleAckLatencyMs: { p99Ms: number };
    sysErrCodes: Record<string, number>;
    routeCacheRetryCount: number;
    clusterHttpFallbackCount: number;
    clusterEgressOverflowCount: number;
    clusterEgressBackpressureCount: number;
  },
  rawThresholds: ClusterWsGateSloThresholds
): SloEvaluationResult {
  const thresholds = normalizeThresholds(rawThresholds);
  const base = evaluateWsGateSlo(summary, thresholds);
  checkThreshold(
    base.violations,
    "routeCacheRetryCount",
    summary.routeCacheRetryCount,
    thresholds.maxRouteCacheRetryCount
  );
  checkThreshold(
    base.violations,
    "clusterHttpFallbackCount",
    summary.clusterHttpFallbackCount,
    thresholds.maxHttpFallbackCount
  );
  checkThreshold(
    base.violations,
    "clusterEgressOverflowCount",
    summary.clusterEgressOverflowCount,
    thresholds.maxEgressOverflowCount
  );
  checkThreshold(
    base.violations,
    "clusterEgressBackpressureCount",
    summary.clusterEgressBackpressureCount,
    thresholds.maxEgressBackpressureCount
  );
  return {
    passed: base.violations.length === 0,
    violations: base.violations
  };
}
