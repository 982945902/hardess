import { describe, expect, it } from "bun:test";
import {
  parseChatMessagePayload,
  parseChatSendPayload,
  parseDemoSendPayload
} from "./protocols.ts";

describe("shared protocol payload schemas", () => {
  it("parses demo.send payloads through the shared schema layer", () => {
    expect(
      parseDemoSendPayload({
        toPeerId: "bob",
        content: "hello"
      })
    ).toEqual({
      toPeerId: "bob",
      content: "hello"
    });
  });

  it("rejects invalid chat.send payloads through the shared schema layer", () => {
    expect(() =>
      parseChatSendPayload({
        toPeerId: "bob",
        content: "   "
      })
    ).toThrow("Invalid chat.send payload");
  });

  it("parses chat.message payloads through the shared schema layer", () => {
    expect(
      parseChatMessagePayload({
        fromPeerId: "alice",
        content: "hi"
      })
    ).toEqual({
      fromPeerId: "alice",
      content: "hi"
    });
  });
});
