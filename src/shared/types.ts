import type { ErrorCode, SdkErrorCode } from "./codes.ts";

export interface AuthContext {
  peerId: string;
  tokenId: string;
  capabilities: string[];
  expiresAt: number;
  revokedAt?: number;
  groupId?: string;
}

export interface ConnRef {
  nodeId: string;
  connId: string;
  peerId: string;
  groupId?: string;
}

export interface Envelope<T = unknown> {
  msgId: string;
  kind: "system" | "biz";
  src: {
    peerId: string;
    connId: string;
  };
  protocol: string;
  version: string;
  action: string;
  streamId?: string;
  seq?: number;
  ts: number;
  traceId?: string;
  payload: T;
}

export interface SysAuthPayload {
  provider: string;
  payload: unknown;
  groupId?: string;
}

export interface SysAuthOkPayload {
  peerId: string;
  capabilities: string[];
  expiresAt: number;
}

export interface SysPingPayload {
  nonce?: string;
}

export interface SysPongPayload {
  nonce?: string;
}

export interface SysRecvAckPayload {
  ackFor: string;
  acceptedAt: number;
}

export interface SysHandleAckPayload {
  ackFor: string;
  handledAt: number;
}

export interface SysErrPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: unknown;
  refMsgId?: string;
  traceId?: string;
}

export interface SysRoutePayload {
  resolvedPeers: string[];
  deliveredConns: ConnRef[];
}

// Reserved for a future runtime-level control event channel.
// Current business notifications should use injected business protocols instead.
export interface SysPushPayload<T = unknown> {
  topic: string;
  payload: T;
}

export interface PlatformErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    traceId?: string;
    refMsgId?: string;
    detail?: unknown;
  };
}

