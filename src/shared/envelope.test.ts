import { describe, expect, it } from "bun:test";
import { parseEnvelope } from "./envelope.ts";

describe("parseEnvelope", () => {
  it("returns null for payloads that do not satisfy the shared envelope contract", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          msgId: "m-1",
          kind: "system",
          src: { peerId: "alice" },
          protocol: "sys",
          version: "1.0",
          action: "ping",
          ts: Date.now(),
          payload: {}
        })
      )
    ).toBeNull();
  });
});
