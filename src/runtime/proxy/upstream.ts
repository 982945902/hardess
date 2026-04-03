import { ERROR_CODES, HardessError, type AuthContext, type PipelineConfig } from "../../shared/index.ts";

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

export async function proxyUpstream(
  request: Request,
  pipeline: PipelineConfig,
  auth: AuthContext,
  traceId?: string
): Promise<Response> {
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), pipeline.downstream.responseTimeoutMs);

  try {
    return await fetch(
      new Request(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        signal: controller.signal,
        redirect: "manual"
      })
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HardessError(ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT, "Upstream request timed out", {
        retryable: true
      });
    }

    throw new HardessError(
      ERROR_CODES.GATEWAY_UPSTREAM_UNAVAILABLE,
      "Upstream service is unavailable",
      {
        retryable: true,
        detail: error instanceof Error ? error.message : String(error),
        cause: error
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}
