import { createEnvelope, parseEnvelope, serializeEnvelope } from "../shared/envelope.ts";
import {
  parseSysAuthPayload,
  parseSysHandleAckPayload,
  type Envelope
} from "../shared/index.ts";

interface MetricsSnapshot {
  counters?: Record<string, number>;
  timings?: Record<string, number[]>;
  timingCounts?: Record<string, number>;
}

declare const Bun: {
  serve(options: {
    port: number;
    fetch(
      request: Request,
      server: {
        upgrade(
          request: Request,
          options?: {
            data?: unknown;
          }
        ): boolean;
      }
    ): Response | Promise<Response> | undefined;
    websocket: {
      open(socket: NativeBaselineSocket): void;
      message(socket: NativeBaselineSocket, message: string | ArrayBuffer | Uint8Array): void;
      close(socket: NativeBaselineSocket, code?: number, reason?: string): void;
    };
  }): {
    port: number;
  };
};

interface SocketData {
  connId: string;
  peerId?: string;
}

interface NativeBaselineSocket {
  data: SocketData;
  send(data: string | ArrayBuffer | Uint8Array): number | void;
  close(code?: number, reason?: string): void;
}

interface PendingDelivery {
  senderPeerId: string;
  senderConnId: string;
  senderSocket: NativeBaselineSocket;
  traceId?: string;
}

const socketsByPeerId = new Map<string, NativeBaselineSocket>();
const pendingByMsgId = new Map<string, PendingDelivery>();
const counters: Record<string, number> = {};

function incCounter(name: string, value = 1): void {
  counters[name] = (counters[name] ?? 0) + value;
}

function metricsSnapshot(): MetricsSnapshot {
  return {
    counters: { ...counters },
    timings: {},
    timingCounts: {}
  };
}

function sendEnvelope(socket: NativeBaselineSocket, envelope: Envelope<unknown>): void {
  socket.send(serializeEnvelope(envelope));
}

function sendAuthOk(socket: NativeBaselineSocket, peerId: string, traceId?: string): void {
  sendEnvelope(
    socket,
    createEnvelope({
      kind: "system",
      src: {
        peerId: "bun.native",
        connId: socket.data.connId
      },
      protocol: "sys",
      version: "1.0",
      action: "auth.ok",
      traceId,
      payload: {
        peerId,
        capabilities: [],
        expiresAt: Date.now() + 60_000
      }
    })
  );
}

function sendRecvAck(socket: NativeBaselineSocket, ackFor: string, traceId?: string): void {
  sendEnvelope(
    socket,
    createEnvelope({
      kind: "system",
      src: {
        peerId: "bun.native",
        connId: socket.data.connId
      },
      protocol: "sys",
      version: "1.0",
      action: "recvAck",
      traceId,
      payload: {
        ackFor,
        acceptedAt: Date.now()
      }
    })
  );
}

function sendHandleAck(socket: NativeBaselineSocket, ackFor: string, traceId?: string): void {
  sendEnvelope(
    socket,
    createEnvelope({
      kind: "system",
      src: {
        peerId: "bun.native",
        connId: socket.data.connId
      },
      protocol: "sys",
      version: "1.0",
      action: "handleAck",
      traceId,
      payload: {
        ackFor,
        handledAt: Date.now()
      }
    })
  );
}

function sendRoute(
  socket: NativeBaselineSocket,
  target: NativeBaselineSocket,
  targetPeerId: string,
  traceId?: string
): void {
  sendEnvelope(
    socket,
    createEnvelope({
      kind: "system",
      src: {
        peerId: "bun.native",
        connId: socket.data.connId
      },
      protocol: "sys",
      version: "1.0",
      action: "route",
      traceId,
      payload: {
        resolvedPeers: [targetPeerId],
        deliveredConns: [
          {
            nodeId: "bun-native",
            connId: target.data.connId,
            peerId: targetPeerId
          }
        ]
      }
    })
  );
}

function sendError(socket: NativeBaselineSocket, code: string, message: string, traceId?: string, refMsgId?: string): void {
  sendEnvelope(
    socket,
    createEnvelope({
      kind: "system",
      src: {
        peerId: "bun.native",
        connId: socket.data.connId
      },
      protocol: "sys",
      version: "1.0",
      action: "err",
      traceId,
      payload: {
        code,
        message,
        retryable: false,
        refMsgId,
        traceId
      }
    })
  );
}

function normalizeRawMessage(raw: string | ArrayBuffer | Uint8Array): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }
  return new TextDecoder().decode(raw);
}

