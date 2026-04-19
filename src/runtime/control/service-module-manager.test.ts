import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HardessError,
  computeServiceModuleProtocolPackageDigest,
  type ArtifactManifest,
  type Assignment
} from "../../shared/index.ts";
import { ServerProtocolRegistry } from "../protocol/registry.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ServiceModuleManager } from "./service-module-manager.ts";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

function createServiceAssignment(sourceUri: string, version = "ws-v1"): Assignment {
  return {
    assignmentId: "assign-ws-1",
    hostId: "host-a",
    deploymentId: "deploy-ws",
    deploymentKind: "service_module",
    declaredVersion: version,
    artifact: {
      manifestId: "manifest-ws-1",
      sourceUri
    },
    serviceModule: {
      name: "chat",
      entry: "services/chat.ts",
      protocolPackage: {
        protocol: "chat",
        version: "1.0",
        actions: ["send"],
        digest: computeServiceModuleProtocolPackageDigest({
          protocol: "chat",
          version: "1.0",
          actions: ["send"]
        })
      }
    }
  };
}

function createServiceManifest(sourceUri: string, version = "ws-v1"): ArtifactManifest {
  return {
    manifestId: "manifest-ws-1",
    artifactKind: "service_module",
    declaredVersion: version,
    source: {
      uri: sourceUri
    },
    entry: "services/chat.ts",
    packageManager: {
      kind: "deno"
    }
  };
}

function createLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  };
}

type AssignmentState = {
  deploymentId?: string;
  declaredVersion?: string;
  state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
  generationId?: string;
  preparedAt?: number;
  activatedAt?: number;
};

