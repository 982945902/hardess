import { describe, expect, it } from "bun:test";
import { InMemoryPeerLocator } from "./peer-locator.ts";

describe("InMemoryPeerLocator", () => {
  it("moves an existing connId between peers without leaving stale indexes", async () => {
    const locator = new InMemoryPeerLocator();

    locator.register({
      nodeId: "local",
      connId: "conn-1",
      peerId: "alice"
    });

    locator.register({
      nodeId: "local",
      connId: "conn-1",
      peerId: "bob"
    });

    expect(locator.countConnections()).toBe(1);
    expect(locator.countConnectionsForPeer("alice")).toBe(0);
    expect(locator.countConnectionsForPeer("bob")).toBe(1);
    expect(await locator.find("alice")).toEqual([]);
    expect(await locator.find("bob")).toEqual([
      {
        nodeId: "local",
        connId: "conn-1",
        peerId: "bob"
      }
    ]);
  });
});
