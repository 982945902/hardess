import type { AdminTransport, AdminTransportOperation } from "./transport.ts";

const DEFAULT_HTTP_PATHS: Record<AdminTransportOperation, string> = {
  registerHost: "/v1/admin/hosts/register",
  heartbeatHost: "/v1/admin/hosts/heartbeat",
  getDesiredHostState: "/v1/admin/hosts/desired",
  reportObservedHostState: "/v1/admin/hosts/observed",
  fetchArtifactManifest: "/v1/admin/artifacts/manifest",
  getRuntimeSummaryReadModel: "/v1/admin/read/runtime-summary"
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpAdminTransportOptions {
  baseUrl: string;
  fetchFn?: FetchLike;
  headers?: HeadersInit;
  pathResolver?: (operation: AdminTransportOperation) => string;
}

export class HttpAdminTransport implements AdminTransport {
  private readonly baseUrl: URL;
  private readonly fetchFn: FetchLike;
  private readonly headers?: HeadersInit;
  private readonly pathResolver: (operation: AdminTransportOperation) => string;

  constructor(options: HttpAdminTransportOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
    this.headers = options.headers;
    this.pathResolver = options.pathResolver ?? ((operation) => DEFAULT_HTTP_PATHS[operation]);
  }

  async request(operation: AdminTransportOperation, payload: unknown): Promise<unknown> {
    const response = await this.fetchFn(this.resolveUrl(operation), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...this.headers
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(
        `Admin HTTP request failed for ${operation}: ${response.status} ${response.statusText}`.trim()
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `Admin HTTP response was not valid JSON for ${operation}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private resolveUrl(operation: AdminTransportOperation): string {
    return new URL(this.pathResolver(operation), this.baseUrl).toString();
  }
}
