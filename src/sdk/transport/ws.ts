export interface WebSocketLikeEvent {
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  message?: string;
}

export interface WebSocketLike {
  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (event?: WebSocketLikeEvent) => void
  ): void;
  send(message: string): void;
  close(): void;
}

export interface TransportCloseInfo {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface TransportErrorInfo {
  message?: string;
}

export interface TransportHooks {
  onOpen?: () => void;
  onClose?: (info: TransportCloseInfo) => void;
  onMessage?: (message: string) => void;
  onError?: (info: TransportErrorInfo) => void;
}

export interface TransportOptions {
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  webSocketFactory?: (url: string) => WebSocketLike;
  setTimeoutFn?: (handler: () => void, delay: number) => TimeoutHandle;
  clearTimeoutFn?: (timeout: TimeoutHandle) => void;
  shouldReconnectOnClose?: (info: TransportCloseInfo) => boolean;
}

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

export class WebSocketTransport {
  private socket?: WebSocketLike;
  private hooks: TransportHooks = {};
  private url?: string;
  private reconnectDelayMs: number;
  private reconnectTimer?: TimeoutHandle;
  private manuallyClosed = false;

  private readonly reconnectEnabled: boolean;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly setTimeoutFn: (handler: () => void, delay: number) => TimeoutHandle;
  private readonly clearTimeoutFn: (timeout: TimeoutHandle) => void;
  private readonly shouldReconnectOnClose: (info: TransportCloseInfo) => boolean;

  constructor(options: TransportOptions = {}) {
    this.reconnectEnabled = options.reconnect?.enabled ?? true;
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? 500;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? 10_000;
    this.reconnectDelayMs = this.initialDelayMs;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timeout: TimeoutHandle) => {
      clearTimeout(timeout as ReturnType<typeof setTimeout>);
    });
    this.shouldReconnectOnClose = options.shouldReconnectOnClose ?? defaultShouldReconnectOnClose;
  }

  connect(url: string, hooks: TransportHooks = {}): void {
    const previousSocket = this.socket;
    this.socket = undefined;
    previousSocket?.close();
    this.url = url;
    this.hooks = hooks;
    this.manuallyClosed = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  send(message: string): void {
    this.socket?.send(message);
  }

  close(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = undefined;
  }

  private openSocket(): void {
    if (!this.url) {
      return;
    }

    const socket = this.webSocketFactory(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }
      this.reconnectDelayMs = this.initialDelayMs;
      this.hooks.onOpen?.();
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = undefined;
      const info = {
        code: event?.code,
        reason: event?.reason,
        wasClean: event?.wasClean
      };
      this.hooks.onClose?.(info);
      if (!this.manuallyClosed && this.reconnectEnabled && this.shouldReconnectOnClose(info)) {
        this.scheduleReconnect();
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.hooks.onMessage?.(typeof event?.data === "string" ? event.data : String(event?.data ?? ""));
    });
    socket.addEventListener("error", (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.hooks.onError?.({
        message: event?.message
      });
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      if (this.manuallyClosed || this.socket || !this.url) {
        return;
      }
      this.openSocket();
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxDelayMs);
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

function defaultShouldReconnectOnClose(info: TransportCloseInfo): boolean {
  switch (info.code) {
    case 4400:
    case 4401:
    case 4403:
    case 4429:
    case 4508:
      return false;
    default:
      return true;
  }
}
