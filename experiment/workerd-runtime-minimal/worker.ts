interface RouteEntry {
  routeId: string;
  pathPrefix: string;
  actionId: string;
  websocketEnabled: boolean;
  actionKind: "http" | "websocket";
}

interface ProtocolAction {
  actionId: string;
  kind: "http" | "websocket";
  methods: string[];
  websocket?: boolean;
}

interface ProtocolPackage {
  packageId: string;
  protocol: string;
  version: string;
  actions: ProtocolAction[];
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
  HARDESS_ROUTE_TABLE: RouteEntry[];
  HARDESS_PROTOCOL_PACKAGE: ProtocolPackage;
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function matchRoute(pathname: string, routes: RouteEntry[]): RouteEntry | null {
  let best: RouteEntry | null = null;

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

function findAction(protocolPackage: ProtocolPackage, actionId: string): ProtocolAction | null {
  return protocolPackage.actions.find((action) => action.actionId === actionId) ?? null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname, env.HARDESS_ROUTE_TABLE);

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

    const action = findAction(env.HARDESS_PROTOCOL_PACKAGE, route.actionId);
    if (!action) {
      return json(
        {
          ok: false,
          error: "unknown_action",
          routeId: route.routeId,
          actionId: route.actionId,
        },
        { status: 500 },
      );
    }

    if (!action.methods.includes(request.method)) {
      return json(
        {
          ok: false,
          error: "method_not_allowed",
          routeId: route.routeId,
          actionId: route.actionId,
          method: request.method,
        },
        { status: 405 },
      );
    }

    if (action.kind === "websocket") {
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

      if (!route.websocketEnabled || !action.websocket) {
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
        protocolPackageId: env.HARDESS_PROTOCOL_PACKAGE.packageId,
        routeRefCount: env.HARDESS_ASSIGNMENT_META.routeRefs.length,
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
