import { json } from "./worker-response.ts";
import type { RuntimeActionHandler, RuntimeRequestContext } from "./worker-types.ts";

async function handleInfo({
  env,
  route,
  request,
  url,
  workerRuntime,
}: RuntimeRequestContext): Promise<Response> {
  return json({
    ok: true,
    runtime: env.RUNTIME_META.runtime,
    experiment: env.RUNTIME_META.experiment,
    configExperiment: env.HARDESS_CONFIG.experiment,
    secret: env.DEMO_SECRET,
    tokenPresent: env.DEMO_TOKEN.length > 0,
    assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
    deploymentId: env.HARDESS_ASSIGNMENT_META.deploymentId,
    declaredVersion: env.HARDESS_ASSIGNMENT_META.declaredVersion,
    manifestId: env.HARDESS_ASSIGNMENT_META.manifestId,
    routeId: route.routeId,
    actionId: route.actionId,
    dispatchSource: "resolved_runtime_model",
    protocolPackageId: env.HARDESS_RESOLVED_RUNTIME_MODEL.protocolPackage.packageId,
    routeRefCount: env.HARDESS_ASSIGNMENT_META.routeRefs.length,
    resolvedRouteCount: env.HARDESS_RESOLVED_RUNTIME_MODEL.routes.length,
    resolvedListenAddress: env.HARDESS_RESOLVED_RUNTIME_MODEL.runtime.listenAddress,
    resolvedProtocolActionCount: env.HARDESS_RESOLVED_RUNTIME_MODEL.protocolPackage.actionCount,
    resolvedProtocolActionIds: env.HARDESS_RESOLVED_RUNTIME_MODEL.protocolPackage.actionIds,
    resolvedPrimaryRuntimeBinding: env.HARDESS_RESOLVED_RUNTIME_MODEL.bindingContract.primaryRuntimeBinding,
    resolvedCompatibilityBindings: env.HARDESS_RESOLVED_RUNTIME_MODEL.bindingContract.compatibilityBindings,
    resolvedMetadataBindings: env.HARDESS_RESOLVED_RUNTIME_MODEL.bindingContract.metadataBindings,
    resolvedHttpRouteCount: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.httpRouteCount,
    resolvedWebsocketRouteCount: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.websocketRouteCount,
    resolvedRootRouteId: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.rootRouteId,
    resolvedBindingNames: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.bindingNames,
    resolvedSecretNames: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.secretNames,
    resolvedAdvisoryCount: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.advisoryCount,
    resolvedAdvisorySeverityCounts: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.advisorySeverityCounts,
    resolvedHighestAdvisorySeverity: env.HARDESS_RESOLVED_RUNTIME_MODEL.diagnostics.highestAdvisorySeverity,
    resolvedAdvisoryCodes: env.HARDESS_RESOLVED_RUNTIME_MODEL.advisories.map((advisory) => advisory.code),
    resolvedAdvisorySeverities: env.HARDESS_RESOLVED_RUNTIME_MODEL.advisories.map(
      (advisory) => advisory.severity,
    ),
    allowedMethods: route.methods,
    method: request.method,
    path: url.pathname,
    workerRuntime: workerRuntime(),
  });
}

async function handleEcho({ env, route, request, url, workerRuntime }: RuntimeRequestContext): Promise<Response> {
  const body = await request.text();
  return json({
    ok: true,
    runtime: env.RUNTIME_META.runtime,
    assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
    routeId: route.routeId,
    actionId: route.actionId,
    dispatchSource: "resolved_runtime_model",
    path: url.pathname,
    echo: body,
    length: body.length,
    workerRuntime: workerRuntime(),
  });
}

export function createActionHandlers(): Map<string, RuntimeActionHandler> {
  return new Map<string, RuntimeActionHandler>([
    ["http.info", handleInfo],
    ["http.echo", handleEcho],
  ]);
}
