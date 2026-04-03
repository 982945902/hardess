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
import { proxyUpstream } from "../proxy/upstream.ts";
import { runWorker } from "../workers/runner.ts";

export interface HttpRuntimeDeps {
  configStore: ConfigStore;
  authService: AuthService;
  logger: Logger;
}

function findPipeline(pathname: string, pipelines: PipelineConfig[]): PipelineConfig | undefined {
  return [...pipelines]
    .sort((left, right) => right.matchPrefix.length - left.matchPrefix.length)
    .find((pipeline) => pathname.startsWith(pipeline.matchPrefix));
}

export async function handleHttpRequest(
  request: Request,
  deps: HttpRuntimeDeps
): Promise<Response> {
  const traceId = request.headers.get("x-trace-id") ?? crypto.randomUUID();

  try {
    const url = new URL(request.url);
    const config = deps.configStore.getConfig();
    const pipeline = findPipeline(url.pathname, config.pipelines);

    if (!pipeline) {
      throw new HardessError(ERROR_CODES.ROUTE_NO_RECIPIENT, `No pipeline for ${url.pathname}`);
    }

    const auth = pipeline.auth?.required === false
      ? await deps.authService.validateBearerToken("demo:anonymous")
      : await deps.authService.validateBearerToken(request.headers.get("authorization"));

    const workerResult = await runWorker(request.clone(), auth, pipeline, traceId, deps.logger);
    if (workerResult.response) {
      return workerResult.response;
    }

    const upstreamRequest = workerResult.request ?? request;
    return await proxyUpstream(upstreamRequest, pipeline, auth, traceId);
  } catch (error) {
    const normalized = asHardessError(error);
    deps.logger.error("http request failed", {
      traceId,
      error: normalized.message,
      code: normalized.code
    });
    return createHttpErrorResponse(normalized, traceId);
  }
}
