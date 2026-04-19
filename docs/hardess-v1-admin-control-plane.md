# Hardess v1 Admin / Control Plane Design

## 1. Scope

This document is about the current `hardess v1` line.

It applies to:

- the existing Bun-based runtime
- the current HTTP worker + WebSocket service hosting model
- the current dual-port and Swarm-oriented deployment direction

It does not assume:

- the Pingora experiment
- a Rust runtime rewrite
- the `v2` experimental workspace

The goal here is to define the right control-plane boundary for `v1`, not to
change the runtime kernel.

## 2. Core Decision

`Hardess Admin` should be the control plane.

`Hardess Runtime` should be the data-plane host.

Short version:

- admin owns desired state and version history
- runtime registers, reconciles, executes, drains, and reports

This means the runtime should gradually evolve away from "local config is the
source of truth" and toward "admin-declared desired state is the source of
truth", while keeping the current `v1` runtime architecture intact.

## 3. Why This Is The Right v1 Direction

If the runtime owns version choice, rollout scope, or rollback policy, the
system gets the wrong boundary.

That causes avoidable problems:

- nodes can drift into different worker or config versions
- rollback becomes a local imperative action instead of a controlled fleet action
- audit trails become weak
- business configuration and runtime lifecycle become mixed together

The current `v1` runtime is already close to a host model:

- one process owns listeners and connection state
- one node owns in-memory routing and session state
- one node may eventually host multiple runtime assignments over time

So the correct next step is not "more local runtime mutability".

It is "stronger control-plane / runtime separation".

## 4. Runtime Role In v1

For `v1`, `Hardess Runtime` should be treated as a host-level node agent.

It is closer to:

- a Ray-style serving host
- a Kubernetes-style node-side reconciler

It is not primarily:

- a business service with business config hard-coded at startup
- a local tool that decides what version should run

So the runtime should be good at:

- bootstrapping with identity and credentials
- registering to admin
- receiving desired state
- preparing local runtime inputs
- activating only after prepare succeeds
- draining previous in-flight work
- exposing health, readiness, metrics, and observed state

It should not be good at:

- version governance
- rollout policy
- rollback policy
- global assignment decisions

## 5. Version Versus Generation

These two concepts must stay separate.

`Version` means:

- admin-owned release meaning
- worker / service-module publication history
- audit and rollback identity

`Generation` means:

- one node-local prepared execution snapshot
- one local active or draining runtime state
- one runtime convergence step

So:

- admin owns versions
- runtime owns generations

The runtime may store and report source metadata such as:

- `declared_version`
- `declared_artifact_id`
- `source_uri`
- `digest`

But that does not make the runtime a version authority.

## 6. Deployment Model For Worker / Service Module

Worker and `serviceModule` publication should follow a deployment model closer
to `Kubernetes` or `Ray Serve`, not a global config-broadcast model.

This must be treated as a fixed design direction for `v1`.

Short version:

- publish a deployment
- declare replica count
- let admin assign replicas to a subset of hosts
- let each host reconcile only its own assignments

This means:

- publishing a worker does not imply every `Hardess` host loads it
- publishing a `serviceModule` does not imply every `Hardess` host loads it
- admin is responsible for placement
- runtime is responsible for local convergence

Example:

- there are 10 `Hardess` hosts
- a worker deployment asks for `replicas = 2`
- admin assigns it to `host-3` and `host-7`
- only those two hosts load and activate it

That is the intended model.

## 7. Global Deployment Versus Host Projection

The control-plane model should have three layers.

### 7.1 Deployment

Global object.

Examples:

- HTTP worker deployment
- WebSocket `serviceModule` deployment

It contains things such as:

- artifact identity
- declared version
- replica count
- routing or exposure metadata
- auth policy reference

### 7.2 Assignment

Scheduling result.

It answers:

- which hosts should carry this deployment
- which deployment instance is expected on which host

