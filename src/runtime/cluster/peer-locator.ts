import type { ConnRef, PeerLocator } from "../../shared/types.ts";
import { StaticClusterNetwork } from "./network.ts";

interface CacheEntry {
  expiresAt: number;
  conns: ConnRef[];
}

export class DistributedPeerLocator implements PeerLocator {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly localPeerLocator: PeerLocator,
    private readonly clusterNetwork?: StaticClusterNetwork,
    private readonly cacheTtlMs = 250,
    private readonly now = () => Date.now()
  ) {}

  async find(peerId: string): Promise<ConnRef[]> {
    return (await this.findMany([peerId])).get(peerId) ?? [];
  }

  async findMany(peerIds: string[]): Promise<Map<string, ConnRef[]>> {
    const result = await this.localPeerLocator.findMany(peerIds);
    if (!this.clusterNetwork?.hasPeers()) {
      return result;
    }

    const cacheMisses: string[] = [];
    const currentTime = this.now();

    for (const peerId of peerIds) {
      const cached = this.cache.get(peerId);
      if (cached && cached.expiresAt > currentTime) {
        result.set(peerId, this.mergeConnRefs(result.get(peerId) ?? [], cached.conns));
        continue;
      }

      cacheMisses.push(peerId);
    }

    if (cacheMisses.length === 0) {
      return result;
    }

    const remote = await this.clusterNetwork.locate(cacheMisses);
    for (const peerId of cacheMisses) {
      const remoteConns = remote.get(peerId) ?? [];
      if (remoteConns.length > 0) {
        this.cache.set(peerId, {
          expiresAt: currentTime + this.cacheTtlMs,
          conns: remoteConns
        });
      } else {
        this.cache.delete(peerId);
      }
      result.set(peerId, this.mergeConnRefs(result.get(peerId) ?? [], remoteConns));
    }

    return result;
  }

  invalidate(peerId?: string): void {
    if (peerId) {
      this.cache.delete(peerId);
      return;
    }

    this.cache.clear();
  }

  private mergeConnRefs(left: ConnRef[], right: ConnRef[]): ConnRef[] {
    const merged = new Map<string, ConnRef>();
    for (const conn of [...left, ...right]) {
      merged.set(`${conn.nodeId}:${conn.connId}`, conn);
    }
    return Array.from(merged.values());
  }
}
