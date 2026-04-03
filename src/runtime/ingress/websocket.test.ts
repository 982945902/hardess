import { describe, expect, it } from "bun:test";
import type { Envelope } from "../../shared/types.ts";
import { parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { DemoBearerAuthProvider } from "../auth/provider.ts";
import { RuntimeAuthService } from "../auth/service.ts";
import { createWebSocketHandlers } from "./websocket.ts";
import { ConsoleLogger } from "../observability/logger.ts";
import { chatServerModule } from "../protocol/chat-module.ts";
import { demoServerModule } from "../protocol/demo-module.ts";
import { ServerProtocolRegistry } from "../protocol/registry.ts";
import { Dispatcher } from "../routing/dispatcher.ts";
import { InMemoryPeerLocator } from "../routing/peer-locator.ts";

interface TestSocket {
  data: {
    connId: string;
  };
  sent: string[];
  closed?: {
    code?: number;
    reason?: string;
  };
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function createSocket(connId: string): TestSocket {
  return {
    data: { connId },
    sent: [],
    send(data: string) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      this.closed = { code, reason };
    }
  };
}

function lastEnvelope(socket: TestSocket): Envelope<unknown> | null {
  const raw = socket.sent.at(-1);
  return raw ? parseEnvelope(raw) : null;
}

describe("createWebSocketHandlers", () => {
  it("authenticates sockets and dispatches business messages", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(demoServerModule);

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger()
    });

    const alice = createSocket("conn-alice");
    const bob = createSocket("conn-bob");

    handlers.open(alice);
    handlers.open(bob);

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "m-auth-alice",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: Date.now(),
        payload: {
          provider: "bearer",
          payload: "demo:alice"
        }
      })
    );

    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "m-auth-bob",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: Date.now(),
        payload: {
          provider: "bearer",
          payload: "demo:bob"
        }
      })
    );

    expect(lastEnvelope(alice)?.action).toBe("auth.ok");
    expect(lastEnvelope(bob)?.action).toBe("auth.ok");

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "m-biz-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      })
    );

    const bobMessage = lastEnvelope(bob);
    const aliceAck = lastEnvelope(alice);
    const aliceRoute = parseEnvelope(alice.sent.at(-2) ?? "");

    expect(bobMessage?.kind).toBe("biz");
    expect(bobMessage?.action).toBe("send");
    expect(bobMessage?.payload).toEqual({
      toPeerId: "bob",
      content: "hello"
    });
    expect(aliceRoute?.kind).toBe("system");
    expect(aliceRoute?.action).toBe("route");
    expect((aliceRoute?.payload as { resolvedPeers?: string[] } | undefined)?.resolvedPeers).toEqual(["bob"]);
    expect(aliceAck?.kind).toBe("system");
    expect(aliceAck?.action).toBe("recvAck");
    expect((aliceAck?.payload as { ackFor?: string } | undefined)?.ackFor).toBe("m-biz-1");

    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "m-handle-1",
        kind: "system",
        src: { peerId: "bob", connId: "conn-bob" },
        protocol: "sys",
        version: "1.0",
        action: "handleAck",
        ts: Date.now(),
        payload: {
          ackFor: "m-biz-1"
        }
      })
    );

    const aliceHandleAck = lastEnvelope(alice);
    expect(aliceHandleAck?.kind).toBe("system");
    expect(aliceHandleAck?.action).toBe("handleAck");
    expect((aliceHandleAck?.payload as { ackFor?: string } | undefined)?.ackFor).toBe("m-biz-1");
    handlers.dispose();
  });

  it("sends heartbeat ping and closes stale connections", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    const intervals: Array<() => void> = [];
    let currentTime = 0;

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      heartbeatIntervalMs: 25,
      staleAfterMs: 60,
      now: () => currentTime,
      setIntervalFn(handler) {
        intervals.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn() {}
    });

    const alice = createSocket("conn-alice");
    handlers.open(alice);
    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "m-auth-alice",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: currentTime,
        payload: {
          provider: "bearer",
          payload: "demo:alice"
        }
      })
    );

    currentTime = 30;
    intervals[0]?.();
    await Promise.resolve();
    expect(lastEnvelope(alice)?.action).toBe("ping");

    currentTime = 100;
    intervals[0]?.();
    expect(alice.closed?.code).toBe(4408);
    handlers.dispose();
  });

  it("supports server-side dispatch transformation for chat messages", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(chatServerModule);

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger()
    });

    const alice = createSocket("conn-alice");
    const bob = createSocket("conn-bob");

    handlers.open(alice);
    handlers.open(bob);

    for (const [socket, token] of [
      [alice, "demo:alice"],
      [bob, "demo:bob"]
    ] as const) {
      await handlers.message(
        socket,
        serializeEnvelope({
          msgId: `auth-${socket.data.connId}`,
          kind: "system",
          src: { peerId: "anonymous", connId: "pending" },
          protocol: "sys",
          version: "1.0",
          action: "auth",
          ts: Date.now(),
          payload: {
            provider: "bearer",
            payload: token
          }
        })
      );
    }

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "chat-send-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "hi bob"
        }
      })
    );

    const bobMessage = lastEnvelope(bob);
    expect(bobMessage?.protocol).toBe("chat");
    expect(bobMessage?.action).toBe("message");
    expect(bobMessage?.streamId).toBe("chat:alice:bob");
    expect(bobMessage?.payload).toEqual({
      fromPeerId: "alice",
      content: "hi bob"
    });

    const aliceRecvAck = lastEnvelope(alice);
    expect(aliceRecvAck?.action).toBe("recvAck");
    expect((aliceRecvAck?.payload as { ackFor?: string } | undefined)?.ackFor).toBe("chat-send-1");

    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "chat-handle-1",
        kind: "system",
        src: { peerId: "bob", connId: "conn-bob" },
        protocol: "sys",
        version: "1.0",
        action: "handleAck",
        ts: Date.now(),
        payload: {
          ackFor: "chat-send-1"
        }
      })
    );

    const aliceHandleAck = lastEnvelope(alice);
    expect(aliceHandleAck?.action).toBe("handleAck");
    expect((aliceHandleAck?.payload as { ackFor?: string } | undefined)?.ackFor).toBe("chat-send-1");
    handlers.dispose();
  });

  it("closes the socket on auth failure", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger()
    });

    const alice = createSocket("conn-alice");
    handlers.open(alice);

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "bad-auth-1",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: Date.now(),
        payload: {
          provider: "bearer",
          payload: "not-a-demo-token"
        }
      })
    );

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("AUTH_INVALID_TOKEN");
    expect(alice.closed?.code).toBe(4401);
    handlers.dispose();
  });

  it("closes the socket on invalid websocket envelope", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger()
    });

    const alice = createSocket("conn-alice");
    handlers.open(alice);

    await handlers.message(alice, "{not-json");

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("PROTO_INVALID_PAYLOAD");
    expect(alice.closed?.code).toBe(4400);
    handlers.dispose();
  });

  it("enforces per-peer connection quotas during auth", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      maxConnectionsPerPeer: 1
    });

    const first = createSocket("conn-1");
    const second = createSocket("conn-2");

    handlers.open(first);
    handlers.open(second);

    for (const socket of [first, second]) {
      await handlers.message(
        socket,
        serializeEnvelope({
          msgId: `auth-${socket.data.connId}`,
          kind: "system",
          src: { peerId: "anonymous", connId: "pending" },
          protocol: "sys",
          version: "1.0",
          action: "auth",
          ts: Date.now(),
          payload: {
            provider: "bearer",
            payload: "demo:alice"
          }
        })
      );
    }

    expect(first.closed).toBeUndefined();
    expect(lastEnvelope(first)?.action).toBe("auth.ok");
    expect(lastEnvelope(second)?.action).toBe("err");
    expect((lastEnvelope(second)?.payload as { code?: string } | undefined)?.code).toBe("CONN_QUOTA_EXCEEDED");
    expect(second.closed?.code).toBe(4429);
    handlers.dispose();
  });

  it("enforces inbound websocket message rate limits", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    let currentTime = 0;

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      rateLimit: {
        windowMs: 100,
        maxMessages: 2
      },
      now: () => currentTime
    });

    const alice = createSocket("conn-alice");
    handlers.open(alice);

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "auth-1",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: currentTime,
        payload: {
          provider: "bearer",
          payload: "demo:alice"
        }
      })
    );

    currentTime = 10;
    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "ping-1",
        kind: "system",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "sys",
        version: "1.0",
        action: "ping",
        ts: currentTime,
        payload: {
          nonce: "n-1"
        }
      })
    );

    currentTime = 20;
    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "ping-2",
        kind: "system",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "sys",
        version: "1.0",
        action: "ping",
        ts: currentTime,
        payload: {
          nonce: "n-2"
        }
      })
    );

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(alice.closed?.code).toBe(4429);
    handlers.dispose();
  });

  it("closes the sender when outbound queue overflows", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(demoServerModule);
    const queuedDrains: VoidFunction[] = [];

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      outbound: {
        maxQueueMessages: 1,
        maxQueueBytes: 64 * 1024
      },
      queueMicrotaskFn(callback) {
        queuedDrains.push(callback);
      }
    });

    const alice = createSocket("conn-alice");
    const bob = createSocket("conn-bob");
    handlers.open(alice);
    handlers.open(bob);

    for (const [socket, token] of [
      [alice, "demo:alice"],
      [bob, "demo:bob"]
    ] as const) {
      await handlers.message(
        socket,
        serializeEnvelope({
          msgId: `auth-${socket.data.connId}`,
          kind: "system",
          src: { peerId: "anonymous", connId: "pending" },
          protocol: "sys",
          version: "1.0",
          action: "auth",
          ts: Date.now(),
          payload: {
            provider: "bearer",
            payload: token
          }
        })
      );
      while (queuedDrains.length > 0) {
        queuedDrains.shift()?.();
      }
    }

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "overflow-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      })
    );

    expect(alice.closed?.code).toBe(4508);
    expect(alice.closed?.reason).toBe("BACKPRESSURE_OVERFLOW");
    handlers.dispose();
  });
});
