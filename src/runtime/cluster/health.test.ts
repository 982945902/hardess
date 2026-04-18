import { describe, expect, it } from "bun:test";
import {
  ClusterPeerHealthStore,
  type ClusterPeerHealthStatus
} from "./health.ts";

describe("ClusterPeerHealthStore", () => {
  it("escalates suspect peers to dead after the configured timeout", () => {
    let now = 1_000;
    const scheduled = new Map<number, () => void>();
    let nextTimerId = 1;
    const store = new ClusterPeerHealthStore({
      suspectTimeoutMs: 50,
      now: () => now,
      timers: {
        setTimeout(callback) {
          const timerId = nextTimerId++;
          scheduled.set(timerId, callback);
          return timerId;
        },
        clearTimeout(timerId) {
          scheduled.delete(timerId as number);
        }
      }
    });
    const statuses: ClusterPeerHealthStatus[] = [];
    store.subscribe((snapshot) => {
      statuses.push(snapshot.status);
    });

    store.markSuspect("node-b", "channel_closed");
    expect(store.getStatus("node-b")).toBe("suspect");

    now += 50;
    const timer = scheduled.get(1);
    expect(timer).toBeDefined();
    timer?.();

    expect(store.getStatus("node-b")).toBe("dead");
    expect(statuses).toEqual(["suspect", "dead"]);
  });

  it("returns a peer to alive and cancels dead escalation when a fresh observation arrives", () => {
    let scheduledCallback: (() => void) | undefined;
    const store = new ClusterPeerHealthStore({
      suspectTimeoutMs: 50,
      timers: {
        setTimeout(callback) {
          scheduledCallback = callback;
          return 1;
        },
        clearTimeout() {
          scheduledCallback = undefined;
        }
      }
    });

    store.markSuspect("node-b", "request_timeout");
    store.markAlive("node-b", "hello_ack");

    expect(store.getStatus("node-b")).toBe("alive");
    expect(scheduledCallback).toBeUndefined();
  });

  it("drops health entries that are no longer part of the known peer set", () => {
    const store = new ClusterPeerHealthStore();
    store.markDead("node-b", "dead");
    store.markAlive("node-c", "alive");

    store.noteKnownPeers(["node-c"]);

    expect(store.snapshot("node-b")).toBeUndefined();
    expect(store.getStatus("node-c")).toBe("alive");
  });

  it("applies newer remote health rumors for known peers", () => {
    const store = new ClusterPeerHealthStore();
    store.noteKnownPeers(["node-b"]);

    store.applyRumor(
      {
        nodeId: "node-b",
        status: "suspect",
        incarnation: 7
      },
      "node-c"
    );

    expect(store.snapshot("node-b")).toEqual(
      expect.objectContaining({
        status: "suspect",
        incarnation: 7,
        source: "remote",
        reportedByNodeId: "node-c"
      })
    );
  });

  it("ignores remote rumors for peers outside the admin-approved set", () => {
    const store = new ClusterPeerHealthStore();
    store.noteKnownPeers(["node-b"]);

    store.applyRumor(
      {
        nodeId: "node-x",
        status: "dead",
        incarnation: 1
      },
      "node-c"
    );

    expect(store.snapshot("node-x")).toBeUndefined();
  });

  it("keeps equal-incarnation local observations ahead of remote rumors", () => {
    const store = new ClusterPeerHealthStore();
    store.noteKnownPeers(["node-b"]);
    store.markAlive("node-b", "pong");

    store.applyRumor(
      {
        nodeId: "node-b",
        status: "suspect",
        incarnation: 1
      },
      "node-c"
    );

    expect(store.snapshot("node-b")).toEqual(
      expect.objectContaining({
        status: "alive",
        incarnation: 1,
        source: "local"
      })
    );
  });
});
