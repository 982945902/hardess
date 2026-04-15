export async function fetch(request: Request, env: { worker_id: string }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 750) {
    // Busy-loop on purpose for overload testing.
  }

  return new Response(`worker=${env.worker_id} body=${await request.text()}`, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
