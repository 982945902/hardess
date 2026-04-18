import { describe, expect, it, mock } from "bun:test";
import { InMemoryMetrics } from "../observability/metrics.ts";
import { StaticClusterNetwork } from "./network.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

type EventMap = {
  open: Array<() => void>;
  message: Array<(event: { data?: unknown }) => void>;
  close: Array<(event: { code?: number; reason?: string }) => void>;
  error: Array<() => void>;
};

class FakeClusterSocket {
  readyState = 0;
  peer?: FakeClusterSocket;
  sendResults: number[] = [];
  private readonly listeners: EventMap = {
    open: [],
    message: [],
    close: [],
    error: []
  };

  send(data: string): number {
    if (!this.peer) {
      throw new Error("Fake cluster socket is not connected");
    }

    const nextResult = this.sendResults.shift();
    if (nextResult === -1 || nextResult === 0) {
      return nextResult;
    }

    this.peer.emit("message", { data });
    return nextResult ?? data.length;
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return;
    }

    this.readyState = 3;
    this.emit("close", { code, reason });
    if (this.peer && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.emit("close", { code, reason });
    }
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: { data?: unknown }) => void)
      | ((event: { code?: number; reason?: string }) => void)
  ): void {
    this.listeners[type].push(listener as never);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  private emit(type: "open"): void;
  private emit(type: "error"): void;
  private emit(type: "message", event: { data?: unknown }): void;
  private emit(type: "close", event: { code?: number; reason?: string }): void;
  private emit(
    type: "open" | "message" | "close" | "error",
    event?: { data?: unknown } | { code?: number; reason?: string }
  ): void {
    for (const listener of this.listeners[type]) {
      (listener as (event?: { data?: unknown } | { code?: number; reason?: string }) => void)(event);
    }
  }
}

class ManualTimers {
  private nextId = 1;
  private readonly timeouts = new Map<number, () => void>();
  private readonly intervals = new Map<number, () => void>();

  setTimeout = (callback: () => void, _delay?: number): TimerHandle => {
    const id = this.nextId++;
    this.timeouts.set(id, callback);
    return id as unknown as TimerHandle;
  };

  clearTimeout = (id: TimerHandle): void => {
    this.timeouts.delete(id as unknown as number);
  };

  setInterval = (callback: () => void, _delay?: number): TimerHandle => {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id as unknown as TimerHandle;
  };

  clearInterval = (id: TimerHandle): void => {
    this.intervals.delete(id as unknown as number);
  };

  tickIntervals(): void {
    for (const callback of this.intervals.values()) {
      callback();
    }
  }

  runNextTimeout(): void {
    const [id, callback] = this.timeouts.entries().next().value ?? [];
    if (id === undefined || !callback) {
      throw new Error("No timeout scheduled");
    }
    this.timeouts.delete(id);
    callback();
  }
}

