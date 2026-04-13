import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, PipelineConfig } from "../../shared/types.ts";
import { ConsoleLogger } from "../observability/logger.ts";
import { runWorker } from "./runner.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

const auth: AuthContext = {
  peerId: "alice",
  tokenId: "demo:alice",
  capabilities: ["notify.conn"],
  expiresAt: Date.now() + 60_000
};

const pipeline: PipelineConfig = {
  id: "demo-http",
  matchPrefix: "/demo",
  auth: { required: true },
  downstream: {
    origin: "http://127.0.0.1:9000",
    connectTimeoutMs: 1000,
    responseTimeoutMs: 5000,
    forwardAuthContext: true
  },
  worker: {
    entry: "workers/demo-worker.ts",
    timeoutMs: 100
  }
};

describe("runWorker", () => {
  it("returns a replacement request from the demo worker", async () => {
    const result = await runWorker(
      new Request("http://localhost/demo", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      auth,
      pipeline,
      "trace-1",
      new ConsoleLogger()
    );

    expect(result.request).toBeDefined();
    expect(result.request?.headers.get("x-hardess-worker")).toBe("demo-http");
    expect(result.request?.headers.get("x-hardess-auth-peer")).toBe("alice");
  });

  it("rejects worker results that do not match the contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-worker-invalid-"));
    cleanupPaths.push(dir);

    const workerPath = join(dir, "invalid-worker.ts");
    await writeFile(
      workerPath,
      `export default {
        fetch() {
          return { unexpected: true };
        }
      };`
    );

    const invalidPipeline: PipelineConfig = {
      ...pipeline,
      worker: {
        entry: workerPath,
        timeoutMs: 100
      }
    };

    await expect(
      runWorker(
        new Request("http://localhost/demo"),
        auth,
        invalidPipeline,
        "trace-invalid",
        new ConsoleLogger()
      )
    ).rejects.toThrow("Worker returned an invalid result");
  });
});
