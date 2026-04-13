import { z } from "zod";
import { parseProtocolPayload } from "./schema.ts";

export const demoSendPayloadSchema = z.object({
  toPeerId: z.string().min(1, "toPeerId is required"),
  content: z.string()
});

export type DemoSendPayload = z.infer<typeof demoSendPayloadSchema>;

export const chatSendPayloadSchema = z.object({
  toPeerId: z.string().min(1, "toPeerId is required"),
  content: z.string().trim().min(1, "content must not be empty")
});

export type ChatSendPayload = z.infer<typeof chatSendPayloadSchema>;

export const chatMessagePayloadSchema = z.object({
  fromPeerId: z.string().min(1, "fromPeerId is required"),
  content: z.string().trim().min(1, "content must not be empty")
});

export type ChatMessagePayload = z.infer<typeof chatMessagePayloadSchema>;

export function parseDemoSendPayload(payload: unknown): DemoSendPayload {
  return parseProtocolPayload(demoSendPayloadSchema, payload, "Invalid demo.send payload");
}

export function parseChatSendPayload(payload: unknown): ChatSendPayload {
  return parseProtocolPayload(chatSendPayloadSchema, payload, "Invalid chat.send payload");
}

export function parseChatMessagePayload(payload: unknown): ChatMessagePayload {
  return parseProtocolPayload(chatMessagePayloadSchema, payload, "Invalid chat.message payload");
}
