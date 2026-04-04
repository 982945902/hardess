import type { ErrorCode, RouteFailureStage } from "./codes.ts";

export interface AuthContext {
  peerId: string;
  tokenId: string;
  capabilities: string[];
  expiresAt: number;
  revokedAt?: number;
}

export interface ConnRef {
  nodeId: string;
  connId: string;
  peerId: string;
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
  ack?: AckMode;
  seq?: number;
  ts: number;
  traceId?: string;
  payload: T;
}

export interface SysAuthPayload {
  provider: string;
  payload: unknown;
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

export interface SysErrPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: unknown;
  refMsgId?: string;
  traceId?: string;
}

export interface SysRouteFailure {
  peerId: string;
  nodeId?: string;
  connId?: string;
  stage: RouteFailureStage;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface SysResultPayload {
  refMsgId?: string;
  resolvedPeers: string[];
  deliveredConns: ConnRef[];
  failed: SysRouteFailure[];
  partialFailure: boolean;
}

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

export interface ClientSystemHandlers {
  onAuthOk?: (payload: SysAuthOkPayload) => void;
  onPong?: (payload: SysPongPayload) => void;
  onResult?: (payload: SysResultPayload) => void;
  onError?: (payload: SysErrPayload) => void;
  onClose?: (info: ClientCloseInfo) => void;
  onTransportError?: (info: ClientTransportErrorInfo) => void;
}

export interface ClientDispatchOptions {
  ack?: AckMode;
  resultTimeoutMs?: number;
}

export interface ClientDispatchReceipt {
  msgId: string;
  result?: SysResultPayload;
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

export interface ServerActionHooks<Payload = unknown> {
  validate?: (ctx: ServerHookContext<Payload>) => Promise<void> | void;
  authorize?: (ctx: ServerHookContext<Payload>) => Promise<void> | void;
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

export type AckMode = "none" | "recv";

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
  find(peerId: string): Promise<ConnRef[]>;
  findMany(peerIds: string[]): Promise<Map<string, ConnRef[]>>;
}

export interface HardessWorkerEnv {
  auth: AuthContext;
  pipeline: {
    id: string;
    matchPrefix: string;
    downstreamOrigin: string;
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

export interface PipelineConfig {
  id: string;
  matchPrefix: string;
  auth?: {
    required: boolean;
  };
  downstream: {
    origin: string;
    connectTimeoutMs: number;
    responseTimeoutMs: number;
    forwardAuthContext?: boolean;
    injectedHeaders?: Record<string, string>;
  };
  worker?: {
    entry: string;
    timeoutMs: number;
  };
}

export interface HardessConfig {
  pipelines: PipelineConfig[];
}