### 7.3 Desired host state

Per-host projection.

It answers:

- what this specific host should be running right now

So `DesiredHostState` is not a globally shared config blob.

It is the single-host projection of global deployment plus placement decisions.

### 7.4 Topology

There is one more layer that must stay separate from assignment:

- `membership`: which hosts exist, where they are, and whether they are `ready`,
  `draining`, or `offline`
- `placement`: which deployments currently have owners on which hosts

This is not the same as hot runtime connection state.

So the split for `v1` is:

- admin owns `deployment`, `assignment`, `membership`, and `placement`
- runtime owns hot `connId -> hostId` knowledge and peer-to-peer locate behavior

That means admin should distribute slow-changing topology projections, while
runtime continues to discover hot connection location at runtime.

### 7.5 Gossip As A Runtime Health Overlay

Future gossip support must not change the control-plane ownership model above.

The fixed rule for `v1` is:

- admin remains the only authority for desired state
- admin remains the only authority for deployment, assignment, membership
  projection, placement, route ownership, and group scope
- runtime continues to reconcile the admin-projected `DesiredHostState`
- gossip must not publish, mutate, or override admin desired state
- gossip must not decide route owners or deployment placement

If added, gossip is only a data-plane enhancement on top of the admin
projection. Its job is to annotate admin-approved nodes with faster local
liveness and endpoint observations.

Recommended mental model:

```text
admin projected topology
  + gossip observed health
  = effective runtime peer view
```

Not:

```text
gossip membership
  = control-plane topology
```

The effective runtime peer view should therefore be constrained by admin:

- a node absent from admin-projected membership must not become routable because
  gossip saw it
- a node that gossip marks `dead` or `suspect` may be skipped, degraded, or have
  local caches invalidated
- a node that gossip marks `alive` should only be considered if admin has already
  projected it into the relevant host group and route scope

This keeps route governance centralized while still allowing the data plane to
react faster to node failure, reconnects, and endpoint changes.

Current implementation stage:

- stage 1 is a SWIM-ish health overlay, not full distributed membership
- it combines passive transport observations with active WS `ping/pong` probes
- it now also disseminates health changes as rumor-style WS control messages
- it periodically exchanges peer-health digests, requests targeted repair for
  missing or older entries, and replies with exact rumor snapshots
- it may temporarily prefer healthy nodes over `suspect` nodes and locally skip
  `dead` nodes
- it still does not spread durable membership state or override admin route
  ownership

Recommended future evolution:

- primary mode: rumor-style health dissemination between already approved peers
- fallback mode: periodic digest-based anti-entropy repair for missed liveness
  updates; digests only summarize state, and repair responses carry the exact
  requested rumor snapshots
- hard boundary: both modes stay scoped to health annotation, never desired
  topology ownership

## 8. Desired Host State

The long-term `v1` control contract should therefore be host-oriented.

Do not model the runtime as a pile of point mutations such as:

- activate one worker
- reload one module
- patch one route
- patch auth in place

Prefer one declarative desired host state derived from admin scheduling.

Recommended direction:

