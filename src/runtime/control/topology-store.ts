import type { ClusterPeerNode } from "../cluster/network.ts";
import type { ClusterPeerHealthStatus } from "../cluster/health.ts";
import type { DesiredTopology, MembershipHost } from "../../shared/index.ts";

type TopologyListener = (topology: DesiredTopology | undefined) => void;

export interface ResolvedHttpRouteTarget {
  hostId: string;
  nodeId?: string;
  baseUrl: string;
  pathPrefix: string;
  routeId: string;
}

export class RuntimeTopologyStore {
  private topology?: DesiredTopology;
  private readonly listeners = new Set<TopologyListener>();
  private readonly runtimePeerHealthByNodeId = new Map<string, ClusterPeerHealthStatus>();

  setTopology(topology: DesiredTopology | undefined): void {
    this.topology = topology;
    for (const listener of this.listeners) {
      listener(this.topology);
    }
  }

  getTopology(): DesiredTopology | undefined {
    return this.topology;
  }

  subscribe(listener: TopologyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setRuntimePeerHealth(nodeId: string, status: ClusterPeerHealthStatus): void {
    this.runtimePeerHealthByNodeId.set(nodeId, status);
  }

  clearRuntimePeerHealth(nodeIds: string[]): void {
    const allowedNodeIds = new Set(nodeIds);
    for (const nodeId of this.runtimePeerHealthByNodeId.keys()) {
      if (allowedNodeIds.has(nodeId)) {
        continue;
      }
      this.runtimePeerHealthByNodeId.delete(nodeId);
    }
  }

  listClusterPeers(selfNodeId?: string): ClusterPeerNode[] {
    return this.buildClusterPeers(selfNodeId);
  }

  listClusterPeerNodeIds(
    selfNodeId?: string,
    scope?: {
      groupId?: string;
    }
  ): string[] | undefined {
    const allowedHostIds = scope ? this.resolveAllowedHostIdsForGroup(scope.groupId) : undefined;
    const peers = this.buildClusterPeers(selfNodeId, allowedHostIds);
    const effectivePeers = peers.filter((peer) => this.peerStatus(peer.nodeId) !== "dead");
    if (peers.length > 0) {
      return effectivePeers.map((peer) => peer.nodeId);
    }

    return allowedHostIds === undefined ? undefined : [];
  }

  private buildClusterPeers(
    selfNodeId?: string,
    allowedHostIds?: Set<string>
  ): ClusterPeerNode[] {
    const peers = new Map<string, ClusterPeerNode>();
    for (const host of this.topology?.membership.hosts ?? []) {
      if (!host.nodeId || host.state === "offline" || host.nodeId === selfNodeId) {
        continue;
      }
      if (allowedHostIds && !allowedHostIds.has(host.hostId)) {
        continue;
      }

      const baseUrl = host.internalBaseUrl ?? host.publicBaseUrl;
      if (!baseUrl) {
        continue;
      }

      peers.set(host.nodeId, {
        nodeId: host.nodeId,
        baseUrl
      });
    }

    return Array.from(peers.values()).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  private resolveAllowedHostIdsForGroup(groupId?: string): Set<string> | undefined {
    const hosts = this.topology?.membership.hosts ?? [];
    if (hosts.length === 0) {
      return undefined;
    }

    const ownerHostIds = new Set<string>();
    let matched = false;
    for (const host of hosts) {
      if (host.groupId !== groupId) {
        continue;
      }
      matched = true;
      ownerHostIds.add(host.hostId);
    }

    if (!matched) {
      return new Set<string>();
    }

    return ownerHostIds;
  }

  resolveHttpRouteTarget(input: {
    pathname: string;
    selfNodeId?: string;
    traceKey?: string;
  }): ResolvedHttpRouteTarget | undefined {
    const match = this.findBestRoute(input.pathname);
    if (!match) {
      return undefined;
    }

    const hostsById = new Map(
      (this.topology?.membership.hosts ?? []).map((host) => [host.hostId, host] as const)
    );
    const routeTargets = this.buildRouteTargets(match.route.ownerHostIds, match.route.pathPrefix, match.route.routeId, hostsById)
      .filter((target) => target.nodeId !== input.selfNodeId)
      .filter((target) => this.peerStatus(target.nodeId) !== "dead");
    const readyTargets = routeTargets
      .filter((target) => target.host.state === "ready")
      .filter((target) => this.peerStatus(target.nodeId) !== "suspect");
    if (readyTargets.length > 0) {
      return this.pickTarget(readyTargets, input.traceKey);
    }

    const suspectReadyTargets = routeTargets
      .filter((target) => target.host.state === "ready")
      .filter((target) => this.peerStatus(target.nodeId) === "suspect");
    if (suspectReadyTargets.length > 0) {
      return this.pickTarget(suspectReadyTargets, input.traceKey);
    }

    const drainingTargets = routeTargets
      .filter((target) => target.nodeId !== input.selfNodeId)
      .filter((target) => target.host.state === "draining")
      .filter((target) => this.peerStatus(target.nodeId) !== "suspect");
    if (drainingTargets.length > 0) {
      return this.pickTarget(drainingTargets, input.traceKey);
    }

    const suspectDrainingTargets = routeTargets
      .filter((target) => target.host.state === "draining")
      .filter((target) => this.peerStatus(target.nodeId) === "suspect");
    if (suspectDrainingTargets.length > 0) {
      return this.pickTarget(suspectDrainingTargets, input.traceKey);
    }

    return undefined;
  }

  private peerStatus(nodeId?: string): ClusterPeerHealthStatus {
    if (!nodeId) {
      return "unknown";
    }
    return this.runtimePeerHealthByNodeId.get(nodeId) ?? "unknown";
  }

  private findBestRoute(pathname: string):
    | {
        route: NonNullable<DesiredTopology["placement"]["deployments"][number]["routes"]>[number];
      }
    | undefined {
    let bestMatch:
      | {
          route: NonNullable<DesiredTopology["placement"]["deployments"][number]["routes"]>[number];
        }
      | undefined;

    for (const deployment of this.topology?.placement.deployments ?? []) {
      for (const route of deployment.routes) {
        if (!pathname.startsWith(route.pathPrefix)) {
          continue;
        }

        if (!bestMatch || route.pathPrefix.length > bestMatch.route.pathPrefix.length) {
          bestMatch = { route };
        }
      }
    }

    return bestMatch;
  }

  private buildRouteTargets(
    ownerHostIds: string[],
    pathPrefix: string,
    routeId: string,
    hostsById: Map<string, MembershipHost>
  ): Array<ResolvedHttpRouteTarget & { host: MembershipHost }> {
    const targets: Array<ResolvedHttpRouteTarget & { host: MembershipHost }> = [];
    for (const hostId of ownerHostIds) {
      const host = hostsById.get(hostId);
      if (!host) {
        continue;
      }
      const baseUrl = host.internalBaseUrl ?? host.publicBaseUrl;
      if (!baseUrl) {
        continue;
      }
      targets.push({
        hostId,
        nodeId: host.nodeId,
        baseUrl,
        pathPrefix,
        routeId,
        host
      });
    }
    return targets;
  }

  private pickTarget(
    targets: Array<ResolvedHttpRouteTarget & { host: MembershipHost }>,
    traceKey?: string
  ): ResolvedHttpRouteTarget {
    const sortedTargets = targets
      .slice()
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
    const index = sortedTargets.length === 1
      ? 0
      : stableHash(traceKey ?? `${sortedTargets[0]?.routeId ?? ""}:${sortedTargets.length}`) % sortedTargets.length;
    const picked = sortedTargets[index] ?? sortedTargets[0]!;
    return {
      hostId: picked.hostId,
      nodeId: picked.nodeId,
      baseUrl: picked.baseUrl,
      pathPrefix: picked.pathPrefix,
      routeId: picked.routeId
    };
  }
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
