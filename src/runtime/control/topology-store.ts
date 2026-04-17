import type { ClusterPeerNode } from "../cluster/network.ts";
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

  listClusterPeers(selfNodeId?: string): ClusterPeerNode[] {
    const peers = new Map<string, ClusterPeerNode>();
    for (const host of this.topology?.membership.hosts ?? []) {
      if (!host.nodeId || host.state === "offline" || host.nodeId === selfNodeId) {
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
    const readyTargets = this.buildRouteTargets(match.route.ownerHostIds, match.route.pathPrefix, match.route.routeId, hostsById)
      .filter((target) => target.nodeId !== input.selfNodeId)
      .filter((target) => target.host.state === "ready");
    if (readyTargets.length > 0) {
      return this.pickTarget(readyTargets, input.traceKey);
    }

    const drainingTargets = this.buildRouteTargets(match.route.ownerHostIds, match.route.pathPrefix, match.route.routeId, hostsById)
      .filter((target) => target.nodeId !== input.selfNodeId)
      .filter((target) => target.host.state === "draining");
    if (drainingTargets.length > 0) {
      return this.pickTarget(drainingTargets, input.traceKey);
    }

    return undefined;
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
