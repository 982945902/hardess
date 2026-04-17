import { describe, expect, it } from "bun:test";
import { createDemoAdminApp } from "./admin-mock.ts";

function createRegistrationRequest(
  hostId: string,
  options: {
    staticLabels?: Record<string, string>;
    staticCapabilities?: string[];
    staticCapacity?: Record<string, number>;
  } = {}
): Request {
  return new Request("http://127.0.0.1:9100/v1/admin/hosts/register", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      hostId,
      startedAt: Date.now(),
      runtime: {
        kind: "hardess-v1",
        version: "1.0.0"
      },
      network: {
        publicListenerEnabled: true,
        internalListenerEnabled: false
      },
      staticLabels: options.staticLabels ?? {},
      staticCapabilities: options.staticCapabilities ?? ["http_worker"],
      staticCapacity: options.staticCapacity ?? {}
    })
  });
}

function createDesiredRequest(hostId: string): Request {
  return new Request("http://127.0.0.1:9100/v1/admin/hosts/desired", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      hostId
    })
  });
}

function createDesiredIfRevisionRequest(hostId: string, ifRevision: string): Request {
  return new Request("http://127.0.0.1:9100/v1/admin/hosts/desired", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      hostId,
      ifRevision
    })
  });
}

function createObservedRequest(
  hostId: string,
  assignmentStatuses: Array<{
    assignmentId: string;
    deploymentId: string;
    declaredVersion: string;
    generationId?: string;
    state: "pending" | "preparing" | "ready" | "active" | "draining" | "failed";
    lastError?: {
      code: string;
      message: string;
      retryable?: boolean;
    };
  }>,
  options: {
    ready?: boolean;
    draining?: boolean;
    schedulable?: boolean;
  } = {}
): Request {
  return new Request("http://127.0.0.1:9100/v1/admin/hosts/observed", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      hostId,
      observedAt: Date.now(),
      ready: options.ready ?? true,
      draining: options.draining ?? false,
      staticLabels: {},
      staticCapabilities: ["http_worker"],
      staticCapacity: {},
      dynamicState: {
        currentAssignmentCount: assignmentStatuses.length,
        schedulable: options.schedulable ?? true
      },
      assignmentStatuses
    })
  });
}

