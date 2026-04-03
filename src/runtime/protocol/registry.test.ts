import { describe, expect, it } from "bun:test";
import { HardessError, type ServerProtocolModule } from "../../shared/index.ts";
import { ServerProtocolRegistry } from "./registry.ts";

const moduleV1: ServerProtocolModule = {
  protocol: "chat",
  version: "1.0",
  actions: {
    send: {}
  }
};

const moduleV2: ServerProtocolModule = {
  protocol: "chat",
  version: "1.0",
  actions: {
    message: {}
  }
};

describe("ServerProtocolRegistry", () => {
  it("rejects duplicate registrations without explicit replace", () => {
    const registry = new ServerProtocolRegistry();
    registry.register(moduleV1);

    expect(() => registry.register(moduleV1)).toThrow(HardessError);
  });

  it("allows explicit replace", () => {
    const registry = new ServerProtocolRegistry();
    registry.register(moduleV1);
    registry.replace(moduleV2);

    expect(() => registry.get("chat", "1.0", "send")).toThrow(HardessError);
    expect(registry.get("chat", "1.0", "message")).toBe(moduleV2.actions.message);
  });
});
