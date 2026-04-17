const demoChatServiceModule = {
  protocol: "demo-chat",
  version: "1.0",
  actions: {
    send: {
      handleLocally() {
        return {
          ack: "handle"
        };
      },
      resolveRecipients(ctx: { payload: { toPeerId?: string } }) {
        return ctx.payload.toPeerId ? [ctx.payload.toPeerId] : [];
      },
      buildDispatch(ctx: { auth: { peerId: string }; payload: { content: string } }) {
        return {
          action: "message",
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

export default demoChatServiceModule;
