import type {
  HardessServeHandler,
  HardessServeMethod,
  HardessServeMiddleware,
  HardessServeMiddlewareDefinition,
  HardessServeModule,
  HardessServeRouteDefinition
} from "../../shared/index.ts";

type MiddlewareOrApp = HardessServeMiddleware | HardessServeApp;
type RouteRegistration = (path: string, handler: HardessServeHandler) => HardessServeApp;

export interface HardessServeApp extends HardessServeModule {
  use(pathOrHandler: string | MiddlewareOrApp, handlerOrApp?: MiddlewareOrApp): HardessServeApp;
  get: RouteRegistration;
  post: RouteRegistration;
  put: RouteRegistration;
  patch: RouteRegistration;
  delete: RouteRegistration;
  head: RouteRegistration;
  options: RouteRegistration;
  all: RouteRegistration;
}

export function createApp(): HardessServeApp {
  const routes: HardessServeRouteDefinition[] = [];
  const middleware: HardessServeMiddlewareDefinition[] = [];
  const app = {} as HardessServeApp;

  app.kind = "serve";
  app.routes = routes;
  app.middleware = middleware;
  app.use = (pathOrHandler: string | MiddlewareOrApp, handlerOrApp?: MiddlewareOrApp): HardessServeApp => {
    const pathPrefix = typeof pathOrHandler === "string" ? normalizePath(pathOrHandler) : undefined;
    const target = typeof pathOrHandler === "string" ? handlerOrApp : pathOrHandler;
    if (!target) {
      throw new Error("app.use requires a middleware or child app");
    }

    if (isServeApp(target)) {
      mountServeApp(routes, middleware, target, pathPrefix);
      return app;
    }

    middleware.push({
      pathPrefix,
      handler: target
    });
    return app;
  };
  app.get = createRouteRegistrar(routes, "GET", app);
  app.post = createRouteRegistrar(routes, "POST", app);
  app.put = createRouteRegistrar(routes, "PUT", app);
  app.patch = createRouteRegistrar(routes, "PATCH", app);
  app.delete = createRouteRegistrar(routes, "DELETE", app);
  app.head = createRouteRegistrar(routes, "HEAD", app);
  app.options = createRouteRegistrar(routes, "OPTIONS", app);
  app.all = createRouteRegistrar(routes, "ALL", app);

  return app;
}

export function createRouter(): HardessServeApp {
  return createApp();
}

export function defineServe(
  input: HardessServeModule | (() => HardessServeApp)
): HardessServeModule {
  return typeof input === "function" ? input() : input;
}

function createRouteRegistrar(
  routes: HardessServeRouteDefinition[],
  method: HardessServeMethod,
  app: HardessServeApp
): RouteRegistration {
  return (path: string, handler: HardessServeHandler): HardessServeApp => {
    routes.push({
      method,
      path: normalizePath(path),
      handler
    });
    return app;
  };
}

function isServeApp(value: MiddlewareOrApp): value is HardessServeApp {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "serve" &&
    Array.isArray((value as { routes?: unknown }).routes)
  );
}

function mountServeApp(
  targetRoutes: HardessServeRouteDefinition[],
  targetMiddleware: HardessServeMiddlewareDefinition[],
  child: HardessServeApp,
  pathPrefix?: string
): void {
  for (const route of child.routes) {
    targetRoutes.push({
      method: route.method,
      path: joinPaths(pathPrefix, route.path),
      handler: route.handler
    });
  }

  for (const middleware of child.middleware ?? []) {
    targetMiddleware.push({
      pathPrefix: middleware.pathPrefix ? joinPaths(pathPrefix, middleware.pathPrefix) : pathPrefix,
      handler: middleware.handler
    });
  }
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

function joinPaths(basePath: string | undefined, childPath: string): string {
  if (!basePath) {
    return normalizePath(childPath);
  }
  const normalizedBase = normalizePath(basePath);
  const normalizedChild = normalizePath(childPath);
  if (normalizedBase === "/") {
    return normalizedChild;
  }
  if (normalizedChild === "/") {
    return normalizedBase;
  }
  return `${normalizedBase}${normalizedChild}`;
}
