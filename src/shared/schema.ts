import { z, type ZodError, type ZodType } from "zod";
import { ERROR_CODES } from "./codes.ts";
import { HardessError } from "./errors.ts";
import type {
  ConnRef,
  Envelope,
  HardessConfig,
  HardessServeModule,
  HardessServiceModule,
  HardessWorkerModule,
  HardessWorkerResult,
  SysAuthOkPayload,
  SysAuthPayload,
  SysErrPayload,
  SysHandleAckPayload,
  SysPingPayload,
  SysPongPayload,
  SysRecvAckPayload,
  SysRoutePayload
} from "./types.ts";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const errorCodeSchema = z.enum(
  Object.values(ERROR_CODES) as [typeof ERROR_CODES[keyof typeof ERROR_CODES], ...typeof ERROR_CODES[keyof typeof ERROR_CODES][]]
);

export const pipelineConfigSchema = z.object({
  id: z.string().min(1, "pipeline id is required"),
  matchPrefix: z
    .string()
    .min(1, "matchPrefix is required")
    .refine((value) => value.startsWith("/"), "matchPrefix must start with '/'"),
  groupId: z.string().min(1, "groupId must be non-empty").optional(),
  auth: z.object({
    required: z.boolean()
  }).optional(),
  downstream: z.object({
    origin: z.string().url("downstream.origin must be a valid absolute URL"),
    connectTimeoutMs: z.number().int().positive("connectTimeoutMs must be > 0"),
    responseTimeoutMs: z.number().int().positive("responseTimeoutMs must be > 0"),
    websocket: z.boolean().optional(),
    forwardAuthContext: z.boolean().optional(),
    injectedHeaders: stringRecordSchema.optional()
  }),
  worker: z.object({
    entry: z.string().min(1, "worker.entry is required"),
    timeoutMs: z.number().int().positive("worker.timeoutMs must be > 0"),
    deployment: z.object({
      config: unknownRecordSchema.optional(),
      bindings: unknownRecordSchema.optional(),
      secrets: stringRecordSchema.optional()
    }).optional()
  }).optional()
});

export const hardessConfigSchema = z.object({
  pipelines: z.array(pipelineConfigSchema)
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
  payload: z.unknown(),
  groupId: z.string().min(1, "groupId must be non-empty").optional()
});

export const bearerSysAuthPayloadSchema = z.object({
  provider: z.literal("bearer"),
  payload: z.string().min(1, "payload is required"),
  groupId: z.string().min(1, "groupId must be non-empty").optional()
});

export const sysAuthOkPayloadSchema = z.object({
  peerId: z.string().min(1, "peerId is required"),
  capabilities: z.array(z.string()),
  expiresAt: z.number().finite()
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

export const sysRecvAckPayloadSchema = z.object({
  ackFor: z.string().min(1, "ackFor is required"),
  acceptedAt: z.number().finite()
});

export const sysHandleAckEventPayloadSchema = z.object({
  ackFor: z.string().min(1, "ackFor is required"),
  handledAt: z.number().finite()
});

const connRefSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  connId: z.string().min(1, "connId is required"),
  peerId: z.string().min(1, "peerId is required"),
  groupId: z.string().min(1, "groupId must be non-empty").optional()
});

export const sysRoutePayloadSchema = z.object({
  resolvedPeers: z.array(z.string().min(1, "resolved peerId is required")),
  deliveredConns: z.array(connRefSchema)
});

export const sysErrPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1, "message is required"),
  retryable: z.boolean(),
  detail: z.unknown().optional(),
  refMsgId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional()
});

export const hardessWorkerResultSchema = z.object({
  request: z.instanceof(Request).optional(),
  response: z.instanceof(Response).optional()
}).strict();

export const workerModuleExportSchema = z.custom<HardessWorkerModule>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function",
  "worker module must export fetch(request, env, ctx)"
);

export const serviceModuleExportSchema = z.custom<HardessServiceModule>(
  (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    const moduleValue = value as {
      protocol?: unknown;
      version?: unknown;
      actions?: unknown;
    };
    if (typeof moduleValue.protocol !== "string" || moduleValue.protocol.length === 0) {
      return false;
    }
    if (typeof moduleValue.version !== "string" || moduleValue.version.length === 0) {
      return false;
    }
    if (!moduleValue.actions || typeof moduleValue.actions !== "object" || Array.isArray(moduleValue.actions)) {
      return false;
    }

    return Object.values(moduleValue.actions).every(
      (hooks) => hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    );
  },
  "service module must export { protocol, version, actions }"
);

