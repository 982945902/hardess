export {};

declare const Bun: {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number };
};

const env = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const port = Number(env.process?.env?.PORT ?? 3101);

const server = Bun.serve({
  port,
  fetch() {
    return Response.json({
      ok: true,
      mode: "bun-bare"
    });
  }
});

console.log(`bench bare http listening on :${server.port}`);
