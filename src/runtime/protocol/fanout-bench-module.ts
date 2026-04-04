import {
  ERROR_CODES,
  HardessError,
  type ServerProtocolModule
} from "../../shared/index.ts";

interface FanoutBenchPayload {
  peerIds: string[];
  content: string;
}

export const fanoutBenchServerModule: ServerProtocolModule<FanoutBenchPayload> = {
  protocol: "fanout-bench",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        if (!ctx.payload || typeof ctx.payload !== "object") {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "Payload must be an object");
        }

        if (!Array.isArray(ctx.payload.peerIds) || ctx.payload.peerIds.some((peerId) => typeof peerId !== "string")) {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "peerIds must be a string array");
        }

        if (typeof ctx.payload.content !== "string" || ctx.payload.content.trim().length === 0) {
          throw new HardessError(ERROR_CODES.PROTO_INVALID_PAYLOAD, "content must not be empty");
        }
      },
      resolveRecipients(ctx) {
        return ctx.payload.peerIds;
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
