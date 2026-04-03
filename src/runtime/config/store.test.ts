import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModuleConfigStore } from "./store.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("ModuleConfigStore", () => {
  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> {
    const startedAt = Date.now();
    while (!(await predicate())) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for condition");
      }

      await Bun.sleep(10);
    }
  }

  it("loads config from a module export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-config-"));
    cleanupPaths.push(dir);

    const configPath = join(dir, "hardess.config.ts");
    await writeFile(
      configPath,
      `export const hardessConfig = {
        pipelines: [
          {
            id: "demo-http",
            matchPrefix: "/demo",
            downstream: {
              origin: "http://127.0.0.1:9000",
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000
            }
          }
        ]
      };`
    );

    const store = new ModuleConfigStore(configPath);
    const config = await store.reload();

    expect(config.pipelines).toHaveLength(1);
    expect(store.getConfig().pipelines[0]?.id).toBe("demo-http");
    store.dispose();
  });

  it("reloads automatically when the config file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-config-watch-"));
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
              downstream: {
                origin: "${origin}",
                connectTimeoutMs: 1000,
                responseTimeoutMs: 5000
              }
            }
          ]
        };`
      );
    };

    await writeConfig("http://upstream-a.internal");
    let watchCallback:
      | ((eventType: string, filename: string | Buffer | null | undefined) => void)
      | undefined;
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;
    const store = new ModuleConfigStore(configPath, "hardessConfig", undefined, {
      watchDebounceMs: 5,
      watchFn(_path, _options, listener) {
        watchCallback = listener;
        return {
          close() {}
        } as unknown as import("node:fs").FSWatcher;
      },
      setTimeoutFn(callback) {
        const id = nextTimerId++;
        timers.set(id, callback as () => void);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn(timeout) {
        timers.delete(timeout as unknown as number);
      }
    });
    await store.reload();
    store.watch();

    await writeConfig("http://upstream-b.internal");
    watchCallback?.("change", basename(configPath));
    watchCallback?.("change", basename(configPath));
    expect(timers.size).toBe(1);
    timers.values().next().value?.();

    await waitFor(() => store.getConfig().pipelines[0]?.downstream.origin === "http://upstream-b.internal");
    store.dispose();
  });

  it("stops watching after dispose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-config-dispose-"));
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
              downstream: {
                origin: "${origin}",
                connectTimeoutMs: 1000,
                responseTimeoutMs: 5000
              }
            }
          ]
        };`
      );
    };

    await writeConfig("http://upstream-a.internal");
    let watchCallback:
      | ((eventType: string, filename: string | Buffer | null | undefined) => void)
      | undefined;
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;
    const store = new ModuleConfigStore(configPath, "hardessConfig", undefined, {
      watchDebounceMs: 5,
      watchFn(_path, _options, listener) {
        watchCallback = listener;
        return {
          close() {}
        } as unknown as import("node:fs").FSWatcher;
      },
      setTimeoutFn(callback) {
        const id = nextTimerId++;
        timers.set(id, callback as () => void);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn(timeout) {
        timers.delete(timeout as unknown as number);
      }
    });
    await store.reload();
    store.watch();
    store.dispose();

    await writeConfig("http://upstream-b.internal");
    watchCallback?.("change", basename(configPath));
    timers.values().next().value?.();
    await Bun.sleep(20);

    expect(store.getConfig().pipelines[0]?.downstream.origin).toBe("http://upstream-a.internal");
  });
});
