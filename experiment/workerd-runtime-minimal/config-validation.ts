import type {
  Assignment,
  PlanningFragment,
  ProtocolAction,
  ProtocolPackage,
  Route,
  RuntimeAdapter
} from "./config-model";

export interface ResolvedRoute {
  routeId: string;
  pathPrefix: string;
  actionId: string;
  websocketEnabled: boolean;
  actionKind: "http" | "websocket";
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

function validateRuntimeAdapter(runtimeAdapter: RuntimeAdapter): void {
  assertUniqueValues(runtimeAdapter.compatibilityFlags, "runtime-adapter compatibilityFlag");

  const separatorIndex = runtimeAdapter.listenAddress.lastIndexOf(":");
  if (separatorIndex <= 0 || separatorIndex === runtimeAdapter.listenAddress.length - 1) {
    throw new Error(`runtime-adapter listenAddress must be host:port: ${runtimeAdapter.listenAddress}`);
  }

  const port = Number(runtimeAdapter.listenAddress.slice(separatorIndex + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`runtime-adapter port must be between 1 and 65535: ${runtimeAdapter.listenAddress}`);
  }
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

export function resolveRoutes(
  assignment: Assignment,
  runtimeAdapter: RuntimeAdapter,
  planningFragment: PlanningFragment,
  protocolPackage: ProtocolPackage
): ResolvedRoute[] {
  validateAssignment(assignment);
  validateRuntimeAdapter(runtimeAdapter);
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
      websocketEnabled: Boolean(route.upstream.websocketEnabled),
      actionKind: action.kind
    };
  });
}
