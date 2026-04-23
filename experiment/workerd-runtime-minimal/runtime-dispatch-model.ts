export type RuntimeRouteDispatchMode =
  | "http_handler"
  | "websocket_builtin"
  | "unhandled_http_action";

export interface RuntimeDispatchRouteShape {
  routeId: string;
  actionId: string;
  actionKind: "http" | "websocket";
}

export interface RuntimeDispatchDiagnostics {
  registeredActionIds: string[];
  dispatchableActionIds: string[];
  unhandledActionIds: string[];
  unhandledRouteIds: string[];
  routeDispatchModes: Record<string, RuntimeRouteDispatchMode>;
}

export const EXPERIMENT_HTTP_HANDLER_ACTION_IDS = ["http.info", "http.echo"] as const;

function orderedUniqueValues(values: Iterable<string>): string[] {
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

export function assertExpectedHttpHandlerActionIds(actionIds: Iterable<string>): void {
  const actual = orderedUniqueValues(actionIds);
  const expected = [...EXPERIMENT_HTTP_HANDLER_ACTION_IDS];

  if (actual.length !== expected.length || actual.some((actionId, index) => actionId !== expected[index])) {
    throw new Error(
      `worker action handler ids drifted from runtime dispatch model: expected=${expected.join(",")} actual=${actual.join(",")}`,
    );
  }
}

export function classifyRouteDispatchMode(
  route: RuntimeDispatchRouteShape,
  registeredActionIds: Iterable<string>,
): RuntimeRouteDispatchMode {
  if (route.actionKind === "websocket") {
    return "websocket_builtin";
  }

  return new Set(registeredActionIds).has(route.actionId) ? "http_handler" : "unhandled_http_action";
}

export function buildRuntimeDispatchDiagnostics(
  routes: RuntimeDispatchRouteShape[],
  registeredActionIds: Iterable<string>,
): RuntimeDispatchDiagnostics {
  const registeredActionIdList = orderedUniqueValues(registeredActionIds);
  const registeredActionIdSet = new Set(registeredActionIdList);
  const routeDispatchModes = Object.fromEntries(
    routes.map((route) => [route.routeId, classifyRouteDispatchMode(route, registeredActionIdSet)]),
  ) as Record<string, RuntimeRouteDispatchMode>;
  const dispatchableActionIds = orderedUniqueValues(
    routes
      .filter((route) => route.actionKind === "websocket" || registeredActionIdSet.has(route.actionId))
      .map((route) => route.actionId),
  );
  const unhandledRoutes = routes.filter(
    (route) => route.actionKind === "http" && !registeredActionIdSet.has(route.actionId),
  );

  return {
    registeredActionIds: registeredActionIdList,
    dispatchableActionIds,
    unhandledActionIds: orderedUniqueValues(unhandledRoutes.map((route) => route.actionId)),
    unhandledRouteIds: unhandledRoutes.map((route) => route.routeId),
    routeDispatchModes,
  };
}
