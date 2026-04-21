import type { Assignment, PlanningFragment, ProtocolAction, ProtocolPackage, Route, RuntimeAdapter } from "./config-model";
import { isIP } from "node:net";

export const RESOLVED_RUNTIME_MODEL_SCHEMA_VERSION = "hardess.workerd.resolved-runtime-model.v1";
export const RESOLVED_RUNTIME_SUMMARY_SCHEMA_VERSION = "hardess.workerd.runtime-summary.v1";

export type CompatibilityBindingName = "HARDESS_ROUTE_TABLE" | "HARDESS_PROTOCOL_PACKAGE";
export type MetadataBindingName = "HARDESS_ASSIGNMENT_META" | "HARDESS_CONFIG";

export interface ResolvedRoute {
  routeId: string;
  pathPrefix: string;
  actionId: string;
  methods: string[];
  websocketEnabled: boolean;
  actionKind: "http" | "websocket";
  upstreamBaseUrl: string;
}

export interface ResolvedRuntimeAdvisory {
  severity: "info" | "warning";
  code:
    | "root_catch_all_route"
    | "non_tls_http_upstream"
    | "non_tls_websocket_upstream";
  message: string;
  routeId?: string;
}

export interface ResolvedRuntimeSummary {
  schemaVersion: typeof RESOLVED_RUNTIME_SUMMARY_SCHEMA_VERSION;
  assignmentId: string;
  deploymentId: string;
  runtime: {
    listenAddress: string;
    socketName: string;
  };
  primaryRuntimeBinding: "HARDESS_RESOLVED_RUNTIME_MODEL";
  compatibilityBindings: CompatibilityBindingName[];
  metadataBindings: MetadataBindingName[];
  routeCount: number;
  httpRouteCount: number;
  websocketRouteCount: number;
  highestAdvisorySeverity: "none" | "info" | "warning";
  advisoryCount: number;
  routes: Array<{
    routeId: string;
    pathPrefix: string;
    actionId: string;
    actionKind: "http" | "websocket";
    methods: string[];
  }>;
  advisories: Array<{
    severity: "info" | "warning";
    code: ResolvedRuntimeAdvisory["code"];
    routeId?: string;
  }>;
}

