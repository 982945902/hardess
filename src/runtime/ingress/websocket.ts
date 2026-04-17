import {
  ERROR_CODES,
  HardessError,
  parseSysAuthPayload,
  parseSysHandleAckPayload,
  parseSysPingPayload,
  parseSysPongPayload,
  type AckMode,
  type AuthContext,
  type ConnRef,
  type Envelope
} from "../../shared/index.ts";
import type { AuthService } from "../auth/service.ts";
import type { StaticClusterNetwork } from "../cluster/network.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";
import { Dispatcher } from "../routing/dispatcher.ts";
import { InMemoryPeerLocator } from "../routing/peer-locator.ts";
import { parseEnvelope, serializeEnvelope } from "../protocol/envelope.ts";
import { ServerProtocolRegistry } from "../protocol/registry.ts";
import {
  createAuthOkEnvelope,
  createHandleAckEnvelope,
  createPingEnvelope,
  createPongEnvelope,
  createRecvAckEnvelope,
  createRouteEnvelope,
  createSysErrEnvelope,
  ensureAuthenticated
} from "../protocol/system-handlers.ts";

interface ConnectionState {
  socket: {
    data: {
      connId: string;
    };
    send(data: string): number | void;
    getBufferedAmount?(): number;
    close(code?: number, reason?: string): void;
  };
  auth?: AuthContext;
  lastSeenAt: number;
  lastPingAt?: number;
  messageTimestamps: number[];
  outboundQueue: Array<{ data: string; bytes: number }>;
  outboundQueuedBytes: number;
  drainScheduled: boolean;
  drainTimer?: TimeoutHandle;
  closed: boolean;
}

type IntervalHandle = ReturnType<typeof globalThis.setInterval> | number;
type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;
type SetIntervalLike = (callback: () => void, delay: number) => IntervalHandle;
type ClearIntervalLike = (handle: IntervalHandle) => void;
type SetTimeoutLike = (callback: () => void, delay: number) => TimeoutHandle;
type ClearTimeoutLike = (handle: TimeoutHandle) => void;

