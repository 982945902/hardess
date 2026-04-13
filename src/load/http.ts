import {
  diffMetricsSnapshot,
  envNumberFirst,
  envOptionalStringFirst,
  envStringFirst,
  fetchAdminMetrics,
  incCounter,
  summarizeLatencies,
  type MetricsSnapshot
} from "./shared.ts";

export interface HttpLoadTestConfig {
  baseUrl: string;
  adminBaseUrl: string;
  peerId: string;
  pathname: string;
  method: string;
  concurrency: number;
  totalRequests: number;
  durationMs: number;
  requestBody?: string;
}

export interface HttpLoadTestResult {
  kind: "http_load_test";
  config: {
    baseUrl: string;
    adminBaseUrl: string;
    pathname: string;
    method: string;
    concurrency: number;
    totalRequests: number;
    durationMs: number;
  };
  summary: {
    attempted: number;
    completed: number;
    elapsedMs: number;
    requestsPerSecond: number;
    successCount: number;
    statusCounts: Record<string, number>;
    errorCounts: Record<string, number>;
    latencyMs: ReturnType<typeof summarizeLatencies>;
  };
  metricsDelta: MetricsSnapshot | null;
}

export function defaultHttpLoadTestConfig(): HttpLoadTestConfig {
  const baseUrl = envStringFirst(["HTTP_LOAD_BASE_URL", "BASE_URL"], "http://127.0.0.1:3000");
  return {
    baseUrl,
    adminBaseUrl: envStringFirst(["HTTP_LOAD_ADMIN_BASE_URL", "ADMIN_BASE_URL"], baseUrl),
    peerId: envStringFirst(["HTTP_LOAD_PEER_ID", "PEER_ID"], "alice"),
    pathname: envStringFirst(["HTTP_LOAD_PATHNAME", "PATHNAME"], "/demo/orders"),
    method: envStringFirst(["HTTP_LOAD_METHOD", "METHOD"], "GET").toUpperCase(),
    concurrency: envNumberFirst(["HTTP_LOAD_CONCURRENCY", "CONCURRENCY"], 20),
    totalRequests: envNumberFirst(["HTTP_LOAD_REQUESTS", "REQUESTS"], 500),
    durationMs: envNumberFirst(["HTTP_LOAD_DURATION_MS", "DURATION_MS"], 0),
    requestBody: envOptionalStringFirst(["HTTP_LOAD_REQUEST_BODY", "REQUEST_BODY"])
  };
}

export async function runHttpLoadTest(
  overrides: Partial<HttpLoadTestConfig> = {}
): Promise<HttpLoadTestResult> {
  const config = {
    ...defaultHttpLoadTestConfig(),
    ...overrides
  };
  const requestHeaders = {
    authorization: `Bearer demo:${config.peerId}`,
    ...(config.requestBody ? { "content-type": "application/json" } : {})
  };

  let launched = 0;
  const startedAt = Date.now();
  const latenciesMs: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errorCounts: Record<string, number> = {};

  function shouldContinue(): boolean {
    if (config.durationMs > 0) {
      return Date.now() - startedAt < config.durationMs;
    }

    return launched < config.totalRequests;
  }

  async function sendOne(): Promise<void> {
    const requestStartedAt = performance.now();

    try {
      const response = await fetch(`${config.baseUrl}${config.pathname}`, {
        method: config.method,
        headers: requestHeaders,
        body: config.requestBody
      });
      latenciesMs.push(performance.now() - requestStartedAt);
      incCounter(statusCounts, String(response.status));
    } catch (error) {
      latenciesMs.push(performance.now() - requestStartedAt);
      incCounter(errorCounts, error instanceof Error ? error.name : "unknown_error");
    }
  }

  async function worker(): Promise<void> {
    while (shouldContinue()) {
      if (config.durationMs === 0 && launched >= config.totalRequests) {
        return;
      }

      launched += 1;
      if (config.durationMs === 0 && launched > config.totalRequests) {
        return;
      }

      await sendOne();
    }
  }

  const metricsBefore = await fetchAdminMetrics(config.adminBaseUrl);
  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const metricsAfter = await fetchAdminMetrics(config.adminBaseUrl);
  const elapsedMs = Date.now() - startedAt;

  return {
    kind: "http_load_test",
    config: {
      baseUrl: config.baseUrl,
      adminBaseUrl: config.adminBaseUrl,
      pathname: config.pathname,
      method: config.method,
      concurrency: config.concurrency,
      totalRequests: config.durationMs > 0 ? launched : config.totalRequests,
      durationMs: config.durationMs
    },
    summary: {
      attempted: launched,
      completed: latenciesMs.length,
      elapsedMs,
      requestsPerSecond: elapsedMs > 0 ? (latenciesMs.length * 1000) / elapsedMs : 0,
      successCount: Object.entries(statusCounts)
        .filter(([status]) => status.startsWith("2"))
        .reduce((sum, [, count]) => sum + count, 0),
      statusCounts,
      errorCounts,
      latencyMs: summarizeLatencies(latenciesMs)
    },
    metricsDelta: diffMetricsSnapshot(metricsBefore, metricsAfter)
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(await runHttpLoadTest(), null, 2));
}
