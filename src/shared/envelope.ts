import type { Envelope } from "./types.ts";

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
    const value = JSON.parse(raw) as Envelope<unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.protocol !== "string" ||
      typeof value.version !== "string" ||
      typeof value.action !== "string" ||
      typeof value.kind !== "string"
    ) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

export function serializeEnvelope(envelope: Envelope<unknown>): string {
  return JSON.stringify(envelope);
}
