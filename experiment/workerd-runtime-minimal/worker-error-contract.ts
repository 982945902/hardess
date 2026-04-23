import type { RuntimeStateSnapshot } from "./worker-types.ts";
import type { WorkerRuntimeRouteExplain } from "./worker-route-contract.ts";

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

export interface WorkerRuntimeMethodNotAllowedResponse
  extends WorkerRuntimeErrorBaseResponse, WorkerRuntimeRouteExplain
{
  error: "method_not_allowed";
  method: string;
  allowedMethods: string[];
}

export interface WorkerRuntimeUnhandledActionResponse
  extends WorkerRuntimeErrorBaseResponse, WorkerRuntimeRouteExplain
{
  error: "unhandled_action";
}

export interface WorkerRuntimeUpgradeRequiredResponse
  extends WorkerRuntimeErrorBaseResponse, WorkerRuntimeRouteExplain
{
  error: "upgrade_required";
  routeActionKind: "websocket";
  routeDispatchMode: "websocket_builtin";
  upgrade: "websocket";
  receivedUpgradeHeader: string | null;
}

export type WorkerRuntimeErrorResponse =
  | WorkerRuntimeNoRouteResponse
  | WorkerRuntimeMethodNotAllowedResponse
  | WorkerRuntimeUnhandledActionResponse
  | WorkerRuntimeUpgradeRequiredResponse;
