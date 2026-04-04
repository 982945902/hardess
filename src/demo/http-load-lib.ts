export interface HttpLoadOptions {
  url: string;
  method?: string;
  totalRequests?: number;
  concurrency?: number;
  timeoutMs?: number;
  token?: string | null;
  body?: string;
  headers?: Record<string, string>;
  onProgress?: (progress: { completed: number; totalRequests: number }) => void;
}

export interface HttpLoadSummary {
  type: "summary";
  target: string;
  method: string;
  totalRequests: number;
  concurrency: number;
  timeoutMs: number;
  succeeded: number;
  failed: number;
  requestsPerSecond: number;
  elapsedMs: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  statusCounts: Record<string, number>;
  platformErrorCodes: Record<string, number>;
  transportErrors: Record<string, number>;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("client-timeout"), timeoutMs);

  try {
    return await fetch(new Request(request, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

export async function runHttpLoad(options: HttpLoadOptions): Promise<HttpLoadSummary> {
  const method = options.method ?? "GET";
  const totalRequests = options.totalRequests ?? 500;
  const concurrency = options.concurrency ?? 50;
  const timeoutMs = options.timeoutMs ?? 6_000;
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const platformErrorCodes: Record<string, number> = {};
  const transportErrors: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;
  let nextRequestIndex = 0;

  async function runSingleRequest(requestIndex: number): Promise<void> {
    const headers = new Headers(options.headers ?? {});
    if (options.token) {
      headers.set("authorization", options.token.startsWith("Bearer ") ? options.token : `Bearer ${options.token}`);
    }

    const request = new Request(options.url, {
      method,
      headers,
      body: options.body && method !== "GET" && method !== "HEAD" ? options.body : undefined
    });

    const startedAt = Date.now();

    try {
      const response = await fetchWithTimeout(request, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      latencies.push(latencyMs);
      incrementCounter(statusCounts, String(response.status));

      if (response.ok) {
        succeeded += 1;
        return;
      }

      failed += 1;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          const payload = await response.json() as {
            error?: {
              code?: string;
            };
          };
          if (payload.error?.code) {
            incrementCounter(platformErrorCodes, payload.error.code);
          }
        } catch {
          incrementCounter(transportErrors, "INVALID_ERROR_BODY");
        }
      }
    } catch (error) {
      failed += 1;
      const key = error instanceof Error ? error.name || error.message : String(error);
      incrementCounter(transportErrors, key);
    } finally {
      options.onProgress?.({
        completed: requestIndex + 1,
        totalRequests
      });
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextRequestIndex;
      nextRequestIndex += 1;

      if (currentIndex >= totalRequests) {
        return;
      }

      await runSingleRequest(currentIndex);
    }
  }

  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker())
  );
  const elapsedMs = Date.now() - startedAt;

  return {
    type: "summary",
    target: options.url,
    method,
    totalRequests,
    concurrency,
    timeoutMs,
    succeeded,
    failed,
    requestsPerSecond: elapsedMs > 0 ? Number((totalRequests / (elapsedMs / 1_000)).toFixed(2)) : totalRequests,
    elapsedMs,
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0
    },
    statusCounts,
    platformErrorCodes,
    transportErrors
  };
}
