import type { HardessConfig } from "../src/shared/types.ts";

export const hardessConfig: HardessConfig = {
  pipelines: [
    {
      id: "demo-http",
      matchPrefix: "/demo",
      auth: {
        required: true
      },
      downstream: {
        origin: "http://127.0.0.1:9000",
        connectTimeoutMs: 1000,
        responseTimeoutMs: 5000,
        forwardAuthContext: true,
        injectedHeaders: {
          "x-hardess-pipeline": "demo-http"
        }
      },
      worker: {
        entry: "workers/demo-worker.ts",
        timeoutMs: 50
      }
    }
  ]
};
