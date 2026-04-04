import {
  ERROR_CODES,
  HardessError,
  asHardessError,
  toSysErrPayload,
  type AuthContext,
  type Envelope,
  type SysAuthOkPayload,
  type SysErrPayload,
  type SysPingPayload,
  type SysPongPayload,
  type SysResultPayload
} from "../../shared/index.ts";
import { createEnvelope } from "./envelope.ts";

const SYSTEM_PEER_ID = "hardess.system";

function systemSrc(connId = "system"): Envelope<never>["src"] {
  return {
    peerId: SYSTEM_PEER_ID,
    connId
  };
}

export function createAuthOkEnvelope(
  auth: AuthContext,
  connId: string,
  traceId?: string
): Envelope<SysAuthOkPayload> {
  return createEnvelope({
    kind: "system",
    src: systemSrc(connId),
    protocol: "sys",
    version: "1.0",
    action: "auth.ok",
    traceId,
    payload: {
      peerId: auth.peerId,
      capabilities: auth.capabilities,
      expiresAt: auth.expiresAt
    }
  });
}

export function createPongEnvelope(
  connId: string,
  nonce?: string,
  traceId?: string
): Envelope<SysPongPayload> {
  return createEnvelope({
    kind: "system",
    src: systemSrc(connId),
    protocol: "sys",
    version: "1.0",
    action: "pong",
    traceId,
    payload: { nonce }
  });
}

export function createPingEnvelope(
  connId: string,
  nonce?: string,
  traceId?: string
): Envelope<SysPingPayload> {
  return createEnvelope({
    kind: "system",
    src: systemSrc(connId),
    protocol: "sys",
    version: "1.0",
    action: "ping",
    traceId,
    payload: { nonce }
  });
}

export function createResultEnvelope(
  connId: string,
  payload: SysResultPayload,
  traceId?: string
): Envelope<typeof payload> {
  return createEnvelope({
    kind: "system",
    src: systemSrc(connId),
    protocol: "sys",
    version: "1.0",
    action: "result",
    traceId,
    payload
  });
}

export function createSysErrEnvelope(
  error: unknown,
  connId = "system",
  traceId?: string,
  refMsgId?: string
): Envelope<SysErrPayload> {
  const normalized = asHardessError(error);
  const payload = toSysErrPayload(
    new HardessError(normalized.code, normalized.message, {
      retryable: normalized.retryable,
      detail: normalized.detail,
      refMsgId: refMsgId ?? normalized.refMsgId
    }),
    traceId
  );

  return createEnvelope({
    kind: "system",
    src: systemSrc(connId),
    protocol: "sys",
    version: "1.0",
    action: "err",
    traceId,
    payload
  });
}

export function ensureAuthenticated(auth?: AuthContext): AuthContext {
  if (!auth) {
    throw new HardessError(ERROR_CODES.AUTH_INVALID_TOKEN, "WebSocket is not authenticated");
  }

  return auth;
}
