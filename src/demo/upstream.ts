declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number };
};

const server = Bun.serve({
  port: Number(process.env.UPSTREAM_PORT ?? 9000),
  async fetch(request) {
    const url = new URL(request.url);
    const bodyText =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text();

    return Response.json({
      ok: true,
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      headers: {
        "x-hardess-pipeline": request.headers.get("x-hardess-pipeline"),
        "x-hardess-worker": request.headers.get("x-hardess-worker"),
        "x-hardess-auth-peer": request.headers.get("x-hardess-auth-peer"),
        "x-hardess-peer-id": request.headers.get("x-hardess-peer-id"),
        "x-hardess-trace-id": request.headers.get("x-hardess-trace-id")
      },
      body: bodyText
    });
  }
});

console.log(`demo upstream listening on :${server.port}`);
