import type { ConnRef, PeerLocator } from "../../shared/types.ts";

export class InMemoryPeerLocator implements PeerLocator {
  private readonly connsByPeer = new Map<string, Map<string, ConnRef>>();
  private readonly connsById = new Map<string, ConnRef>();

  register(connRef: ConnRef): void {
    const existing = this.connsById.get(connRef.connId);
    if (existing && existing.peerId !== connRef.peerId) {
      const existingPeerConns = this.connsByPeer.get(existing.peerId);
      existingPeerConns?.delete(existing.connId);
      if (existingPeerConns && existingPeerConns.size === 0) {
        this.connsByPeer.delete(existing.peerId);
      }
    }

    this.connsById.set(connRef.connId, connRef);

    let peerConns = this.connsByPeer.get(connRef.peerId);
    if (!peerConns) {
      peerConns = new Map<string, ConnRef>();
      this.connsByPeer.set(connRef.peerId, peerConns);
    }

    peerConns.set(connRef.connId, connRef);
  }

  unregister(connId: string): void {
    const connRef = this.connsById.get(connId);
    if (!connRef) {
      return;
    }

    this.connsById.delete(connId);

    const peerConns = this.connsByPeer.get(connRef.peerId);
    if (!peerConns) {
      return;
    }

    peerConns.delete(connId);
    if (peerConns.size === 0) {
      this.connsByPeer.delete(connRef.peerId);
    }
  }

  getByConnId(connId: string): ConnRef | undefined {
    return this.connsById.get(connId);
  }

  countConnections(): number {
    return this.connsById.size;
  }

  countConnectionsForPeer(peerId: string): number {
    return this.connsByPeer.get(peerId)?.size ?? 0;
  }

  async find(peerId: string): Promise<ConnRef[]> {
    return Array.from(this.connsByPeer.get(peerId)?.values() ?? []);
  }

  async findMany(peerIds: string[]): Promise<Map<string, ConnRef[]>> {
    const result = new Map<string, ConnRef[]>();
    for (const peerId of peerIds) {
      result.set(peerId, await this.find(peerId));
    }
    return result;
  }
}
