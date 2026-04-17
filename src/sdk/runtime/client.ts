import { createEnvelope, parseEnvelope, serializeEnvelope } from "../../shared/envelope.ts";
import {
  CLIENT_ERROR_CODES,
  createClientSdkError,
  createRemoteSdkError,
  type ClientAwaitableDeliveryStage,
  type ClientDeliveryEvent,
  type ClientDeliveryTimeoutPolicy,
  type ClientSendTracker,
  parseSysAuthOkPayload,
  parseSysErrPayload,
  parseSysHandleAckEventPayload,
  parseSysPingPayload,
  parseSysPongPayload,
  parseSysRecvAckPayload,
  parseSysRoutePayload,
  type ClientProtocolErrorInfo,
  type ClientProtocolModule,
  type ClientSystemHandlers,
  type Envelope
} from "../../shared/index.ts";
import { ClientProtocolRegistry } from "../protocol/registry.ts";
import { WebSocketTransport, type TransportOptions } from "../transport/ws.ts";

type IntervalHandle = ReturnType<typeof globalThis.setInterval> | number;
type TimeoutHandle = ReturnType<typeof globalThis.setTimeout> | number;

interface ClientEmitInput {
  protocol: string;
  version: string;
  action: string;
  payload: unknown;
  streamId?: string;
  traceId?: string;
  deliveryTimeoutMs?: ClientDeliveryTimeoutPolicy;
}

export interface HardessClientOptions {
  autoHandleAck?: boolean;
  heartbeatIntervalMs?: number;
  deliveryTimeoutMs?: ClientDeliveryTimeoutPolicy;
  transport?: TransportOptions;
  systemHandlers?: ClientSystemHandlers;
  timers?: {
    setInterval: (handler: () => void, delay: number) => IntervalHandle;
    clearInterval: (timeout: IntervalHandle) => void;
    setTimeout?: (handler: () => void, delay: number) => TimeoutHandle;
    clearTimeout?: (timeout: TimeoutHandle) => void;
  };
}

export interface HardessClientConnectOptions {
  groupId?: string;
}

interface PendingStageWaiter {
  resolve(event: ClientDeliveryEvent): void;
  reject(error: Error): void;
}

interface PendingStageOutcome {
  event?: ClientDeliveryEvent;
  error?: Error;
}

interface PendingDelivery {
  msgId: string;
  traceId: string;
  protocol: string;
  version: string;
  action: string;
  createdAt: number;
  listeners: Set<(event: ClientDeliveryEvent) => void>;
  recvAckWaiters: PendingStageWaiter[];
  handleAckWaiters: PendingStageWaiter[];
  recvAckOutcome?: PendingStageOutcome;
  handleAckOutcome?: PendingStageOutcome;
  recvAckTimeoutMs?: number;
  handleAckTimeoutMs?: number;
  recvAckTimer?: TimeoutHandle;
  handleAckTimer?: TimeoutHandle;
  completed: boolean;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer?: TimeoutHandle;
}

type ClientReadyState = "idle" | "connecting" | "authenticating" | "ready" | "closed";

export class HardessClient {
  private readonly registry = new ClientProtocolRegistry();
  private readonly transport: WebSocketTransport;
  private readonly autoHandleAck: boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly deliveryTimeoutMs: Required<ClientDeliveryTimeoutPolicy>;
  private readonly systemHandlers: ClientSystemHandlers;
  private readonly timerApi: {
    setInterval: (handler: () => void, delay: number) => IntervalHandle;
    clearInterval: (timeout: IntervalHandle) => void;
    setTimeout: (handler: () => void, delay: number) => TimeoutHandle;
    clearTimeout: (timeout: TimeoutHandle) => void;
  };
  private heartbeatTimer?: IntervalHandle;
  private token?: string;
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readyState: ClientReadyState = "idle";
  private connectOptions?: HardessClientConnectOptions;

