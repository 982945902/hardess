import type { Logger } from "./logger.ts";
import type { MetricsSnapshot, MetricsSnapshotProvider } from "./metrics.ts";

export interface MetricsAlertThresholds {
  httpErrors?: number;
  upstreamTimeouts?: number;
  upstreamUnavailable?: number;
  workerErrors?: number;
  wsErrors?: number;
  wsBackpressureEvents?: number;
  wsRateLimitExceeded?: number;
  wsHeartbeatTimeouts?: number;
  httpRequestP99Ms?: number;
  upstreamP99Ms?: number;
  workerP99Ms?: number;
}

export interface MetricsAlertMonitorDeps {
  metrics: MetricsSnapshotProvider;
  logger: Logger;
  windowMs: number;
  thresholds: MetricsAlertThresholds;
  now?: () => number;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function counterDelta(current: MetricsSnapshot, previous: MetricsSnapshot, name: string): number {
  return (current.counters[name] ?? 0) - (previous.counters[name] ?? 0);
}

function appendedTimings(current: MetricsSnapshot, previous: MetricsSnapshot, name: string): number[] {
  const currentValues = current.timings[name] ?? [];
  const previousValues = previous.timings[name] ?? [];
  return currentValues.slice(previousValues.length);
}

export class MetricsAlertMonitor {
  private previousSnapshot: MetricsSnapshot;
  private previousCheckedAt: number;

  constructor(private readonly deps: MetricsAlertMonitorDeps) {
    this.previousSnapshot = deps.metrics.snapshot();
    this.previousCheckedAt = (deps.now ?? (() => Date.now()))();
  }

  check(): void {
    const currentSnapshot = this.deps.metrics.snapshot();
    const checkedAt = (this.deps.now ?? (() => Date.now()))();

    this.warnOnCounter("http.error_rate_high", "http.error", this.deps.thresholds.httpErrors, currentSnapshot);
    this.warnOnCounter(
      "http.upstream_timeout_high",
      "http.upstream_timeout",
      this.deps.thresholds.upstreamTimeouts,
      currentSnapshot
    );
    this.warnOnCounter(
      "http.upstream_unavailable_high",
      "http.upstream_unavailable",
      this.deps.thresholds.upstreamUnavailable,
      currentSnapshot
    );
    this.warnOnCounter("worker.error_rate_high", "worker.run_error", this.deps.thresholds.workerErrors, currentSnapshot);
    this.warnOnCounter("ws.error_rate_high", "ws.error", this.deps.thresholds.wsErrors, currentSnapshot);
    this.warnOnCounter(
      "ws.backpressure_high",
      "ws.egress_backpressure",
      this.deps.thresholds.wsBackpressureEvents,
      currentSnapshot
    );
    this.warnOnCounter(
      "ws.rate_limit_high",
      "ws.rate_limit_exceeded",
      this.deps.thresholds.wsRateLimitExceeded,
      currentSnapshot
    );
    this.warnOnCounter(
      "ws.heartbeat_timeout_high",
      "ws.heartbeat_timeout",
      this.deps.thresholds.wsHeartbeatTimeouts,
      currentSnapshot
    );

    this.warnOnTiming("http.request_p99_high", "http.request_ms", this.deps.thresholds.httpRequestP99Ms, currentSnapshot);
    this.warnOnTiming("http.upstream_p99_high", "http.upstream_ms", this.deps.thresholds.upstreamP99Ms, currentSnapshot);
    this.warnOnTiming("worker.run_p99_high", "worker.run_ms", this.deps.thresholds.workerP99Ms, currentSnapshot);

    this.previousSnapshot = currentSnapshot;
    this.previousCheckedAt = checkedAt;
  }

  private warnOnCounter(
    alert: string,
    counterName: string,
    threshold: number | undefined,
    currentSnapshot: MetricsSnapshot
  ): void {
    if (threshold === undefined) {
      return;
    }

    const delta = counterDelta(currentSnapshot, this.previousSnapshot, counterName);
    if (delta < threshold) {
      return;
    }

    this.deps.logger.warn("runtime metrics alert", {
      alert,
      metric: counterName,
      threshold,
      observed: delta,
      windowMs: this.deps.windowMs
    });
  }

  private warnOnTiming(
    alert: string,
    timingName: string,
    thresholdMs: number | undefined,
    currentSnapshot: MetricsSnapshot
  ): void {
    if (thresholdMs === undefined) {
      return;
    }

    const values = appendedTimings(currentSnapshot, this.previousSnapshot, timingName);
    if (values.length === 0) {
      return;
    }

    const p99Ms = percentile(values, 0.99);
    if (p99Ms < thresholdMs) {
      return;
    }

    this.deps.logger.warn("runtime metrics alert", {
      alert,
      metric: timingName,
      thresholdMs,
      observedP99Ms: p99Ms,
      sampleCount: values.length,
      windowMs: this.deps.windowMs
    });
  }
}
