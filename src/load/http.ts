import * as http from "node:http";
import * as https from "node:https";
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

export type HttpConnectionMode = "keepalive" | "close";

export interface HttpLoadTestConfig {
  baseUrl: string;
  adminBaseUrl: string;
  peerId: string;
  pathname: string;
  method: string;
  connectionMode: HttpConnectionMode;
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
    connectionMode: HttpConnectionMode;
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
    connectionMode: parseHttpConnectionMode(
      envStringFirst(["HTTP_LOAD_CONNECTION_MODE", "CONNECTION_MODE"], "keepalive")
    ),
    concurrency: envNumberFirst(["HTTP_LOAD_CONCURRENCY", "CONCURRENCY"], 20),
    totalRequests: envNumberFirst(["HTTP_LOAD_REQUESTS", "REQUESTS"], 500),
    durationMs: envNumberFirst(["HTTP_LOAD_DURATION_MS", "DURATION_MS"], 0),
    requestBody: envOptionalStringFirst(["HTTP_LOAD_REQUEST_BODY", "REQUEST_BODY"])
  };
}

function parseHttpConnectionMode(value: string): HttpConnectionMode {
  return value.toLowerCase() === "close" ? "close" : "keepalive";
}

async function sendFetchRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  requestBody?: string
): Promise<number> {
  const response = await fetch(url, {
    method,
    headers,
    body: requestBody
  });
  return response.status;
}

async function sendFreshConnectionRequest(
  urlText: string,
  method: string,
  headers: Record<string, string>,
  requestBody?: string
): Promise<number> {
  const url = new URL(urlText);
  const transport = url.protocol === "https:" ? https : http;
  const requestHeaders = {
    ...headers,
    connection: "close",
    ...(requestBody
      ? {
          "content-length": Buffer.byteLength(requestBody).toString()
        }
      : {})
  };

  return await new Promise<number>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        agent: false
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      }
    );

    request.on("error", reject);

    if (requestBody) {
      request.write(requestBody);
    }

    request.end();
  });
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
    const requestUrl = `${config.baseUrl}${config.pathname}`;

    try {
      const status =
        config.connectionMode === "close"
          ? await sendFreshConnectionRequest(
              requestUrl,
              config.method,
              requestHeaders,
              config.requestBody
            )
          : await sendFetchRequest(
              requestUrl,
              config.method,
              requestHeaders,
              config.requestBody
            );
      latenciesMs.push(performance.now() - requestStartedAt);
      incCounter(statusCounts, String(status));
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
      connectionMode: config.connectionMode,
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