describe("createDemoAdminApp", () => {
  it("serves replicas-based selective assignments plus host-specific projections", async () => {
    const app = await createDemoAdminApp({
      artifactBaseUrl: "http://127.0.0.1:9100",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      sharedDeploymentReplicas: 1
    });

    const registerHostA = await app.fetch(createRegistrationRequest("host-demo-a"));
    const registerHostB = await app.fetch(createRegistrationRequest("host-demo-b"));
    expect(registerHostA.status).toBe(200);
    expect(registerHostB.status).toBe(200);

    const desiredResponseA = await app.fetch(createDesiredRequest("host-demo-a"));
    const desiredResponseB = await app.fetch(createDesiredRequest("host-demo-b"));
    const desiredA = await desiredResponseA.json();
    const desiredB = await desiredResponseB.json();

    expect(desiredA.changed).toBe(true);
    expect(desiredB.changed).toBe(true);
    expect(desiredA.desired.assignments).toHaveLength(4);
    expect(desiredB.desired.assignments).toHaveLength(3);
    expect(desiredA.desired.topology.membership.hosts.map((host: { hostId: string }) => host.hostId)).toEqual([
      "host-demo-a",
      "host-demo-b"
    ]);
    expect(
      desiredA.desired.topology.placement.deployments.find(
        (deployment: { deploymentId: string }) => deployment.deploymentId === "deployment:demo-http-shared"
      ).ownerHostIds
    ).toEqual(["host-demo-a"]);
    expect(
      desiredA.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toEqual([
      "deployment:demo-http-shared",
      "deployment:demo-http-host",
      "deployment:demo-personnel-serve",
      "deployment:demo-chat-service-module"
    ]);
    expect(
      desiredB.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toEqual([
      "deployment:demo-http-host",
      "deployment:demo-personnel-serve",
      "deployment:demo-chat-service-module"
    ]);
    expect(
      desiredA.desired.sharedHttpForwardConfig.routes.map(
        (route: { match: { pathPrefix: string } }) => route.match.pathPrefix
      )
    ).toEqual([
      "/demo/shared",
      "/demo/hosts/host-demo-a",
      "/demo/serve"
    ]);
    expect(
      desiredB.desired.sharedHttpForwardConfig.routes.map(
        (route: { match: { pathPrefix: string } }) => route.match.pathPrefix
      )
    ).toEqual([
      "/demo/hosts/host-demo-b",
      "/demo/serve"
    ]);
    const servePlacement = desiredA.desired.topology.placement.deployments.find(
      (deployment: { deploymentId: string }) => deployment.deploymentId === "deployment:demo-personnel-serve"
    );
    expect(servePlacement.groupId).toBe("group-personnel");
    expect(servePlacement.ownerHostIds).toEqual(["host-demo-a", "host-demo-b"]);
    expect(desiredA.desired.revision).toContain("demo-rev:1:");
    expect(desiredB.desired.revision).toContain("demo-rev:1:");

    await app.fetch(
      createObservedRequest("host-demo-a", [
        {
          assignmentId: "assign:host-demo-a:deployment:demo-http-shared",
          deploymentId: "deployment:demo-http-shared",
          declaredVersion: "demo-http-shared/v1",
          generationId: "gen-a-1",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-a:deployment:demo-http-host",
          deploymentId: "deployment:demo-http-host",
          declaredVersion: "demo-http-host/v1",
          generationId: "gen-a-1",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-a:deployment:demo-personnel-serve",
          deploymentId: "deployment:demo-personnel-serve",
          declaredVersion: "demo-personnel-serve/v1",
          generationId: "gen-a-1",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-a:deployment:demo-chat-service-module",
          deploymentId: "deployment:demo-chat-service-module",
          declaredVersion: "demo-chat-service-module/v1",
          generationId: "gen-a-1",
          state: "active"
        }
      ])
    );
    await app.fetch(
      createObservedRequest("host-demo-b", [
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-host",
          deploymentId: "deployment:demo-http-host",
          declaredVersion: "demo-http-host/v1",
          generationId: "gen-b-1",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-personnel-serve",
          deploymentId: "deployment:demo-personnel-serve",
          declaredVersion: "demo-personnel-serve/v1",
          generationId: "gen-b-1",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-chat-service-module",
          deploymentId: "deployment:demo-chat-service-module",
          declaredVersion: "demo-chat-service-module/v1",
          generationId: "gen-b-1",
          state: "active"
        }
      ])
    );

    const rolloutResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/rollouts/shared-deployment", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sharedDeploymentReplicas: 2
        })
      })
    );
    const rollout = await rolloutResponse.json();
    expect(rollout.accepted).toBe(true);
    expect(rollout.sharedDeploymentReplicas).toBe(2);
    expect(rollout.revisionToken).toBe(2);

    const desiredAfterRolloutResponseB = await app.fetch(
      createDesiredIfRevisionRequest("host-demo-b", desiredB.desired.revision)
    );
    const desiredAfterRolloutB = await desiredAfterRolloutResponseB.json();
    expect(desiredAfterRolloutB.changed).toBe(true);
    expect(desiredAfterRolloutB.desired.revision).toContain("demo-rev:2:");
    expect(
      desiredAfterRolloutB.desired.assignments.map(
        (assignment: { deploymentId: string }) => assignment.deploymentId
      )
    ).toEqual([
      "deployment:demo-http-shared",
      "deployment:demo-http-host",
      "deployment:demo-personnel-serve",
      "deployment:demo-chat-service-module"
    ]);
    expect(
      desiredAfterRolloutB.desired.sharedHttpForwardConfig.routes.map(
        (route: { match: { pathPrefix: string } }) => route.match.pathPrefix
      )
    ).toEqual([
      "/demo/shared",
      "/demo/hosts/host-demo-b",
      "/demo/serve"
    ]);

    const stateDuringRolloutResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/state")
    );
    const stateDuringRollout = await stateDuringRolloutResponse.json();
    const sharedDeploymentDuringRollout = stateDuringRollout.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-shared"
    );
    expect(sharedDeploymentDuringRollout.desiredHosts).toBe(2);
    expect(sharedDeploymentDuringRollout.activeHosts).toBe(1);
    expect(sharedDeploymentDuringRollout.pendingHosts).toBe(1);
    expect(sharedDeploymentDuringRollout.hosts).toEqual([
      expect.objectContaining({
        hostId: "host-demo-a",
        observedState: "active"
      }),
      expect.objectContaining({
        hostId: "host-demo-b",
        observedState: "missing"
      })
    ]);

    await app.fetch(
      createObservedRequest("host-demo-b", [
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-shared",
          deploymentId: "deployment:demo-http-shared",
          declaredVersion: "demo-http-shared/v1",
          generationId: "gen-b-2",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-host",
          deploymentId: "deployment:demo-http-host",
          declaredVersion: "demo-http-host/v1",
          generationId: "gen-b-2",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-personnel-serve",
          deploymentId: "deployment:demo-personnel-serve",
          declaredVersion: "demo-personnel-serve/v1",
          generationId: "gen-b-2",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-chat-service-module",
          deploymentId: "deployment:demo-chat-service-module",
          declaredVersion: "demo-chat-service-module/v1",
          generationId: "gen-b-2",
          state: "active"
        }
      ])
    );

    const sharedManifestResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/v1/admin/artifacts/manifest", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          manifestId: "manifest:demo-http-shared:v1"
        })
      })
    );
    const hostManifestResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/v1/admin/artifacts/manifest", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          manifestId: "manifest:demo-http-host:v1"
        })
      })
    );
    const serviceManifestResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/v1/admin/artifacts/manifest", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          manifestId: "manifest:demo-chat-service-module:v1"
        })
      })
    );
    const serveManifestResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/v1/admin/artifacts/manifest", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          manifestId: "manifest:demo-personnel-serve:v1"
        })
      })
    );
    const sharedManifest = await sharedManifestResponse.json();
    const hostManifest = await hostManifestResponse.json();
    const serviceManifest = await serviceManifestResponse.json();
    const serveManifest = await serveManifestResponse.json();
    expect(sharedManifest.source.uri).toBe("http://127.0.0.1:9100/artifacts/demo-http-worker.ts");
    expect(hostManifest.source.uri).toBe("http://127.0.0.1:9100/artifacts/demo-host-worker.ts");
    expect(serviceManifest.source.uri).toBe("http://127.0.0.1:9100/artifacts/demo-chat-service-module.ts");
    expect(serveManifest.source.uri).toBe("http://127.0.0.1:9100/artifacts/demo-serve-app.ts");
    expect(serveManifest.artifactKind).toBe("serve");

    const hostWorkerResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/artifacts/demo-host-worker.ts")
    );
    expect(hostWorkerResponse.status).toBe(200);
    expect(await hostWorkerResponse.text()).toContain("x-hardess-admin-scope");
    const serveArtifactResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/artifacts/demo-serve-app.ts")
    );
    expect(serveArtifactResponse.status).toBe(200);
    expect(await serveArtifactResponse.text()).toContain('kind: "serve"');
    const serviceModuleResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/artifacts/demo-chat-service-module.ts")
    );
    expect(serviceModuleResponse.status).toBe(200);
    expect(await serviceModuleResponse.text()).toContain('protocol: "demo-chat"');

    const stateResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/state")
    );
    const state = await stateResponse.json();
    expect(state.registeredHosts).toHaveLength(2);
    expect(state.desiredHostStates).toHaveLength(2);
    expect(state.artifactManifests).toHaveLength(4);
    expect(state.topology.membership.hosts).toHaveLength(2);
    expect(state.topology.placement.deployments).toHaveLength(4);
    expect(state.rolloutState.sharedDeploymentReplicas).toBe(2);
    expect(state.rolloutState.revisionToken).toBe(2);
    const sharedDeploymentSummary = state.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-shared"
    );
    expect(sharedDeploymentSummary.activeHosts).toBe(2);
    expect(sharedDeploymentSummary.pendingHosts).toBe(0);
    const hostDeploymentSummary = state.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-host"
    );
    expect(hostDeploymentSummary.activeHosts).toBe(2);
    const serveDeploymentSummary = state.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-personnel-serve"
    );
    expect(serveDeploymentSummary.activeHosts).toBe(2);
    const serviceModuleSummary = state.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-chat-service-module"
    );
    expect(serviceModuleSummary.activeHosts).toBe(2);

    const scaleDownResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/rollouts/shared-deployment", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sharedDeploymentReplicas: 1
        })
      })
    );
    const scaleDown = await scaleDownResponse.json();
    expect(scaleDown.accepted).toBe(true);
    expect(scaleDown.sharedDeploymentReplicas).toBe(1);
    expect(scaleDown.revisionToken).toBe(3);

    const desiredAfterScaleDownResponseB = await app.fetch(
      createDesiredIfRevisionRequest("host-demo-b", desiredAfterRolloutB.desired.revision)
    );
    const desiredAfterScaleDownB = await desiredAfterScaleDownResponseB.json();
    expect(desiredAfterScaleDownB.changed).toBe(true);
    expect(desiredAfterScaleDownB.desired.revision).toContain("demo-rev:3:");
    expect(
      desiredAfterScaleDownB.desired.assignments.map(
        (assignment: { deploymentId: string }) => assignment.deploymentId
      )
    ).toEqual([
      "deployment:demo-http-host",
      "deployment:demo-personnel-serve",
      "deployment:demo-chat-service-module"
    ]);

    const stateBeforeDrainResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/state")
    );
    const stateBeforeDrain = await stateBeforeDrainResponse.json();
    const sharedDeploymentBeforeDrain = stateBeforeDrain.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-shared"
    );
    expect(sharedDeploymentBeforeDrain.desiredHosts).toBe(1);
    expect(sharedDeploymentBeforeDrain.activeHosts).toBe(2);
    expect(sharedDeploymentBeforeDrain.drainingHosts).toBe(0);

    await app.fetch(
      createObservedRequest("host-demo-b", [
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-shared",
          deploymentId: "deployment:demo-http-shared",
          declaredVersion: "demo-http-shared/v1",
          generationId: "gen-b-2",
          state: "draining"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-host",
          deploymentId: "deployment:demo-http-host",
          declaredVersion: "demo-http-host/v1",
          generationId: "gen-b-2",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-personnel-serve",
          deploymentId: "deployment:demo-personnel-serve",
          declaredVersion: "demo-personnel-serve/v1",
          generationId: "gen-b-2",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-chat-service-module",
          deploymentId: "deployment:demo-chat-service-module",
          declaredVersion: "demo-chat-service-module/v1",
          generationId: "gen-b-2",
          state: "active"
        }
      ])
    );

    const stateDuringDrainResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/state")
    );
    const stateDuringDrain = await stateDuringDrainResponse.json();
    const sharedDeploymentDuringDrain = stateDuringDrain.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-shared"
    );
    expect(sharedDeploymentDuringDrain.desiredHosts).toBe(1);
    expect(sharedDeploymentDuringDrain.activeHosts).toBe(1);
    expect(sharedDeploymentDuringDrain.drainingHosts).toBe(1);
    expect(sharedDeploymentDuringDrain.hosts).toEqual([
      expect.objectContaining({
        hostId: "host-demo-a",
        observedState: "active"
      }),
      expect.objectContaining({
        hostId: "host-demo-b",
        observedState: "draining"
      })
    ]);

    await app.fetch(
      createObservedRequest("host-demo-b", [
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-host",
          deploymentId: "deployment:demo-http-host",
          declaredVersion: "demo-http-host/v1",
          generationId: "gen-b-3",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-personnel-serve",
          deploymentId: "deployment:demo-personnel-serve",
          declaredVersion: "demo-personnel-serve/v1",
          generationId: "gen-b-3",
          state: "active"
        },
        {
          assignmentId: "assign:host-demo-b:deployment:demo-chat-service-module",
          deploymentId: "deployment:demo-chat-service-module",
          declaredVersion: "demo-chat-service-module/v1",
          generationId: "gen-b-3",
          state: "active"
        }
      ])
    );

    const stateAfterDrainResponse = await app.fetch(
      new Request("http://127.0.0.1:9100/__admin/mock/state")
    );
    const stateAfterDrain = await stateAfterDrainResponse.json();
    const sharedDeploymentAfterDrain = stateAfterDrain.rolloutSummary.find(
      (summary: { deploymentId: string }) => summary.deploymentId === "deployment:demo-http-shared"
    );
    expect(sharedDeploymentAfterDrain.desiredHosts).toBe(1);
    expect(sharedDeploymentAfterDrain.activeHosts).toBe(1);
    expect(sharedDeploymentAfterDrain.drainingHosts).toBe(0);
    expect(sharedDeploymentAfterDrain.pendingHosts).toBe(0);
    expect(state.desiredHostStates[0].assignments.length).toBeGreaterThanOrEqual(1);
  });

  it("stages replacement when the previous shared-deployment owner becomes unschedulable", async () => {
    const app = await createDemoAdminApp({
      artifactBaseUrl: "http://127.0.0.1:9100",
      upstreamBaseUrl: "http://127.0.0.1:9000",
      sharedDeploymentReplicas: 1
    });

    await app.fetch(createRegistrationRequest("host-demo-a"));
    await app.fetch(createRegistrationRequest("host-demo-b"));

    const initialDesiredA = await (await app.fetch(createDesiredRequest("host-demo-a"))).json();
    const initialDesiredB = await (await app.fetch(createDesiredRequest("host-demo-b"))).json();
    expect(
      initialDesiredA.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-http-shared");
    expect(
      initialDesiredA.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-personnel-serve");
    expect(
      initialDesiredA.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-chat-service-module");
    expect(
      initialDesiredB.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).not.toContain("deployment:demo-http-shared");
    expect(
      initialDesiredB.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-personnel-serve");
    expect(
      initialDesiredB.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-chat-service-module");

    await app.fetch(
      createObservedRequest(
        "host-demo-a",
        [
          {
            assignmentId: "assign:host-demo-a:deployment:demo-http-shared",
            deploymentId: "deployment:demo-http-shared",
            declaredVersion: "demo-http-shared/v1",
            state: "active"
          }
        ],
        {
          draining: true,
          schedulable: false
        }
      )
    );

    const nextDesiredA = await (await app.fetch(createDesiredRequest("host-demo-a"))).json();
    const nextDesiredB = await (await app.fetch(createDesiredRequest("host-demo-b"))).json();
    expect(
      nextDesiredA.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-http-shared");
    expect(
      nextDesiredB.desired.assignments.map((assignment: { deploymentId: string }) => assignment.deploymentId)
    ).toContain("deployment:demo-http-shared");

    await app.fetch(
      createObservedRequest("host-demo-b", [
        {
          assignmentId: "assign:host-demo-b:deployment:demo-http-shared",
          deploymentId: "deployment:demo-http-shared",
          declaredVersion: "demo-http-shared/v1",
          state: "active"
        }
      ])
    );

    const convergedDesiredA = await (await app.fetch(createDesiredRequest("host-demo-a"))).json();
    const convergedDesiredB = await (await app.fetch(createDesiredRequest("host-demo-b"))).json();
    expect(
      convergedDesiredA.desired.assignments.map(
        (assignment: { deploymentId: string }) => assignment.deploymentId
      )
    ).not.toContain("deployment:demo-http-shared");
    expect(
      convergedDesiredB.desired.assignments.map(
        (assignment: { deploymentId: string }) => assignment.deploymentId
      )
    ).toContain("deployment:demo-http-shared");
  });
});
