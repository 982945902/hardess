import { describe, expect, it, mock } from "bun:test";
import {
  buildServiceModuleProtocolPackageId,
  computeServiceModuleProtocolPackageDigest
} from "../../shared/index.ts";
import type { DesiredHostState } from "../../shared/index.ts";
import { InMemoryMetrics } from "../observability/metrics.ts";
import { RuntimeHostAdapter } from "./runtime-host-adapter.ts";
import { RuntimeTopologyStore } from "./topology-store.ts";

describe("RuntimeHostAdapter", () => {
  it("builds host registration from runtime state and static metadata", () => {
    const adapter = new RuntimeHostAdapter({
      app: {
        logger: {
          info: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {})
        },
        runtimeState: () => ({
          startedAt: 100,
          uptimeMs: 500,
          shuttingDown: false,
          disposed: false,
          ready: true,
          inFlightHttpRequests: 0
        })
      },
      configStore: {
        getConfig: () => ({ pipelines: [] }),
        reload: async () => ({ pipelines: [] }),
        applyConfig: async (config) => config,
        watch: () => {},
        dispose: () => {},
        subscribe: () => () => {}
      },
      artifactStore: {
        stageHttpWorker: async () => ({ localEntry: "workers/demo-worker.ts" })
      } as never,
      hostId: "host-a",
      nodeId: "node-a",
      runtimeVersion: "1.0.0",
      publicBaseUrl: "http://10.0.0.1:3000",
      internalBaseUrl: "http://10.0.0.1:3100",
      staticLabels: {
        zone: "cn-sh-1"
      },
      staticCapabilities: ["http", "ws"],
      staticCapacity: {
        maxHttpWorkerAssignments: 8
      },
      registrationDynamicFields: {
        bootstrapMode: "static"
      }
    });

    const registration = adapter.getHostRegistration();
    expect(registration.hostId).toBe("host-a");
    expect(registration.network.publicListenerEnabled).toBe(true);
    expect(registration.staticLabels.zone).toBe("cn-sh-1");
    expect(registration.dynamicFields?.bootstrapMode).toBe("static");
  });

  it("stores desired state and reports active assignment statuses after apply", async () => {
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {})
    };
    const metrics = new InMemoryMetrics();
    metrics.increment("artifact.prepare_ok");
    metrics.increment("artifact.prepare_cache_hit");
    metrics.timing("artifact.prepare_ms", 12);
    const topologyStore = new RuntimeTopologyStore();
    const adapter = new RuntimeHostAdapter({
      app: {
        logger,
        metrics,
        runtimeState: () => ({
          startedAt: 100,
          uptimeMs: 500,
          shuttingDown: false,
          disposed: false,
          ready: true,
          inFlightHttpRequests: 3
        })
      },
      configStore: {
        getConfig: () => ({ pipelines: [] }),
        reload: async () => ({ pipelines: [] }),
        applyConfig: async (config) => config,
        watch: () => {},
        dispose: () => {},
        subscribe: () => () => {}
      },
      artifactStore: {
        stageHttpWorker: async () => ({ localEntry: "workers/demo-worker.ts" })
      } as never,
      topologyStore,
      hostId: "host-a",
      runtimeVersion: "1.0.0",
      staticCapabilities: ["http"]
    });

    const desired: DesiredHostState = {
      hostId: "host-a",
      revision: "rev-1",
      generatedAt: Date.now(),
      topology: {
        membership: {
          revision: "topology:1:membership",
          generatedAt: Date.now(),
          hosts: []
        },
        placement: {
          revision: "topology:1:placement",
          generatedAt: Date.now(),
          deployments: []
        }
      },
      assignments: [
        {
          assignmentId: "assign-http-1",
          hostId: "host-a",
          deploymentId: "deploy-http",
          deploymentKind: "http_worker",
          declaredVersion: "worker-v2",
          artifact: {
            manifestId: "manifest-http-1",
            sourceUri: "https://admin.example/artifacts/http-worker.tgz"
          },
          httpWorker: {
            name: "demo-http",
            entry: "workers/demo-worker.ts"
          }
        }
      ]
    };

    await adapter.applyDesiredHostState(desired);
    const observed = adapter.collectObservedHostState();

    expect(observed.dynamicState.currentAssignmentCount).toBe(1);
    expect(observed.dynamicState.currentInflightRequests).toBe(3);
    expect(observed.dynamicState.appliedTopology).toEqual({
      membershipRevision: "topology:1:membership",
      placementRevision: "topology:1:placement"
    });
    expect(observed.dynamicState.dynamicFields?.metrics).toEqual({
      counters: {
        "artifact.prepare_ok": 1,
        "artifact.prepare_cache_hit": 1
      },
      timingCounts: {
        "artifact.prepare_ms": 1
      }
    });
    expect(topologyStore.getTopology()?.membership.revision).toBe("topology:1:membership");
    expect(observed.assignmentStatuses[0]).toMatchObject({
      assignmentId: "assign-http-1",
      deploymentId: "deploy-http",
      declaredVersion: "worker-v2",
      generationId: "admin:rev-1",
      state: "active"
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("builds pipelines for serve assignments and carries groupId into generated config", async () => {
    const applyConfig = mock(async (config) => config);
    const adapter = new RuntimeHostAdapter({
      app: {
        logger: {
          info: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {})
        },
        runtimeState: () => ({
          startedAt: 100,
          uptimeMs: 500,
          shuttingDown: false,
          disposed: false,
          ready: true,
          inFlightHttpRequests: 0
        })
      },
      configStore: {
        getConfig: () => ({ pipelines: [] }),
        reload: async () => ({ pipelines: [] }),
        applyConfig,
        watch: () => {},
        dispose: () => {},
        subscribe: () => () => {}
      },
      artifactStore: {
        stageHttpWorker: async () => ({ localEntry: "/tmp/staged/personnel-serve.ts" })
      } as never,
      hostId: "host-a",
      runtimeVersion: "1.0.0"
    });

    await adapter.applyDesiredHostState({
      hostId: "host-a",
      revision: "rev-serve-1",
      generatedAt: Date.now(),
      topology: {
        membership: {
          revision: "topology:serve:membership",
          generatedAt: Date.now(),
          hosts: []
        },
        placement: {
          revision: "topology:serve:placement",
          generatedAt: Date.now(),
          deployments: []
        }
      },
      assignments: [
        {
          assignmentId: "assign-serve-1",
          hostId: "host-a",
          deploymentId: "deploy-serve",
          deploymentKind: "serve",
          groupId: "group-personnel",
          declaredVersion: "serve-v1",
          artifact: {
            manifestId: "manifest-serve-1",
            sourceUri: "https://admin.example/artifacts/personnel-serve.tgz"
          },
          serveApp: {
            name: "personnel-serve",
            entry: "apps/personnel-serve.ts",
            routeRefs: ["route-serve-a", "route-serve-b"],
            deployment: {
              config: {
                region: "cn-sh-1"
              },
              bindings: {
                catalogBaseUrl: "https://catalog.internal"
              },
              secrets: {
                apiToken: "serve-secret"
              }
            }
          }
        }
      ],
      sharedHttpForwardConfig: {
        routes: [
          {
            routeId: "route-serve-a",
            match: {
              pathPrefix: "/personnel"
            },
            upstream: {
              baseUrl: "http://upstream.internal"
            }
          },
          {
            routeId: "route-serve-b",
            match: {
              pathPrefix: "/personnel/stats"
            },
            upstream: {
              baseUrl: "http://upstream.internal"
            }
          }
        ]
      }
    });

    expect(applyConfig).toHaveBeenCalledWith(
      {
        pipelines: [
          {
            id: "assign-serve-1:route-serve-a",
            matchPrefix: "/personnel",
            groupId: "group-personnel",
            auth: { required: true },
            downstream: {
              origin: "http://upstream.internal",
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000,
              websocket: undefined
            },
            worker: {
              entry: "/tmp/staged/personnel-serve.ts",
              timeoutMs: 1000,
              deployment: {
                instanceKey: "assign-serve-1",
                config: {
                  region: "cn-sh-1"
                },
                bindings: {
                  catalogBaseUrl: "https://catalog.internal"
                },
                secrets: {
                  apiToken: "serve-secret"
                }
              }
            }
          },
          {
            id: "assign-serve-1:route-serve-b",
            matchPrefix: "/personnel/stats",
            groupId: "group-personnel",
            auth: { required: true },
            downstream: {
              origin: "http://upstream.internal",
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000,
              websocket: undefined
            },
            worker: {
              entry: "/tmp/staged/personnel-serve.ts",
              timeoutMs: 1000,
              deployment: {
                instanceKey: "assign-serve-1",
                config: {
                  region: "cn-sh-1"
                },
                bindings: {
                  catalogBaseUrl: "https://catalog.internal"
                },
                secrets: {
                  apiToken: "serve-secret"
                }
              }
            }
          }
        ]
      },
      { source: "admin:rev-serve-1" }
    );
  });

  it("applies generated http config and activates service_module assignments through the manager", async () => {
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {})
    };
    const applyConfig = mock(async (config) => config);
    const adapter = new RuntimeHostAdapter({
      app: {
        logger,
        runtimeState: () => ({
          startedAt: 100,
          uptimeMs: 500,
          shuttingDown: false,
          disposed: false,
          ready: true,
          inFlightHttpRequests: 0
        })
      },
      configStore: {
        getConfig: () => ({ pipelines: [] }),
        reload: async () => ({ pipelines: [] }),
        applyConfig,
        watch: () => {},
        dispose: () => {},
        subscribe: () => () => {}
      },
      artifactStore: {
        stageHttpWorker: async () => ({ localEntry: "/tmp/staged/demo-worker.ts" })
      } as never,
      serviceModuleManager: {
        applyAssignments: async (input: {
          assignmentStates: Map<
            string,
            {
              state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
              generationId?: string;
              preparedAt?: number;
            }
          >;
          revisionGenerationId: string;
        }) => {
          const { assignmentStates, revisionGenerationId } = input;
          const state = assignmentStates.get("assign-ws-1");
          if (state) {
            state.state = "ready";
            state.generationId = revisionGenerationId;
            state.preparedAt = Date.now();
          }
        },
        listDrainingAssignments: () => []
      } as never,
      hostId: "host-a",
      runtimeVersion: "1.0.0"
    });

    await adapter.applyDesiredHostState({
      hostId: "host-a",
      revision: "rev-2",
      generatedAt: Date.now(),
      topology: {
        membership: {
          revision: "topology:2:membership",
          generatedAt: Date.now(),
          hosts: []
        },
        placement: {
          revision: "topology:2:placement",
          generatedAt: Date.now(),
          deployments: []
        }
      },
      assignments: [
        {
          assignmentId: "assign-http-1",
          hostId: "host-a",
          deploymentId: "deploy-http",
          deploymentKind: "http_worker",
          declaredVersion: "worker-v2",
          artifact: {
            manifestId: "manifest-http-1",
            sourceUri: "https://admin.example/artifacts/http-worker.tgz"
          },
          httpWorker: {
            name: "demo-http",
            entry: "workers/demo-worker.ts",
            routeRefs: ["route-a"]
          }
        },
        {
          assignmentId: "assign-ws-1",
          hostId: "host-a",
          deploymentId: "deploy-ws",
          deploymentKind: "service_module",
          declaredVersion: "ws-v1",
          artifact: {
            manifestId: "manifest-ws-1",
            sourceUri: "https://admin.example/artifacts/ws.tgz"
          },
          serviceModule: {
            name: "chat",
            entry: "services/chat.ts",
            protocolPackage: {
              packageId: buildServiceModuleProtocolPackageId("chat", "1.0"),
              protocol: "chat",
              version: "1.0",
              actions: ["send"],
              digest: computeServiceModuleProtocolPackageDigest({
                packageId: buildServiceModuleProtocolPackageId("chat", "1.0"),
                protocol: "chat",
                version: "1.0",
                actions: ["send"]
              })
            }
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
              baseUrl: "http://upstream.internal",
              websocketEnabled: true
            }
          }
        ]
      }
    }, new Map([
      [
        "manifest-http-1",
        {
          manifestId: "manifest-http-1",
          artifactKind: "http_worker",
          declaredVersion: "worker-v2",
          source: {
            uri: "https://admin.example/artifacts/http-worker.ts"
          },
          entry: "workers/demo-worker.ts",
          packageManager: {
            kind: "deno"
          }
        }
      ]
    ]));

    expect(applyConfig).toHaveBeenCalledWith(
      {
        pipelines: [
          {
            id: "assign-http-1:route-a",
            matchPrefix: "/demo",
            auth: { required: true },
            downstream: {
              origin: "http://upstream.internal",
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000,
              websocket: true
            },
            worker: {
              entry: "/tmp/staged/demo-worker.ts",
              timeoutMs: 1000
            }
          }
        ]
      },
      { source: "admin:rev-2" }
    );
    expect(logger.warn).not.toHaveBeenCalled();

    const observed = adapter.collectObservedHostState();
    expect(observed.dynamicState.appliedTopology).toEqual({
      membershipRevision: "topology:2:membership",
      placementRevision: "topology:2:placement"
    });
    expect(observed.assignmentStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentId: "assign-http-1",
          state: "active"
        }),
        expect.objectContaining({
          assignmentId: "assign-ws-1",
          state: "active",
          generationId: "admin:rev-2"
        })
      ])
    );
  });

  it("includes draining service_module assignments in observed state after removal", async () => {
    const adapter = new RuntimeHostAdapter({
      app: {
        logger: {
          info: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {})
        },
        runtimeState: () => ({
          startedAt: 100,
          uptimeMs: 500,
          shuttingDown: false,
          disposed: false,
          ready: true,
          inFlightHttpRequests: 1
        })
      },
      configStore: {
        getConfig: () => ({ pipelines: [] }),
        reload: async () => ({ pipelines: [] }),
        applyConfig: async (config) => config,
        watch: () => {},
        dispose: () => {},
        subscribe: () => () => {}
      },
      hostId: "host-a",
      runtimeVersion: "1.0.0",
      serviceModuleManager: {
        applyAssignments: async () => {},
        listDrainingAssignments: () => [
          {
            assignmentId: "assign-ws-1",
            deploymentId: "deploy-ws",
            declaredVersion: "ws-v1",
            generationId: "admin:rev-1",
            state: "draining" as const,
            preparedAt: 200,
            activatedAt: 300
          }
        ]
      } as never
    });

    await adapter.applyDesiredHostState({
      hostId: "host-a",
      revision: "rev-2",
      generatedAt: Date.now(),
      topology: {
        membership: {
          revision: "topology:2:membership",
          generatedAt: Date.now(),
          hosts: []
        },
        placement: {
          revision: "topology:2:placement",
          generatedAt: Date.now(),
          deployments: []
        }
      },
      assignments: []
    });

    const observed = adapter.collectObservedHostState();
    expect(observed.dynamicState.currentAssignmentCount).toBe(1);
    expect(observed.assignmentStatuses).toEqual([
      expect.objectContaining({
        assignmentId: "assign-ws-1",
        deploymentId: "deploy-ws",
        declaredVersion: "ws-v1",
        generationId: "admin:rev-1",
        state: "draining",
        preparedAt: 200,
        activatedAt: 300
      })
    ]);
  });
});