export interface WebSocketRuntimeDeps {
  nodeId: string;
  hostGroupId?: string;
  authService: AuthService;
  peerLocator: InMemoryPeerLocator;
  dispatcher: Dispatcher;
  clusterNetwork?: StaticClusterNetwork;
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
    maxSocketBufferBytes?: number;
    backpressureRetryMs?: number;
  };
  shutdownGraceMs?: number;
  now?: () => number;
  setIntervalFn?: SetIntervalLike;
  clearIntervalFn?: ClearIntervalLike;
  setTimeoutFn?: SetTimeoutLike;
  clearTimeoutFn?: ClearTimeoutLike;
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
  const pendingHandleAckByMsgId = new Map<string, ConnRef>();
  const recentClusterDeliveryByMsgId = new Map<string, number>();
  const now = deps.now ?? (() => Date.now());
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 25_000;
  const staleAfterMs = deps.staleAfterMs ?? 60_000;
  const metrics = deps.metrics ?? new NoopMetrics();
  const rateLimitWindowMs = deps.rateLimit?.windowMs ?? 1_000;
  const rateLimitMaxMessages = deps.rateLimit?.maxMessages ?? 100;
  const outboundMaxQueueMessages = deps.outbound?.maxQueueMessages ?? 256;
  const outboundMaxQueueBytes = deps.outbound?.maxQueueBytes ?? 512 * 1024;
  const outboundMaxSocketBufferBytes = deps.outbound?.maxSocketBufferBytes ?? 512 * 1024;
  const outboundBackpressureRetryMs = deps.outbound?.backpressureRetryMs ?? 10;
  const shutdownGraceMs = deps.shutdownGraceMs ?? 3_000;
  const recentClusterDeliveryTtlMs = Math.max(staleAfterMs, 60_000);
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const queueMicrotaskFn = deps.queueMicrotaskFn ?? queueMicrotask;
  let shuttingDown = false;
  let shutdownTimer: TimeoutHandle | undefined;

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
    if (connection.drainTimer !== undefined) {
      clearTimeoutFn(connection.drainTimer);
      connection.drainTimer = undefined;
    }
    connection.socket.close(code, reason);
  }

  function createBackpressureError(message: string, detail?: string): HardessError {
    return new HardessError(ERROR_CODES.BACKPRESSURE_OVERFLOW, message, {
      detail
    });
  }

  function createDrainingError(refMsgId?: string): HardessError {
    return new HardessError(ERROR_CODES.SERVER_DRAINING, "Runtime websocket ingress is draining", {
      retryable: true,
      detail: "retry_on_another_healthy_node",
      refMsgId
    });
  }

  function currentSocketBufferedAmount(connection: ConnectionState): number {
    return connection.socket.getBufferedAmount?.() ?? 0;
  }

  function ensureSocketBufferWithinLimit(connection: ConnectionState): void {
    const bufferedAmount = currentSocketBufferedAmount(connection);
    if (bufferedAmount <= outboundMaxSocketBufferBytes) {
      return;
    }

    metrics.increment("ws.egress_buffer_limit_exceeded");
    const error = createBackpressureError("WebSocket socket buffer overflow", `buffered_amount=${bufferedAmount}`);
    closeConnection(connection, closeCodeForError(error), error.code);
    throw error;
  }

  function trySendNow(connection: ConnectionState, data: string): boolean {
    ensureSocketBufferWithinLimit(connection);

    let status: number | void;
    try {
      status = connection.socket.send(data);
    } catch (error) {
      metrics.increment("ws.egress_error");
      const normalized = createBackpressureError(
        "WebSocket outbound send failed",
        error instanceof Error ? error.message : String(error)
      );
      closeConnection(connection, closeCodeForError(normalized), normalized.code);
      throw normalized;
    }

    if (status === -1) {
      metrics.increment("ws.egress_backpressure");
      return false;
    }

    if (status === 0) {
      metrics.increment("ws.egress_drop");
      const error = createBackpressureError("WebSocket outbound send dropped by runtime");
      closeConnection(connection, closeCodeForError(error), error.code);
      throw error;
    }

    ensureSocketBufferWithinLimit(connection);
    metrics.increment("ws.message_out");
    return true;
  }

  function scheduleDrainRetry(connection: ConnectionState): void {
    if (connection.closed || connection.drainTimer !== undefined) {
      return;
    }

    connection.drainTimer = setTimeoutFn(() => {
      connection.drainTimer = undefined;
      if (connection.outboundQueue.length > 0) {
        scheduleDrain(connection);
      }
    }, outboundBackpressureRetryMs);
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
        const sent = trySendNow(connection, next.data);
        if (!sent) {
          connection.outboundQueue.unshift(next);
          connection.outboundQueuedBytes += next.bytes;
          scheduleDrainRetry(connection);
          break;
        }
      } catch {
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

  function forceCloseDrainingConnections(): void {
    const drainingConnections = Array.from(connections.values()).filter((connection) => !connection.closed);
    if (drainingConnections.length === 0) {
      return;
    }

    metrics.increment("ws.shutdown_close", drainingConnections.length);
    deps.logger.info("websocket shutdown grace expired", {
      activeConnections: drainingConnections.length
    });

    for (const connection of drainingConnections) {
      closeConnection(connection, 1001, "server shutting down");
    }
  }

  function beginShutdown(): void {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const connection of connections.values()) {
      deps.peerLocator.unregister(connection.socket.data.connId);
    }

    deps.logger.info("websocket shutdown draining", {
      activeConnections: connections.size,
      shutdownGraceMs
    });

    if (shutdownGraceMs <= 0) {
      forceCloseDrainingConnections();
      return;
    }

    shutdownTimer = setTimeoutFn(() => {
      shutdownTimer = undefined;
      forceCloseDrainingConnections();
    }, shutdownGraceMs);
  }

  function enqueueOutbound(connection: ConnectionState, data: string): void {
    if (connection.closed) {
      return;
    }

    const bytes = new TextEncoder().encode(data).byteLength;
    const canAttemptDirectSend =
      connection.outboundQueue.length === 0 &&
      !connection.drainScheduled &&
      connection.drainTimer === undefined;
    let directSendBackpressured = false;

    if (canAttemptDirectSend) {
      const sent = trySendNow(connection, data);
      if (sent) {
        return;
      }
      directSendBackpressured = true;
    }

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
    if (directSendBackpressured) {
      scheduleDrainRetry(connection);
      return;
    }
    if (connection.drainTimer !== undefined) {
      return;
    }
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
        try {
          enqueueOutbound(
            connection,
            serializeEnvelope(
              createPingEnvelope(connection.socket.data.connId, crypto.randomUUID())
            )
          );
        } catch {}
      }
    }
  }

  async function sendToPeerIds(
    sender: ConnectionState,
    envelope: Envelope<unknown>,
    peerIds: string[],
    ack: AckMode = "recv"
  ): Promise<void> {
    const senderRef: ConnRef = {
      nodeId: deps.nodeId,
      connId: sender.socket.data.connId,
      peerId: sender.auth?.peerId ?? envelope.src.peerId,
      groupId: sender.auth?.groupId
    };

    async function attemptDelivery(targetPeerIds: string[]): Promise<ConnRef[]> {
      const plan = await deps.dispatcher.buildPlan(targetPeerIds, {
        streamId: envelope.streamId,
        ack,
        groupId: sender.auth?.groupId
      });

      if (plan.targets.length === 0) {
        return [];
      }

      const deliveredTargets: typeof plan.targets = [];
      const remoteTargetsByNode = new Map<string, ConnRef[]>();
      let targetFailures = 0;

      for (const target of plan.targets) {
        if (target.nodeId !== deps.nodeId) {
          const nodeTargets = remoteTargetsByNode.get(target.nodeId) ?? [];
          nodeTargets.push(target);
          remoteTargetsByNode.set(target.nodeId, nodeTargets);
          continue;
        }

        const connection = connections.get(target.connId);
        if (!connection?.auth) {
          continue;
        }

        if (!(await deps.authService.isAuthContextValid(connection.auth))) {
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
          deliveredTargets.push(target);
        } catch (error) {
          targetFailures += 1;
          metrics.increment("ws.delivery_target_error");
          deps.logger.warn("local websocket delivery failed", {
            traceId: envelope.traceId,
            msgId: envelope.msgId,
            targetNodeId: target.nodeId,
            targetConnId: target.connId,
            targetPeerId: target.peerId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      for (const [nodeId, targets] of remoteTargetsByNode.entries()) {
        if (!deps.clusterNetwork) {
          continue;
        }

        try {
          const delivered = await deps.clusterNetwork.deliver(nodeId, {
            sender: senderRef,
            envelope: {
              ...envelope,
              src: {
                peerId: senderRef.peerId,
                connId: senderRef.connId
              }
            },
            ack,
            targets
          });
          deliveredTargets.push(...delivered);
        } catch (error) {
          targetFailures += targets.length;
          metrics.increment("ws.relay_error");
          deps.logger.error("cluster relay delivery failed", {
            nodeId,
            msgId: envelope.msgId,
            traceId: envelope.traceId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (deliveredTargets.length > 0 && targetFailures > 0) {
        metrics.increment("ws.partial_delivery");
        deps.logger.warn("websocket fanout partially delivered", {
          msgId: envelope.msgId,
          traceId: envelope.traceId,
          resolvedPeerCount: targetPeerIds.length,
          plannedTargetCount: plan.targets.length,
          deliveredTargetCount: deliveredTargets.length,
          failedTargetCount: targetFailures
        });
      }

      return deliveredTargets;
    }

    let deliveredTargets = await attemptDelivery(peerIds);
    if (deliveredTargets.length === 0) {
      deps.dispatcher.invalidate(peerIds);
      metrics.increment("ws.route_cache_retry");
      deliveredTargets = await attemptDelivery(peerIds);
    }

    if (deliveredTargets.length === 0) {
      throw new HardessError(ERROR_CODES.ROUTE_PEER_OFFLINE, "No valid target connections");
    }

    if (ack !== "none") {
      pendingHandleAckByMsgId.set(envelope.msgId, senderRef);
    }

    enqueueOutbound(
      sender,
      serializeEnvelope(
        createRouteEnvelope(
          sender.socket.data.connId,
          {
            resolvedPeers: peerIds,
            deliveredConns: deliveredTargets
          },
          envelope.traceId
        )
      )
    );

    if (ack !== "none" && sender.auth) {
      enqueueOutbound(
        sender,
        serializeEnvelope(createRecvAckEnvelope(sender.socket.data.connId, envelope.msgId, envelope.traceId))
      );
    }
  }

  function pruneRecentClusterDeliveries(currentTime: number): void {
    for (const [msgId, expiresAt] of recentClusterDeliveryByMsgId.entries()) {
      if (expiresAt <= currentTime) {
        recentClusterDeliveryByMsgId.delete(msgId);
      }
    }
  }

  async function handleSystemMessage(connection: ConnectionState, envelope: Envelope<unknown>): Promise<void> {
    switch (envelope.action) {
      case "auth": {
        if (shuttingDown) {
          throw createDrainingError(envelope.msgId);
        }

        const authPayload = parseSysAuthPayload(envelope.payload);
        const auth = await deps.authService.validateSystemAuth(authPayload);

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

        connection.auth = {
          ...auth,
          groupId: deps.hostGroupId
        };
        deps.peerLocator.register({
          nodeId: deps.nodeId,
          connId: connection.socket.data.connId,
          peerId: auth.peerId,
          groupId: deps.hostGroupId
        });
        enqueueOutbound(
          connection,
          serializeEnvelope(createAuthOkEnvelope(auth, connection.socket.data.connId, envelope.traceId))
        );
        return;
      }
      case "ping": {
        const payload = parseSysPingPayload(envelope.payload);
        connection.lastSeenAt = now();
        enqueueOutbound(
          connection,
          serializeEnvelope(
            createPongEnvelope(
              connection.socket.data.connId,
              payload.nonce,
              envelope.traceId
            )
          )
        );
        return;
      }
      case "pong": {
        parseSysPongPayload(envelope.payload);
        connection.lastSeenAt = now();
        connection.lastPingAt = undefined;
        return;
      }
      case "handleAck": {
        ensureAuthenticated(connection.auth);
        const payload = parseSysHandleAckPayload(envelope.payload);

        const senderRef = pendingHandleAckByMsgId.get(payload.ackFor);
        if (!senderRef) {
          throw new HardessError(ERROR_CODES.ROUTE_NO_RECIPIENT, "No sender found for handleAck", {
            refMsgId: payload.ackFor
          });
        }

        pendingHandleAckByMsgId.delete(payload.ackFor);

        if (senderRef.nodeId !== deps.nodeId) {
          if (!deps.clusterNetwork) {
            throw new HardessError(ERROR_CODES.ROUTE_PEER_OFFLINE, "Sender node is unavailable", {
              refMsgId: payload.ackFor
            });
          }

          await deps.clusterNetwork.forwardHandleAck(senderRef, payload.ackFor, envelope.traceId);
          return;
        }

        const senderConnection = connections.get(senderRef.connId);
        if (!senderConnection?.auth || !(await deps.authService.isAuthContextValid(senderConnection.auth))) {
          throw new HardessError(ERROR_CODES.ROUTE_PEER_OFFLINE, "Sender is offline", {
            refMsgId: payload.ackFor
          });
        }

        enqueueOutbound(
          senderConnection,
          serializeEnvelope(
            createHandleAckEnvelope(connection.socket.data.connId, payload.ackFor, envelope.traceId)
          )
        );
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
    if (shuttingDown) {
      throw createDrainingError(envelope.msgId);
    }

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

    const localHandleResult = await hooks.handleLocally?.(ctx);
    const peerIds = await hooks.resolveRecipients?.(ctx);
    const hasRecipients = Boolean(peerIds && peerIds.length > 0);
    const handledLocally = hooks.handleLocally !== undefined;
    if (!handledLocally && !hasRecipients) {
      throw new HardessError(ERROR_CODES.ROUTE_NO_RECIPIENT, "No recipients resolved");
    }

    if (hasRecipients) {
      const dispatch = (await hooks.buildDispatch?.(ctx)) ?? {};
      const outboundEnvelope: Envelope<unknown> = {
        ...envelope,
        protocol: dispatch.protocol ?? envelope.protocol,
        version: dispatch.version ?? envelope.version,
        action: dispatch.action ?? envelope.action,
        streamId: dispatch.streamId ?? envelope.streamId,
        payload: dispatch.payload ?? envelope.payload
      };

      await sendToPeerIds(connection, outboundEnvelope, peerIds ?? [], dispatch.ack ?? "recv");
      return;
    }

    const localAck = localHandleResult?.ack ?? "handle";
    if (localAck === "recv" || localAck === "handle") {
      enqueueOutbound(
        connection,
        serializeEnvelope(createRecvAckEnvelope(connection.socket.data.connId, envelope.msgId, envelope.traceId))
      );
    }
    if (localAck === "handle") {
      enqueueOutbound(
        connection,
        serializeEnvelope(createHandleAckEnvelope("system", envelope.msgId, envelope.traceId))
      );
    }
  }

  return {
    beginShutdown,
    open(socket: ConnectionState["socket"]) {
      if (shuttingDown) {
        metrics.increment("ws.shutdown_rejected");
        socket.close(1001, "server shutting down");
        return;
      }

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
        drainTimer: undefined,
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
        metrics.increment(`ws.error_code.${normalized.code.toLowerCase()}`);
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
        if (connection.drainTimer !== undefined) {
          clearTimeoutFn(connection.drainTimer);
          connection.drainTimer = undefined;
        }
      }
      deps.peerLocator.unregister(socket.data.connId);
      connections.delete(socket.data.connId);
      for (const [msgId, senderRef] of pendingHandleAckByMsgId.entries()) {
        if (senderRef.nodeId === deps.nodeId && senderRef.connId === socket.data.connId) {
          pendingHandleAckByMsgId.delete(msgId);
        }
      }
      metrics.increment("ws.close");
      deps.logger.info("websocket closed", { connId: socket.data.connId });
    },
    async deliverCluster(payload: {
      sender: ConnRef;
      envelope: Envelope<unknown>;
      ack: AckMode;
      targets: ConnRef[];
    }): Promise<ConnRef[]> {
      if (shuttingDown && payload.envelope.kind === "biz") {
        metrics.increment("ws.shutdown_rejected");
        deps.logger.info("cluster websocket delivery skipped during shutdown", {
          msgId: payload.envelope.msgId,
          traceId: payload.envelope.traceId,
          senderNodeId: payload.sender.nodeId,
          targetCount: payload.targets.length
        });
        return [];
      }

      const currentTime = now();
      pruneRecentClusterDeliveries(currentTime);
      const duplicateUntil = recentClusterDeliveryByMsgId.get(payload.envelope.msgId);
      if (duplicateUntil && duplicateUntil > currentTime) {
        metrics.increment("ws.cluster_duplicate_delivery");
        return payload.targets.filter((target) => target.nodeId === deps.nodeId);
      }

      const deliveredTargets: ConnRef[] = [];

      for (const target of payload.targets) {
        const connection = connections.get(target.connId);
        if (!connection?.auth || target.nodeId !== deps.nodeId) {
          continue;
        }

        if (!(await deps.authService.isAuthContextValid(connection.auth))) {
          continue;
        }

        if (payload.ack !== "none") {
          pendingHandleAckByMsgId.set(payload.envelope.msgId, payload.sender);
        }

        enqueueOutbound(
          connection,
          serializeEnvelope({
            ...payload.envelope
          })
        );
        deliveredTargets.push(target);
      }

      if (deliveredTargets.length > 0) {
        recentClusterDeliveryByMsgId.set(payload.envelope.msgId, currentTime + recentClusterDeliveryTtlMs);
      }

      return deliveredTargets;
    },
    async forwardClusterHandleAck(payload: {
      sender: ConnRef;
      ackFor: string;
      traceId?: string;
    }): Promise<boolean> {
      pendingHandleAckByMsgId.delete(payload.ackFor);

      const senderConnection = connections.get(payload.sender.connId);
      if (!senderConnection?.auth || !(await deps.authService.isAuthContextValid(senderConnection.auth))) {
        return false;
      }

      enqueueOutbound(
        senderConnection,
        serializeEnvelope(
          createHandleAckEnvelope("cluster", payload.ackFor, payload.traceId)
        )
      );
      return true;
    },
    dispose() {
      clearIntervalFn(heartbeatTimer);
      if (shutdownTimer !== undefined) {
        clearTimeoutFn(shutdownTimer);
        shutdownTimer = undefined;
      }
    }
  };
}
