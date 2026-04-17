export type DeploymentKind = "http_worker" | "service_module";

export interface HostStaticCapacity {
  maxHttpWorkerAssignments?: number;
  maxServiceModuleAssignments?: number;
  maxConnections?: number;
  maxInflightRequests?: number;
}

export interface HostRegistration {
  hostId: string;
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
  };
  serviceModule?: {
    name: string;
    entry: string;
  };
  authPolicyRef?: string;
  secretRefs?: string[];
}

export type MembershipHostState = "ready" | "draining" | "offline";

export interface MembershipHost {
  hostId: string;
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
  ownerHostIds: string[];
  routes: Array<{
    routeId: string;
    pathPrefix: string;
    ownerHostIds: string[];
  }>;
}

export interface PlacementSnapshot {
  revision: string;
  generatedAt: number;
  deployments: PlacementDeployment[];
}

export interface DesiredTopology {
  membership: MembershipSnapshot;
  placement: PlacementSnapshot;
}

export interface DesiredHostState {
  hostId: string;
  revision: string;
  generatedAt: number;
  assignments: Assignment[];
  topology?: DesiredTopology;
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
  packageManager: {
    kind: "deno";
    denoJson?: string;
    denoLock?: string;
    frozenLock?: boolean;
  };
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
