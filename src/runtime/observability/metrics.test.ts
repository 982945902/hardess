import { describe, expect, it } from "bun:test";
import { InMemoryMetrics } from "./metrics.ts";

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
      }
    });
  });
});
