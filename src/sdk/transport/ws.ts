export interface WebSocketLike {
  addEventListener(
    type: "open" | "close" | "message" | "error",
    listener: (event?: { data?: unknown }) => void
  ): void;
  send(message: string): void;
  close(): void;
}

export interface TransportHooks {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (message: string) => void;
  onError?: () => void;
}

export interface TransportOptions {
  reconnect?: {
    enabled?: boolean;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  webSocketFactory?: (url: string) => WebSocketLike;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class WebSocketTransport {
  private socket?: WebSocketLike;
  private hooks: TransportHooks = {};
  private url?: string;
  private reconnectDelayMs: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private manuallyClosed = false;

  private readonly reconnectEnabled: boolean;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(options: TransportOptions = {}) {
    this.reconnectEnabled = options.reconnect?.enabled ?? true;
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? 500;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? 10_000;
    this.reconnectDelayMs = this.initialDelayMs;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  connect(url: string, hooks: TransportHooks = {}): void {
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
  }

  private openSocket(): void {
    if (!this.url) {
      return;
    }

    this.socket = this.webSocketFactory(this.url);
    this.socket.addEventListener("open", () => {
      this.reconnectDelayMs = this.initialDelayMs;
      this.hooks.onOpen?.();
    });
    this.socket.addEventListener("close", () => {
      this.hooks.onClose?.();
      if (!this.manuallyClosed && this.reconnectEnabled) {
        this.scheduleReconnect();
      }
    });
    this.socket.addEventListener("message", (event) => {
      this.hooks.onMessage?.(typeof event?.data === "string" ? event.data : String(event?.data ?? ""));
    });
    this.socket.addEventListener("error", () => {
      this.hooks.onError?.();
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = this.setTimeoutFn(() => {
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