export interface ResolvedRuntimeModel {
  schemaVersion: typeof RESOLVED_RUNTIME_MODEL_SCHEMA_VERSION;
  assignment: {
    assignmentId: string;
    hostId: string;
    deploymentId: string;
    declaredVersion: string;
    manifestId: string;
    routeRefs: string[];
  };
  runtime: {
    socketName: string;
    listenAddress: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
  };
  worker: {
    name: string;
    entry: string;
    bindings: Record<string, unknown>;
    secrets: string[];
    config: Record<string, unknown>;
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
    compatibilityBindings: CompatibilityBindingName[];
    metadataBindings: MetadataBindingName[];
  };
  diagnostics: {
    routeCount: number;
    httpRouteCount: number;
    websocketRouteCount: number;
    rootRouteId: string | null;
    routeIds: string[];
    actionIds: string[];
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
  advisories: ResolvedRuntimeAdvisory[];
  routes: ResolvedRoute[];
}

function assertUniqueValues(values: string[], label: string): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function orderedUniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function computeAdvisories(routes: ResolvedRoute[]): ResolvedRuntimeAdvisory[] {
  const advisories: ResolvedRuntimeAdvisory[] = [];
  const rootRoute = routes.find((route) => route.pathPrefix === "/") ?? null;

  if (rootRoute && routes.length > 1) {
    advisories.push({
      severity: "info",
      code: "root_catch_all_route",
      routeId: rootRoute.routeId,
      message: "root pathPrefix / will catch all unmatched paths; rely on longest-prefix routing for overrides"
    });
  }

  for (const route of routes) {
    const scheme = new URL(route.upstreamBaseUrl).protocol;

    if (route.actionKind === "http" && scheme === "http:") {
      advisories.push({
        severity: "warning",
        code: "non_tls_http_upstream",
        routeId: route.routeId,
        message: `route uses non-TLS HTTP upstream: ${route.upstreamBaseUrl}`
      });
    }

    if (route.actionKind === "websocket" && scheme === "ws:") {
      advisories.push({
        severity: "warning",
        code: "non_tls_websocket_upstream",
        routeId: route.routeId,
        message: `route uses non-TLS WebSocket upstream: ${route.upstreamBaseUrl}`
      });
    }
  }

  return advisories;
}

function resolveCompatibilityBindings(runtimeAdapter: RuntimeAdapter): CompatibilityBindingName[] {
  const bindings: CompatibilityBindingName[] = [];

  if (runtimeAdapter.compatibilityBindings.routeTable) {
    bindings.push("HARDESS_ROUTE_TABLE");
  }

  if (runtimeAdapter.compatibilityBindings.protocolPackage) {
    bindings.push("HARDESS_PROTOCOL_PACKAGE");
  }

  return bindings;
}

function isValidUrlScheme(value: string, schemes: string[]): boolean {
  try {
    const url = new URL(value);
    return schemes.includes(url.protocol);
  } catch {
    return false;
  }
}

function validateAssignment(assignment: Assignment): void {
  assertUniqueValues(assignment.httpWorker.routeRefs, "assignment routeRef");
}

function validateCompatibilityDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`runtime-adapter compatibilityDate must be YYYY-MM-DD: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`runtime-adapter compatibilityDate must be real calendar date: ${value}`);
  }
}

function validateListenAddress(value: string): void {
  let host = "";
  let portText = "";

  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(value);
    if (!match) {
      throw new Error(`runtime-adapter listenAddress must be host:port: ${value}`);
    }
    host = match[1];
    portText = match[2];

    if (isIP(host) !== 6) {
      throw new Error(`runtime-adapter bracketed host must be valid IPv6: ${value}`);
    }
  } else {
    const separatorIndex = value.lastIndexOf(":");
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
      throw new Error(`runtime-adapter listenAddress must be host:port: ${value}`);
    }

    host = value.slice(0, separatorIndex);
    portText = value.slice(separatorIndex + 1);

    if (host.includes(":")) {
      throw new Error(`runtime-adapter IPv6 listenAddress must use brackets: ${value}`);
    }

    const isIpv4 = isIP(host) === 4;
    const isHostname = /^[A-Za-z0-9.-]+$/.test(host) && !host.startsWith(".") && !host.endsWith(".");
    if (!isIpv4 && !isHostname) {
      throw new Error(`runtime-adapter host must be IPv4, hostname, or bracketed IPv6: ${value}`);
    }
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`runtime-adapter port must be between 1 and 65535: ${value}`);
  }
}

function validateRuntimeAdapter(runtimeAdapter: RuntimeAdapter): void {
  assertUniqueValues(runtimeAdapter.compatibilityFlags, "runtime-adapter compatibilityFlag");
  validateCompatibilityDate(runtimeAdapter.compatibilityDate);
  validateListenAddress(runtimeAdapter.listenAddress);
}

function validateProtocolAction(action: ProtocolAction): void {
  assertUniqueValues(action.methods, `protocol-package methods for action ${action.actionId}`);

  for (const method of action.methods) {
    if (!/^[A-Z]+$/.test(method)) {
      throw new Error(`protocol-package method must be uppercase token: ${action.actionId}:${method}`);
    }
  }

  if (action.kind === "websocket" && (action.methods.length !== 1 || action.methods[0] !== "GET")) {
    throw new Error(`websocket action must use exactly GET method: ${action.actionId}`);
  }
}

function validateProtocolPackage(protocolPackage: ProtocolPackage): void {
  assertUniqueValues(
    protocolPackage.actions.map((action) => action.actionId),
    "protocol-package actionId"
  );

  for (const action of protocolPackage.actions) {
    validateProtocolAction(action);

    if (action.kind === "websocket" && action.websocket !== true) {
      throw new Error(`websocket action must declare websocket=true: ${action.actionId}`);
    }

    if (action.kind === "http" && action.websocket === true) {
      throw new Error(`http action cannot declare websocket=true: ${action.actionId}`);
    }
  }
}

function validatePlanningFragment(planningFragment: PlanningFragment): void {
  const routes = planningFragment.sharedHttpForwardConfig.routes;
  assertUniqueValues(
    routes.map((route) => route.routeId),
    "planning routeId"
  );
  assertUniqueValues(
    routes.map((route) => route.match.pathPrefix),
    "planning pathPrefix"
  );

  for (const route of routes) {
    const { routeId } = route;
    const { pathPrefix } = route.match;

    if (!pathPrefix.startsWith("/")) {
      throw new Error(`planning pathPrefix must start with /: ${routeId}`);
    }

    if (pathPrefix !== "/" && pathPrefix.endsWith("/")) {
      throw new Error(`planning pathPrefix must not end with /: ${routeId}`);
    }

    if (pathPrefix.includes("//")) {
      throw new Error(`planning pathPrefix must not contain //: ${routeId}`);
    }
  }
}

