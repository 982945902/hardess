export type DeploymentKind = "http_worker" | "service_module" | "serve";

export interface ServiceModuleProtocolPackageRef {
  packageId: string;
  digest: string;
  assignmentId?: string;
  deploymentId?: string;
  declaredVersion?: string;
}

export interface ServiceModuleProtocolPackage {
  packageId: string;
  protocol: string;
  version: string;
  actions: string[];
  digest: string;
}

export interface RuntimeSummaryPipelineView {
  pipelineId: string;
  matchPrefix: string;
  groupId?: string;
  authRequired: boolean;
  downstreamOrigin: string;
  downstreamConnectTimeoutMs: number;
  downstreamResponseTimeoutMs: number;
  websocketEnabled: boolean;
  workerConfigured: boolean;
  workerEntry?: string;
  workerTimeoutMs?: number;
  deploymentInstanceKey?: string;
  deploymentConfigKeys?: string[];
  deploymentBindingKeys?: string[];
  deploymentSecretCount?: number;
}

export interface RuntimeSummaryView {
  pipelineCount: number;
  pipelines: RuntimeSummaryPipelineView[];
  activeProtocolPackages: ServiceModuleProtocolPackageRef[];
}

export interface HostStaticCapacity {
  maxHttpWorkerAssignments?: number;
  maxServiceModuleAssignments?: number;
  maxConnections?: number;
  maxInflightRequests?: number;
}

export interface HostRegistration {
  hostId: string;
  groupId?: string;
  nodeId?: string;
  startedAt: number;
  runtime: {
    kind: "hardess-v1";
    version: string;
    pid?: number;
  };
  network: {
    publicBaseUrl?: string;
    internalBaseUrl?: string;
    publicListenerEnabled: boolean;
    internalListenerEnabled: boolean;
  };
  staticLabels: Record<string, string>;
  staticCapabilities: string[];
  staticCapacity: HostStaticCapacity;
  dynamicFields?: Record<string, unknown>;
}

export interface Deployment {
  deploymentId: string;
  deploymentKind: DeploymentKind;
  groupId?: string;
  name: string;
  declaredVersion: string;
  declaredArtifactId?: string;
  replicas: number;
  artifact: {
    manifestId: string;
    sourceUri: string;
    digest?: string;
  };
  routeBindings?: Array<{
    routeId: string;
  }>;
  authPolicyRef?: string;
  secretRefs?: string[];
  scheduling?: {
    requiredLabels?: Record<string, string>;
    preferredLabels?: Record<string, string>;
  };
  rollout?: {
    strategy?: "gradual";
    maxUnavailable?: number;
    batchSize?: number;
  };
}

export interface Assignment {
  assignmentId: string;
  hostId: string;
  deploymentId: string;
  deploymentKind: DeploymentKind;
  groupId?: string;
  declaredVersion: string;
  declaredArtifactId?: string;
  artifact: {
    manifestId: string;
    sourceUri: string;
    digest?: string;
  };
  httpWorker?: {
    name: string;
    entry: string;
    routeRefs?: string[];
    deployment?: {
      config?: Record<string, unknown>;
      bindings?: Record<string, unknown>;
      secrets?: Record<string, string>;
    };
  };
  serviceModule?: {
    name: string;
    entry: string;
    protocolPackage: ServiceModuleProtocolPackage;
  };
  serveApp?: {
    name: string;
    entry: string;
    routeRefs?: string[];
    deployment?: {
      config?: Record<string, unknown>;
      bindings?: Record<string, unknown>;
      secrets?: Record<string, string>;
    };
  };
  authPolicyRef?: string;
  secretRefs?: string[];
}

export type MembershipHostState = "ready" | "draining" | "offline";

export interface MembershipHost {
  hostId: string;
  groupId?: string;
  nodeId?: string;
  publicBaseUrl?: string;
  internalBaseUrl?: string;
  publicListenerEnabled: boolean;
  internalListenerEnabled: boolean;
  state: MembershipHostState;
  staticLabels: Record<string, string>;
  staticCapabilities: string[];
  staticCapacity: HostStaticCapacity;
  lastSeenAt?: number;
}

export interface MembershipSnapshot {
  revision: string;
  generatedAt: number;
  hosts: MembershipHost[];
}

export interface PlacementDeployment {
  deploymentId: string;
  deploymentKind: DeploymentKind;
  groupId?: string;
  ownerHostIds: string[];
  routes: Array<{
    routeId: string;
    pathPrefix: string;
    ownerHostIds: string[];
  }>;
}

export interface PlacementIngressGroupRequirement {
  groupId?: string;
  requiredProtocolPackages: ServiceModuleProtocolPackageRef[];
}

export interface PlacementSnapshot {
  revision: string;
  generatedAt: number;
  deployments: PlacementDeployment[];
  ingressGroupRequirements?: PlacementIngressGroupRequirement[];
}

export interface DesiredTopology {
  membership: MembershipSnapshot;
  placement: PlacementSnapshot;
}

export interface RuntimeAuthTrustPublicKey {
  kid: string;
  alg: "RS256" | "ES256";
  pem: string;
}