function createSocketPair(): [FakeClusterSocket, FakeClusterSocket] {
  const left = new FakeClusterSocket();
  const right = new FakeClusterSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("StaticClusterNetwork", () => {
  it("forwards cluster requests with the configured shared secret", async () => {
    const fetchFn = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({
          "x-hardess-cluster-secret": "secret"
        })
      );

      return new Response(
        JSON.stringify({
          deliveredConns: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const network = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        sharedSecret: "secret",
        fetchFn
      }
    );

    const delivered = await network.deliver("node-b", {
      sender: { nodeId: "node-a", connId: "conn-sender", peerId: "alice" },
      envelope: {
        msgId: "m-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-sender" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { ok: true }
      },
      ack: "recv",
      targets: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
    });

    expect(delivered).toEqual([{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]);
  });

  it("reuses a long-lived websocket channel for cluster deliver and handleAck", async () => {
    const acceptedDeliveries: Array<{ ack: string; targets: Array<{ connId: string }> }> = [];
    const acceptedHandleAcks: string[] = [];
    const openedUrls: string[] = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        acceptedDeliveries.push({
          ack: payload.ack,
          targets: payload.targets.map((target) => ({ connId: target.connId }))
        });
        return payload.targets;
      },
      async handleAck(payload) {
        acceptedHandleAcks.push(payload.ackFor);
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        socketFactory(url) {
          openedUrls.push(url);
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    const sender = { nodeId: "node-a", connId: "conn-alice", peerId: "alice" };
    const targets = [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }];
    const delivered = await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "hello" }
      },
      ack: "handle",
      targets
    });

    await clientNetwork.forwardHandleAck(
      { nodeId: "node-b", connId: "conn-bob", peerId: "bob" },
      "m-1",
      "trace-1"
    );

    expect(delivered).toEqual(targets);
    expect(openedUrls).toEqual(["ws://node-b.internal/__cluster/ws"]);
    expect(acceptedDeliveries).toEqual([
      {
        ack: "handle",
        targets: [{ connId: "conn-bob" }]
      }
    ]);
    expect(acceptedHandleAcks).toEqual(["m-1"]);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("retries websocket cluster sends after backpressure", async () => {
    const metrics = new InMemoryMetrics();
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    let clientSocketRef: FakeClusterSocket | undefined;
    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        metrics,
        requestTimeoutMs: 500,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          clientSocketRef = clientSocket;
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    const sender = { nodeId: "node-a", connId: "conn-alice", peerId: "alice" };
    const targets = [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }];
    const handshakeDelivered = await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-0",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "warmup" }
      },
      ack: "recv",
      targets
    });

    expect(handshakeDelivered).toEqual(targets);
    expect(clientSocketRef).toBeDefined();
    clientSocketRef?.sendResults.push(-1);

    const delivered = await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "retry" }
      },
      ack: "recv",
      targets
    });

    expect(delivered).toEqual(targets);
    expect(metrics.snapshot().counters).toEqual(
      expect.objectContaining({
        "cluster.egress_backpressure": 1,
        "cluster.message_out": expect.any(Number)
      })
    );

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("rejects invalid websocket cluster messages through the shared schema path", async () => {
    const metrics = new InMemoryMetrics();
    const network = new StaticClusterNetwork([], {
      nodeId: "node-a",
      metrics
    });
    const socket = new FakeClusterSocket();
    let closeInfo: { code?: number; reason?: string } | undefined;
    socket.addEventListener("close", (event: { code?: number; reason?: string }) => {
      closeInfo = event;
    });

    network.openServerSocket(socket);
    await network.messageServerSocket(
      socket,
      JSON.stringify({
        type: "deliver",
        ref: "bad-1",
        sender: { nodeId: "node-b", connId: "conn-bob", peerId: "bob" },
        envelope: {
          msgId: "missing-fields-only"
        },
        ack: "recv",
        targets: [{ nodeId: "node-a", connId: "conn-alice", peerId: "alice" }]
      })
    );

    expect(closeInfo).toEqual({
      code: 4400,
      reason: "invalid cluster message"
    });
    expect(metrics.snapshot().counters["cluster.invalid_message"]).toBe(1);

    network.dispose();
  });

  it("warms websocket cluster channels ahead of traffic", async () => {
    const openedUrls: string[] = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        socketFactory(url) {
          openedUrls.push(url);
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    await clientNetwork.warmConnections();
    expect(openedUrls).toEqual(["ws://node-b.internal/__cluster/ws"]);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("reports peer health transitions from websocket channel observations", async () => {
    const observed: string[] = [];
    let clientSocketRef: FakeClusterSocket | undefined;
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        peerHealthObserver: {
          markAlive(nodeId, detail) {
            observed.push(`alive:${nodeId}:${detail}`);
          },
          markSuspect(nodeId, detail) {
            observed.push(`suspect:${nodeId}:${detail}`);
          }
        },
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          clientSocketRef = clientSocket;
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    await clientNetwork.warmConnections();
    clientSocketRef?.close(1012, "closed");

    expect(observed.some((entry) => entry.startsWith("alive:node-b:"))).toBe(true);
    expect(observed.some((entry) => entry === "suspect:node-b:channel_closed")).toBe(true);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("actively probes websocket peers and marks them alive on pong", async () => {
    const timers = new ManualTimers();
    const observed: string[] = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        peerProbeIntervalMs: 50,
        peerPingTimeoutMs: 10,
        peerHealthObserver: {
          markAlive(nodeId, detail) {
            observed.push(`alive:${nodeId}:${detail}`);
          },
          markSuspect(nodeId, detail) {
            observed.push(`suspect:${nodeId}:${detail}`);
          }
        },
        timers,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    clientNetwork.startPeerProbes();
    await flushMicrotasks();
    timers.tickIntervals();
    await flushMicrotasks();

    expect(observed.some((entry) => entry === "alive:node-b:pong")).toBe(true);
    expect(observed.some((entry) => entry.startsWith("suspect:node-b:probe_timeout"))).toBe(false);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("marks a websocket peer suspect when an active probe misses pong", async () => {
    const timers = new ManualTimers();
    const observed: string[] = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        peerProbeIntervalMs: 50,
        peerPingTimeoutMs: 10,
        peerHealthObserver: {
          markAlive(nodeId, detail) {
            observed.push(`alive:${nodeId}:${detail}`);
          },
          markSuspect(nodeId, detail) {
            observed.push(`suspect:${nodeId}:${detail}`);
          }
        },
        timers,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            const raw = String(event.data ?? "");
            if (raw.includes('"type":"ping"')) {
              return;
            }
            void serverNetwork.messageServerSocket(serverSocket, raw);
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    clientNetwork.startPeerProbes();
    await flushMicrotasks();
    timers.tickIntervals();
    await flushMicrotasks();
    timers.runNextTimeout();

    expect(observed.some((entry) => entry === "suspect:node-b:probe_timeout")).toBe(true);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("broadcasts peer health rumors over the websocket cluster channel", async () => {
    const receivedRumors: Array<{
      fromNodeId: string;
      nodeId: string;
      status: string;
      incarnation: number;
    }> = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret",
      peerHealthObserver: {
        markAlive() {},
        markSuspect() {},
        applyRumor(rumor, fromNodeId) {
          receivedRumors.push({
            fromNodeId,
            nodeId: rumor.nodeId,
            status: rumor.status,
            incarnation: rumor.incarnation
          });
        }
      }
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    await clientNetwork.warmConnections();
    await clientNetwork.broadcastPeerHealthRumor(
      {
        nodeId: "node-c",
        status: "suspect",
        incarnation: 3,
        updatedAt: Date.now(),
        detail: "probe_timeout",
        source: "local"
      },
      {
        excludeNodeIds: ["node-c"]
      }
    );

    expect(receivedRumors).toEqual([
      {
        fromNodeId: "node-a",
        nodeId: "node-c",
        status: "suspect",
        incarnation: 3
      }
    ]);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("broadcasts peer health sync snapshots over the websocket cluster channel", async () => {
    const metrics = new InMemoryMetrics();
    const receivedRumors: Array<{
      fromNodeId: string;
      nodeId: string;
      status: string;
      incarnation: number;
    }> = [];
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret",
      peerHealthObserver: {
        markAlive() {},
        markSuspect() {},
        applyRumor(rumor, fromNodeId) {
          receivedRumors.push({
            fromNodeId,
            nodeId: rumor.nodeId,
            status: rumor.status,
            incarnation: rumor.incarnation
          });
        }
      }
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        metrics,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    await clientNetwork.warmConnections();
    const snapshots = [
      {
        nodeId: "node-c",
        status: "alive",
        incarnation: 5,
        updatedAt: Date.now(),
        lastAliveAt: 123,
        detail: "pong",
        source: "local"
      },
      {
        nodeId: "node-d",
        status: "dead",
        incarnation: 2,
        updatedAt: Date.now(),
        detail: "channel_closed",
        source: "local"
      }
    ] as const;
    await clientNetwork.broadcastPeerHealthSync([...snapshots]);

    expect(receivedRumors).toEqual([
      {
        fromNodeId: "node-a",
        nodeId: "node-c",
        status: "alive",
        incarnation: 5
      },
      {
        fromNodeId: "node-a",
        nodeId: "node-d",
        status: "dead",
        incarnation: 2
      }
    ]);

    receivedRumors.length = 0;
    await clientNetwork.broadcastPeerHealthSync([...snapshots]);
    expect(receivedRumors).toEqual([]);

    await clientNetwork.broadcastPeerHealthSync([
      {
        ...snapshots[0],
        status: "suspect",
        incarnation: 6
      },
      snapshots[1]
    ]);
    expect(receivedRumors).toEqual([
      {
        fromNodeId: "node-a",
        nodeId: "node-c",
        status: "suspect",
        incarnation: 6
      }
    ]);
    expect(metrics.snapshot().counters).toEqual(
      expect.objectContaining({
        "cluster.peer_health_sync_out": 2,
        "cluster.peer_health_sync_item_out": 3,
        "cluster.peer_health_sync_skip": 1
      })
    );

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("runs periodic peer health sync when anti-entropy is enabled", async () => {
    const timers = new ManualTimers();
    const metrics = new InMemoryMetrics();
    const receivedRumors: string[] = [];
    let currentIncarnation = 9;
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret",
      peerHealthObserver: {
        markAlive() {},
        markSuspect() {},
        applyRumor(rumor) {
          receivedRumors.push(`${rumor.nodeId}:${rumor.status}:${rumor.incarnation}`);
        }
      }
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        peerProbeIntervalMs: 50,
        peerPingTimeoutMs: 10,
        peerAntiEntropyIntervalMs: 25,
        metrics,
        peerHealthSnapshotProvider() {
          return [
            {
              nodeId: "node-c",
              status: "suspect",
              incarnation: currentIncarnation,
              updatedAt: 1,
              detail: "probe_timeout",
              source: "local"
            }
          ];
        },
        timers,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    clientNetwork.startPeerProbes();
    await flushMicrotasks();
    timers.tickIntervals();
    await flushMicrotasks();

    expect(receivedRumors).toContain("node-c:suspect:9");
    receivedRumors.length = 0;
    timers.tickIntervals();
    await flushMicrotasks();
    expect(receivedRumors).toEqual([]);

    currentIncarnation = 10;
    timers.tickIntervals();
    await flushMicrotasks();
    expect(receivedRumors).toContain("node-c:suspect:10");
    expect(metrics.snapshot().counters["cluster.peer_health_sync_skip"]).toBeGreaterThanOrEqual(1);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("falls back to http delivery when the websocket cluster channel is unavailable", async () => {
    const fetchFn = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          deliveredConns: [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const network = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        requestTimeoutMs: 10,
        fetchFn,
        socketFactory() {
          return {
            readyState: 0,
            send() {
              return 1;
            },
            close() {},
            addEventListener() {}
          };
        }
      }
    );

    const delivered = await network.deliver("node-b", {
      sender: { nodeId: "node-a", connId: "conn-alice", peerId: "alice" },
      envelope: {
        msgId: "m-http-fallback",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "fallback" }
      },
      ack: "recv",
      targets: [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]
    });

    expect(delivered).toEqual([{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]);
    expect(fetchFn).toHaveBeenCalled();
  });

  it("can disconnect a peer channel without dropping the configured peer table", async () => {
    let clientSocketRef: FakeClusterSocket | undefined;
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          clientSocketRef = clientSocket;
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    await clientNetwork.warmConnections();
    clientNetwork.disconnectPeer("node-b", "peer_dead");

    expect(clientNetwork.listPeers()).toEqual([{ nodeId: "node-b", baseUrl: "http://node-b.internal" }]);
    expect(clientSocketRef?.readyState).toBe(3);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("waits for queue capacity before failing with cluster outbound overflow", async () => {
    const metrics = new InMemoryMetrics();
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    let clientSocketRef: FakeClusterSocket | undefined;
    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        metrics,
        requestTimeoutMs: 200,
        outboundMaxQueueMessages: 1,
        outboundBackpressureRetryMs: 5,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          clientSocketRef = clientSocket;
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    const sender = { nodeId: "node-a", connId: "conn-alice", peerId: "alice" };
    const targets = [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }];

    await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "warmup",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "warmup" }
      },
      ack: "recv",
      targets
    });

    clientSocketRef?.sendResults.push(-1, -1, -1);

    const deliverA = clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-a",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "a" }
      },
      ack: "recv",
      targets
    });

    const deliverB = clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-b",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "b" }
      },
      ack: "recv",
      targets
    });

    const delivered = await Promise.all([deliverA, deliverB]);

    expect(delivered).toEqual([targets, targets]);
    expect(metrics.snapshot().counters["cluster.egress_overflow"] ?? 0).toBe(0);

    clientNetwork.dispose();
    serverNetwork.dispose();
  });

  it("enforces websocket cluster queue byte limits", async () => {
    const metrics = new InMemoryMetrics();
    const fetchFn = mock(async () => {
      return new Response(
        JSON.stringify({
          deliveredConns: [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;
    const serverNetwork = new StaticClusterNetwork([], {
      nodeId: "node-b",
      sharedSecret: "secret"
    });
    serverNetwork.setServerHandlers({
      async deliver(payload) {
        return payload.targets;
      },
      async handleAck() {
        return true;
      }
    });

    let clientSocketRef: FakeClusterSocket | undefined;
    const clientNetwork = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      {
        nodeId: "node-a",
        transport: "ws",
        sharedSecret: "secret",
        metrics,
        fetchFn,
        requestTimeoutMs: 200,
        outboundMaxQueueMessages: 8,
        outboundMaxQueueBytes: 400,
        outboundBackpressureRetryMs: 5,
        socketFactory() {
          const [clientSocket, serverSocket] = createSocketPair();
          clientSocketRef = clientSocket;
          serverNetwork.openServerSocket(serverSocket);
          serverSocket.addEventListener("message", (event: { data?: unknown }) => {
            void serverNetwork.messageServerSocket(serverSocket, String(event.data ?? ""));
          });
          serverSocket.addEventListener("close", () => {
            serverNetwork.closeServerSocket(serverSocket);
          });
          queueMicrotask(() => {
            serverSocket.open();
            clientSocket.open();
          });
          return clientSocket;
        }
      }
    );

    const sender = { nodeId: "node-a", connId: "conn-alice", peerId: "alice" };
    const targets = [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }];

    await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "warmup-bytes",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: "warmup" }
      },
      ack: "recv",
      targets
    });

    clientSocketRef?.sendResults.push(-1, -1, -1);
    const largePayload = "x".repeat(1024);

    const delivered = await clientNetwork.deliver("node-b", {
      sender,
      envelope: {
        msgId: "m-bytes",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: { content: largePayload }
      },
      ack: "recv",
      targets
    });

    expect(delivered).toEqual(targets);
    expect(metrics.snapshot().counters["cluster.egress_overflow"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(fetchFn).toHaveBeenCalled();

    clientNetwork.dispose();
    serverNetwork.dispose();
  });
});
