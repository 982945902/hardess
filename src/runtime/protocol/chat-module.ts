import { ERROR_CODES, HardessError, type ServerProtocolModule } from "../../shared/index.ts";

interface ChatSendPayload {
  toPeerId: string;
  content: string;
}

export const chatServerModule: ServerProtocolModule<ChatSendPayload> = {
  protocol: "chat",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        if (!ctx.payload || typeof ctx.payload !== "object") {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "Payload must be an object");
        }

        if (typeof ctx.payload.toPeerId !== "string" || typeof ctx.payload.content !== "string") {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "Missing toPeerId or content");
        }

        if (ctx.payload.content.trim().length === 0) {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "Content must not be empty");
        }
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
          ack: "recv"
        };
      }
    }
  }
};
