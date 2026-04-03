import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeApp } from "./app.ts";

const originalFetch = globalThis.fetch;
const cleanupPaths: string[] = [];
const appDisposers: Array<() => void> = [];

beforeEach(() => {
  globalThis.fetch = mock(async (request: Request) => {
    return Response.json({
      ok: true,
      upstreamUrl: request.url,
      peerId: request.headers.get("x-hardess-peer-id"),
      workerId: request.headers.get("x-hardess-worker")
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  while (appDisposers.length > 0) {
    appDisposers.pop()?.();
  }
});

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("createRuntimeApp", () => {
  it("serves the HTTP runtime path through the app fetch entrypoint", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts"
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://127.0.0.1:9000/demo/health",
      peerId: "alice",
      workerId: "demo-http"
    });
  });

  it("returns 426 when websocket upgrade fails", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts"
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/ws"),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response?.status).toBe(426);
  });

  it("applies reloaded config to new requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-app-config-"));
    cleanupPaths.push(dir);

    const configPath = join(dir, "hardess.config.ts");
    const writeConfig = async (origin: string) => {
      await writeFile(
        configPath,
        `export const hardessConfig = {
          pipelines: [
            {
              id: "demo-http",
              matchPrefix: "/demo",
              auth: { required: true },
              downstream: {
                origin: "${origin}",
                connectTimeoutMs: 1000,
                responseTimeoutMs: 5000,
                forwardAuthContext: true
              },
              worker: {
                entry: "workers/demo-worker.ts",
                timeoutMs: 100
              }
            }
          ]
        };`
      );
    };

    await writeConfig("http://upstream-a.internal");
    const app = await createRuntimeApp({
      configModulePath: configPath
    });
    appDisposers.push(() => app.dispose());

    const firstResponse = await app.fetch(
      new Request("http://localhost/demo/reload", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(await firstResponse?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://upstream-a.internal/demo/reload",
      peerId: "alice",
      workerId: "demo-http"
    });

    await Bun.sleep(5);
    await writeConfig("http://upstream-b.internal");
    await app.configStore.reload();

    const secondResponse = await app.fetch(
      new Request("http://localhost/demo/reload", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(await secondResponse?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://upstream-b.internal/demo/reload",
      peerId: "alice",
      workerId: "demo-http"
    });
  });
});
