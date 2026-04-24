import type {
  HardessConfig,
  PipelineConfig,
  RuntimeSummaryPipelineView,
  RuntimeSummaryView,
  ServiceModuleProtocolPackageRef
} from "../shared/index.ts";

export function buildRuntimeSummaryView(input: {
  config: HardessConfig;
  activeProtocolPackages?: ServiceModuleProtocolPackageRef[];
}): RuntimeSummaryView {
  return {
    pipelineCount: input.config.pipelines.length,
    pipelines: input.config.pipelines
      .map((pipeline) => buildPipelineView(pipeline))
      .sort((left, right) => left.pipelineId.localeCompare(right.pipelineId)),
    activeProtocolPackages: [...(input.activeProtocolPackages ?? [])].sort(compareProtocolPackageRefs)
  };
}

function compareProtocolPackageRefs(
  left: ServiceModuleProtocolPackageRef,
  right: ServiceModuleProtocolPackageRef
): number {
  return (
    left.packageId.localeCompare(right.packageId) ||
    (left.deploymentId ?? "").localeCompare(right.deploymentId ?? "") ||
    (left.assignmentId ?? "").localeCompare(right.assignmentId ?? "")
  );
}

function buildPipelineView(pipeline: PipelineConfig): RuntimeSummaryPipelineView {
  const deploymentConfigKeys = sortedKeys(pipeline.worker?.deployment?.config);
  const deploymentBindingKeys = sortedKeys(pipeline.worker?.deployment?.bindings);
  const deploymentSecretCount = countKeys(pipeline.worker?.deployment?.secrets);
  return {
    pipelineId: pipeline.id,
    matchPrefix: pipeline.matchPrefix,
    ...(pipeline.groupId !== undefined
      ? {
          groupId: pipeline.groupId
        }
      : {}),
    authRequired: pipeline.auth?.required ?? false,
    downstreamOrigin: pipeline.downstream.origin,
    downstreamConnectTimeoutMs: pipeline.downstream.connectTimeoutMs,
    downstreamResponseTimeoutMs: pipeline.downstream.responseTimeoutMs,
    websocketEnabled: pipeline.downstream.websocket ?? false,
    workerConfigured: pipeline.worker !== undefined,
    ...(pipeline.worker
      ? {
          workerEntry: pipeline.worker.entry,
          workerTimeoutMs: pipeline.worker.timeoutMs,
          ...(pipeline.worker.deployment?.instanceKey !== undefined
            ? {
                deploymentInstanceKey: pipeline.worker.deployment.instanceKey
              }
            : {}),
          ...(deploymentConfigKeys
            ? {
                deploymentConfigKeys
              }
            : {}),
          ...(deploymentBindingKeys
            ? {
                deploymentBindingKeys
              }
            : {}),
          ...(deploymentSecretCount > 0
            ? {
                deploymentSecretCount
              }
            : {})
        }
      : {})
  };
}

function sortedKeys(input: Record<string, unknown> | undefined): string[] | undefined {
  const keys = Object.keys(input ?? {}).sort((left, right) => left.localeCompare(right));
  return keys.length > 0 ? keys : undefined;
}

function countKeys(input: Record<string, unknown> | undefined): number {
  return Object.keys(input ?? {}).length;
}
