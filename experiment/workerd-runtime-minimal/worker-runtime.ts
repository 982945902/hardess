import { WORKER_RUNTIME_ACTION_SCHEMA_VERSION } from "./worker-action-contract.ts";
import { createActionHandlers } from "./worker-actions.ts";
import { isWorkerRuntimeAdminPath } from "./worker-admin-contract.ts";
import { WORKER_RUNTIME_ERROR_SCHEMA_VERSION } from "./worker-error-contract.ts";
import { handleRuntimeAdmin } from "./worker-admin.ts";
import { toWorkerRuntimeRouteExplain } from "./worker-route-contract.ts";
import { buildRuntimeDispatchDiagnostics } from "./runtime-dispatch-model.ts";
import { json } from "./worker-response.ts";
import type {
  Env,
  ResolvedRouteEntry,
  RuntimeActionHandler,
  RuntimeDispatchDiagnostics,
  RuntimeStateSnapshot,
} from "./worker-types.ts";
import type {
  WorkerRuntimeWebSocketEchoResponse,
  WorkerRuntimeWebSocketOpenResponse,
} from "./worker-action-contract.ts";
import type {
  WorkerRuntimeErrorBaseResponse,
  WorkerRuntimeMethodNotAllowedResponse,
  WorkerRuntimeNoRouteResponse,
  WorkerRuntimeUnhandledActionResponse,
  WorkerRuntimeUpgradeRequiredResponse,
} from "./worker-error-contract.ts";

function buildRuntimeKey(env: Env): string {
  return [
    env.HARDESS_ASSIGNMENT_META.assignmentId,
    env.HARDESS_ASSIGNMENT_META.deploymentId,
    env.HARDESS_ASSIGNMENT_META.declaredVersion,
    env.HARDESS_ASSIGNMENT_META.manifestId,
    env.HARDESS_RESOLVED_RUNTIME_MODEL.protocolPackage.packageId,
    env.HARDESS_RESOLVED_RUNTIME_MODEL.runtime.listenAddress,
  ].join("|");
}

