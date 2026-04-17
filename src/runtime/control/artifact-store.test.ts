import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactManifest, Assignment } from "../../shared/index.ts";
import { ArtifactStore } from "./artifact-store.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

function createAssignment(sourceUri: string): Assignment {
  return {
    assignmentId: "assign-http-1",
    hostId: "host-a",
    deploymentId: "deploy-http",
    deploymentKind: "http_worker",
    declaredVersion: "worker-v1",
    artifact: {
      manifestId: "manifest-http-1",
      sourceUri
    },
    httpWorker: {
      name: "demo-http",
      entry: "workers/demo-worker.ts",
      routeRefs: ["route-a"]
    }
  };
}

function createManifest(sourceUri: string): ArtifactManifest {
  return {
    manifestId: "manifest-http-1",
    artifactKind: "http_worker",
    declaredVersion: "worker-v1",
    source: {
      uri: sourceUri
    },
    entry: "workers/demo-worker.ts",
    packageManager: {
      kind: "deno"
    }
  };
}

function createServiceModuleAssignment(sourceUri: string): Assignment {
  return {
    assignmentId: "assign-ws-1",
    hostId: "host-a",
    deploymentId: "deploy-ws",
    deploymentKind: "service_module",
    declaredVersion: "ws-v1",
    artifact: {
      manifestId: "manifest-ws-1",
      sourceUri
    },
    serviceModule: {
      name: "chat",
      entry: "services/chat.ts"
    }
  };
}

function createServiceModuleManifest(sourceUri: string): ArtifactManifest {
  return {
    manifestId: "manifest-ws-1",
    artifactKind: "service_module",
    declaredVersion: "ws-v1",
    source: {
      uri: sourceUri
    },
    entry: "services/chat.ts",
    packageManager: {
      kind: "deno"
    }
  };
}

