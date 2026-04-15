type ParsedV1Request = {
  method: string;
  path: string;
};

type CompatEnv = {
  worker_id: string;
};

type CompatContext = {
  request_id: string;
};

type PublicErrorSpec = {
  code: string;
  category: string;
  status: number;
  retryable: boolean;
};

type HardessPublicErrorsApi = {
  version: number;
  list: PublicErrorSpec[];
  codes(): string[];
  has(code: string): boolean;
  get(code: string): PublicErrorSpec | null;
};

declare global {
  var HardessPublicErrors: HardessPublicErrorsApi;
}

export async function fetchCompat(
  request: ParsedV1Request,
  env: CompatEnv,
  ctx: CompatContext,
) {
  const quotaError = globalThis.HardessPublicErrors.get("tenant_over_quota");
  if (!quotaError) {
    throw new Error("tenant_over_quota must exist in HardessPublicErrors");
  }

  return {
    status: quotaError.status,
    headers: {
      "x-worker-id": env.worker_id,
      "x-request-id": ctx.request_id,
      "x-path": request.path,
      "x-error-contract-version": String(globalThis.HardessPublicErrors.version),
    },
    body_text: "this body should be ignored once error is present",
    error: {
      category: quotaError.category,
      code: quotaError.code,
      message: "quota exceeded",
      retryable: quotaError.retryable,
      status: quotaError.status,
    },
  };
}
