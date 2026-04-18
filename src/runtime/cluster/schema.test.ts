import { describe, expect, it } from "bun:test";
import {
  parseClusterDeliverResponse,
  parseClusterLocateResponse,
  parseClusterPeersAdminResponse,
  parseClusterPeersEnv,
  parseClusterSocketMessage,
  parseClusterTransportEnv
} from "./schema.ts";

describe("cluster schema helpers", () => {
  it("parses cluster peers from env json through the shared schema path", () => {
    expect(
      parseClusterPeersEnv(
        JSON.stringify([
          {
            nodeId: "node-b",
            baseUrl: "http://node-b.internal"
          }
        ])
      )
    ).toEqual([
      {
        nodeId: "node-b",
        baseUrl: "http://node-b.internal"
      }
    ]);
  });

  it("rejects invalid cluster peers env json", () => {
    expect(() => parseClusterPeersEnv('{"nodeId":"node-b"}')).toThrow("Invalid CLUSTER_PEERS_JSON");
    expect(() => parseClusterPeersEnv('[{"nodeId":"","baseUrl":"http://node-b.internal"}]')).toThrow(
      "Invalid CLUSTER_PEERS_JSON"
    );
  });

  it("parses cluster transport env with ws default", () => {
    expect(parseClusterTransportEnv(undefined)).toBe("ws");
    expect(parseClusterTransportEnv("http")).toBe("http");
  });

  it("rejects invalid cluster transport env values", () => {
    expect(() => parseClusterTransportEnv("udp")).toThrow("Invalid CLUSTER_TRANSPORT: udp");
  });

  it("parses websocket cluster messages through schema", () => {
    expect(
      parseClusterSocketMessage(
        JSON.stringify({
          type: "handleAckResult",
          ref: "ref-1",
          ok: true
        })
      )
    ).toEqual({
      type: "handleAckResult",
      ref: "ref-1",
      ok: true
    });

    expect(
      parseClusterSocketMessage(
        JSON.stringify({
          type: "peerHealthRumor",
          peerNodeId: "node-b",
          status: "suspect",
          incarnation: 2
        })
      )
    ).toEqual({
      type: "peerHealthRumor",
      peerNodeId: "node-b",
      status: "suspect",
      incarnation: 2
    });

    expect(
      parseClusterSocketMessage(
        JSON.stringify({
          type: "peerHealthSync",
          rumors: [
            {
              peerNodeId: "node-b",
              status: "alive",
              incarnation: 4,
              lastAliveAt: 123
            }
          ]
        })
      )
    ).toEqual({
      type: "peerHealthSync",
      rumors: [
        {
          peerNodeId: "node-b",
          status: "alive",
          incarnation: 4,
          lastAliveAt: 123
        }
      ]
    });
  });

  it("parses cluster http/admin responses through shared schema helpers", () => {
    expect(
      parseClusterLocateResponse({
        ok: true,
        peers: {
          bob: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
        }
      })
    ).toEqual({
      peers: {
        bob: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
      }
    });

    expect(
      parseClusterDeliverResponse({
        ok: true,
        deliveredConns: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
      })
    ).toEqual({
      deliveredConns: [{ nodeId: "node-b", connId: "conn-1", peerId: "bob" }]
    });

    expect(
      parseClusterPeersAdminResponse({
        ok: true,
        nodeId: "node-a",
        transport: "ws",
        peers: [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }]
      })
    ).toEqual({
      nodeId: "node-a",
      transport: "ws",
      peers: [{ nodeId: "node-b", baseUrl: "http://node-b.internal" }]
    });
  });

  it("rejects invalid cluster http/admin responses", () => {
    expect(() => parseClusterLocateResponse({ peers: { bob: [{ nodeId: "node-b" }] } })).toThrow(
      "Invalid cluster locate response"
    );
    expect(() => parseClusterDeliverResponse({ deliveredConns: "not-an-array" })).toThrow(
      "Invalid cluster deliver response"
    );
    expect(() => parseClusterPeersAdminResponse({ nodeId: "", transport: "udp", peers: [] })).toThrow(
      "Invalid cluster peers response"
    );
  });
});
