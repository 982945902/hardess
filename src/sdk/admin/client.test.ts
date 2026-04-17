import { describe, expect, it } from "bun:test";
import type { DesiredHostState, HostRegistration, ObservedHostState } from "../../shared/index.ts";
import { HardessAdminClient } from "./client.ts";
import { MockAdminTransport } from "./mock.ts";

describe("HardessAdminClient with MockAdminTransport", () => {
  it("registers a host and returns an initial desired state", async () => {
    const transport = new MockAdminTransport();
    const client = new HardessAdminClient(transport);

    const registration: HostRegistration = {
      hostId: "host-a",
      nodeId: "node-a",
      startedAt: Date.now(),
      runtime: {
        kind: "hardess-v1",
        version: "1.0.0"
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
      staticCapabilities: ["http", "ws"],
      staticCapacity: {
        maxHttpWorkerAssignments: 8,
        maxServiceModuleAssignments: 8
      }
    };

    const ack = await client.registerHost(registration);
    const desired = await client.getDesiredHostState({
      hostId: "host-a"
    });

    expect(ack.accepted).toBe(true);
    expect(desired.changed).toBe(true);
    expect(desired.desired?.hostId).toBe("host-a");
    expect(desired.desired?.assignments).toHaveLength(0);
  });

  it("returns changed=false when the host already has the latest revision", async () => {
    const transport = new MockAdminTransport();
    const client = new HardessAdminClient(transport);

    await client.registerHost({
      hostId: "host-a",
      startedAt: Date.now(),
      runtime: {
        kind: "hardess-v1",
        version: "1.0.0"
      },
      network: {
        publicListenerEnabled: true,
        internalListenerEnabled: true
      },
      staticLabels: {},
      staticCapabilities: [],
      staticCapacity: {}
    });

    const first = await client.getDesiredHostState({ hostId: "host-a" });
    const second = await client.getDesiredHostState({
      hostId: "host-a",
      ifRevision: first.desired?.revision
    });

    expect(first.changed).toBe(true);
    expect(second).toEqual({ changed: false });
  });

  it("surfaces updated desired state set directly on the mock transport", async () => {
    const transport = new MockAdminTransport();
    const client = new HardessAdminClient(transport);

    await client.registerHost({
      hostId: "host-a",
      startedAt: Date.now(),
      runtime: {
        kind: "hardess-v1",
        version: "1.0.0"
      },
      network: {
        publicListenerEnabled: true,
        internalListenerEnabled: true
      },
      staticLabels: {},
      staticCapabilities: [],
      staticCapacity: {}
    });

    const nextDesired: DesiredHostState = {
      hostId: "host-a",
      revision: "rev-2",
      generatedAt: Date.now(),
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
        }
      ]
    };
    transport.setDesiredHostState(nextDesired);

    const desired = await client.getDesiredHostState({
      hostId: "host-a",
      ifRevision: "initial:host-a"
    });

    expect(desired.changed).toBe(true);
    expect(desired.desired?.revision).toBe("rev-2");
    expect(desired.desired?.assignments[0]?.httpWorker?.name).toBe("demo-http");
  });

  it("stores observed state through heartbeat and report operations and fetches manifests", async () => {
    const transport = new MockAdminTransport();
    const client = new HardessAdminClient(transport);

    transport.putArtifactManifest({
      manifestId: "manifest-http-1",
      artifactKind: "http_worker",
      declaredVersion: "worker-v2",
      source: {
        uri: "https://admin.example/artifacts/http-worker.tgz",
        digest: "sha256:abc"
      },
      entry: "workers/demo-worker.ts",
      packageManager: {
        kind: "deno",
        denoJson: "deno.json",
        denoLock: "deno.lock",
        frozenLock: true
      }
    });

    const observed: ObservedHostState = {
      hostId: "host-a",
      observedAt: Date.now(),
      ready: true,
      draining: false,
      staticLabels: {
        zone: "cn-sh-1"
      },
      staticCapabilities: ["http", "ws"],
      staticCapacity: {
        maxHttpWorkerAssignments: 8
      },
      dynamicState: {
        currentAssignmentCount: 1,
        schedulable: true
      },
      assignmentStatuses: []
    };

    const heartbeat = await client.heartbeatHost({
      hostId: "host-a",
      observed
    });
    const report = await client.reportObservedHostState(observed);
    const manifest = await client.fetchArtifactManifest({
      manifestId: "manifest-http-1"
    });

    expect(heartbeat.accepted).toBe(true);
    expect(report.accepted).toBe(true);
    expect(transport.getObservedHostState("host-a")?.ready).toBe(true);
    expect(manifest.entry).toBe("workers/demo-worker.ts");
  });
});
