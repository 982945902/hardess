import {
  WORKER_RUNTIME_ADMIN_ENDPOINTS,
  WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
  WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
  WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
  WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
} from "./worker-admin-contract.ts";
import { json } from "./worker-response.ts";
import type { Env, ResolvedRouteEntry, RuntimeStateSnapshot } from "./worker-types.ts";

export interface RuntimeAdminContext {
  request: Request;
  env: Env;
  url: URL;
  requestSequence: number;
  routes: ResolvedRouteEntry[];
  registeredActionIds: string[];
  snapshot: (requestSequence: number) => RuntimeStateSnapshot;
}

function runtimeRoutes(routes: ResolvedRouteEntry[]) {
  return routes.map((route) => ({
    routeId: route.routeId,
    pathPrefix: route.pathPrefix,
    actionId: route.actionId,
    actionKind: route.actionKind,
    methods: route.methods,
    websocketEnabled: route.websocketEnabled,
  }));
}

function runtimeAdminBase(env: Env, url: URL) {
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
  };
}

export function handleRuntimeAdmin({
  request,
  env,
  url,
  requestSequence,
  routes,
  registeredActionIds,
  snapshot,
}: RuntimeAdminContext): Response {
  if (request.method !== "GET") {
    return json(
      {
        ok: false,
        schemaVersion: WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
        error: "method_not_allowed",
        endpoint: url.pathname,
        method: request.method,
        allowedMethods: ["GET"],
        workerRuntime: snapshot(requestSequence),
      },
      { status: 405 },
    );
  }

  if (url.pathname === "/_hardess/runtime/stats") {
    return json({
      ...runtimeAdminBase(env, url),
      endpoint: WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
      view: "stats",
      workerRuntime: snapshot(requestSequence),
    });
  }

  if (url.pathname === "/_hardess/runtime/routes") {
    return json({
      ...runtimeAdminBase(env, url),
      endpoint: WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
      view: "routes",
      registeredActionIds,
      routeCount: routes.length,
      routes: runtimeRoutes(routes),
      workerRuntime: snapshot(requestSequence),
    });
  }

  if (url.pathname !== "/_hardess/runtime") {
    return json(
      {
        ok: false,
        schemaVersion: WORKER_RUNTIME_ADMIN_SCHEMA_VERSION,
        error: "runtime_admin_endpoint_not_found",
        endpoint: url.pathname,
        allowedEndpoints: WORKER_RUNTIME_ADMIN_ENDPOINTS,
        workerRuntime: snapshot(requestSequence),
      },
      { status: 404 },
    );
  }

  return json({
    ...runtimeAdminBase(env, url),
    endpoint: WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
    view: "overview",
    availableEndpoints: WORKER_RUNTIME_ADMIN_ENDPOINTS,
    registeredActionIds,
    routeCount: routes.length,
    routes: runtimeRoutes(routes),
    workerRuntime: snapshot(requestSequence),
  });
}