function buildInstanceId(env: Env): string {
  const shortManifestId = env.HARDESS_ASSIGNMENT_META.manifestId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${env.HARDESS_ASSIGNMENT_META.assignmentId}:${shortManifestId}:${Date.now().toString(36)}`;
}

function runtimeErrorBase(
  env: Env,
  url: URL,
  workerRuntime: RuntimeStateSnapshot,
): WorkerRuntimeErrorBaseResponse {
  return {
    ok: false,
    schemaVersion: WORKER_RUNTIME_ERROR_SCHEMA_VERSION,
    dispatchSource: "worker_runtime",
    runtime: env.RUNTIME_META.runtime,
    assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
    path: url.pathname,
    workerRuntime,
  };
}

export class HardessWorkerRuntime {
  readonly runtimeName = "hardess.workerd.worker-runtime.v1" as const;
  readonly instanceId: string;
  readonly runtimeKey: string;
  readonly startedAtEpochMs = Date.now();

  private readonly routes: ResolvedRouteEntry[];
  private readonly actionHandlers: Map<string, RuntimeActionHandler>;
  private readonly dispatchDiagnostics: RuntimeDispatchDiagnostics;
  private totalRequests = 0;
  private websocketSessionCount = 0;
  private readonly routeRequestCounts = new Map<string, number>();

  constructor(env: Env) {
    this.instanceId = buildInstanceId(env);
    this.runtimeKey = buildRuntimeKey(env);
    this.routes = [...env.HARDESS_RESOLVED_RUNTIME_MODEL.routes];
    this.actionHandlers = createActionHandlers();
    this.dispatchDiagnostics = buildRuntimeDispatchDiagnostics(this.routes, this.actionHandlers.keys());
  }

  canServe(env: Env): boolean {
    return buildRuntimeKey(env) === this.runtimeKey;
  }

  async fetch(request: Request, env: Env): Promise<Response> {
    const requestSequence = this.nextRequestSequence();
    const url = new URL(request.url);

    if (isWorkerRuntimeAdminPath(url.pathname)) {
      return handleRuntimeAdmin({
        request,
        env,
        url,
        requestSequence,
        routes: this.routes,
        dispatchDiagnostics: this.dispatchDiagnostics,
        snapshot: (sequence) => this.snapshot(sequence),
      });
    }

    const route = this.matchRoute(url.pathname);

    if (!route) {
      const payload: WorkerRuntimeNoRouteResponse = {
        ...runtimeErrorBase(env, url, this.snapshot(requestSequence)),
        error: "no_route",
        method: request.method,
      };
      return json(payload, { status: 404 });
    }

    const routeHitCount = this.recordRouteHit(route.routeId);
    const workerRuntime = () => this.snapshot(requestSequence, routeHitCount);

    if (!route.methods.includes(request.method)) {
      const payload: WorkerRuntimeMethodNotAllowedResponse = {
        ...runtimeErrorBase(env, url, workerRuntime()),
        error: "method_not_allowed",
        ...toWorkerRuntimeRouteExplain(route),
        method: request.method,
        allowedMethods: route.methods,
      };
      return json(payload, { status: 405 });
    }

    if (route.actionKind === "websocket") {
      return this.handleWebSocket(request, env, url, route, requestSequence, routeHitCount);
    }

    const handler = this.actionHandlers.get(route.actionId);
    if (!handler) {
      const payload: WorkerRuntimeUnhandledActionResponse = {
        ...runtimeErrorBase(env, url, workerRuntime()),
        error: "unhandled_action",
        ...toWorkerRuntimeRouteExplain(route),
      };
      return json(payload, { status: 500 });
    }

    return handler({
      request,
      env,
      url,
      route,
      requestSequence,
      routeHitCount,
      workerRuntime,
      dispatchDiagnostics: this.dispatchDiagnostics,
    });
  }

  private nextRequestSequence(): number {
    this.totalRequests += 1;
    return this.totalRequests;
  }

  private recordRouteHit(routeId: string): number {
    const routeHitCount = (this.routeRequestCounts.get(routeId) ?? 0) + 1;
    this.routeRequestCounts.set(routeId, routeHitCount);
    return routeHitCount;
  }

  private snapshot(requestSequence: number, routeHitCount = 0): RuntimeStateSnapshot {
    return {
      runtimeName: this.runtimeName,
      instanceId: this.instanceId,
      runtimeKey: this.runtimeKey,
      startedAtEpochMs: this.startedAtEpochMs,
      requestSequence,
      totalRequests: this.totalRequests,
      routeHitCount,
      routeHits: Array.from(this.routeRequestCounts, ([routeId, count]) => ({ routeId, count })),
      routeRequestCounts: Object.fromEntries(this.routeRequestCounts),
      websocketSessionCount: this.websocketSessionCount,
    };
  }

  private matchRoute(pathname: string): ResolvedRouteEntry | null {
    let best: ResolvedRouteEntry | null = null;

    for (const route of this.routes) {
      const prefix = route.pathPrefix;
      const matches =
        prefix === "/" ? pathname.startsWith("/") : pathname === prefix || pathname.startsWith(`${prefix}/`);

      if (!matches) {
        continue;
      }

      if (!best || route.pathPrefix.length > best.pathPrefix.length) {
        best = route;
      }
    }

    return best;
  }

  private handleWebSocket(
    request: Request,
    env: Env,
    url: URL,
    route: ResolvedRouteEntry,
    requestSequence: number,
    routeHitCount: number,
  ): Response {
    const workerRuntime = () => this.snapshot(requestSequence, routeHitCount);

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      const payload: WorkerRuntimeUpgradeRequiredResponse = {
        ...runtimeErrorBase(env, url, workerRuntime()),
        error: "upgrade_required",
        ...toWorkerRuntimeRouteExplain(route),
        upgrade: "websocket",
        receivedUpgradeHeader: upgradeHeader,
      };
      return json(payload, { status: 426 });
    }

    this.websocketSessionCount += 1;
    const snapshot = workerRuntime();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      const payload: WorkerRuntimeWebSocketEchoResponse = {
        ok: true,
        schemaVersion: WORKER_RUNTIME_ACTION_SCHEMA_VERSION,
        type: "echo",
        runtime: env.RUNTIME_META.runtime,
        assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
        ...toWorkerRuntimeRouteExplain(route),
        echo: text,
        workerRuntime: snapshot,
      };
      server.send(JSON.stringify(payload));
    });
    server.addEventListener("close", (event) => {
      server.close(event.code, event.reason);
    });
    const openPayload: WorkerRuntimeWebSocketOpenResponse = {
      ok: true,
      schemaVersion: WORKER_RUNTIME_ACTION_SCHEMA_VERSION,
      type: "open",
      runtime: env.RUNTIME_META.runtime,
      assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
      ...toWorkerRuntimeRouteExplain(route),
      workerRuntime: snapshot,
    };
    server.send(JSON.stringify(openPayload));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}
