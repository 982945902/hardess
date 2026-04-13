import { parseDemoSendPayload, type DemoSendPayload, type ServerProtocolModule } from "../../shared/index.ts";
import { requireCapabilities } from "./acl.ts";

export const demoServerModule: ServerProtocolModule<DemoSendPayload> = {
  protocol: "demo",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {
        parseDemoSendPayload(ctx.payload);
      },
      authorize(ctx) {
        requireCapabilities(ctx.auth, ["notify.conn"], "demo.send");
      },
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      }
    }
  }
};
