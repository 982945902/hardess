import type { RuntimeStateSnapshot } from "./worker-types.ts";
import type { WorkerRuntimeRouteWithPolicy } from "./worker-route-contract.ts";

export const WORKER_RUNTIME_ADMIN_SCHEMA_VERSION = "hardess.workerd.worker-runtime-admin.v1";

export const WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT = "/_hardess/runtime";
export const WORKER_RUNTIME_ADMIN_STATS_ENDPOINT = "/_hardess/runtime/stats";
export const WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT = "/_hardess/runtime/routes";

export const WORKER_RUNTIME_ADMIN_ENDPOINTS = [
  WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT,
  WORKER_RUNTIME_ADMIN_STATS_ENDPOINT,
  WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT,
] as const;

export type WorkerRuntimeAdminEndpoint = (typeof WORKER_RUNTIME_ADMIN_ENDPOINTS)[number];
export type WorkerRuntimeAdminView = "overview" | "stats" | "routes";
export type WorkerRuntimeAdminErrorCode = "method_not_allowed" | "runtime_admin_endpoint_not_found";

export type WorkerRuntimeAdminRoute = WorkerRuntimeRouteWithPolicy;

export interface WorkerRuntimeAdminBaseResponse {
  ok: true;
  schemaVersion: typeof WORKER_RUNTIME_ADMIN_SCHEMA_VERSION;
  path: string;
  dispatchSource: "worker_runtime_admin";
  assignmentId: string;
  deploymentId: string;
  declaredVersion: string;
  manifestId: string;
  protocolPackageId: string;
  resolvedListenAddress: string;
  resolvedBoundActionIds: string[];
  resolvedUnboundProtocolActionIds: string[];
  registeredActionIds: string[];
  dispatchableActionIds: string[];
  unhandledActionIds: string[];
  unhandledRouteIds: string[];
}

export interface WorkerRuntimeAdminOverviewResponse extends WorkerRuntimeAdminBaseResponse {
  endpoint: typeof WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT;
  view: "overview";
  availableEndpoints: typeof WORKER_RUNTIME_ADMIN_ENDPOINTS;
  routeCount: number;
  routes: WorkerRuntimeAdminRoute[];
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeAdminStatsResponse extends WorkerRuntimeAdminBaseResponse {
  endpoint: typeof WORKER_RUNTIME_ADMIN_STATS_ENDPOINT;
  view: "stats";
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeAdminRoutesResponse extends WorkerRuntimeAdminBaseResponse {
  endpoint: typeof WORKER_RUNTIME_ADMIN_ROUTES_ENDPOINT;
  view: "routes";
  routeCount: number;
  routes: WorkerRuntimeAdminRoute[];
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeAdminMethodNotAllowedResponse {
  ok: false;
  schemaVersion: typeof WORKER_RUNTIME_ADMIN_SCHEMA_VERSION;
  error: "method_not_allowed";
  endpoint: string;
  method: string;
  allowedMethods: ["GET"];
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeAdminNotFoundResponse {
  ok: false;
  schemaVersion: typeof WORKER_RUNTIME_ADMIN_SCHEMA_VERSION;
  error: "runtime_admin_endpoint_not_found";
  endpoint: string;
  allowedEndpoints: typeof WORKER_RUNTIME_ADMIN_ENDPOINTS;
  workerRuntime: RuntimeStateSnapshot;
}

export type WorkerRuntimeAdminSuccessResponse =
  | WorkerRuntimeAdminOverviewResponse
  | WorkerRuntimeAdminStatsResponse
  | WorkerRuntimeAdminRoutesResponse;

export type WorkerRuntimeAdminErrorResponse =
  | WorkerRuntimeAdminMethodNotAllowedResponse
  | WorkerRuntimeAdminNotFoundResponse;

export type WorkerRuntimeAdminResponse = WorkerRuntimeAdminSuccessResponse | WorkerRuntimeAdminErrorResponse;

export function isWorkerRuntimeAdminPath(pathname: string): boolean {
  return pathname === WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT || pathname.startsWith(`${WORKER_RUNTIME_ADMIN_OVERVIEW_ENDPOINT}/`);
}