const server = Bun.serve({
  port: Number(process.env.WS_NATIVE_BASELINE_PORT ?? 9100),
  fetch(request, serverRef) {
    const url = new URL(request.url);

    if (url.pathname === "/__admin/metrics") {
      return Response.json({
        ok: true,
        metrics: metricsSnapshot()
      });
    }

    if (url.pathname === "/__admin/health" || url.pathname === "/__admin/ready") {
      return Response.json({
        ok: true,
        status: "ok"
      });
    }

    if (url.pathname === "/ws") {
      const upgraded = serverRef.upgrade(request, {
        data: {
          connId: crypto.randomUUID()
        } satisfies SocketData
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("WebSocket upgrade failed", { status: 426 });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(socket) {
      incCounter("ws.open");
    },
    message(socket, raw) {
      const envelope = parseEnvelope(normalizeRawMessage(raw));
      if (!envelope) {
        incCounter("ws.invalid_envelope");
        socket.close(4400, "invalid envelope");
        return;
      }

      if (envelope.kind === "system") {
        if (envelope.action === "auth") {
          const payload = parseSysAuthPayload(envelope.payload);
          if (payload.provider !== "bearer" || typeof payload.payload !== "string" || !payload.payload.startsWith("demo:")) {
            incCounter("ws.auth_invalid");
            sendError(socket, "AUTH_INVALID_TOKEN", "Invalid bearer token", envelope.traceId, envelope.msgId);
            socket.close(4401, "invalid token");
            return;
          }

          socket.data.peerId = payload.payload.slice("demo:".length);
          socketsByPeerId.set(socket.data.peerId, socket);
          incCounter("ws.auth_ok");
          sendAuthOk(socket, socket.data.peerId, envelope.traceId);
          return;
        }

        if (!socket.data.peerId) {
          incCounter("ws.auth_missing");
          socket.close(4401, "not authenticated");
          return;
        }

        if (envelope.action === "handleAck") {
          const payload = parseSysHandleAckPayload(envelope.payload);
          const pending = pendingByMsgId.get(payload.ackFor);
          if (!pending) {
            return;
          }
          pendingByMsgId.delete(payload.ackFor);
          incCounter("ws.handle_ack");
          sendHandleAck(pending.senderSocket, payload.ackFor, pending.traceId);
          return;
        }

        if (envelope.action === "pong") {
          incCounter("ws.pong");
          return;
        }

        return;
      }

      if (!socket.data.peerId) {
        incCounter("ws.auth_missing");
        socket.close(4401, "not authenticated");
        return;
      }

      if (envelope.action !== "send") {
        incCounter("ws.unsupported_action");
        sendError(socket, "PROTO_ACTION_UNKNOWN", `Unsupported action: ${envelope.action}`, envelope.traceId, envelope.msgId);
        return;
      }

      const payload = envelope.payload as {
        toPeerId?: string;
        content?: string;
      };
      const targetPeerId = payload.toPeerId;
      if (!targetPeerId) {
        incCounter("ws.route_miss");
        sendError(socket, "ROUTE_NO_RECIPIENT", "Missing toPeerId", envelope.traceId, envelope.msgId);
        return;
      }

      const target = socketsByPeerId.get(targetPeerId);
      if (!target) {
        incCounter("ws.route_miss");
        sendError(socket, "ROUTE_NO_RECIPIENT", `No recipient for ${targetPeerId}`, envelope.traceId, envelope.msgId);
        return;
      }

      pendingByMsgId.set(envelope.msgId, {
        senderPeerId: socket.data.peerId,
        senderConnId: socket.data.connId,
        senderSocket: socket,
        traceId: envelope.traceId
      });

      sendRoute(socket, target, targetPeerId, envelope.traceId);
      sendRecvAck(socket, envelope.msgId, envelope.traceId);
      sendEnvelope(
        target,
        createEnvelope({
          msgId: envelope.msgId,
          kind: "biz",
          src: {
            peerId: socket.data.peerId,
            connId: socket.data.connId
          },
          protocol: envelope.protocol,
          version: envelope.version,
          action: "message",
          traceId: envelope.traceId,
          payload: {
            fromPeerId: socket.data.peerId,
            content: payload.content ?? ""
          }
        })
      );
      incCounter("ws.deliver_ok");
    },
    close(socket) {
      incCounter("ws.close");
      if (socket.data.peerId) {
        const current = socketsByPeerId.get(socket.data.peerId);
        if (current === socket) {
          socketsByPeerId.delete(socket.data.peerId);
        }
      }

      for (const [msgId, pending] of pendingByMsgId.entries()) {
        if (pending.senderSocket === socket) {
          pendingByMsgId.delete(msgId);
        }
      }
    }
  }
});

console.log(`bun native ws baseline listening on :${server.port}`);
