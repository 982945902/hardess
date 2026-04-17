import { describe, expect, it } from "bun:test";
import {
  parseArtifactManifest,
  parseAssignment,
  parseDesiredHostState,
  parseHostRegistration,
  parseObservedHostState
} from "./admin-schema.ts";

describe("admin protocol schemas", () => {
  it("parses a valid host registration", () => {
    const value = parseHostRegistration({
      hostId: "host-a",
      nodeId: "node-a",
      startedAt: Date.now(),
      runtime: {
        kind: "hardess-v1",
        version: "1.0.0",
        pid: 123
      },
      network: {
        publicBaseUrl: "http://10.0.0.1:3000",
        internalBaseUrl: "http://10.0.0.1:3100",
        publicListenerEnabled: true,
        internalListenerEnabled: true
      },
      staticLabels: {
        zone: "cn-sh-1"
      },
      staticCapabilities: ["ws", "http"],
      staticCapacity: {
        maxHttpWorkerAssignments: 8
      },
      dynamicFields: {
        loadClass: "small"
      }
    });

    expect(value.hostId).toBe("host-a");
    expect(value.staticLabels.zone).toBe("cn-sh-1");
  });

  it("parses a desired host state with serve plus service-module assignments", () => {
    const value = parseDesiredHostState({
      hostId: "host-a",
      revision: "rev-42",
      generatedAt: Date.now(),
      topology: {
        membership: {
          revision: "topology:42:membership",
          generatedAt: Date.now(),
          hosts: [
            {
              hostId: "host-a",
              publicBaseUrl: "http://10.0.0.1:3000",
              internalBaseUrl: "http://10.0.0.1:3100",
              publicListenerEnabled: true,
              internalListenerEnabled: true,
              state: "ready",
              staticLabels: {
                zone: "cn-sh-1"
              },
              staticCapabilities: ["http", "ws"],
              staticCapacity: {
                maxHttpWorkerAssignments: 8
              },
              lastSeenAt: Date.now()
            }
          ]
        },
        placement: {
          revision: "topology:42:placement",
          generatedAt: Date.now(),
          deployments: [
            {
              deploymentId: "deploy-http",
              deploymentKind: "serve",
              groupId: "group-core",
              ownerHostIds: ["host-a"],
              routes: [
                {
                  routeId: "route-a",
                  pathPrefix: "/demo",
                  ownerHostIds: ["host-a"]
                }
              ]
            }
          ]
        }
      },
      assignments: [
        {
          assignmentId: "assign-http-1",
          hostId: "host-a",
          deploymentId: "deploy-http",
          deploymentKind: "serve",
          groupId: "group-core",
          declaredVersion: "worker-v3",
          artifact: {
            manifestId: "manifest-http-1",
            sourceUri: "https://admin.example/artifacts/http-worker.tgz",
            digest: "sha256:abc"
          },
          serveApp: {
            name: "demo-http",
            entry: "apps/demo-serve.ts",
            routeRefs: ["route-a"]
          }
        },
        {
          assignmentId: "assign-ws-1",
          hostId: "host-a",
          deploymentId: "deploy-ws",
          deploymentKind: "service_module",
          declaredVersion: "ws-v2",
          artifact: {
            manifestId: "manifest-ws-1",
            sourceUri: "https://admin.example/artifacts/chat-module.tgz"
          },
          serviceModule: {
            name: "chat",
            entry: "services/chat.ts"
          }
        }
      ],
      sharedHttpForwardConfig: {
        routes: [
          {
            routeId: "route-a",
            match: {
              pathPrefix: "/demo"
            },
            upstream: {
              baseUrl: "https://upstream.example",
              websocketEnabled: true
            }
          }
        ]
      }
    });

    expect(value.assignments).toHaveLength(2);
    expect(value.topology?.membership.hosts[0]?.state).toBe("ready");
    expect(value.topology?.placement.deployments[0]?.ownerHostIds).toEqual(["host-a"]);
    expect(value.assignments[0]?.groupId).toBe("group-core");
    expect(value.assignments[0]?.serveApp?.name).toBe("demo-http");
    expect(value.assignments[1]?.serviceModule?.name).toBe("chat");
  });

  it("rejects mismatched assignment payloads", () => {
    expect(() =>
      parseAssignment({
        assignmentId: "assign-http-1",
        hostId: "host-a",
        deploymentId: "deploy-http",
        deploymentKind: "http_worker",
        declaredVersion: "worker-v3",
        artifact: {
          manifestId: "manifest-http-1",
          sourceUri: "https://admin.example/artifacts/http-worker.tgz"
        },
        serviceModule: {
          name: "chat",
          entry: "services/chat.ts"
        }
      })
    ).toThrow("Invalid Assignment");
  });

  it("parses observed host state and bun artifact manifest", () => {
    const observed = parseObservedHostState({
      hostId: "host-a",
      observedAt: Date.now(),
      ready: true,
      draining: false,
      staticLabels: {
        zone: "cn-sh-1"
      },
      staticCapabilities: ["http", "ws"],
      staticCapacity: {
        maxHttpWorkerAssignments: 8,
        maxServiceModuleAssignments: 8
      },
      dynamicState: {
        currentAssignmentCount: 2,
        currentConnectionCount: 100,
        currentInflightRequests: 8,
        schedulable: true,
        appliedTopology: {
          membershipRevision: "topology:42:membership",
          placementRevision: "topology:42:placement"
        },
        resourceHints: {
          cpu: 0.4
        },
        dynamicFields: {
          degraded: false
        }
      },
      assignmentStatuses: [
        {
          assignmentId: "assign-http-1",
          deploymentId: "deploy-http",
          declaredVersion: "worker-v3",
          generationId: "gen-7",
          state: "active",
          preparedAt: Date.now() - 1000,
          activatedAt: Date.now() - 500
        }
      ]
    });

    const manifest = parseArtifactManifest({
      manifestId: "manifest-http-1",
      artifactKind: "http_worker",
      declaredArtifactId: "artifact-http-1",
      declaredVersion: "worker-v3",
      source: {
        uri: "https://admin.example/artifacts/http-worker.tgz",
        digest: "sha256:abc"
      },
      entry: "workers/demo-worker.ts",
      packageManager: {
        kind: "bun",
        packageJson: "package.json",
        bunLock: "bun.lock",
        frozenLock: true
      },
      metadata: {
        annotations: {
          owner: "platform"
        }
      }
    });

    expect(observed.assignmentStatuses[0]?.state).toBe("active");
    expect(observed.dynamicState.appliedTopology?.membershipRevision).toBe("topology:42:membership");
    expect(manifest.packageManager.kind).toBe("bun");
  });

  it("parses a deno artifact manifest", () => {
    const manifest = parseArtifactManifest({
      manifestId: "manifest-http-2",
      artifactKind: "http_worker",
      declaredVersion: "worker-v4",
      source: {
        uri: "https://admin.example/artifacts/http-worker.ts"
      },
      entry: "workers/demo-worker.ts",
      packageManager: {
        kind: "deno",
        denoJson: "deno.json",
        denoLock: "deno.lock",
        frozenLock: true
      }
    });

    expect(manifest.packageManager.kind).toBe("deno");
  });
});
