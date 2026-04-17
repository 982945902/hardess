import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServiceModule } from "./loader.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("loadServiceModule", () => {
  it("reloads when the module file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-"));
    cleanupPaths.push(dir);

    const modulePath = join(dir, "chat.ts");
    await writeFile(
      modulePath,
      `export default {
        protocol: "chat",
        version: "1.0",
        actions: {
          send: {
            resolveRecipients() {
              return ["alice"];
            }
          }
        }
      };`
    );

    const v1 = await loadServiceModule(modulePath);
    expect(v1.protocol).toBe("chat");
    expect(v1.version).toBe("1.0");

    await Bun.sleep(5);
    await writeFile(
      modulePath,
      `export default {
        protocol: "chat",
        version: "2.0",
        actions: {
          send: {
            resolveRecipients() {
              return ["bob"];
            }
          }
        }
      };`
    );

    const v2 = await loadServiceModule(modulePath);
    expect(v2.protocol).toBe("chat");
    expect(v2.version).toBe("2.0");
  });

  it("rejects invalid service module exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-invalid-"));
    cleanupPaths.push(dir);

    const modulePath = join(dir, "invalid.ts");
    await writeFile(
      modulePath,
      `export default {
        name: "chat"
      };`
    );

    await expect(loadServiceModule(modulePath)).rejects.toThrow(
      "service module must export { protocol, version, actions }"
    );
  });
});
