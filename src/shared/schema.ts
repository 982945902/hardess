import { z, type ZodError, type ZodType } from "zod";
import { ERROR_CODES } from "./codes.ts";
import { HardessError } from "./errors.ts";
import type {
  Envelope,
  HardessConfig,
  HardessWorkerResult,
  SysAuthPayload,
  SysPingPayload,
  SysPongPayload
} from "./types.ts";

const stringRecordSchema = z.record(z.string(), z.string());

export const pipelineConfigSchema = z.object({
  id: z.string().min(1, "pipeline id is required"),
  matchPrefix: z
    .string()
    .min(1, "matchPrefix is required")
    .refine((value) => value.startsWith("/"), "matchPrefix must start with '/'"),
  auth: z.object({
    required: z.boolean()
  }).optional(),
  downstream: z.object({
    origin: z.string().url("downstream.origin must be a valid absolute URL"),
    connectTimeoutMs: z.number().int().positive("connectTimeoutMs must be > 0"),
    responseTimeoutMs: z.number().int().positive("responseTimeoutMs must be > 0"),
    forwardAuthContext: z.boolean().optional(),
    injectedHeaders: stringRecordSchema.optional()
  }),
  worker: z.object({
    entry: z.string().min(1, "worker.entry is required"),
    timeoutMs: z.number().int().positive("worker.timeoutMs must be > 0")
  }).optional()
});

export const hardessConfigSchema = z.object({
  pipelines: z.array(pipelineConfigSchema).min(1, "at least one pipeline is required")
});

export const envelopeSchema = z.object({
  msgId: z.string().min(1, "msgId is required"),
  kind: z.enum(["system", "biz"]),
  src: z.object({
    peerId: z.string().min(1, "src.peerId is required"),
    connId: z.string().min(1, "src.connId is required")
  }),
  protocol: z.string().min(1, "protocol is required"),
  version: z.string().min(1, "version is required"),
  action: z.string().min(1, "action is required"),
  streamId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative().optional(),
  ts: z.number().finite().nonnegative(),
  traceId: z.string().min(1).optional(),
  payload: z.unknown()
});

export const sysAuthPayloadSchema = z.object({
  provider: z.string().min(1, "provider is required"),
  payload: z.unknown()
});

export const sysPingPayloadSchema = z.object({
  nonce: z.string().optional()
});

export const sysPongPayloadSchema = z.object({
  nonce: z.string().optional()
});

export const sysHandleAckPayloadSchema = z.object({
  ackFor: z.string().min(1, "ackFor is required")
});

export const hardessWorkerResultSchema = z.object({
  request: z.instanceof(Request).optional(),
  response: z.instanceof(Response).optional()
}).strict();

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseHardessConfig(value: unknown): HardessConfig {
  const result = hardessConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Hardess config: ${formatZodError(result.error)}`);
  }

  return result.data as HardessConfig;
}

export function parseEnvelopeValue(value: unknown): Envelope<unknown> | null {
  const result = envelopeSchema.safeParse(value);
  return result.success ? (result.data as Envelope<unknown>) : null;
}

export function parseProtocolPayload<T>(
  schema: ZodType<T>,
  payload: unknown,
  message: string
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, message, {
      detail: formatZodError(result.error)
    });
  }

  return result.data;
}

export function parseSysAuthPayload(payload: unknown): SysAuthPayload {
  return parseProtocolPayload(sysAuthPayloadSchema, payload, "Invalid sys.auth payload");
}

export function parseSysPingPayload(payload: unknown): SysPingPayload {
  return parseProtocolPayload(sysPingPayloadSchema, payload, "Invalid sys.ping payload");
}

export function parseSysPongPayload(payload: unknown): SysPongPayload {
  return parseProtocolPayload(sysPongPayloadSchema, payload, "Invalid sys.pong payload");
}

export function parseSysHandleAckPayload(payload: unknown): { ackFor: string } {
  return parseProtocolPayload(sysHandleAckPayloadSchema, payload, "Invalid sys.handleAck payload");
}

export function normalizeWorkerResult(result: Response | HardessWorkerResult | void): HardessWorkerResult {
  if (!result) {
    return {};
  }

  if (result instanceof Response) {
    return { response: result };
  }

  const parsed = hardessWorkerResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new HardessError(ERROR_CODES.INTERNAL_ERROR, "Worker returned an invalid result", {
      detail: formatZodError(parsed.error)
    });
  }

  return parsed.data as HardessWorkerResult;
}
