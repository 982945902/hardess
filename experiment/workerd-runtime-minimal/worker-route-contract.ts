import type { ResolvedRouteEntry, RuntimeRouteDispatchMode } from "./worker-types.ts";

export interface WorkerRuntimeRouteExplain {
  routeId: string;
  routePathPrefix: string;
  actionId: string;
  routeActionKind: "http" | "websocket";
  routeDispatchMode: RuntimeRouteDispatchMode;
}

export function toWorkerRuntimeRouteExplain(route: ResolvedRouteEntry): WorkerRuntimeRouteExplain {
  return {
    routeId: route.routeId,
    routePathPrefix: route.pathPrefix,
    actionId: route.actionId,
    routeActionKind: route.actionKind,
    routeDispatchMode: route.dispatchMode,
  };
}

export interface WorkerRuntimeRouteWithMethods extends WorkerRuntimeRouteExplain {
  methods: string[];
}

export interface WorkerRuntimeRouteWithPolicy extends WorkerRuntimeRouteWithMethods {
  websocketEnabled: boolean;
}
