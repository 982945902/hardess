import type {
  ArtifactManifest,
  Assignment,
  AssignmentObservedState,
  DesiredHostState,
  HostRegistration,
  MembershipHostState,
  MembershipSnapshot,
  PlacementIngressGroupRequirement,
  ObservedHostState,
  RuntimeSummaryCheck,
  RuntimeSummaryReadModel,
  RuntimeSummaryReadModelQuery,
  RuntimeSummaryRollup,
  RuntimeSummaryStatus
} from "../../shared/index.ts";
import type { PlacementSnapshot } from "../../shared/index.ts";
import {
  toServiceModuleProtocolPackageRef
} from "../../shared/index.ts";

export type HttpWorkerAssignmentMode = "select-first-n-hosts" | "all-hosts";
export type HttpWorkerRouteScope = "shared" | "per_host";

export interface PlacementCandidateHost {
  hostId: string;
  groupId?: string;
  staticLabels?: Record<string, string>;
  staticCapabilities?: string[];
  staticCapacity?: {
    maxHttpWorkerAssignments?: number;
  };
  ready?: boolean;
  draining?: boolean;
  schedulable?: boolean;
  currentAssignmentCount?: number;
}

export interface HttpWorkerDeploymentPlan {
  deploymentId: string;
  deploymentKind?: "http_worker" | "serve";
  groupId?: string;
  declaredArtifactId?: string;
  declaredVersion: string;
  manifestId: string;
  replicas?: number;
  assignmentMode?: HttpWorkerAssignmentMode;
  sourceUri: string;
  sourceDigest?: string;
  upstreamBaseUrl?: string;
  workerName: string;
  workerEntry: string;
  routeId: string;
  routePathPrefix: string;
  routeScope?: HttpWorkerRouteScope;
  packageManagerKind?: "bun" | "deno";
  packageJson?: string;
  bunfigToml?: string;
  bunLock?: string;
  denoJson?: string;
  denoLock?: string;
  frozenLock?: boolean;
  metadataAnnotations?: Record<string, string>;
  deployment?: {
    config?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    secrets?: Record<string, string>;
  };
  stickyHostIds?: string[];
  ownerHostIds?: string[];
  scheduling?: {
    requiredLabels?: Record<string, string>;
    preferredLabels?: Record<string, string>;
    requiredCapabilities?: string[];
  };
  rollout?: {
    strategy?: "gradual";
    maxUnavailable?: number;
    batchSize?: number;
  };
}

export interface ProjectDesiredHttpWorkersInput {
  hostId: string;
  upstreamBaseUrl: string;
  deployments: HttpWorkerDeploymentPlan[];
  revisionToken: number;
  registeredHostIds: string[];
  candidateHosts?: PlacementCandidateHost[];
}

