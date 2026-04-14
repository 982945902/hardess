import { describe, expect, it, mock } from "bun:test";
import type { Logger } from "./logger.ts";
import { MetricsAlertMonitor } from "./alerts.ts";
import { InMemoryMetrics, WindowedMetrics } from "./metrics.ts";

function createLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  } satisfies Logger;
}

describe("MetricsAlertMonitor", () => {
  it("emits warnings when counter thresholds are crossed in the current window", () => {
    const metrics = new InMemoryMetrics();
    const logger = createLogger();
    const monitor = new MetricsAlertMonitor({
      metrics,
      logger,
      windowMs: 30_000,
      thresholds: {
        wsBackpressureEvents: 2
      }
    });

    metrics.increment("ws.egress_backpressure");
    monitor.check();
    expect(logger.warn).toHaveBeenCalledTimes(0);

    metrics.increment("ws.egress_backpressure");
    metrics.increment("ws.egress_backpressure");
    monitor.check();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "runtime metrics alert",
      expect.objectContaining({
        alert: "ws.backpressure_high",
        metric: "ws.egress_backpressure",
        observed: 2
      })
    );
  });

  it("emits warnings when timing p99 crosses the configured threshold", () => {
    const metrics = new InMemoryMetrics();
    const logger = createLogger();
    const monitor = new MetricsAlertMonitor({
      metrics,
      logger,
      windowMs: 30_000,
      thresholds: {
        httpRequestP99Ms: 50
      }
    });

    metrics.timing("http.request_ms", 10);
    metrics.timing("http.request_ms", 75);
    monitor.check();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "runtime metrics alert",
      expect.objectContaining({
        alert: "http.request_p99_high",
        metric: "http.request_ms",
        observedP99Ms: 75
      })
    );
  });

  it("keeps timing alerts accurate after the windowed buffer rolls over", () => {
    const metrics = new WindowedMetrics(2);
    const logger = createLogger();
    const monitor = new MetricsAlertMonitor({
      metrics,
      logger,
      windowMs: 30_000,
      thresholds: {
        httpRequestP99Ms: 50
      }
    });

    metrics.timing("http.request_ms", 10);
    metrics.timing("http.request_ms", 20);
    monitor.check();
    expect(logger.warn).toHaveBeenCalledTimes(0);

    metrics.timing("http.request_ms", 70);
    metrics.timing("http.request_ms", 80);
    monitor.check();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "runtime metrics alert",
      expect.objectContaining({
        alert: "http.request_p99_high",
        metric: "http.request_ms",
        observedP99Ms: 80,
        sampleCount: 2
      })
    );
  });
});
