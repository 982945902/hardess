import type { Envelope } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

// Hot path: keep envelope parsing here as a minimal hand-rolled guard instead of zod.
// If this contract changes, keep it aligned with shared/schema.ts envelopeSchema and
// preserve test coverage before broadening the checks.
function parseEnvelopeValueFast(value: unknown): Envelope<unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const src = value.src;
  if (!isRecord(src)) {
    return null;
  }

  if (
    typeof value.msgId !== "string" ||
    value.msgId.length === 0 ||
    (value.kind !== "system" && value.kind !== "biz") ||
    typeof src.peerId !== "string" ||
    src.peerId.length === 0 ||
    typeof src.connId !== "string" ||
    src.connId.length === 0 ||
    typeof value.protocol !== "string" ||
    value.protocol.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    typeof value.action !== "string" ||
    value.action.length === 0 ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    value.ts < 0
  ) {
    return null;
  }

  if (value.streamId !== undefined && (typeof value.streamId !== "string" || value.streamId.length === 0)) {
    return null;
  }

  if (
    value.seq !== undefined &&
    (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0)
  ) {
    return null;
  }

  if (value.traceId !== undefined && (typeof value.traceId !== "string" || value.traceId.length === 0)) {
    return null;
  }

  if (!("payload" in value)) {
    return null;
  }

  return value as unknown as Envelope<unknown>;
}

export function createEnvelope<T>(
  input: Omit<Envelope<T>, "msgId" | "ts"> & { msgId?: string; ts?: number }
): Envelope<T> {
  return {
    ...input,
    msgId: input.msgId ?? crypto.randomUUID(),
    ts: input.ts ?? Date.now()
  };
}

export function parseEnvelope(raw: string): Envelope<unknown> | null {
  try {
    return parseEnvelopeValueFast(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeEnvelope(envelope: Envelope<unknown>): string {
  return JSON.stringify(envelope);
}
