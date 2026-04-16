export async function fetch(request: Request) {
  const url = request.url;
  const pathnameStart = url.indexOf("/", url.indexOf("://") + 3);
  const pathname = pathnameStart === -1 ? "/" : url.slice(pathnameStart).split("?")[0];

  return new Response(
    JSON.stringify({
      ok: true,
      method: request.method,
      pathname
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-benchmark-worker": "v2-short-circuit"
      }
    },
  );
}
