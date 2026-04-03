import type {
  ClientProtocolModule,
  ClientSystemHandlers,
  Envelope,
  SysAuthOkPayload,
  SysErrPayload,
  SysHandleAckPayload,
  SysPongPayload,
  SysRecvAckPayload,
  SysRoutePayload
} from "../../shared/types.ts";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { ClientProtocolRegistry } from "../protocol/registry.ts";
import { WebSocketTransport, type TransportOptions } from "../transport/ws.ts";

export interface HardessClientOptions {
  autoHandleAck?: boolean;
  heartbeatIntervalMs?: number;
  transport?: TransportOptions;
  systemHandlers?: ClientSystemHandlers;
  timers?: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}

export class HardessClient {
  private readonly registry = new ClientProtocolRegistry();
  private readonly transport: WebSocketTransport;
  private readonly autoHandleAck: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly systemHandlers: ClientSystemHandlers;
  private readonly timerApi: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private token?: string;

  constructor(
    private readonly websocketUrl: string,
    options: HardessClientOptions = {}
  ) {
    this.transport = new WebSocketTransport(options.transport);
    this.autoHandleAck = options.autoHandleAck ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.systemHandlers = options.systemHandlers ?? {};
    this.timerApi = options.timers ?? {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis)
    };
  }

  use(module: ClientProtocolModule<unknown, unknown>): void {
    this.registry.register(module);
  }

  replace(module: ClientProtocolModule<unknown, unknown>): void {
    this.registry.replace(module);
  }

  unuse(protocol: string, version: string): void {
    this.registry.unregister(protocol, version);
  }

  connect(token: string): void {
    this.token = token;
    this.transport.connect(this.websocketUrl, {
      onOpen: () => {
        this.sendAuth(token);
        this.startHeartbeat();
      },
      onClose: () => {
        this.stopHeartbeat();
      },
      onMessage: (raw) => {
        const envelope = parseEnvelope(raw);
        if (!envelope) {
          return;
        }

        if (envelope.kind === "system") {
          this.handleSystem(envelope);
          return;
        }

        void this.handleInbound(envelope);
      }
    });
  }

  emit(input: {
    protocol: string;
    version: string;
    action: string;
    payload: unknown;
    streamId?: string;
  }): void {
    const module = this.registry.get(input.protocol, input.version);
    const encoded = module?.outbound?.encode
      ? module.outbound.encode(input.action, input.payload)
      : input.payload;

    const streamRef = { current: input.streamId };
    const actionPayload = module?.outbound?.actions?.[input.action]?.({
      protocol: input.protocol,
      version: input.version,
      action: input.action,
      payload: encoded,
      setStream(streamId) {
        streamRef.current = streamId;
      }
    });

    const envelope = createEnvelope({
      kind: "biz",
      src: { peerId: "local", connId: "local" },
      protocol: input.protocol,
      version: input.version,
      action: input.action,
      streamId: streamRef.current,
      payload: actionPayload ?? encoded
    });

    this.transport.send(serializeEnvelope(envelope));
  }

  close(): void {
    this.stopHeartbeat();
    this.transport.close();
  }

  ackHandled(msgId: string, traceId?: string): void {
    this.transport.send(
      serializeEnvelope(
        createEnvelope({
          kind: "system",
          src: { peerId: "local", connId: "local" },
          protocol: "sys",
          version: "1.0",
          action: "handleAck",
          traceId,
          payload: {
            ackFor: msgId
          }
        })
      )
    );
  }

  private async handleInbound(envelope: Envelope<unknown>): Promise<void> {
    const module = this.registry.get(envelope.protocol, envelope.version);
    if (!module?.inbound) {
      return;
    }

    const decoded = module.inbound.decode
      ? module.inbound.decode(envelope.action, envelope.payload)
      : envelope.payload;

    module.inbound.validate?.(envelope.action, decoded);
    await module.inbound.actions?.[envelope.action]?.({
      msgId: envelope.msgId,
      protocol: envelope.protocol,
      version: envelope.version,
      action: envelope.action,
      payload: decoded,
      src: envelope.src,
      traceId: envelope.traceId,
      ts: envelope.ts
    });

    if (this.autoHandleAck) {
      this.ackHandled(envelope.msgId, envelope.traceId);
    }
  }

  private sendAuth(token: string): void {
    const authEnvelope = createEnvelope({
      kind: "system",
      src: { peerId: "anonymous", connId: "pending" },
      protocol: "sys",
      version: "1.0",
      action: "auth",
      payload: {
        provider: "bearer",
        payload: token
      }
    });
    this.transport.send(serializeEnvelope(authEnvelope));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = this.timerApi.setInterval(() => {
      this.transport.send(
        serializeEnvelope(
          createEnvelope({
            kind: "system",
            src: { peerId: "local", connId: "local" },
            protocol: "sys",
            version: "1.0",
            action: "ping",
            payload: {
              nonce: crypto.randomUUID()
            }
          })
        )
      );
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      this.timerApi.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleSystem(envelope: Envelope<unknown>): void {
    switch (envelope.action) {
      case "auth.ok":
        this.systemHandlers.onAuthOk?.(envelope.payload as SysAuthOkPayload);
        return;
      case "pong":
        this.systemHandlers.onPong?.(envelope.payload as SysPongPayload);
        return;
      case "ping":
        this.transport.send(
          serializeEnvelope(
            createEnvelope({
              kind: "system",
              src: { peerId: "local", connId: "local" },
              protocol: "sys",
              version: "1.0",
              action: "pong",
              traceId: envelope.traceId,
              payload: envelope.payload
            })
          )
        );
        return;
      case "recvAck":
        this.systemHandlers.onRecvAck?.(envelope.payload as SysRecvAckPayload);
        return;
      case "handleAck":
        this.systemHandlers.onHandleAck?.(envelope.payload as SysHandleAckPayload);
        return;
      case "route":
        this.systemHandlers.onRoute?.(envelope.payload as SysRoutePayload);
        return;
      case "err":
        this.systemHandlers.onError?.(envelope.payload as SysErrPayload);
        return;
      default:
        return;
    }
  }
}
