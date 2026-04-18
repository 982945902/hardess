import { ERROR_CODES, HardessError, type AuthContext, type PipelineConfig } from "../../shared/index.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function createTimeoutError(stage: "connect" | "response"): HardessError {
  return new HardessError(
    ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT,
    stage === "connect" ? "Upstream connect timed out" : "Upstream request timed out",
    {
      retryable: true,
      detail: `timeout_stage=${stage}`
    }
  );
}

function createUnavailableError(error: unknown): HardessError {
  return new HardessError(
    ERROR_CODES.GATEWAY_UPSTREAM_UNAVAILABLE,
    "Upstream service is unavailable",
    {
      retryable: true,
      detail: error instanceof Error ? error.message : String(error),
      cause: error
    }
  );
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(createTimeoutError("response"));
    }, timeoutMs);

    void reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function createStreamingResponseBody(
  response: Response,
  timeoutMs: number
): Promise<ReadableStream<Uint8Array> | undefined> {
  if (!response.body) {
    return Promise.resolve(undefined);
  }

  const reader = response.body.getReader();
  return (async () => {
    const firstChunk = await readResponseChunk(reader, timeoutMs);
    if (firstChunk.done) {
      reader.releaseLock();
      return undefined;
    }

    let seeded = false;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstChunk.value && !seeded) {
          seeded = true;
          controller.enqueue(firstChunk.value);
        }
      },
      async pull(controller) {
        try {
          const next = await readResponseChunk(reader, timeoutMs);
          if (next.done) {
            reader.releaseLock();
            controller.close();
            return;
          }

          if (next.value) {
            controller.enqueue(next.value);
          }
        } catch (error) {
          try {
            reader.releaseLock();
          } catch {}
          controller.error(error);
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
      }
    });
  })();
}

export async function withResponseReadTimeout(
  response: Response,
  timeoutMs: number
): Promise<Response> {
  const body = await createStreamingResponseBody(response, timeoutMs);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  });
}

export async function proxyUpstream(
  request: Request,
  pipeline: PipelineConfig,
  auth: AuthContext,
  traceId?: string,
  metrics: Metrics = new NoopMetrics()
): Promise<Response> {
  const startedAt = Date.now();
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    pipeline.downstream.origin.endsWith("/")
      ? pipeline.downstream.origin
      : `${pipeline.downstream.origin}/`
  );

  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  headers.set("x-hardess-trace-id", traceId ?? crypto.randomUUID());
  headers.set("x-hardess-peer-id", auth.peerId);
  headers.set("x-hardess-token-id", auth.tokenId);

  if (!pipeline.downstream.forwardAuthContext) {
    headers.delete("authorization");
  }

  for (const [key, value] of Object.entries(pipeline.downstream.injectedHeaders ?? {})) {
    headers.set(key, value);
  }

  const connectController = new AbortController();
  const connectTimeout = setTimeout(() => {
    connectController.abort();
  }, pipeline.downstream.connectTimeoutMs);

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(
      new Request(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        signal: connectController.signal,
        redirect: "manual"
      })
    );
  } catch (error) {
    if (connectController.signal.aborted) {
      metrics.increment("http.upstream_connect_timeout");
      metrics.timing("http.upstream_ms", Date.now() - startedAt);
      throw createTimeoutError("connect");
    }

    metrics.increment("http.upstream_unavailable");
    metrics.timing("http.upstream_ms", Date.now() - startedAt);
    throw createUnavailableError(error);
  } finally {
    clearTimeout(connectTimeout);
  }

  try {
    // Wait for the first response chunk within responseTimeoutMs, then stream the rest
    // with the same per-chunk timeout instead of buffering the whole upstream body.
    const response = await withResponseReadTimeout(
      upstreamResponse,
      pipeline.downstream.responseTimeoutMs
    );
    const responseHeaders = new Headers(response.headers);
    for (const header of HOP_BY_HOP_HEADERS) {
      responseHeaders.delete(header);
    }

    metrics.increment("http.upstream_ok");
    metrics.timing("http.upstream_ms", Date.now() - startedAt);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    if (error instanceof HardessError && error.code === ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT) {
      metrics.increment("http.upstream_timeout");
      metrics.timing("http.upstream_ms", Date.now() - startedAt);
      throw error;
    }

    metrics.increment("http.upstream_unavailable");
    metrics.timing("http.upstream_ms", Date.now() - startedAt);
    throw createUnavailableError(error);
  }
}
