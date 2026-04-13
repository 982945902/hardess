import { z } from "zod";
import { envelopeSchema, formatZodError } from "../../shared/schema.ts";
import type { AckMode, ConnRef, Envelope } from "../../shared/types.ts";

const connRefSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  connId: z.string().min(1, "connId is required"),
  peerId: z.string().min(1, "peerId is required")
});

const clusterLocateRequestSchema = z.object({
  peerIds: z.array(z.string().min(1, "peerId is required")).min(1, "at least one peerId is required")
});

const ackModeSchema = z.enum(["none", "recv", "handle"]);

const clusterDeliverRequestSchema = z.object({
  sender: connRefSchema,
  envelope: envelopeSchema,
  ack: ackModeSchema,
  targets: z.array(connRefSchema).min(1, "at least one target is required")
});

const clusterHandleAckRequestSchema = z.object({
  sender: connRefSchema,
  ackFor: z.string().min(1, "ackFor is required"),
  traceId: z.string().min(1).optional()
});

export function parseClusterLocateRequest(value: unknown): { peerIds: string[] } {
  const result = clusterLocateRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster locate request: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseClusterDeliverRequest(value: unknown): {
  sender: ConnRef;
  envelope: Envelope<unknown>;
  ack: AckMode;
  targets: ConnRef[];
} {
  const result = clusterDeliverRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster deliver request: ${formatZodError(result.error)}`);
  }

  return result.data as {
    sender: ConnRef;
    envelope: Envelope<unknown>;
    ack: AckMode;
    targets: ConnRef[];
  };
}

export function parseClusterHandleAckRequest(value: unknown): {
  sender: ConnRef;
  ackFor: string;
  traceId?: string;
} {
  const result = clusterHandleAckRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster handleAck request: ${formatZodError(result.error)}`);
  }

  return result.data;
}