export interface DeploymentRolloutHostStatus {
  hostId: string;
  desiredAssignmentId?: string;
  desiredVersion?: string;
  observedState?: AssignmentObservedState | "missing";
  observedGenerationId?: string;
  runtimeSummaryReported?: boolean;
  runtimeSummaryStatus?: "match" | "drift" | "not_reported";
  runtimeSummaryMissingIds?: string[];
  runtimeSummaryUnexpectedIds?: string[];
  lastError?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface DeploymentRolloutSummary {
  deploymentId: string;
  desiredHosts: number;
  activeHosts: number;
  readyHosts: number;
  preparingHosts: number;
  drainingHosts: number;
  failedHosts: number;
  pendingHosts: number;
  hosts: DeploymentRolloutHostStatus[];
}


export function buildHttpWorkerArtifactManifest(plan: HttpWorkerDeploymentPlan): ArtifactManifest {
  const packageManager =
    plan.packageManagerKind === "deno" || plan.denoJson !== undefined || plan.denoLock !== undefined
      ? {
          kind: "deno" as const,
          denoJson: plan.denoJson,
          denoLock: plan.denoLock,
          frozenLock: plan.frozenLock
        }
      : {
          kind: "bun" as const,
          packageJson: plan.packageJson,
          bunfigToml: plan.bunfigToml,
          bunLock: plan.bunLock,
          frozenLock: plan.frozenLock
        };

  return {
    manifestId: plan.manifestId,
    artifactKind: plan.deploymentKind ?? "http_worker",
    declaredArtifactId: plan.declaredArtifactId,
    declaredVersion: plan.declaredVersion,
    source: {
      uri: plan.sourceUri,
      digest: plan.sourceDigest
    },
    entry: plan.workerEntry,
    packageManager,
    metadata: plan.metadataAnnotations
      ? {
          annotations: { ...plan.metadataAnnotations }
        }
      : undefined
  };
}

export function projectHttpWorkerDesiredState(
  input: ProjectDesiredHttpWorkersInput
): DesiredHostState {
  const assignedDeployments = input.deployments.filter((deployment) =>
    shouldAssignDeploymentToHost(
      deployment,
      input.hostId,
      input.registeredHostIds,
      input.candidateHosts
    )
  );

  const assignments = assignedDeployments.map((deployment) =>
    buildAssignmentForHost(input.hostId, deployment)
  );

  return {
    hostId: input.hostId,
    revision: buildDesiredRevision(input.hostId, input.revisionToken, assignments),
    generatedAt: Date.now(),
    assignments,
    sharedHttpForwardConfig: {
      routes: assignedDeployments.map((deployment) => buildRouteForHost(input.hostId, deployment, input.upstreamBaseUrl))
    }
  };
}

export function buildMembershipSnapshot(input: {
  revision: string;
  generatedAt?: number;
  registrations: HostRegistration[];
  observedHostStates?: ObservedHostState[];
}): MembershipSnapshot {
  const observedByHostId = new Map(
    (input.observedHostStates ?? []).map((observed) => [observed.hostId, observed] as const)
  );

  return {
    revision: input.revision,
    generatedAt: input.generatedAt ?? Date.now(),
    hosts: input.registrations
      .map((registration) => {
        const observed = observedByHostId.get(registration.hostId);
        const state: MembershipHostState = observed
          ? observed.draining
            ? "draining"
            : observed.ready
              ? "ready"
              : "offline"
          : "ready";
        return {
          hostId: registration.hostId,
          ...(registration.groupId !== undefined
            ? {
                groupId: registration.groupId
              }
            : {}),
          nodeId: registration.nodeId,
          publicBaseUrl: registration.network.publicBaseUrl,
          internalBaseUrl: registration.network.internalBaseUrl,
          publicListenerEnabled: registration.network.publicListenerEnabled,
          internalListenerEnabled: registration.network.internalListenerEnabled,
          state,
          staticLabels: { ...registration.staticLabels },
          staticCapabilities: [...registration.staticCapabilities],
          staticCapacity: { ...registration.staticCapacity },
          lastSeenAt: observed?.observedAt
        };
      })
      .sort((left, right) => left.hostId.localeCompare(right.hostId))
  };
}

export function buildPlacementSnapshot(input: {
  revision: string;
  generatedAt?: number;
  desiredHostStates: DesiredHostState[];
}): PlacementSnapshot {
  const deployments = new Map<
    string,
    {
      deploymentId: string;
      deploymentKind: Assignment["deploymentKind"];
      groupId?: string;
      ownerHostIds: Set<string>;
      routesById: Map<
        string,
        {
          routeId: string;
          pathPrefix: string;
          ownerHostIds: Set<string>;
        }
      >;
    }
  >();

  for (const desired of input.desiredHostStates) {
    const routesById = new Map(
      (desired.sharedHttpForwardConfig?.routes ?? []).map((route) => [route.routeId, route] as const)
    );
    for (const assignment of desired.assignments) {
      const entry = deployments.get(assignment.deploymentId) ?? {
        deploymentId: assignment.deploymentId,
        deploymentKind: assignment.deploymentKind,
        groupId: assignment.groupId,
        ownerHostIds: new Set<string>(),
        routesById: new Map()
      };
      entry.ownerHostIds.add(desired.hostId);
      for (const routeId of assignment.httpWorker?.routeRefs ?? assignment.serveApp?.routeRefs ?? []) {
        const route = routesById.get(routeId);
        if (!route) {
          continue;
        }
        const routeEntry = entry.routesById.get(routeId) ?? {
          routeId,
          pathPrefix: route.match.pathPrefix,
          ownerHostIds: new Set<string>()
        };
        routeEntry.ownerHostIds.add(desired.hostId);
        entry.routesById.set(routeId, routeEntry);
      }
      deployments.set(assignment.deploymentId, entry);
    }
  }

  const ingressGroupRequirements = buildIngressGroupRequirements(input.desiredHostStates);

  return {
    revision: input.revision,
    generatedAt: input.generatedAt ?? Date.now(),
    deployments: Array.from(deployments.values())
      .map((deployment) => ({
        deploymentId: deployment.deploymentId,
        deploymentKind: deployment.deploymentKind,
        ...(deployment.groupId !== undefined
          ? {
              groupId: deployment.groupId
            }
          : {}),
        ownerHostIds: Array.from(deployment.ownerHostIds).sort((left, right) => left.localeCompare(right)),
        routes: Array.from(deployment.routesById.values())
          .map((route) => ({
            routeId: route.routeId,
            pathPrefix: route.pathPrefix,
            ownerHostIds: Array.from(route.ownerHostIds).sort((left, right) => left.localeCompare(right))
          }))
          .sort((left, right) => left.routeId.localeCompare(right.routeId))
      }))
      .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId)),
    ingressGroupRequirements
  };
}

