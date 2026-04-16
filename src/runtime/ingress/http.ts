import {
  ERROR_CODES,
  HardessError,
  asHardessError,
  createHttpErrorResponse,
  type PipelineConfig
} from "../../shared/index.ts";
import type { AuthService } from "../auth/service.ts";
import type { ConfigStore } from "../config/store.ts";
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

    if (!pipeline) {
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
