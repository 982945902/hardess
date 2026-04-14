import { describe, expect, it } from "bun:test";
import { CompositeMetrics, InMemoryMetrics, WindowedMetrics } from "./metrics.ts";

describe("InMemoryMetrics", () => {
  it("tracks counters and timings and can snapshot state", () => {
    const metrics = new InMemoryMetrics();

    metrics.increment("ws.open");
    metrics.increment("ws.open", 2);
    metrics.timing("http.request_ms", 12);
    metrics.timing("http.request_ms", 18);

    expect(metrics.counter("ws.open")).toBe(3);
    expect(metrics.timings("http.request_ms")).toEqual([12, 18]);
    expect(metrics.snapshot()).toEqual({
      counters: {
        "ws.open": 3
      },
      timings: {
        "http.request_ms": [12, 18]
      },
      timingCounts: {
        "http.request_ms": 2
      }
    });
  });

  it("keeps timing history bounded in windowed metrics", () => {
    const metrics = new WindowedMetrics(2);

    metrics.timing("http.request_ms", 10);
    metrics.timing("http.request_ms", 20);
    metrics.timing("http.request_ms", 30);

    expect(metrics.snapshot()).toEqual({
      counters: {},
      timings: {
        "http.request_ms": [20, 30]
      },
      timingCounts: {
        "http.request_ms": 3
      }
    });
  });

  it("fans out metrics updates to multiple sinks", () => {
    const left = new InMemoryMetrics();
    const right = new InMemoryMetrics();
    const metrics = new CompositeMetrics([left, right]);

    metrics.increment("ws.open");
    metrics.timing("http.request_ms", 12);

    expect(left.snapshot()).toEqual({
      counters: {
        "ws.open": 1
      },
      timings: {
        "http.request_ms": [12]
      },
      timingCounts: {
        "http.request_ms": 1
      }
    });
    expect(right.snapshot()).toEqual(left.snapshot());
  });
});
