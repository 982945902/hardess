import {
  ERROR_CODES,
  HardessError,
  asHardessError,
  createHttpErrorResponse,
  type PipelineConfig
} from "../../shared/index.ts";
import type { AuthService } from "../auth/service.ts";
import type { ConfigStore } from "../config/store.ts";
import type { RuntimeTopologyStore } from "../control/topology-store.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";
import { proxyUpstream } from "../proxy/upstream.ts";
import {
  isWebSocketUpgradeRequest,
  UpstreamWebSocketProxyRuntime
} from "../proxy/upstream-websocket.ts";
import { runWorker } from "../workers/runner.ts";

export interface HttpRuntimeDeps {
  configStore: ConfigStore;
  authService: AuthService;
  logger: Logger;
  metrics?: Metrics;
  nodeId?: string;
  clusterSharedSecret?: string;
  topologyStore?: RuntimeTopologyStore;
  internalForward?: {
    httpTimeoutMs?: number;
    wsConnectTimeoutMs?: number;
  };
  serverRef: {
    upgrade(
      request: Request,
      options?: {
        headers?: HeadersInit;
        data?: unknown;
      }
    ): boolean;
  };
  upstreamWebSocketProxy: UpstreamWebSocketProxyRuntime;
}

const INTERNAL_FORWARD_HOP_HEADER = "x-hardess-forward-hop";
const INTERNAL_FORWARD_PATH_HEADER = "x-hardess-forward-path";
const MAX_INTERNAL_FORWARD_HOPS = 1;
const DEFAULT_INTERNAL_FORWARD_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_INTERNAL_FORWARD_WS_CONNECT_TIMEOUT_MS = 5_000;

function findPipeline(pathname: string, pipelines: PipelineConfig[]): PipelineConfig | undefined {
  return [...pipelines]
    .sort((left, right) => right.matchPrefix.length - left.matchPrefix.length)
    .find((pipeline) => pathname.startsWith(pipeline.matchPrefix));
}

export async function handleHttpRequest(
  request: Request,
  deps: HttpRuntimeDeps
): Promise<Response | undefined> {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();
  const metrics = deps.metrics ?? new NoopMetrics();
  const startedAt = Date.now();
  metrics.increment("http.request_in");

  try {
    const url = new URL(request.url);
    const config = deps.configStore.getConfig();
    const pipeline = findPipeline(url.pathname, config.pipelines);
    const forwardHop = Number(request.headers.get(INTERNAL_FORWARD_HOP_HEADER) ?? "0");

    if (!pipeline) {
      const forwarded = await tryForwardInternally(request, deps, {
        traceId,
        pathname: url.pathname,
        search: url.search,
        forwardHop
      });
      if (forwarded.handled) {
        metrics.increment("http.internal_forward_ok");
        metrics.timing("http.request_ms", Date.now() - startedAt);
        return forwarded.response;
      }

      metrics.increment("http.route_missing");
      throw new HardessError(ERROR_CODES.ROUTE_NO_RECIPIENT, `No pipeline for ${url.pathname}`);
    }

    if (isWebSocketUpgradeRequest(request) && !pipeline.downstream.websocket) {
      metrics.increment("http.ws_proxy_disabled");
      metrics.timing("http.request_ms", Date.now() - startedAt);
      return new Response("WebSocket proxy is not enabled for this pipeline", { status: 426 });
    }

    const auth = pipeline.auth?.required === false
      ? await deps.authService.validateBearerToken("demo:anonymous")
      : await deps.authService.validateBearerToken(request.headers.get("authorization"));
    metrics.increment("http.auth_ok");

    const workerResult = await runWorker(request.clone(), auth, pipeline, traceId, deps.logger, metrics);
    if (workerResult.response) {
      metrics.increment("http.worker_short_circuit");
      metrics.timing("http.request_ms", Date.now() - startedAt);
      return workerResult.response;
    }

    const upstreamRequest = workerResult.request ?? request;
    if (isWebSocketUpgradeRequest(upstreamRequest)) {
      const response = await deps.upstreamWebSocketProxy.upgrade(
        upstreamRequest,
        pipeline,
        auth,
        traceId,
        deps.serverRef
      );
      metrics.increment("http.ws_proxy_ok");
      metrics.timing("http.request_ms", Date.now() - startedAt);
      return response;
    }

    const response = await proxyUpstream(upstreamRequest, pipeline, auth, traceId, metrics);
    metrics.increment("http.proxy_ok");
    metrics.timing("http.request_ms", Date.now() - startedAt);
    return response;
  } catch (error) {
    const normalized = asHardessError(error);
    metrics.increment("http.error");
    metrics.timing("http.request_ms", Date.now() - startedAt);
    deps.logger.error("http request failed", {
      traceId,
      error: normalized.message,
      code: normalized.code
    });
    return createHttpErrorResponse(normalized, traceId);
  }
}

