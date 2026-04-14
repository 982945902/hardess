import { type ClientErrorCode, type ErrorCode, type SdkErrorCode, ERROR_CODES } from "./codes.ts";
import type { ClientCloseInfo, HardessSdkErrorShape, PlatformErrorBody, SysErrPayload } from "./types.ts";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ERROR_CODES.AUTH_INVALID_TOKEN]: 401,
  [ERROR_CODES.AUTH_EXPIRED_TOKEN]: 401,
  [ERROR_CODES.AUTH_REVOKED_TOKEN]: 401,
  [ERROR_CODES.ACL_DENIED]: 403,
  [ERROR_CODES.CONN_QUOTA_EXCEEDED]: 429,
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 429,
  [ERROR_CODES.BACKPRESSURE_OVERFLOW]: 503,
  [ERROR_CODES.PROTO_REGISTRATION_CONFLICT]: 409,
  [ERROR_CODES.PROTO_UNKNOWN_ACTION]: 404,
  [ERROR_CODES.PROTO_INVALID_PAYLOAD]: 400,
  [ERROR_CODES.ROUTE_NO_RECIPIENT]: 404,
  [ERROR_CODES.ROUTE_PEER_OFFLINE]: 404,
  [ERROR_CODES.ROUTE_DELIVERY_TIMEOUT]: 504,
  [ERROR_CODES.SERVER_DRAINING]: 503,
  [ERROR_CODES.GATEWAY_UPSTREAM_TIMEOUT]: 504,
  [ERROR_CODES.GATEWAY_UPSTREAM_UNAVAILABLE]: 503,
  [ERROR_CODES.INTERNAL_ERROR]: 500
};

export class HardessError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly detail?: unknown;
  readonly refMsgId?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      detail?: unknown;
      refMsgId?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "HardessError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.detail = options.detail;
    this.refMsgId = options.refMsgId;
  }
}

export class HardessSdkError extends Error implements HardessSdkErrorShape {
  readonly code: SdkErrorCode;
  readonly source: "client" | "remote";
  readonly retryable: boolean;
  readonly traceId?: string;
  readonly refMsgId?: string;
  readonly detail?: unknown;
  readonly close?: ClientCloseInfo;

  constructor(
    code: SdkErrorCode,
    message: string,
    options: {
      source: "client" | "remote";
      retryable?: boolean;
      traceId?: string;
      refMsgId?: string;
      detail?: unknown;
      close?: ClientCloseInfo;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "HardessSdkError";
    this.code = code;
    this.source = options.source;
    this.retryable = options.retryable ?? false;
    this.traceId = options.traceId;
    this.refMsgId = options.refMsgId;
    this.detail = options.detail;
    this.close = options.close;
  }
}

export function statusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function toPlatformErrorBody(
  error: HardessError,
  traceId?: string
): PlatformErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      traceId,
      refMsgId: error.refMsgId,
      detail: error.detail
    }
  };
}

export function createHttpErrorResponse(
  error: HardessError,
  traceId?: string
): Response {
  return Response.json(toPlatformErrorBody(error, traceId), {
    status: error.status,
    headers: {
      "content-type": "application/json"
    }
  });
}

export function toSysErrPayload(
  error: HardessError,
  traceId?: string
): SysErrPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    detail: error.detail,
    refMsgId: error.refMsgId,
    traceId
  };
}

export function asHardessError(error: unknown): HardessError {
  if (error instanceof HardessError) {
    return error;
  }

  return new HardessError(ERROR_CODES.INTERNAL_ERROR, "Unexpected internal error", {
    detail: error instanceof Error ? error.message : String(error),
    cause: error
  });
}

export function createClientSdkError(
  code: ClientErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    traceId?: string;
    refMsgId?: string;
    detail?: unknown;
    close?: ClientCloseInfo;
    cause?: unknown;
  } = {}
): HardessSdkError {
  return new HardessSdkError(code, message, {
    source: "client",
    retryable: options.retryable,
    traceId: options.traceId,
    refMsgId: options.refMsgId,
    detail: options.detail,
    close: options.close,
    cause: options.cause
  });
}

export function createRemoteSdkError(payload: SysErrPayload): HardessSdkError {
  return new HardessSdkError(payload.code, payload.message, {
    source: "remote",
    retryable: payload.retryable,
    traceId: payload.traceId,
    refMsgId: payload.refMsgId,
    detail: payload.detail
  });
}