export function buildDeploymentRolloutSummary(
  desiredHostStates: DesiredHostState[],
  observedHostStates: ObservedHostState[]
): DeploymentRolloutSummary[] {
  const observedByHostId = new Map(observedHostStates.map((observed) => [observed.hostId, observed] as const));
  const desiredDeploymentIds = new Set(
    desiredHostStates.flatMap((desired) => desired.assignments.map((assignment) => assignment.deploymentId))
  );
  const observedOnlyDeploymentIds = new Set(
    observedHostStates.flatMap((observed) =>
      observed.assignmentStatuses
        .map((assignmentStatus) => assignmentStatus.deploymentId)
        .filter((deploymentId) => !desiredDeploymentIds.has(deploymentId))
    )
  );
  const deploymentIds = Array.from(new Set([...desiredDeploymentIds, ...observedOnlyDeploymentIds])).sort(
    (left, right) => left.localeCompare(right)
  );

  return deploymentIds.map((deploymentId) => {
    const hosts = desiredHostStates
      .map((desired): DeploymentRolloutHostStatus | null => {
        const desiredAssignment = desired.assignments.find(
          (assignment) => assignment.deploymentId === deploymentId
        );
        const observed = observedByHostId.get(desired.hostId);
        const observedStatus = observed?.assignmentStatuses.find(
          (assignmentStatus) => assignmentStatus.deploymentId === deploymentId
        );

        if (!desiredAssignment && !observedStatus) {
          return null;
        }

        return {
          hostId: desired.hostId,
          desiredAssignmentId: desiredAssignment?.assignmentId,
          desiredVersion: desiredAssignment?.declaredVersion,
          observedState: observedStatus?.state ?? (desiredAssignment ? "missing" : undefined),
          observedGenerationId: observedStatus?.generationId,
          lastError: observedStatus?.lastError
        };
      })
      .filter((value): value is DeploymentRolloutHostStatus => value !== null)
      .sort((left, right) => left.hostId.localeCompare(right.hostId));

    return {
      deploymentId,
      desiredHosts: hosts.filter((host) => host.desiredAssignmentId !== undefined).length,
      activeHosts: hosts.filter((host) => host.observedState === "active").length,
      readyHosts: hosts.filter((host) => host.observedState === "ready").length,
      preparingHosts: hosts.filter((host) => host.observedState === "preparing").length,
      drainingHosts: hosts.filter((host) => host.observedState === "draining").length,
      failedHosts: hosts.filter((host) => host.observedState === "failed").length,
      pendingHosts: hosts.filter((host) => host.observedState === "pending" || host.observedState === "missing")
        .length,
      hosts
    };
  });
}

export function attachRuntimeSummaryToDeploymentRolloutSummary(
  summaries: DeploymentRolloutSummary[],
  desiredHostStates: DesiredHostState[],
  observedHostStates: ObservedHostState[]
): DeploymentRolloutSummary[] {
  const desiredByHostId = new Map(desiredHostStates.map((desired) => [desired.hostId, desired] as const));
  const observedByHostId = new Map(observedHostStates.map((observed) => [observed.hostId, observed] as const));

  return summaries.map((summary) => ({
    ...summary,
    hosts: summary.hosts.map((host) =>
      attachRuntimeSummaryToRolloutHost(
        host,
        summary.deploymentId,
        desiredByHostId.get(host.hostId),
        observedByHostId.get(host.hostId)
      )
    )
  }));
}

export function buildRuntimeSummaryChecks(
  desiredHostStates: DesiredHostState[],
  observedHostStates: ObservedHostState[],
  query: Pick<RuntimeSummaryReadModelQuery, "deploymentId"> = {}
): RuntimeSummaryCheck[] {
  const desiredByHostId = new Map(desiredHostStates.map((desired) => [desired.hostId, desired] as const));
  const observedByHostId = new Map(observedHostStates.map((observed) => [observed.hostId, observed] as const));
  const hostIds = Array.from(
    new Set([...desiredHostStates.map((desired) => desired.hostId), ...observedHostStates.map((observed) => observed.hostId)])
  ).sort((left, right) => left.localeCompare(right));

  return hostIds.map((hostId) => {
    const desired = desiredByHostId.get(hostId);
    const observed = observedByHostId.get(hostId);
    const runtimeSummary = observed?.dynamicState.runtimeSummary ?? observed?.dynamicState.dynamicFields?.runtimeSummary;
    const expectedPipelineIds = listExpectedPipelineIds(desired);
    const observedPipelineIds = listObservedPipelineIdsForReadModel(runtimeSummary, query);
    const expectedProtocolPackageIds = listExpectedProtocolPackageIds(desired);
    const observedProtocolPackageIds = listObservedProtocolPackageIdsForReadModel(
      runtimeSummary,
      expectedProtocolPackageIds,
      query
    );
    const missingPipelineIds = computeMissingValues(expectedPipelineIds, observedPipelineIds);
    const unexpectedPipelineIds = computeMissingValues(observedPipelineIds, expectedPipelineIds);
    const missingProtocolPackageIds = computeMissingValues(
      expectedProtocolPackageIds,
      observedProtocolPackageIds
    );
    const unexpectedProtocolPackageIds = computeMissingValues(
      observedProtocolPackageIds,
      expectedProtocolPackageIds
    );
    const status = resolveRuntimeSummaryStatus({
      reported: runtimeSummary !== undefined,
      missingCount: missingPipelineIds.length + missingProtocolPackageIds.length,
      unexpectedCount: unexpectedPipelineIds.length + unexpectedProtocolPackageIds.length
    });

    return {
      hostId,
      status,
      reported: runtimeSummary !== undefined,
      matches: status === "match",
      expectedPipelineIds,
      observedPipelineIds,
      missingPipelineIds,
      unexpectedPipelineIds,
      expectedProtocolPackageIds,
      observedProtocolPackageIds,
      missingProtocolPackageIds,
      unexpectedProtocolPackageIds
    };
  });
}

export function buildRuntimeSummaryRollup(checks: RuntimeSummaryCheck[]): RuntimeSummaryRollup {
  return {
    totalHosts: checks.length,
    reportedHosts: checks.filter((check) => check.reported).length,
    matchingHosts: checks.filter((check) => check.matches).length,
    driftedHosts: checks.filter((check) => check.status === "drift").length,
    notReportedHosts: checks.filter((check) => check.status === "not_reported").length
  };
}

