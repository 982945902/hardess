import type { AckMode, ConnRef, Envelope } from "../../shared/types.ts";
import {
  parseClusterDeliverResponse,
  parseClusterLocateResponse,
  parseClusterSocketMessage,
  type ClusterSocketMessage
} from "./schema.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";

type ClusterMessage = ClusterSocketMessage;

export interface ClusterPeerNode {
  nodeId: string;
  baseUrl: string;
}

export type ClusterTransport = "http" | "ws";

interface ClusterPendingRequest {
  nodeId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ClusterOutboundMessage {
  data: string;
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
}

interface ClusterChannel {
  nodeId: string;
  socket: ClusterSocket;
  connectedAt: number;
}

interface ClusterServerHandlers {
  deliver(payload: {
    sender: ConnRef;
    envelope: Envelope<unknown>;
    ack: AckMode;
    targets: ConnRef[];
  }): Promise<ConnRef[]>;
  handleAck(payload: {
    sender: ConnRef;
    ackFor: string;
    traceId?: string;
  }): Promise<boolean>;
}

interface ClusterSocketMessageEvent {
  data?: unknown;
}

interface ClusterSocketCloseEvent {
  code?: number;
  reason?: string;
}

export interface ClusterSocket {
  readyState?: number;
  send(data: string): number | void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: ClusterSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: ClusterSocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export interface ClusterNetworkOptions {
  nodeId: string;
  sharedSecret?: string;
  requestTimeoutMs?: number;
  outboundMaxQueueMessages?: number;
  outboundMaxQueueBytes?: number;
  outboundBackpressureRetryMs?: number;
  metrics?: Metrics;
  fetchFn?: typeof fetch;
  transport?: ClusterTransport;
  socketFactory?: (url: string) => ClusterSocket;
  logger?: Logger;
}

function parseClusterMessage(raw: unknown): ClusterMessage | null {
  return parseClusterSocketMessage(raw);
}

function toClusterWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/__cluster/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function shouldFallbackToHttp(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Cluster outbound queue overflow") ||
    message.includes("Cluster socket is closed") ||
    message.includes("Cluster socket connect timed out") ||
    message.includes("Cluster channel closed:")
  );
}

export class StaticClusterNetwork {
  private static readonly DEFAULT_OUTBOUND_BACKPRESSURE_RETRY_MS = 10;
  private static readonly DEFAULT_MAX_OUTBOUND_QUEUE_MESSAGES = 16_384;
  private static readonly DEFAULT_MAX_OUTBOUND_QUEUE_BYTES = 8 * 1024 * 1024;
  private readonly peersByNodeId = new Map<string, ClusterPeerNode>();
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly outboundMaxQueueMessages: number;
  private readonly outboundMaxQueueBytes: number;
  private readonly outboundBackpressureRetryMs: number;
  private readonly transport: ClusterTransport;
  private readonly socketFactory: (url: string) => ClusterSocket;
  private readonly metrics: Metrics;
  private readonly channelsByNodeId = new Map<string, ClusterChannel>();
  private readonly pendingRequests = new Map<string, ClusterPendingRequest>();
  private readonly connectingByNodeId = new Map<string, Promise<ClusterChannel>>();
  private readonly nodeIdBySocket = new WeakMap<ClusterSocket, string>();
  private readonly serverSockets = new Set<ClusterSocket>();
  private readonly outboundQueueBySocket = new WeakMap<ClusterSocket, ClusterOutboundMessage[]>();
  private readonly outboundQueuedBytesBySocket = new WeakMap<ClusterSocket, number>();
  private readonly outboundDrainTimerBySocket = new WeakMap<ClusterSocket, ReturnType<typeof setTimeout>>();
  private readonly outboundDrainScheduled = new WeakSet<ClusterSocket>();
  private serverHandlers?: ClusterServerHandlers;

