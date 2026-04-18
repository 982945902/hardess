type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

export type ClusterPeerHealthStatus = "unknown" | "alive" | "suspect" | "dead";
export type ClusterPeerHealthSource = "local" | "remote";

export interface ClusterPeerHealthRumor {
  nodeId: string;
  status: Exclude<ClusterPeerHealthStatus, "unknown">;
  incarnation: number;
  lastAliveAt?: number;
}

export interface ClusterPeerHealthSnapshot {
  nodeId: string;
  status: ClusterPeerHealthStatus;
  incarnation: number;
  updatedAt: number;
  lastAliveAt?: number;
  detail?: string;
  source: ClusterPeerHealthSource;
  reportedByNodeId?: string;
}

interface ClusterPeerHealthEntry extends ClusterPeerHealthSnapshot {
  deadTimer?: TimeoutHandle;
}

type ClusterPeerHealthListener = (snapshot: ClusterPeerHealthSnapshot) => void;

export interface ClusterPeerHealthStoreOptions {
  suspectTimeoutMs?: number;
  now?: () => number;
  timers?: {
    setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
    clearTimeout: (timeout: TimeoutHandle) => void;
  };
}

export class ClusterPeerHealthStore {
  private readonly entries = new Map<string, ClusterPeerHealthEntry>();
  private readonly listeners = new Set<ClusterPeerHealthListener>();
  private knownPeerNodeIds?: Set<string>;
  private readonly suspectTimeoutMs: number;
  private readonly now: () => number;
  private readonly timers: {
    setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
    clearTimeout: (timeout: TimeoutHandle) => void;
  };

  constructor(options: ClusterPeerHealthStoreOptions = {}) {
    this.suspectTimeoutMs = options.suspectTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
    this.timers = {
      setTimeout: options.timers?.setTimeout ?? setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? clearTimeout
    };
  }

  noteKnownPeers(nodeIds: string[]): void {
    const allowedNodeIds = new Set(nodeIds);
    this.knownPeerNodeIds = allowedNodeIds;
    for (const existingNodeId of this.entries.keys()) {
      if (allowedNodeIds.has(existingNodeId)) {
        continue;
      }

      const existing = this.entries.get(existingNodeId);
      if (existing?.deadTimer !== undefined) {
        this.timers.clearTimeout(existing.deadTimer);
      }
      this.entries.delete(existingNodeId);
    }
  }

  getStatus(nodeId: string): ClusterPeerHealthStatus {
    return this.entries.get(nodeId)?.status ?? "unknown";
  }

  snapshot(nodeId: string): ClusterPeerHealthSnapshot | undefined {
    const entry = this.entries.get(nodeId);
    if (!entry) {
      return undefined;
    }

    return this.toSnapshot(entry);
  }

  list(): ClusterPeerHealthSnapshot[] {
    return Array.from(this.entries.values()).map((entry) => this.toSnapshot(entry));
  }

  markAlive(nodeId: string, detail?: string): void {
    if (this.isUnknownPeer(nodeId)) {
      return;
    }

    const current = this.getOrCreateEntry(nodeId);
    const now = this.now();
    if (current.status === "alive" && current.source === "local") {
      current.lastAliveAt = now;
      current.updatedAt = now;
      current.detail = detail;
      current.reportedByNodeId = undefined;
      return;
    }

    this.applyLocalStatus(current, "alive", now, detail);
  }

  markSuspect(nodeId: string, detail?: string): void {
    if (this.isUnknownPeer(nodeId)) {
      return;
    }

    const current = this.getOrCreateEntry(nodeId);
    const now = this.now();
    if (current.status === "suspect" && current.source === "local") {
      current.updatedAt = now;
      current.detail = detail;
      current.reportedByNodeId = undefined;
    } else {
      this.applyLocalStatus(current, "suspect", now, detail);
    }

    this.ensureSuspectTimer(nodeId, detail);
  }

  markDead(nodeId: string, detail?: string): void {
    if (this.isUnknownPeer(nodeId)) {
      return;
    }

    const current = this.getOrCreateEntry(nodeId);
    const now = this.now();
    if (current.status === "dead" && current.source === "local" && current.detail === detail) {
      current.updatedAt = now;
      return;
    }

    this.applyLocalStatus(current, "dead", now, detail);
  }

