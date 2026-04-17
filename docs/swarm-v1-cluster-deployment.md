# Hardess v1 Swarm Cluster Deployment Design

## 1. Scope

This document defines the concrete Swarm deployment shape for `hardess v1`.

It is intentionally narrower than the broader dual-port / membership design:

1. it covers the first production-oriented Swarm shape
2. it does not add dynamic membership code yet
3. it does not change protocol or SDK behavior
4. it keeps the current v1 runtime model: dual-port, single process, single shared state per node

## 2. Chosen Phase-1 Shape

Phase 1 chooses:

1. `Hardess` remains the gateway
2. one `Hardess` task per swarm node
3. static cluster peer list remains the runtime default
4. control plane renders cluster membership into config
5. Swarm is used for deployment, placement, restart, rollout, rollback, config, and secret distribution

This means:

1. Swarm manages where nodes run
2. control plane decides what the cluster membership should be
3. runtime still consumes a concrete node table

## 3. Design Goals

1. keep the current v1 runtime ownership model intact
2. expose only the business listener to external traffic
3. keep admin and cluster traffic on control addresses only
4. support both downstream HTTP and downstream WebSocket proxy traffic on internal networks
5. minimize deployment-time ambiguity around node identity and node-to-node addressing
6. make rollout and rollback operationally predictable

## 4. Non-Goals

This phase does not attempt to solve:

1. runtime-side Swarm service discovery
2. shared distributed session state
3. gossip or registry-backed membership
4. multi-region traffic management
5. active-active cross-cluster routing
6. separate edge gateway service

## 5. Why One Task Per Node

The key runtime invariant is:

1. one `Hardess` node owns one in-memory connection-routing state space

That state space includes:

1. `peerId -> ConnRef[]`
2. `connId -> connection state`
3. pending delivery / ack state
4. cluster channel state

Because of that, the first Swarm deployment should run:

1. exactly one `Hardess` task on each participating runtime node

The recommended Swarm mode is therefore:

1. `deploy.mode: global`

Why this is the right first choice:

1. stable operational mapping: one swarm node equals one `Hardess` runtime owner
2. simpler `NODE_ID` semantics
3. simpler host-port publishing
4. simpler external LB integration
5. avoids accidental multiple runtime owners on the same host

## 6. Service Topology

Phase 1 uses three service categories.

### 6.1 Hardess Runtime Service

Responsibilities:

1. business HTTP ingress
2. business `/ws`
3. business WebSocket proxy to downstream services
4. control admin endpoints
5. control cluster transport

Recommended shape:

1. one global service named for example `hardess-runtime`
2. scheduled only on labelled gateway/runtime nodes

### 6.2 Upstream Application Services

Responsibilities:

1. receive downstream HTTP proxy traffic from `Hardess`
2. receive downstream business WebSocket proxy traffic from `Hardess`

Recommended shape:

1. one or more replicated internal services
2. no public port publishing unless they truly need external access
3. reached by internal DNS / overlay names from `Hardess`

### 6.3 External Load Balancer

Responsibilities:

1. route internet traffic to the `Hardess` business port
2. health-check a business-safe readiness path if exposed, or use a private health path through control/internal networking
3. drain nodes before rollout if required by the environment

This can be:

1. cloud LB
2. hardware LB
3. internal L4/L7 gateway outside the Swarm stack

Phase 1 does not require a separate in-cluster edge service.

## 7. Network Topology

### 7.1 Traffic Classes

There are three traffic classes:

1. external client traffic
2. control node-to-node cluster traffic
3. internal `Hardess -> upstream` HTTP / WS traffic

### 7.2 Recommended Networks

Use at least:

1. external/public network path
2. private node-to-node network path
3. internal overlay service network

Recommended practical shape:

1. client traffic enters through an external LB and reaches node private or public addresses on `BUSINESS_PORT`
2. cluster traffic uses node private addresses on `CONTROL_PORT`
3. downstream HTTP / WS traffic from `Hardess` to app services uses an internal overlay network and service DNS names

