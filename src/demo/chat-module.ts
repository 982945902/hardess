import {
  parseChatMessagePayload,
  parseChatSendPayload,
  type ChatMessagePayload,
  type ChatSendPayload,
  type ClientProtocolModule
} from "../sdk/index.ts";

export const chatClientModule: ClientProtocolModule<ChatSendPayload, ChatMessagePayload> = {
  protocol: "chat",
  version: "1.0",
  outbound: {
    encode(_action, payload) {
      return parseChatSendPayload(payload);
    },
    actions: {
      send(ctx) {
        ctx.setStream(`chat:${[ctx.payload.toPeerId].join(":")}`);
        return ctx.payload;
      }
    }
  },
  inbound: {
    decode(_action, payload) {
      return parseChatMessagePayload(payload);
    },
    validate(_action, payload) {
      parseChatMessagePayload(payload);
    },
    actions: {
      async message(ctx) {
        console.log(
          JSON.stringify({
            type: "chat.message",
            from: ctx.payload.fromPeerId,
            content: ctx.payload.content,
            msgId: ctx.msgId
          })
        );
      }
    }
  }
};
