import { HardessClient, type ClientProtocolModule } from "../sdk/index.ts";
import { chatClientModule } from "./chat-module.ts";

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
    argv?: string[];
  };
};

const peerId = env.process?.env?.PEER_ID ?? "alice";
const targetPeerId = env.process?.env?.TARGET_PEER_ID;
const wsUrl = env.process?.env?.WS_URL ?? "ws://127.0.0.1:3000/ws";
const autoSend = (env.process?.env?.AUTO_SEND ?? "").toLowerCase() === "true";
const sendDelayMs = Number(env.process?.env?.SEND_DELAY_MS ?? 1500);
const protocol = env.process?.env?.PROTOCOL ?? "chat";

const demoModule: ClientProtocolModule<
  { toPeerId: string; content: string },
  { toPeerId: string; content: string }
> = {
  protocol: "demo",
  version: "1.0",
  outbound: {
    actions: {
      send(ctx) {
        ctx.setStream(`demo:${ctx.payload.toPeerId}`);
        return ctx.payload;
      }
    }
  },
  inbound: {
    actions: {
      async send(ctx) {
        console.log(
          JSON.stringify({
            type: "biz.recv",
            from: ctx.src.peerId,
            action: ctx.action,
            payload: ctx.payload
          })
        );
      }
    }
  }
};

const moduleForProtocol: ClientProtocolModule<unknown, unknown> =
  protocol === "demo"
    ? (demoModule as ClientProtocolModule<unknown, unknown>)
    : (chatClientModule as ClientProtocolModule<unknown, unknown>);

const client = new HardessClient(wsUrl, {
  systemHandlers: {
    onAuthOk(payload) {
      console.log(JSON.stringify({ type: "sys.auth.ok", payload }));
    },
    onPong(payload) {
      console.log(JSON.stringify({ type: "sys.pong", payload }));
    },
    onRecvAck(payload) {
      console.log(JSON.stringify({ type: "sys.recvAck", payload }));
    },
    onHandleAck(payload) {
      console.log(JSON.stringify({ type: "sys.handleAck", payload }));
    },
    onRoute(payload) {
      console.log(JSON.stringify({ type: "sys.route", payload }));
    },
    onError(payload) {
      console.log(JSON.stringify({ type: "sys.err", payload }));
    }
  }
});

client.use(moduleForProtocol);
client.connect(`demo:${peerId}`);

console.log(
  JSON.stringify({
    type: "client.ready",
    peerId,
    protocol,
    wsUrl,
    targetPeerId: targetPeerId ?? null,
    autoSend
  })
);

if (autoSend && targetPeerId) {
  setTimeout(() => {
    client.emit({
      protocol,
      version: "1.0",
      action: "send",
      payload: {
        toPeerId: targetPeerId,
        content: `hello from ${peerId}`
      }
    });
  }, sendDelayMs);
}
