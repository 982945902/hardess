import { describe, expect, it } from "bun:test";
import { HardessError, type ClientProtocolModule } from "../../shared/index.ts";
import { ClientProtocolRegistry } from "./registry.ts";

const moduleV1: ClientProtocolModule = {
  protocol: "chat",
  version: "1.0"
};

const moduleV2: ClientProtocolModule = {
  protocol: "chat",
  version: "1.0",
  inbound: {
    actions: {
      message() {}
    }
  }
};

describe("ClientProtocolRegistry", () => {
  it("rejects duplicate registrations without explicit replace", () => {
    const registry = new ClientProtocolRegistry();
    registry.register(moduleV1);

    expect(() => registry.register(moduleV2)).toThrow(HardessError);
  });

  it("allows explicit replace", () => {
    const registry = new ClientProtocolRegistry();
    registry.register(moduleV1);
    registry.replace(moduleV2);

    expect(registry.get("chat", "1.0")).toBe(moduleV2);
  });
});
