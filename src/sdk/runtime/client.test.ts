import { describe, expect, it } from "bun:test";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { CLIENT_ERROR_CODES, ERROR_CODES, type HardessSdkErrorShape } from "../../shared/index.ts";
import { HardessClient } from "./client.ts";
import type { WebSocketLike, WebSocketLikeEvent } from "../transport/ws.ts";

class FakeSocket implements WebSocketLike {
  private listeners = new Map<string, Array<(event?: WebSocketLikeEvent) => void>>();
  sent: string[] = [];

  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (event?: WebSocketLikeEvent) => void
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.emit("close");
  }

  emit(type: "open" | "close" | "message" | "error", event?: WebSocketLikeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function emitAuthOk(socket: FakeSocket, peerId = "alice"): void {
  socket.emit("message", {
    data: serializeEnvelope(
      createEnvelope({
        kind: "system",
        src: { peerId: "hardess.system", connId: "system" },
        protocol: "sys",
        version: "1.0",
        action: "auth.ok",
        payload: {
          peerId,
          capabilities: [],
          expiresAt: Date.now() + 60_000
        }
      })
    )
  });
}

function createManualTimers() {
  const timeouts: Array<{
    id: number;
    delay: number;
    handler: () => void;
    cleared: boolean;
  }> = [];
  let nextTimeoutId = 1;

  return {
    timers: {
      setInterval() {
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval() {},
      setTimeout(handler: () => void, delay: number) {
        const timeout = {
          id: nextTimeoutId++,
          delay,
          handler,
          cleared: false
        };
        timeouts.push(timeout);
        return timeout.id;
      },
      clearTimeout(timeoutId: ReturnType<typeof globalThis.setTimeout> | number) {
        if (typeof timeoutId !== "number") {
          return;
        }

        const timeout = timeouts.find((entry) => entry.id === timeoutId);
        if (timeout) {
          timeout.cleared = true;
        }
      }
    },
    runTimeout(delay: number) {
      const timeout = timeouts.find((entry) => entry.delay === delay && !entry.cleared);
      if (!timeout) {
        throw new Error(`No active timeout registered for ${delay}ms`);
      }

      timeout.cleared = true;
      timeout.handler();
    }
  };
}

describe("HardessClient", () => {
  it("sends auth on open and heartbeat on interval", () => {
    let socket: FakeSocket | undefined;
    let intervalHandler: (() => void) | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      heartbeatIntervalMs: 1000,
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval(handler) {
          intervalHandler = handler as () => void;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    const authEnvelope = parseEnvelope(socket?.sent[0] ?? "");
    expect(authEnvelope?.action).toBe("auth");

    intervalHandler?.();
    const pingEnvelope = parseEnvelope(socket?.sent[1] ?? "");
    expect(pingEnvelope?.action).toBe("ping");
  });

  it("sends bearer auth payload without client-selected group", () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    const authEnvelope = parseEnvelope(socket?.sent[0] ?? "");
    expect(authEnvelope?.payload).toEqual({
      provider: "bearer",
      payload: "demo:alice"
    });
  });

  it("auto-sends handleAck after inbound biz message", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      heartbeatIntervalMs: 1000,
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.use({
      protocol: "demo",
      version: "1.0",
      inbound: {
        actions: {
          async send() {}
        }
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "biz",
          src: { peerId: "bob", connId: "conn-bob" },
          protocol: "demo",
          version: "1.0",
          action: "send",
          payload: {
            toPeerId: "alice",
            content: "hello"
          }
        })
      )
    });

    await Promise.resolve();
    const handleAckEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    expect(handleAckEnvelope?.action).toBe("handleAck");
  });

  it("responds to server ping with pong", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      heartbeatIntervalMs: 1000,
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "ping",
          payload: {
            nonce: "n-1"
          }
        })
      )
    });

    const pongEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    expect(pongEnvelope?.action).toBe("pong");
    expect((pongEnvelope?.payload as { nonce?: string } | undefined)?.nonce).toBe("n-1");
  });

  it("forwards close and transport error details to client handlers", () => {
    let socket: FakeSocket | undefined;
    let closeInfo:
      | { code?: number; reason?: string; wasClean?: boolean }
      | undefined;
    let transportError:
      | { message?: string }
      | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onClose(info) {
          closeInfo = info;
        },
        onTransportError(info) {
          transportError = info;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    socket?.emit("error", { message: "socket failure" });
    socket?.emit("close", {
      code: 4508,
      reason: "BACKPRESSURE_OVERFLOW",
      wasClean: false
    });

    expect(transportError).toEqual({
      message: "socket failure"
    });
    expect(closeInfo).toEqual({
      code: 4508,
      reason: "BACKPRESSURE_OVERFLOW",
      wasClean: false
    });
  });

  it("reports malformed system payloads through the protocol error handler", () => {
    let socket: FakeSocket | undefined;
    let protocolError:
      | {
          layer: "envelope" | "system" | "business";
          message: string;
          protocol?: string;
          version?: string;
          action?: string;
          msgId?: string;
          traceId?: string;
        }
      | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onProtocolError(info) {
          protocolError = info;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          payload: {
            acceptedAt: Date.now()
          }
        })
      )
    });

    expect(protocolError).toEqual({
      layer: "system",
      message: "Invalid sys.recvAck payload",
      protocol: "sys",
      version: "1.0",
      action: "recvAck",
      msgId: expect.any(String),
      traceId: undefined
    });
  });

  it("reports malformed envelopes through the protocol error handler", () => {
    let socket: FakeSocket | undefined;
    let protocolError:
      | {
          layer: "envelope" | "system" | "business";
          message: string;
        }
      | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onProtocolError(info) {
          protocolError = info;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    socket?.emit("message", {
      data: "{not-json"
    });

    expect(protocolError).toEqual({
      layer: "envelope",
      message: "Invalid websocket envelope"
    });
  });

  it("reports business handler failures through the protocol error handler", async () => {
    let socket: FakeSocket | undefined;
    let protocolError:
      | {
          layer: "envelope" | "system" | "business";
          message: string;
          protocol?: string;
          version?: string;
          action?: string;
          msgId?: string;
          traceId?: string;
        }
      | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      heartbeatIntervalMs: 1000,
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onProtocolError(info) {
          protocolError = info;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.use({
      protocol: "demo",
      version: "1.0",
      inbound: {
        actions: {
          async send() {
            throw new Error("business handler failed");
          }
        }
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "biz",
          src: { peerId: "bob", connId: "conn-bob" },
          protocol: "demo",
          version: "1.0",
          action: "send",
          payload: {
            toPeerId: "alice",
            content: "hello"
          }
        })
      )
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(protocolError).toEqual({
      layer: "business",
      message: "business handler failed",
      protocol: "demo",
      version: "1.0",
      action: "send",
      msgId: expect.any(String),
      traceId: undefined
    });
  });

  it("emits global delivery events for route, recvAck, and handleAck", () => {
    let socket: FakeSocket | undefined;
    const events: Array<{
      stage: string;
      msgId: string;
    }> = [];

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onDeliveryEvent(event) {
          events.push({
            stage: event.stage,
            msgId: event.msgId
          });
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "route",
          traceId: tracker.msgId,
          payload: {
            resolvedPeers: ["bob"],
            deliveredConns: [
              {
                nodeId: "local",
                connId: "conn-bob",
                peerId: "bob"
              }
            ]
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            handledAt: Date.now()
          }
        })
      )
    });

    expect(events).toEqual([
      { stage: "route", msgId: tracker.msgId },
      { stage: "recvAck", msgId: tracker.msgId },
      { stage: "handleAck", msgId: tracker.msgId }
    ]);
  });

  it("allows waiting for per-message delivery stages", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const recvAckPromise = tracker.waitForRecvAck();
    const handleAckPromise = tracker.waitForHandleAck();

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            handledAt: Date.now()
          }
        })
      )
    });

    await expect(recvAckPromise).resolves.toMatchObject({
      stage: "recvAck",
      msgId: tracker.msgId
    });
    await expect(handleAckPromise).resolves.toMatchObject({
      stage: "handleAck",
      msgId: tracker.msgId
    });
  });

  it("rejects pending per-message waits when sys.err arrives", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const handleAckPromise = tracker.waitForHandleAck();

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "err",
          traceId: tracker.msgId,
          payload: {
            code: "ROUTE_NO_RECIPIENT",
            message: "No recipients resolved",
            retryable: false,
            refMsgId: tracker.msgId
          }
        })
      )
    });

    await expect(handleAckPromise).rejects.toMatchObject({
      code: ERROR_CODES.ROUTE_NO_RECIPIENT,
      source: "remote",
      retryable: false,
      message: "No recipients resolved"
    } satisfies Partial<HardessSdkErrorShape>);
  });

  it("fails pending tracked sends immediately when the transport closes", async () => {
    let socket: FakeSocket | undefined;
    const events: Array<{
      stage: string;
      code?: number;
      reason?: string;
      protocol?: string;
      action?: string;
    }> = [];

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onDeliveryEvent(event) {
          events.push({
            stage: event.stage,
            code: event.close?.code,
            reason: event.close?.reason,
            protocol: event.protocol,
            action: event.action
          });
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const handleAckPromise = tracker.waitForHandleAck();

    socket?.emit("close", {
      code: 1001,
      reason: "server shutting down",
      wasClean: true
    });

    await expect(handleAckPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
      source: "client",
      retryable: true,
      message: "Transport closed before delivery completed (code 1001, reason server shutting down)"
    } satisfies Partial<HardessSdkErrorShape>);
    expect(events).toEqual([
      {
        stage: "transportClosed",
        code: 1001,
        reason: "server shutting down",
        protocol: "demo",
        action: "send"
      }
    ]);
  });

  it("keeps recvAck settled when transport closes before handleAck", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });

    const recvAckPromise = tracker.waitForRecvAck();
    const handleAckPromise = tracker.waitForHandleAck();

    socket?.emit("close", {
      code: 1001,
      reason: "server shutting down",
      wasClean: true
    });

    await expect(recvAckPromise).resolves.toMatchObject({
      stage: "recvAck",
      msgId: tracker.msgId
    });
    await expect(handleAckPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
      source: "client",
      retryable: true,
      message: "Transport closed before delivery completed (code 1001, reason server shutting down)"
    } satisfies Partial<HardessSdkErrorShape>);
  });

  it("fails waitForResult when the transport closes before handleAck", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const resultPromise = tracker.waitForResult();

    socket?.emit("close", {
      code: 1001,
      reason: "server shutting down",
      wasClean: true
    });

    await expect(resultPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
      source: "client",
      retryable: true,
      message: "Transport closed before delivery completed (code 1001, reason server shutting down)"
    } satisfies Partial<HardessSdkErrorShape>);
  });

  it("emits timeout stages and rejects tracked waits when delivery exceeds policy", async () => {
    let socket: FakeSocket | undefined;
    const manualTimers = createManualTimers();
    const events: Array<{
      stage: string;
      protocol?: string;
      action?: string;
      timeoutStage?: string;
    }> = [];

    const client = new HardessClient("ws://localhost/ws", {
      deliveryTimeoutMs: {
        recvAckMs: 5,
        handleAckMs: 10
      },
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onDeliveryEvent(event) {
          events.push({
            stage: event.stage,
            protocol: event.protocol,
            action: event.action,
            timeoutStage: event.timeout?.stage
          });
        }
      },
      timers: manualTimers.timers
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }

    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const recvAckPromise = tracker.waitForRecvAck();
    const handleAckPromise = tracker.waitForHandleAck();

    manualTimers.runTimeout(5);
    await expect(recvAckPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_DELIVERY_TIMEOUT,
      source: "client",
      retryable: true,
      message: "Timed out waiting for recvAck after 5ms"
    } satisfies Partial<HardessSdkErrorShape>);

    manualTimers.runTimeout(10);
    await expect(handleAckPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_DELIVERY_TIMEOUT,
      source: "client",
      retryable: true,
      message: "Timed out waiting for handleAck after 10ms"
    } satisfies Partial<HardessSdkErrorShape>);

    expect(events).toEqual([
      {
        stage: "recvAckTimeout",
        protocol: "demo",
        action: "send",
        timeoutStage: "recvAck"
      },
      {
        stage: "handleAckTimeout",
        protocol: "demo",
        action: "send",
        timeoutStage: "handleAck"
      }
    ]);
  });

  it("keeps global delivery tracking for fire-and-forget emit", () => {
    let socket: FakeSocket | undefined;
    const manualTimers = createManualTimers();
    const events: Array<{
      stage: string;
      protocol?: string;
      action?: string;
    }> = [];

    const client = new HardessClient("ws://localhost/ws", {
      deliveryTimeoutMs: {
        recvAckMs: 5,
        handleAckMs: 10
      },
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      systemHandlers: {
        onDeliveryEvent(event) {
          events.push({
            stage: event.stage,
            protocol: event.protocol,
            action: event.action
          });
        }
      },
      timers: manualTimers.timers
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    client.emit({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    manualTimers.runTimeout(5);

    expect(events).toEqual([
      {
        stage: "recvAckTimeout",
        protocol: "demo",
        action: "send"
      }
    ]);
  });

  it("resolves tracked waits immediately when the stage already happened", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            handledAt: Date.now()
          }
        })
      )
    });

    await expect(tracker.waitForRecvAck()).resolves.toMatchObject({
      stage: "recvAck",
      protocol: "demo",
      action: "send",
      msgId: tracker.msgId
    });
    await expect(tracker.waitForHandleAck()).resolves.toMatchObject({
      stage: "handleAck",
      protocol: "demo",
      action: "send",
      msgId: tracker.msgId
    });
  });

  it("provides a high-level waitForResult convenience on tracked sends", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const resultPromise = tracker.waitForResult();

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            handledAt: Date.now()
          }
        })
      )
    });

    await expect(resultPromise).resolves.toMatchObject({
      stage: "handleAck",
      protocol: "demo",
      action: "send",
      msgId: tracker.msgId
    });
  });

  it("allows waitForResult to stop at recvAck when requested", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const resultPromise = tracker.waitForResult({
      until: "recvAck"
    });

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: tracker.msgId,
          payload: {
            ackFor: tracker.msgId,
            acceptedAt: Date.now()
          }
        })
      )
    });

    await expect(resultPromise).resolves.toMatchObject({
      stage: "recvAck",
      protocol: "demo",
      action: "send",
      msgId: tracker.msgId
    });
  });

  it("fails fast in waitForResult when recvAck times out before handleAck", async () => {
    let socket: FakeSocket | undefined;
    const manualTimers = createManualTimers();

    const client = new HardessClient("ws://localhost/ws", {
      deliveryTimeoutMs: {
        recvAckMs: 5,
        handleAckMs: 10
      },
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: manualTimers.timers
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }
    const tracker = client.emitTracked({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const resultPromise = tracker.waitForResult();

    manualTimers.runTimeout(5);

    await expect(resultPromise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.CLIENT_DELIVERY_TIMEOUT,
      source: "client",
      retryable: true,
      message: "Timed out waiting for recvAck after 5ms"
    } satisfies Partial<HardessSdkErrorShape>);
  });

  it("provides a high-level client.send convenience", async () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    if (socket) {
      emitAuthOk(socket);
    }

    const resultPromise = client.send({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const outbound = parseEnvelope(socket?.sent.at(-1) ?? "");
    const outboundMsgId = outbound?.msgId;
    expect(outbound?.action).toBe("send");
    expect(outboundMsgId).toEqual(expect.any(String));

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "recvAck",
          traceId: outboundMsgId,
          payload: {
            ackFor: outboundMsgId,
            acceptedAt: Date.now()
          }
        })
      )
    });
    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId: outboundMsgId,
          payload: {
            ackFor: outboundMsgId,
            handledAt: Date.now()
          }
        })
      )
    });

    await expect(resultPromise).resolves.toMatchObject({
      stage: "handleAck",
      protocol: "demo",
      action: "send",
      msgId: outboundMsgId
    });
  });

  it("fails fast when sending before auth.ok", () => {
    let socket: FakeSocket | undefined;

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: { enabled: false },
        webSocketFactory() {
          socket = new FakeSocket();
          return socket;
        }
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {}
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    expect(() =>
      client.emitTracked({
        protocol: "demo",
        version: "1.0",
        action: "send",
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      })
    ).toThrow("Client is not ready; wait for auth.ok before sending (state: authenticating)");

    try {
      client.emitTracked({
        protocol: "demo",
        version: "1.0",
        action: "send",
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: CLIENT_ERROR_CODES.CLIENT_NOT_READY,
        source: "client",
        retryable: true
      } satisfies Partial<HardessSdkErrorShape>);
    }
  });

  it("waitUntilReady resolves on auth.ok and tracks readiness across reconnects", async () => {
    const sockets: FakeSocket[] = [];
    const reconnectTimers: Array<() => void> = [];

    const client = new HardessClient("ws://localhost/ws", {
      transport: {
        reconnect: {
          enabled: true,
          initialDelayMs: 5,
          maxDelayMs: 5
        },
        webSocketFactory() {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        setTimeoutFn(handler) {
          reconnectTimers.push(handler as () => void);
          return reconnectTimers.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeoutFn() {}
      },
      timers: {
        setInterval() {
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
        setTimeout(handler, delay) {
          reconnectTimers.push(handler as () => void);
          return reconnectTimers.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout() {}
      }
    });

    client.connect("demo:alice");
    expect(client.isReady()).toBe(false);

    const firstReadyPromise = client.waitUntilReady();
    sockets[0]?.emit("open");
    emitAuthOk(sockets[0] as FakeSocket);
    await expect(firstReadyPromise).resolves.toBeUndefined();
    expect(client.isReady()).toBe(true);

    sockets[0]?.emit("close", {
      code: 1001,
      reason: "server shutting down",
      wasClean: true
    });
    expect(client.isReady()).toBe(false);

    const secondReadyPromise = client.waitUntilReady();
    reconnectTimers.shift()?.();
    sockets[1]?.emit("open");
    emitAuthOk(sockets[1] as FakeSocket);
    await expect(secondReadyPromise).resolves.toBeUndefined();
    expect(client.isReady()).toBe(true);
  });
});
