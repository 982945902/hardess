interface Env {
  DEMO_SECRET: string;
  RUNTIME_META: {
    runtime: string;
    experiment: string;
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json(
          {
            ok: false,
            error: "upgrade_required",
            path: url.pathname,
          },
          { status: 426 },
        );
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      server.accept();
      server.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : String(event.data);
        server.send(
          JSON.stringify({
            ok: true,
            type: "echo",
            runtime: env.RUNTIME_META.runtime,
            echo: text,
          }),
        );
      });
      server.addEventListener("close", (event) => {
        server.close(event.code, event.reason);
      });
      server.send(
        JSON.stringify({
          ok: true,
          type: "open",
          runtime: env.RUNTIME_META.runtime,
        }),
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        runtime: env.RUNTIME_META.runtime,
        experiment: env.RUNTIME_META.experiment,
        secret: env.DEMO_SECRET,
        method: request.method,
        path: url.pathname,
      });
    }

    if (request.method === "POST" && url.pathname === "/echo") {
      const body = await request.text();
      return json({
        ok: true,
        runtime: env.RUNTIME_META.runtime,
        path: url.pathname,
        echo: body,
        length: body.length,
      });
    }

    return json(
      {
        ok: false,
        error: "not_found",
        method: request.method,
        path: url.pathname,
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
