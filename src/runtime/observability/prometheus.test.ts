import { describe, expect, it } from "bun:test";
import { renderPrometheusMetrics } from "./prometheus.ts";

describe("renderPrometheusMetrics", () => {
  it("renders counters and timing summaries in prometheus text format", () => {
    const text = renderPrometheusMetrics(
      {
        counters: {
          "ws.open": 3
        },
        timings: {
          "http.request_ms": [10, 20, 30]
        },
        timingCounts: {
          "http.request_ms": 3
        }
      },
      {
        prefix: "hardess"
      }
    );

    expect(text).toContain("hardess_ws_open_total 3");
    expect(text).toContain("hardess_http_request_ms_milliseconds_count 3");
    expect(text).toContain('hardess_http_request_ms_milliseconds{stat="p90"} 30');
  });
});
