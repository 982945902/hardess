export {};

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }): Response | Promise<Response> | undefined;
    websocket: {
      open?(ws: {
        send(data: string): void;
      }): void;
      message?(ws: {
        send(data: string): void;
      }, message: string | ArrayBuffer | Uint8Array): void;
    };
  }): { port: number };
};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const port = Number(env.process?.env?.PORT ?? 3201);

const server = Bun.serve({
  port,
  fetch(request, serverRef) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const upgraded = serverRef.upgrade(request);
      if (upgraded) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 426 });
    }

    return Response.json({ ok: true, mode: "bun-ws-bare" });
  },
  websocket: {
    message(ws, message) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof ArrayBuffer
            ? new TextDecoder().decode(new Uint8Array(message))
            : new TextDecoder().decode(message);
      ws.send(text);
    }
  }
});

console.log(`bench ws bare listening on :${server.port}`);