```ts
type DesiredHostState = {
  host_id: string;
  revision: string;
  generated_at: number;
  assignments: Array<{
    assignment_id: string;
    deployment_id: string;
    deployment_kind: "http_worker" | "service_module" | "serve";
    group_id?: string;
    declared_version: string;
    declared_artifact_id?: string;
    artifact: {
      source_uri: string;
      digest?: string;
    };
    http_worker?: {
      name: string;
      entry: string;
      route_refs?: string[];
    };
  service_module?: {
    name: string;
    entry: string;
    protocol_package: {
      protocol: string;
      version: string;
      actions: string[];
      digest: string;
    };
  };
    serve_app?: {
      name: string;
      entry: string;
      route_refs?: string[];
      deployment?: {
        config?: Record<string, unknown>;
        bindings?: Record<string, unknown>;
        secrets?: Record<string, string>;
      };
    };
    auth_policy_ref?: string;
    secret_refs?: string[];
  }>;
  topology?: {
    membership: {
      revision: string;
      generated_at: number;
      hosts: Array<{
        host_id: string;
        node_id?: string;
        public_base_url?: string;
        internal_base_url?: string;
        public_listener_enabled: boolean;
        internal_listener_enabled: boolean;
        state: "ready" | "draining" | "offline";
      }>;
    };
    placement: {
      revision: string;
      generated_at: number;
      deployments: Array<{
        deployment_id: string;
        deployment_kind: "http_worker" | "service_module" | "serve";
        group_id?: string;
        owner_host_ids: string[];
        routes: Array<{
          route_id: string;
          path_prefix: string;
          owner_host_ids: string[];
        }>;
      }>;
    };
  };
  shared_http_forward_config?: {
    routes: unknown[];
  };
}
```

The exact schema can evolve.

The important point is:

- admin publishes global deployments
- admin chooses placement by replica count and host state
- admin also distributes the slow-changing topology snapshot relevant to that host group
- each host receives only its own assignments
- runtime reconciles one coherent host-local desired state
- `group_id` is an explicit grouping field carried by deployment / assignment /
  placement, while host registration also carries the host's own group; `v1`
  does not add a separate `service + selector` object model
- admin is global across many groups, but one runtime host belongs to exactly
  one group chosen at startup by `HOST_GROUP_ID`
- runtime does not let clients choose their own group; WebSocket locate /
  fanout and host-to-host forwarding inherit the host group boundary
- runtime can use `placement.routes` to forward HTTP requests to the correct
  owner host when the current host is not assigned that route
- runtime can use the same route ownership to forward business WebSocket upgrade
  traffic to the correct owner host over the control listener
- runtime can use the same topology snapshot as the search scope for peer locate
- cutover happens at a generation boundary

## 9. Build-Time SDK Versus Runtime Artifact

Two things must not be mixed.

### 9.1 Build-time SDK

This is for:

- admin-side tooling
- publish pipelines
- mock services
- external integration services

This SDK can be consumed by:

- `git` dependency during early development
- later `npm` or `jsr` publication if needed

Its job is to provide:

- shared types and schemas
- admin API clients
- artifact-manifest types
- mock-friendly client interfaces

This is a build-time dependency.

It is not the runtime artifact format.

### 9.2 Runtime Artifact

This is what admin delivers to runtime as part of desired host state.

Examples:

- HTTP worker code
- WebSocket service-module code
- runtime-consumed manifests and metadata

The runtime then owns:

- dependency prepare
- local cache population
- validation
- warmup
- activation
- draining

The runtime is responsible for dependency preparation.

It is not responsible for version governance.

## 10. SDK Design Principle For v1

The admin SDK should be designed for two realities:

1. near-term work may only have `admin + mock service`
2. longer-term runtime shape is host-style, not embedded-app-style

So the SDK should be:

- transport-neutral
- mock-first
- host-oriented

Recommended split:

### 10.1 Contract layer

Contains:

- types
- schemas
- error shapes
- manifest definitions

No network side effects.

### 10.2 Transport interface layer

Contains an abstract client boundary, for example:

```ts
interface AdminTransport {
  request<TReq, TRes>(operation: string, payload: TReq): Promise<TRes>;
}
```

### 10.3 Adapter layer

Contains:

- real HTTP adapter
- in-memory mock adapter
- record/replay adapter if needed later

With this split, the same SDK contract can be used by:

- real admin integration
- local mock integration
- tests
- publish tooling

## 11. Host-Oriented Runtime API Shape

The runtime-facing admin contract should be host-oriented, not worker-oriented.

Bad direction:

- `activateWorker(workerId)`
- `reloadServiceModule(name)`
- `scaleWorkerLocally(workerId, replicas)`

