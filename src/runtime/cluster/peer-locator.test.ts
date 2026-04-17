import { describe, expect, it, mock } from "bun:test";
import { InMemoryPeerLocator } from "../routing/peer-locator.ts";
import { DistributedPeerLocator } from "./peer-locator.ts";
import { StaticClusterNetwork } from "./network.ts";

describe("DistributedPeerLocator", () => {
  it("merges local and remote results and caches remote lookups", async () => {
    const local = new InMemoryPeerLocator();
    local.register({ nodeId: "node-a", connId: "conn-local", peerId: "alice", groupId: "group-chat" });

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

    const first = await locator.find("alice", { groupId: "group-chat" });
    expect(first).toEqual([
      { nodeId: "node-a", connId: "conn-local", peerId: "alice", groupId: "group-chat" },
      { nodeId: "node-b", connId: "conn-remote", peerId: "alice" }
    ]);

    const second = await locator.find("alice", { groupId: "group-chat" });
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

  it("passes groupId and topology-scoped node ids into remote locate", async () => {
    const local = new InMemoryPeerLocator();
    let requestedUrl: string | undefined;
    let requestedBody: unknown;
    const fetchSpy = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(
        JSON.stringify({
          peers: {
            alice: [{ nodeId: "node-c", connId: "conn-remote", peerId: "alice", groupId: "group-chat" }]
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const network = new StaticClusterNetwork(
      [
        { nodeId: "node-b", baseUrl: "http://node-b.internal" },
        { nodeId: "node-c", baseUrl: "http://node-c.internal" }
      ],
      { nodeId: "node-a", fetchFn: fetchSpy as unknown as typeof fetch }
    );
    const locator = new DistributedPeerLocator(
      local,
      network,
      10_000,
      undefined,
      () => ["node-c"]
    );

    await locator.find("alice", { groupId: "group-chat" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(requestedUrl).toBe("http://node-c.internal/__cluster/locate");
    expect(requestedBody).toEqual({
      peerIds: ["alice"],
      groupId: "group-chat"
    });
  });
});