export const serveModuleExportSchema = z.custom<HardessServeModule>(
  (value) => {
    if (!value || typeof value !== "object") {
      return false;
    }

    const moduleValue = value as {
      kind?: unknown;
      routes?: unknown;
      middleware?: unknown;
      deployment?: unknown;
    };
    if (moduleValue.kind !== "serve") {
      return false;
    }
    if (!Array.isArray(moduleValue.routes)) {
      return false;
    }
    if (
      moduleValue.middleware !== undefined &&
      !Array.isArray(moduleValue.middleware)
    ) {
      return false;
    }
    if (
      moduleValue.deployment !== undefined &&
      typeof moduleValue.deployment !== "function"
    ) {
      return false;
    }

    return moduleValue.routes.every((route) => {
      if (!route || typeof route !== "object") {
        return false;
      }
      const routeValue = route as {
        method?: unknown;
        path?: unknown;
        handler?: unknown;
      };
      return (
        typeof routeValue.method === "string" &&
        typeof routeValue.path === "string" &&
        routeValue.path.startsWith("/") &&
        (
          typeof routeValue.handler === "function" ||
          (typeof routeValue.handler === "string" && routeValue.handler.length > 0)
        )
      );
    }) && (
      moduleValue.deployment !== undefined ||
      moduleValue.routes.every((route) => typeof (route as { handler?: unknown }).handler === "function")
    ) && (moduleValue.middleware ?? []).every((middleware) => {
      if (!middleware || typeof middleware !== "object") {
        return false;
      }
      const middlewareValue = middleware as {
        pathPrefix?: unknown;
        handler?: unknown;
      };
      return (
        (middlewareValue.pathPrefix === undefined ||
          (typeof middlewareValue.pathPrefix === "string" &&
            middlewareValue.pathPrefix.startsWith("/"))) &&
        typeof middlewareValue.handler === "function"
      );
    });
  },
  "serve module must export { kind: \"serve\", routes, middleware?, deployment? }"
);

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

export function parseConfigModuleExport(
  value: unknown,
  options: {
    exportName?: string;
    modulePath?: string;
  } = {}
): HardessConfig {
  const exportName = options.exportName ?? "hardessConfig";
  const modulePath = options.modulePath ?? "config module";
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid ${modulePath}: module must export ${exportName} or default`);
  }

  const moduleExports = value as Record<string, unknown>;
  const candidate = moduleExports[exportName] ?? moduleExports.default;
  if (candidate === undefined) {
    throw new Error(`Invalid ${modulePath}: module must export ${exportName} or default`);
  }

  return parseHardessConfig(candidate);
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

export function parseBearerSysAuthPayload(payload: unknown): {
  provider: "bearer";
  payload: string;
} {
  return parseProtocolPayload(
    bearerSysAuthPayloadSchema,
    payload,
    "Invalid bearer auth payload"
  );
}

export function parseSysAuthOkPayload(payload: unknown): SysAuthOkPayload {
  return parseProtocolPayload(sysAuthOkPayloadSchema, payload, "Invalid sys.auth.ok payload");
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

export function parseSysRecvAckPayload(payload: unknown): SysRecvAckPayload {
  return parseProtocolPayload(sysRecvAckPayloadSchema, payload, "Invalid sys.recvAck payload");
}

export function parseSysHandleAckEventPayload(payload: unknown): SysHandleAckPayload {
  return parseProtocolPayload(sysHandleAckEventPayloadSchema, payload, "Invalid sys.handleAck event payload");
}

export function parseConnRef(payload: unknown): ConnRef {
  return parseProtocolPayload(connRefSchema, payload, "Invalid conn ref");
}

export function parseSysRoutePayload(payload: unknown): SysRoutePayload {
  return parseProtocolPayload(sysRoutePayloadSchema, payload, "Invalid sys.route payload");
}

export function parseSysErrPayload(payload: unknown): SysErrPayload {
  return parseProtocolPayload(sysErrPayloadSchema, payload, "Invalid sys.err payload");
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

export function parseWorkerModuleExport(value: unknown, entry = "worker"): HardessWorkerModule {
  const result = workerModuleExportSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid worker module ${entry}: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseServiceModuleExport(
  value: unknown,
  entry = "service module"
): HardessServiceModule {
  const result = serviceModuleExportSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid service module ${entry}: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseServeModuleExport(
  value: unknown,
  entry = "serve module"
): HardessServeModule {
  const result = serveModuleExportSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid serve module ${entry}: ${formatZodError(result.error)}`);
  }

  return result.data;
}
