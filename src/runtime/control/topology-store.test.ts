import { describe, expect, it } from "bun:test";
import { RuntimeTopologyStore } from "./topology-store.ts";

describe("RuntimeTopologyStore", () => {
  it("resolves the longest matching http route target and prefers ready hosts", () => {
    const store = new RuntimeTopologyStore();
    store.setTopology({
      membership: {
        revision: "topology:1:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            groupId: "group-chat",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-b",
            groupId: "group-chat",
            nodeId: "node-b",
            internalBaseUrl: "http://node-b.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:1:placement",
        generatedAt: 1,
        deployments: [
          {
            deploymentId: "deployment:shared",
            deploymentKind: "http_worker",
            ownerHostIds: ["host-a", "host-b"],
            routes: [
              {
                routeId: "route:shared",
                pathPrefix: "/demo",
                ownerHostIds: ["host-a", "host-b"]
              },
              {
                routeId: "route:host-b",
                pathPrefix: "/demo/hosts/host-b",
                ownerHostIds: ["host-b"]
              }
            ]
          }
        ]
      }
    });

    expect(
      store.resolveHttpRouteTarget({
        pathname: "/demo/hosts/host-b/orders",
        selfNodeId: "node-a",
        traceKey: "trace-1"
      })
    ).toEqual({
      hostId: "host-b",
      nodeId: "node-b",
      baseUrl: "http://node-b.internal",
      pathPrefix: "/demo/hosts/host-b",
      routeId: "route:host-b"
    });
  });

  it("projects cluster peers from membership topology", () => {
    const store = new RuntimeTopologyStore();
    store.setTopology({
      membership: {
        revision: "topology:2:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-b",
            nodeId: "node-b",
            internalBaseUrl: "http://node-b.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "offline",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-c",
            groupId: "group-chat",
            nodeId: "node-c",
            publicBaseUrl: "http://node-c.public",
            publicListenerEnabled: true,
            internalListenerEnabled: false,
            state: "draining",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:2:placement",
        generatedAt: 1,
        deployments: []
      }
    });

    expect(store.listClusterPeers("node-a")).toEqual([
      { nodeId: "node-c", baseUrl: "http://node-c.public" }
    ]);
  });

  it("narrows cluster peers by membership host groupId when provided", () => {
    const store = new RuntimeTopologyStore();
    store.setTopology({
      membership: {
        revision: "topology:3:membership",
        generatedAt: 1,
        hosts: [
          {
            hostId: "host-a",
            groupId: "group-chat",
            nodeId: "node-a",
            internalBaseUrl: "http://node-a.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-b",
            groupId: "group-other",
            nodeId: "node-b",
            internalBaseUrl: "http://node-b.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          },
          {
            hostId: "host-c",
            groupId: "group-chat",
            nodeId: "node-c",
            internalBaseUrl: "http://node-c.internal",
            publicListenerEnabled: true,
            internalListenerEnabled: true,
            state: "ready",
            staticLabels: {},
            staticCapabilities: [],
            staticCapacity: {}
          }
        ]
      },
      placement: {
        revision: "topology:3:placement",
        generatedAt: 1,
        deployments: []
      }
    });

    expect(store.listClusterPeerNodeIds("node-a", { groupId: "group-chat" })).toEqual(["node-c"]);
    expect(store.listClusterPeerNodeIds("node-a", { groupId: undefined })).toEqual([]);
    expect(store.listClusterPeerNodeIds("node-a", { groupId: "group-missing" })).toEqual([]);
    expect(store.listClusterPeerNodeIds("node-a")).toEqual(["node-b", "node-c"]);
  });
});