async function tryForwardInternally(
  request: Request,
  deps: HttpRuntimeDeps,
  input: {
    traceId: string;
    pathname: string;
    search: string;
    forwardHop: number;
  }
): Promise<{ handled: boolean; response?: Response }> {
  if (input.forwardHop >= MAX_INTERNAL_FORWARD_HOPS) {
    deps.metrics?.increment("http.internal_forward_loop");
    return { handled: false };
  }

  const target = deps.topologyStore?.resolveHttpRouteTarget({
    pathname: input.pathname,
    selfNodeId: deps.nodeId,
    traceKey: `${input.traceId}:${input.pathname}${input.search}`
  });
  if (!target) {
    deps.metrics?.increment("http.internal_forward_miss");
    return { handled: false };
  }

  if (isWebSocketUpgradeRequest(request)) {
    const targetWsUrl = new URL("/__cluster/ws-forward", target.baseUrl);
    targetWsUrl.protocol = targetWsUrl.protocol === "https:" ? "wss:" : "ws:";
    return {
      handled: true,
      response: await deps.upstreamWebSocketProxy.upgradeToTarget(
        request,
        deps.upstreamWebSocketProxy.buildForwardTarget(request, targetWsUrl.toString(), {
          connectTimeoutMs:
            deps.internalForward?.wsConnectTimeoutMs ?? DEFAULT_INTERNAL_FORWARD_WS_CONNECT_TIMEOUT_MS,
          extraHeaders: {
            [INTERNAL_FORWARD_HOP_HEADER]: String(input.forwardHop + 1),
            [INTERNAL_FORWARD_PATH_HEADER]: `${input.pathname}${input.search}`,
            "x-trace-id": input.traceId,
            ...(deps.clusterSharedSecret
              ? {
                  "x-hardess-cluster-secret": deps.clusterSharedSecret
                }
              : {})
          }
        }),
        deps.serverRef
      )
    };
  }

  const targetUrl = new URL("/__cluster/http-forward", target.baseUrl);
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_FORWARD_HOP_HEADER, String(input.forwardHop + 1));
  headers.set(INTERNAL_FORWARD_PATH_HEADER, `${input.pathname}${input.search}`);
  headers.set("x-trace-id", input.traceId);
  if (deps.clusterSharedSecret) {
    headers.set("x-hardess-cluster-secret", deps.clusterSharedSecret);
  }

  const controller = new AbortController();
  const timeoutMs = deps.internalForward?.httpTimeoutMs ?? DEFAULT_INTERNAL_FORWARD_HTTP_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return {
      handled: true,
      response: await fetch(
        new Request(targetUrl, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          signal: controller.signal,
          redirect: "manual"
        })
      )
    };
  } catch (error) {
    deps.metrics?.increment("http.internal_forward_error");
    deps.logger.warn("http internal forward failed", {
      traceId: input.traceId,
      targetHostId: target.hostId,
      targetNodeId: target.nodeId,
      targetBaseUrl: target.baseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    if (controller.signal.aborted) {
      throw new HardessError(
        ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT,
        `Internal forward timed out after ${timeoutMs}ms`,
        {
          retryable: true,
          detail: {
            targetNodeId: target.nodeId,
            targetBaseUrl: target.baseUrl,
            timeoutMs
          }
        }
      );
    }
    throw new HardessError(
      ERROR_CODES.GATEWAY_UPSTREAM_UNAVAILABLE,
      "Internal forward target is unavailable",
      {
        retryable: true,
        detail: {
          targetNodeId: target.nodeId,
          targetBaseUrl: target.baseUrl,
          error: error instanceof Error ? error.message : String(error)
        },
        cause: error
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}