Better direction:

- `registerHost(...)`
- `heartbeatHost(...)`
- `getDesiredHostState(hostId)`
- `reportObservedHostState(...)`
- `fetchArtifact(...)`

That keeps the runtime in a reconcile loop:

1. register host
2. learn desired host state
3. prepare next local generation
4. activate and drain
5. report observed host state

This is important because one host may eventually run:

- zero or more HTTP worker assignments
- zero or more `serviceModule` assignments
- multiple listeners
- many concurrent sessions

So the runtime-side contract must not encode a one-worker-per-host assumption.

## 12. Admin + Mock First

For the next integration stage, assume the real upstream service may not exist
yet.

So the SDK and protocol must make these easy:

- inject a mock transport
- return deterministic fake desired state
- simulate prepare / activate / fail transitions
- simulate retryable and terminal failures
- validate payloads with the same schemas as the real client

The point is to verify contracts before the full system exists.

## 13. Authoring UX For Worker / Service Module

For `v1`, worker or service-module authoring can move toward a more declarative
style, but runtime ABI should stay explicit.

Recommended approach:

- use explicit definition helpers as the real contract
- allow decorator-like syntax later only as sugar

Good direction:

```ts
export default defineWorker({
  name: "demo-http",
  routes: ["/demo"],
  fetch(request, env, ctx) {
    return new Response("ok");
  }
});
```

Possible future sugar:

```ts
@worker({ name: "demo-http", routes: ["/demo"] })
export class DemoWorker {}
```

But the runtime should ultimately consume the explicit object-model form, not
depend on decorator semantics.

This authoring style should fit the deployment model above:

- author code declares what one worker or `serviceModule` is
- admin publishes it as a deployment object
- admin scales it by replica count
- admin assigns it onto a subset of hosts

For the current `v1` runtime, the concrete execution ABI now diverges by
protocol surface, but not by deployment lifecycle:

- `http_worker` exports `fetch(request, env, ctx)`
- `serve` is the standard business-facing HTTP deployment abstraction
- runtime adapts `serve` to the same `fetch(request, env, ctx)` worker ABI
  internally, so `worker` remains the low-level runtime primitive
- `serviceModule` exports the explicit `ServerProtocolModule` object shape:
- `serviceModule` is published together with a bound protocol package:

```ts
export default {
  protocol: "chat",
  version: "1.0",
  actions: {
    send: {
      validate(ctx) {},
      authorize(ctx) {},
      handleLocally(ctx) {
        if (ctx.payload.auditOnly) {
          return { ack: "handle" };
        }
      },
      resolveRecipients(ctx) {
        return [ctx.payload.toPeerId];
      },
      buildDispatch(ctx) {
        return {
          action: "message",
          payload: {
            fromPeerId: ctx.auth.peerId,
            content: ctx.payload.content
          },
          ack: "handle"
        };
      }
    }
  }
};
```

That means `serviceModule` is aligned with `http_worker` at the control-plane
layer, but its runtime activation path is "stage artifact -> load module ->
validate against the bound protocol package -> register protocol actions into
the WebSocket registry", not "compile into HTTP pipeline config".

Binding rule for `v1`:

- admin publishes the protocol package and the implementation together in one
  assignment
- the bound protocol package carries its own digest so publish / rollback can be
  pinned to a stable contract identity
- runtime must reject a module whose exported `protocol`, `version`, or action
  set does not exactly match the bound package
- the module may not widen its action surface beyond the bound package
- version bumps require a new package binding, not an in-place mutation
- the package digest should be computed from the normalized package payload so
  action ordering does not change the contract identity

For HTTP specifically, the current `v1` layering is therefore:

- `worker` is the lowest-level runtime primitive
- `serve` is the standard authoring and deployment form for one HTTP service
- admin still deploys and scales both through the same deployment / assignment
  lifecycle

### 13.1 `serve` Deployment Model