function buildRouteIndex(planningFragment: PlanningFragment): Map<string, Route> {
  validatePlanningFragment(planningFragment);
  return new Map(
    planningFragment.sharedHttpForwardConfig.routes.map((route) => [route.routeId, route] as const)
  );
}

function buildActionIndex(protocolPackage: ProtocolPackage): Map<string, ProtocolAction> {
  validateProtocolPackage(protocolPackage);
  return new Map(protocolPackage.actions.map((action) => [action.actionId, action] as const));
}

function resolveRoutes(
  assignment: Assignment,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage
): ResolvedRoute[] {
  const routesById = buildRouteIndex(planningFragment);
  const actionsById = buildActionIndex(protocolPackage);

  return assignment.httpWorker.routeRefs.map((routeRef) => {
    const route = routesById.get(routeRef);
    if (!route) {
      throw new Error(`routeRef not found in planning fragment: ${routeRef}`);
    }

    const action = actionsById.get(route.actionId);
    if (!action) {
      throw new Error(`actionId not found in protocol package: ${route.actionId}`);
    }

    if (action.kind === "websocket" && !route.upstream.websocketEnabled) {
      throw new Error(`websocket route must enable upstream websocket: ${route.routeId}`);
    }

    if (action.kind === "http" && route.upstream.websocketEnabled) {
      throw new Error(`http route cannot enable upstream websocket: ${route.routeId}`);
    }

    if (action.kind === "http" && !isValidUrlScheme(route.upstream.baseUrl, ["http:", "https:"])) {
      throw new Error(`http route must use http/https upstream: ${route.routeId}`);
    }

    if (action.kind === "websocket" && !isValidUrlScheme(route.upstream.baseUrl, ["ws:", "wss:"])) {
      throw new Error(`websocket route must use ws/wss upstream: ${route.routeId}`);
    }

    return {
      routeId: route.routeId,
      pathPrefix: route.match.pathPrefix,
      actionId: route.actionId,
      methods: [...action.methods],
      websocketEnabled: Boolean(route.upstream.websocketEnabled),
      actionKind: action.kind,
      upstreamBaseUrl: route.upstream.baseUrl
    };
  });
}

