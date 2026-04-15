import { formatBody } from "./lib.ts";

type WorkerEnv = {
  worker_id: string;
};

type WorkerContext = {
  waitUntil(value: Promise<unknown> | unknown): void;
};

export async function fetch(
  request: Request,
  env: WorkerEnv,
  ctx: WorkerContext,
) {
  ctx.waitUntil(Promise.resolve("background-complete"));

  const body = formatBody(await request.text());

  return new Response(
    `worker=${env.worker_id} method=${request.method} url=${request.url} body=${body}`,
    {
      status: request.method === "POST" ? 201 : 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-worker-id": env.worker_id,
        "x-request-type": request instanceof Request ? "request" : "other",
        "x-request-header": request.headers.get("x-test") ?? "",
      },
    },
  );
}
