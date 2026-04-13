import { parseChatSendPayload, type ChatSendPayload, type ServerProtocolModule } from "../../shared/index.ts";
import { requireCapabilities } from "./acl.ts";

export const chatServerModule: ServerProtocolModule<ChatSendPayload> = {
  protocol: "chat",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        parseChatSendPayload(ctx.payload);
      },
      authorize(ctx) {
        requireCapabilities(ctx.auth, ["notify.conn"], "chat.send");
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
