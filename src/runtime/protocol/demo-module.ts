import { ERROR_CODES, HardessError, type ServerProtocolModule } from "../../shared/index.ts";

interface DemoSendPayload {
  toPeerId: string;
  content: string;
}

export const demoServerModule: ServerProtocolModule<DemoSendPayload> = {
  protocol: "demo",
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
      },
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      }
    }
  }
};
