export function fetch() {
  return new Response("ok");
}

export const websocket = {
  onMessage(message: { kind: string; text: string }, ctx: { send(data: string): void }) {
    if (message.kind !== "text") {
      return;
    }
    ctx.send(message.text);
  },
};
