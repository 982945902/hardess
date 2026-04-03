import type { ErrorCode } from "./codes.ts";

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

export interface ClientSystemHandlers {
  onAuthOk?: (payload: SysAuthOkPayload) => void;
  onPong?: (payload: SysPongPayload) => void;
  onRecvAck?: (payload: SysRecvAckPayload) => void;
  onHandleAck?: (payload: SysHandleAckPayload) => void;
  onRoute?: (payload: SysRoutePayload) => void;
  onError?: (payload: SysErrPayload) => void;
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
