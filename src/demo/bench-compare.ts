export {};

import { runHttpLoad, type HttpLoadSummary } from "./http-load-lib.ts";

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        headers: {
          authorization: "Bearer demo:alice"
        }
      });
      if (response.ok || response.status >= 400) {
        return;
      }
    } catch {
      // keep polling until timeout
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function spawnBun(scriptOrArgs: string[]): ReturnType<typeof Bun.spawn> {
  const bunPath = env.process?.execPath ?? "bun";
  return Bun.spawn({
    cmd: [bunPath, ...scriptOrArgs],
    cwd: "D:/code/hardess",
    stdout: "pipe",
    stderr: "pipe"
  });
}

async function readProcessOutput(process: ReturnType<typeof Bun.spawn>): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

async function runCase(name: string, summaryPromise: Promise<HttpLoadSummary>): Promise<{ name: string; summary: HttpLoadSummary }> {
  const summary = await summaryPromise;
  return { name, summary };
}

const requests = envNumber("REQUESTS", 1000);
const concurrency = envNumber("CONCURRENCY", 100);
const timeoutMs = envNumber("TIMEOUT_MS", 6000);

const bare = spawnBun(["run", "src/demo/bench-bare-http.ts"]);
const short = spawnBun(["run", "src/demo/bench-short-server.ts"]);
const upstream = spawnBun(["run", "src/demo/upstream.ts"]);
const full = spawnBun(["run", "src/runtime/server.ts"]);

try {
  await waitForHttp("http://127.0.0.1:3101/", 10_000);
  await waitForHttp("http://127.0.0.1:3102/bench", 10_000);
  await waitForHttp("http://127.0.0.1:3000/demo/orders", 10_000);

  const [bareResult, shortResult, fullResult] = await Promise.all([
    runCase("bun-bare", runHttpLoad({
      url: "http://127.0.0.1:3101/",
      totalRequests: requests,
      concurrency,
      timeoutMs,
      token: null
    })),
    runCase("hardess-short-circuit", runHttpLoad({
      url: "http://127.0.0.1:3102/bench",
      totalRequests: requests,
      concurrency,
      timeoutMs,
      token: "demo:alice"
    })),
    runCase("hardess-full-chain", runHttpLoad({
      url: "http://127.0.0.1:3000/demo/orders",
      totalRequests: requests,
      concurrency,
      timeoutMs,
      token: "demo:alice"
    }))
  ]);

  const baselineRps = bareResult.summary.requestsPerSecond || 1;
  const comparison = [bareResult, shortResult, fullResult].map((entry) => ({
    name: entry.name,
    requestsPerSecond: entry.summary.requestsPerSecond,
    rpsVsBare: Number((entry.summary.requestsPerSecond / baselineRps).toFixed(4)),
    p50: entry.summary.latencyMs.p50,
    p95: entry.summary.latencyMs.p95,
    failed: entry.summary.failed
  }));

  console.log(JSON.stringify({
    type: "bench-compare",
    requests,
    concurrency,
    timeoutMs,
    comparison,
    details: [bareResult, shortResult, fullResult]
  }, null, 2));
} finally {
  for (const process of [bare, short, upstream, full]) {
    process.kill();
    await process.exited;
  }

  const outputs = await Promise.all([bare, short, upstream, full].map((process) => readProcessOutput(process)));
  if (outputs.some(Boolean)) {
    console.error(outputs.filter(Boolean).join("\n"));
  }
}
