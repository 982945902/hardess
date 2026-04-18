import type { AckMode, ConnRef, Envelope } from "../../shared/types.ts";
import type {
  ClusterPeerHealthRumor,
  ClusterPeerHealthSnapshot,
  ClusterPeerHealthStatus
} from "./health.ts";
import {
  parseClusterDeliverResponse,
  parseClusterLocateResponse,
  parseClusterSocketMessage,
  type ClusterSocketMessage
} from "./schema.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";

type ClusterMessage = ClusterSocketMessage;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

export interface ClusterPeerNode {
  nodeId: string;
  baseUrl: string;
}

export type ClusterTransport = "http" | "ws";

interface ClusterPendingRequest {
  nodeId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: TimeoutHandle;
}

interface ClusterOutboundMessage {
  data: string;
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
}

interface ClusterPeerHealthSyncRumor {
  peerNodeId: string;
  status: Exclude<ClusterPeerHealthStatus, "unknown">;
  incarnation: number;
  lastAliveAt?: number;
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

export interface ClusterPeerHealthObserver {
  markAlive(nodeId: string, detail?: string): void;
  markSuspect(nodeId: string, detail?: string): void;
  applyRumor?(rumor: ClusterPeerHealthRumor, fromNodeId: string): boolean | void;
}

interface ClusterNetworkTimers {
  setTimeout(callback: () => void, delay: number): TimeoutHandle;
  clearTimeout(timeout: TimeoutHandle): void;
  setInterval(callback: () => void, delay: number): IntervalHandle;
  clearInterval(interval: IntervalHandle): void;
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
  peerProbeIntervalMs?: number;
  peerPingTimeoutMs?: number;
  peerAntiEntropyIntervalMs?: number;
  metrics?: Metrics;
  fetchFn?: typeof fetch;
  transport?: ClusterTransport;
  socketFactory?: (url: string) => ClusterSocket;
  logger?: Logger;
  peerHealthObserver?: ClusterPeerHealthObserver;
  peerHealthSnapshotProvider?: () => ClusterPeerHealthSnapshot[];
  timers?: Partial<ClusterNetworkTimers>;
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
  private static readonly DEFAULT_PEER_PROBE_INTERVAL_MS = 2_000;
  private static readonly DEFAULT_PEER_PING_TIMEOUT_MS = 1_000;
  private static readonly DEFAULT_PEER_ANTI_ENTROPY_INTERVAL_MS = 15_000;
  private readonly peersByNodeId = new Map<string, ClusterPeerNode>();
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly outboundMaxQueueMessages: number;
  private readonly outboundMaxQueueBytes: number;
  private readonly outboundBackpressureRetryMs: number;
  private readonly peerProbeIntervalMs: number;
  private readonly peerPingTimeoutMs: number;
  private readonly peerAntiEntropyIntervalMs: number;
  private readonly transport: ClusterTransport;
  private readonly socketFactory: (url: string) => ClusterSocket;
  private readonly metrics: Metrics;
  private readonly timers: ClusterNetworkTimers;
  private readonly channelsByNodeId = new Map<string, ClusterChannel>();
  private readonly pendingRequests = new Map<string, ClusterPendingRequest>();
  private readonly pendingProbeByNodeId = new Map<string, { ts: number; timeout: TimeoutHandle }>();
  private readonly peerHealthSyncStateByPeerNodeId = new Map<string, Map<string, string>>();
  private readonly connectingByNodeId = new Map<string, Promise<ClusterChannel>>();
  private readonly nodeIdBySocket = new WeakMap<ClusterSocket, string>();
  private readonly serverSockets = new Set<ClusterSocket>();
  private readonly outboundQueueBySocket = new WeakMap<ClusterSocket, ClusterOutboundMessage[]>();
  private readonly outboundQueuedBytesBySocket = new WeakMap<ClusterSocket, number>();
  private readonly outboundDrainTimerBySocket = new WeakMap<ClusterSocket, TimeoutHandle>();
  private readonly outboundDrainScheduled = new WeakSet<ClusterSocket>();
  private readonly peerHealthObserver?: ClusterPeerHealthObserver;
  private peerProbeTimer?: IntervalHandle;
  private peerAntiEntropyTimer?: IntervalHandle;
  private peerProbeInFlight = false;
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
    this.peerProbeIntervalMs =
      options.peerProbeIntervalMs ?? StaticClusterNetwork.DEFAULT_PEER_PROBE_INTERVAL_MS;
    this.peerPingTimeoutMs =
      options.peerPingTimeoutMs ?? StaticClusterNetwork.DEFAULT_PEER_PING_TIMEOUT_MS;
    this.peerAntiEntropyIntervalMs =
      options.peerAntiEntropyIntervalMs ?? StaticClusterNetwork.DEFAULT_PEER_ANTI_ENTROPY_INTERVAL_MS;
    this.transport = options.transport ?? "http";
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as ClusterSocket);
    this.metrics = options.metrics ?? new NoopMetrics();
    this.timers = {
      setTimeout: options.timers?.setTimeout ?? setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
      setInterval: options.timers?.setInterval ?? setInterval,
      clearInterval: options.timers?.clearInterval ?? clearInterval
    };
    this.peerHealthObserver = options.peerHealthObserver;
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
      this.clearPendingProbe(nodeId);
      this.peerHealthSyncStateByPeerNodeId.delete(nodeId);
      channel.socket.close(1012, "cluster peer removed");
      this.channelsByNodeId.delete(nodeId);
    }

    for (const nodeId of this.pendingProbeByNodeId.keys()) {
      if (nextPeersByNodeId.has(nodeId)) {
        continue;
      }
      this.clearPendingProbe(nodeId);
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
    this.stopPeerProbes();
    for (const pending of this.pendingRequests.values()) {
      this.timers.clearTimeout(pending.timeout);
      pending.reject(new Error("Cluster network disposed"));
    }
    this.pendingRequests.clear();

    for (const channel of this.channelsByNodeId.values()) {
      channel.socket.close(1012, "cluster network disposed");
    }
    this.channelsByNodeId.clear();
  }

  disconnectPeer(nodeId: string, reason = "cluster peer disconnected"): void {
    this.clearPendingProbe(nodeId);
    const channel = this.channelsByNodeId.get(nodeId);
    if (!channel) {
      return;
    }

    try {
      channel.socket.close(1012, reason);
    } catch {}
    this.channelsByNodeId.delete(nodeId);
    this.notePeerSuspect(nodeId, reason);
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

  async broadcastPeerHealthRumor(
    snapshot: ClusterPeerHealthSnapshot,
    options: {
      excludeNodeIds?: string[];
    } = {}
  ): Promise<void> {
    if (this.transport !== "ws" || snapshot.status === "unknown") {
      return;
    }

    const rumor = this.toPeerHealthRumor(snapshot);
    const excludedNodeIds = new Set(options.excludeNodeIds ?? []);
    await Promise.allSettled(
      this.listPeers()
        .filter((peer) => !excludedNodeIds.has(peer.nodeId))
        .map(async (peer) => {
          try {
            const channel = await this.ensureChannel(peer.nodeId);
            await this.sendMessage(
              channel.socket,
              JSON.stringify({
                type: "peerHealthRumor",
                peerNodeId: rumor.nodeId,
                status: rumor.status,
                incarnation: rumor.incarnation,
                lastAliveAt: rumor.lastAliveAt
              } satisfies ClusterMessage)
            );
            this.metrics.increment("cluster.peer_health_rumor_out");
          } catch {
            return;
          }
        })
    );
  }

  async broadcastPeerHealthSync(
    snapshots: ClusterPeerHealthSnapshot[],
    options: {
      excludeNodeIds?: string[];
    } = {}
  ): Promise<void> {
    if (this.transport !== "ws") {
      return;
    }

    const eligibleSnapshots = snapshots.filter((snapshot) => snapshot.status !== "unknown");
    if (eligibleSnapshots.length === 0) {
      return;
    }

    const excludedNodeIds = new Set(options.excludeNodeIds ?? []);
    await Promise.allSettled(
      this.listPeers()
        .filter((peer) => !excludedNodeIds.has(peer.nodeId))
        .map(async (peer) => {
          const rumors = this.buildIncrementalPeerHealthSync(peer.nodeId, eligibleSnapshots);
          if (rumors.length === 0) {
            this.metrics.increment("cluster.peer_health_sync_skip");
            return;
          }

          try {
            const channel = await this.ensureChannel(peer.nodeId);
            await this.sendMessage(
              channel.socket,
              JSON.stringify({
                type: "peerHealthSync",
                rumors
              } satisfies ClusterMessage)
            );
            this.recordPeerHealthSync(peer.nodeId, rumors);
            this.metrics.increment("cluster.peer_health_sync_out");
            this.metrics.increment("cluster.peer_health_sync_item_out", rumors.length);
          } catch {
            return;
          }
        })
    );
  }

  startPeerProbes(): void {
    if (this.transport !== "ws" || this.peerProbeTimer !== undefined) {
      return;
    }

    this.peerProbeTimer = this.timers.setInterval(() => {
      void this.runPeerProbes();
    }, this.peerProbeIntervalMs);
    void this.runPeerProbes();

    if (this.peerAntiEntropyIntervalMs > 0 && this.peerAntiEntropyTimer === undefined) {
      this.peerAntiEntropyTimer = this.timers.setInterval(() => {
        void this.runPeerHealthSync();
      }, this.peerAntiEntropyIntervalMs);
      void this.runPeerHealthSync();
    }
  }

  stopPeerProbes(): void {
    if (this.peerProbeTimer !== undefined) {
      this.timers.clearInterval(this.peerProbeTimer);
      this.peerProbeTimer = undefined;
    }
    if (this.peerAntiEntropyTimer !== undefined) {
      this.timers.clearInterval(this.peerAntiEntropyTimer);
      this.peerAntiEntropyTimer = undefined;
    }

    for (const nodeId of this.pendingProbeByNodeId.keys()) {
      this.clearPendingProbe(nodeId);
    }
  }

  private async runPeerProbes(): Promise<void> {
    if (this.peerProbeInFlight) {
      return;
    }

    this.peerProbeInFlight = true;
    try {
      await Promise.allSettled(
        this.listPeers().map(async (peer) => {
          await this.probePeer(peer.nodeId);
        })
      );
    } finally {
      this.peerProbeInFlight = false;
    }
  }

  private async probePeer(nodeId: string): Promise<void> {
    if (this.pendingProbeByNodeId.has(nodeId)) {
      return;
    }

    try {
      const channel = await this.ensureChannel(nodeId);
      const ts = Date.now();
      const timeout = this.timers.setTimeout(() => {
        this.pendingProbeByNodeId.delete(nodeId);
        this.metrics.increment("cluster.probe_timeout");
        this.notePeerSuspect(nodeId, "probe_timeout");
      }, this.peerPingTimeoutMs);
      this.pendingProbeByNodeId.set(nodeId, { ts, timeout });
      await this.sendMessage(
        channel.socket,
        JSON.stringify({
          type: "ping",
          ts
        } satisfies ClusterMessage)
      );
    } catch (error) {
      this.notePeerSuspect(nodeId, error instanceof Error ? error.message : String(error));
    }
  }

  private async runPeerHealthSync(): Promise<void> {
    const snapshots = this.options.peerHealthSnapshotProvider?.() ?? [];
    await this.broadcastPeerHealthSync(snapshots);
  }

  private clearPendingProbe(nodeId: string): void {
    const pendingProbe = this.pendingProbeByNodeId.get(nodeId);
    if (!pendingProbe) {
      return;
    }

    this.timers.clearTimeout(pendingProbe.timeout);
    this.pendingProbeByNodeId.delete(nodeId);
  }

  private notePeerAlive(nodeId: string, detail?: string): void {
    this.clearPendingProbe(nodeId);
    this.peerHealthObserver?.markAlive(nodeId, detail);
  }

  private notePeerSuspect(nodeId: string, detail?: string): void {
    this.clearPendingProbe(nodeId);
    this.peerHealthObserver?.markSuspect(nodeId, detail);
  }

  private toPeerHealthRumor(snapshot: ClusterPeerHealthSnapshot): ClusterPeerHealthRumor {
    return {
      nodeId: snapshot.nodeId,
      status: snapshot.status as Exclude<ClusterPeerHealthStatus, "unknown">,
      incarnation: snapshot.incarnation,
      lastAliveAt: snapshot.lastAliveAt
    };
  }

  private buildIncrementalPeerHealthSync(
    peerNodeId: string,
    snapshots: ClusterPeerHealthSnapshot[]
  ): ClusterPeerHealthSyncRumor[] {
    const lastSentByNodeId = this.peerHealthSyncStateByPeerNodeId.get(peerNodeId);
    return snapshots
      .map((snapshot) => ({
        peerNodeId: snapshot.nodeId,
        status: snapshot.status as Exclude<ClusterPeerHealthStatus, "unknown">,
        incarnation: snapshot.incarnation,
        lastAliveAt: snapshot.lastAliveAt
      }))
      .filter((rumor) => {
        const fingerprint = this.peerHealthSyncFingerprint(rumor);
        return lastSentByNodeId?.get(rumor.peerNodeId) !== fingerprint;
      });
  }

  private recordPeerHealthSync(peerNodeId: string, rumors: ClusterPeerHealthSyncRumor[]): void {
    const peerState = this.peerHealthSyncStateByPeerNodeId.get(peerNodeId) ?? new Map<string, string>();
    for (const rumor of rumors) {
      peerState.set(rumor.peerNodeId, this.peerHealthSyncFingerprint(rumor));
    }
    this.peerHealthSyncStateByPeerNodeId.set(peerNodeId, peerState);
  }

  private peerHealthSyncFingerprint(rumor: ClusterPeerHealthSyncRumor): string {
    return `${rumor.status}:${rumor.incarnation}:${rumor.lastAliveAt ?? ""}`;
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
      const timeout = this.timers.setTimeout(() => {
        this.pendingRequests.delete(ref);
        this.metrics.increment("cluster.request_timeout");
        this.notePeerSuspect(nodeId, `request_timeout:${payload.type}`);
        reject(new Error(`Cluster request timed out: ${payload.type} -> ${nodeId}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(ref, {
        nodeId,
        resolve,
        reject,
        timeout
      });

      void this.sendMessage(channel.socket, JSON.stringify({ ...payload, ref })).catch((error) => {
        this.timers.clearTimeout(timeout);
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
        this.timers.clearTimeout(connectTimer);
        this.connectingByNodeId.delete(nodeId);
        try {
          socket.close(1013, message);
        } catch {}
        this.notePeerSuspect(nodeId, message);
        reject(new Error(message));
      };
      const finishResolve = (channel: ClusterChannel) => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(connectTimer);
        this.connectingByNodeId.delete(nodeId);
        resolve(channel);
      };
      const connectTimer = this.timers.setTimeout(() => {
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
            this.notePeerAlive(nodeId, "hello_ack");
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
        this.notePeerAlive(message.nodeId, "hello");
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
        this.notePeerAlive(message.nodeId, "hello_ack");
        hooks.onHelloAck?.(message.nodeId);
        return;
      case "ping":
        if (remoteNodeId) {
          this.notePeerAlive(remoteNodeId, "ping");
        }
        await this.sendMessage(socket, JSON.stringify({ type: "pong", ts: message.ts } satisfies ClusterMessage));
        return;
      case "pong":
        if (remoteNodeId) {
          this.notePeerAlive(remoteNodeId, "pong");
        }
        return;
      case "peerHealthRumor":
        if (remoteNodeId) {
          this.notePeerAlive(remoteNodeId, "peer_health_rumor");
          const applied = this.peerHealthObserver?.applyRumor?.(
            {
              nodeId: message.peerNodeId,
              status: message.status,
              incarnation: message.incarnation,
              lastAliveAt: message.lastAliveAt
            },
            remoteNodeId
          );
          this.metrics.increment("cluster.peer_health_rumor_in");
          this.metrics.increment(
            applied === false ? "cluster.peer_health_rumor_ignored" : "cluster.peer_health_rumor_applied"
          );
        }
        return;
      case "peerHealthSync":
        if (remoteNodeId) {
          this.notePeerAlive(remoteNodeId, "peer_health_sync");
          for (const rumor of message.rumors) {
            const applied = this.peerHealthObserver?.applyRumor?.(
              {
                nodeId: rumor.peerNodeId,
                status: rumor.status,
                incarnation: rumor.incarnation,
                lastAliveAt: rumor.lastAliveAt
              },
              remoteNodeId
            );
            this.metrics.increment(
              applied === false ? "cluster.peer_health_sync_item_ignored" : "cluster.peer_health_sync_item_applied"
            );
          }
          this.metrics.increment("cluster.peer_health_sync_in");
          this.metrics.increment("cluster.peer_health_sync_item_in", message.rumors.length);
        }
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

        this.timers.clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.ref);
        if (message.error) {
          this.metrics.increment("cluster.deliver_error");
          this.notePeerSuspect(pending.nodeId, `deliver_error:${message.error}`);
          pending.reject(new Error(message.error));
          return;
        }

        this.notePeerAlive(pending.nodeId, "deliver_result");
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

        this.timers.clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.ref);
        if (!message.ok) {
          this.metrics.increment("cluster.handle_ack_error");
          this.notePeerSuspect(
            pending.nodeId,
            `handle_ack_error:${message.error ?? "unknown"}`
          );
          pending.reject(new Error(message.error ?? "Cluster handleAck failed"));
          return;
        }

        this.notePeerAlive(pending.nodeId, "handle_ack_result");
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

    this.peerHealthSyncStateByPeerNodeId.delete(channel.nodeId);
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
      this.timers.clearTimeout(drainTimer);
      this.outboundDrainTimerBySocket.delete(socket);
    }
    this.outboundDrainScheduled.delete(socket);

    const nodeId = this.nodeIdBySocket.get(socket);
    if (nodeId) {
      this.clearPendingProbe(nodeId);
      this.peerHealthSyncStateByPeerNodeId.delete(nodeId);
      this.metrics.increment("cluster.channel_closed");
      this.notePeerSuspect(nodeId, "channel_closed");
      const current = this.channelsByNodeId.get(nodeId);
      if (current?.socket === socket) {
        this.channelsByNodeId.delete(nodeId);
      }
      this.nodeIdBySocket.delete(socket);
    }

    for (const [ref, pending] of this.pendingRequests.entries()) {
      if (pending.nodeId === nodeId) {
        this.timers.clearTimeout(pending.timeout);
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
    const timeout = this.timers.setTimeout(() => controller.abort(), this.requestTimeoutMs);

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
        this.notePeerSuspect(peer.nodeId, `http_${response.status}`);
        throw new Error(`Cluster request failed: ${peer.nodeId} ${path} ${response.status}`);
      }

      this.notePeerAlive(peer.nodeId, `http_${path}`);
      return response;
    } catch (error) {
      this.notePeerSuspect(
        peer.nodeId,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
      this.timers.clearTimeout(timeout);
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

    const timer = this.timers.setTimeout(() => {
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
        this.timers.setTimeout(resolve, this.outboundBackpressureRetryMs);
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
