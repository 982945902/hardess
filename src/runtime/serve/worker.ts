import {
  normalizeWorkerResult,
  type HardessServeDeploymentInstance,
  type HardessServeContext,
  type HardessServeHandlerResult,
  type HardessServeMiddleware,
  type HardessServeMethod,
  type HardessServeModule,
  type HardessWorkerEnv,
  type HardessWorkerModule
} from "../../shared/index.ts";

interface CompiledRoute {
  method: HardessServeMethod;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HardessServeModule["routes"][number]["handler"];
}

export function createWorkerFromServeModule(module: HardessServeModule): HardessWorkerModule {
  const compiledRoutes = module.routes.map(compileRoute);
  const deploymentInstancesByInstanceKey = new Map<string, HardessServeDeploymentInstance>();
  const middleware = (module.middleware ?? []).map((entry) => ({
    pathPrefix: normalizePathPrefix(entry.pathPrefix),
    handler: entry.handler
  }));

  return {
    async fetch(request, env, ctx) {
      const originalUrl = new URL(request.url);
      const originalPath = originalUrl.pathname;
      const routedPath = stripMatchPrefix(originalPath, env.pipeline.matchPrefix);
      const routedUrl = new URL(request.url);
      routedUrl.pathname = routedPath;
      const routedRequest = new Request(routedUrl, request);
      const routeMatch = findRoute(compiledRoutes, routedPath, request.method);

      if (!routeMatch) {
        return new Response("Not Found", { status: 404 });
      }

      const serveContext: HardessServeContext = {
        ...ctx,
        params: routeMatch.params,
        path: routedPath,
        originalPath
      };

      const chain = middleware
        .filter((entry) => pathStartsWithPrefix(routedPath, entry.pathPrefix))
        .map((entry) => entry.handler);

      const response = await runMiddlewareChain(chain, routedRequest, env, serveContext, async () => {
        const handler = resolveRouteHandler(
          routeMatch.route.handler,
          module,
          deploymentInstancesByInstanceKey,
          env
        );
        return await handler(routedRequest, env, serveContext);
      });

      return normalizeWorkerResult(response);
    }
  };
}

function resolveRouteHandler(
  handler: HardessServeModule["routes"][number]["handler"],
  module: HardessServeModule,
  deploymentInstancesByInstanceKey: Map<string, HardessServeDeploymentInstance>,
  env: HardessWorkerEnv
): (
  request: Request,
  env: HardessWorkerEnv,
  ctx: HardessServeContext
) => Promise<HardessServeHandlerResult> | HardessServeHandlerResult {
  if (typeof handler === "function") {
    return handler;
  }

  const instance = getDeploymentInstance(module, deploymentInstancesByInstanceKey, env);
  const method = instance[handler];
  if (typeof method !== "function") {
    throw new Error(`Serve deployment method is not a function: ${handler}`);
  }

  return method.bind(instance) as (
    request: Request,
    env: HardessWorkerEnv,
    ctx: HardessServeContext
  ) => Promise<HardessServeHandlerResult> | HardessServeHandlerResult;
}

function getDeploymentInstance(
  module: HardessServeModule,
  deploymentInstancesByInstanceKey: Map<string, HardessServeDeploymentInstance>,
  env: HardessWorkerEnv
): HardessServeDeploymentInstance {
  if (!module.deployment) {
    throw new Error("Serve route uses a deployment method but no deployment class is configured");
  }

  const instanceKey = env.deployment?.instanceKey ?? env.pipeline.id;
  const existing = deploymentInstancesByInstanceKey.get(instanceKey);
  if (existing) {
    return existing;
  }

  const created = new module.deployment({
    config: { ...(env.deployment?.config ?? {}) },
    bindings: { ...(env.deployment?.bindings ?? {}) },
    secrets: { ...(env.deployment?.secrets ?? {}) },
    pipeline: { ...env.pipeline }
  });
  deploymentInstancesByInstanceKey.set(instanceKey, created);
  return created;
}

async function runMiddlewareChain(
  chain: HardessServeMiddleware[],
  request: Request,
  env: HardessWorkerEnv,
  ctx: HardessServeContext,
  terminal: () => Promise<HardessServeHandlerResult>
): Promise<HardessServeHandlerResult> {
  async function dispatch(index: number): Promise<HardessServeHandlerResult> {
    const current = chain[index];
    if (!current) {
      return await terminal();
    }

    return await current(request, env, ctx, async () => await dispatch(index + 1));
  }

  return await dispatch(0);
}

function findRoute(
  routes: CompiledRoute[],
  pathname: string,
  method: string
):
  | {
      route: CompiledRoute;
      params: Record<string, string>;
    }
  | undefined {
  for (const route of routes) {
    if (route.method !== "ALL" && route.method !== method.toUpperCase()) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    return {
      route,
      params: Object.fromEntries(
        route.paramNames.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")])
      )
    };
  }

  return undefined;
}

function compileRoute(route: HardessServeModule["routes"][number]): CompiledRoute {
  const normalizedPath = normalizePath(route.path);
  const segments = normalizedPath === "/"
    ? []
    : normalizedPath.slice(1).split("/");
  const paramNames: string[] = [];
  const pattern = segments.length === 0
    ? /^\/$/
    : new RegExp(
        `^/${segments
          .map((segment) => {
            if (segment.startsWith(":")) {
              paramNames.push(segment.slice(1));
              return "([^/]+)";
            }
            return escapeRegExp(segment);
          })
          .join("/")}$`
      );

  return {
    method: route.method,
    path: normalizedPath,
    pattern,
    paramNames,
    handler: route.handler
  };
}

function stripMatchPrefix(pathname: string, matchPrefix: string): string {
  const normalizedPrefix = normalizePath(matchPrefix);
  if (normalizedPrefix === "/" || !pathname.startsWith(normalizedPrefix)) {
    return pathname;
  }
  const stripped = pathname.slice(normalizedPrefix.length);
  if (stripped.length === 0) {
    return "/";
  }
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`Serve path must start with '/': ${path}`);
  }
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

function normalizePathPrefix(pathPrefix: string | undefined): string | undefined {
  if (!pathPrefix) {
    return undefined;
  }
  return normalizePath(pathPrefix);
}

function pathStartsWithPrefix(pathname: string, pathPrefix: string | undefined): boolean {
  if (!pathPrefix || pathPrefix === "/") {
    return true;
  }
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
