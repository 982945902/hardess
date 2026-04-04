import { describe, expect, it } from "bun:test";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { ROUTE_FAILURE_STAGES } from "../../shared/codes.ts";
import { HardessClient } from "./client.ts";
import type { WebSocketLike } from "../transport/ws.ts";

class FakeSocket implements WebSocketLike {
  private listeners = new Map<string, Array<(event?: { data?: unknown; code?: number; reason?: string; wasClean?: boolean; message?: string }) => void>>();
  sent: string[] = [];

  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (event?: { data?: unknown; code?: number; reason?: string; wasClean?: boolean; message?: string }) => void
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

  emit(
    type: "open" | "close" | "message" | "error",
    event?: { data?: unknown; code?: number; reason?: string; wasClean?: boolean; message?: string }
  ): void {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
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

  it("does not send sdk-level ack frames for inbound business messages", async () => {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
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
    const sentBeforeInbound = socket?.sent.length ?? 0;
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
    expect(socket?.sent.length).toBe(sentBeforeInbound);
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
        clearInterval() {},
        setTimeout,
        clearTimeout
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
        clearInterval() {},
        setTimeout,
        clearTimeout
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

  it("emitAndWait resolves after sys.result", async () => {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    const pending = client.emitAndWait(
      {
        protocol: "demo",
        version: "1.0",
        action: "send",
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      },
      {
        ack: "recv",
        resultTimeoutMs: 100
      }
    );

    const outboundEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    const msgId = outboundEnvelope?.msgId ?? "";

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "result",
          payload: {
            refMsgId: msgId,
            resolvedPeers: ["bob"],
            failed: [],
            partialFailure: false,
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

    await expect(pending).resolves.toMatchObject({
      msgId,
      result: {
        refMsgId: msgId
      }
    });
  });

  it("emitAndWait rejects when sys.err references the message", async () => {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    const pending = client.emitAndWait(
      {
        protocol: "demo",
        version: "1.0",
        action: "send",
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      },
      {
        ack: "recv",
        resultTimeoutMs: 100
      }
    );

    const outboundEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    const msgId = outboundEnvelope?.msgId ?? "";

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "err",
          payload: {
            code: "ROUTE_PEER_OFFLINE",
            message: "peer offline",
            retryable: false,
            refMsgId: msgId
          }
        })
      )
    });

    await expect(pending).rejects.toMatchObject({
      message: "peer offline",
      code: "ROUTE_PEER_OFFLINE",
      refMsgId: msgId
    });
  });

  it("emitAndWait exposes partial route failures to the caller", async () => {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");

    const pending = client.emitAndWait(
      {
        protocol: "demo",
        version: "1.0",
        action: "send",
        payload: {
          toPeerId: "bob",
          content: "hello"
        }
      },
      {
        ack: "recv",
        resultTimeoutMs: 100
      }
    );

    const outboundEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    const msgId = outboundEnvelope?.msgId ?? "";

    socket?.emit("message", {
      data: serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "hardess.system", connId: "system" },
          protocol: "sys",
          version: "1.0",
          action: "result",
          payload: {
            refMsgId: msgId,
            resolvedPeers: ["bob", "charlie"],
            deliveredConns: [
              {
                nodeId: "local",
                connId: "conn-bob",
                peerId: "bob"
              }
            ],
            failed: [
              {
                peerId: "charlie",
                stage: ROUTE_FAILURE_STAGES.RESOLVE,
                code: "ROUTE_PEER_OFFLINE",
                message: "Peer charlie is offline",
                retryable: false
              }
            ],
            partialFailure: true
          }
        })
      )
    });

    await expect(pending).resolves.toMatchObject({
      msgId,
      result: {
        partialFailure: true,
        failed: [
          {
            peerId: "charlie",
            code: "ROUTE_PEER_OFFLINE"
          }
        ]
      }
    });
  });

  it("emit defaults to fire-and-forget ack mode", () => {
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
        clearInterval() {},
        setTimeout,
        clearTimeout
      }
    });

    client.connect("demo:alice");
    socket?.emit("open");
    client.emit({
      protocol: "demo",
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: "bob",
        content: "hello"
      }
    });

    const outboundEnvelope = parseEnvelope(socket?.sent.at(-1) ?? "");
    expect(outboundEnvelope?.ack).toBe("none");
  });
});
