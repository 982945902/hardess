const port = Number(process.env.BUN_NATIVE_WS_PORT ?? "6191");

const server = Bun.serve({
  port,
  fetch(request, server) {
    if (server.upgrade(request)) {
      return;
    }

    return new Response("ok", {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
  websocket: {
    message(ws, message) {
      ws.send(message);
    },
  },
});

console.log(`bun native websocket echo listening on ws://127.0.0.1:${server.port}`);
