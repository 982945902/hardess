import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { HardessConfig } from "../../shared/types.ts";
import { handleHttpRequest } from "./http.ts";
import { DemoBearerAuthProvider } from "../auth/provider.ts";
import { RuntimeAuthService } from "../auth/service.ts";
import { ConsoleLogger } from "../observability/logger.ts";

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
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("handleHttpRequest", () => {
  it("proxies authenticated requests", async () => {
    const response = await handleHttpRequest(
      new Request("http://localhost/demo/orders", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        configStore: {
          getConfig: () => config,
          reload: async () => config,
          watch: () => {}
        },
        authService: new RuntimeAuthService([new DemoBearerAuthProvider()]),
        logger: new ConsoleLogger()
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: "http://upstream.internal/demo/orders"
    });
  });

  it("rejects unknown routes", async () => {
    const response = await handleHttpRequest(
      new Request("http://localhost/unknown", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        configStore: {
          getConfig: () => config,
          reload: async () => config,
          watch: () => {}
        },
        authService: new RuntimeAuthService([new DemoBearerAuthProvider()]),
        logger: new ConsoleLogger()
      }
    );

    expect(response.status).toBe(404);
  });
});