`serve` should move toward a Ray Serve-style deployment model while still
running on the existing worker ABI.

The standard `serve` shape is:

```ts
export default defineServe({
  deployment: class OrderServe {
    private readonly region: string;

    constructor(ctx) {
      this.region = String(ctx.config.region);
    }

    getOrder(_request, _env, ctx) {
      return Response.json({
        id: ctx.params.id,
        region: this.region
      });
    }
  },
  routes: [
    { method: "GET", path: "/orders/:id", handler: "getOrder" }
  ]
});
```

Rules:

- one `serve` assignment / replica owns exactly one instance
- one `serve` may expand into multiple HTTP route pipelines internally, but all
  of those pipelines must share that same instance
- runtime-generated pipelines should therefore carry the assignment identity as
  the deployment instance key
- constructor input is explicit deployment context, not ambient globals
- supported injection buckets are `config`, `bindings`, and `secrets`
- route handlers may be functions for the old app/router style or method names
  for class-based deployments
- mutable member variables are replica-local only; they are not durable and are
  not shared across hosts or replicas
- this instance-sharing rule is a hard requirement for `v1`; otherwise multiple
  HTTP entry methods on one `serve` deployment would observe inconsistent
  member-variable state
- admin remains responsible for publishing injected values into desired host
  state; runtime only consumes the host-local projection

The assignment payload may carry explicit injection values:

```ts
serve_app: {
  name: "orders",
  entry: "apps/orders.ts",
  route_refs: ["route-orders"],
  deployment: {
    config: { region: "cn-sh-1" },
    bindings: { catalog_base_url: "https://catalog.internal" },
    secrets: { api_token: "runtime-injected-secret" }
  }
}
```

This keeps the boundary clear:

- `serve` is the product-level business abstraction
- `worker` is the compatibility and execution ABI
- deployment injection is versioned with admin desired state
- secrets are still explicit data in the current mock/control protocol and
  should later become secret references resolved by runtime-owned secret
  materialization

One important `serviceModule` semantic is now fixed for `v1`:

- a server protocol action does not have to fan out to another peer
- it may terminate locally through `handleLocally`
- it may also do both: local origin-side work plus optional recipient fanout

## 14. Decisions To Confirm

The following items still need explicit product / architecture confirmation
before protocol and admin implementation should be treated as fixed.

### 14.1 Scheduling unit

Confirmed direction:

- schedule by deployment replica
- one assignment is one deployment replica placed onto one host

This is the fixed `v1` default for now.

More advanced placement policy can be added later, for example:

- affinity / anti-affinity
- topology or zone preference
- capacity-aware balancing
- custom scheduling policy

But those later policies should refine assignment choice, not replace the core
`deployment -> replicas -> assignments -> desired host state` model.

### 14.2 Replica semantics for `serviceModule`

Confirmed direction:

- `serviceModule` uses the same deployment / replica / assignment model as HTTP worker

This is now fixed for `v1`.

In other words:

- `worker` and `serviceModule` share the same publication model
- both are published as deployment objects
- both are scaled by replica count
- both are placed onto a subset of hosts through assignments

`serviceModule` should not become a special global-broadcast configuration path.

### 14.3 Route ownership model

Confirmed direction:

- routes belong to deployment metadata
- host only receives route references or resolved route bindings through assignment

This is now fixed for `v1`.

That means:

- route intent is authored centrally
- assignment decides where that route-bearing deployment runs
- host executes the assigned routing state, but does not own route truth

This keeps route governance in the control plane instead of fragmenting it
across hosts.

### 14.4 Host capacity and placement labels

Confirmed direction:

- host registration should expose capacity, labels, and dynamic placement fields
- admin placement should use those fields when choosing assignment targets

This is now fixed for `v1`.

The registration / observed-state model should therefore leave room for both
static and dynamic host metadata.

Static examples:

