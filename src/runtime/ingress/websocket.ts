import {
  ERROR_CODES,
  HardessError,
  type AckMode,
  type AuthContext,
  type Envelope,
  type SysResultPayload,
  type SysAuthPayload
} from "../../shared/index.ts";
import type { AuthService } from "../auth/service.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";
import { Dispatcher } from "../routing/dispatcher.ts";
import { DispatchFailureCollector } from "../routing/failure-collector.ts";
import { InMemoryPeerLocator } from "../routing/peer-locator.ts";
import { parseEnvelope, serializeEnvelope } from "../protocol/envelope.ts";
import { ServerProtocolRegistry } from "../protocol/registry.ts";
import {
  createAuthOkEnvelope,
  createPingEnvelope,
  createPongEnvelope,
  createResultEnvelope,
  createSysErrEnvelope,
  ensureAuthenticated
} from "../protocol/system-handlers.ts";

interface ConnectionState {
  socket: {
    data: {
      connId: string;
    };
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
  auth?: AuthContext;
  lastSeenAt: number;
  lastPingAt?: number;
  messageTimestamps: number[];
  outboundQueue: Array<{ data: string; bytes: number }>;
  outboundQueuedBytes: number;
  drainScheduled: boolean;
  closed: boolean;
}

export interface WebSocketRuntimeDeps {
  nodeId: string;
  authService: AuthService;
  peerLocator: InMemoryPeerLocator;
  dispatcher: Dispatcher;
  registry: ServerProtocolRegistry;
  logger: Logger;
  metrics?: Metrics;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  maxConnections?: number;
  maxConnectionsPerPeer?: number;
  rateLimit?: {
    windowMs: number;
    maxMessages: number;
  };
  outbound?: {
    maxQueueMessages: number;
    maxQueueBytes: number;
  };
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  queueMicrotaskFn?: (callback: VoidFunction) => void;
}

function messageToString(raw: string | ArrayBuffer | Uint8Array): string {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw));
  }

  return new TextDecoder().decode(raw);
}

