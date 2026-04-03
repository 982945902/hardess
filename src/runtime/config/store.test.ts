import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  });
});
