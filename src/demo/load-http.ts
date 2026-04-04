export {};

import { runHttpLoad } from "./http-load-lib.ts";

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

function envNumber(name: string, fallback: number): number {
  const raw = env.process?.env?.[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const url = env.process?.env?.TARGET_URL ?? "http://127.0.0.1:3000/demo/orders";
const method = env.process?.env?.METHOD ?? "GET";
const totalRequests = envNumber("REQUESTS", 500);
const concurrency = envNumber("CONCURRENCY", 50);
const timeoutMs = envNumber("TIMEOUT_MS", 6_000);
const token = env.process?.env?.AUTH_TOKEN ?? "demo:alice";
const body = env.process?.env?.BODY;
const headersJson = env.process?.env?.HEADERS_JSON;
const extraHeaders = headersJson ? JSON.parse(headersJson) as Record<string, string> : {};
const summary = await runHttpLoad({
  url,
  method,
  totalRequests,
  concurrency,
  timeoutMs,
  token,
  body,
  headers: extraHeaders,
  onProgress(progress) {
    if (progress.completed % 100 === 0 || progress.completed === progress.totalRequests) {
      console.log(JSON.stringify({
        type: "progress",
        completed: progress.completed,
        totalRequests: progress.totalRequests
      }));
    }
  }
});

console.log(JSON.stringify(summary, null, 2));
