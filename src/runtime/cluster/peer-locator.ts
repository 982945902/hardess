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
    private readonly now = () => Date.now(),
    private readonly resolveLocateNodeIds?: (scope?: { groupId?: string }) => string[] | undefined
  ) {}

  async find(peerId: string, options?: { groupId?: string }): Promise<ConnRef[]> {
    return (await this.findMany([peerId], options)).get(peerId) ?? [];
  }

  async findMany(peerIds: string[], options?: { groupId?: string }): Promise<Map<string, ConnRef[]>> {
    const result = await this.localPeerLocator.findMany(peerIds, options);
    if (!this.clusterNetwork?.hasPeers()) {
      return result;
    }

    const cacheMisses: string[] = [];
    const currentTime = this.now();

    for (const peerId of peerIds) {
      const cached = this.cache.get(this.cacheKey(peerId, options));
      if (cached && cached.expiresAt > currentTime) {
        result.set(peerId, this.mergeConnRefs(result.get(peerId) ?? [], cached.conns));
        continue;
      }

      cacheMisses.push(peerId);
    }

    if (cacheMisses.length === 0) {
      return result;
    }

    const remote = await this.clusterNetwork.locate(cacheMisses, {
      groupId: options?.groupId,
      nodeIds: this.resolveLocateNodeIds?.(options)
    });
    for (const peerId of cacheMisses) {
      const remoteConns = remote.get(peerId) ?? [];
      const cacheKey = this.cacheKey(peerId, options);
      if (remoteConns.length > 0) {
        this.cache.set(cacheKey, {
          expiresAt: currentTime + this.cacheTtlMs,
          conns: remoteConns
        });
      } else {
        this.cache.delete(cacheKey);
      }
      result.set(peerId, this.mergeConnRefs(result.get(peerId) ?? [], remoteConns));
    }

    return result;
  }

  invalidate(peerId?: string): void {
    if (peerId) {
      for (const key of this.cache.keys()) {
        if (key.endsWith(`:${peerId}`)) {
          this.cache.delete(key);
        }
      }
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

  private cacheKey(peerId: string, options?: { groupId?: string }): string {
    if (options === undefined) {
      return `*:${peerId}`;
    }

    return `${options.groupId ?? "__default__"}:${peerId}`;
  }
}
