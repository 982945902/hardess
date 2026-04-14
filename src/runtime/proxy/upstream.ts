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

async function readResponseBody(
  response: Response,
  signal: AbortSignal
): Promise<ArrayBuffer | undefined> {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        void reader.cancel().catch(() => {});
        reject(createTimeoutError("response"));
      },
      { once: true }
    );
  });

  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  })();

  try {
    return await Promise.race([readPromise, abortPromise]);
  } finally {
    reader.releaseLock();
  }
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

  const responseController = new AbortController();
  const responseTimeout = setTimeout(() => {
    responseController.abort();
  }, pipeline.downstream.responseTimeoutMs);

  try {
    // Bun fetch resolves once the upstream response is available; buffer the body so
    // responseTimeout applies after the connect/header stage instead of racing it.
    const body = await readResponseBody(upstreamResponse, responseController.signal);
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const header of HOP_BY_HOP_HEADERS) {
      responseHeaders.delete(header);
    }

    metrics.increment("http.upstream_ok");
    metrics.timing("http.upstream_ms", Date.now() - startedAt);
    return new Response(body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
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
  } finally {
    clearTimeout(responseTimeout);
  }
}
