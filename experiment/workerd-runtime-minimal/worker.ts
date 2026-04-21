interface ResolvedRouteEntry {
  routeId: string;
  pathPrefix: string;
  actionId: string;
  methods: string[];
  websocketEnabled: boolean;
  actionKind: "http" | "websocket";
  upstreamBaseUrl: string;
}

interface Env {
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

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function matchRoute(pathname: string, routes: ResolvedRouteEntry[]): ResolvedRouteEntry | null {
  let best: ResolvedRouteEntry | null = null;

  for (const route of routes) {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname, env.HARDESS_RESOLVED_RUNTIME_MODEL.routes);

    if (!route) {
      return json(
        {
          ok: false,
          error: "no_route",
          method: request.method,
          path: url.pathname,
        },
        { status: 404 },
      );
    }

    if (!route.methods.includes(request.method)) {
      return json(
        {
          ok: false,
          error: "method_not_allowed",
          routeId: route.routeId,
          actionId: route.actionId,
          method: request.method,
          allowedMethods: route.methods,
        },
        { status: 405 },
      );
    }

    if (route.actionKind === "websocket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json(
          {
            ok: false,
            error: "upgrade_required",
            routeId: route.routeId,
            actionId: route.actionId,
            path: url.pathname,
          },
          { status: 426 },
        );
      }

      if (!route.websocketEnabled) {
        return json(
          {
            ok: false,
            error: "websocket_not_enabled",
            routeId: route.routeId,
            actionId: route.actionId,
            path: url.pathname,
          },
          { status: 404 },
        );
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      server.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : String(event.data);
        server.send(
          JSON.stringify({
            ok: true,
            type: "echo",
            runtime: env.RUNTIME_META.runtime,
            assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
            routeId: route.routeId,
            actionId: route.actionId,
            echo: text,
          }),
        );
      });
      server.addEventListener("close", (event) => {
        server.close(event.code, event.reason);
      });
      server.send(
        JSON.stringify({
          ok: true,
          type: "open",
          runtime: env.RUNTIME_META.runtime,
          assignmentId: env.HARDESS_ASSIGNMENT_META.assignmentId,
          routeId: route.routeId,
          actionId: route.actionId,
        }),
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (route.actionId === "http.info") {
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
      });
    }

    if (route.actionId === "http.echo") {
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
      });
    }

    return json(
      {
        ok: false,
        error: "unhandled_action",
        routeId: route.routeId,
        actionId: route.actionId,
      },
      { status: 500 },
    );
  },
} satisfies ExportedHandler<Env>;
