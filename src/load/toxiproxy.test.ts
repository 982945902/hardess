import { describe, expect, test } from "bun:test";
import { parseToxiproxyCommand, parseToxiproxyProxyMap } from "./toxiproxy.ts";

describe("toxiproxy tooling schema", () => {
  test("parses supported command names", () => {
    expect(parseToxiproxyCommand("setup")).toBe("setup");
    expect(parseToxiproxyCommand("weak-client")).toBe("weak-client");
    expect(() => parseToxiproxyCommand("unknown")).toThrow("Unknown toxiproxy command: unknown");
  });

  test("parses toxiproxy proxy maps through schema", () => {
    expect(
      parseToxiproxyProxyMap({
        hardess_http: {
          name: "hardess_http",
          listen: "0.0.0.0:8666",
          upstream: "host.docker.internal:3000",
          enabled: true,
          toxics: [{ name: "latency_downstream" }]
        }
      })
    ).toEqual({
      hardess_http: {
        name: "hardess_http",
        listen: "0.0.0.0:8666",
        upstream: "host.docker.internal:3000",
        enabled: true,
        toxics: [{ name: "latency_downstream" }]
      }
    });
  });

  test("rejects invalid toxiproxy proxy maps", () => {
    expect(() =>
      parseToxiproxyProxyMap({
        hardess_http: {
          name: "",
          listen: "0.0.0.0:8666",
          upstream: "host.docker.internal:3000"
        }
      })
    ).toThrow("Invalid Toxiproxy proxies response");
  });
});