  applyRumor(rumor: ClusterPeerHealthRumor, reportedByNodeId: string): boolean {
    if (this.isUnknownPeer(rumor.nodeId)) {
      return false;
    }

    const current = this.getOrCreateEntry(rumor.nodeId);
    if (!this.shouldApplyRumor(current, rumor)) {
      if (
        current.status === rumor.status &&
        rumor.lastAliveAt !== undefined &&
        rumor.lastAliveAt > (current.lastAliveAt ?? 0)
      ) {
        current.lastAliveAt = rumor.lastAliveAt;
        current.updatedAt = this.now();
        current.source = "remote";
        current.reportedByNodeId = reportedByNodeId;
        current.detail = `gossip:${reportedByNodeId}`;
      }
      return false;
    }

    this.clearDeadTimer(current);
    current.status = rumor.status;
    current.incarnation = rumor.incarnation;
    current.updatedAt = this.now();
    current.lastAliveAt = rumor.status === "alive"
      ? rumor.lastAliveAt ?? current.lastAliveAt ?? current.updatedAt
      : current.lastAliveAt;
    current.detail = `gossip:${reportedByNodeId}`;
    current.source = "remote";
    current.reportedByNodeId = reportedByNodeId;

    if (rumor.status === "suspect") {
      this.ensureSuspectTimer(rumor.nodeId, current.detail);
    }

    this.emit(current);
    return true;
  }

  subscribe(listener: ClusterPeerHealthListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.deadTimer !== undefined) {
        this.timers.clearTimeout(entry.deadTimer);
      }
    }
    this.entries.clear();
  }

  private getOrCreateEntry(nodeId: string): ClusterPeerHealthEntry {
    const existing = this.entries.get(nodeId);
    if (existing) {
      return existing;
    }

    const created: ClusterPeerHealthEntry = {
      nodeId,
      status: "unknown",
      incarnation: 0,
      updatedAt: this.now(),
      source: "local"
    };
    this.entries.set(nodeId, created);
    return created;
  }

  private isUnknownPeer(nodeId: string): boolean {
    return this.knownPeerNodeIds !== undefined && !this.knownPeerNodeIds.has(nodeId);
  }

  private toSnapshot(entry: ClusterPeerHealthEntry): ClusterPeerHealthSnapshot {
    return {
      nodeId: entry.nodeId,
      status: entry.status,
      incarnation: entry.incarnation,
      updatedAt: entry.updatedAt,
      lastAliveAt: entry.lastAliveAt,
      detail: entry.detail,
      source: entry.source,
      reportedByNodeId: entry.reportedByNodeId
    };
  }

  private emit(entry: ClusterPeerHealthEntry): void {
    const snapshot = this.toSnapshot(entry);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private applyLocalStatus(
    entry: ClusterPeerHealthEntry,
    status: Exclude<ClusterPeerHealthStatus, "unknown">,
    now: number,
    detail?: string
  ): void {
    this.clearDeadTimer(entry);
    entry.status = status;
    entry.incarnation += 1;
    entry.updatedAt = now;
    entry.detail = detail;
    entry.source = "local";
    entry.reportedByNodeId = undefined;
    if (status === "alive") {
      entry.lastAliveAt = now;
    }
    this.emit(entry);
  }

  private ensureSuspectTimer(nodeId: string, detail?: string): void {
    const current = this.entries.get(nodeId);
    if (!current || current.deadTimer !== undefined) {
      return;
    }

    current.deadTimer = this.timers.setTimeout(() => {
      const latest = this.entries.get(nodeId);
      if (!latest || latest.status !== "suspect") {
        return;
      }
      latest.deadTimer = undefined;
      this.markDead(nodeId, detail ?? "suspect_timeout");
    }, this.suspectTimeoutMs);
  }

  private clearDeadTimer(entry: ClusterPeerHealthEntry): void {
    if (entry.deadTimer === undefined) {
      return;
    }

    this.timers.clearTimeout(entry.deadTimer);
    entry.deadTimer = undefined;
  }

  private shouldApplyRumor(
    current: ClusterPeerHealthEntry,
    rumor: ClusterPeerHealthRumor
  ): boolean {
    if (current.status === "unknown") {
      return true;
    }
    if (rumor.incarnation > current.incarnation) {
      return true;
    }
    if (rumor.incarnation < current.incarnation) {
      return false;
    }
    if (current.source === "local") {
      return false;
    }

    return this.statusRank(rumor.status) > this.statusRank(current.status);
  }

  private statusRank(status: ClusterPeerHealthStatus): number {
    switch (status) {
      case "dead":
        return 3;
      case "suspect":
        return 2;
      case "alive":
        return 1;
      default:
        return 0;
    }
  }
}