  constructor(
    peers: ClusterPeerNode[],
    private readonly options: ClusterNetworkOptions
  ) {
    this.setPeers(peers);
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.outboundMaxQueueMessages =
      options.outboundMaxQueueMessages ?? StaticClusterNetwork.DEFAULT_MAX_OUTBOUND_QUEUE_MESSAGES;
    this.outboundMaxQueueBytes =
      options.outboundMaxQueueBytes ?? StaticClusterNetwork.DEFAULT_MAX_OUTBOUND_QUEUE_BYTES;
    this.outboundBackpressureRetryMs =
      options.outboundBackpressureRetryMs ?? StaticClusterNetwork.DEFAULT_OUTBOUND_BACKPRESSURE_RETRY_MS;
    this.transport = options.transport ?? "http";
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as ClusterSocket);
    this.metrics = options.metrics ?? new NoopMetrics();
  }

  listPeers(): ClusterPeerNode[] {
    return Array.from(this.peersByNodeId.values());
  }

  setPeers(peers: ClusterPeerNode[]): void {
    const nextPeersByNodeId = new Map<string, ClusterPeerNode>();
    for (const peer of peers) {
      nextPeersByNodeId.set(peer.nodeId, peer);
    }

    for (const [nodeId, channel] of this.channelsByNodeId) {
      if (nextPeersByNodeId.has(nodeId)) {
        continue;
      }
      channel.socket.close(1012, "cluster peer removed");
      this.channelsByNodeId.delete(nodeId);
    }

    this.peersByNodeId.clear();
    for (const peer of nextPeersByNodeId.values()) {
      this.peersByNodeId.set(peer.nodeId, peer);
    }
  }

  hasPeers(): boolean {
    return this.peersByNodeId.size > 0;
  }

  setServerHandlers(handlers: ClusterServerHandlers): void {
    this.serverHandlers = handlers;
  }

  async locate(
    peerIds: string[],
    options: {
      groupId?: string;
      nodeIds?: string[];
    } = {}
  ): Promise<Map<string, ConnRef[]>> {
    const merged = new Map<string, ConnRef[]>();
    for (const peerId of peerIds) {
      merged.set(peerId, []);
    }

    const allowedNodeIds = options.nodeIds ? new Set(options.nodeIds) : undefined;
    await Promise.all(
      this.listPeers()
        .filter((peer) => !allowedNodeIds || allowedNodeIds.has(peer.nodeId))
        .map(async (peer) => {
        try {
          const response = await this.request(peer, "/__cluster/locate", {
            method: "POST",
            body: JSON.stringify({
              peerIds,
              groupId: options.groupId
            })
          });
          const payload = parseClusterLocateResponse(await response.json());
          for (const peerId of peerIds) {
            const current = merged.get(peerId) ?? [];
            const next = payload.peers[peerId] ?? [];
            merged.set(peerId, [...current, ...next]);
          }
        } catch {
          return;
        }
      })
    );

    return merged;
  }

