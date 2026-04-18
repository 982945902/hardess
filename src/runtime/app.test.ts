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

  it("internally forwards HTTP requests to the host selected by admin topology", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardess-app-internal-forward-"));
    cleanupPaths.push(dir);
    const sourceConfigPath = join(dir, "source.config.ts");
    const targetConfigPath = join(dir, "target.config.ts");
    await writeFile(sourceConfigPath, `export const hardessConfig = { pipelines: [] };`);
    await writeFile(
      targetConfigPath,
      `export const hardessConfig = {
        pipelines: [
          {
            id: "demo-http",
            matchPrefix: "/demo",
            auth: { required: true },
            downstream: {
              origin: "http://127.0.0.1:9000",
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

    const sourceApp = await createRuntimeApp({
      configModulePath: sourceConfigPath,
      nodeId: "node-a"
    });
    const targetApp = await createRuntimeApp({
      configModulePath: targetConfigPath,
      nodeId: "node-b"
    });
    appDisposers.push(() => sourceApp.dispose());
    appDisposers.push(() => targetApp.dispose());

    sourceApp.topologyStore.setTopology({
      membership: {
        revision: "topology:1:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            groupId: "group-chat",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-b",
            nodeId: "node-b",
            internalBaseUrl: "http://node-b.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:1:placement",
        generatedAt: 1,
        deployments: [
          {
            deploymentId: "deployment:demo-http",
            deploymentKind: "http_worker",
            ownerHostIds: ["host-b"],
            routes: [
              {
                routeId: "route:demo-http",
                pathPrefix: "/demo",
                ownerHostIds: ["host-b"]
              }
            ]
          }
        ]
      }
    });

    globalThis.fetch = mock(async (request: Request) => {
      if (request.url === "http://node-b.internal/__cluster/http-forward") {
        return await targetApp.fetch(
          request,
          {
            upgrade() {
              return false;
            }
          },
          {
            listener: "internal"
          }
        ) as Response;
      }

      return Response.json({
        ok: true,
        upstreamUrl: request.url,
        peerId: request.headers.get("x-hardess-peer-id"),
        workerId: request.headers.get("x-hardess-worker")
      });
    }) as unknown as typeof fetch;

    const response = await sourceApp.fetch(
      new Request("http://localhost/demo/health", {
        headers: {
          authorization: "Bearer demo:alice",
          "x-trace-id": "trace-forward-1"
        }
      }),
      {
        upgrade() {
          return false;
        }
      }
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      upstreamUrl: "http://127.0.0.1:9000/demo/health",
      peerId: "alice",
      workerId: "demo-http"
    });
  });

  it("uses admin topology to narrow distributed websocket locate peers", async () => {
    const fetchUrls: string[] = [];
    const fetchBodies: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        fetchBodies.push(JSON.parse(String(init.body)));
      }
      fetchUrls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      );
      return Response.json({
        peers: {
          alice: []
        }
      });
    }) as unknown as typeof fetch;

    const dir = await mkdtemp(join(tmpdir(), "hardess-app-topology-peers-"));
    cleanupPaths.push(dir);
    const configPath = join(dir, "hardess.config.ts");
    await writeFile(configPath, `export const hardessConfig = { pipelines: [] };`);

    const app = await createRuntimeApp({
      configModulePath: configPath,
      nodeId: "node-a",
      cluster: {
        peers: [
          { nodeId: "node-b", baseUrl: "http://node-b.static" },
          { nodeId: "node-c", baseUrl: "http://node-c.static" }
        ]
      }
    });
    appDisposers.push(() => app.dispose());

    app.topologyStore.setTopology({
      membership: {
        revision: "topology:2:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-c",
            groupId: "group-chat",
            nodeId: "node-c",
            internalBaseUrl: "http://node-c.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:2:placement",
        generatedAt: 1,
        deployments: [
          {
            deploymentId: "deploy-chat",
            deploymentKind: "service_module",
            groupId: "group-chat",
            ownerHostIds: ["host-c"],
            routes: []
          }
        ]
      }
    });

    await app.peerLocator.find("alice", { groupId: "group-chat" });

    expect(app.clusterNetwork.listPeers()).toEqual([
      { nodeId: "node-c", baseUrl: "http://node-c.internal" }
    ]);
    expect(fetchUrls).toEqual(["http://node-c.internal/__cluster/locate"]);
    expect(fetchBodies).toEqual([
      {
        peerIds: ["alice"],
        groupId: "group-chat"
      }
    ]);
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

  it("rejects business websocket upgrades when the pipeline does not enable upstream websocket proxy", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts"
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
      new Request("http://localhost/demo/socket", {
        headers: {
          authorization: "Bearer demo:alice",
          connection: "Upgrade",
          upgrade: "websocket"
        }
      }),
      {
        upgrade() {
          return true;
        }
      },
      {
        listener: "public"
      }
    );

    expect(response?.status).toBe(426);
    expect(await response?.text()).toContain("WebSocket proxy is not enabled");
  });

  it("proxies business websocket traffic to the configured upstream websocket", async () => {
    class FakeUpstreamWebSocket {
      static instances: FakeUpstreamWebSocket[] = [];

      readonly listeners = {
        open: [] as Array<() => void>,
        message: [] as Array<(event: { data?: unknown }) => void>,
        close: [] as Array<(event: { code?: number; reason?: string }) => void>,
        error: [] as Array<() => void>
      };
      readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly protocols?: string | string[];
      protocol: string;
      binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
      closed?: {
        code?: number;
        reason?: string;
      };

      constructor(url: string | URL, options?: { headers?: Record<string, string>; protocols?: string | string[] }) {
        this.url = String(url);
        this.headers = options?.headers;
        this.protocols = options?.protocols;
        const offered = Array.isArray(options?.protocols)
          ? options?.protocols[0]
          : options?.protocols;
        this.protocol = offered ?? "";
        FakeUpstreamWebSocket.instances.push(this);
        queueMicrotask(() => {
          for (const listener of this.listeners.open) {
            listener();
          }
        });
      }

      addEventListener(type: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
        (this.listeners[type] as Array<(...args: never[]) => void>).push(listener);
      }

      send(data: string | ArrayBuffer | Uint8Array): void {
        this.sent.push(data);
      }

      close(code?: number, reason?: string): void {
        this.closed = { code, reason };
      }

      emitMessage(data: unknown): void {
        for (const listener of this.listeners.message) {
          listener({ data });
        }
      }

      emitClose(code?: number, reason?: string): void {
        for (const listener of this.listeners.close) {
          listener({ code, reason });
        }
      }
    }

    interface ProxiedServerSocket {
      data: Record<string, unknown> & { bridgeId: string };
      sent: Array<string | ArrayBuffer | Uint8Array>;
      closed?: {
        code?: number;
        reason?: string;
      };
      send(data: string | ArrayBuffer | Uint8Array): number;
      close(code?: number, reason?: string): void;
    }

    const dir = await mkdtemp(join(tmpdir(), "hardess-app-upstream-ws-"));
    cleanupPaths.push(dir);
    const configPath = join(dir, "hardess.config.ts");
    await writeFile(
      configPath,
      `export const hardessConfig = {
        pipelines: [
          {
            id: "demo-upstream-ws",
            matchPrefix: "/demo",
            auth: { required: true },
            downstream: {
              origin: "ws://upstream.internal",
              websocket: true,
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000,
              forwardAuthContext: false,
              injectedHeaders: {
                "x-proxy-mode": "ws"
              }
            }
          }
        ]
      };`
    );

    const app = await createRuntimeApp({
      configModulePath: configPath,
      upstreamWebSocket: {
        socketFactory: (url, options) => new FakeUpstreamWebSocket(url, options)
      }
    });
    appDisposers.push(() => app.dispose());

    let upgradeData: unknown;
    let upgradeHeaders: HeadersInit | undefined;
    const response = await app.fetch(
      new Request("http://localhost/demo/socket?room=alpha", {
        headers: {
          authorization: "Bearer demo:alice",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-protocol": "chat.v1"
        }
      }),
      {
        upgrade(_request, options) {
          upgradeData = options?.data;
          upgradeHeaders = options?.headers;
          return true;
        }
      },
      {
        listener: "public"
      }
    );

    expect(response).toBeUndefined();
    expect(FakeUpstreamWebSocket.instances).toHaveLength(1);
    const upstreamSocket = FakeUpstreamWebSocket.instances[0]!;
    expect(upstreamSocket.url).toBe("ws://upstream.internal/demo/socket?room=alpha");
    expect(upstreamSocket.headers?.authorization).toBeUndefined();
    expect(upstreamSocket.headers?.["x-hardess-peer-id"]).toBe("alice");
    expect(upstreamSocket.headers?.["x-proxy-mode"]).toBe("ws");
    expect(upstreamSocket.protocols).toEqual(["chat.v1"]);
    expect(new Headers(upgradeHeaders).get("sec-websocket-protocol")).toBe("chat.v1");

    const serverSocket: ProxiedServerSocket = {
      data: upgradeData as ProxiedServerSocket["data"],
      sent: [],
      send(data) {
        this.sent.push(data);
        return typeof data === "string" ? data.length : data.byteLength;
      },
      close(code?: number, reason?: string) {
        this.closed = { code, reason };
      }
    };
    app.websocket.open(serverSocket);

    await app.websocket.message(serverSocket, "client->upstream");
    expect(upstreamSocket.sent).toEqual(["client->upstream"]);

    upstreamSocket.emitMessage("upstream->client");
    expect(serverSocket.sent).toEqual(["upstream->client"]);

    upstreamSocket.emitClose(1000, "done");
    expect(serverSocket.closed).toEqual({
      code: 1000,
      reason: "done"
    });
  });

  it("internally forwards business websocket traffic to the owner host selected by admin topology", async () => {
    class FakeUpstreamWebSocket {
      static instances: FakeUpstreamWebSocket[] = [];

      readonly listeners = {
        open: [] as Array<() => void>,
        message: [] as Array<(event: { data?: unknown }) => void>,
        close: [] as Array<(event: { code?: number; reason?: string }) => void>,
        error: [] as Array<() => void>
      };
      readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly protocols?: string | string[];
      protocol: string;
      binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
      closed?: {
        code?: number;
        reason?: string;
      };

      constructor(url: string | URL, options?: { headers?: Record<string, string>; protocols?: string | string[] }) {
        this.url = String(url);
        this.headers = options?.headers;
        this.protocols = options?.protocols;
        const offered = Array.isArray(options?.protocols)
          ? options?.protocols[0]
          : options?.protocols;
        this.protocol = offered ?? "";
        FakeUpstreamWebSocket.instances.push(this);
        queueMicrotask(() => {
          for (const listener of this.listeners.open) {
            listener();
          }
        });
      }

      addEventListener(type: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
        (this.listeners[type] as Array<(...args: never[]) => void>).push(listener);
      }

      send(data: string | ArrayBuffer | Uint8Array): void {
        this.sent.push(data);
      }

      close(code?: number, reason?: string): void {
        this.closed = { code, reason };
      }

      emitMessage(data: unknown): void {
        for (const listener of this.listeners.message) {
          listener({ data });
        }
      }

      emitClose(code?: number, reason?: string): void {
        for (const listener of this.listeners.close) {
          listener({ code, reason });
        }
      }
    }

    interface ProxiedServerSocket {
      data: Record<string, unknown> & { bridgeId: string };
      sent: Array<string | ArrayBuffer | Uint8Array>;
      closed?: {
        code?: number;
        reason?: string;
      };
      send(data: string | ArrayBuffer | Uint8Array): number;
      close(code?: number, reason?: string): void;
    }

    class InternalForwardWebSocket {
      protocol = "";
      binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
      private readonly listeners = {
        open: [] as Array<() => void>,
        message: [] as Array<(event: { data?: unknown }) => void>,
        close: [] as Array<(event: { code?: number; reason?: string }) => void>,
        error: [] as Array<() => void>
      };
      private serverSocket?: ProxiedServerSocket;
      private closed = false;

      constructor(
        url: string | URL,
        options: { headers?: Record<string, string>; protocols?: string | string[] } | undefined,
        private readonly targetApp: Awaited<ReturnType<typeof createRuntimeApp>>
      ) {
        const requestHeaders = new Headers(options?.headers);
        if (options?.protocols) {
          requestHeaders.set(
            "sec-websocket-protocol",
            Array.isArray(options.protocols) ? options.protocols.join(", ") : options.protocols
          );
        }

        queueMicrotask(async () => {
          const response = await this.targetApp.fetch(
            new Request(String(url), {
              headers: requestHeaders
            }),
            {
              upgrade: (_request, upgradeOptions) => {
                this.protocol =
                  new Headers(upgradeOptions?.headers).get("sec-websocket-protocol") ?? "";
                this.serverSocket = {
                  data: upgradeOptions?.data as ProxiedServerSocket["data"],
                  sent: [],
                  send: (data) => {
                    this.emit("message", { data });
                    return typeof data === "string" ? data.length : data.byteLength;
                  },
                  close: (code?: number, reason?: string) => {
                    if (this.closed) {
                      return;
                    }
                    this.closed = true;
                    this.emit("close", { code, reason });
                  }
                };
                this.targetApp.websocket.open(this.serverSocket);
                this.emit("open");
                return true;
              }
            },
            {
              listener: "internal"
            }
          );

          if (response) {
            this.emit("error");
            this.emit("close", { code: 1011, reason: await response.text() });
          }
        });
      }

      addEventListener(type: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): void {
        (this.listeners[type] as Array<(...args: never[]) => void>).push(listener);
      }

      send(data: string | ArrayBuffer | Uint8Array): void {
        if (!this.serverSocket) {
          throw new Error("Internal forward websocket is not open");
        }

        void this.targetApp.websocket.message(this.serverSocket, data);
      }

      close(code?: number, reason?: string): void {
        if (this.closed) {
          return;
        }

        this.closed = true;
        if (this.serverSocket) {
          this.targetApp.websocket.close(this.serverSocket, code, reason);
        }
        this.emit("close", { code, reason });
      }

      private emit(type: "open"): void;
      private emit(type: "error"): void;
      private emit(type: "message", event: { data?: unknown }): void;
      private emit(type: "close", event: { code?: number; reason?: string }): void;
      private emit(
        type: "open" | "message" | "close" | "error",
        event?: { data?: unknown } | { code?: number; reason?: string }
      ): void {
        for (const listener of this.listeners[type]) {
          (listener as (event?: { data?: unknown } | { code?: number; reason?: string }) => void)(event);
        }
      }
    }

    const dir = await mkdtemp(join(tmpdir(), "hardess-app-internal-ws-forward-"));
    cleanupPaths.push(dir);
    const sourceConfigPath = join(dir, "source.config.ts");
    const targetConfigPath = join(dir, "target.config.ts");
    await writeFile(sourceConfigPath, `export const hardessConfig = { pipelines: [] };`);
    await writeFile(
      targetConfigPath,
      `export const hardessConfig = {
        pipelines: [
          {
            id: "demo-upstream-ws",
            matchPrefix: "/demo",
            auth: { required: true },
            downstream: {
              origin: "ws://upstream.internal",
              websocket: true,
              connectTimeoutMs: 1000,
              responseTimeoutMs: 5000,
              forwardAuthContext: false
            }
          }
        ]
      };`
    );

    const targetApp = await createRuntimeApp({
      configModulePath: targetConfigPath,
      nodeId: "node-b",
      cluster: {
        sharedSecret: "secret"
      },
      upstreamWebSocket: {
        socketFactory: (url, options) => new FakeUpstreamWebSocket(url, options)
      }
    });
    const sourceApp = await createRuntimeApp({
      configModulePath: sourceConfigPath,
      nodeId: "node-a",
      cluster: {
        sharedSecret: "secret"
      },
      upstreamWebSocket: {
        socketFactory: (url, options) => new InternalForwardWebSocket(url, options, targetApp)
      }
    });
    appDisposers.push(() => sourceApp.dispose());
    appDisposers.push(() => targetApp.dispose());

    sourceApp.topologyStore.setTopology({
      membership: {
        revision: "topology:3:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-b",
            nodeId: "node-b",
            internalBaseUrl: "http://node-b.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:3:placement",
        generatedAt: 1,
        deployments: [
          {
            deploymentId: "deployment:demo-upstream-ws",
            deploymentKind: "http_worker",
            ownerHostIds: ["host-b"],
            routes: [
              {
                routeId: "route:demo-upstream-ws",
                pathPrefix: "/demo",
                ownerHostIds: ["host-b"]
              }
            ]
          }
        ]
      }
    });

    let upgradeData: unknown;
    let upgradeHeaders: HeadersInit | undefined;
    const response = await sourceApp.fetch(
      new Request("http://localhost/demo/socket?room=alpha", {
        headers: {
          authorization: "Bearer demo:alice",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-protocol": "chat.v1",
          "x-trace-id": "trace-ws-forward-1"
        }
      }),
      {
        upgrade(_request, options) {
          upgradeData = options?.data;
          upgradeHeaders = options?.headers;
          return true;
        }
      },
      {
        listener: "public"
      }
    );

    expect(response).toBeUndefined();
    expect(FakeUpstreamWebSocket.instances).toHaveLength(1);
    const upstreamSocket = FakeUpstreamWebSocket.instances[0]!;
    expect(upstreamSocket.url).toBe("ws://upstream.internal/demo/socket?room=alpha");
    expect(upstreamSocket.headers?.authorization).toBeUndefined();
    expect(upstreamSocket.headers?.["x-hardess-peer-id"]).toBe("alice");
    expect(upstreamSocket.protocols).toEqual(["chat.v1"]);
    expect(new Headers(upgradeHeaders).get("sec-websocket-protocol")).toBe("chat.v1");

    const serverSocket: ProxiedServerSocket = {
      data: upgradeData as ProxiedServerSocket["data"],
      sent: [],
      send(data) {
        this.sent.push(data);
        return typeof data === "string" ? data.length : data.byteLength;
      },
      close(code?: number, reason?: string) {
        this.closed = { code, reason };
      }
    };
    sourceApp.websocket.open(serverSocket);

    await sourceApp.websocket.message(serverSocket, "client->upstream");
    expect(upstreamSocket.sent).toEqual(["client->upstream"]);

    upstreamSocket.emitMessage("upstream->client");
    expect(serverSocket.sent).toEqual(["upstream->client"]);

    upstreamSocket.emitClose(1000, "done");
    expect(serverSocket.closed).toEqual({
      code: 1000,
      reason: "done"
    });
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
        listener: "control"
      }
    );

    expect(defaultAdmin?.status).toBe(200);
    expect(defaultWs?.status).toBe(426);
  });

  it("keeps __admin and __cluster control-only even without listener path policies", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const businessAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "business"
      }
    );
    const businessCluster = await app.fetch(
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
        listener: "business"
      }
    );

    expect(businessAdmin?.status).toBe(404);
    expect(businessCluster?.status).toBe(404);
  });

  it("accepts cluster websocket upgrade only on the control listener", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const businessResponse = await app.fetch(
      new Request("http://localhost/__cluster/ws"),
      {
        upgrade() {
          return true;
        }
      },
      {
        listener: "business"
      }
    );

    let controlUpgradeData: unknown;
    const controlResponse = await app.fetch(
      new Request("http://localhost/__cluster/ws"),
      {
        upgrade(_request, options) {
          controlUpgradeData = options?.data;
          return true;
        }
      },
      {
        listener: "control"
      }
    );

    expect(businessResponse?.status).toBe(404);
    expect(controlResponse).toBeUndefined();
    expect((controlUpgradeData as { kind?: string } | undefined)?.kind).toBe("cluster");
  });

  it("applies listener path policies only when configured", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics(),
      listeners: {
        business: {
          allowedPathPrefixes: ["/ws", "/demo"]
        },
        control: {
          allowedPathPrefixes: ["/__admin", "/__cluster"]
        }
      }
    });
    appDisposers.push(() => app.dispose());

    const businessAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "business"
      }
    );
    const businessRequest = await app.fetch(
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
        listener: "business"
      }
    );
    const controlCluster = await app.fetch(
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
        listener: "control"
      }
    );
    const controlBusiness = await app.fetch(
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
        listener: "control"
      }
    );

    expect(businessAdmin?.status).toBe(404);
    expect(businessRequest?.status).toBe(200);
    expect(controlCluster?.status).toBe(200);
    expect(controlBusiness?.status).toBe(404);
  });

  it("keeps public and internal listener names as compatibility aliases", async () => {
    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics(),
      listeners: {
        business: {
          allowedPathPrefixes: ["/ws", "/demo"]
        },
        control: {
          allowedPathPrefixes: ["/__admin", "/__cluster"]
        }
      }
    });
    appDisposers.push(() => app.dispose());

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
    const internalAdmin = await app.fetch(
      new Request("http://localhost/__admin/health"),
      {
        upgrade() {
          return false;
        }
      },
      {
        listener: "internal"
      }
    );

    expect(publicBusiness?.status).toBe(200);
    expect(internalAdmin?.status).toBe(200);
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
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'));
            releaseUpstream = () => {
              controller.enqueue(new TextEncoder().encode("true}"));
              controller.close();
            };
          }
        }),
        {
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as unknown as typeof fetch;

    const app = await createRuntimeApp({
      configModulePath: "./config/hardess.config.ts",
      metrics: new InMemoryMetrics()
    });
    appDisposers.push(() => app.dispose());

    const response = await app.fetch(
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
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({
      ok: true
    });
    const drained = await app.waitForHttpDrain({ timeoutMs: 50, pollIntervalMs: 1 });

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
