import { describe, expect, it } from "bun:test";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { HardessClient } from "./client.ts";
import type { WebSocketLike } from "../transport/ws.ts";

class FakeSocket implements WebSocketLike {
  private listeners = new Map<string, Array<(event?: { data?: unknown }) => void>>();
  sent: string[] = [];

  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (event?: { data?: unknown }) => void
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

  emit(type: "open" | "close" | "message" | "error", event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
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
});
