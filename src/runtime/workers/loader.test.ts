import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("loads serve modules and adapts them into worker fetch handlers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-serve-module-"));
    cleanupPaths.push(dir);

    const workerPath = join(dir, "personnel-serve.ts");
    const sdkPath = resolve(process.cwd(), "src/sdk/index.ts");
    await writeFile(
      workerPath,
      `
        import { createApp, createRouter, defineServe } from ${JSON.stringify(sdkPath)};

        const users = createRouter();
        users.get("/:id", (_request, _env, ctx) => Response.json({
          kind: "user",
          id: ctx.params.id,
          path: ctx.path,
          originalPath: ctx.originalPath
        }));

        const app = createApp();
        app.use("/users", users);
        app.get("/health", () => new Response("ok"));

        export default defineServe(app);
      `
    );

    const worker = await loadWorker(workerPath);
    const env = {
      auth: {
        peerId: "alice",
        tokenId: "demo:alice",
        capabilities: [],
        expiresAt: Date.now() + 1000
      },
      pipeline: {
        id: "personnel",
        matchPrefix: "/personnel",
        downstreamOrigin: "http://127.0.0.1:9000"
      }
    };
    const ctx = {
      waitUntil() {}
    };

    const health = await worker.fetch(new Request("http://localhost/personnel/health"), env, ctx);
    const healthResponse = health instanceof Response ? health : health?.response;
    expect(healthResponse ? await healthResponse.text() : null).toBe("ok");

    const user = await worker.fetch(new Request("http://localhost/personnel/users/42"), env, ctx);
    const userResponse = user instanceof Response ? user : user?.response;
    expect(userResponse ? await userResponse.json() : null).toEqual({
      kind: "user",
      id: "42",
      path: "/users/42",
      originalPath: "/personnel/users/42"
    });
  });

  it("does not cache a failed worker load permanently when a dependency becomes available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-worker-transient-"));
    cleanupPaths.push(dir);

    const workerPath = join(dir, "dynamic-worker.ts");
    const dependencyPath = join(dir, "helper.ts");
    await writeFile(
      workerPath,
      `
        import { render } from "./helper.ts";
        export default {
          fetch() {
            return new Response(render());
          }
        };
      `
    );

    await expect(loadWorker(workerPath)).rejects.toThrow();

    await writeFile(
      dependencyPath,
      `export function render() { return "recovered"; }`
    );

    const worker = await loadWorker(workerPath);
    const result = await worker.fetch(
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

    expect(result instanceof Response ? await result.text() : null).toBe("recovered");
  });
});