export function buildRuntimeSummaryReadModel(
  desiredHostStates: DesiredHostState[],
  observedHostStates: ObservedHostState[],
  query: RuntimeSummaryReadModelQuery = {}
): RuntimeSummaryReadModel {
  const scopedDesiredHostStates = filterDesiredHostStatesForRuntimeSummaryQuery(desiredHostStates, query);
  const scopedObservedHostStates = filterObservedHostStatesForRuntimeSummaryQuery(observedHostStates, query);
  const checks = buildRuntimeSummaryChecks(scopedDesiredHostStates, scopedObservedHostStates, query);
  return {
    checks,
    rollup: buildRuntimeSummaryRollup(checks),
    rolloutSummary: attachRuntimeSummaryToDeploymentRolloutSummary(
      buildDeploymentRolloutSummary(scopedDesiredHostStates, scopedObservedHostStates),
      scopedDesiredHostStates,
      scopedObservedHostStates
    )
  };
}

function filterDesiredHostStatesForRuntimeSummaryQuery(
  desiredHostStates: DesiredHostState[],
  query: RuntimeSummaryReadModelQuery
): DesiredHostState[] {
  return desiredHostStates.flatMap((desired) => {
    if (query.hostId !== undefined && desired.hostId !== query.hostId) {
      return [];
    }
    if (query.deploymentId === undefined) {
      return [desired];
    }

    const assignments = desired.assignments.filter(
      (assignment) => assignment.deploymentId === query.deploymentId
    );
    if (assignments.length === 0 && query.hostId === undefined) {
      return [];
    }

    const routeRefs = new Set(assignments.flatMap((assignment) => listAssignmentRouteRefs(assignment)));
    const sharedHttpForwardConfig = desired.sharedHttpForwardConfig
      ? {
          routes: desired.sharedHttpForwardConfig.routes.filter((route) => routeRefs.has(route.routeId))
        }
      : undefined;

    return [
      {
        ...desired,
        assignments,
        ...(sharedHttpForwardConfig !== undefined
          ? {
              sharedHttpForwardConfig
            }
          : {})
      }
    ];
  });
}

function filterObservedHostStatesForRuntimeSummaryQuery(
  observedHostStates: ObservedHostState[],
  query: RuntimeSummaryReadModelQuery
): ObservedHostState[] {
  return observedHostStates.flatMap((observed) => {
    if (query.hostId !== undefined && observed.hostId !== query.hostId) {
      return [];
    }
    if (query.deploymentId === undefined) {
      return [observed];
    }
    const deploymentId = query.deploymentId;

    const assignmentStatuses = observed.assignmentStatuses.filter(
      (status) => status.deploymentId === deploymentId
    );
    const runtimeSummary = observed.dynamicState.runtimeSummary ?? observed.dynamicState.dynamicFields?.runtimeSummary;
    const hasObservedPipeline = listObservedPipelineIds(runtimeSummary).some((pipelineId) =>
      isRuntimePipelineIdForDeployment(pipelineId, deploymentId)
    );
    const hasObservedProtocolPackage = listObservedProtocolPackageIdsForDeployment(
      runtimeSummary,
      deploymentId
    ).packageIds.length > 0;

    if (
      assignmentStatuses.length === 0 &&
      !hasObservedPipeline &&
      !hasObservedProtocolPackage &&
      query.hostId === undefined
    ) {
      return [];
    }

    return [
      {
        ...observed,
        assignmentStatuses
      }
    ];
  });
}

function listAssignmentRouteRefs(assignment: Assignment): string[] {
  return [
    ...(assignment.httpWorker?.routeRefs ?? []),
    ...(assignment.serveApp?.routeRefs ?? [])
  ];
}

export function normalizeReplicaCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  return Math.max(1, Math.trunc(value));
}

export function shouldAssignDeploymentToHost(
  deployment: HttpWorkerDeploymentPlan,
  hostId: string,
  registeredHostIds: string[],
  candidateHosts: PlacementCandidateHost[] = registeredHostIds.map((candidateHostId) => ({
    hostId: candidateHostId
  }))
): boolean {
  if (deployment.ownerHostIds) {
    return deployment.ownerHostIds.includes(hostId);
  }

  const eligibleHosts = rankCandidateHosts(deployment, candidateHosts);

  if ((deployment.assignmentMode ?? "select-first-n-hosts") === "all-hosts") {
    return eligibleHosts.some((candidate) => candidate.hostId === hostId);
  }

  const selectedHosts = eligibleHosts
    .map((candidate) => candidate.hostId)
    .slice(0, normalizeReplicaCount(deployment.replicas ?? 1));
  return selectedHosts.includes(hostId);
}

