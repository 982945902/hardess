import type { HardessConfig } from "../src/shared/types.ts";

export const hardessConfig: HardessConfig = {
  pipelines: [
    {
      id: "benchmark-short-circuit",
      matchPrefix: "/benchmark",
      auth: {
        required: false
      },
      downstream: {
        origin: "http://127.0.0.1:9000",
        connectTimeoutMs: 1000,
        responseTimeoutMs: 5000,
        forwardAuthContext: false
      },
      worker: {
        entry: "workers/benchmark-short-circuit.ts",
        timeoutMs: 50
      }
    }
  ]
};