  constructor(
    private readonly websocketUrl: string,
    options: HardessClientOptions = {}
  ) {
    this.transport = new WebSocketTransport(options.transport);
    this.autoHandleAck = options.autoHandleAck ?? true;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.deliveryTimeoutMs = {
      recvAckMs: options.deliveryTimeoutMs?.recvAckMs ?? 5_000,
      handleAckMs: options.deliveryTimeoutMs?.handleAckMs ?? 15_000
    };
    this.systemHandlers = options.systemHandlers ?? {};
    this.timerApi = {
      setInterval: options.timers?.setInterval ?? globalThis.setInterval.bind(globalThis),
      clearInterval: options.timers?.clearInterval ?? globalThis.clearInterval.bind(globalThis),
      setTimeout: options.timers?.setTimeout ?? globalThis.setTimeout.bind(globalThis),
      clearTimeout: options.timers?.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
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

  connect(token: string, options: HardessClientConnectOptions = {}): void {
    this.token = token;
    this.connectOptions = options;
    this.readyState = "connecting";
    this.transport.connect(this.websocketUrl, {
      onOpen: () => {
        this.readyState = "authenticating";
        this.sendAuth(token, this.connectOptions);
        this.startHeartbeat();
      },
      onClose: (info) => {
        this.stopHeartbeat();
        this.readyState = this.token ? "connecting" : "closed";
        this.failPendingDeliveriesOnClose(info);
        if (isTerminalClientClose(info)) {
          this.rejectReadyWaiters(
            createClientSdkError(
              CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
              `Client failed to become ready${this.formatCloseSuffix(info)}`,
              {
                close: info
              }
            )
          );
        }
        this.systemHandlers.onClose?.(info);
      },
      onMessage: (raw) => {
        const envelope = parseEnvelope(raw);
        if (!envelope) {
          this.reportProtocolError({
            layer: "envelope",
            message: "Invalid websocket envelope"
          });
          return;
        }

        if (envelope.kind === "system") {
          try {
            this.handleSystem(envelope);
          } catch (error) {
            this.reportProtocolErrorFromEnvelope("system", envelope, error);
          }
          return;
        }

        void this.handleInbound(envelope).catch((error) => {
          this.reportProtocolErrorFromEnvelope("business", envelope, error);
        });
      },
      onError: (info) => {
        this.systemHandlers.onTransportError?.(info);
      }
    });
  }

  emit(input: ClientEmitInput): void {
    this.ensureReady();
    const { envelope, msgId, traceId } = this.createBusinessEnvelope(input);
    this.createPendingDelivery(msgId, traceId, input);
    this.transport.send(serializeEnvelope(envelope));
  }

  send(
    input: ClientEmitInput,
    options?: {
      until?: ClientAwaitableDeliveryStage;
    }
  ): Promise<ClientDeliveryEvent> {
    try {
      return this.emitTracked(input).waitForResult(options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  emitTracked(input: ClientEmitInput): ClientSendTracker {
    this.ensureReady();
    const { envelope, msgId, traceId } = this.createBusinessEnvelope(input);
    const pending = this.createPendingDelivery(msgId, traceId, input);
    this.transport.send(serializeEnvelope(envelope));
    return {
      msgId,
      traceId,
      onEvent: (listener) => {
        pending.listeners.add(listener);
        return () => {
          pending.listeners.delete(listener);
        };
      },
      waitForRecvAck: () => this.waitForPendingStage(pending, "recvAck"),
      waitForHandleAck: () => this.waitForPendingStage(pending, "handleAck"),
      waitForResult: (options) => this.waitForPendingResult(pending, options?.until ?? "handleAck")
    };
  }

  close(): void {
    this.stopHeartbeat();
    this.readyState = "closed";
    this.token = undefined;
    this.connectOptions = undefined;
    this.rejectReadyWaiters(
      createClientSdkError(CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED, "Client closed before becoming ready", {
        close: {
          reason: "client closed"
        }
      })
    );
    for (const pending of this.pendingDeliveries.values()) {
      this.clearPendingTimers(pending);
      const error = createClientSdkError(
        CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
        "Client closed before delivery completed",
        {
          close: {
            reason: "client closed"
          }
        }
      );
      this.markPendingStageFailure(pending, "recvAck", error);
      this.markPendingStageFailure(pending, "handleAck", error);
      this.rejectPendingWaiters(pending, error);
    }
    this.pendingDeliveries.clear();
    this.transport.close();
  }

  isReady(): boolean {
    return this.readyState === "ready";
  }

  waitUntilReady(options: {
    timeoutMs?: number;
  } = {}): Promise<void> {
    if (this.isReady()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve: () => {
          if (waiter.timer !== undefined) {
            this.timerApi.clearTimeout(waiter.timer);
          }
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          if (waiter.timer !== undefined) {
            this.timerApi.clearTimeout(waiter.timer);
          }
          this.readyWaiters.delete(waiter);
          reject(error);
        }
      };

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        waiter.timer = this.timerApi.setTimeout(() => {
          waiter.reject(
            createClientSdkError(
              CLIENT_ERROR_CODES.CLIENT_NOT_READY,
              `Timed out waiting for client readiness after ${options.timeoutMs}ms`,
              {
                retryable: true,
                detail: {
                  timeoutMs: options.timeoutMs
                }
              }
            )
          );
        }, options.timeoutMs);
      }

      this.readyWaiters.add(waiter);
    });
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

  private createBusinessEnvelope(input: ClientEmitInput): {
    envelope: Envelope<unknown>;
    msgId: string;
    traceId: string;
  } {
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

    const msgId = crypto.randomUUID();
    const traceId = input.traceId ?? msgId;
    const envelope = createEnvelope({
      msgId,
      kind: "biz",
      src: { peerId: "local", connId: "local" },
      protocol: input.protocol,
      version: input.version,
      action: input.action,
      streamId: streamRef.current,
      traceId,
      payload: actionPayload ?? encoded
    });

    return {
      envelope,
      msgId,
      traceId
    };
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

  private sendAuth(token: string, options?: HardessClientConnectOptions): void {
    const authEnvelope = createEnvelope({
      kind: "system",
      src: { peerId: "anonymous", connId: "pending" },
      protocol: "sys",
      version: "1.0",
      action: "auth",
      payload: {
        provider: "bearer",
        payload: token,
        groupId: options?.groupId
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
      case "auth.ok": {
        const payload = parseSysAuthOkPayload(envelope.payload);
        this.readyState = "ready";
        this.resolveReadyWaiters();
        this.systemHandlers.onAuthOk?.(payload);
        return;
      }
      case "pong": {
        const payload = parseSysPongPayload(envelope.payload);
        this.systemHandlers.onPong?.(payload);
        return;
      }
      case "ping":
        const pingPayload = parseSysPingPayload(envelope.payload);
        this.transport.send(
          serializeEnvelope(
            createEnvelope({
              kind: "system",
              src: { peerId: "local", connId: "local" },
              protocol: "sys",
              version: "1.0",
              action: "pong",
              traceId: envelope.traceId,
              payload: pingPayload
            })
          )
        );
        return;
      case "recvAck": {
        const payload = parseSysRecvAckPayload(envelope.payload);
        this.systemHandlers.onRecvAck?.(payload);
        this.emitDeliveryEvent({
          stage: "recvAck",
          msgId: payload.ackFor,
          traceId: envelope.traceId,
          recvAck: payload
        });
        return;
      }
      case "handleAck": {
        const payload = parseSysHandleAckEventPayload(envelope.payload);
        this.systemHandlers.onHandleAck?.(payload);
        this.emitDeliveryEvent({
          stage: "handleAck",
          msgId: payload.ackFor,
          traceId: envelope.traceId,
          handleAck: payload
        });
        return;
      }
      case "route": {
        const payload = parseSysRoutePayload(envelope.payload);
        this.systemHandlers.onRoute?.(payload);
        if (envelope.traceId) {
          this.emitDeliveryEvent({
            stage: "route",
            msgId: envelope.traceId,
            traceId: envelope.traceId,
            route: payload
          });
        }
        return;
      }
      case "err": {
        const payload = parseSysErrPayload(envelope.payload);
        this.systemHandlers.onError?.(payload);
        const msgId = payload.refMsgId ?? envelope.traceId;
        if (msgId) {
          this.emitDeliveryEvent({
            stage: "error",
            msgId,
            traceId: envelope.traceId,
            error: payload,
            sdkError: createRemoteSdkError(payload)
          });
        }
        return;
      }
      default:
        throw new Error(`Unknown system action: ${envelope.action}`);
    }
  }

  private reportProtocolErrorFromEnvelope(
    layer: ClientProtocolErrorInfo["layer"],
    envelope: Envelope<unknown>,
    error: unknown
  ): void {
    const info = {
      layer,
      message: error instanceof Error ? error.message : String(error),
      protocol: envelope.protocol,
      version: envelope.version,
      action: envelope.action,
      msgId: envelope.msgId,
      traceId: envelope.traceId
    } satisfies ClientProtocolErrorInfo;
    this.reportProtocolError(info);

    const associatedMsgId = this.associateDeliveryMsgId(envelope, info);
    if (associatedMsgId) {
      this.emitDeliveryEvent({
        stage: "protocolError",
        msgId: associatedMsgId,
        traceId: envelope.traceId,
        protocol: envelope.protocol,
        version: envelope.version,
        action: envelope.action,
        protocolError: info
      });
    }
  }

  private reportProtocolError(info: ClientProtocolErrorInfo): void {
    this.systemHandlers.onProtocolError?.(info);
  }

  private createPendingDelivery(
    msgId: string,
    traceId: string,
    input: ClientEmitInput
  ): PendingDelivery {
    const pending: PendingDelivery = {
      msgId,
      traceId,
      protocol: input.protocol,
      version: input.version,
      action: input.action,
      createdAt: Date.now(),
      listeners: new Set(),
      recvAckWaiters: [],
      handleAckWaiters: [],
      recvAckTimeoutMs: input.deliveryTimeoutMs?.recvAckMs ?? this.deliveryTimeoutMs.recvAckMs,
      handleAckTimeoutMs: input.deliveryTimeoutMs?.handleAckMs ?? this.deliveryTimeoutMs.handleAckMs,
      completed: false
    };
    this.pendingDeliveries.set(msgId, pending);
    this.schedulePendingTimeout(pending, "recvAck");
    this.schedulePendingTimeout(pending, "handleAck");
    return pending;
  }

  private waitForPendingStage(
    pending: PendingDelivery,
    stage: ClientAwaitableDeliveryStage
  ): Promise<ClientDeliveryEvent> {
    const outcome = stage === "recvAck" ? pending.recvAckOutcome : pending.handleAckOutcome;
    if (outcome?.event) {
      return Promise.resolve(outcome.event);
    }
    if (outcome?.error) {
      return Promise.reject(outcome.error);
    }

    return new Promise<ClientDeliveryEvent>((resolve, reject) => {
      const queue = stage === "recvAck" ? pending.recvAckWaiters : pending.handleAckWaiters;
      queue.push({ resolve, reject });
    });
  }

  private waitForPendingResult(
    pending: PendingDelivery,
    until: ClientAwaitableDeliveryStage
  ): Promise<ClientDeliveryEvent> {
    const settled = this.pendingResultSettlement(pending, until);
    if (settled.event) {
      return Promise.resolve(settled.event);
    }
    if (settled.error) {
      return Promise.reject(settled.error);
    }

    return new Promise<ClientDeliveryEvent>((resolve, reject) => {
      const listener = (event: ClientDeliveryEvent) => {
        if (this.isResultSuccessEvent(event, until)) {
          pending.listeners.delete(listener);
          resolve(event);
          return;
        }

        if (this.isResultFailureEvent(event, until)) {
          pending.listeners.delete(listener);
          reject(this.deliveryFailureError(event));
        }
      };

      pending.listeners.add(listener);

      const rechecked = this.pendingResultSettlement(pending, until);
      if (rechecked.event) {
        pending.listeners.delete(listener);
        resolve(rechecked.event);
        return;
      }
      if (rechecked.error) {
        pending.listeners.delete(listener);
        reject(rechecked.error);
      }
    });
  }

  private emitDeliveryEvent(event: ClientDeliveryEvent): void {
    const pending = this.pendingDeliveries.get(event.msgId);
    const normalizedEvent = this.decorateDeliveryEvent(event, pending);
    this.systemHandlers.onDeliveryEvent?.(normalizedEvent);
    if (!pending) {
      return;
    }

    for (const listener of pending.listeners) {
      listener(normalizedEvent);
    }

    switch (normalizedEvent.stage) {
      case "recvAck":
        this.clearPendingTimeout(pending, "recvAck");
        pending.recvAckOutcome = {
          event: normalizedEvent
        };
        this.resolvePendingWaiters(pending.recvAckWaiters, normalizedEvent);
        return;
      case "recvAckTimeout": {
        const error = this.deliveryFailureError(normalizedEvent);
        pending.recvAckOutcome = {
          error
        };
        this.clearPendingTimeout(pending, "recvAck");
        this.rejectWaiters(pending.recvAckWaiters, error);
        return;
      }
      case "handleAck":
        this.clearPendingTimers(pending);
        pending.handleAckOutcome = {
          event: normalizedEvent
        };
        this.resolvePendingWaiters(pending.handleAckWaiters, normalizedEvent);
        this.pendingDeliveries.delete(normalizedEvent.msgId);
        pending.completed = true;
        return;
      case "handleAckTimeout":
      case "transportClosed":
      case "error":
      case "protocolError": {
        const error = this.deliveryFailureError(normalizedEvent);
        this.clearPendingTimers(pending);
        this.markPendingStageFailure(pending, "recvAck", error);
        this.markPendingStageFailure(pending, "handleAck", error);
        this.rejectPendingWaiters(pending, error);
        this.pendingDeliveries.delete(normalizedEvent.msgId);
        pending.completed = true;
        return;
      }
      default:
        return;
    }
  }

  private resolvePendingWaiters(waiters: PendingStageWaiter[], event: ClientDeliveryEvent): void {
    while (waiters.length > 0) {
      waiters.shift()?.resolve(event);
    }
  }

  private rejectWaiters(waiters: PendingStageWaiter[], error: Error): void {
    while (waiters.length > 0) {
      waiters.shift()?.reject(error);
    }
  }

  private rejectPendingWaiters(pending: PendingDelivery, error: Error): void {
    for (const queue of [pending.recvAckWaiters, pending.handleAckWaiters]) {
      this.rejectWaiters(queue, error);
    }
  }

  private deliveryFailureError(event: ClientDeliveryEvent): Error {
    switch (event.stage) {
      case "recvAckTimeout":
      case "handleAckTimeout":
        return createClientSdkError(
          CLIENT_ERROR_CODES.CLIENT_DELIVERY_TIMEOUT,
          `Timed out waiting for ${event.timeout?.stage ?? "delivery"} after ${event.timeout?.timeoutMs ?? 0}ms`,
          {
            retryable: true,
            traceId: event.traceId,
            refMsgId: event.msgId,
            detail: event.timeout
          }
        );
      case "transportClosed":
        return event.sdkError instanceof Error
          ? event.sdkError
          : createClientSdkError(
              CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
              `Transport closed before delivery completed${this.formatCloseSuffix(event.close)}`,
              {
                retryable: true,
                traceId: event.traceId,
                refMsgId: event.msgId,
                close: event.close
              }
            );
      case "error":
        return event.sdkError instanceof Error
          ? event.sdkError
          : createClientSdkError(
              CLIENT_ERROR_CODES.CLIENT_PROTOCOL_ERROR,
              event.error?.message ?? "Delivery failed",
              {
                traceId: event.traceId,
                refMsgId: event.msgId,
                detail: event.error
              }
            );
      case "protocolError":
        return createClientSdkError(
          CLIENT_ERROR_CODES.CLIENT_PROTOCOL_ERROR,
          event.protocolError?.message ?? "Protocol error",
          {
            traceId: event.traceId,
            refMsgId: event.msgId,
            detail: event.protocolError
          }
        );
      default:
        return createClientSdkError(
          CLIENT_ERROR_CODES.CLIENT_PROTOCOL_ERROR,
          `Unexpected delivery failure stage: ${event.stage}`,
          {
            traceId: event.traceId,
            refMsgId: event.msgId,
            detail: {
              stage: event.stage
            }
          }
        );
    }
  }

  private failPendingDeliveriesOnClose(info: { code?: number; reason?: string; wasClean?: boolean }): void {
    for (const pending of this.pendingDeliveries.values()) {
      this.emitDeliveryEvent({
        stage: "transportClosed",
        msgId: pending.msgId,
        traceId: pending.traceId,
        close: {
          code: info.code,
          reason: info.reason,
          wasClean: info.wasClean
        },
        sdkError: createClientSdkError(
          CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED,
          `Transport closed before delivery completed${this.formatCloseSuffix(info)}`,
          {
            retryable: true,
            traceId: pending.traceId,
            refMsgId: pending.msgId,
            close: {
              code: info.code,
              reason: info.reason,
              wasClean: info.wasClean
            }
          }
        )
      });
    }
  }

  private associateDeliveryMsgId(
    envelope: Envelope<unknown>,
    info: ClientProtocolErrorInfo
  ): string | undefined {
    if (this.pendingDeliveries.has(envelope.msgId)) {
      return envelope.msgId;
    }
    if (envelope.traceId && this.pendingDeliveries.has(envelope.traceId)) {
      return envelope.traceId;
    }
    if (info.msgId && this.pendingDeliveries.has(info.msgId)) {
      return info.msgId;
    }
    return undefined;
  }

  private decorateDeliveryEvent(
    event: ClientDeliveryEvent,
    pending?: PendingDelivery
  ): ClientDeliveryEvent {
    if (!pending) {
      return event;
    }

    return {
      ...event,
      traceId: event.traceId ?? pending.traceId,
      protocol: pending.protocol,
      version: pending.version,
      action: pending.action
    };
  }

  private schedulePendingTimeout(
    pending: PendingDelivery,
    stage: ClientAwaitableDeliveryStage
  ): void {
    const timeoutMs = stage === "recvAck" ? pending.recvAckTimeoutMs : pending.handleAckTimeoutMs;
    if (!timeoutMs) {
      return;
    }

    const timer = this.timerApi.setTimeout(() => {
      this.handlePendingTimeout(pending, stage, timeoutMs);
    }, timeoutMs);

    if (stage === "recvAck") {
      pending.recvAckTimer = timer;
      return;
    }
    pending.handleAckTimer = timer;
  }

  private handlePendingTimeout(
    pending: PendingDelivery,
    stage: ClientAwaitableDeliveryStage,
    timeoutMs: number
  ): void {
    const outcome = stage === "recvAck" ? pending.recvAckOutcome : pending.handleAckOutcome;
    if (outcome?.event || outcome?.error || pending.completed) {
      return;
    }

    this.emitDeliveryEvent({
      stage: stage === "recvAck" ? "recvAckTimeout" : "handleAckTimeout",
      msgId: pending.msgId,
      traceId: pending.traceId,
      timeout: {
        stage,
        timeoutMs,
        startedAt: pending.createdAt,
        timedOutAt: Date.now()
      }
    });
  }

  private clearPendingTimeout(
    pending: PendingDelivery,
    stage: ClientAwaitableDeliveryStage
  ): void {
    if (stage === "recvAck") {
      if (pending.recvAckTimer !== undefined) {
        this.timerApi.clearTimeout(pending.recvAckTimer);
        pending.recvAckTimer = undefined;
      }
      return;
    }

    if (pending.handleAckTimer !== undefined) {
      this.timerApi.clearTimeout(pending.handleAckTimer);
      pending.handleAckTimer = undefined;
    }
  }

  private clearPendingTimers(pending: PendingDelivery): void {
    this.clearPendingTimeout(pending, "recvAck");
    this.clearPendingTimeout(pending, "handleAck");
  }

  private markPendingStageFailure(
    pending: PendingDelivery,
    stage: ClientAwaitableDeliveryStage,
    error: Error
  ): void {
    const outcome = stage === "recvAck" ? pending.recvAckOutcome : pending.handleAckOutcome;
    if (outcome?.event || outcome?.error) {
      return;
    }

    if (stage === "recvAck") {
      pending.recvAckOutcome = {
        error
      };
      return;
    }

    pending.handleAckOutcome = {
      error
    };
  }

  private pendingResultSettlement(
    pending: PendingDelivery,
    until: ClientAwaitableDeliveryStage
  ): PendingStageOutcome {
    if (until === "recvAck") {
      return pending.recvAckOutcome ?? {};
    }

    if (pending.recvAckOutcome?.error) {
      return {
        error: pending.recvAckOutcome.error
      };
    }

    return pending.handleAckOutcome ?? {};
  }

  private isResultSuccessEvent(
    event: ClientDeliveryEvent,
    until: ClientAwaitableDeliveryStage
  ): boolean {
    return event.stage === until;
  }

  private isResultFailureEvent(
    event: ClientDeliveryEvent,
    until: ClientAwaitableDeliveryStage
  ): boolean {
    switch (event.stage) {
      case "error":
      case "protocolError":
      case "transportClosed":
      case "handleAckTimeout":
        return true;
      case "recvAckTimeout":
        return until === "recvAck" || until === "handleAck";
      default:
        return false;
    }
  }

  private ensureReady(): void {
    if (this.readyState === "ready") {
      return;
    }

    throw createClientSdkError(
      CLIENT_ERROR_CODES.CLIENT_NOT_READY,
      `Client is not ready; wait for auth.ok before sending (state: ${this.readyState})`,
      {
        retryable: true,
        detail: {
          state: this.readyState
        }
      }
    );
  }

  private resolveReadyWaiters(): void {
    for (const waiter of Array.from(this.readyWaiters)) {
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of Array.from(this.readyWaiters)) {
      waiter.reject(error);
    }
  }

  private formatCloseSuffix(info?: { code?: number; reason?: string }): string {
    return (info?.code !== undefined ? ` (code ${info.code}` : "") +
      (info?.reason ? `${info.code !== undefined ? ", " : " ("}reason ${info.reason}` : "") +
      (info?.code !== undefined || info?.reason ? ")" : "");
  }
}

function isTerminalClientClose(info: { code?: number }): boolean {
  switch (info.code) {
    case 4400:
    case 4401:
    case 4403:
    case 4429:
    case 4508:
      return true;
    default:
      return false;
  }
}
