import { describe, expect, it } from "bun:test";
import {
  buildPlacementCandidateHosts,
  buildMembershipSnapshot,
  buildPlacementSnapshot,
  buildDeploymentRolloutSummary,
  buildHttpWorkerArtifactManifest,
  planHttpWorkerDeploymentOwners,
  projectHttpWorkerDesiredState
} from "./planning.ts";

describe("admin planning helpers", () => {
  it("projects desired host state for shared and per-host http worker deployments", () => {
    const desiredA = projectHttpWorkerDesiredState({
      hostId: "host-a",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      revisionToken: 2,
      registeredHostIds: ["host-a", "host-b"],
      deployments: [
        {
          deploymentId: "deployment:shared",
          declaredArtifactId: "artifact:shared",
          declaredVersion: "shared/v1",
          manifestId: "manifest:shared",
          replicas: 1,
          assignmentMode: "select-first-n-hosts",
          sourceUri: "https://admin.example/shared.ts",
          sourceDigest: "sha256:abc",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          routeScope: "shared"
        },
        {
          deploymentId: "deployment:host",
          declaredArtifactId: "artifact:host",
          declaredVersion: "host/v1",
          manifestId: "manifest:host",
          assignmentMode: "all-hosts",
          sourceUri: "https://admin.example/host.ts",
          sourceDigest: "sha256:def",
          workerName: "host-worker",
          workerEntry: "workers/host.ts",
          routeId: "route:host",
          routePathPrefix: "/demo/hosts",
          routeScope: "per_host"
        }
      ]
    });

    const desiredB = projectHttpWorkerDesiredState({
      hostId: "host-b",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      revisionToken: 2,
      registeredHostIds: ["host-a", "host-b"],
      deployments: [
        {
          deploymentId: "deployment:shared",
          declaredArtifactId: "artifact:shared",
          declaredVersion: "shared/v1",
          manifestId: "manifest:shared",
          replicas: 1,
          assignmentMode: "select-first-n-hosts",
          sourceUri: "https://admin.example/shared.ts",
          sourceDigest: "sha256:abc",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          routeScope: "shared"
        },
        {
          deploymentId: "deployment:host",
          declaredArtifactId: "artifact:host",
          declaredVersion: "host/v1",
          manifestId: "manifest:host",
          assignmentMode: "all-hosts",
          sourceUri: "https://admin.example/host.ts",
          sourceDigest: "sha256:def",
          workerName: "host-worker",
          workerEntry: "workers/host.ts",
          routeId: "route:host",
          routePathPrefix: "/demo/hosts",
          routeScope: "per_host"
        }
      ]
    });

    expect(desiredA.assignments.map((assignment) => assignment.deploymentId)).toEqual([
      "deployment:shared",
      "deployment:host"
    ]);
    expect(desiredB.assignments.map((assignment) => assignment.deploymentId)).toEqual([
      "deployment:host"
    ]);
    expect(desiredA.sharedHttpForwardConfig?.routes.map((route) => route.match.pathPrefix)).toEqual([
      "/demo/shared",
      "/demo/hosts/host-a"
    ]);
    expect(desiredB.sharedHttpForwardConfig?.routes.map((route) => route.match.pathPrefix)).toEqual([
      "/demo/hosts/host-b"
    ]);
  });

  it("builds artifact manifests and rollout summaries", () => {
    const manifest = buildHttpWorkerArtifactManifest({
      deploymentId: "deployment:shared",
      declaredArtifactId: "artifact:shared",
      declaredVersion: "shared/v1",
      manifestId: "manifest:shared",
      sourceUri: "https://admin.example/shared.ts",
      sourceDigest: "sha256:abc",
      workerName: "shared-worker",
      workerEntry: "workers/shared.ts",
      routeId: "route:shared",
      routePathPrefix: "/demo/shared",
      denoJson: "https://admin.example/deno.json",
      denoLock: "https://admin.example/deno.lock",
      frozenLock: true
    });
    expect(manifest.packageManager.denoJson).toBe("https://admin.example/deno.json");

    const summary = buildDeploymentRolloutSummary(
      [
        {
          hostId: "host-a",
          revision: "rev-a",
          generatedAt: 1,
          sharedHttpForwardConfig: {
            routes: [
              {
                routeId: "route:shared",
                match: {
                  pathPrefix: "/demo/shared"
                },
                upstream: {
                  baseUrl: "http://127.0.0.1:9000"
                }
              }
            ]
          },
          assignments: [
            {
              assignmentId: "assign:host-a:deployment:shared",
              hostId: "host-a",
              deploymentId: "deployment:shared",
              deploymentKind: "http_worker",
              declaredVersion: "shared/v1",
              artifact: {
                manifestId: "manifest:shared",
                sourceUri: "https://admin.example/shared.ts"
              },
              httpWorker: {
                name: "shared-worker",
                entry: "workers/shared.ts",
                routeRefs: ["route:shared"]
              }
            }
          ]
        },
        {
          hostId: "host-b",
          revision: "rev-b",
          generatedAt: 1,
          sharedHttpForwardConfig: {
            routes: [
              {
                routeId: "route:shared",
                match: {
                  pathPrefix: "/demo/shared"
                },
                upstream: {
                  baseUrl: "http://127.0.0.1:9000"
                }
              }
            ]
          },
          assignments: [
            {
              assignmentId: "assign:host-b:deployment:shared",
              hostId: "host-b",
              deploymentId: "deployment:shared",
              deploymentKind: "http_worker",
              declaredVersion: "shared/v1",
              artifact: {
                manifestId: "manifest:shared",
                sourceUri: "https://admin.example/shared.ts"
              },
              httpWorker: {
                name: "shared-worker",
                entry: "workers/shared.ts",
                routeRefs: ["route:shared"]
              }
            }
          ]
        }
      ],
      [
        {
          hostId: "host-a",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 1
          },
          assignmentStatuses: [
            {
              assignmentId: "assign:host-a:deployment:shared",
              deploymentId: "deployment:shared",
              declaredVersion: "shared/v1",
              state: "active"
            }
          ]
        }
      ]
    );

    expect(summary).toEqual([
      expect.objectContaining({
        deploymentId: "deployment:shared",
        desiredHosts: 2,
        activeHosts: 1,
        pendingHosts: 1
      })
    ]);
  });

  it("places replicas using labels, schedulable state, and capacity instead of plain hostId order", () => {
    const candidateHosts = buildPlacementCandidateHosts({
      registrations: [
        {
          hostId: "host-a",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {
            zone: "z1",
            tier: "edge"
          },
          staticCapabilities: ["http", "ws"],
          staticCapacity: {
            maxHttpWorkerAssignments: 4
          }
        },
        {
          hostId: "host-b",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {
            zone: "z2",
            tier: "edge"
          },
          staticCapabilities: ["http", "ws"],
          staticCapacity: {
            maxHttpWorkerAssignments: 2
          }
        },
        {
          hostId: "host-c",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {
            zone: "z1",
            tier: "core"
          },
          staticCapabilities: ["http"],
          staticCapacity: {
            maxHttpWorkerAssignments: 1
          }
        }
      ],
      observedHostStates: [
        {
          hostId: "host-a",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 2,
            schedulable: true
          },
          assignmentStatuses: []
        },
        {
          hostId: "host-b",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 2,
            schedulable: true
          },
          assignmentStatuses: []
        },
        {
          hostId: "host-c",
          observedAt: 1,
          ready: true,
          draining: true,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 0,
            schedulable: true
          },
          assignmentStatuses: []
        }
      ]
    });

    const desiredA = projectHttpWorkerDesiredState({
      hostId: "host-a",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      revisionToken: 3,
      registeredHostIds: ["host-a", "host-b", "host-c"],
      candidateHosts,
      deployments: [
        {
          deploymentId: "deployment:shared",
          declaredVersion: "shared/v2",
          manifestId: "manifest:shared",
          replicas: 1,
          assignmentMode: "select-first-n-hosts",
          sourceUri: "https://admin.example/shared.ts",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          scheduling: {
            requiredLabels: {
              tier: "edge"
            },
            preferredLabels: {
              zone: "z1"
            },
            requiredCapabilities: ["ws"]
          }
        }
      ]
    });
    const desiredB = projectHttpWorkerDesiredState({
      hostId: "host-b",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      revisionToken: 3,
      registeredHostIds: ["host-a", "host-b", "host-c"],
      candidateHosts,
      deployments: [
        {
          deploymentId: "deployment:shared",
          declaredVersion: "shared/v2",
          manifestId: "manifest:shared",
          replicas: 1,
          assignmentMode: "select-first-n-hosts",
          sourceUri: "https://admin.example/shared.ts",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          scheduling: {
            requiredLabels: {
              tier: "edge"
            },
            preferredLabels: {
              zone: "z1"
            },
            requiredCapabilities: ["ws"]
          }
        }
      ]
    });

    expect(candidateHosts.map((host) => host.hostId)).toEqual(["host-a", "host-b", "host-c"]);
    expect(desiredA.assignments.map((assignment) => assignment.deploymentId)).toEqual([
      "deployment:shared"
    ]);
    expect(desiredB.assignments).toHaveLength(0);
  });

  it("prefers sticky owners to avoid unnecessary reassignment churn", () => {
    const candidateHosts = buildPlacementCandidateHosts({
      registrations: [
        {
          hostId: "host-a",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {},
          staticCapabilities: ["http"],
          staticCapacity: {
            maxHttpWorkerAssignments: 8
          }
        },
        {
          hostId: "host-b",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {},
          staticCapabilities: ["http"],
          staticCapacity: {
            maxHttpWorkerAssignments: 8
          }
        }
      ],
      observedHostStates: [
        {
          hostId: "host-a",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 3,
            schedulable: true
          },
          assignmentStatuses: []
        },
        {
          hostId: "host-b",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 1,
            schedulable: true
          },
          assignmentStatuses: []
        }
      ]
    });

    const desiredA = projectHttpWorkerDesiredState({
      hostId: "host-a",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      revisionToken: 4,
      registeredHostIds: ["host-a", "host-b"],
      candidateHosts,
      deployments: [
        {
          deploymentId: "deployment:sticky",
          declaredVersion: "sticky/v1",
          manifestId: "manifest:sticky",
          replicas: 1,
          sourceUri: "https://admin.example/sticky.ts",
          workerName: "sticky-worker",
          workerEntry: "workers/sticky.ts",
          routeId: "route:sticky",
          routePathPrefix: "/demo/sticky",
          stickyHostIds: ["host-a"]
        }
      ]
    });

    expect(desiredA.assignments.map((assignment) => assignment.deploymentId)).toEqual([
      "deployment:sticky"
    ]);
  });

  it("adds replacement owners before removing previous owners during gradual rollout", () => {
    const candidateHosts = buildPlacementCandidateHosts({
      registrations: [
        {
          hostId: "host-a",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {},
          staticCapabilities: ["http"],
          staticCapacity: {}
        },
        {
          hostId: "host-b",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {},
          staticCapabilities: ["http"],
          staticCapacity: {}
        }
      ],
      observedHostStates: [
        {
          hostId: "host-a",
          observedAt: 1,
          ready: true,
          draining: true,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 1,
            schedulable: false
          },
          assignmentStatuses: [
            {
              assignmentId: "assign:host-a:deployment:shared",
              deploymentId: "deployment:shared",
              declaredVersion: "shared/v1",
              state: "active"
            }
          ]
        },
        {
          hostId: "host-b",
          observedAt: 1,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 0,
            schedulable: true
          },
          assignmentStatuses: []
        }
      ]
    });

    expect(
      planHttpWorkerDeploymentOwners({
        deployment: {
          deploymentId: "deployment:shared",
          declaredVersion: "shared/v1",
          manifestId: "manifest:shared",
          replicas: 1,
          sourceUri: "https://admin.example/shared.ts",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          stickyHostIds: ["host-a"],
          rollout: {
            strategy: "gradual",
            batchSize: 1,
            maxUnavailable: 0
          }
        },
        candidateHosts,
        currentDesiredOwnerHostIds: ["host-a"],
        observedHostStates: [
          {
            hostId: "host-a",
            observedAt: 1,
            ready: true,
            draining: true,
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {},
            dynamicState: {
              currentAssignmentCount: 1,
              schedulable: false
            },
            assignmentStatuses: [
              {
                assignmentId: "assign:host-a:deployment:shared",
                deploymentId: "deployment:shared",
                declaredVersion: "shared/v1",
                state: "active"
              }
            ]
          }
        ]
      })
    ).toEqual(["host-a", "host-b"]);

    expect(
      planHttpWorkerDeploymentOwners({
        deployment: {
          deploymentId: "deployment:shared",
          declaredVersion: "shared/v1",
          manifestId: "manifest:shared",
          replicas: 1,
          sourceUri: "https://admin.example/shared.ts",
          workerName: "shared-worker",
          workerEntry: "workers/shared.ts",
          routeId: "route:shared",
          routePathPrefix: "/demo/shared",
          stickyHostIds: ["host-a", "host-b"],
          rollout: {
            strategy: "gradual",
            batchSize: 1,
            maxUnavailable: 0
          }
        },
        candidateHosts,
        currentDesiredOwnerHostIds: ["host-a", "host-b"],
        observedHostStates: [
          {
            hostId: "host-b",
            observedAt: 2,
            ready: true,
            draining: false,
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {},
            dynamicState: {
              currentAssignmentCount: 1,
              schedulable: true
            },
            assignmentStatuses: [
              {
                assignmentId: "assign:host-b:deployment:shared",
                deploymentId: "deployment:shared",
                declaredVersion: "shared/v1",
                state: "active"
              }
            ]
          }
        ]
      })
    ).toEqual(["host-b"]);
  });

  it("builds membership and placement topology snapshots", () => {
    const membership = buildMembershipSnapshot({
      revision: "topology:1:membership",
      generatedAt: 10,
      registrations: [
        {
          hostId: "host-b",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicBaseUrl: "http://127.0.0.1:3001",
            internalBaseUrl: "http://127.0.0.1:3101",
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {
            zone: "z2"
          },
          staticCapabilities: ["http"],
          staticCapacity: {
            maxHttpWorkerAssignments: 8
          }
        },
        {
          hostId: "host-a",
          startedAt: 1,
          runtime: {
            kind: "hardess-v1",
            version: "1.0.0"
          },
          network: {
            publicBaseUrl: "http://127.0.0.1:3000",
            internalBaseUrl: "http://127.0.0.1:3100",
            publicListenerEnabled: true,
            internalListenerEnabled: true
          },
          staticLabels: {
            zone: "z1"
          },
          staticCapabilities: ["http", "ws"],
          staticCapacity: {
            maxHttpWorkerAssignments: 16
          }
        }
      ],
      observedHostStates: [
        {
          hostId: "host-a",
          observedAt: 20,
          ready: true,
          draining: false,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 1
          },
          assignmentStatuses: []
        },
        {
          hostId: "host-b",
          observedAt: 21,
          ready: true,
          draining: true,
          staticLabels: {},
          staticCapabilities: [],
          staticCapacity: {},
          dynamicState: {
            currentAssignmentCount: 0
          },
          assignmentStatuses: []
        }
      ]
    });

    const placement = buildPlacementSnapshot({
      revision: "topology:1:placement",
      generatedAt: 11,
      desiredHostStates: [
        {
          hostId: "host-a",
          revision: "rev-a",
          generatedAt: 1,
          sharedHttpForwardConfig: {
            routes: [
              {
                routeId: "route:shared",
                match: {
                  pathPrefix: "/demo/shared"
                },
                upstream: {
                  baseUrl: "http://127.0.0.1:9000"
                }
              }
            ]
          },
          assignments: [
            {
              assignmentId: "assign:host-a:deployment:shared",
              hostId: "host-a",
              deploymentId: "deployment:shared",
              deploymentKind: "http_worker",
              declaredVersion: "shared/v1",
              artifact: {
                manifestId: "manifest:shared",
                sourceUri: "https://admin.example/shared.ts"
              },
              httpWorker: {
                name: "shared-worker",
                entry: "workers/shared.ts",
                routeRefs: ["route:shared"]
              }
            }
          ]
        },
        {
          hostId: "host-b",
          revision: "rev-b",
          generatedAt: 1,
          sharedHttpForwardConfig: {
            routes: [
              {
                routeId: "route:shared",
                match: {
                  pathPrefix: "/demo/shared"
                },
                upstream: {
                  baseUrl: "http://127.0.0.1:9000"
                }
              }
            ]
          },
          assignments: [
            {
              assignmentId: "assign:host-b:deployment:shared",
              hostId: "host-b",
              deploymentId: "deployment:shared",
              deploymentKind: "http_worker",
              declaredVersion: "shared/v1",
              artifact: {
                manifestId: "manifest:shared",
                sourceUri: "https://admin.example/shared.ts"
              },
              httpWorker: {
                name: "shared-worker",
                entry: "workers/shared.ts",
                routeRefs: ["route:shared"]
              }
            }
          ]
        }
      ]
    });

    expect(membership.hosts.map((host) => `${host.hostId}:${host.state}`)).toEqual([
      "host-a:ready",
      "host-b:draining"
    ]);
    expect(placement.deployments).toEqual([
      {
        deploymentId: "deployment:shared",
        deploymentKind: "http_worker",
        ownerHostIds: ["host-a", "host-b"],
        routes: [
          {
            routeId: "route:shared",
            pathPrefix: "/demo/shared",
            ownerHostIds: ["host-a", "host-b"]
          }
        ]
      }
    ]);
  });
});
