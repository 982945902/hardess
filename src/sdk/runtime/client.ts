import type {
  AckMode,
  ClientDispatchOptions,
  ClientDispatchReceipt,
  ClientProtocolModule,
  ClientSystemHandlers,
  Envelope,
  SysAuthOkPayload,
  SysErrPayload,
  SysPongPayload,
  SysResultPayload
} from "../../shared/types.ts";
import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import { ClientProtocolRegistry } from "../protocol/registry.ts";
import { WebSocketTransport, type TransportOptions } from "../transport/ws.ts";

export interface HardessClientOptions {
  heartbeatIntervalMs?: number;
  transport?: TransportOptions;
  systemHandlers?: ClientSystemHandlers;
  timers?: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}

interface PendingDispatch {
  receipt: ClientDispatchReceipt;
  resultTimeoutMs: number;
  resolve: (receipt: ClientDispatchReceipt) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class HardessClient {
  private readonly registry = new ClientProtocolRegistry();
  private readonly transport: WebSocketTransport;
  private readonly heartbeatIntervalMs: number;
  private readonly systemHandlers: ClientSystemHandlers;
  private readonly timerApi: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly pendingDispatches = new Map<string, PendingDispatch>();

  constructor(
    private readonly websocketUrl: string,
    options: HardessClientOptions = {}
  ) {
    this.transport = new WebSocketTransport(options.transport);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.systemHandlers = options.systemHandlers ?? {};
    this.timerApi = options.timers ?? {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis)
    };
  }

  use(module: ClientProtocolModule<any, any>): void {
    this.registry.register(module);
  }

  replace(module: ClientProtocolModule<any, any>): void {
    this.registry.replace(module);
  }

  unuse(protocol: string, version: string): void {
    this.registry.unregister(protocol, version);
  }

  connect(token: string): void {
    this.transport.connect(this.websocketUrl, {
      onOpen: () => {
        this.sendAuth(token);
        this.startHeartbeat();
      },
      onClose: (info) => {
        this.stopHeartbeat();
        this.rejectAllPendingDispatches(
          createClientError(
            `WebSocket closed${info.reason ? `: ${info.reason}` : ""}`,
            {
              code: info.reason,
              detail: info
            }
          )
        );
        this.systemHandlers.onClose?.(info);
      },
      onMessage: (raw) => {
        const envelope = parseEnvelope(raw);
        if (!envelope) {
          this.systemHandlers.onTransportError?.({
            message: "Received invalid websocket envelope"
          });
          return;
        }

        if (envelope.kind === "system") {
          this.handleSystem(envelope);
          return;
        }

        void this.handleInbound(envelope).catch((error) => {
          this.systemHandlers.onTransportError?.({
            message: error instanceof Error ? error.message : String(error)
          });
        });
      },
      onError: (info) => {
        this.systemHandlers.onTransportError?.(info);
      }
    });
  }

  emit(input: {
    protocol: string;
    version: string;
    action: string;
    payload: unknown;
    streamId?: string;
    ack?: AckMode;
  }): string {
    const envelope = this.createOutboundEnvelope(input, input.ack ?? "none");
    this.transport.send(serializeEnvelope(envelope));
    return envelope.msgId;
  }

  emitAndWait(
    input: {
      protocol: string;
      version: string;
      action: string;
      payload: unknown;
      streamId?: string;
    },
    options: ClientDispatchOptions = {}
  ): Promise<ClientDispatchReceipt> {
    const ack = options.ack ?? "recv";
    const envelope = this.createOutboundEnvelope(input, ack);

    if (ack === "none") {
      this.transport.send(serializeEnvelope(envelope));
      return Promise.resolve({ msgId: envelope.msgId });
    }

    return new Promise<ClientDispatchReceipt>((resolve, reject) => {
      const pending: PendingDispatch = {
        receipt: {
          msgId: envelope.msgId
        },
        resultTimeoutMs: options.resultTimeoutMs ?? 5_000,
        resolve,
        reject
      };

      this.pendingDispatches.set(envelope.msgId, pending);
      this.armPendingDispatchTimer(
        envelope.msgId,
        pending,
        pending.resultTimeoutMs,
        "result"
      );

      try {
        this.transport.send(serializeEnvelope(envelope));
      } catch (error) {
        this.clearPendingDispatchTimer(pending);
        this.pendingDispatches.delete(envelope.msgId);
        reject(
          error instanceof Error
            ? error
            : new Error(String(error))
        );
      }
    });
  }

