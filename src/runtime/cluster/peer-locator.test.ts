import { describe, expect, it, mock } from "bun:test";
import { InMemoryPeerLocator } from "../routing/peer-locator.ts";
import { DistributedPeerLocator } from "./peer-locator.ts";
import { StaticClusterNetwork } from "./network.ts";

describe("DistributedPeerLocator", () => {
  it("merges local and remote results and caches remote lookups", async () => {
    const local = new InMemoryPeerLocator();
    local.register({ nodeId: "node-a", connId: "conn-local", peerId: "alice" });

    const fetchFn = mock(async () => {
      return new Response(
        JSON.stringify({
          peers: {
            alice: [{ nodeId: "node-b", connId: "conn-remote", peerId: "alice" }]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;
    const network = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      { nodeId: "node-a", fetchFn }
    );
    const locator = new DistributedPeerLocator(local, network, 10_000);

    const first = await locator.find("alice");
    expect(first).toEqual([
      { nodeId: "node-a", connId: "conn-local", peerId: "alice" },
      { nodeId: "node-b", connId: "conn-remote", peerId: "alice" }
    ]);

    const second = await locator.find("alice");
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty remote lookup results", async () => {
    const local = new InMemoryPeerLocator();
    let calls = 0;

    const fetchFn = mock(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          peers: {
            alice: calls === 1 ? [] : [{ nodeId: "node-b", connId: "conn-remote", peerId: "alice" }]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const network = new StaticClusterNetwork(
      [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }],
      { nodeId: "node-a", fetchFn }
    );
    const locator = new DistributedPeerLocator(local, network, 10_000);

    expect(await locator.find("alice")).toEqual([]);
    expect(await locator.find("alice")).toEqual([
      { nodeId: "node-b", connId: "conn-remote", peerId: "alice" }
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