- host id
- zone / region
- labels
- supported capabilities
- configured listener surfaces

Dynamic examples:

- current assignment count
- current connection count
- current inflight load
- recent error state
- resource usage hints
- temporary schedulability signals

The first scheduler can stay simple, but the contract should not block richer
placement later.

Current baseline scheduler for the `v1` line is:

- filter out hosts that are `draining`, explicitly unschedulable, not ready, or
  already at `maxHttpWorkerAssignments`
- honor `requiredLabels`
- honor `requiredCapabilities`
- prefer existing owners first to reduce unnecessary reassignment churn
- then prefer `preferredLabels`
- then prefer lower current assignment count
- finally break ties by stable host ordering

### 14.5 Rollout strategy

Confirmed direction:

- rollout happens by changing deployment version then replacing assignments gradually
- not by broadcasting one new desired state to all hosts at once

This is now fixed for `v1`.

So the baseline rollout model is:

1. publish a new deployment version
2. compute the next desired assignments
3. replace assignments gradually
4. let each affected host reconcile locally

For the current `v1` demo scheduler, the concrete baseline is:

- rollout is still assignment-driven, not a second protocol
- when `rollout.strategy=gradual`, admin first computes the final target owner
  set, then publishes only the next owner set for this reconciliation round
- the default demo policy is `batchSize=1` and `maxUnavailable=0`
- so replacement follows "add the next owner first, wait until enough owners
  are observed `ready` or `active`, then remove the previous owner"
- when a host loses a `service_module` assignment, runtime may continue to
  report that assignment as `draining` for a short local grace window before
  final unregister, so rollout summary can see "no longer desired but not yet
  fully gone"

More advanced rollout policy can be added later, for example:

- rolling windows
- canary / gray release
- topology-aware staged rollout
- failure-triggered pause or rollback

But the baseline control-plane model remains assignment-driven rollout, not
global config broadcast.

## 15. Relation To Existing v1 Docs

This document complements, but does not replace:

- [hardess-architecture.md](./hardess-architecture.md)
- [hardess-v1-host-protocol.md](./hardess-v1-host-protocol.md)
- [swarm-dual-port-cluster-design.md](./swarm-dual-port-cluster-design.md)
- [swarm-v1-cluster-deployment.md](./swarm-v1-cluster-deployment.md)

Those documents cover runtime architecture and deployment.

This document covers control-plane ownership and admin/runtime boundaries for
the current `v1` line.

## 16. Current Status

The baseline `v1` direction in this document is no longer just design intent.

The following parts are already implemented in the repo:

- shared host protocol types plus schema validation
- mock admin transport and demo admin app
- host-agent register / desired / observed reconcile loop
- admin-side placement, topology projection, and gradual owner rollout
- `http_worker` runtime activation through staged artifacts plus generated HTTP
  pipeline config
- `serviceModule` runtime activation through staged artifacts plus WebSocket
  protocol-registry registration
- `serviceModule` actions may now terminate locally through `handleLocally`,
  fan out through `resolveRecipients`, or do both

## 17. Current TODO

The main remaining `v1` work is now narrower and more product-facing:

1. define the deployment convention for `serviceModule` on multi-node WebSocket
   ingress:
   - each bound protocol package must be present on every ingress node in the
     target host group, or
   - ingress must be partitioned so only a known host pool accepts that package
     and its actions
2. finish the real admin publish / rollback shape beyond the current mock admin
   replica and owner-set demo endpoints
3. keep the broader runtime-production items outside this document moving in
   parallel:
   - real auth provider integration
   - broader observability environment wiring
   - final ACL / capability policy for injected protocol actions

Current implemented `serviceModule` drain rule:

- runtime uses a bounded node-local grace drain, not socket-level version
  pinning
- removed assignments remain observable as `draining` during that grace window
- after the grace window expires, runtime unregisters the old module locally
- if the same assignment returns before grace expiry, the drain is canceled