  private createOutboundEnvelope(input: {
    protocol: string;
    version: string;
    action: string;
    payload: unknown;
    streamId?: string;
  }, ack?: AckMode): Envelope<unknown> {
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

    return createEnvelope({
      kind: "biz",
      src: { peerId: "local", connId: "local" },
      protocol: input.protocol,
      version: input.version,
      action: input.action,
      streamId: streamRef.current,
      ack,
      payload: actionPayload ?? encoded
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.rejectAllPendingDispatches(
      createClientError("WebSocket client closed by caller")
    );
    this.transport.close();
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
      case "result":
        this.resolveResult(envelope.payload as SysResultPayload);
        this.systemHandlers.onResult?.(envelope.payload as SysResultPayload);
        return;
      case "err":
        this.rejectPendingDispatchFromSysErr(envelope.payload as SysErrPayload);
        this.systemHandlers.onError?.(envelope.payload as SysErrPayload);
        return;
      default:
        return;
    }
  }

  private resolveResult(payload: SysResultPayload): void {
    if (!payload.refMsgId) {
      return;
    }

    const pending = this.pendingDispatches.get(payload.refMsgId);
    if (!pending) {
      return;
    }

    this.clearPendingDispatchTimer(pending);
    this.pendingDispatches.delete(payload.refMsgId);
    pending.receipt.result = payload;
    pending.resolve({ ...pending.receipt });
  }

  private rejectPendingDispatchFromSysErr(payload: SysErrPayload): void {
    if (!payload.refMsgId) {
      return;
    }

    const pending = this.pendingDispatches.get(payload.refMsgId);
    if (!pending) {
      return;
    }

    this.clearPendingDispatchTimer(pending);
    this.pendingDispatches.delete(payload.refMsgId);
    pending.reject(
      createClientError(payload.message, {
        code: payload.code,
        refMsgId: payload.refMsgId,
        detail: payload.detail
      })
    );
  }

  private armPendingDispatchTimer(
    msgId: string,
    pending: PendingDispatch,
    timeoutMs: number,
    phase: "result"
  ): void {
    this.clearPendingDispatchTimer(pending);
    pending.timer = this.timerApi.setTimeout(() => {
      this.pendingDispatches.delete(msgId);
      pending.reject(
        createClientError(`Timed out waiting for ${phase}`, {
          code: "CLIENT_TIMEOUT",
          refMsgId: msgId,
          detail: {
            phase,
            timeoutMs
          }
        })
      );
    }, timeoutMs);
  }

  private clearPendingDispatchTimer(pending: PendingDispatch): void {
    if (!pending.timer) {
      return;
    }

    this.timerApi.clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private rejectAllPendingDispatches(error: Error): void {
    for (const [msgId, pending] of this.pendingDispatches.entries()) {
      this.clearPendingDispatchTimer(pending);
      this.pendingDispatches.delete(msgId);
      pending.reject(error);
    }
  }
}

function createClientError(
  message: string,
  extra: {
    code?: string;
    refMsgId?: string;
    detail?: unknown;
  } = {}
): Error {
  const error = new Error(message) as Error & {
    code?: string;
    refMsgId?: string;
    detail?: unknown;
  };

  error.code = extra.code;
  error.refMsgId = extra.refMsgId;
  error.detail = extra.detail;
  return error;
}
