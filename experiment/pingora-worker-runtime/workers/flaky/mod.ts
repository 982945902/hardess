export async function fetch(_request: Request, env: { worker_id: string }) {
  const mode = _request.url.includes("mode=hang") ? "hang" : "ok";
  if (mode === "hang") {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 500) {
      // Busy-loop on purpose so the runtime watchdog has to terminate V8.
    }
  }

  return new Response(`mode=${mode} worker=${env.worker_id}`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