export interface RuntimeAuthTokenIssuerTrust {
  issuer: string;
  audiences: string[];
  jwksUrl?: string;
  publicKeys?: RuntimeAuthTrustPublicKey[];
  algorithms?: Array<"RS256" | "ES256">;
  requiredClaims?: string[];
  clockSkewSec?: number;
  maxTokenTtlSec?: number;
}

export interface RuntimeAuthTrust {
  tokenIssuers: RuntimeAuthTokenIssuerTrust[];
}

export interface DesiredHostState {
  hostId: string;
  revision: string;
  generatedAt: number;
  assignments: Assignment[];
  topology?: DesiredTopology;
  runtimeAuthTrust?: RuntimeAuthTrust;
  sharedHttpForwardConfig?: {
    routes: Array<{
      routeId: string;
      match: {
        pathPrefix: string;
      };
      upstream: {
        baseUrl: string;
        websocketEnabled?: boolean;
      };
    }>;
  };
}

export type AssignmentObservedState =
  | "pending"
  | "preparing"
  | "ready"
  | "active"
  | "draining"
  | "failed";

export type RuntimeSummaryStatus = "match" | "drift" | "not_reported";

export interface RuntimeSummaryCheck {
  hostId: string;
  status: RuntimeSummaryStatus;
  reported: boolean;
  matches: boolean;
  expectedPipelineIds: string[];
  observedPipelineIds: string[];
  missingPipelineIds: string[];
  unexpectedPipelineIds: string[];
  expectedProtocolPackageIds: string[];
  observedProtocolPackageIds: string[];
  missingProtocolPackageIds: string[];
  unexpectedProtocolPackageIds: string[];
}

export interface RuntimeSummaryRollup {
  totalHosts: number;
  reportedHosts: number;
  matchingHosts: number;
  driftedHosts: number;
  notReportedHosts: number;
}

export interface RuntimeSummaryReadModelRolloutHostStatus {
  hostId: string;
  desiredAssignmentId?: string;
  desiredVersion?: string;
  observedState?: AssignmentObservedState | "missing";
  observedGenerationId?: string;
  runtimeSummaryReported?: boolean;
  runtimeSummaryStatus?: RuntimeSummaryStatus;
  runtimeSummaryMissingIds?: string[];
  runtimeSummaryUnexpectedIds?: string[];
  lastError?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface RuntimeSummaryReadModelDeploymentRolloutSummary {
  deploymentId: string;
  desiredHosts: number;
  activeHosts: number;
  readyHosts: number;
  preparingHosts: number;
  drainingHosts: number;
  failedHosts: number;
  pendingHosts: number;
  hosts: RuntimeSummaryReadModelRolloutHostStatus[];
}

export interface RuntimeSummaryReadModel {
  checks: RuntimeSummaryCheck[];
  rollup: RuntimeSummaryRollup;
  rolloutSummary: RuntimeSummaryReadModelDeploymentRolloutSummary[];
}

export interface RuntimeSummaryReadModelQuery {
  hostId?: string;
  deploymentId?: string;
}

export interface ObservedHostState {
  hostId: string;
  observedAt: number;
  ready: boolean;
  draining: boolean;
  staticLabels: Record<string, string>;
  staticCapabilities: string[];
  staticCapacity: HostStaticCapacity;
  dynamicState: {
    currentAssignmentCount: number;
    currentConnectionCount?: number;
    currentInflightRequests?: number;
    schedulable?: boolean;
    appliedTopology?: {
      membershipRevision?: string;
      placementRevision?: string;
    };
    resourceHints?: Record<string, number>;
    runtimeSummary?: RuntimeSummaryView;
    dynamicFields?: Record<string, unknown>;
  };
  assignmentStatuses: Array<{
    assignmentId: string;
    deploymentId: string;
    declaredVersion: string;
    generationId?: string;
    state: AssignmentObservedState;
    preparedAt?: number;
    activatedAt?: number;
    failedAt?: number;
    lastError?: {
      code: string;
      message: string;
      retryable?: boolean;
    };
  }>;
}

export type ArtifactPackageManager =
  | {
      kind: "bun";
      packageJson?: string;
      bunfigToml?: string;
      bunLock?: string;
      frozenLock?: boolean;
    }
  | {
      kind: "deno";
      denoJson?: string;
      denoLock?: string;
      frozenLock?: boolean;
    };

export interface ArtifactManifest {
  manifestId: string;
  artifactKind: DeploymentKind;
  declaredArtifactId?: string;
  declaredVersion: string;
  source: {
    uri: string;
    digest?: string;
  };
  entry: string;
  packageManager: ArtifactPackageManager;
  metadata?: {
    annotations?: Record<string, string>;
  };
}

export interface RegisterHostResult {
  hostId: string;
  accepted: boolean;
  pollAfterMs?: number;
}

export interface HeartbeatHostInput {
  hostId: string;
  observed: ObservedHostState;
}

export interface HeartbeatHostResult {
  accepted: boolean;
  nextPollAfterMs?: number;
}

export interface DesiredHostStateQuery {
  hostId: string;
  ifRevision?: string;
}

export interface DesiredHostStateResult {
  changed: boolean;
  desired?: DesiredHostState;
}

export interface ReportObservedHostStateResult {
  accepted: boolean;
}

export interface ArtifactManifestQuery {
  manifestId: string;
}
