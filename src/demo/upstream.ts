declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number };
};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixedDelayMs = Number(env.process?.env?.UPSTREAM_DELAY_MS ?? 0);
const jitterDelayMs = Number(env.process?.env?.UPSTREAM_JITTER_MS ?? 0);
const failureRate = Number(env.process?.env?.UPSTREAM_FAILURE_RATE ?? 0);
const hangRate = Number(env.process?.env?.UPSTREAM_HANG_RATE ?? 0);

function sampleDelayMs(): number {
  if (jitterDelayMs <= 0) {
    return fixedDelayMs;
  }

  return fixedDelayMs + Math.floor(Math.random() * jitterDelayMs);
}

const server = Bun.serve({
  port: Number(env.process?.env?.UPSTREAM_PORT ?? 9000),
  async fetch(request) {
    const delayMs = sampleDelayMs();
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (hangRate > 0 && Math.random() < hangRate) {
      return await new Promise<Response>(() => {});
    }

    if (failureRate > 0 && Math.random() < failureRate) {
      return Response.json(
        {
          ok: false,
          reason: "simulated upstream failure"
        },
        {
          status: 503
        }
      );
    }

    const url = new URL(request.url);
    const bodyText =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text();

    return Response.json({
      ok: true,
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      headers: {
        "x-hardess-pipeline": request.headers.get("x-hardess-pipeline"),
        "x-hardess-worker": request.headers.get("x-hardess-worker"),
        "x-hardess-auth-peer": request.headers.get("x-hardess-auth-peer"),
        "x-hardess-peer-id": request.headers.get("x-hardess-peer-id"),
        "x-hardess-trace-id": request.headers.get("x-hardess-trace-id")
      },
      body: bodyText,
      simulatedDelayMs: delayMs
    });
  }
});

console.log(`demo upstream listening on :${server.port}`);
