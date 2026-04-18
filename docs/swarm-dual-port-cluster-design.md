# Hardess v1 Dual-Port Cluster And Swarm Design

## 1. Goal

This document fixes the intended v1 cluster deployment shape:

1. Hardess remains the gateway.
2. One Hardess node is still one process with one shared runtime state.
3. The runtime is split into two listeners:
   - `business`: client HTTP + client WebSocket ingress
   - `control`: admin endpoints + node-to-node transport + internal forwarding entry
4. Cluster node discovery supports two modes:
   - `config`: current static config-file / env mode
   - `swarm`: runtime node discovery backed by Docker Swarm networking

This is a deployment and networking evolution, not a protocol rewrite.

## 2. Naming Clarification

`business/control` is the runtime-level semantic split.

`public/internal` is only a deployment reachability property.

That distinction matters:

1. runtime should care about which listener serves business ingress vs
   control-plane / east-west traffic
2. whether a listener is internet-facing, private, or overlay-only should be
   decided by Swarm, LB, and network policy
3. older `public/internal` naming should be treated as a compatibility alias,
   not as the primary v1 design vocabulary

## 3. Why Change The Current Shape

Today the runtime uses one listen port and multiplexes all traffic by path:

1. business HTTP traffic
2. business WebSocket traffic at `/ws`
3. admin traffic at `/__admin/*`
4. control transport traffic at `/__cluster/*` and `/__cluster/ws`

That works functionally, but the network boundary is too loose:

1. user traffic and internal runtime traffic share one external surface
2. cluster traffic should stay on an internal network
3. upstream service HTTP / WS should also stay on an internal network
4. future Swarm deployment needs a clearer distinction between public ingress and internal east-west traffic

## 4. Current Runtime Facts

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

## 5. Target Networking Model

### 4.1 Traffic Classes

Hardess traffic is split into three classes:

1. business ingress
   - client HTTP requests
   - client WebSocket upgrades at `/ws`
2. control transport
   - host-agent to admin requests
   - `POST /__cluster/locate`
   - `POST /__cluster/deliver`
   - `POST /__cluster/handle-ack`
   - `GET /__cluster/ws`
   - `POST /__cluster/http-forward`
   - `GET /__cluster/ws-forward`
3. upstream service traffic
   - Hardess to upstream HTTP proxy traffic
   - Hardess to upstream WebSocket traffic

Only class 1 is business ingress.

Whether that listener is actually public or private is a deployment decision.

### 4.2 Dual-Listener Model

Each Hardess node should expose:

1. `BUSINESS_PORT`
   - business HTTP ingress
   - business `/ws`
2. `CONTROL_PORT`
   - `__admin/*`
   - `__cluster/*`
   - `__cluster/ws`
   - `__cluster/http-forward`
   - `__cluster/ws-forward`

The two listeners must share the same `RuntimeApp`.

### 4.3 Route Ownership

Business listener:

1. allow business HTTP paths
2. allow `/ws`
3. always reject `/__admin/*`
4. always reject `/__cluster/*`

Control listener:

1. allow `/__admin/*`
2. allow `/__cluster/*`
3. should carry node-to-node forward traffic such as `http-forward` /
   `ws-forward`
4. should not be treated as a client ingress endpoint

Recommended default:

1. business listener is the only client-facing ingress
2. control listener is for runtime operation and east-west traffic only
3. `/__admin/*` and `/__cluster/*` are reserved control-only routes and are not configurable onto the business listener

## 6. Why This Still Works For Cross-Node WebSocket Delivery

The current cross-node realtime path is already bridge-based:

1. client `A` connects to `node-a` via `/ws`
2. `node-a` resolves target ownership
3. `node-a` delivers to `node-b` over the control transport
4. `node-b` forwards into its local connection state and sends to `B`

This means the transport already has two different websocket classes:

1. external client sockets
2. control transport sockets

Dual-port does not change the runtime model. It only changes which listener accepts each socket class.

So the current queueing / ack / bridge model can be reused directly.

## 7. Cluster Peer Sources And Health Overlay

Hardess should treat cluster peers and cluster peer health as two different
layers.

Short version:

1. admin remains the source of truth for desired topology
2. runtime may still support local discovery backends for non-admin deployments
3. runtime health probing is only an overlay on top of admin-approved peers
4. future gossip extends that overlay; it does not become membership authority

Admin-driven runtime behavior:

1. when admin / host-agent mode is enabled, runtime should consume the
   admin-projected `topology.membership`
2. that projected membership should feed the same `ClusterPeerNode[]` shape used
   by the cluster transport
3. admin-projected placement and route ownership remain the only authority for
   owner selection and forward targets
4. gossip must not replace admin placement, route ownership, or host-group
   boundaries

Current health-overlay behavior:

1. the runtime passively observes control-channel success, failure, close, and
   request-timeout events
2. when `CLUSTER_TRANSPORT=ws`, the runtime actively probes admin-approved peers
   with WS `ping/pong`
3. missing probe responses mark a peer `suspect`; continued suspicion escalates
   to `dead` after `CLUSTER_PEER_SUSPECT_TIMEOUT_MS`
4. `dead` peers are locally skipped for locate probes and route forwarding until
   a fresh alive observation returns them to service

Future gossip mode:

1. primary dissemination should be rumor-style liveness updates among approved
   peers
2. anti-entropy should be a slower repair loop for missed updates, not the hot
   path
