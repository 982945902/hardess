import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { InMemoryMetrics } from "./observability/metrics.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeApp } from "./app.ts";
import { parseEnvelope, serializeEnvelope } from "../shared/envelope.ts";

const originalFetch = globalThis.fetch;
const cleanupPaths: string[] = [];
const appDisposers: Array<() => void> = [];

beforeEach(() => {
  globalThis.fetch = mock(async (request: Request) => {
    return Response.json({
      ok: true,
      upstreamUrl: request.url,
      peerId: request.headers.get("x-hardess-peer-id"),
      workerId: request.headers.get("x-hardess-worker")
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  while (appDisposers.length > 0) {
    appDisposers.pop()?.();
  }
});

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
});

describe("createRuntimeApp", () => {
  it("serves the HTTP runtime path through the app fetch entrypoint", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts"
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response).toBeDefined();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://127.0.0.1:9000/demo/health",
      peerId: "alice",
      workerId: "demo-http"
    });
  });

  it("returns 426 when websocket upgrade fails", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts"
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/ws"),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response?.status).toBe(426);
  });

  it("keeps the default listener unrestricted for backward compatibility", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const defaultAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "default"
      }
    );
    const defaultWs = await app.fetch(
      new Request("http://localhost/ws"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "internal"
      }
    );

    expect(defaultAdmin?.status).toBe(200);
    expect(defaultWs?.status).toBe(426);
  });

  it("keeps __admin and __cluster internal-only even without listener path policies", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const publicAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "public"
      }
    );
    const publicCluster = await app.fetch(
      new Request("http://localhost/__cluster/locate", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          peerIds: ["alice"]
        })
      }),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "public"
      }
    );

    expect(publicAdmin?.status).toBe(404);
    expect(publicCluster?.status).toBe(404);
  });

  it("accepts cluster websocket upgrade only on the internal listener", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const publicResponse = await app.fetch(
      new Request("http://localhost/__cluster/ws"),
      {
        upgrade() {
          return true;
        }
      },
      {
        listener: "public"
      }
    );

    let internalUpgradeData: unknown;
    const internalResponse = await app.fetch(
      new Request("http://localhost/__cluster/ws"),
      {
        upgrade(_request, options) {
          internalUpgradeData = options?.data;
          return true;
        }
      },
      {
        listener: "internal"
      }
    );

    expect(publicResponse?.status).toBe(404);
    expect(internalResponse).toBeUndefined();
    expect((internalUpgradeData as { kind?: string } | undefined)?.kind).toBe("cluster");
  });

  it("applies listener path policies only when configured", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics(),
      listeners: {
        public: {
          allowedPathPrefixes: ["/ws", "/demo"]
        },
        internal: {
          allowedPathPrefixes: ["/__admin", "/__cluster"]
        }
      }
    });
    appDisposers.push(() => app.dispose());

    const publicAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "public"
      }
    );
    const publicBusiness = await app.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "public"
      }
    );
    const internalCluster = await app.fetch(
      new Request("http://localhost/__cluster/locate", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          peerIds: ["alice"]
        })
      }),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "internal"
      }
    );
    const internalBusiness = await app.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "internal"
      }
    );

    expect(publicAdmin?.status).toBe(404);
    expect(publicBusiness?.status).toBe(200);
    expect(internalCluster?.status).toBe(200);
    expect(internalBusiness?.status).toBe(404);
  });

  it("exposes admin health, readiness, and metrics endpoints", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const health = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      }
    );
    const ready = await app.fetch(
      new Request("http://localhost/__admin/ready"),
      {
        upgrade() {
          return false;
        }
      }
    );
    const metrics = await app.fetch(
      new Request("http://localhost/__admin/metrics"),
      {
        upgrade() {
          return false;
        }
      }
    );
    const prometheus = await app.fetch(
      new Request("http://localhost/__admin/metrics/prometheus"),
      {
        upgrade() {
          return false;
        }
      }
    );
    const clusterPeers = await app.fetch(
      new Request("http://localhost/__admin/cluster/peers"),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(health?.status).toBe(200);
    expect((await health?.json())?.ok).toBe(true);
    expect(ready?.status).toBe(200);
    expect((await ready?.json())?.status).toBe("ready");
    expect(metrics?.status).toBe(200);
    expect((await metrics?.json())?.metrics).toEqual({
      counters: {},
      timings: {},
      timingCounts: {}
    });
    expect(prometheus?.status).toBe(200);
    expect(prometheus?.headers.get("content-type")).toContain("text/plain");
    expect(clusterPeers?.status).toBe(200);
    expect((await clusterPeers?.json())?.peers).toEqual([]);
  });

  it("reports not ready and rejects traffic during shutdown", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());
    app.beginShutdown();

    const ready = await app.fetch(
      new Request("http://localhost/__admin/ready"),
      {
        upgrade() {
          return false;
        }
      }
    );
    const response = await app.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(ready?.status).toBe(503);
    expect(response?.status).toBe(503);
  });

  it("rejects websocket upgrades during shutdown", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());
    app.beginShutdown();

    const response = await app.fetch(
      new Request("http://localhost/ws"),
      {
        upgrade() {
          return true;
        }
      }
    );

    expect(response?.status).toBe(503);
  });

  it("waits for in-flight http requests to drain during shutdown", async () => {
    let releaseUpstream!: () => void;
    globalThis.fetch = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });

      return Response.json({
        ok: true
      });
    }) as unknown as typeof fetch;

    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const requestPromise = app.fetch(
      new Request("http://localhost/demo/slow", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    while (app.runtimeState().inFlightHttpRequests !== 1) {
      await Bun.sleep(1);
    }

    app.beginShutdown();

    const drainedBeforeRelease = await app.waitForHttpDrain({ timeoutMs: 5, pollIntervalMs: 1 });
    expect(drainedBeforeRelease).toBe(false);

    releaseUpstream();
    const response = await requestPromise;
    const drained = await app.waitForHttpDrain({ timeoutMs: 50, pollIntervalMs: 1 });

    expect(response?.status).toBe(200);
    expect(drained).toBe(true);
    expect(app.runtimeState().inFlightHttpRequests).toBe(0);
  });

  it("applies reloaded config to new requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-app-config-"));
    cleanupPaths.push(dir);

    const configPath = join(dir, "hardess.config.ts");
    const writeConfig = async (origin: string) => {
      await writeFile(
        configPath,
        `export const hardessConfig = {
          pipelines: [
            {
              id: "demo-http",
              matchPrefix: "/demo",
              auth: { required: true },
              downstream: {
                origin: "${origin}",
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
        };`
      );
    };

    await writeConfig("http://upstream-a.internal");
    const app = await createRuntimeApp({
      configModulePath: configPath
    });
    appDisposers.push(() => app.dispose());

    const firstResponse = await app.fetch(
      new Request("http://localhost/demo/reload", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(await firstResponse?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://upstream-a.internal/demo/reload",
      peerId: "alice",
      workerId: "demo-http"
    });

    await Bun.sleep(5);
    await writeConfig("http://upstream-b.internal");
    await app.configStore.reload();

    const secondResponse = await app.fetch(
      new Request("http://localhost/demo/reload", {
        headers: {
          authorization: "Bearer demo:alice"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(await secondResponse?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://upstream-b.internal/demo/reload",
      peerId: "alice",
      workerId: "demo-http"
    });
  });

  it("routes websocket traffic across two runtime nodes through cluster relay", async () => {
    interface TestSocket {
      data: Record<string, unknown> & { connId: string };
      sent: string[];
      closed?: { code?: number; reason?: string };
      send(data: string): number;
      getBufferedAmount(): number;
      close(code?: number, reason?: string): void;
    }

    function createSocket(connId: string): TestSocket {
      return {
        data: { connId },
        sent: [],
        send(data: string) {
          this.sent.push(data);
          return data.length;
        },
        getBufferedAmount() {
          return 0;
        },
        close(code?: number, reason?: string) {
          this.closed = { code, reason };
        }
      };
    }

    async function openClientSocketThroughPublicListener(
      app: Awaited<ReturnType<typeof createRuntimeApp>>,
      connId: string
    ): Promise<TestSocket> {
      let upgradeData: unknown;
      const response = await app.fetch(
        new Request("http://localhost/ws"),
        {
          upgrade(_request, options) {
            upgradeData = options?.data;
            return true;
          }
        },
        {
          listener: "public"
        }
      );

      expect(response).toBeUndefined();
      const socket = createSocket(connId);
      socket.data = {
        ...(upgradeData as Record<string, unknown>),
        connId
      };
      app.websocket.open(socket);
      return socket;
    }

    let appA: Awaited<ReturnType<typeof createRuntimeApp>>;
    let appB: Awaited<ReturnType<typeof createRuntimeApp>>;
    const upgradeRef = {
      upgrade() {
        return false;
      }
    };
    const fetchA = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return await appB.fetch(new Request(url, init), upgradeRef, {
        listener: "internal"
      });
    }) as unknown as typeof fetch;
    const fetchB = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return await appA.fetch(new Request(url, init), upgradeRef, {
        listener: "internal"
      });
    }) as unknown as typeof fetch;

    appA = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      nodeId: "node-a",
      cluster: {
        transport: "http",
        peers: [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
        sharedSecret: "secret",
        fetchFn: fetchA
      }
    });
    appB = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      nodeId: "node-b",
      cluster: {
        transport: "http",
        peers: [{ nodeId: "node-a", baseUrl: "http://node-a.internal" }],
        sharedSecret: "secret",
        fetchFn: fetchB
      }
    });
    appDisposers.push(() => appA.dispose());
    appDisposers.push(() => appB.dispose());

    const alice = await openClientSocketThroughPublicListener(appA, "conn-alice");
    const bob = await openClientSocketThroughPublicListener(appB, "conn-bob");

    await appA.websocket.message(
      alice,
      serializeEnvelope({
        msgId: "auth-alice",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: Date.now(),
        payload: {
          provider: "bearer",
          payload: "demo:alice"
        }
      })
    );
    await appB.websocket.message(
      bob,
      serializeEnvelope({
        msgId: "auth-bob",
        kind: "system",
        src: { peerId: "anonymous", connId: "pending" },
        protocol: "sys",
        version: "1.0",
        action: "auth",
        ts: Date.now(),
        payload: {
          provider: "bearer",
          payload: "demo:bob"
        }
      })
    );

    await appA.websocket.message(
      alice,
      serializeEnvelope({
        msgId: "chat-send-1",
        kind: "biz",
        src: { peerId: "alice", connId: "conn-alice" },
        protocol: "chat",
        version: "1.0",
        action: "send",
        ts: Date.now(),
        payload: {
          toPeerId: "bob",
          content: "cross-node"
        }
      })
    );

    const bobMessage = parseEnvelope(bob.sent.at(-1) ?? "");
    expect(bobMessage?.action).toBe("message");
    expect(bobMessage?.payload).toEqual({
      fromPeerId: "alice",
      content: "cross-node"
    });
    expect(parseEnvelope(alice.sent.at(-1) ?? "")?.action).toBe("recvAck");

    await appB.websocket.message(
      bob,
      serializeEnvelope({
        msgId: "handle-1",
        kind: "system",
        src: { peerId: "bob", connId: "conn-bob" },
        protocol: "sys",
        version: "1.0",
        action: "handleAck",
        ts: Date.now(),
        payload: {
          ackFor: "chat-send-1"
        }
      })
    );

    expect(parseEnvelope(alice.sent.at(-1) ?? "")?.action).toBe("handleAck");
  });

  it("retries cluster routing after invalidating stale remote locator cache", async () => {
    interface TestSocket {
      data: { connId: string };
      sent: string[];
      closed?: { code?: number; reason?: string };
      send(data: string): number;
      getBufferedAmount(): number;
      close(code?: number, reason?: string): void;
    }

    function createSocket(connId: string): TestSocket {
      return {
        data: { connId },
        sent: [],
        send(data: string) {
          this.sent.push(data);
          return data.length;
        },
        getBufferedAmount() {
          return 0;
        },
        close(code?: number, reason?: string) {
          this.closed = { code, reason };
        }
      };
    }

    async function auth(app: Awaited<ReturnType<typeof createRuntimeApp>>, socket: TestSocket, peerId: string) {
      await app.websocket.message(
        socket,
        serializeEnvelope({
          msgId: `auth-${peerId}-${socket.data.connId}`,
          kind: "system",
          src: { peerId: "anonymous", connId: "pending" },
          protocol: "sys",
          version: "1.0",
          action: "auth",
          ts: Date.now(),
          payload: {
            provider: "bearer",
            payload: `demo:${peerId}`
          }
        })
      );
    }

    async function sendChat(
      app: Awaited<ReturnType<typeof createRuntimeApp>>,
      socket: TestSocket,
      msgId: string
    ) {
      await app.websocket.message(
        socket,
        serializeEnvelope({
          msgId,
          kind: "biz",
          src: { peerId: "alice", connId: socket.data.connId },
          protocol: "chat",
          version: "1.0",
          action: "send",
          ts: Date.now(),
          payload: {
            toPeerId: "bob",
            content: msgId
          }
        })
      );
    }

    let appA: Awaited<ReturnType<typeof createRuntimeApp>>;
    let appB: Awaited<ReturnType<typeof createRuntimeApp>>;
    const upgradeRef = {
      upgrade() {
        return false;
      }
    };
    const fetchA = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      return await appB.fetch(new Request(String(input), init), upgradeRef);
    }) as unknown as typeof fetch;
    const fetchB = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      return await appA.fetch(new Request(String(input), init), upgradeRef);
    }) as unknown as typeof fetch;

    appA = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      nodeId: "node-a",
      metrics: new InMemoryMetrics(),
      cluster: {
        transport: "http",
        peers: [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
        sharedSecret: "secret",
        fetchFn: fetchA,
        locatorCacheTtlMs: 10_000
      }
    });
    appB = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      nodeId: "node-b",
      metrics: new InMemoryMetrics(),
      cluster: {
        transport: "http",
        peers: [{ nodeId: "node-a", baseUrl: "http://node-a.internal" }],
        sharedSecret: "secret",
        fetchFn: fetchB,
        locatorCacheTtlMs: 10_000
      }
    });
    appDisposers.push(() => appA.dispose());
    appDisposers.push(() => appB.dispose());

    const alice = createSocket("conn-alice");
    const bobOld = createSocket("conn-bob-old");
    appA.websocket.open(alice);
    appB.websocket.open(bobOld);
    await auth(appA, alice, "alice");
    await auth(appB, bobOld, "bob");

    await sendChat(appA, alice, "chat-send-warm");
    expect(parseEnvelope(bobOld.sent.at(-1) ?? "")?.action).toBe("message");

    appB.websocket.close(bobOld);

    const bobNew = createSocket("conn-bob-new");
    appB.websocket.open(bobNew);
    await auth(appB, bobNew, "bob");

    await sendChat(appA, alice, "chat-send-retry");

    const deliveredToNew = bobNew.sent
      .map((raw) => parseEnvelope(raw))
      .find((envelope) => envelope?.kind === "biz" && envelope.msgId === "chat-send-retry");
    expect(deliveredToNew?.action).toBe("message");
    expect(parseEnvelope(alice.sent.at(-1) ?? "")?.action).toBe("recvAck");
    expect(
      (appA.metrics as InMemoryMetrics).snapshot().counters["ws.route_cache_retry"]
    ).toBe(1);
  });

  it("rejects unauthorized cluster relay requests when a shared secret is configured", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      nodeId: "node-a",
      cluster: {
        peers: [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
        sharedSecret: "secret"
      }
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/__cluster/locate", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          peerIds: ["alice"]
        })
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response?.status).toBe(401);
    expect((await response?.json())?.error).toBe("Unauthorized cluster request");
  });
});
