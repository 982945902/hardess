import { describe, expect, it } from "bun:test";
import { WebSocketTransport, type WebSocketLike } from "./ws.ts";

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

describe("WebSocketTransport", () => {
  it("does not reconnect by default", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const transport = new WebSocketTransport({
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn(handler) {
        timers.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn() {}
    });

    transport.connect("ws://localhost/ws");
    sockets[0]?.emit("open");
    sockets[0]?.emit("close", {
      code: 1006,
      reason: "abnormal",
      wasClean: false
    });

    expect(timers).toHaveLength(0);
  });

  it("reconnects after close when enabled", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const transport = new WebSocketTransport({
      reconnect: {
        enabled: true,
        initialDelayMs: 10,
        maxDelayMs: 20
      },
      webSocketFactory(url) {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn(handler) {
        timers.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn() {}
    });

    let opened = 0;
    transport.connect("ws://localhost/ws", {
      onOpen: () => {
        opened += 1;
      }
    });

    sockets[0]?.emit("open");
    expect(opened).toBe(1);

    sockets[0]?.emit("close");
    expect(timers).toHaveLength(1);

    timers[0]?.();
    sockets[1]?.emit("open");
    expect(opened).toBe(2);
  });

  it("does not reconnect on terminal server close codes", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const transport = new WebSocketTransport({
      reconnect: {
        enabled: true,
        initialDelayMs: 10,
        maxDelayMs: 20
      },
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn(handler) {
        timers.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn() {}
    });

    transport.connect("ws://localhost/ws");
    sockets[0]?.emit("open");
    sockets[0]?.emit("close", {
      code: 4401,
      reason: "AUTH_INVALID_TOKEN",
      wasClean: true
    });

    expect(timers).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it("throws when sending without an active socket", () => {
    const transport = new WebSocketTransport({
      reconnect: {
        enabled: false
      }
    });

    expect(() => transport.send("hello")).toThrow("WebSocket is not connected");
  });
});
