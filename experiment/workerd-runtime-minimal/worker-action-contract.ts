import type { RuntimeStateSnapshot } from "./worker-types.ts";

export const WORKER_RUNTIME_ACTION_SCHEMA_VERSION = "hardess.workerd.worker-action.v1";

export interface WorkerRuntimeActionBaseResponse {
  ok: true;
  schemaVersion: typeof WORKER_RUNTIME_ACTION_SCHEMA_VERSION;
  runtime: string;
  assignmentId: string;
  routeId: string;
  actionId: string;
  workerRuntime: RuntimeStateSnapshot;
}

export interface WorkerRuntimeInfoResponse extends WorkerRuntimeActionBaseResponse {
  experiment: string;
  configExperiment: string;
  secret: string;
  tokenPresent: boolean;
  deploymentId: string;
  declaredVersion: string;
  manifestId: string;
  dispatchSource: "resolved_runtime_model";
  protocolPackageId: string;
  routeRefCount: number;
  resolvedRouteCount: number;
  resolvedListenAddress: string;
  resolvedProtocolActionCount: number;
  resolvedProtocolActionIds: string[];
  resolvedPrimaryRuntimeBinding: string;
  resolvedCompatibilityBindings: string[];
  resolvedMetadataBindings: string[];
  resolvedHttpRouteCount: number;
  resolvedWebsocketRouteCount: number;
  resolvedRootRouteId: string | null;
  resolvedBindingNames: string[];
  resolvedSecretNames: string[];
  resolvedAdvisoryCount: number;
  resolvedAdvisorySeverityCounts: {
    info: number;
    warning: number;
  };
  resolvedHighestAdvisorySeverity: "none" | "info" | "warning";
  resolvedAdvisoryCodes: string[];
  resolvedAdvisorySeverities: Array<"info" | "warning">;
  runtimeRegisteredActionIds: string[];
  runtimeDispatchableActionIds: string[];
  runtimeUnhandledActionIds: string[];
  runtimeUnhandledRouteIds: string[];
  allowedMethods: string[];
  method: string;
  path: string;
}

export interface WorkerRuntimeEchoResponse extends WorkerRuntimeActionBaseResponse {
  dispatchSource: "resolved_runtime_model";
  path: string;
  echo: string;
  length: number;
}

export interface WorkerRuntimeWebSocketOpenResponse extends WorkerRuntimeActionBaseResponse {
  type: "open";
}

export interface WorkerRuntimeWebSocketEchoResponse extends WorkerRuntimeActionBaseResponse {
  type: "echo";
  echo: string;
}

export type WorkerRuntimeActionResponse =
  | WorkerRuntimeInfoResponse
  | WorkerRuntimeEchoResponse
  | WorkerRuntimeWebSocketOpenResponse
  | WorkerRuntimeWebSocketEchoResponse;