describe("ServiceModuleManager", () => {
  it("keeps removed service modules draining until the grace period expires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-manager-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "chat.ts");
    await writeFile(
      sourcePath,
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
      };`,
      "utf8"
    );

    const registry = new ServerProtocolRegistry();
    const manager = new ServiceModuleManager({
      registry,
      artifactStore: new ArtifactStore({
        rootDir: join(dir, "cache")
      }),
      logger: createLogger(),
      drainGraceMs: 30
    });
    const assignmentStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          state: "preparing" as const
        }
      ]
    ]);

    await manager.applyAssignments({
      assignments: [createServiceAssignment(sourcePath)],
      artifacts: new Map([
        ["manifest-ws-1", createServiceManifest(`file://${sourcePath}`)]
      ]),
      assignmentStates,
      revision: "rev-1",
      revisionGenerationId: "admin:rev-1"
    });

    expect(registry.get("chat", "1.0", "send")).toBeDefined();
    expect(assignmentStates.get("assign-ws-1")).toMatchObject({
      state: "ready",
      generationId: "admin:rev-1"
    });

    const activatedAt = Date.now();
    assignmentStates.set("assign-ws-1", {
      deploymentId: "deploy-ws",
      declaredVersion: "ws-v1",
      state: "active",
      generationId: "admin:rev-1",
      preparedAt: assignmentStates.get("assign-ws-1")?.preparedAt,
      activatedAt
    });

    await manager.applyAssignments({
      assignments: [],
      artifacts: new Map(),
      assignmentStates: new Map(),
      revision: "rev-2",
      revisionGenerationId: "admin:rev-2",
      previousAssignmentStates: assignmentStates
    });

    expect(registry.get("chat", "1.0", "send")).toBeDefined();
    expect(manager.listDrainingAssignments()).toEqual([
      {
        assignmentId: "assign-ws-1",
        deploymentId: "deploy-ws",
        declaredVersion: "ws-v1",
        generationId: "admin:rev-1",
        state: "draining",
        preparedAt: assignmentStates.get("assign-ws-1")?.preparedAt,
        activatedAt
      }
    ]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(() => registry.get("chat", "1.0", "send")).toThrow(HardessError);
    expect(manager.listDrainingAssignments()).toEqual([]);
  });

  it("cancels draining when the same assignment is re-added before grace expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-manager-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "chat.ts");
    await writeFile(
      sourcePath,
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
      };`,
      "utf8"
    );

    const registry = new ServerProtocolRegistry();
    const manager = new ServiceModuleManager({
      registry,
      artifactStore: new ArtifactStore({
        rootDir: join(dir, "cache")
      }),
      logger: createLogger(),
      drainGraceMs: 60
    });
    const firstStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          deploymentId: "deploy-ws",
          declaredVersion: "ws-v1",
          state: "preparing" as const
        }
      ]
    ]);

    await manager.applyAssignments({
      assignments: [createServiceAssignment(sourcePath)],
      artifacts: new Map([
        ["manifest-ws-1", createServiceManifest(`file://${sourcePath}`)]
      ]),
      assignmentStates: firstStates,
      revision: "rev-1",
      revisionGenerationId: "admin:rev-1"
    });

    const previousStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          deploymentId: "deploy-ws",
          declaredVersion: "ws-v1",
          state: "active" as const,
          generationId: "admin:rev-1",
          preparedAt: firstStates.get("assign-ws-1")?.preparedAt,
          activatedAt: Date.now()
        }
      ]
    ]);

    await manager.applyAssignments({
      assignments: [],
      artifacts: new Map(),
      assignmentStates: new Map(),
      revision: "rev-2",
      revisionGenerationId: "admin:rev-2",
      previousAssignmentStates: previousStates
    });

    expect(manager.listDrainingAssignments()).toHaveLength(1);

    const reAddStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          deploymentId: "deploy-ws",
          declaredVersion: "ws-v1",
          state: "preparing" as const
        }
      ]
    ]);

    await manager.applyAssignments({
      assignments: [createServiceAssignment(sourcePath)],
      artifacts: new Map([
        ["manifest-ws-1", createServiceManifest(`file://${sourcePath}`)]
      ]),
      assignmentStates: reAddStates,
      revision: "rev-3",
      revisionGenerationId: "admin:rev-3",
      previousAssignmentStates: previousStates
    });

    expect(registry.get("chat", "1.0", "send")).toBeDefined();
    expect(manager.listDrainingAssignments()).toEqual([]);
  });

  it("fails when the bound protocol package does not match the loaded service module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-manager-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "chat.ts");
    await writeFile(
      sourcePath,
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
      };`,
      "utf8"
    );

    const registry = new ServerProtocolRegistry();
    const manager = new ServiceModuleManager({
      registry,
      artifactStore: new ArtifactStore({
        rootDir: join(dir, "cache")
      }),
      logger: createLogger(),
      drainGraceMs: 30
    });
    const assignment = createServiceAssignment(sourcePath);
    assignment.serviceModule = {
      ...assignment.serviceModule!,
      protocolPackage: {
        protocol: "chat",
        version: "1.0",
        actions: ["send", "typing"],
        digest: computeServiceModuleProtocolPackageDigest({
          protocol: "chat",
          version: "1.0",
          actions: ["send", "typing"]
        })
      }
    };
    const assignmentStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          state: "preparing" as const
        }
      ]
    ]);

    await expect(
      manager.applyAssignments({
        assignments: [assignment],
        artifacts: new Map([
          ["manifest-ws-1", createServiceManifest(`file://${sourcePath}`)]
        ]),
        assignmentStates,
        revision: "rev-1",
        revisionGenerationId: "admin:rev-1"
      })
    ).rejects.toThrow("Service module action set mismatch");

    expect(assignmentStates.get("assign-ws-1")).toMatchObject({
      state: "failed"
    });
    expect(() => registry.get("chat", "1.0", "send")).toThrow(HardessError);
  });

  it("fails when the bound protocol package digest is tampered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-service-module-manager-"));
    cleanupPaths.push(dir);

    const sourcePath = join(dir, "chat.ts");
    await writeFile(
      sourcePath,
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
      };`,
      "utf8"
    );

    const registry = new ServerProtocolRegistry();
    const manager = new ServiceModuleManager({
      registry,
      artifactStore: new ArtifactStore({
        rootDir: join(dir, "cache")
      }),
      logger: createLogger(),
      drainGraceMs: 30
    });
    const assignment = createServiceAssignment(sourcePath);
    assignment.serviceModule = {
      ...assignment.serviceModule!,
      protocolPackage: {
        ...assignment.serviceModule!.protocolPackage,
        digest: "sha256:tampered"
      }
    };
    const assignmentStates = new Map<string, AssignmentState>([
      [
        "assign-ws-1",
        {
          state: "preparing" as const
        }
      ]
    ]);

    await expect(
      manager.applyAssignments({
        assignments: [assignment],
        artifacts: new Map([
          ["manifest-ws-1", createServiceManifest(`file://${sourcePath}`)]
        ]),
        assignmentStates,
        revision: "rev-1",
        revisionGenerationId: "admin:rev-1"
      })
    ).rejects.toThrow("Service module protocol package digest mismatch");

    expect(assignmentStates.get("assign-ws-1")).toMatchObject({
      state: "failed"
    });
  });
});
