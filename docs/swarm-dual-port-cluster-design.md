# Hardess v1 Dual-Port Cluster And Swarm Design

## 1. Goal

This document fixes the intended v1 cluster deployment shape:

1. Hardess remains the gateway.
2. One Hardess node is still one process with one shared runtime state.
3. The runtime is split into two listeners:
   - `public`: external HTTP + external WebSocket ingress
   - `internal`: admin endpoints + node-to-node cluster transport
4. Cluster node discovery supports two modes:
   - `config`: current static config-file / env mode
   - `swarm`: runtime node discovery backed by Docker Swarm networking

This is a deployment and networking evolution, not a protocol rewrite.

## 2. Why Change The Current Shape

Today the runtime uses one listen port and multiplexes all traffic by path:

1. public HTTP traffic
2. public WebSocket traffic at `/ws`
3. admin traffic at `/__admin/*`
4. internal cluster traffic at `/__cluster/*` and `/__cluster/ws`

That works functionally, but the network boundary is too loose:

1. user traffic and internal runtime traffic share one external surface
2. cluster traffic should stay on an internal network
3. upstream service HTTP / WS should also stay on an internal network
4. future Swarm deployment needs a clearer distinction between public ingress and internal east-west traffic

## 3. Current Runtime Facts

The current design already has the core property needed for dual-port operation:

1. client WebSocket connections and cluster WebSocket channels are already handled inside one `RuntimeApp`
2. local peer-to-connection indexes are in process memory
3. cross-node delivery is already a runtime-level bridge rather than byte-stream passthrough

So the important invariant is not "single port". The important invariant is:

1. one Hardess node = one process = one shared mapping space

The mapping space includes:

1. `peerId -> ConnRef[]`
2. `connId -> connection state`
3. pending ack / delivery state
4. cluster channel state

Because of that, the acceptable shape is:

1. dual-port
2. single process
3. single shared state

The unacceptable shape is:

1. public gateway process
2. internal cluster process
3. duplicated or externally synchronized connection state

That would split the in-memory ownership model and create avoidable complexity.

## 4. Target Networking Model

### 4.1 Traffic Classes

Hardess traffic is split into three classes:

1. external ingress
   - client HTTP requests
   - client WebSocket upgrades at `/ws`
2. internal cluster traffic
   - `POST /__cluster/locate`
   - `POST /__cluster/deliver`
   - `POST /__cluster/handle-ack`
   - `GET /__cluster/ws`
3. internal upstream traffic
   - Hardess to upstream HTTP proxy traffic
   - Hardess to upstream WebSocket traffic

Only class 1 should be exposed to the public network.

### 4.2 Dual-Listener Model

Each Hardess node should expose:

1. `PUBLIC_PORT`
   - public HTTP business traffic
   - public `/ws`
2. `INTERNAL_PORT`
   - `__admin/*`
   - `__cluster/*`
   - `__cluster/ws`

The two listeners must share the same `RuntimeApp`.

### 4.3 Route Ownership

Public listener:

1. allow business HTTP paths
2. allow `/ws`
3. always reject `/__admin/*`
4. always reject `/__cluster/*`

Internal listener:

1. allow `/__admin/*`
2. allow `/__cluster/*`
3. may allow business HTTP only if there is a specific internal-use reason
4. should not be treated as a public client ingress endpoint

Recommended default:

1. public listener is the only client-facing ingress
2. internal listener is for runtime operation and east-west traffic only
3. `/__admin/*` and `/__cluster/*` are reserved internal-only routes and are not configurable onto the public listener

## 5. Why This Still Works For Cross-Node WebSocket Delivery

The current cross-node realtime path is already bridge-based:

1. client `A` connects to `node-a` via `/ws`
2. `node-a` resolves target ownership
3. `node-a` delivers to `node-b` over the internal cluster transport
4. `node-b` forwards into its local connection state and sends to `B`

This means the transport already has two different websocket classes:

1. external client sockets
2. internal cluster sockets

Dual-port does not change the runtime model. It only changes which listener accepts each socket class.

So the current queueing / ack / bridge model can be reused directly.

## 6. Cluster Membership Modes

Hardess should support two membership modes.

### 6.1 `config` Mode

This is the current baseline.

Properties:

1. peers are provided explicitly by config or environment
2. each peer entry resolves to a node id plus internal base URL
3. this is static membership, not dynamic discovery

Example shape:

```json
[
  { "nodeId": "node-a", "baseUrl": "http://10.0.0.11:3100" },
  { "nodeId": "node-b", "baseUrl": "http://10.0.0.12:3100" }
]
```

Important note:

1. this is a node table, not a `peerId -> nodeId` table
2. business peer ownership is still resolved dynamically by `PeerLocator`

### 6.2 `swarm` Mode

This adds a second source for node discovery.

Properties:

1. Swarm is used only for runtime-node discovery
2. Swarm does not replace business routing or `PeerLocator`
3. Swarm membership should feed the same `ClusterPeerNode[]` shape consumed by the cluster transport

Recommended source:

1. resolve task instances through Swarm DNS, not through Docker manager API access from the runtime

Why:

1. keeps runtime and control plane separated
2. avoids Docker socket or manager credentials in the runtime container
3. reduces platform coupling
4. keeps the runtime portable

Recommended requirement:

1. the runtime service uses `endpoint_mode: dnsrr`
2. the runtime discovers task IPs behind `tasks.<service-name>`
3. the runtime builds internal peer base URLs with `INTERNAL_PORT`

Swarm mode replaces node discovery only. It does not replace:

1. `peerId -> ConnRef[]` resolution
2. `Dispatcher`
3. `deliver` / `handleAck` protocol behavior
4. SDK semantics

## 7. Swarm Topology

Recommended production topology:

```text
Internet
  |
  v
public entry
  |
  v
Hardess PUBLIC_PORT

Hardess INTERNAL_PORT <--> Hardess INTERNAL_PORT
Hardess INTERNAL_PORT ---> upstream internal HTTP / WS
```

In Swarm terms:

1. public traffic reaches `PUBLIC_PORT`
2. node-to-node cluster traffic reaches `INTERNAL_PORT`
3. upstream services are addressed over internal overlay networking

The key boundary is:

1. internal cluster traffic must not traverse the public entry path
2. upstream HTTP / WS traffic must not traverse the public entry path either

## 8. Runtime Invariants

These invariants should remain true after the change.

1. one Hardess node has exactly one runtime state owner
2. both listeners share the same auth service, config store, peer locator, dispatcher, websocket runtime, metrics sink, and shutdown state
3. `connId` uniqueness is runtime-scoped, not port-scoped
4. readiness state is node-wide, not listener-specific
5. shutdown begins once per node and affects both listeners together

## 9. Operational Semantics

### 9.1 Readiness

Readiness should be node-wide:

1. when shutdown begins, the node flips not-ready once
2. public ingress should stop receiving new traffic
3. internal cluster calls should also stop admitting new work except for bounded drain behavior already required by the protocol

### 9.2 Shutdown

Shutdown remains a single node lifecycle:

1. stop new public websocket upgrades
2. stop new public HTTP work
3. stop admitting new cluster ingress
4. allow bounded drain for in-flight HTTP and existing websocket cleanup
5. close both listeners

### 9.3 Metrics And Admin

Admin and metrics should live on the internal listener only by default.

Reason:

1. they are operational surfaces, not user-facing APIs

## 10. Suggested Config Model

The exact variable names can still change, but the shape should be:

```bash
PUBLIC_PORT=3000
INTERNAL_PORT=3100

CLUSTER_DISCOVERY_MODE=config
CLUSTER_PEERS_JSON='[...]'

# or

CLUSTER_DISCOVERY_MODE=swarm
CLUSTER_SWARM_SERVICE_NAME=hardess-runtime
CLUSTER_SWARM_INTERNAL_PORT=3100
CLUSTER_SWARM_REFRESH_MS=1000
```

Additional notes:

1. `CLUSTER_PEERS_JSON` entries should point to the internal listener, not the public listener
2. `NODE_ID` may remain explicit in `config` mode
3. `swarm` mode may derive node identity from runtime startup metadata, but the cluster protocol still needs a stable node id per running task

## 11. Non-Goals

This change does not attempt to solve:

1. distributed durable routing state
2. global session registry
3. gossip membership
4. automatic leader election
5. control-plane rollout or version management
6. protocol-level changes to the SDK

## 12. Migration Strategy

Recommended order:

1. keep the current single-port runtime working
2. introduce a dual-listener server with one shared `RuntimeApp`
3. move `__admin/*` and `__cluster/*` onto the internal listener boundary
4. keep `config` membership mode as the default
5. add `swarm` membership mode as an optional second backend
6. validate shutdown, readiness, cluster WS delivery, and admin access behavior under dual-port deployment

## 13. Bottom Line

The intended v1 shape is:

1. Hardess stays the gateway
2. one node stays one process
3. one node keeps one shared connection-routing state space
4. the network boundary becomes dual-port
5. cluster node discovery supports both static config and Swarm-backed discovery

This keeps the current runtime model intact while making the deployment boundary correct.
