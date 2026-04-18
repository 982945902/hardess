import { describe, expect, it, mock } from "bun:test";
import { InMemoryMetrics } from "../observability/metrics.ts";
import { StaticClusterNetwork } from "./network.ts";

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

function createSocketPair(): [FakeClusterSocket, FakeClusterSocket] {
  const left = new FakeClusterSocket();
  const right = new FakeClusterSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
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
