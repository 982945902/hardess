import { describe, expect, it, mock } from "bun:test";
import { HttpAdminTransport } from "./http.ts";

describe("HttpAdminTransport", () => {
  it("posts json to the default admin endpoints", async () => {
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://admin.example/v1/admin/hosts/register");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ hostId: "host-a" }));

      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer token");

      return new Response(JSON.stringify({ accepted: true, hostId: "host-a" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    });

    const transport = new HttpAdminTransport({
      baseUrl: "https://admin.example",
      fetchFn,
      headers: {
        authorization: "Bearer token"
      }
    });

    const result = await transport.request("registerHost", { hostId: "host-a" });
    expect(result).toEqual({ accepted: true, hostId: "host-a" });
  });

  it("supports custom path resolution", async () => {
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://admin.example/custom/getDesiredHostState");
      return new Response(JSON.stringify({ changed: false }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    });

    const transport = new HttpAdminTransport({
      baseUrl: "https://admin.example/root/",
      fetchFn,
      pathResolver: (operation) => `/custom/${operation}`
    });

    const result = await transport.request("getDesiredHostState", { hostId: "host-a" });
    expect(result).toEqual({ changed: false });
  });

  it("throws on non-ok responses", async () => {
    const transport = new HttpAdminTransport({
      baseUrl: "https://admin.example",
      fetchFn: mock(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }))
    });

    await expect(transport.request("heartbeatHost", { hostId: "host-a" })).rejects.toThrow(
      "Admin HTTP request failed for heartbeatHost: 503 Service Unavailable"
    );
  });

  it("throws when the response body is not valid json", async () => {
    const transport = new HttpAdminTransport({
      baseUrl: "https://admin.example",
      fetchFn: mock(async () =>
        new Response("not-json", {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    });

    await expect(transport.request("fetchArtifactManifest", { manifestId: "m-1" })).rejects.toThrow(
      "Admin HTTP response was not valid JSON for fetchArtifactManifest"
    );
  });
});
