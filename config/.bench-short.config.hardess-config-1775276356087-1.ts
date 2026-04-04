import type { HardessConfig } from "../src/shared/types.ts";

export const hardessConfig: HardessConfig = {
  pipelines: [
    {
      id: "bench-short",
      matchPrefix: "/bench",
      auth: {
        required: true
      },
      downstream: {
        origin: "http://127.0.0.1:9",
        connectTimeoutMs: 10,
        responseTimeoutMs: 10,
        forwardAuthContext: false
      },
      worker: {
        entry: "workers/bench-short-worker.ts",
        timeoutMs: 50
      }
    }
  ]
};