export function planHttpWorkerDeploymentOwners(input: {
  deployment: HttpWorkerDeploymentPlan;
  candidateHosts: PlacementCandidateHost[];
  currentDesiredOwnerHostIds?: string[];
  observedHostStates?: ObservedHostState[];
}): string[] {
  const deployment = input.deployment;
  const targetOwnerHostIds = selectTargetOwnerHostIds(deployment, input.candidateHosts);
  const rollout = deployment.rollout;
  const gradualRolloutEnabled =
    rollout?.strategy === "gradual" ||
    rollout?.batchSize !== undefined ||
    rollout?.maxUnavailable !== undefined;

  if (
    !gradualRolloutEnabled ||
    (deployment.assignmentMode ?? "select-first-n-hosts") === "all-hosts"
  ) {
    return targetOwnerHostIds;
  }

  const currentDesiredOwnerHostIds = uniqueHostIds(input.currentDesiredOwnerHostIds ?? []);
  if (currentDesiredOwnerHostIds.length === 0) {
    return targetOwnerHostIds;
  }

  const batchSize = normalizePositiveCount(rollout?.batchSize, 1);
  const maxUnavailable = normalizeNonNegativeCount(rollout?.maxUnavailable, 0);
  const minAvailable = Math.max(0, normalizeReplicaCount(deployment.replicas ?? 1) - maxUnavailable);
  const targetOwnerSet = new Set(targetOwnerHostIds);
  const nextOwnerHostIds = [...currentDesiredOwnerHostIds];
  const nextOwnerSet = new Set(nextOwnerHostIds);

  for (const hostId of targetOwnerHostIds) {
    if (nextOwnerSet.size >= currentDesiredOwnerHostIds.length + batchSize) {
      break;
    }
    if (nextOwnerSet.has(hostId)) {
      continue;
    }
    nextOwnerSet.add(hostId);
    nextOwnerHostIds.push(hostId);
  }

  let removedCount = 0;
  for (const hostId of currentDesiredOwnerHostIds) {
    if (removedCount >= batchSize) {
      break;
    }
    if (targetOwnerSet.has(hostId)) {
      continue;
    }

    const remainingOwnerHostIds = nextOwnerHostIds.filter(
      (candidateHostId) => candidateHostId !== hostId && nextOwnerSet.has(candidateHostId)
    );
    if (
      countAvailableOwnerHosts({
        deploymentId: deployment.deploymentId,
        declaredVersion: deployment.declaredVersion,
        ownerHostIds: remainingOwnerHostIds,
        observedHostStates: input.observedHostStates ?? []
      }) < minAvailable
    ) {
      continue;
    }

    nextOwnerSet.delete(hostId);
    removedCount += 1;
  }

  return nextOwnerHostIds.filter((hostId) => nextOwnerSet.has(hostId));
}

export function buildPlacementCandidateHosts(input: {
  registrations: HostRegistration[];
  observedHostStates?: ObservedHostState[];
}): PlacementCandidateHost[] {
  const observedByHostId = new Map(
    (input.observedHostStates ?? []).map((observed) => [observed.hostId, observed] as const)
  );

  return input.registrations
    .map((registration) => {
      const observed = observedByHostId.get(registration.hostId);
      return {
        hostId: registration.hostId,
        groupId: registration.groupId,
        staticLabels: { ...registration.staticLabels },
        staticCapabilities: [...registration.staticCapabilities],
        staticCapacity: {
          maxHttpWorkerAssignments: registration.staticCapacity.maxHttpWorkerAssignments
        },
        ready: observed?.ready,
        draining: observed?.draining,
        schedulable: observed?.dynamicState.schedulable,
        currentAssignmentCount: observed?.dynamicState.currentAssignmentCount
      } satisfies PlacementCandidateHost;
    })
    .sort((left, right) => left.hostId.localeCompare(right.hostId));
}

function rankCandidateHosts(
  deployment: HttpWorkerDeploymentPlan,
  candidateHosts: PlacementCandidateHost[]
): PlacementCandidateHost[] {
  return candidateHosts
    .filter((candidate) => isCandidateEligible(deployment, candidate))
    .sort((left, right) => compareCandidateHosts(deployment, left, right));
}

function isCandidateEligible(
  deployment: HttpWorkerDeploymentPlan,
  candidate: PlacementCandidateHost
): boolean {
  if (deployment.groupId !== candidate.groupId) {
    return false;
  }

  if (candidate.ready === false || candidate.draining === true || candidate.schedulable === false) {
    return false;
  }

  if (!matchesRequiredLabels(candidate, deployment.scheduling?.requiredLabels)) {
    return false;
  }

  if (!matchesRequiredCapabilities(candidate, deployment.scheduling?.requiredCapabilities)) {
    return false;
  }

  const maxAssignments = candidate.staticCapacity?.maxHttpWorkerAssignments;
  if (
    maxAssignments !== undefined &&
    (candidate.currentAssignmentCount ?? 0) >= maxAssignments
  ) {
    return false;
  }

  return true;
}

function matchesRequiredLabels(
  candidate: PlacementCandidateHost,
  requiredLabels?: Record<string, string>
): boolean {
  if (!requiredLabels) {
    return true;
  }

  const labels = candidate.staticLabels ?? {};
  return Object.entries(requiredLabels).every(([key, value]) => labels[key] === value);
}

