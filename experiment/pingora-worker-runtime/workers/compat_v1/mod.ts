type ParsedV1Request = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  body_text?: string;
  protocol_version: string;
};

type CompatEnv = {
  worker_id: string;
  mode: string;
  vars: Record<string, string>;
  compat: {
    protocol_version: string;
    shadow_mode: boolean;
  };
};

type CompatContext = {
  request_id: string;
  trace_id?: string;
  deadline_ms?: number;
  metadata: Record<string, string>;
  compat: {
    protocol_version: string;
    shadow_mode: boolean;
  };
  waitUntil(value: Promise<unknown> | unknown): void;
};

export async function fetchCompat(
  request: ParsedV1Request,
  env: CompatEnv,
  ctx: CompatContext,
) {
  ctx.waitUntil(Promise.resolve("compat-background-complete"));

  return {
    status: request.method === "POST" ? 202 : 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-compat-mode": env.mode,
      "x-request-id": ctx.request_id,
      "x-shadow-mode": String(ctx.compat.shadow_mode),
      "x-query-x": (request.query.x ?? []).join("|"),
    },
    body_text:
      `worker=${env.worker_id} protocol=${request.protocol_version} ` +
      `path=${request.path} body=${request.body_text ?? ""} ` +
      `trace=${ctx.trace_id ?? ""} feature=${env.vars.feature ?? ""}`,
  };
}
