import { describe, expect, it, mock } from "bun:test";
import type { DesiredHostState, HostRegistration, ObservedHostState } from "../../shared/index.ts";
import { HardessAdminClient } from "../../sdk/admin/client.ts";
import { MockAdminTransport } from "../../sdk/admin/mock.ts";
import { HostAgent } from "./host-agent.ts";

function createRegistration(hostId = "host-a"): HostRegistration {
  return {
    hostId,
    startedAt: Date.now(),
    runtime: {
      kind: "hardess-v1",
      version: "1.0.0"
    },
    network: {
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
}

function createObserved(hostId = "host-a"): ObservedHostState {
  return {
    hostId,
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
      currentAssignmentCount: 0,
      schedulable: true
    },
    assignmentStatuses: []
  };
}

function createDesired(hostId = "host-a", revision = "rev-1"): DesiredHostState {
  return {
    hostId,
    revision,
    generatedAt: Date.now(),
    assignments: [
      {
        assignmentId: "assign-http-1",
        hostId,
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
}

describe("HostAgent", () => {
  it("registers, applies desired state, reports observed state, and stores poll delay", async () => {
    const transport = new MockAdminTransport({
      pollAfterMs: 7_000,
      nextPollAfterMs: 11_000
    });
    transport.putArtifactManifest({
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
    });
    transport.setDesiredHostState(createDesired());
    const adminClient = new HardessAdminClient(transport);
    const applyDesiredHostState = mock(async (_desired: DesiredHostState) => {});
    const collectObservedHostState = mock(async () => createObserved());
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {})
    };

    const agent = new HostAgent(
      adminClient,
      {
        getHostRegistration: () => createRegistration(),
        applyDesiredHostState,
        collectObservedHostState
      },
      {
        logger
      }
    );

    await agent.reconcileOnce();

    expect(applyDesiredHostState).toHaveBeenCalledTimes(1);
    expect(collectObservedHostState).toHaveBeenCalledTimes(1);
    expect(transport.getObservedHostState("host-a")?.ready).toBe(true);
    expect(agent.getSnapshot()).toEqual({
      running: false,
      registered: true,
      hostId: "host-a",
      desiredRevision: "rev-1",
      lastPollAfterMs: 11_000,
      lastError: undefined
    });
  });

  it("does not reapply when the desired revision is unchanged", async () => {
    const transport = new MockAdminTransport();
    transport.putArtifactManifest({
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
    });
    transport.setDesiredHostState(createDesired("host-a", "rev-2"));
    const adminClient = new HardessAdminClient(transport);
    const applyDesiredHostState = mock(async (_desired: DesiredHostState) => {});

    const agent = new HostAgent(adminClient, {
      getHostRegistration: () => createRegistration(),
      applyDesiredHostState,
      collectObservedHostState: () => createObserved()
    });

    await agent.reconcileOnce();
    await agent.reconcileOnce();

    expect(applyDesiredHostState).toHaveBeenCalledTimes(1);
    expect(agent.getSnapshot().desiredRevision).toBe("rev-2");
  });

  it("uses retry poll delay and keeps desired revision unchanged when apply fails", async () => {
    const transport = new MockAdminTransport({
      nextPollAfterMs: 11_000
    });
    transport.putArtifactManifest({
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
    });
    transport.setDesiredHostState(createDesired("host-a", "rev-bad"));
    const adminClient = new HardessAdminClient(transport);
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {})
    };

    const agent = new HostAgent(
      adminClient,
      {
        getHostRegistration: () => createRegistration(),
        applyDesiredHostState: async () => {
          throw new Error("apply failed");
        },
        collectObservedHostState: () => createObserved()
      },
      {
        logger,
        retryPollAfterMs: 250
      }
    );

    await agent.reconcileOnce();

    expect(agent.getSnapshot().desiredRevision).toBeUndefined();
    expect(agent.getSnapshot().lastPollAfterMs).toBe(250);
    expect(agent.getSnapshot().lastError).toBe("apply failed");
    expect(logger.error).toHaveBeenCalled();
  });

  it("start schedules the next poll and stop cancels it", async () => {
    const transport = new MockAdminTransport({
      nextPollAfterMs: 1_234
    });
    transport.putArtifactManifest({
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
    });
    transport.setDesiredHostState(createDesired("host-a", "rev-3"));
    const adminClient = new HardessAdminClient(transport);
    const scheduled = new Map<number, () => void>();
    const cleared = new Set<number>();
    let nextTimerId = 1;

    const agent = new HostAgent(
      adminClient,
      {
        getHostRegistration: () => createRegistration(),
        applyDesiredHostState: async () => {},
        collectObservedHostState: () => createObserved()
      },
      {
        timers: {
          setTimeout(callback) {
            const id = nextTimerId++;
            scheduled.set(id, callback);
            return id as unknown as ReturnType<typeof setTimeout>;
          },
          clearTimeout(timeout) {
            cleared.add(timeout as unknown as number);
            scheduled.delete(timeout as unknown as number);
          }
        }
      }
    );

    agent.start();
    await Bun.sleep(0);

    expect(agent.getSnapshot().running).toBe(true);
    expect(agent.getSnapshot().lastPollAfterMs).toBe(1_234);
    expect(scheduled.size).toBe(1);

    const scheduledId = scheduled.keys().next().value as number;
    agent.stop();

    expect(agent.getSnapshot().running).toBe(false);
    expect(cleared.has(scheduledId)).toBe(true);
  });
});