describe("ArtifactStore", () => {
  it("stages a file-backed worker artifact into the local cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "remote-worker.ts");
    await writeFile(sourcePath, `export default { fetch() { return new Response("ok"); } };`, "utf8");

    const store = new ArtifactStore({
      rootDir: join(dir, "cache")
    });

    const result = await store.stageHttpWorker(
      createAssignment(sourcePath),
      createManifest(`file://${sourcePath}`)
    );

    expect(result.localEntry.endsWith("workers/demo-worker.ts")).toBe(true);
    expect(await readFile(result.localEntry, "utf8")).toContain('new Response("ok")');
  });

  it("stages a file-backed service module artifact into the local cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-service-module-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "remote-service-module.ts");
    await writeFile(
      sourcePath,
      `export default { protocol: "chat", version: "1.0", actions: { send: {} } };`,
      "utf8"
    );

    const store = new ArtifactStore({
      rootDir: join(dir, "cache")
    });

    const result = await store.stageServiceModule(
      createServiceModuleAssignment(sourcePath),
      createServiceModuleManifest(`file://${sourcePath}`)
    );

    expect(result.localEntry.endsWith("services/chat.ts")).toBe(true);
    expect(await readFile(result.localEntry, "utf8")).toContain('protocol: "chat"');
  });

  it("stages bun package files beside the worker and prepares once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-project-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "remote-worker.ts");
    await writeFile(sourcePath, `export default { fetch() { return new Response("ok"); } };`, "utf8");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo-worker",
        type: "module"
      }),
      "utf8"
    );
    await writeFile(join(dir, "bun.lock"), JSON.stringify({ lockfileVersion: 1 }), "utf8");

    const prepareRunner = mock(async () => {});
    const store = new ArtifactStore({
      rootDir: join(dir, "cache"),
      prepareRunner
    });

    const result = await store.stageHttpWorker(createAssignment(sourcePath), {
      ...createManifest(`file://${sourcePath}`),
      packageManager: {
        kind: "bun",
        packageJson: "package.json",
        bunLock: "bun.lock",
        frozenLock: true
      }
    });
    await store.stageHttpWorker(createAssignment(sourcePath), {
      ...createManifest(`file://${sourcePath}`),
      packageManager: {
        kind: "bun",
        packageJson: "package.json",
        bunLock: "bun.lock",
        frozenLock: true
      }
    });

    expect(await readFile(join(dir, "cache", "manifest-http-1", "package.json"), "utf8")).toContain(
      '"name":"demo-worker"'
    );
    expect(await readFile(join(dir, "cache", "manifest-http-1", "bun.lock"), "utf8")).toContain(
      '"lockfileVersion":1'
    );
    expect(result.localEntry.endsWith("workers/demo-worker.ts")).toBe(true);
    expect(prepareRunner).toHaveBeenCalledTimes(1);
    expect(prepareRunner).toHaveBeenCalledWith(
      "bun",
      expect.arrayContaining(["install", "--frozen-lockfile"]),
      {
        cwd: join(dir, "cache", "manifest-http-1")
      }
    );
  });

  it("stages deno project files when declared by the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-deno-project-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "remote-worker.ts");
    await writeFile(sourcePath, `export default { fetch() { return new Response("ok"); } };`, "utf8");
    await writeFile(join(dir, "deno.json"), JSON.stringify({ imports: { "@lib/": "./lib/" } }), "utf8");
    await writeFile(join(dir, "deno.lock"), JSON.stringify({ version: "4" }), "utf8");

    const prepareRunner = mock(async () => {});
    const store = new ArtifactStore({
      rootDir: join(dir, "cache"),
      prepareRunner
    });

    await store.stageHttpWorker(createAssignment(sourcePath), {
      ...createManifest(`file://${sourcePath}`),
      packageManager: {
        kind: "deno",
        denoJson: "deno.json",
        denoLock: "deno.lock",
        frozenLock: true
      }
    });

    expect(await readFile(join(dir, "cache", "manifest-http-1", "deno.json"), "utf8")).toContain(
      '"@lib/"'
    );
    expect(await readFile(join(dir, "cache", "manifest-http-1", "deno.lock"), "utf8")).toContain(
      '"version":"4"'
    );
    expect(prepareRunner).not.toHaveBeenCalled();
  });

  it("reuses staged artifact metadata for remote worker sources when a digest is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-http-"));
    cleanupPaths.push(dir);

    const workerSource = `export default { fetch() { return new Response("cached"); } };`;
    const fetchFn = mock(async () =>
      new Response(workerSource, {
        status: 200
      })
    );
    const store = new ArtifactStore({
      rootDir: join(dir, "cache"),
      fetchFn
    });

    const assignment = createAssignment("https://admin.example/http-worker.ts");
    const manifest = {
      ...createManifest("https://admin.example/http-worker.ts"),
      source: {
        uri: "https://admin.example/http-worker.ts",
        digest: `sha256:${createHash("sha256").update(workerSource).digest("hex")}`
      }
    };

    const first = await store.stageHttpWorker(assignment, manifest);
    const second = await store.stageHttpWorker(assignment, manifest);

    expect(first.localEntry).toBe(second.localEntry);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not reuse remote worker cache entries without a digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-http-nodigest-"));
    cleanupPaths.push(dir);

    const fetchFn = mock(async () =>
      new Response(`export default { fetch() { return new Response("fresh"); } };`, {
        status: 200
      })
    );
    const store = new ArtifactStore({
      rootDir: join(dir, "cache"),
      fetchFn
    });

    const assignment = createAssignment("https://admin.example/http-worker.ts");
    const manifest = createManifest("https://admin.example/http-worker.ts");

    await store.stageHttpWorker(assignment, manifest);
    await store.stageHttpWorker(assignment, manifest);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("restages the artifact when metadata exists but the cached entry file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-restage-"));
    cleanupPaths.push(dir);

    const fetchFn = mock(async () =>
      new Response(`export default { fetch() { return new Response("restaged"); } };`, {
        status: 200
      })
    );
    const store = new ArtifactStore({
      rootDir: join(dir, "cache"),
      fetchFn
    });

    const assignment = createAssignment("https://admin.example/http-worker.ts");
    const manifest = createManifest("https://admin.example/http-worker.ts");

    const first = await store.stageHttpWorker(assignment, manifest);
    await rm(first.localEntry, { force: true });
    const second = await store.stageHttpWorker(assignment, manifest);

    expect(second.localEntry).toBe(first.localEntry);
    expect(await readFile(second.localEntry, "utf8")).toContain('new Response("restaged")');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("restages local companion project files when their content changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-artifacts-local-companion-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "remote-worker.ts");
    const denoJsonPath = join(dir, "deno.json");
    await writeFile(sourcePath, `export default { fetch() { return new Response("ok"); } };`, "utf8");
    await writeFile(denoJsonPath, JSON.stringify({ imports: { "@lib/": "./lib-v1/" } }), "utf8");

    const store = new ArtifactStore({
      rootDir: join(dir, "cache")
    });

    const manifest: ArtifactManifest = {
      ...createManifest(`file://${sourcePath}`),
      packageManager: {
        kind: "deno",
        denoJson: "deno.json"
      }
    };

    await store.stageHttpWorker(createAssignment(sourcePath), manifest);
    await writeFile(denoJsonPath, JSON.stringify({ imports: { "@lib/": "./lib-v2/" } }), "utf8");
    await store.stageHttpWorker(createAssignment(sourcePath), manifest);

    expect(await readFile(join(dir, "cache", "manifest-http-1", "deno.json"), "utf8")).toContain(
      "lib-v2"
    );
  });
});
