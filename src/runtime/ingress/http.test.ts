import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { HardessConfig } from "../../shared/types.ts";
import type { ConfigStore } from "../config/store.ts";
import { handleHttpRequest } from "./http.ts";
import { DemoBearerAuthProvider } from "../auth/provider.ts";
import { RuntimeAuthService } from "../auth/service.ts";
import { ConsoleLogger } from "../observability/logger.ts";
import { InMemoryMetrics } from "../observability/metrics.ts";
import { UpstreamWebSocketProxyRuntime } from "../proxy/upstream-websocket.ts";

const config: HardessConfig = {
  pipelines: [
    {
      id: "demo-http",
      matchPrefix: "/demo",
      auth: { required: true },
      downstream: {
        origin: "http://upstream.internal",
        connectTimeoutMs: 1000,
        responseTimeoutMs: 5000,
        forwardAuthContext: true
      },
      worker: {
        entry: "workers/demo-worker.ts",
        timeoutMs: 100
      }
    }
  ]
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async (request: Request) => {
    return new Response(JSON.stringify({ ok: true, url: request.url }), {
      headers: {
        "content-type": "application/json"
      }
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createConfigStoreMock(nextConfig: HardessConfig): ConfigStore {
  return {
    getConfig: () => nextConfig,
    reload: async () => nextConfig,
    watch: () => {},
    dispose: () => {},
    subscribe: () => () => {}
  };
}

function createHttpDeps(nextConfig: HardessConfig, metrics: InMemoryMetrics) {
  return {
    configStore: createConfigStoreMock(nextConfig),
    authService: new RuntimeAuthService([new DemoBearerAuthProvider()]),
    logger: new ConsoleLogger(),
    metrics,
    serverRef: {
      upgrade() {
        return false;
      }
    },
    upstreamWebSocketProxy: new UpstreamWebSocketProxyRuntime({
      logger: new ConsoleLogger(),
      metrics
    })
  };
}

describe("handleHttpRequest", () => {
  it("proxies authenticated requests", async () => {
    const metrics = new InMemoryMetrics();
    const response = await handleHttpRequest(
      new Request("http://localhost/demo/orders", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      createHttpDeps(config, metrics)
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      ok: true,
      url: "http://upstream.internal/demo/orders"
    });
    expect(metrics.counter("http.request_in")).toBe(1);
    expect(metrics.counter("http.auth_ok")).toBe(1);
    expect(metrics.counter("worker.run_ok")).toBe(1);
    expect(metrics.counter("http.upstream_ok")).toBe(1);
    expect(metrics.counter("http.proxy_ok")).toBe(1);
    expect(metrics.timings("http.request_ms").length).toBe(1);
    expect(metrics.timings("http.upstream_ms").length).toBe(1);
    expect(metrics.timings("worker.run_ms").length).toBe(1);
  });

  it("rejects unknown routes", async () => {
    const metrics = new InMemoryMetrics();
    const response = await handleHttpRequest(
      new Request("http://localhost/unknown", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      createHttpDeps(config, metrics)
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    expect(metrics.counter("http.request_in")).toBe(1);
    expect(metrics.counter("http.route_missing")).toBe(1);
    expect(metrics.counter("http.error")).toBe(1);
  });

  it("maps upstream connect timeout failures", async () => {
    globalThis.fetch = mock((request: Request) => {
      return new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;

    const metrics = new InMemoryMetrics();
    const response = await handleHttpRequest(
      new Request("http://localhost/demo/orders", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      createHttpDeps({
        pipelines: [
          {
            ...config.pipelines[0]!,
            downstream: {
              ...config.pipelines[0]!.downstream,
              connectTimeoutMs: 5,
              responseTimeoutMs: 20
            }
          }
        ]
      }, metrics)
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(504);
    expect(metrics.counter("http.upstream_connect_timeout")).toBe(1);
    expect(metrics.counter("http.error")).toBe(1);
  });

  it("keeps response-body latency under responseTimeout instead of connectTimeout", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(10);
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
            controller.close();
          }
        }),
        {
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as unknown as typeof fetch;

    const metrics = new InMemoryMetrics();
    const response = await handleHttpRequest(
      new Request("http://localhost/demo/orders", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      createHttpDeps({
        pipelines: [
          {
            ...config.pipelines[0]!,
            downstream: {
              ...config.pipelines[0]!.downstream,
              connectTimeoutMs: 5,
              responseTimeoutMs: 20
            }
          }
        ]
      }, metrics)
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true });
    expect(metrics.counter("http.upstream_connect_timeout")).toBe(0);
    expect(metrics.counter("http.upstream_timeout")).toBe(0);
    expect(metrics.counter("http.upstream_ok")).toBe(1);
  });

  it("maps upstream response timeout failures after headers are received", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(30);
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
            controller.close();
          }
        }),
        {
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as unknown as typeof fetch;

    const metrics = new InMemoryMetrics();
    const response = await handleHttpRequest(
      new Request("http://localhost/demo/orders", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      createHttpDeps({
        pipelines: [
          {
            ...config.pipelines[0]!,
            downstream: {
              ...config.pipelines[0]!.downstream,
              connectTimeoutMs: 20,
              responseTimeoutMs: 5
            }
          }
        ]
      }, metrics)
    );

    expect(response).toBeDefined();
    expect(response!.status).toBe(504);
    expect(metrics.counter("http.upstream_connect_timeout")).toBe(0);
    expect(metrics.counter("http.upstream_timeout")).toBe(1);
    expect(metrics.counter("http.error")).toBe(1);
  });
});
