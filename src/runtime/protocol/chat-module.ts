import { parseProtocolPayload, type ServerProtocolModule } from "../../shared/index.ts";
import { z } from "zod";

const chatSendPayloadSchema = z.object({
  toPeerId: z.string().min(1, "toPeerId is required"),
  content: z.string().trim().min(1, "content must not be empty")
});

type ChatSendPayload = z.infer<typeof chatSendPayloadSchema>;

function isChatSendPayload(value: unknown): value is ChatSendPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { toPeerId?: unknown }).toPeerId === "string" &&
      (value as { toPeerId: string }).toPeerId.length > 0 &&
      typeof (value as { content?: unknown }).content === "string" &&
      (value as { content: string }).content.trim().length > 0
  );
}

export const chatServerModule: ServerProtocolModule<ChatSendPayload> = {
  protocol: "chat",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        if (isChatSendPayload(ctx.payload)) {
          return;
        }

        parseProtocolPayload(chatSendPayloadSchema, ctx.payload, "Invalid chat.send payload");
      },
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      },
      buildDispatch(ctx) {
        return {
          action: "message",
          streamId: `chat:${[ctx.auth.peerId, ctx.payload.toPeerId].sort().join(":")}`,
          payload: {
            fromPeerId: ctx.auth.peerId,
            content: ctx.payload.content
          },
          ack: "handle"
        };
      }
    }
  }
};