### 7.3 Why Business And Control Paths Stay Separate

This separation protects:

1. `__admin/*`
2. `__cluster/*`
3. control observability surfaces
4. node-to-node transport behavior

It also keeps downstream service traffic off the public entry path.

## 8. Port Publishing Strategy

### 8.1 Business Port

Recommendation:

1. publish `BUSINESS_PORT` in `mode: host`
2. place an external LB in front of the participating nodes

Why:

1. `Hardess` is itself the gateway
2. WebSocket-heavy services benefit from stable node-level ingress paths
3. host publishing preserves a simpler mental model than Swarm routing mesh for a stateful gateway
4. one global task per node aligns naturally with one host-published business port per node

### 8.2 Control Port

Recommendation:

1. publish `CONTROL_PORT` in `mode: host` on the node private network only
2. do not expose it through the public LB
3. protect it with security groups, firewall rules, or private-subnet routing

Why this is chosen in phase 1:

1. static peer lists need stable addresses
2. node private IP + control host port is stable enough for the current control-plane-generated membership model
3. this avoids runtime-side dependency on dynamic service discovery in the first phase

Important consequence:

1. the control port is published, but it is still not a public endpoint in the intended deployment
2. network policy must enforce that only internal callers can reach it

## 9. Runtime Listener Model In Swarm

Each `Hardess` task runs:

1. `BUSINESS_PORT`
2. `CONTROL_PORT`

Listener behavior remains:

1. `business` accepts business HTTP, `/ws`, and business WS proxy paths
2. `control` accepts `__admin/*`, `__cluster/*`, and node-to-node forwarding entrypoints
3. `__admin/*` and `__cluster/*` are always control-only

The runtime remains:

1. one process
2. one `RuntimeApp`
3. one shared runtime state

## 10. Node Identity

Each runtime task needs a stable `NODE_ID`.

Recommended first choice:

1. derive `NODE_ID` from the Swarm node identity, typically the node hostname

This is practical because Docker supports Go-template placeholders for `docker service create` / `update` flags including `--env`, `--hostname`, and `--mount`. Valid placeholders include `.Node.ID` and `.Node.Hostname`. Source: Docker Docs on Swarm service templates.

Recommended operational rule:

1. use a stable human-readable node hostname as the primary `NODE_ID`
2. keep that hostname lifecycle under infrastructure control

## 11. Cluster Membership Source

Phase 1 keeps:

1. `CLUSTER_PEERS_JSON`

But changes how it is produced:

1. control plane renders the peer list from the intended gateway nodes
2. each peer entry points to the node private address plus `CONTROL_PORT`

Example:

```json
[
  { "nodeId": "gw-a", "baseUrl": "http://10.0.1.11:3100" },
  { "nodeId": "gw-b", "baseUrl": "http://10.0.1.12:3100" },
  { "nodeId": "gw-c", "baseUrl": "http://10.0.1.13:3100" }
]
```

This file should be distributed to the service as:

1. a Swarm config
2. or an env value rendered by deployment tooling

Recommended first choice:

1. use a versioned Swarm config file

Reason:

1. easier review and rollback than embedding a long JSON string directly in stack YAML

## 12. Secrets And Configs

Recommended Swarm primitives:

1. `docker config` for rendered runtime config files
2. `docker secret` for cluster shared secret and future auth credentials

Expected items:

1. `hardess.config.ts`
2. rendered cluster peer config
3. `CLUSTER_SHARED_SECRET`
4. future real auth provider credentials

Docker configs are immutable and versionable, which fits rollout and rollback well. Source: Docker Docs on Swarm configs.

## 13. Placement Strategy

Recommended node labels:

1. `node.labels.hardess.gateway=true`
2. `node.labels.hardess.business=true`
3. `node.labels.hardess.control=true`

Use placement constraints so the runtime lands only on intended nodes.

This matters because:

1. `Hardess` is not a generic app task
2. it owns ingress ports and runtime connection state
3. placement should be intentional, not best-effort

## 14. Downstream Service Access