function matchesRequiredCapabilities(
  candidate: PlacementCandidateHost,
  requiredCapabilities?: string[]
): boolean {
  if (!requiredCapabilities || requiredCapabilities.length === 0) {
    return true;
  }

  const capabilities = new Set(candidate.staticCapabilities ?? []);
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

function preferredLabelScore(
  candidate: PlacementCandidateHost,
  preferredLabels?: Record<string, string>
): number {
  if (!preferredLabels) {
    return 0;
  }

  const labels = candidate.staticLabels ?? {};
  return Object.entries(preferredLabels).reduce(
    (score, [key, value]) => score + (labels[key] === value ? 1 : 0),
    0
  );
}

function compareCandidateHosts(
  deployment: HttpWorkerDeploymentPlan,
  left: PlacementCandidateHost,
  right: PlacementCandidateHost
): number {
  const stickyHostIds = new Set(deployment.stickyHostIds ?? []);
  const leftSticky = stickyHostIds.has(left.hostId);
  const rightSticky = stickyHostIds.has(right.hostId);
  if (leftSticky !== rightSticky) {
    return leftSticky ? -1 : 1;
  }

  const preferredScoreDiff =
    preferredLabelScore(right, deployment.scheduling?.preferredLabels) -
    preferredLabelScore(left, deployment.scheduling?.preferredLabels);
  if (preferredScoreDiff !== 0) {
    return preferredScoreDiff;
  }

  const leftAssignments = left.currentAssignmentCount ?? 0;
  const rightAssignments = right.currentAssignmentCount ?? 0;
  if (leftAssignments !== rightAssignments) {
    return leftAssignments - rightAssignments;
  }

  return left.hostId.localeCompare(right.hostId);
}

function buildAssignmentForHost(hostId: string, deployment: HttpWorkerDeploymentPlan): Assignment {
  const manifest = buildHttpWorkerArtifactManifest(deployment);
  return {
    assignmentId: `assign:${hostId}:${deployment.deploymentId}`,
    hostId,
    deploymentId: deployment.deploymentId,
    deploymentKind: deployment.deploymentKind ?? "http_worker",
    ...(deployment.groupId !== undefined
      ? {
          groupId: deployment.groupId
        }
      : {}),
    declaredVersion: deployment.declaredVersion,
    declaredArtifactId: deployment.declaredArtifactId,
    artifact: {
      manifestId: deployment.manifestId,
      sourceUri: manifest.source.uri,
      digest: manifest.source.digest
    },
    httpWorker: (deployment.deploymentKind ?? "http_worker") === "http_worker"
      ? {
          name: deployment.workerName,
          entry: deployment.workerEntry,
          routeRefs: [buildRouteIdForHost(hostId, deployment)],
          ...(deployment.deployment !== undefined
            ? {
                deployment: deployment.deployment
              }
            : {})
        }
      : undefined,
    serveApp: (deployment.deploymentKind ?? "http_worker") === "serve"
      ? {
          name: deployment.workerName,
          entry: deployment.workerEntry,
          routeRefs: [buildRouteIdForHost(hostId, deployment)],
          ...(deployment.deployment !== undefined
            ? {
                deployment: deployment.deployment
              }
            : {})
        }
      : undefined
  };
}

function selectTargetOwnerHostIds(
  deployment: HttpWorkerDeploymentPlan,
  candidateHosts: PlacementCandidateHost[]
): string[] {
  const eligibleHosts = rankCandidateHosts(deployment, candidateHosts).map((candidate) => candidate.hostId);
  if ((deployment.assignmentMode ?? "select-first-n-hosts") === "all-hosts") {
    return eligibleHosts;
  }

  return eligibleHosts.slice(0, normalizeReplicaCount(deployment.replicas ?? 1));
}

function countAvailableOwnerHosts(input: {
  deploymentId: string;
  declaredVersion: string;
  ownerHostIds: string[];
  observedHostStates: ObservedHostState[];
}): number {
  const observedByHostId = new Map(
    input.observedHostStates.map((observed) => [observed.hostId, observed] as const)
  );

  return input.ownerHostIds.filter((hostId) => {
    const observed = observedByHostId.get(hostId);
    const assignmentStatus = observed?.assignmentStatuses.find(
      (status) =>
        status.deploymentId === input.deploymentId && status.declaredVersion === input.declaredVersion
    );
    return assignmentStatus?.state === "ready" || assignmentStatus?.state === "active";
  }).length;
}

function uniqueHostIds(hostIds: string[]): string[] {
  const seen = new Set<string>();
  return hostIds.filter((hostId) => {
    if (seen.has(hostId)) {
      return false;
    }
    seen.add(hostId);
    return true;
  });
}

function normalizePositiveCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function attachRuntimeSummaryToRolloutHost(
  host: DeploymentRolloutHostStatus,
  deploymentId: string,
  desired: DesiredHostState | undefined,
  observed: ObservedHostState | undefined
): DeploymentRolloutHostStatus {
  const expectedIds = listExpectedDeploymentRuntimeIds(desired, deploymentId);
  const runtimeSummary = observed?.dynamicState.runtimeSummary ?? observed?.dynamicState.dynamicFields?.runtimeSummary;

  if (runtimeSummary === undefined) {
    return expectedIds.length > 0
      ? {
          ...host,
          runtimeSummaryReported: false,
          runtimeSummaryStatus: "not_reported",
          runtimeSummaryMissingIds: expectedIds
        }
      : { ...host };
  }

  const observedIds = listObservedDeploymentRuntimeIds(runtimeSummary, deploymentId, expectedIds);
  const missingIds = computeMissingValues(expectedIds, observedIds);
  const unexpectedIds = computeMissingValues(observedIds, expectedIds);
  const runtimeSummaryStatus = resolveRuntimeSummaryStatus({
    reported: true,
    missingCount: missingIds.length,
    unexpectedCount: unexpectedIds.length
  });

  return {
    ...host,
    runtimeSummaryReported: true,
    runtimeSummaryStatus,
    ...(missingIds.length > 0
      ? {
          runtimeSummaryMissingIds: missingIds
        }
      : {}),
    ...(unexpectedIds.length > 0
      ? {
          runtimeSummaryUnexpectedIds: unexpectedIds
        }
      : {})
  };
}

function listExpectedDeploymentRuntimeIds(
  desired: DesiredHostState | undefined,
  deploymentId: string
): string[] {
  if (!desired) {
    return [];
  }

  const routeIds = new Set((desired.sharedHttpForwardConfig?.routes ?? []).map((route) => route.routeId));
  const httpRuntimeIds = desired.assignments
    .filter(
      (assignment) =>
        assignment.deploymentId === deploymentId && assignment.deploymentKind !== "service_module"
    )
    .flatMap((assignment) => {
      const executable = assignment.httpWorker ?? assignment.serveApp;
      return (executable?.routeRefs ?? [])
        .filter((routeId) => routeIds.has(routeId))
        .map((routeId) => `${assignment.assignmentId}:${routeId}`);
    });
  if (httpRuntimeIds.length > 0) {
    return httpRuntimeIds.sort((left, right) => left.localeCompare(right));
  }

  return desired.assignments
    .flatMap((assignment) =>
      assignment.deploymentId === deploymentId &&
      assignment.deploymentKind === "service_module" &&
      assignment.serviceModule
        ? [assignment.serviceModule.protocolPackage.packageId]
        : []
    )
    .sort((left, right) => left.localeCompare(right));
}

function listExpectedPipelineIds(desired: DesiredHostState | undefined): string[] {
  if (!desired) {
    return [];
  }

  const routeIds = new Set((desired.sharedHttpForwardConfig?.routes ?? []).map((route) => route.routeId));
  const pipelineIds = desired.assignments.flatMap((assignment) => {
    if (assignment.deploymentKind === "service_module") {
      return [];
    }
    const executable = assignment.httpWorker ?? assignment.serveApp;
    return (executable?.routeRefs ?? [])
      .filter((routeId) => routeIds.has(routeId))
      .map((routeId) => `${assignment.assignmentId}:${routeId}`);
  });
  return Array.from(new Set(pipelineIds)).sort((left, right) => left.localeCompare(right));
}

function listExpectedProtocolPackageIds(desired: DesiredHostState | undefined): string[] {
  if (!desired) {
    return [];
  }

  return desired.assignments
    .flatMap((assignment) =>
      assignment.deploymentKind === "service_module" && assignment.serviceModule
        ? [assignment.serviceModule.protocolPackage.packageId]
        : []
    )
    .sort((left, right) => left.localeCompare(right));
}

function listObservedPipelineIdsForReadModel(
  runtimeSummary: unknown,
  query: Pick<RuntimeSummaryReadModelQuery, "deploymentId">
): string[] {
  const pipelineIds = listObservedPipelineIds(runtimeSummary);
  if (query.deploymentId === undefined) {
    return pipelineIds;
  }
  const deploymentId = query.deploymentId;
  return pipelineIds.filter((pipelineId) =>
    isRuntimePipelineIdForDeployment(pipelineId, deploymentId)
  );
}

function listObservedProtocolPackageIdsForReadModel(
  runtimeSummary: unknown,
  expectedProtocolPackageIds: string[],
  query: Pick<RuntimeSummaryReadModelQuery, "deploymentId">
): string[] {
  const protocolPackageIds = listObservedProtocolPackageIds(runtimeSummary);
  if (query.deploymentId === undefined) {
    return protocolPackageIds;
  }

  const scoped = listObservedProtocolPackageIdsForDeployment(runtimeSummary, query.deploymentId);
  if (scoped.hasDeploymentMetadata) {
    return scoped.packageIds;
  }

  const expectedSet = new Set(expectedProtocolPackageIds);
  return protocolPackageIds.filter((packageId) => expectedSet.has(packageId));
}

function isRuntimePipelineIdForDeployment(pipelineId: string, deploymentId: string): boolean {
  return pipelineId.includes(`:${deploymentId}:`);
}

function listObservedDeploymentRuntimeIds(
  runtimeSummary: unknown,
  deploymentId: string,
  expectedIds: string[]
): string[] {
  if (!runtimeSummary || typeof runtimeSummary !== "object") {
    return [];
  }

  if (expectedIds.some((value) => value.startsWith("assign:"))) {
    const pipelines = (runtimeSummary as { pipelines?: unknown }).pipelines;
    if (!Array.isArray(pipelines)) {
      return [];
    }
    return pipelines
      .flatMap((pipeline) => {
        if (!pipeline || typeof pipeline !== "object") {
          return [];
        }
        const pipelineId = (pipeline as { pipelineId?: unknown }).pipelineId;
        return typeof pipelineId === "string" && pipelineId.includes(`:${deploymentId}:`)
          ? [pipelineId]
          : [];
      })
      .sort((left, right) => left.localeCompare(right));
  }

  const activeProtocolPackages = (runtimeSummary as { activeProtocolPackages?: unknown }).activeProtocolPackages;
  if (!Array.isArray(activeProtocolPackages)) {
    return [];
  }
  const scoped = listObservedProtocolPackageIdsForDeployment(runtimeSummary, deploymentId);
  if (scoped.hasDeploymentMetadata) {
    return scoped.packageIds;
  }
  if (expectedIds.length === 0) {
    return [];
  }

  return listObservedProtocolPackageIds(runtimeSummary);
}

function listObservedProtocolPackageIdsForDeployment(
  runtimeSummary: unknown,
  deploymentId: string
): { packageIds: string[]; hasDeploymentMetadata: boolean } {
  if (!runtimeSummary || typeof runtimeSummary !== "object") {
    return {
      packageIds: [],
      hasDeploymentMetadata: false
    };
  }

  const activeProtocolPackages = (runtimeSummary as { activeProtocolPackages?: unknown }).activeProtocolPackages;
  if (!Array.isArray(activeProtocolPackages)) {
    return {
      packageIds: [],
      hasDeploymentMetadata: false
    };
  }

  let hasDeploymentMetadata = false;
  const packageIds = activeProtocolPackages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const entryDeploymentId = (entry as { deploymentId?: unknown }).deploymentId;
    if (typeof entryDeploymentId === "string") {
      hasDeploymentMetadata = true;
      if (entryDeploymentId !== deploymentId) {
        return [];
      }
    } else {
      return [];
    }
    const packageId = (entry as { packageId?: unknown }).packageId;
    return typeof packageId === "string" ? [packageId] : [];
  });

  return {
    packageIds: Array.from(new Set(packageIds)).sort((left, right) => left.localeCompare(right)),
    hasDeploymentMetadata
  };
}

