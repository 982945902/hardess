import { z } from "zod";
import { envelopeSchema, formatZodError } from "../../shared/schema.ts";
import type { AckMode, ConnRef, Envelope } from "../../shared/types.ts";
import type { ClusterPeerNode, ClusterTransport } from "./network.ts";

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

const clusterLocateResponseSchema = z.object({
  peers: z.record(z.string(), z.array(connRefSchema))
});

const clusterDeliverResponseSchema = z.object({
  deliveredConns: z.array(connRefSchema)
});

const clusterHandleAckResponseSchema = z.object({
  forwarded: z.boolean()
});

const clusterHelloMessageSchema = z.object({
  type: z.literal("hello"),
  nodeId: z.string().min(1, "nodeId is required"),
  secret: z.string().min(1).optional()
});

const clusterHelloAckMessageSchema = z.object({
  type: z.literal("helloAck"),
  nodeId: z.string().min(1, "nodeId is required")
});

const clusterPingMessageSchema = z.object({
  type: z.literal("ping"),
  ts: z.number()
});

const clusterPongMessageSchema = z.object({
  type: z.literal("pong"),
  ts: z.number()
});

const clusterDeliverMessageSchema = z.object({
  type: z.literal("deliver"),
  ref: z.string().min(1, "ref is required"),
  sender: connRefSchema,
  envelope: envelopeSchema,
  ack: ackModeSchema,
  targets: z.array(connRefSchema)
});

const clusterDeliverResultMessageSchema = z.object({
  type: z.literal("deliverResult"),
  ref: z.string().min(1, "ref is required"),
  deliveredConns: z.array(connRefSchema),
  error: z.string().min(1).optional()
});

const clusterHandleAckMessageSchema = z.object({
  type: z.literal("handleAck"),
  ref: z.string().min(1, "ref is required"),
  sender: connRefSchema,
  ackFor: z.string().min(1, "ackFor is required"),
  traceId: z.string().min(1).optional()
});

const clusterHandleAckResultMessageSchema = z.object({
  type: z.literal("handleAckResult"),
  ref: z.string().min(1, "ref is required"),
  ok: z.boolean(),
  error: z.string().min(1).optional()
});

const clusterPeerNodeSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  baseUrl: z.string().min(1, "baseUrl is required")
});

const clusterPeerListSchema = z.array(clusterPeerNodeSchema);
const clusterTransportSchema = z.enum(["http", "ws"]);

const clusterPeersAdminResponseSchema = z.object({
  nodeId: z.string().min(1, "nodeId is required"),
  transport: clusterTransportSchema,
  peers: clusterPeerListSchema
});

const clusterSocketMessageSchema = z.discriminatedUnion("type", [
  clusterHelloMessageSchema,
  clusterHelloAckMessageSchema,
  clusterPingMessageSchema,
  clusterPongMessageSchema,
  clusterDeliverMessageSchema,
  clusterDeliverResultMessageSchema,
  clusterHandleAckMessageSchema,
  clusterHandleAckResultMessageSchema
]);

export type ClusterSocketMessage =
  | {
      type: "hello";
      nodeId: string;
      secret?: string;
    }
  | {
      type: "helloAck";
      nodeId: string;
    }
  | {
      type: "ping";
      ts: number;
    }
  | {
      type: "pong";
      ts: number;
    }
  | {
      type: "deliver";
      ref: string;
      sender: ConnRef;
      envelope: Envelope<unknown>;
      ack: AckMode;
      targets: ConnRef[];
    }
  | {
      type: "deliverResult";
      ref: string;
      deliveredConns: ConnRef[];
      error?: string;
    }
  | {
      type: "handleAck";
      ref: string;
      sender: ConnRef;
      ackFor: string;
      traceId?: string;
    }
  | {
      type: "handleAckResult";
      ref: string;
      ok: boolean;
      error?: string;
    };

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

export function parseClusterLocateResponse(value: unknown): {
  peers: Record<string, ConnRef[]>;
} {
  const result = clusterLocateResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster locate response: ${formatZodError(result.error)}`);
  }

  return result.data as { peers: Record<string, ConnRef[]> };
}

export function parseClusterDeliverResponse(value: unknown): {
  deliveredConns: ConnRef[];
} {
  const result = clusterDeliverResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster deliver response: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseClusterHandleAckResponse(value: unknown): {
  forwarded: boolean;
} {
  const result = clusterHandleAckResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster handleAck response: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseClusterSocketMessage(raw: unknown): ClusterSocketMessage | null {
  if (typeof raw !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = clusterSocketMessageSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data as ClusterSocketMessage;
}

export function parseClusterPeersEnv(raw: string | undefined): ClusterPeerNode[] {
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid CLUSTER_PEERS_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result = clusterPeerListSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid CLUSTER_PEERS_JSON: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseClusterPeersAdminResponse(value: unknown): {
  nodeId: string;
  transport: ClusterTransport;
  peers: ClusterPeerNode[];
} {
  const result = clusterPeersAdminResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid cluster peers response: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function parseClusterTransportEnv(raw: string | undefined): ClusterTransport {
  if (!raw) {
    return "ws";
  }

  const result = clusterTransportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid CLUSTER_TRANSPORT: ${raw}`);
  }

  return result.data;
}
