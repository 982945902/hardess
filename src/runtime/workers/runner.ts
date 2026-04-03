import type { AuthContext, HardessWorkerResult, PipelineConfig } from "../../shared/types.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";
import { loadWorker } from "./loader.ts";

function normalizeWorkerResult(result: Response | HardessWorkerResult | void): HardessWorkerResult {
  if (!result) {
    return {};
  }

  if (result instanceof Response) {
    return { response: result };
  }

  return result;
}

export async function runWorker(
  request: Request,
  auth: AuthContext,
  pipeline: PipelineConfig,
  traceId: string,
  logger: Logger,
  metrics: Metrics = new NoopMetrics()
): Promise<HardessWorkerResult> {
  if (!pipeline.worker) {
    return {};
  }

  const startedAt = Date.now();
  const worker = await loadWorker(pipeline.worker.entry);
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    }
  };

  const workerPromise = Promise.resolve(
    worker.fetch(
      request,
      {
        auth,
        pipeline: {
          id: pipeline.id,
          matchPrefix: pipeline.matchPrefix,
          downstreamOrigin: pipeline.downstream.origin
        },
        traceId
      },
      ctx
    )
  );

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Worker timed out after ${pipeline.worker?.timeoutMs}ms`));
    }, pipeline.worker?.timeoutMs ?? 0);

    void workerPromise.finally(() => clearTimeout(timeout));
  });

  try {
    const result = normalizeWorkerResult(await Promise.race([workerPromise, timeoutPromise]));
    metrics.increment("worker.run_ok");
    metrics.timing("worker.run_ms", Date.now() - startedAt);
    return result;
  } catch (error) {
    metrics.increment("worker.run_error");
    metrics.timing("worker.run_ms", Date.now() - startedAt);
    logger.error("worker execution failed", {
      traceId,
      pipelineId: pipeline.id,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
