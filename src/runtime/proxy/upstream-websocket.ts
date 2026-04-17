import {
  ERROR_CODES,
  HardessError,
  type AuthContext,
  type PipelineConfig
} from "../../shared/index.ts";
import type { Logger } from "../observability/logger.ts";
import { NoopMetrics, type Metrics } from "../observability/metrics.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

const UPSTREAM_HANDSHAKE_HEADERS = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept"
]);

interface UpgradeServerRef {
  upgrade(
    request: Request,
    options?: {
      headers?: HeadersInit;
      data?: unknown;
    }
  ): boolean;
}

export interface UpstreamProxyServerSocket {
  data: {
    bridgeId: string;
  };
  send(data: string | ArrayBuffer | Uint8Array): number | void;
  close(code?: number, reason?: string): void;
}

interface UpstreamProxyMessageEvent {
  data?: unknown;
}

interface UpstreamProxyCloseEvent {
  code?: number;
  reason?: string;
}

export interface UpstreamWebSocketClient {
  protocol: string;
  binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: UpstreamProxyMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: UpstreamProxyCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type UpstreamWebSocketFactory = (
  url: string | URL,
  options?: {
    headers?: Record<string, string>;
    protocols?: string | string[];
  }
) => UpstreamWebSocketClient;

interface UpstreamWebSocketProxyDeps {
  logger: Logger;
  metrics?: Metrics;
  socketFactory?: UpstreamWebSocketFactory;
}

interface UpstreamWebSocketBridge {
  id: string;
  clientSocket?: UpstreamProxyServerSocket;
  upstreamSocket: UpstreamWebSocketClient;
  pendingClientMessages: Array<string | Uint8Array>;
  pendingUpstreamMessages: Array<string | Uint8Array>;
  closed: boolean;
  upstreamClosed?: {
    code?: number;
    reason?: string;
  };
}

function createTimeoutError(): HardessError {
  return new HardessError(ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT, "Upstream websocket connect timed out", {
    retryable: true,
    detail: "timeout_stage=websocket_connect"
  });
}

function createUnavailableError(error: unknown): HardessError {
  return new HardessError(ERROR_CODES.GATEWAY_UPSTREAM_UNAVAILABLE, "Upstream websocket service is unavailable", {
    retryable: true,
    detail: error instanceof Error ? error.message : String(error),
    cause: error
  });
}

function normalizeSocketMessage(raw: unknown): string | Uint8Array {
  if (typeof raw === "string") {
    return raw;
  }

  if (raw instanceof Uint8Array) {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    "buffer" in raw &&
    raw instanceof Uint8Array
  ) {
    return raw;
  }

  return new TextEncoder().encode(String(raw ?? ""));
}

function toUpstreamWebSocketUrl(request: Request, pipeline: PipelineConfig): string {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    pipeline.downstream.origin.endsWith("/")
      ? pipeline.downstream.origin
      : `${pipeline.downstream.origin}/`
  );

  if (upstreamUrl.protocol === "http:") {
    upstreamUrl.protocol = "ws:";
  } else if (upstreamUrl.protocol === "https:") {
    upstreamUrl.protocol = "wss:";
  }

  return upstreamUrl.toString();
}

function sanitizeHeadersForUpstreamWebSocket(
  request: Request,
  pipeline: PipelineConfig,
  auth: AuthContext,
  traceId?: string
): {
  headers: Record<string, string>;
  protocols?: string | string[];
} {
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  for (const header of UPSTREAM_HANDSHAKE_HEADERS) {
    headers.delete(header);
  }

  const offeredProtocols = headers.get("sec-websocket-protocol");
  headers.delete("sec-websocket-protocol");

  headers.set("x-hardess-trace-id", traceId ?? crypto.randomUUID());
  headers.set("x-hardess-peer-id", auth.peerId);
  headers.set("x-hardess-token-id", auth.tokenId);

  if (!pipeline.downstream.forwardAuthContext) {
    headers.delete("authorization");
  }

  for (const [key, value] of Object.entries(pipeline.downstream.injectedHeaders ?? {})) {
    headers.set(key, value);
  }

  const sanitizedHeaders = Object.fromEntries(headers.entries());
  const protocols = offeredProtocols
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    headers: sanitizedHeaders,
    protocols: protocols && protocols.length > 0 ? protocols : undefined
  };
}

