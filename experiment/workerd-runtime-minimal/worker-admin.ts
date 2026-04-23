import {
  WORKER_RUNTIME_ADMIN_ENDPOINTS,
  WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
  WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
  WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
  WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
} from "./worker-admin-contract.ts";
import { toWorkerRuntimeRouteExplain } from "./worker-route-contract.ts";
import { json } from "./worker-response.ts";
import type { Env, ResolvedRouteEntry, RuntimeDispatchDiagnostics, RuntimeStateSnapshot } from "./worker-types.ts";
import type {
  WorkerRuntimeAdminBaseResponse,
  WorkerRuntimeAdminErrorResponse,
  WorkerRuntimeAdminResponse,
  WorkerRuntimeAdminRoute,
  WorkerRuntimeAdminRoutesResponse,
  WorkerRuntimeAdminStatsResponse,
  WorkerRuntimeAdminSuccessResponse,
} from "./worker-admin-contract.ts";

export interface RuntimeAdminContext {
  request: Request;
  env: Env;
  url: URL;
  requestSequence: number;
  routes: ResolvedRouteEntry[];
  dispatchDiagnostics: RuntimeDispatchDiagnostics;
  snapshot: (requestSequence: number) => RuntimeStateSnapshot;
}

function runtimeRoutes(
  routes: ResolvedRouteEntry[],
  dispatchDiagnostics: RuntimeDispatchDiagnostics,
): WorkerRuntimeAdminRoute[] {
  return routes.map((route) => ({
    ...toWorkerRuntimeRouteExplain({
      ...route,
      dispatchMode: dispatchDiagnostics.routeDispatchModes[route.routeId],
    }),
    methods: route.methods,
    websocketEnabled: route.websocketEnabled,
  }));
}

function runtimeAdminBase(
  env: Env,
  url: URL,
  dispatchDiagnostics: RuntimeDispatchDiagnostics,
): WorkerRuntimeAdminBaseResponse {
  return {
    ok: true,
    schemaVersion: WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
    path: url.pathname,
    dispatchSource: "worker_runtime_admin",
    assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
    deploymentId: env.HARDESS_ASSIGNMENT_META.deploymentId,
    declaredVersion: env.HARDESS_ASSIGNMENT_META.declaredVersion,
    manifestId: env.HARDESS_ASSIGNMENT_META.manifestId,
    protocolPackageId: env.HARDESS_RESOLVED_RUNTIME_MODEL.protocolPackage.packageId,
    resolvedListenAddress: env.HARDESS_RESOLVED_RUNTIME_MODEL.runtime.listenAddress,
    resolvedBoundActionIds: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.boundActionIds,
    resolvedUnboundProtocolActionIds: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.unboundProtocolActionIds,
    registeredActionIds: dispatchDiagnostics.registeredActionIds,
    dispatchableActionIds: dispatchDiagnostics.dispatchableActionIds,
    unhandledActionIds: dispatchDiagnostics.unhandledActionIds,
    unhandledRouteIds: dispatchDiagnostics.unhandledRouteIds,
  };
}

export function handleRuntimeAdmin({
  request,
  env,
  url,
  requestSequence,
  routes,
  dispatchDiagnostics,
  snapshot,
}: RuntimeAdminContext): Response {
  if (request.method !== "GET") {
    const payload: WorkerRuntimeAdminErrorResponse = {
      ok: false,
      schemaVersion: WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
      error: "method_not_allowed",
      endpoint: url.pathname,
      method: request.method,
      allowedMethods: ["GET"],
      workerRuntime: snapshot(requestSequence),
    };
    return json(payload, { status: 405 });
  }

  if (url.pathname === "/_hardess/runtime/stats") {
    const payload: WorkerRuntimeAdminStatsResponse = {
      ...runtimeAdminBase(env, url, dispatchDiagnostics),
      endpoint: WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
      view: "stats",
      workerRuntime: snapshot(requestSequence),
    };
    return json(payload);
  }

  if (url.pathname === "/_hardess/runtime/routes") {
    const payload: WorkerRuntimeAdminRoutesResponse = {
      ...runtimeAdminBase(env, url, dispatchDiagnostics),
      endpoint: WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
      view: "routes",
      routeCount: routes.length,
      routes: runtimeRoutes(routes, dispatchDiagnostics),
      workerRuntime: snapshot(requestSequence),
    };
    return json(payload);
  }

  if (url.pathname !== "/_hardess/runtime") {
    const payload: WorkerRuntimeAdminErrorResponse = {
      ok: false,
      schemaVersion: WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
      error: "runtime_admin_endpoint_not_found",
      endpoint: url.pathname,
      allowedEndpoints: WORKER_RUNTIME_ADMIN_ENDPOINTS,
      workerRuntime: snapshot(requestSequence),
    };
    return json(payload, { status: 404 });
  }

  const payload: WorkerRuntimeAdminSuccessResponse = {
    ...runtimeAdminBase(env, url, dispatchDiagnostics),
    endpoint: WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
    view: "overview",
    availableEndpoints: WORKER_RUNTIME_ADMIN_ENDPOINTS,
    routeCount: routes.length,
    routes: runtimeRoutes(routes, dispatchDiagnostics),
    workerRuntime: snapshot(requestSequence),
  };
  return json(payload satisfies WorkerRuntimeAdminResponse);
}