  async deliver(
    nodeId: string,
    payload: {
      sender: ConnRef;
      envelope: Envelope<unknown>;
      ack: AckMode;
      targets: ConnRef[];
    }
  ): Promise<ConnRef[]> {
    if (this.transport === "http") {
      const peer = this.requirePeer(nodeId);
      const response = await this.request(peer, "/__cluster/deliver", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return parseClusterDeliverResponse(await response.json()).deliveredConns;
    }

    try {
      const response = await this.sendRequest(nodeId, {
        type: "deliver",
        sender: payload.sender,
        envelope: payload.envelope,
        ack: payload.ack,
        targets: payload.targets
      }) as { deliveredConns: ConnRef[] };
      return response.deliveredConns;
    } catch (error) {
      if (!shouldFallbackToHttp(error)) {
        throw error;
      }

      this.metrics.increment("cluster.http_fallback");
      const peer = this.requirePeer(nodeId);
      const response = await this.request(peer, "/__cluster/deliver", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      return parseClusterDeliverResponse(await response.json()).deliveredConns;
    }
  }

  async forwardHandleAck(
    sender: ConnRef,
    ackFor: string,
    traceId?: string
  ): Promise<void> {
    if (this.transport === "http") {
      const peer = this.requirePeer(sender.nodeId);
      await this.request(peer, "/__cluster/handle-ack", {
        method: "POST",
        body: JSON.stringify({
          sender,
          ackFor,
          traceId
        })
      });
      return;
    }

    try {
      await this.sendRequest(sender.nodeId, {
        type: "handleAck",
        sender,
        ackFor,
        traceId
      });
    } catch (error) {
      if (!shouldFallbackToHttp(error)) {
        throw error;
      }

      this.metrics.increment("cluster.http_fallback");
      const peer = this.requirePeer(sender.nodeId);
      await this.request(peer, "/__cluster/handle-ack", {
        method: "POST",
        body: JSON.stringify({
          sender,
          ackFor,
          traceId
        })
      });
    }
  }

  openServerSocket(socket: ClusterSocket): void {
    this.serverSockets.add(socket);
  }

  async messageServerSocket(socket: ClusterSocket, raw: string | ArrayBuffer | Uint8Array): Promise<void> {
    try {
      await this.handleIncomingMessage(socket, typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array));
    } catch (error) {
      this.options.logger?.error("cluster websocket message handling failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      try {
        socket.close(1011, "cluster websocket message handling failed");
      } catch {}
    }
  }

  closeServerSocket(socket: ClusterSocket): void {
    this.serverSockets.delete(socket);
    this.unregisterSocket(socket);
  }

  dispose(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Cluster network disposed"));
    }
    this.pendingRequests.clear();

    for (const channel of this.channelsByNodeId.values()) {
      channel.socket.close(1012, "cluster network disposed");
    }
    this.channelsByNodeId.clear();
  }

  async warmConnections(): Promise<void> {
    if (this.transport !== "ws") {
      return;
    }

    await Promise.allSettled(
      this.listPeers().map(async (peer) => {
        await this.ensureChannel(peer.nodeId);
      })
    );
  }