function sanitizeHeadersForForwardedWebSocket(
  request: Request,
  extraHeaders: Record<string, string> = {}
): {
  headers: Record<string, string>;
  protocols?: string | string[];
} {
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  for (const header of UPSTREAM_HANDSHAKE_HEADERS) {
    headers.delete(header);
  }

  const offeredProtocols = headers.get("sec-websocket-protocol");
  headers.delete("sec-websocket-protocol");

  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }

  const sanitizedHeaders = Object.fromEntries(headers.entries());
  const protocols = offeredProtocols
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    headers: sanitizedHeaders,
    protocols: protocols && protocols.length > 0 ? protocols : undefined
  };
}

function isValidCloseCode(code: number | undefined): code is number {
  return code !== undefined && code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
}

export class UpstreamWebSocketProxyRuntime {
  private readonly bridges = new Map<string, UpstreamWebSocketBridge>();
  private readonly metrics: Metrics;
  private readonly socketFactory: UpstreamWebSocketFactory;

  constructor(private readonly deps: UpstreamWebSocketProxyDeps) {
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.socketFactory =
      deps.socketFactory ??
      ((url, options) =>
        new (WebSocket as unknown as {
          new (url: string | URL, options?: {
            headers?: Record<string, string>;
            protocols?: string | string[];
          }): UpstreamWebSocketClient;
        })(url, {
          headers: options?.headers,
          protocols: options?.protocols
        }));
  }

  async upgrade(
    request: Request,
    pipeline: PipelineConfig,
    auth: AuthContext,
    traceId: string | undefined,
    serverRef: UpgradeServerRef
  ): Promise<Response | undefined> {
    const upstreamUrl = toUpstreamWebSocketUrl(request, pipeline);
    const { headers, protocols } = sanitizeHeadersForUpstreamWebSocket(request, pipeline, auth, traceId);
    return await this.upgradeToTarget(
      request,
      {
        url: upstreamUrl,
        headers,
        protocols,
        connectTimeoutMs: pipeline.downstream.connectTimeoutMs
      },
      serverRef
    );
  }

  async upgradeToTarget(
    request: Request,
    target: {
      url: string;
      headers?: Record<string, string>;
      protocols?: string | string[];
      connectTimeoutMs: number;
    },
    serverRef: UpgradeServerRef
  ): Promise<Response | undefined> {
    const bridge = await this.openBridge(target);
    const upgraded = serverRef.upgrade(request, {
      headers: bridge.upstreamSocket.protocol
        ? {
            "sec-websocket-protocol": bridge.upstreamSocket.protocol
          }
        : undefined,
      data: {
        kind: "upstream_proxy",
        bridgeId: bridge.id
      }
    });

    if (upgraded) {
      this.metrics.increment("http.ws_proxy_open");
      return undefined;
    }

    this.closeBridge(bridge, 1011, "client websocket upgrade failed");
    return new Response("WebSocket upgrade failed", { status: 426 });
  }

  buildForwardTarget(
    request: Request,
    targetUrl: string,
    options: {
      connectTimeoutMs: number;
      extraHeaders?: Record<string, string>;
    }
  ): {
    url: string;
    headers?: Record<string, string>;
    protocols?: string | string[];
    connectTimeoutMs: number;
  } {
    const { headers, protocols } = sanitizeHeadersForForwardedWebSocket(
      request,
      options.extraHeaders
    );
    return {
      url: targetUrl,
      headers,
      protocols,
      connectTimeoutMs: options.connectTimeoutMs
    };
  }

  openClientSocket(socket: UpstreamProxyServerSocket): void {
    const bridge = this.bridges.get(socket.data.bridgeId);
    if (!bridge || bridge.closed) {
      socket.close(1011, "upstream websocket bridge unavailable");
      return;
    }

    bridge.clientSocket = socket;
    while (bridge.pendingUpstreamMessages.length > 0 && !bridge.closed) {
      const message = bridge.pendingUpstreamMessages.shift();
      if (!message) {
        break;
      }
      socket.send(message);
    }

    if (bridge.upstreamClosed) {
      socket.close(
        isValidCloseCode(bridge.upstreamClosed.code) ? bridge.upstreamClosed.code : 1011,
        bridge.upstreamClosed.reason
      );
      this.bridges.delete(bridge.id);
    }
  }