export function createWebSocketHandlers(deps: WebSocketRuntimeDeps) {
  const connections = new Map<string, ConnectionState>();
  const now = deps.now ?? (() => Date.now());
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 25_000;
  const staleAfterMs = deps.staleAfterMs ?? 60_000;
  const metrics = deps.metrics ?? new NoopMetrics();
  const rateLimitWindowMs = deps.rateLimit?.windowMs ?? 1_000;
  const rateLimitMaxMessages = deps.rateLimit?.maxMessages ?? 100;
  const outboundMaxQueueMessages = deps.outbound?.maxQueueMessages ?? 256;
  const outboundMaxQueueBytes = deps.outbound?.maxQueueBytes ?? 512 * 1024;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const queueMicrotaskFn = deps.queueMicrotaskFn ?? queueMicrotask;

  function closeCodeForError(error: HardessError): number | undefined {
    switch (error.code) {
      case ERROR_CODES.AUTH_INVALID_TOKEN:
      case ERROR_CODES.AUTH_EXPIRED_TOKEN:
      case ERROR_CODES.AUTH_REVOKED_TOKEN:
        return 4401;
      case ERROR_CODES.ACL_DENIED:
        return 4403;
      case ERROR_CODES.CONN_QUOTA_EXCEEDED:
      case ERROR_CODES.RATE_LIMIT_EXCEEDED:
        return 4429;
      case ERROR_CODES.BACKPRESSURE_OVERFLOW:
        return 4508;
      case ERROR_CODES.PROTO_INVALID_PAYLOAD:
        return 4400;
      default:
        return undefined;
    }
  }

  function closeConnection(
    connection: ConnectionState,
    code?: number,
    reason?: string
  ): void {
    if (connection.closed) {
      return;
    }

    connection.closed = true;
    connection.socket.close(code, reason);
  }

  function drainOutboundQueue(connection: ConnectionState): void {
    connection.drainScheduled = false;

    while (!connection.closed && connection.outboundQueue.length > 0) {
      const next = connection.outboundQueue.shift();
      if (!next) {
        break;
      }

      connection.outboundQueuedBytes -= next.bytes;

      try {
        connection.socket.send(next.data);
        metrics.increment("ws.message_out");
      } catch (error) {
        metrics.increment("ws.egress_error");
        const normalized = new HardessError(
          ERROR_CODES.BACKPRESSURE_OVERFLOW,
          "WebSocket outbound send failed",
          {
            detail: error instanceof Error ? error.message : String(error),
            cause: error
          }
        );
        closeConnection(connection, closeCodeForError(normalized), normalized.code);
        break;
      }
    }
  }

  function scheduleDrain(connection: ConnectionState): void {
    if (connection.drainScheduled || connection.closed) {
      return;
    }

    connection.drainScheduled = true;
    queueMicrotaskFn(() => {
      drainOutboundQueue(connection);
    });
  }

  function enqueueOutbound(connection: ConnectionState, data: string): void {
    if (connection.closed) {
      return;
    }

    const bytes = new TextEncoder().encode(data).byteLength;
    if (
      connection.outboundQueue.length + 1 > outboundMaxQueueMessages ||
      connection.outboundQueuedBytes + bytes > outboundMaxQueueBytes
    ) {
      metrics.increment("ws.egress_overflow");
      const error = new HardessError(
        ERROR_CODES.BACKPRESSURE_OVERFLOW,
        "WebSocket outbound queue overflow"
      );
      closeConnection(connection, closeCodeForError(error), error.code);
      throw error;
    }

    connection.outboundQueue.push({ data, bytes });
    connection.outboundQueuedBytes += bytes;
    scheduleDrain(connection);
  }

  const heartbeatTimer = setIntervalFn(() => {
    void tickHeartbeat();
  }, heartbeatIntervalMs);

  async function tickHeartbeat(): Promise<void> {
    const currentTime = now();

    for (const connection of connections.values()) {
      if (currentTime - connection.lastSeenAt > staleAfterMs) {
        metrics.increment("ws.heartbeat_timeout");
        connection.socket.close(4408, "heartbeat timeout");
        continue;
      }

      if (
        connection.auth &&
        currentTime - connection.lastSeenAt >= heartbeatIntervalMs &&
        (!connection.lastPingAt || currentTime - connection.lastPingAt >= heartbeatIntervalMs)
      ) {
        connection.lastPingAt = currentTime;
        enqueueOutbound(
          connection,
          serializeEnvelope(
            createPingEnvelope(connection.socket.data.connId, crypto.randomUUID())
          )
        );
      }
    }
  }

  async function sendToPeerIds(
    sender: ConnectionState,
    envelope: Envelope<unknown>,
    peerIds: string[],
    ack: AckMode = "recv"
  ): Promise<void> {
    const uniquePeerIds = Array.from(new Set(peerIds));
    const located = await deps.peerLocator.findMany(uniquePeerIds);
    const plan = await deps.dispatcher.buildPlan(uniquePeerIds, {
      streamId: envelope.streamId,
      ack
    });
    const collector = new DispatchFailureCollector(uniquePeerIds);

    for (const peerId of uniquePeerIds) {
      const targets = located.get(peerId) ?? [];
      if (targets.length === 0) {
        collector.recordResolveFailure(peerId);
      }
    }

    for (const target of plan.targets) {
      const connection = connections.get(target.connId);
      if (!connection?.auth) {
        collector.recordResolveFailure(target.peerId);
        continue;
      }

      if (!(await deps.authService.isAuthContextValid(connection.auth))) {
        collector.recordAuthFailure(
          target,
          ERROR_CODES.AUTH_REVOKED_TOKEN,
          "Target authentication is no longer valid"
        );
        continue;
      }

      try {
        enqueueOutbound(
          connection,
          serializeEnvelope({
            ...envelope,
            src: {
              peerId: sender.auth?.peerId ?? envelope.src.peerId,
              connId: sender.socket.data.connId
            }
          })
        );
        collector.recordDelivered(target);
      } catch (error) {
        const normalized = error instanceof HardessError
          ? error
          : new HardessError(ERROR_CODES.INTERNAL_ERROR, "Outbound delivery failed", {
              detail: error instanceof Error ? error.message : String(error),
              cause: error
            });
        collector.recordEgressFailure(
          target,
          normalized.code,
          normalized.message,
          normalized.retryable
        );
      }
    }

    const hasDeliveries = collector.hasDeliveries();
    const resultPayload: SysResultPayload = collector.build(envelope.msgId);
    if (ack !== "none") {
      enqueueOutbound(
        sender,
        serializeEnvelope(
          createResultEnvelope(
            sender.socket.data.connId,
            resultPayload,
            envelope.traceId
          )
        )
      );
    }

    if (!hasDeliveries) {
      if (ack === "none") {
        return;
      }

      throw new HardessError(ERROR_CODES.ROUTE_PEER_OFFLINE, "No valid target connections", {
        refMsgId: envelope.msgId,
        detail: resultPayload
      });
    }
  }

  async function handleSystemMessage(connection: ConnectionState, envelope: Envelope<unknown>): Promise<void> {
    switch (envelope.action) {
      case "auth": {
        const auth = await deps.authService.validateSystemAuth(envelope.payload as SysAuthPayload);

        const currentConnRef = deps.peerLocator.getByConnId(connection.socket.data.connId);
        const existingPeerCount = deps.peerLocator.countConnectionsForPeer(auth.peerId);
        const willIncreasePeerCount = currentConnRef?.peerId !== auth.peerId;
        if (
          deps.maxConnectionsPerPeer !== undefined &&
          existingPeerCount + (willIncreasePeerCount ? 1 : 0) > deps.maxConnectionsPerPeer
        ) {
          metrics.increment("ws.conn_quota_exceeded");
          throw new HardessError(
            ERROR_CODES.CONN_QUOTA_EXCEEDED,
            `Peer connection quota exceeded for ${auth.peerId}`
          );
        }

        connection.auth = auth;
        deps.peerLocator.register({
          nodeId: deps.nodeId,
          connId: connection.socket.data.connId,
          peerId: auth.peerId
        });
        enqueueOutbound(
          connection,
          serializeEnvelope(createAuthOkEnvelope(auth, connection.socket.data.connId, envelope.traceId))
        );
        return;
      }
      case "ping": {
        connection.lastSeenAt = now();
        enqueueOutbound(
          connection,
          serializeEnvelope(
            createPongEnvelope(
              connection.socket.data.connId,
              typeof envelope.payload === "object" && envelope.payload && "nonce" in envelope.payload
                ? String((envelope.payload as { nonce?: string }).nonce ?? "")
                : undefined,
              envelope.traceId
            )
          )
        );
        return;
      }
      case "pong": {
        connection.lastSeenAt = now();
        connection.lastPingAt = undefined;
        return;
      }
      default:
        throw new HardessError(
          ERROR_CODES.PROTO_UNKNOWN_ACTION,
          `Unknown system action: ${envelope.action}`,
          { refMsgId: envelope.msgId }
        );
    }
  }

  async function handleBusinessMessage(
    connection: ConnectionState,
    envelope: Envelope<unknown>
  ): Promise<void> {
    const auth = ensureAuthenticated(connection.auth);
    const isValid = await deps.authService.isAuthContextValid(auth);
    if (!isValid) {
      throw new HardessError(ERROR_CODES.AUTH_REVOKED_TOKEN, "Authentication is no longer valid");
    }

    const hooks = deps.registry.get(envelope.protocol, envelope.version, envelope.action);
    const ctx = {
      protocol: envelope.protocol,
      version: envelope.version,
      action: envelope.action,
      payload: envelope.payload,
      auth,
      traceId: envelope.traceId,
      ts: envelope.ts
    };

    await hooks.validate?.(ctx);
    await hooks.authorize?.(ctx);

    const peerIds = await hooks.resolveRecipients?.(ctx);
    if (!peerIds || peerIds.length === 0) {
      throw new HardessError(ERROR_CODES.ROUTE_NO_RECIPIENT, "No recipients resolved");
    }

    const dispatch = (await hooks.buildDispatch?.(ctx)) ?? {};
    const ack = envelope.ack ?? dispatch.ack ?? "recv";
    const outboundEnvelope: Envelope<unknown> = {
      ...envelope,
      protocol: dispatch.protocol ?? envelope.protocol,
      version: dispatch.version ?? envelope.version,
      action: dispatch.action ?? envelope.action,
      streamId: dispatch.streamId ?? envelope.streamId,
      ack,
      payload: dispatch.payload ?? envelope.payload
    };

    await sendToPeerIds(connection, outboundEnvelope, peerIds, ack);
  }

  return {
    open(socket: ConnectionState["socket"]) {
      if (
        deps.maxConnections !== undefined &&
        connections.size >= deps.maxConnections
      ) {
        const error = new HardessError(ERROR_CODES.CONN_QUOTA_EXCEEDED, "Connection quota exceeded");
        metrics.increment("ws.conn_quota_exceeded");
        socket.send(serializeEnvelope(createSysErrEnvelope(error, socket.data.connId)));
        socket.close(closeCodeForError(error), error.code);
        return;
      }

      connections.set(socket.data.connId, {
        socket,
        lastSeenAt: now(),
        messageTimestamps: [],
        outboundQueue: [],
        outboundQueuedBytes: 0,
        drainScheduled: false,
        closed: false
      });
      metrics.increment("ws.open");
      deps.logger.info("websocket opened", { connId: socket.data.connId });
    },
    async message(socket: ConnectionState["socket"], raw: string | ArrayBuffer | Uint8Array) {
      const connection = connections.get(socket.data.connId);
      if (!connection) {
        return;
      }

      const currentTime = now();
      connection.lastSeenAt = currentTime;
      connection.messageTimestamps = connection.messageTimestamps.filter(
        (timestamp) => currentTime - timestamp < rateLimitWindowMs
      );
      if (connection.messageTimestamps.length >= rateLimitMaxMessages) {
        const error = new HardessError(ERROR_CODES.RATE_LIMIT_EXCEEDED, "WebSocket message rate limit exceeded");
        metrics.increment("ws.rate_limit_exceeded");
        socket.send(
          serializeEnvelope(
            createSysErrEnvelope(error, socket.data.connId)
          )
        );
        closeConnection(connection, closeCodeForError(error), error.code);
        return;
      }
      connection.messageTimestamps.push(currentTime);
      metrics.increment("ws.message_in");

      const envelope = parseEnvelope(messageToString(raw));
      if (!envelope) {
        const error = new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "Invalid websocket envelope");
        metrics.increment("ws.invalid_envelope");
        socket.send(
          serializeEnvelope(
            createSysErrEnvelope(error, socket.data.connId)
          )
        );
        closeConnection(connection, closeCodeForError(error), error.code);
        return;
      }

      try {
        if (envelope.kind === "system") {
          await handleSystemMessage(connection, envelope);
          return;
        }

        await handleBusinessMessage(connection, envelope);
      } catch (error) {
        metrics.increment("ws.error");
        const normalized = error instanceof HardessError
          ? error
          : new HardessError(ERROR_CODES.INTERNAL_ERROR, "Unhandled websocket error", {
              detail: error instanceof Error ? error.message : String(error),
              cause: error
            });
        socket.send(
          serializeEnvelope(
            createSysErrEnvelope(normalized, socket.data.connId, envelope.traceId, envelope.msgId)
          )
        );
        const closeCode = closeCodeForError(normalized);
        if (closeCode !== undefined) {
          closeConnection(connection, closeCode, normalized.code);
        }
      }
    },
    close(socket: ConnectionState["socket"]) {
      const connection = connections.get(socket.data.connId);
      if (connection) {
        connection.closed = true;
      }
      deps.peerLocator.unregister(socket.data.connId);
      connections.delete(socket.data.connId);
      metrics.increment("ws.close");
      deps.logger.info("websocket closed", { connId: socket.data.connId });
    },
    dispose() {
      clearIntervalFn(heartbeatTimer);
    }
  };
}
