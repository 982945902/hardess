import { parseProtocolPayload, type ServerProtocolModule } from "../../shared/index.ts";
import { z } from "zod";

const demoSendPayloadSchema = z.object({
  toPeerId: z.string().min(1, "toPeerId is required"),
  content: z.string()
});

type DemoSendPayload = z.infer<typeof demoSendPayloadSchema>;

function isDemoSendPayload(value: unknown): value is DemoSendPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { toPeerId?: unknown }).toPeerId === "string" &&
      (value as { toPeerId: string }).toPeerId.length > 0 &&
      typeof (value as { content?: unknown }).content === "string"
  );
}

export const demoServerModule: ServerProtocolModule<DemoSendPayload> = {
  protocol: "demo",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        if (isDemoSendPayload(ctx.payload)) {
          return;
        }

        parseProtocolPayload(demoSendPayloadSchema, ctx.payload, "Invalid demo.send payload");
      },
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      }
    }
  }
};
