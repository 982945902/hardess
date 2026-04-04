import type { ServerProtocolModule } from "../../shared/index.ts";

interface EchoSendPayload {
  toPeerId: string;
  content: string;
}

export const echoServerModule: ServerProtocolModule<EchoSendPayload> = {
  protocol: "echo",
  version: "1.0",
  actions: {
    send: {
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      },
      buildDispatch(ctx) {
        return {
          action: "message",
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