function listObservedPipelineIds(runtimeSummary: unknown): string[] {
  if (!runtimeSummary || typeof runtimeSummary !== "object") {
    return [];
  }

  const pipelines = (runtimeSummary as { pipelines?: unknown }).pipelines;
  if (!Array.isArray(pipelines)) {
    return [];
  }

  return pipelines
    .flatMap((pipeline) => {
      if (!pipeline || typeof pipeline !== "object") {
        return [];
      }
      const pipelineId = (pipeline as { pipelineId?: unknown }).pipelineId;
      return typeof pipelineId === "string" ? [pipelineId] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function listObservedProtocolPackageIds(runtimeSummary: unknown): string[] {
  if (!runtimeSummary || typeof runtimeSummary !== "object") {
    return [];
  }

  const activeProtocolPackages = (runtimeSummary as { activeProtocolPackages?: unknown }).activeProtocolPackages;
  if (!Array.isArray(activeProtocolPackages)) {
    return [];
  }

  return activeProtocolPackages
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const packageId = (entry as { packageId?: unknown }).packageId;
      return typeof packageId === "string" ? [packageId] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function computeMissingValues(expected: string[], observed: string[]): string[] {
  const observedSet = new Set(observed);
  return expected.filter((value) => !observedSet.has(value));
}

function resolveRuntimeSummaryStatus(input: {
  reported: boolean;
  missingCount: number;
  unexpectedCount: number;
}): RuntimeSummaryStatus {
  if (!input.reported) {
    return input.missingCount === 0 && input.unexpectedCount === 0 ? "match" : "not_reported";
  }
  return input.missingCount === 0 && input.unexpectedCount === 0 ? "match" : "drift";
}

function buildRouteForHost(
  hostId: string,
  deployment: HttpWorkerDeploymentPlan,
  upstreamBaseUrl: string
): NonNullable<DesiredHostState["sharedHttpForwardConfig"]>["routes"][number] {
  return {
    routeId: buildRouteIdForHost(hostId, deployment),
    match: {
      pathPrefix: buildRoutePathPrefixForHost(hostId, deployment)
    },
    upstream: {
      baseUrl: deployment.upstreamBaseUrl ?? upstreamBaseUrl
    }
  };
}

function buildRouteIdForHost(hostId: string, deployment: HttpWorkerDeploymentPlan): string {
  if ((deployment.routeScope ?? "shared") === "per_host") {
    return `${deployment.routeId}:${hostId}`;
  }
  return deployment.routeId;
}

function buildRoutePathPrefixForHost(hostId: string, deployment: HttpWorkerDeploymentPlan): string {
  if ((deployment.routeScope ?? "shared") === "per_host") {
    return `${deployment.routePathPrefix}/${encodeURIComponent(hostId)}`;
  }
  return deployment.routePathPrefix;
}

function buildIngressGroupRequirements(desiredHostStates: DesiredHostState[]): PlacementIngressGroupRequirement[] {
  const requirementsByGroupKey = new Map<
    string,
    {
      groupId?: string;
      requiredProtocolPackages: Map<string, PlacementIngressGroupRequirement["requiredProtocolPackages"][number]>;
    }
  >();

  for (const desired of desiredHostStates) {
    for (const assignment of desired.assignments) {
      const protocolPackage = assignment.serviceModule?.protocolPackage;
      if (!protocolPackage) {
        continue;
      }
      const groupId = assignment.groupId;
      const groupKey = groupId ?? "__default__";
      const entry = requirementsByGroupKey.get(groupKey) ?? {
        groupId,
        requiredProtocolPackages: new Map()
      };
      entry.requiredProtocolPackages.set(protocolPackage.packageId, toServiceModuleProtocolPackageRef(protocolPackage));
      requirementsByGroupKey.set(groupKey, entry);
    }
  }

  return Array.from(requirementsByGroupKey.values())
    .filter((entry) => entry.requiredProtocolPackages.size > 0)
    .map((entry) => ({
      ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
      requiredProtocolPackages: Array.from(entry.requiredProtocolPackages.values()).sort((left, right) =>
        left.packageId.localeCompare(right.packageId)
      )
    }))
    .sort((left, right) => (left.groupId ?? "").localeCompare(right.groupId ?? ""));
}

function buildDesiredRevision(
  hostId: string,
  revisionToken: number,
  assignments: Assignment[]
): string {
  const assignmentKey = assignments
    .map((assignment) => `${assignment.deploymentId}:${assignment.assignmentId}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
  return `demo-rev:${revisionToken}:${hostId}:${assignmentKey || "empty"}`;
}