Phase 1 downstream services should be reached through internal service names.

Examples:

1. HTTP downstream: `http://orders-api:8080`
2. WS downstream: `ws://events-api:8080`

This keeps:

1. downstream HTTP off the business ingress network
2. downstream business WS off the business ingress network

It also means:

1. `Hardess` remains the only public gateway in the first phase

## 15. Update And Rollback Strategy

### 15.1 Chosen Update Shape

Recommended first choice:

1. rolling update
2. `parallelism: 1`
3. small delay between nodes
4. failure action: rollback
5. update order: `stop-first`

Why `stop-first` is the safer first choice:

1. the service uses host-published ports
2. with one runtime task per node, starting a second task first on the same node can conflict on port ownership
3. `Hardess` already has readiness-drop plus drain logic, so stop-first can still be operationally safe with multi-node LB protection

Docker supports `update-order` and `rollback-order` controls on services. Source: Docker Docs for `docker service update`.

### 15.2 How To Keep Stop-First Safe

Operational rules:

1. never run a single-node production cluster
2. use at least two gateway nodes, preferably three
3. remove or drain a node from external LB rotation before or during rollout if the environment requires stricter connection protection
4. rely on `Hardess` readiness and shutdown drain behavior to reduce disruption

### 15.3 Rollback

Recommendation:

1. rollback should use the same node-at-a-time strategy
2. restore both image version and config/secret versions together
3. treat config drift and image drift as one release unit

## 16. Health, Readiness, And Draining

Required health surfaces:

1. `GET /__admin/health`
2. `GET /__admin/ready`
3. `GET /__admin/metrics`
4. `GET /__admin/metrics/prometheus`

Swarm itself is not enough here.

Operational expectation:

1. runtime becomes not-ready before exit
2. business new traffic must stop before process stop
3. existing websocket and in-flight HTTP work must receive bounded drain behavior

## 17. Manager And Quorum Guidance

Swarm managers should follow the usual operational rule:

1. use an odd number of managers, typically three or five

Docker documents that manager quorum is required for cluster management operations. Existing tasks may keep running, but management operations are affected if quorum is lost.

For this design:

1. keep managers separate from gateway sizing concerns
2. do not couple runtime capacity planning to manager count

## 18. Why Routing Mesh Is Not The First Choice

Swarm routing mesh is useful, but it is not the preferred first choice here.

Reasons:

1. `Hardess` is already the gateway and wants direct node-level identity
2. websocket-heavy ingress benefits from clearer node ownership
3. cluster peer addressing in phase 1 wants concrete node private addresses
4. external LB plus host publish is easier to reason about operationally

This is a deliberate design choice, not a statement that routing mesh is unusable.

## 19. Recommended Stack Skeleton

The first stack should conceptually look like:

1. `hardess-runtime`
   - global mode
   - constrained to gateway nodes
   - host-published `BUSINESS_PORT`
   - host-published `CONTROL_PORT`
   - attached to internal service overlay network
2. `upstream-*`
   - replicated mode
   - internal-only
   - attached to the same internal service overlay network
3. external LB
   - outside stack responsibility
   - points only at `BUSINESS_PORT`

## 20. Remaining Work Outside This Design

These items still exist, but they do not block the Swarm design itself:

1. real `AuthProvider` integration
2. dedicated upstream WebSocket benchmark / release-gate coverage
3. runtime-side `swarm` discovery mode implementation
4. final production stack YAML and deployment automation

## 21. Bottom Line

The recommended first Swarm deployment for `hardess v1` is:

1. `Hardess` stays the gateway
2. one global runtime task per gateway node
3. `BUSINESS_PORT` is host-published behind an external LB
4. `CONTROL_PORT` is host-published on private node addresses only
5. cluster membership is still rendered by control plane into `CLUSTER_PEERS_JSON`
6. downstream HTTP and downstream WS traffic stay on internal networks
7. rollout is node-at-a-time with stop-first plus readiness/drain protection

This gets the system onto Swarm without disturbing the v1 runtime ownership model.