export interface ClientCloseInfo {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface ClientTransportErrorInfo {
  message?: string;
}

export interface HardessSdkErrorShape {
  code: SdkErrorCode;
  source: "client" | "remote";
  retryable: boolean;
  message: string;
  traceId?: string;
  refMsgId?: string;
  detail?: unknown;
  close?: ClientCloseInfo;
}

export interface ClientProtocolErrorInfo {
  layer: "envelope" | "system" | "business";
  message: string;
  protocol?: string;
  version?: string;
  action?: string;
  msgId?: string;
  traceId?: string;
}

export type ClientAwaitableDeliveryStage = "recvAck" | "handleAck";

export type ClientDeliveryStage =
  | "route"
  | "recvAck"
  | "handleAck"
  | "recvAckTimeout"
  | "handleAckTimeout"
  | "transportClosed"
  | "error"
  | "protocolError";

export interface ClientDeliveryTimeoutInfo {
  stage: ClientAwaitableDeliveryStage;
  timeoutMs: number;
  startedAt: number;
  timedOutAt: number;
}

export interface ClientDeliveryTimeoutPolicy {
  recvAckMs?: number;
  handleAckMs?: number;
}

export interface ClientDeliveryEvent {
  stage: ClientDeliveryStage;
  msgId: string;
  traceId?: string;
  protocol?: string;
  version?: string;
  action?: string;
  close?: ClientCloseInfo;
  sdkError?: HardessSdkErrorShape;
  route?: SysRoutePayload;
  recvAck?: SysRecvAckPayload;
  handleAck?: SysHandleAckPayload;
  error?: SysErrPayload;
  protocolError?: ClientProtocolErrorInfo;
  timeout?: ClientDeliveryTimeoutInfo;
}

export interface ClientSendTracker {
  msgId: string;
  traceId: string;
  onEvent(listener: (event: ClientDeliveryEvent) => void): () => void;
  waitForRecvAck(): Promise<ClientDeliveryEvent>;
  waitForHandleAck(): Promise<ClientDeliveryEvent>;
  waitForResult(options?: {
    until?: ClientAwaitableDeliveryStage;
  }): Promise<ClientDeliveryEvent>;
}

export interface ClientSystemHandlers {
  onAuthOk?: (payload: SysAuthOkPayload) => void;
  onPong?: (payload: SysPongPayload) => void;
  onRecvAck?: (payload: SysRecvAckPayload) => void;
  onHandleAck?: (payload: SysHandleAckPayload) => void;
  onRoute?: (payload: SysRoutePayload) => void;
  onError?: (payload: SysErrPayload) => void;
  onDeliveryEvent?: (event: ClientDeliveryEvent) => void;
  onProtocolError?: (info: ClientProtocolErrorInfo) => void;
  onClose?: (info: ClientCloseInfo) => void;
  onTransportError?: (info: ClientTransportErrorInfo) => void;
}

export interface OutboundContext<Payload = unknown> {
  protocol: string;
  version: string;
  action: string;
  payload: Payload;
  auth?: Pick<AuthContext, "peerId" | "capabilities" | "expiresAt">;
  traceId?: string;
  setStream(streamId: string): void;
}

export interface InboundContext<Payload = unknown> {
  msgId: string;
  protocol: string;
  version: string;
  action: string;
  payload: Payload;
  src: {
    peerId: string;
    connId: string;
  };
  traceId?: string;
  ts: number;
}

export interface ClientProtocolModule<Out = unknown, In = unknown> {
  protocol: string;
  version: string;
  outbound?: {
    encode?: (action: string, payload: Out) => unknown;
    actions?: Record<string, (ctx: OutboundContext<Out>) => unknown>;
  };
  inbound?: {
    decode?: (action: string, payload: unknown) => In;
    validate?: (action: string, payload: In) => void;
    actions?: Record<string, (ctx: InboundContext<In>) => Promise<void> | void>;
  };
}

export interface ServerHookContext<Payload = unknown> {
  protocol: string;
  version: string;
  action: string;
  payload: Payload;
  auth: AuthContext;
  traceId?: string;
  ts: number;
}

export interface ServerLocalHandleResult {
  ack?: AckMode;
}

export interface ServerActionHooks<Payload = unknown> {
  validate?: (ctx: ServerHookContext<Payload>) => Promise<void> | void;
  authorize?: (ctx: ServerHookContext<Payload>) => Promise<void> | void;
  handleLocally?: (
    ctx: ServerHookContext<Payload>
  ) => Promise<ServerLocalHandleResult | void> | ServerLocalHandleResult | void;
  resolveRecipients?: (ctx: ServerHookContext<Payload>) => Promise<string[]> | string[];
  buildDispatch?: (
    ctx: ServerHookContext<Payload>
  ) => Promise<ServerDispatch | void> | ServerDispatch | void;
}

export interface ServerProtocolModule<Payload = unknown> {
  protocol: string;
  version: string;
  actions: Record<string, ServerActionHooks<Payload>>;
}

export type HardessServiceModule<Payload = unknown> = ServerProtocolModule<Payload>;

export type AckMode = "none" | "recv" | "handle";

export interface ServerDispatch {
  protocol?: string;
  version?: string;
  action?: string;
  payload?: unknown;
  streamId?: string;
  ack?: AckMode;
}

export interface DeliveryPlan {
  targets: ConnRef[];
  streamId?: string;
  ack: AckMode;
}

export interface PeerLocator {
  find(peerId: string, options?: { groupId?: string }): Promise<ConnRef[]>;
  findMany(peerIds: string[], options?: { groupId?: string }): Promise<Map<string, ConnRef[]>>;
  invalidate?(peerId?: string): void;
}

export interface HardessWorkerEnv {
  auth: AuthContext;
  pipeline: {
    id: string;
    matchPrefix: string;
    downstreamOrigin: string;
    groupId?: string;
  };
  deployment?: {
    config?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
    secrets?: Record<string, string>;
  };
  traceId?: string;
}

export interface HardessExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface HardessWorkerResult {
  request?: Request;
  response?: Response;
}

export interface HardessWorkerModule {
  fetch(
    request: Request,
    env: HardessWorkerEnv,
    ctx: HardessExecutionContext
  ): Promise<Response | HardessWorkerResult | void> | Response | HardessWorkerResult | void;
}

export type HardessServeMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "ALL";

export interface HardessServeContext extends HardessExecutionContext {
  params: Record<string, string>;
  path: string;
  originalPath: string;
}

export type HardessServeHandlerResult = Response | HardessWorkerResult | void;

export type HardessServeHandler = (
  request: Request,
  env: HardessWorkerEnv,
  ctx: HardessServeContext
) =>
  | Promise<HardessServeHandlerResult>
  | HardessServeHandlerResult;

export type HardessServeRouteHandlerTarget = HardessServeHandler | string;

export type HardessServeNext = () => Promise<HardessServeHandlerResult>;

export type HardessServeMiddleware = (
  request: Request,
  env: HardessWorkerEnv,
  ctx: HardessServeContext,
  next: HardessServeNext
) =>
  | Promise<HardessServeHandlerResult>
  | HardessServeHandlerResult;

export interface HardessServeRouteDefinition {
  method: HardessServeMethod;
  path: string;
  handler: HardessServeRouteHandlerTarget;
}

export interface HardessServeMiddlewareDefinition {
  pathPrefix?: string;
  handler: HardessServeMiddleware;
}

export interface HardessServeDeploymentContext {
  config: Record<string, unknown>;
  bindings: Record<string, unknown>;
  secrets: Record<string, string>;
  pipeline: HardessWorkerEnv["pipeline"];
}

export interface HardessServeDeploymentInstance {
  [key: string]: unknown;
}

export type HardessServeDeploymentClass = new (
  ctx: HardessServeDeploymentContext
) => HardessServeDeploymentInstance;

export interface HardessServeModule {
  kind: "serve";
  routes: HardessServeRouteDefinition[];
  middleware?: HardessServeMiddlewareDefinition[];
  deployment?: HardessServeDeploymentClass;
}

export interface PipelineConfig {
  id: string;
  matchPrefix: string;
  groupId?: string;
  auth?: {
    required: boolean;
  };
  downstream: {
    origin: string;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
    websocket?: boolean;
    forwardAuthContext?: boolean;
    injectedHeaders?: Record<string, string>;
  };
  worker?: {
    entry: string;
    timeoutMs: number;
    deployment?: {
      config?: Record<string, unknown>;
      bindings?: Record<string, unknown>;
      secrets?: Record<string, string>;
    };
  };
}

export interface HardessConfig {
  pipelines: PipelineConfig[];
}
