import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorker } from "./loader.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("loadWorker", () => {
  it("reloads when the worker file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-worker-"));
    cleanupPaths.push(dir);

    const workerPath = join(dir, "dynamic-worker.ts");
    await writeFile(
      workerPath,
      `export default { fetch() { return new Response("v1"); } };`
    );

    const v1 = await loadWorker(workerPath);
    const firstResult = await v1.fetch(
      new Request("http://localhost/demo"),
      {
        auth: {
          peerId: "alice",
          tokenId: "demo:alice",
          capabilities: [],
          expiresAt: Date.now() + 1000
        },
        pipeline: {
          id: "demo",
          matchPrefix: "/demo",
          downstreamOrigin: "http://127.0.0.1:9000"
        }
      },
      {
        waitUntil() {}
      }
    );

    expect(firstResult instanceof Response ? await firstResult.text() : null).toBe("v1");

    await Bun.sleep(5);
    await writeFile(
      workerPath,
      `export default { fetch() { return new Response("v2"); } };`
    );

    const v2 = await loadWorker(workerPath);
    const secondResult = await v2.fetch(
      new Request("http://localhost/demo"),
      {
        auth: {
          peerId: "alice",
          tokenId: "demo:alice",
          capabilities: [],
          expiresAt: Date.now() + 1000
        },
        pipeline: {
          id: "demo",
          matchPrefix: "/demo",
          downstreamOrigin: "http://127.0.0.1:9000"
        }
      },
      {
        waitUntil() {}
      }
    );

    expect(secondResult instanceof Response ? await secondResult.text() : null).toBe("v2");
  });

  it("rejects worker modules that do not export fetch(request, env, ctx)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-worker-invalid-module-"));
    cleanupPaths.push(dir);

    const workerPath = join(dir, "invalid-worker.ts");
    await writeFile(
      workerPath,
      `export default {
        handle() {
          return new Response("nope");
        }
      };`
    );

    await expect(loadWorker(workerPath)).rejects.toThrow(
      "worker module must export fetch(request, env, ctx)"
    );
  });
});