  clientMessage(socket: UpstreamProxyServerSocket, raw: string | ArrayBuffer | Uint8Array): void {
    const bridge = this.bridges.get(socket.data.bridgeId);
    if (!bridge || bridge.closed) {
      socket.close(1011, "upstream websocket bridge unavailable");
      return;
    }

    const message = normalizeSocketMessage(raw);
    bridge.upstreamSocket.send(message);
    this.metrics.increment("http.ws_proxy_message_in");
  }

  clientClose(socket: UpstreamProxyServerSocket, code?: number, reason?: string): void {
    const bridge = this.bridges.get(socket.data.bridgeId);
    if (!bridge || bridge.closed) {
      return;
    }

    bridge.clientSocket = undefined;
    this.closeBridge(bridge, code, reason);
  }

  dispose(): void {
    for (const bridge of this.bridges.values()) {
      this.closeBridge(bridge, 1001, "runtime disposed");
    }
    this.bridges.clear();
  }

  private async waitForUpstreamOpen(
    bridge: UpstreamWebSocketBridge,
    timeoutMs: number
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(createTimeoutError());
      }, timeoutMs);

      bridge.upstreamSocket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      });

      bridge.upstreamSocket.addEventListener("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(createUnavailableError("upstream websocket error"));
      });

      bridge.upstreamSocket.addEventListener("close", (event) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(createUnavailableError(`upstream websocket closed during connect: ${event.code ?? 1005} ${event.reason ?? ""}`.trim()));
      });
    });
  }

  private attachUpstreamListeners(bridge: UpstreamWebSocketBridge): void {
    bridge.upstreamSocket.addEventListener("message", (event) => {
      if (bridge.closed) {
        return;
      }

      const message = normalizeSocketMessage(event.data);
      if (bridge.clientSocket) {
        bridge.clientSocket.send(message);
      } else {
        bridge.pendingUpstreamMessages.push(message);
      }
      this.metrics.increment("http.ws_proxy_message_out");
    });

    bridge.upstreamSocket.addEventListener("close", (event) => {
      if (bridge.closed) {
        return;
      }

      bridge.upstreamClosed = {
        code: event.code,
        reason: event.reason
      };
      bridge.closed = true;
      this.metrics.increment("http.ws_proxy_close");
      if (bridge.clientSocket) {
        bridge.clientSocket.close(isValidCloseCode(event.code) ? event.code : 1011, event.reason);
      }
      this.bridges.delete(bridge.id);
    });

    bridge.upstreamSocket.addEventListener("error", () => {
      if (bridge.closed) {
        return;
      }

      this.metrics.increment("http.ws_proxy_error");
      this.deps.logger.error("upstream websocket bridge error", {
        bridgeId: bridge.id
      });
      this.closeBridge(bridge, 1011, "upstream websocket error");
    });
  }

  private closeBridge(bridge: UpstreamWebSocketBridge, code?: number, reason?: string): void {
    if (bridge.closed) {
      return;
    }

    bridge.closed = true;
    try {
      bridge.upstreamSocket.close(isValidCloseCode(code) ? code : undefined, reason);
    } catch {}
    if (bridge.clientSocket) {
      try {
        bridge.clientSocket.close(isValidCloseCode(code) ? code : 1011, reason);
      } catch {}
    }
    this.bridges.delete(bridge.id);
  }

  private async openBridge(target: {
    url: string;
    headers?: Record<string, string>;
    protocols?: string | string[];
    connectTimeoutMs: number;
  }): Promise<UpstreamWebSocketBridge> {
    const bridgeId = crypto.randomUUID();
    const upstreamSocket = this.socketFactory(target.url, {
      headers: target.headers,
      protocols: target.protocols
    });
    upstreamSocket.binaryType = "uint8array";

    const bridge: UpstreamWebSocketBridge = {
      id: bridgeId,
      upstreamSocket,
      pendingClientMessages: [],
      pendingUpstreamMessages: [],
      closed: false
    };
    this.bridges.set(bridgeId, bridge);
    this.attachUpstreamListeners(bridge);

    try {
      await this.waitForUpstreamOpen(bridge, target.connectTimeoutMs);
      return bridge;
    } catch (error) {
      this.bridges.delete(bridgeId);
      try {
        upstreamSocket.close(1011, "upstream connect failed");
      } catch {}
      throw error;
    }
  }
}

export function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
