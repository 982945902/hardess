import { describe, expect, it } from "bun:test";
import {
  parseRuntimeBootstrapConfig,
  RUNTIME_DEFAULTS
} from "./bootstrap-config.ts";

describe("parseRuntimeBootstrapConfig", () => {
  it("applies runtime timeout defaults into the effective config", () => {
    const config = parseRuntimeBootstrapConfig({});

    expect(config.listen.businessPort).toBe(RUNTIME_DEFAULTS.port);
    expect(config.listen.singleListenerName).toBe("default");
    expect(config.cluster.transport).toBe("ws");
    expect(config.shutdown.drainMs).toBe(RUNTIME_DEFAULTS.shutdownDrainMs);
    expect(config.shutdown.timeoutMs).toBe(RUNTIME_DEFAULTS.shutdownTimeoutMs);
    expect(config.websocket.heartbeatIntervalMs).toBe(RUNTIME_DEFAULTS.websocketHeartbeatIntervalMs);
    expect(config.websocket.staleAfterMs).toBe(RUNTIME_DEFAULTS.websocketStaleAfterMs);
    expect(config.internalForward.httpTimeoutMs).toBe(RUNTIME_DEFAULTS.internalForwardHttpTimeoutMs);
    expect(config.admin.pollAfterMs).toBe(RUNTIME_DEFAULTS.adminPollAfterMs);
    expect(config.timeoutProfile.pipelineConfig.downstreamConnectTimeoutMs).toBe("per-pipeline required");
  });

  it("resolves aliases for listener config", () => {
    const config = parseRuntimeBootstrapConfig({
      PUBLIC_PORT: "3100",
      INTERNAL_PORT: "3200",
      PUBLIC_ALLOWED_PATH_PREFIXES: "/ws,/api",
      INTERNAL_ALLOWED_PATH_PREFIXES: "/__admin,/__cluster"
    });

    expect(config.listen.businessPort).toBe(3100);
    expect(config.listen.controlPort).toBe(3200);
    expect(config.listen.singleListenerName).toBe("business");
    expect(config.listen.businessAllowedPathPrefixes).toEqual(["/ws", "/api"]);
    expect(config.listen.controlAllowedPathPrefixes).toEqual(["/__admin", "/__cluster"]);
  });

  it("rejects invalid numeric timeout values instead of silently falling back", () => {
    expect(() =>
      parseRuntimeBootstrapConfig({
        SHUTDOWN_TIMEOUT_MS: "abc"
      })
    ).toThrow("Invalid SHUTDOWN_TIMEOUT_MS");
  });

  it("rejects timeout relationships that would make the runtime unhealthy", () => {
    expect(() =>
      parseRuntimeBootstrapConfig({
        WS_HEARTBEAT_INTERVAL_MS: "5000",
        WS_STALE_AFTER_MS: "5000"
      })
    ).toThrow("WS_STALE_AFTER_MS must be greater than WS_HEARTBEAT_INTERVAL_MS");

    expect(() =>
      parseRuntimeBootstrapConfig({
        SHUTDOWN_DRAIN_MS: "2000",
        SHUTDOWN_TIMEOUT_MS: "1000"
      })
    ).toThrow("SHUTDOWN_DRAIN_MS must be <= SHUTDOWN_TIMEOUT_MS");
  });

  it("rejects malformed listener path prefixes", () => {
    expect(() =>
      parseRuntimeBootstrapConfig({
        BUSINESS_ALLOWED_PATH_PREFIXES: "api"
      })
    ).toThrow("must start with '/'");
  });
});