3. both modes remain constrained by the admin-projected peer set

### 7.1 `config` Mode

This is the current baseline.

Properties:

1. peers are provided explicitly by config or environment
2. each peer entry resolves to a node id plus control base URL
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

### 7.2 `swarm` Mode

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
3. the runtime builds control peer base URLs with `CONTROL_PORT`

Swarm mode replaces node discovery only. It does not replace:

1. `peerId -> ConnRef[]` resolution
2. `Dispatcher`
3. `deliver` / `handleAck` protocol behavior
4. SDK semantics

### 7.3 Gossip Health Overlay

The current runtime has started this as a WS health overlay and rumor path, but
it must still be treated as an enhancement to runtime health convergence, not as
a third control plane.

Its allowed responsibilities are:

1. faster `alive` / `suspect` / `dead` propagation between already-known nodes
2. faster endpoint or incarnation change propagation for already-known nodes
3. local cache invalidation and channel teardown when a known node degrades
4. health annotation used to filter or de-prioritize peer targets that admin has
   already approved

Its forbidden responsibilities are:

1. creating new cluster peers outside admin-projected membership
2. changing deployment placement
3. changing route ownership
4. redefining host-group boundaries
5. replacing admin as the source of truth for desired topology

Current implementation stage:

1. passive transport observations already update local peer health
2. active WS `ping/pong` probes already mark peers `alive` or `suspect`
3. health changes are now disseminated as rumor-style WS control messages
4. periodic anti-entropy repair now runs over the same WS control channel using per-peer incremental sync
5. connection re-establishment resets that peer's repair state so the next sync acts like a fresh baseline repair

Recommended runtime merge rule:

```text
effective peers
  = admin projected peers
  + gossip health annotation
```

Not:

```text
effective peers
  = gossip discovered peers
```

## 8. Swarm Topology

Recommended production topology:

```text
Internet
  |
  v
business entry
  |
  v
Hardess BUSINESS_PORT

Hardess CONTROL_PORT <--> Hardess CONTROL_PORT
Hardess ---> upstream internal HTTP / WS
```

In Swarm terms:

1. business ingress reaches `BUSINESS_PORT`
2. node-to-node control traffic reaches `CONTROL_PORT`
3. upstream services are addressed over internal overlay networking

The key boundary is:

1. control traffic must not traverse the business ingress path
2. upstream HTTP / WS traffic must not traverse the business ingress path either

## 9. Runtime Invariants

These invariants should remain true after the change.

1. one Hardess node has exactly one runtime state owner
2. both listeners share the same auth service, config store, peer locator, dispatcher, websocket runtime, metrics sink, and shutdown state
3. `connId` uniqueness is runtime-scoped, not port-scoped
4. readiness state is node-wide, not listener-specific
5. shutdown begins once per node and affects both listeners together

## 10. Operational Semantics

### 9.1 Readiness

Readiness should be node-wide:

1. when shutdown begins, the node flips not-ready once
2. business ingress should stop receiving new traffic
3. control calls should also stop admitting new work except for bounded drain behavior already required by the protocol

### 9.2 Shutdown

Shutdown remains a single node lifecycle:

1. stop new business websocket upgrades
2. stop new business HTTP work
3. stop admitting new cluster ingress
4. allow bounded drain for in-flight HTTP and existing websocket cleanup
5. close both listeners

### 9.3 Metrics And Admin

Admin and metrics should live on the control listener only by default.

Reason:

1. they are operational surfaces, not user-facing APIs

## 11. Suggested Config Model

The exact variable names can still change, but the shape should be:

```bash
BUSINESS_PORT=3000
CONTROL_PORT=3100

CLUSTER_DISCOVERY_MODE=config
CLUSTER_PEERS_JSON='[...]'

# or

CLUSTER_DISCOVERY_MODE=swarm
CLUSTER_SWARM_SERVICE_NAME=hardess-runtime
CLUSTER_SWARM_CONTROL_PORT=3100
CLUSTER_SWARM_REFRESH_MS=1000
```

Additional notes:

1. `CLUSTER_PEERS_JSON` entries should point to the control listener, not the business listener
2. `NODE_ID` may remain explicit in `config` mode
3. `swarm` mode may derive node identity from runtime startup metadata, but the cluster protocol still needs a stable node id per running task

## 12. Non-Goals

This change does not attempt to solve:

1. distributed durable routing state
2. global session registry
3. gossip replacing admin topology
4. automatic leader election
5. control-plane rollout or version management
6. protocol-level changes to the SDK

## 13. Migration Strategy

Recommended order:

1. keep the current single-port runtime working
2. introduce a dual-listener server with one shared `RuntimeApp`
3. move `__admin/*` and `__cluster/*` onto the control listener boundary
4. keep `config` membership mode as the default
5. add `swarm` membership mode as an optional second backend
6. validate shutdown, readiness, cluster WS delivery, and admin access behavior under dual-port deployment

## 14. Bottom Line

The intended v1 shape is:

1. Hardess stays the gateway
2. one node stays one process
3. one node keeps one shared connection-routing state space
4. the network boundary becomes dual-port
5. cluster peers can come from admin projection, static config, or Swarm-backed discovery
6. current probing and future gossip only overlay health on top of those approved peers

This keeps the current runtime model intact while making the deployment boundary correct.

For the concrete first Swarm deployment choice on top of this shape, see [swarm-v1-cluster-deployment.md](swarm-v1-cluster-deployment.md).
