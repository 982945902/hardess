import { describe, expect, it } from "bun:test";
import { ERROR_CODES, HardessError } from "../../shared/index.ts";
import type { Envelope, ServerProtocolModule } from "../../shared/types.ts";
import { parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { DemoBearerAuthProvider, type AuthProvider } from "../auth/provider.ts";
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
  bufferedAmount?: number;
  send(data: string): number | void;
  getBufferedAmount?(): number;
  close(code?: number, reason?: string): void;
}

function createSocket(
  connId: string,
  overrides: {
    sendImpl?: (socket: TestSocket, data: string) => number | void;
    getBufferedAmountImpl?: (socket: TestSocket) => number;
  } = {}
): TestSocket {
  return {
    data: { connId },
    sent: [],
    bufferedAmount: 0,
    send(data: string) {
      if (overrides.sendImpl) {
        return overrides.sendImpl(this, data);
      }

      this.sent.push(data);
      return data.length;
    },
    getBufferedAmount() {
      if (overrides.getBufferedAmountImpl) {
        return overrides.getBufferedAmountImpl(this);
      }

      return this.bufferedAmount ?? 0;
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

function createBearerAuthProvider(capabilities: string[]): AuthProvider {
  return {
    name: "bearer",
    async validateBearerToken(token: string) {
      const normalized = token.startsWith("Bearer ") ? token.slice(7) : token;
      const [scheme, peerId] = normalized.split(":");
      if (scheme !== "demo" || !peerId) {
        throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Unsupported token format");
      }

      return {
        peerId,
        tokenId: normalized,
        capabilities,
        expiresAt: Date.now() + 60 * 60 * 1000
      };
    },
    async validateSystemAuth(payload: unknown) {
      if (!payload || typeof payload !== "object" || typeof (payload as { payload?: unknown }).payload !== "string") {
        throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "Invalid bearer auth payload");
      }

      return this.validateBearerToken((payload as { payload: string }).payload);
    }
  };
}

const fanoutServerModule: ServerProtocolModule<{
  toPeerIds: string[];
  content: string;
}> = {
  protocol: "fanout",
  version: "1.0",
  actions: {
    send: {
      validate() {},
      resolveRecipients(ctx) {
        return ctx.payload.toPeerIds;
      }
    }
  }
};

const terminalServerModule: ServerProtocolModule<{
  content: string;
}> = {
  protocol: "terminal",
  version: "1.0",
  actions: {
    send: {
      validate() {},
      handleLocally() {
        return {
          ack: "handle"
        };
      }
    }
  }
};

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

  it("supports service-module actions that terminate locally without forwarding", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(terminalServerModule);

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
      alice,
      serializeEnvelope({
        msgId: "m-terminal-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "terminal",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          content: "only-local"
        }
      })
    );

    const actions = alice.sent
      .map((raw) => parseEnvelope(raw)?.action)
      .filter((value): value is string => value !== undefined);
    expect(actions.slice(-2)).toEqual(["recvAck", "handleAck"]);
  });

  it("uses hostGroupId instead of trusting client-selected auth group", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(demoServerModule);

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      hostGroupId: "group-a",
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
          payload: "demo:alice",
          groupId: "group-client-wrong"
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
          payload: "demo:bob",
          groupId: "group-other-wrong"
        }
      })
    );

    expect(peerLocator.getByConnId("conn-alice")?.groupId).toBe("group-a");
    expect(peerLocator.getByConnId("conn-bob")?.groupId).toBe("group-a");

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "m-biz-group-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "hello-group-a"
        }
      })
    );

    expect(lastEnvelope(bob)?.kind).toBe("biz");
    expect(lastEnvelope(bob)?.payload).toEqual({
      toPeerId: "bob",
      content: "hello-group-a"
    });
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

  it("rejects protocol actions when required capabilities are missing", async () => {
    const authService = new RuntimeAuthService([createBearerAuthProvider(["push.system"])]);
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
        msgId: "acl-send-1",
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

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("ACL_DENIED");
    expect(alice.closed?.code).toBe(4403);
    expect(bob.sent.filter((raw) => parseEnvelope(raw)?.kind === "biz")).toHaveLength(0);
    handlers.dispose();
  });

  it("suppresses duplicate cluster deliveries for the same message id", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(chatServerModule);

    const handlers = createWebSocketHandlers({
      nodeId: "node-b",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger()
    });

    const bob = createSocket("conn-bob");
    handlers.open(bob);

    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "auth-bob",
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

    const payload = {
      sender: { nodeId: "node-a", connId: "conn-alice", peerId: "alice" },
      envelope: {
        msgId: "cluster-dup-1",
        kind: "biz" as const,
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "message",
        ts: Date.now(),
        payload: {
          fromPeerId: "alice",
          content: "hello"
        }
      },
      ack: "handle" as const,
      targets: [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]
    };

    const first = await handlers.deliverCluster(payload);
    const second = await handlers.deliverCluster(payload);

    const bizMessages = bob.sent
      .map((raw) => parseEnvelope(raw))
      .filter((envelope) => envelope?.kind === "biz" && envelope.msgId === "cluster-dup-1");

    expect(first).toEqual(payload.targets);
    expect(second).toEqual(payload.targets);
    expect(bizMessages).toHaveLength(1);
    handlers.dispose();
  });

  it("closes the socket on invalid system payloads", async () => {
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
        msgId: "auth-alice",
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
      alice,
      serializeEnvelope({
        msgId: "bad-handle-ack",
        kind: "system",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "sys",
        version: "1.0",
        action: "handleAck",
        ts: Date.now(),
        payload: {}
      })
    );

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("PROTO_INVALID_PAYLOAD");
    expect(alice.closed?.code).toBe(4400);
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
      }
    });

    const alice = createSocket("conn-alice", {
      sendImpl(socket, data) {
        if (parseEnvelope(data)?.action === "auth.ok") {
          socket.sent.push(data);
          return data.length;
        }

        return -1;
      }
    });
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

  it("retries queued sends after websocket backpressure clears", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(demoServerModule);
    const timeouts: Array<() => void> = [];
    let backpressured = true;
    let outboundBizSendAttempts = 0;

    const handlers = createWebSocketHandlers({
      nodeId: "local",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      outbound: {
        maxQueueMessages: 8,
        maxQueueBytes: 64 * 1024,
        backpressureRetryMs: 5
      },
      setTimeoutFn(callback) {
        timeouts.push(callback);
        return timeouts.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn() {}
    });

    const alice = createSocket("conn-alice");
    const bob = createSocket("conn-bob", {
      sendImpl(socket, data: string) {
        if (parseEnvelope(data)?.action === "auth.ok") {
          socket.sent.push(data);
          return data.length;
        }

        outboundBizSendAttempts += 1;

        if (backpressured) {
          return -1;
        }

        socket.sent.push(data);
        return data.length;
      }
    });
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
        msgId: "queued-1",
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

    await Promise.resolve();
    expect(bob.sent.some((raw) => parseEnvelope(raw)?.msgId === "queued-1")).toBe(false);
    expect(outboundBizSendAttempts).toBe(1);

    backpressured = false;
    timeouts.shift()?.();
    await Promise.resolve();

    expect(bob.sent.some((raw) => parseEnvelope(raw)?.msgId === "queued-1")).toBe(true);
    expect(outboundBizSendAttempts).toBe(2);
    handlers.dispose();
  });

  it("keeps sender success surfaces when fanout is only partially delivered", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    registry.register(fanoutServerModule);

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
    const carol = createSocket("conn-carol", {
      sendImpl(socket, data) {
        if (parseEnvelope(data)?.action === "auth.ok") {
          socket.sent.push(data);
          return data.length;
        }

        return 0;
      }
    });
    handlers.open(alice);
    handlers.open(bob);
    handlers.open(carol);

    for (const [socket, token] of [
      [alice, "demo:alice"],
      [bob, "demo:bob"],
      [carol, "demo:carol"]
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
        msgId: "fanout-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "fanout",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerIds: ["bob", "carol"],
          content: "hello"
        }
      })
    );

    const aliceRecvAck = lastEnvelope(alice);
    const aliceRoute = parseEnvelope(alice.sent.at(-2) ?? "");

    expect(alice.closed).toBeUndefined();
    expect(aliceRecvAck?.action).toBe("recvAck");
    expect(aliceRoute?.action).toBe("route");
    expect((
      aliceRoute?.payload as {
        deliveredConns?: Array<{ nodeId: string; connId: string; peerId: string }>;
      } | undefined
    )?.deliveredConns).toEqual([
      {
        nodeId: "local",
        connId: "conn-bob",
        peerId: "bob"
      }
    ]);
    expect(lastEnvelope(bob)?.msgId).toBe("fanout-1");
    expect(carol.closed?.code).toBe(4508);
    expect(alice.sent.some((raw) => parseEnvelope(raw)?.action === "err")).toBe(false);
    handlers.dispose();
  });

  it("closes the socket when the websocket buffered amount exceeds the configured limit", async () => {
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
      outbound: {
        maxQueueMessages: 8,
        maxQueueBytes: 64 * 1024,
        maxSocketBufferBytes: 32
      }
    });

    const alice = createSocket("conn-alice", {
      getBufferedAmountImpl() {
        return 64;
      }
    });
    handlers.open(alice);

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "auth-alice",
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

    expect(alice.closed?.code).toBe(4508);
    expect(alice.closed?.reason).toBe("BACKPRESSURE_OVERFLOW");
    handlers.dispose();
  });

  it("rejects new business messages but still allows handleAck during shutdown drain", async () => {
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
      logger: new ConsoleLogger(),
      shutdownGraceMs: 1_000
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
        msgId: "pre-drain-send",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "before drain"
        }
      })
    );

    handlers.beginShutdown();

    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "pre-drain-handle",
        kind: "system",
        src: { peerId: "bob", connId: "conn-bob" },
        protocol: "sys",
        version: "1.0",
        action: "handleAck",
        ts: Date.now(),
        payload: {
          ackFor: "pre-drain-send"
        }
      })
    );

    const aliceHandleAck = lastEnvelope(alice);
    expect(aliceHandleAck?.action).toBe("handleAck");
    expect((aliceHandleAck?.payload as { ackFor?: string } | undefined)?.ackFor).toBe("pre-drain-send");

    await handlers.message(
      alice,
      serializeEnvelope({
        msgId: "post-drain-send",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "demo",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "after drain"
        }
      })
    );

    expect(lastEnvelope(alice)?.action).toBe("err");
    expect((lastEnvelope(alice)?.payload as { code?: string } | undefined)?.code).toBe("SERVER_DRAINING");
    expect(alice.closed).toBeUndefined();
    expect(
      bob.sent.some((raw) => {
        const envelope = parseEnvelope(raw);
        return envelope?.kind === "biz" && envelope.msgId === "post-drain-send";
      })
    ).toBe(false);
    handlers.dispose();
  });

  it("stops accepting cluster biz deliveries and closes remaining sockets after shutdown grace", async () => {
    const authService = new RuntimeAuthService([new DemoBearerAuthProvider()]);
    const peerLocator = new InMemoryPeerLocator();
    const dispatcher = new Dispatcher(peerLocator);
    const registry = new ServerProtocolRegistry();
    const timeouts: Array<() => void> = [];

    const handlers = createWebSocketHandlers({
      nodeId: "node-b",
      authService,
      peerLocator,
      dispatcher,
      registry,
      logger: new ConsoleLogger(),
      shutdownGraceMs: 5,
      setTimeoutFn(callback) {
        timeouts.push(callback);
        return timeouts.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn() {}
    });

    const bob = createSocket("conn-bob");
    handlers.open(bob);
    await handlers.message(
      bob,
      serializeEnvelope({
        msgId: "auth-bob",
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

    handlers.beginShutdown();

    const delivered = await handlers.deliverCluster({
      sender: { nodeId: "node-a", connId: "conn-alice", peerId: "alice" },
      envelope: {
        msgId: "cluster-drain-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "message",
        ts: Date.now(),
        payload: {
          fromPeerId: "alice",
          content: "hello"
        }
      },
      ack: "handle",
      targets: [{ nodeId: "node-b", connId: "conn-bob", peerId: "bob" }]
    });

    expect(delivered).toEqual([]);
    expect(
      bob.sent.some((raw) => {
        const envelope = parseEnvelope(raw);
        return envelope?.kind === "biz" && envelope.msgId === "cluster-drain-1";
      })
    ).toBe(false);

    timeouts.shift()?.();
    expect(bob.closed?.code).toBe(1001);
    expect(bob.closed?.reason).toBe("server shutting down");
    handlers.dispose();
  });
});
