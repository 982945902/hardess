import { describe, expect, it } from "bun:test";
import { Dispatcher } from "./dispatcher.ts";
import { InMemoryPeerLocator } from "./peer-locator.ts";

describe("Dispatcher", () => {
  it("builds plans from unique peer ids", async () => {
    const locator = new InMemoryPeerLocator();
    locator.register({ nodeId: "local", connId: "conn-1", peerId: "alice" });
    locator.register({ nodeId: "local", connId: "conn-2", peerId: "alice" });
    locator.register({ nodeId: "local", connId: "conn-3", peerId: "bob" });

    const dispatcher = new Dispatcher(locator);
    const plan = await dispatcher.buildPlan(["alice", "bob", "alice"], {
      streamId: "demo",
      ack: "recv"
    });

    expect(plan.streamId).toBe("demo");
    expect(plan.ack).toBe("recv");
    expect(plan.targets.map((target) => target.connId).sort()).toEqual(["conn-1", "conn-2", "conn-3"]);
  });
});
