import type { RuntimeStateSnapshot } from "./worker-types.ts";

export const WORKER_RUNTIME_ERROR_SCHEMA_VERSION = "hardess.workerd.worker-error.v1";

export type WorkerRuntimeErrorCode =
  | "no_route"
  | "method_not_allowed"
  | "unhandled_action"
  | "upgrade_required";

export interface WorkerRuntimeErrorBaseResponse {
  ok: false;
  schemaVersion: typeof WORKER_RUNTIME_ERROR_SCHEMA_VERSION;
  dispatchSource: "worker_runtime";
  runtime: string;
  assignmentId: string;
  path: string;
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeNoRouteResponse extends WorkerRuntimeErrorBaseResponse {
  error: "no_route";
  method: string;
}

export interface WorkerRuntimeMethodNotAllowedResponse extends WorkerRuntimeErrorBaseResponse {
  error: "method_not_allowed";
  routeId: string;
  actionId: string;
  method: string;
  allowedMethods: string[];
}

export interface WorkerRuntimeUnhandledActionResponse extends WorkerRuntimeErrorBaseResponse {
  error: "unhandled_action";
  routeId: string;
  actionId: string;
}

export interface WorkerRuntimeUpgradeRequiredResponse extends WorkerRuntimeErrorBaseResponse {
  error: "upgrade_required";
  routeId: string;
  actionId: string;
  upgrade: "websocket";
  receivedUpgradeHeader: string | null;
}

export type WorkerRuntimeErrorResponse =
  | WorkerRuntimeNoRouteResponse
  | WorkerRuntimeMethodNotAllowedResponse
  | WorkerRuntimeUnhandledActionResponse
  | WorkerRuntimeUpgradeRequiredResponse;
