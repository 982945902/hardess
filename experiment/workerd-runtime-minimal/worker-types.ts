export interface ResolvedRouteEntry {
  routeId: string;
  pathPrefix: string;
  actionId: string;
  methods: string[];
  websocketEnabled: boolean;
  actionKind: "http" | "websocket";
  upstreamBaseUrl: string;
}

export interface Env {
  DEMO_SECRET: string;
  DEMO_TOKEN: string;
  RUNTIME_META: {
    runtime: string;
    experiment: string;
  };
  HARDESS_ASSIGNMENT_META: {
    assignmentId: string;
    hostId: string;
    deploymentId: string;
    declaredVersion: string;
    manifestId: string;
    routeRefs: string[];
  };
  HARDESS_CONFIG: {
    experiment: string;
  };
  HARDESS_ROUTE_TABLE?: ResolvedRouteEntry[];
  HARDESS_RESOLVED_RUNTIME_MODEL: {
    runtime: {
      listenAddress: string;
      socketName: string;
    };
    protocolPackage: {
      packageId: string;
      protocol: string;
      version: string;
      actionCount: number;
      actionIds: string[];
    };
    bindingContract: {
      primaryRuntimeBinding: "HARDESS_RESOLVED_RUNTIME_MODEL";
      compatibilityBindings: string[];
      metadataBindings: string[];
    };
    diagnostics: {
      routeCount: number;
      httpRouteCount: number;
      websocketRouteCount: number;
      rootRouteId: string | null;
      methods: string[];
      bindingNames: string[];
      secretNames: string[];
      advisoryCount: number;
      advisorySeverityCounts: {
        info: number;
        warning: number;
      };
      highestAdvisorySeverity: "none" | "info" | "warning";
    };
    advisories: Array<{
      severity: "info" | "warning";
      code: string;
      message: string;
      routeId?: string;
    }>;
    routes: ResolvedRouteEntry[];
  };
  HARDESS_PROTOCOL_PACKAGE?: {
    packageId: string;
  };
}

export interface RuntimeStateSnapshot {
  runtimeName: "hardess.workerd.worker-runtime.v1";
  instanceId: string;
  runtimeKey: string;
  startedAtEpochMs: number;
  requestSequence: number;
  totalRequests: number;
  routeHitCount: number;
  routeHits: Array<{
    routeId: string;
    count: number;
  }>;
  routeRequestCounts: Record<string, number>;
  websocketSessionCount: number;
}

export interface RuntimeDispatchDiagnostics {
  registeredActionIds: string[];
  dispatchableActionIds: string[];
  unhandledActionIds: string[];
  unhandledRouteIds: string[];
}

export interface RuntimeRequestContext {
  request: Request;
  env: Env;
  url: URL;
  route: ResolvedRouteEntry;
  requestSequence: number;
  routeHitCount: number;
  workerRuntime: () => RuntimeStateSnapshot;
  dispatchDiagnostics: RuntimeDispatchDiagnostics;
}

export type RuntimeActionHandler = (context: RuntimeRequestContext) => Promise<Response>;