  private async sendRequest(
    nodeId: string,
    payload:
      | Omit<Extract<ClusterMessage, { type: "deliver" }>, "ref">
      | Omit<Extract<ClusterMessage, { type: "handleAck" }>, "ref">
  ): Promise<unknown> {
    const channel = await this.ensureChannel(nodeId);
    const ref = crypto.randomUUID();

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(ref);
        this.metrics.increment("cluster.request_timeout");
        reject(new Error(`Cluster request timed out: ${payload.type} -> ${nodeId}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(ref, {
        nodeId,
        resolve,
        reject,
        timeout
      });

      void this.sendMessage(channel.socket, JSON.stringify({ ...payload, ref })).catch((error) => {
        clearTimeout(timeout);
        this.pendingRequests.delete(ref);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async ensureChannel(nodeId: string): Promise<ClusterChannel> {
    const existing = this.channelsByNodeId.get(nodeId);
    if (existing && existing.socket.readyState !== 3) {
      return existing;
    }

    const connecting = this.connectingByNodeId.get(nodeId);
    if (connecting) {
      return await connecting;
    }

    const peer = this.requirePeer(nodeId);
    const connectPromise = new Promise<ClusterChannel>((resolve, reject) => {
      const socket = this.socketFactory(toClusterWsUrl(peer.baseUrl));
      let settled = false;
      const finishReject = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        this.connectingByNodeId.delete(nodeId);
        try {
          socket.close(1013, message);
        } catch {}
        reject(new Error(message));
      };
      const finishResolve = (channel: ClusterChannel) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        this.connectingByNodeId.delete(nodeId);
        resolve(channel);
      };
      const connectTimer = setTimeout(() => {
        finishReject(`Cluster socket connect timed out: ${nodeId}`);
      }, this.requestTimeoutMs);

      socket.addEventListener("open", () => {
        void this.sendMessage(
          socket,
          JSON.stringify({
            type: "hello",
            nodeId: this.options.nodeId,
            secret: this.options.sharedSecret
          } satisfies ClusterMessage)
        ).catch((error) => {
          finishReject(error instanceof Error ? error.message : String(error));
        });
      });

      socket.addEventListener("message", (event) => {
        void this.handleIncomingMessage(socket, String(event.data ?? ""), {
          onHelloAck: (remoteNodeId) => {
            if (remoteNodeId !== nodeId) {
              finishReject(`Cluster helloAck mismatch: expected=${nodeId} actual=${remoteNodeId}`);
              return;
            }

            const channel: ClusterChannel = {
              nodeId,
              socket,
              connectedAt: Date.now()
            };
            this.registerChannel(channel);
            finishResolve(channel);
          }
        }).catch((error) => {
          finishReject(error instanceof Error ? error.message : String(error));
        });
      });

      socket.addEventListener("close", () => {
        this.unregisterSocket(socket);
        if (this.connectingByNodeId.get(nodeId)) {
          finishReject(`Cluster socket closed during connect: ${nodeId}`);
        }
      });

      socket.addEventListener("error", () => {
        if (this.connectingByNodeId.get(nodeId)) {
          finishReject(`Cluster socket error during connect: ${nodeId}`);
        }
      });
    });

    this.connectingByNodeId.set(nodeId, connectPromise);
    return await connectPromise;
  }

  private async handleIncomingMessage(
    socket: ClusterSocket,
    raw: string,
    hooks: {
      onHelloAck?(remoteNodeId: string): void;
    } = {}
  ): Promise<void> {
    const message = parseClusterMessage(raw);
    if (!message) {
      this.metrics.increment("cluster.invalid_message");
      socket.close(4400, "invalid cluster message");
      return;
    }

    this.metrics.increment("cluster.message_in");

    const remoteNodeId = this.nodeIdBySocket.get(socket);
    if (!remoteNodeId && message.type !== "hello" && message.type !== "helloAck") {
      this.metrics.increment("cluster.auth_rejected");
      socket.close(4401, "cluster channel not authenticated");
      return;
    }

    switch (message.type) {
      case "hello":
        if (this.options.sharedSecret && message.secret !== this.options.sharedSecret) {
          this.metrics.increment("cluster.auth_rejected");
          socket.close(4401, "cluster shared secret mismatch");
          return;
        }
        this.registerChannel({
          nodeId: message.nodeId,
          socket,
          connectedAt: Date.now()
        });
        await this.sendMessage(
          socket,
          JSON.stringify({
            type: "helloAck",
            nodeId: this.options.nodeId
          } satisfies ClusterMessage)
        );
        return;
      case "helloAck":
        this.nodeIdBySocket.set(socket, message.nodeId);
        hooks.onHelloAck?.(message.nodeId);
        return;
      case "ping":
        await this.sendMessage(socket, JSON.stringify({ type: "pong", ts: message.ts } satisfies ClusterMessage));
        return;
      case "pong":
        return;
      case "deliver": {
        if (!this.serverHandlers) {
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "deliverResult",
              ref: message.ref,
              deliveredConns: [],
              error: "Cluster server handlers are not configured"
            } satisfies ClusterMessage)
          );
          return;
        }

        try {
          const deliveredConns = await this.serverHandlers.deliver({
            sender: message.sender,
            envelope: message.envelope,
            ack: message.ack,
            targets: message.targets
          });
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "deliverResult",
              ref: message.ref,
              deliveredConns
            } satisfies ClusterMessage)
          );
        } catch (error) {
          this.metrics.increment("cluster.deliver_error");
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "deliverResult",
              ref: message.ref,
              deliveredConns: [],
              error: error instanceof Error ? error.message : String(error)
            } satisfies ClusterMessage)
          );
        }
        return;
      }
      case "deliverResult": {
        const pending = this.pendingRequests.get(message.ref);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.ref);
        if (message.error) {
          this.metrics.increment("cluster.deliver_error");
          pending.reject(new Error(message.error));
          return;
        }

        pending.resolve({
          deliveredConns: message.deliveredConns
        });
        return;
      }
      case "handleAck": {
        if (!this.serverHandlers) {
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "handleAckResult",
              ref: message.ref,
              ok: false,
              error: "Cluster server handlers are not configured"
            } satisfies ClusterMessage)
          );
          return;
        }

        try {
          const ok = await this.serverHandlers.handleAck({
            sender: message.sender,
            ackFor: message.ackFor,
            traceId: message.traceId
          });
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "handleAckResult",
              ref: message.ref,
              ok
            } satisfies ClusterMessage)
          );
        } catch (error) {
          this.metrics.increment("cluster.handle_ack_error");
          await this.sendMessage(
            socket,
            JSON.stringify({
              type: "handleAckResult",
              ref: message.ref,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            } satisfies ClusterMessage)
          );
        }
        return;
      }
      case "handleAckResult": {
        const pending = this.pendingRequests.get(message.ref);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.ref);
        if (!message.ok) {
          this.metrics.increment("cluster.handle_ack_error");
          pending.reject(new Error(message.error ?? "Cluster handleAck failed"));
          return;
        }

        pending.resolve(undefined);
        return;
      }
    }
  }

  private registerChannel(channel: ClusterChannel): void {
    const existing = this.channelsByNodeId.get(channel.nodeId);
    if (existing && existing.socket !== channel.socket) {
      existing.socket.close(1000, "cluster channel replaced");
    }

    this.channelsByNodeId.set(channel.nodeId, channel);
    this.nodeIdBySocket.set(channel.socket, channel.nodeId);
  }

  private unregisterSocket(socket: ClusterSocket): void {
    const queued = this.outboundQueueBySocket.get(socket) ?? [];
    for (const entry of queued) {
      entry.reject(new Error("Cluster socket closed"));
    }
    this.outboundQueueBySocket.delete(socket);
    this.outboundQueuedBytesBySocket.delete(socket);
    const drainTimer = this.outboundDrainTimerBySocket.get(socket);
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      this.outboundDrainTimerBySocket.delete(socket);
    }
    this.outboundDrainScheduled.delete(socket);

    const nodeId = this.nodeIdBySocket.get(socket);
    if (nodeId) {
      this.metrics.increment("cluster.channel_closed");
      const current = this.channelsByNodeId.get(nodeId);
      if (current?.socket === socket) {
        this.channelsByNodeId.delete(nodeId);
      }
      this.nodeIdBySocket.delete(socket);
    }

    for (const [ref, pending] of this.pendingRequests.entries()) {
      if (pending.nodeId === nodeId) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(ref);
        pending.reject(new Error(`Cluster channel closed: ${nodeId}`));
      }
    }
  }

  private requirePeer(nodeId: string): ClusterPeerNode {
    const peer = this.peersByNodeId.get(nodeId);
    if (!peer) {
      throw new Error(`Unknown cluster peer: ${nodeId}`);
    }

    return peer;
  }

  private async request(peer: ClusterPeerNode, path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchFn(`${peer.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.options.sharedSecret ? { "x-hardess-cluster-secret": this.options.sharedSecret } : {}),
          ...init.headers
        }
      });
      if (!response.ok) {
        throw new Error(`Cluster request failed: ${peer.nodeId} ${path} ${response.status}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getOutboundQueue(socket: ClusterSocket): ClusterOutboundMessage[] {
    const existing = this.outboundQueueBySocket.get(socket);
    if (existing) {
      return existing;
    }

    const created: ClusterOutboundMessage[] = [];
    this.outboundQueueBySocket.set(socket, created);
    return created;
  }

  private getOutboundQueuedBytes(socket: ClusterSocket): number {
    return this.outboundQueuedBytesBySocket.get(socket) ?? 0;
  }

  private setOutboundQueuedBytes(socket: ClusterSocket, bytes: number): void {
    this.outboundQueuedBytesBySocket.set(socket, bytes);
  }

  private trySendNow(socket: ClusterSocket, data: string): boolean {
    if (socket.readyState === 3) {
      throw new Error("Cluster socket is closed");
    }

    const status = socket.send(data);
    if (status === -1) {
      this.metrics.increment("cluster.egress_backpressure");
      return false;
    }
    if (status === 0) {
      this.metrics.increment("cluster.egress_drop");
      throw new Error("Cluster socket send dropped by runtime");
    }

    this.metrics.increment("cluster.message_out");
    return true;
  }

  private scheduleDrain(socket: ClusterSocket): void {
    if (this.outboundDrainScheduled.has(socket)) {
      return;
    }

    this.outboundDrainScheduled.add(socket);
    queueMicrotask(() => {
      void this.drainOutboundQueue(socket);
    });
  }

  private scheduleDrainRetry(socket: ClusterSocket): void {
    if (this.outboundDrainTimerBySocket.has(socket)) {
      return;
    }

    const timer = setTimeout(() => {
      this.outboundDrainTimerBySocket.delete(socket);
      this.scheduleDrain(socket);
    }, this.outboundBackpressureRetryMs);
    this.outboundDrainTimerBySocket.set(socket, timer);
  }

  private async drainOutboundQueue(socket: ClusterSocket): Promise<void> {
    this.outboundDrainScheduled.delete(socket);
    const queue = this.getOutboundQueue(socket);

    while (queue.length > 0) {
      const next = queue[0];
      if (!next) {
        return;
      }

      try {
        const sent = this.trySendNow(socket, next.data);
        if (!sent) {
          this.scheduleDrainRetry(socket);
          return;
        }

        queue.shift();
        this.setOutboundQueuedBytes(socket, this.getOutboundQueuedBytes(socket) - next.bytes);
        next.resolve();
      } catch (error) {
        queue.shift();
        this.setOutboundQueuedBytes(socket, this.getOutboundQueuedBytes(socket) - next.bytes);
        next.reject(error instanceof Error ? error : new Error(String(error)));
        try {
          socket.close(1011, "cluster outbound send failed");
        } catch {}
        return;
      }
    }
  }

  private async waitForQueueCapacity(socket: ClusterSocket): Promise<void> {
    const startedAt = Date.now();

    while (true) {
      if (socket.readyState === 3) {
        throw new Error("Cluster socket is closed");
      }

      const queue = this.getOutboundQueue(socket);
      if (queue.length < this.outboundMaxQueueMessages) {
        return;
      }

      if (Date.now() - startedAt >= this.requestTimeoutMs) {
        this.metrics.increment("cluster.egress_overflow");
        throw new Error("Cluster outbound queue overflow");
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.outboundBackpressureRetryMs);
      });
    }
  }

  private ensureQueueBytesWithinLimit(socket: ClusterSocket, nextBytes: number): void {
    if (this.getOutboundQueuedBytes(socket) + nextBytes <= this.outboundMaxQueueBytes) {
      return;
    }

    this.metrics.increment("cluster.egress_overflow");
    throw new Error("Cluster outbound queue overflow");
  }

  private async sendMessage(socket: ClusterSocket, data: string): Promise<void> {
    let queue = this.getOutboundQueue(socket);
    const bytes = new TextEncoder().encode(data).byteLength;

    while (queue.length + 1 > this.outboundMaxQueueMessages) {
      await this.waitForQueueCapacity(socket);
      queue = this.getOutboundQueue(socket);
    }

    this.ensureQueueBytesWithinLimit(socket, bytes);

    return await new Promise<void>((resolve, reject) => {
      if (
        queue.length === 0 &&
        !this.outboundDrainScheduled.has(socket) &&
        !this.outboundDrainTimerBySocket.has(socket)
      ) {
        try {
          const sent = this.trySendNow(socket, data);
          if (sent) {
            resolve();
            return;
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }

      queue.push({
        data,
        bytes,
        resolve,
        reject
      });
      this.setOutboundQueuedBytes(socket, this.getOutboundQueuedBytes(socket) + bytes);
      if (!this.outboundDrainTimerBySocket.has(socket)) {
        this.scheduleDrain(socket);
      }
    });
  }
}
