import type { ClientProtocolModule } from "../sdk/index.ts";

export interface ChatSendPayload {
  toPeerId: string;
  content: string;
}

export interface ChatMessagePayload {
  fromPeerId: string;
  content: string;
}

export const chatClientModule: ClientProtocolModule<ChatSendPayload, ChatMessagePayload> = {
  protocol: "chat",
  version: "1.0",
  outbound: {
    actions: {
      send(ctx) {
        ctx.setStream(`chat:${[ctx.payload.toPeerId].join(":")}`);
        return ctx.payload;
      }
    }
  },
  inbound: {
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