export function resolveRuntimeModel(
  assignment: Assignment,
  runtimeAdapter: RuntimeAdapter,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage
): ResolvedRuntimeModel {
  validateAssignment(assignment);
  validateRuntimeAdapter(runtimeAdapter);
  const routes = resolveRoutes(assignment, planningFragment, protocolPackage);
  const httpRouteCount = routes.filter((route) => route.actionKind === "http").length;
  const websocketRouteCount = routes.filter((route) => route.actionKind === "websocket").length;
  const rootRoute = routes.find((route) => route.pathPrefix === "/") ?? null;
  const advisories = computeAdvisories(routes);
  const compatibilityBindings = resolveCompatibilityBindings(runtimeAdapter);
  const advisorySeverityCounts = {
    info: advisories.filter((advisory) => advisory.severity === "info").length,
    warning: advisories.filter((advisory) => advisory.severity === "warning").length
  };
  const highestAdvisorySeverity =
    advisorySeverityCounts.warning > 0 ? "warning" : advisorySeverityCounts.info > 0 ? "info" : "none";

  return {
    schemaVersion: RESOLVED_RUNTIME_MODEL_SCHEMA_VERSION,
    assignment: {
      assignmentId: assignment.assignmentId,
      hostId: assignment.hostId,
      deploymentId: assignment.deploymentId,
      declaredVersion: assignment.declaredVersion,
      manifestId: assignment.artifact.manifestId,
      routeRefs: [...assignment.httpWorker.routeRefs]
    },
    runtime: {
      socketName: runtimeAdapter.socketName,
      listenAddress: runtimeAdapter.listenAddress,
      compatibilityDate: runtimeAdapter.compatibilityDate,
      compatibilityFlags: [...runtimeAdapter.compatibilityFlags]
    },
    worker: {
      name: assignment.httpWorker.name,
      entry: assignment.httpWorker.entry,
      bindings: { ...assignment.httpWorker.deployment.bindings },
      secrets: Object.keys(assignment.httpWorker.deployment.secrets),
      config: { ...assignment.httpWorker.deployment.config }
    },
    protocolPackage: {
      packageId: protocolPackage.packageId,
      protocol: protocolPackage.protocol,
      version: protocolPackage.version,
      actionCount: protocolPackage.actions.length,
      actionIds: protocolPackage.actions.map((action) => action.actionId)
    },
    bindingContract: {
      primaryRuntimeBinding: "HARDESS_RESOLVED_RUNTIME_MODEL",
      compatibilityBindings,
      metadataBindings: ["HARDESS_ASSIGNMENT_META", "HARDESS_CONFIG"]
    },
    diagnostics: {
      routeCount: routes.length,
      httpRouteCount,
      websocketRouteCount,
      rootRouteId: rootRoute?.routeId ?? null,
      routeIds: routes.map((route) => route.routeId),
      actionIds: orderedUniqueValues(routes.map((route) => route.actionId)),
      methods: orderedUniqueValues(routes.flatMap((route) => route.methods)),
      bindingNames: Object.keys(assignment.httpWorker.deployment.bindings),
      secretNames: Object.keys(assignment.httpWorker.deployment.secrets),
      advisoryCount: advisories.length,
      advisorySeverityCounts,
      highestAdvisorySeverity
    },
    summary: {
      schemaVersion: RESOLVED_RUNTIME_SUMMARY_SCHEMA_VERSION,
      assignmentId: assignment.assignmentId,
      deploymentId: assignment.deploymentId,
      runtime: {
        listenAddress: runtimeAdapter.listenAddress,
        socketName: runtimeAdapter.socketName
      },
      primaryRuntimeBinding: "HARDESS_RESOLVED_RUNTIME_MODEL",
      compatibilityBindings,
      metadataBindings: ["HARDESS_ASSIGNMENT_META", "HARDESS_CONFIG"],
      routeCount: routes.length,
      httpRouteCount,
      websocketRouteCount,
      highestAdvisorySeverity,
      advisoryCount: advisories.length,
      routes: routes.map((route) => ({
        routeId: route.routeId,
        pathPrefix: route.pathPrefix,
        actionId: route.actionId,
        actionKind: route.actionKind,
        methods: route.methods
      })),
      advisories: advisories.map((advisory) => ({
        severity: advisory.severity,
        code: advisory.code,
        routeId: advisory.routeId
      }))
    },
    advisories,
    routes
  };
}
