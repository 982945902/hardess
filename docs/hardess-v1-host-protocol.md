# Hardess v1 Host Protocol Design

## 1. Scope

This document defines the baseline admin-to-runtime protocol for the current
`hardess v1` line.

It is designed for:

- the current Bun-based runtime
- the current `v1` control-plane direction
- an `admin + mock service` integration phase

It does not assume:

- the `v2` experiment
- a Rust runtime rewrite
- a final transport beyond a simple HTTP control contract

## 2. Design Goal

Define one host-oriented protocol between:

- `Hardess Admin`
- `Hardess Runtime`

This protocol should support:

- host registration
- host heartbeat and observed state reporting
- deployment publication and placement
- per-host desired state reconciliation
- runtime artifact retrieval

The protocol should fit the fixed `v1` design:

- `worker` and `serviceModule` publish like `Kubernetes` / `Ray Serve`
- publish creates a deployment
- deployment declares replica count
- admin produces assignments
- each host reconciles only its own desired state

## 3. Core Objects

The baseline protocol uses six core objects:

1. `HostRegistration`
2. `Deployment`
3. `Assignment`
4. `DesiredHostState`
5. `ObservedHostState`
6. `ArtifactManifest`

## 4. HostRegistration

This is the first object a runtime host sends to admin.

Purpose:

- identify the host
- advertise static capabilities
- advertise initial dynamic state
- give admin enough information to schedule assignments later

Recommended shape:

```ts
type HostRegistration = {
  host_id: string;
  group_id?: string;
  node_id?: string;
  started_at: number;
  runtime: {
    kind: "hardess-v1";
    version: string;
    pid?: number;
  };
  network: {
    public_base_url?: string;
    internal_base_url?: string;
    public_listener_enabled: boolean;
    internal_listener_enabled: boolean;
  };
  static_labels: Record<string, string>;
  static_capabilities: string[];
  static_capacity: {
    max_http_worker_assignments?: number;
    max_service_module_assignments?: number;
    max_connections?: number;
    max_inflight_requests?: number;
  };
  dynamic_fields?: Record<string, unknown>;
}
```

Notes:

- `dynamic_state.dynamic_fields` is the extensibility surface for runtime-side
  reporting that should not churn the protocol
- runtime metrics may be reported here as a compact summary, for example
  `metrics.counters` and `metrics.timing_counts`, instead of shipping full raw
  timing sample arrays in every heartbeat

- `host_id` is the admin-facing stable identity
- `group_id` is the host's group boundary; one runtime host belongs to exactly
  one group, chosen at startup by `HOST_GROUP_ID`
- `node_id` may mirror runtime/node naming already present in cluster mode
- `dynamic_fields` exists on purpose so the contract can grow without churn

## 5. Deployment

This is the global control-plane object.

It is the thing users publish and scale.

Recommended shape:

```ts
type Deployment = {
  deployment_id: string;
  deployment_kind: "http_worker" | "service_module" | "serve";
  group_id?: string;
  name: string;
  declared_version: string;
  declared_artifact_id?: string;
  replicas: number;
  artifact: {
    manifest_id: string;
    source_uri: string;
    digest?: string;
  };
  route_bindings?: Array<{
    route_id: string;
  }>;
  auth_policy_ref?: string;
  secret_refs?: string[];
  scheduling?: {
    required_labels?: Record<string, string>;
    preferred_labels?: Record<string, string>;
  };
  rollout?: {
    strategy?: "gradual";
    max_unavailable?: number;
    batch_size?: number;
  };
}
```

Notes:

- `replicas` is global desired count
- `group_id` is the deployment's target group; admin only places that
  deployment onto hosts with the same `group_id`
- `v1` does not introduce a separate `service` or `selector` object
- `scheduling` leaves room for future affinity / anti-affinity policy
- `rollout` stays intentionally simple in `v1`

## 6. Assignment

This is the placement result from admin onto one host.

One assignment means:

- one deployment replica
- placed onto one host

Recommended shape:

```ts
type Assignment = {
  assignment_id: string;
  host_id: string;
  deployment_id: string;
  deployment_kind: "http_worker" | "service_module" | "serve";
  group_id?: string;
  declared_version: string;
  declared_artifact_id?: string;
  artifact: {
    manifest_id: string;
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
      package_id: string;
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
  };
  auth_policy_ref?: string;
  secret_refs?: string[];
}
```

Notes:

- this is the scheduling unit for `v1`
- more advanced sub-assignment behavior is out of scope for now

## 7. DesiredHostState

This is what admin returns to one specific host.

It is not a global config snapshot.

It is the host-local projection of:

- deployments
- placement decisions
- current rollout state

Recommended shape:

```ts
type DesiredHostState = {
  host_id: string;
  revision: string;
  generated_at: number;
  assignments: Assignment[];
  topology?: {
    membership: {
      revision: string;
      generated_at: number;
      hosts: Array<{
        host_id: string;
        group_id?: string;
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
    routes: Array<{
      route_id: string;
      match: {
        path_prefix: string;
      };
      upstream: {
        base_url: string;
        websocket_enabled?: boolean;
      };
    }>;
  };
}
```

Notes:

- `revision` is the admin-side monotonic desired-state token
- hosts should treat `revision` as an opaque value
- `topology.membership` is the slow-changing host view for the current host group
- `topology.placement` is the slow-changing deployment-owner view for the current host group
- `topology.placement.routes` is the minimal routing table needed for host-to-host
  HTTP forwarding and business WebSocket upgrade forwarding
- hot `connId` location is still runtime-owned and should not be pushed through
  admin

## 8. ObservedHostState

This is what runtime reports back to admin.

Purpose:

- let admin know whether assignments are healthy
- support scheduling decisions
- support rollout progress and rollback decisions
- optionally carry compact runtime-native summaries in `dynamic_fields`, for example metrics rollups or a pipeline/protocol-package summary of the currently applied runtime state

Recommended shape:

```ts
type ObservedHostState = {
  host_id: string;
  observed_at: number;
  ready: boolean;
  draining: boolean;
  static_labels: Record<string, string>;
  static_capabilities: string[];
  static_capacity: {
    max_http_worker_assignments?: number;
    max_service_module_assignments?: number;
    max_connections?: number;
    max_inflight_requests?: number;
  };
  dynamic_state: {
    current_assignment_count: number;
    current_connection_count?: number;
    current_inflight_requests?: number;
    schedulable?: boolean;
    applied_topology?: {
      membership_revision?: string;
      placement_revision?: string;
    };
    resource_hints?: Record<string, number>;
    runtime_summary?: {
      pipeline_count: number;
      pipelines: Array<{
        pipeline_id: string;
        match_prefix: string;
      }>;
      active_protocol_packages: Array<{
        package_id: string;
        digest: string;
      }>;
    };
    dynamic_fields?: Record<string, unknown>;
  };
  assignment_statuses: Array<{
    assignment_id: string;
    deployment_id: string;
    declared_version: string;
    generation_id?: string;
    state:
      | "pending"
      | "preparing"
      | "ready"
      | "active"
      | "draining"
      | "failed";
    prepared_at?: number;
    activated_at?: number;
    failed_at?: number;
    last_error?: {
      code: string;
      message: string;
      retryable?: boolean;
    };
  }>;
}
```

Notes:

- runtime owns `generation_id`
- admin owns `declared_version`
- this keeps version and generation semantics separated
- `applied_topology` lets admin observe whether one host has converged to the
  latest topology snapshot

## 9. ArtifactManifest

This object tells runtime how to fetch and validate one artifact.

Recommended shape:

```ts
type ArtifactManifest = {
  manifest_id: string;
  artifact_kind: "http_worker" | "service_module" | "serve";
  declared_artifact_id?: string;
  declared_version: string;
  source: {
    uri: string;
    digest?: string;
  };
  entry: string;
  package_manager: {
    kind: "bun" | "deno";
    package_json?: string;
    bunfig_toml?: string;
    bun_lock?: string;
    deno_json?: string;
    deno_lock?: string;
    frozen_lock?: boolean;
  };
  metadata?: {
    annotations?: Record<string, string>;
  };
}
```

This matches the current direction:

- admin governs version and artifact identity
- runtime prepares dependencies locally
- runtime can use package-manager metadata during prepare

Current `v1` implementation boundary:

- for `http_worker`, runtime currently treats `source.uri` as the worker source file
- runtime stages that file into a local artifact cache and points the live pipeline `worker.entry` at the staged path
- for `serve`, runtime stages the app entry the same way, validates that it
  exports the `serve` module shape, and adapts it into the worker fetch ABI
  before attaching it to the generated HTTP pipeline
- for `service_module`, admin binds a protocol package together with the module assignment; that package now carries a stable `package_id` plus digest so it can be referenced elsewhere in planning and rollout state; runtime stages the module source into the same local artifact cache, loads the staged entry, validates that its exported `{ protocol, version, actions }` matches the bound protocol package exactly, verifies the package digest, and then registers it into the runtime WebSocket protocol registry
- `topology.placement.ingress_group_requirements` is the slow-changing group-level contract view that says which protocol package refs a WebSocket ingress group must have before it should accept that business traffic
- current `v1` runtime enforcement is package-scoped rather than whole-connection-scoped: when an inbound business envelope targets a `protocol@version` that appears in the current host group's required package refs, ingress must confirm that the same `package_id + digest` is active locally before dispatch; otherwise it rejects that message as retryable instead of silently accepting traffic on a node that has not converged for that package
- when Bun or Deno project files are present in `package_manager`, runtime currently resolves them relative to the worker source location unless they are given as absolute refs, and stages them into the same local artifact directory
- for remote `source.uri`, a `digest` is the boundary for reliable cache reuse; without it, runtime should prefer restaging over assuming the cached remote source is still current
- `v1` keeps Bun as the host runtime, but the worker artifact protocol now allows both Bun and Deno project metadata
- for Bun projects, runtime now runs `bun install` during prepare before activation
- Deno project metadata is still staging-only on the current Bun host runtime; full Deno dependency materialization/execution remains future work
- cluster peer locate still accepts an optional `group_id` scope internally, but
  in the current `v1` runtime that scope comes from the host group boundary
  rather than a client-selected field

## 10. Baseline Operations

The protocol can start with five runtime-facing operations.

### 10.1 Register host

```ts
registerHost(input: HostRegistration): {
  host_id: string;
  accepted: boolean;
  poll_after_ms?: number;
}
```

### 10.2 Heartbeat host

```ts
heartbeatHost(input: {
  host_id: string;
  observed: ObservedHostState;
}): {
  accepted: boolean;
  next_poll_after_ms?: number;
}
```

### 10.3 Get desired host state

```ts
getDesiredHostState(input: {
  host_id: string;
  if_revision?: string;
}): {
  changed: boolean;
  desired?: DesiredHostState;
}
```

### 10.4 Report observed host state

```ts
reportObservedHostState(input: ObservedHostState): {
  accepted: boolean;
}
```

### 10.5 Fetch artifact manifest

```ts
fetchArtifactManifest(input: {
  manifest_id: string;
}): ArtifactManifest
```

### 10.6 Get runtime summary read model

```ts
getRuntimeSummaryReadModel(input: {
  host_id?: string;
  deployment_id?: string;
}): {
  checks: RuntimeSummaryCheck[];
  rollup: RuntimeSummaryRollup;
  rollout_summary: DeploymentRolloutSummary[];
}
```

This is a read-side admin API. It compares desired host state with observed
runtime summaries and separates three states:

- `match`: runtime reported and all expected runtime ids matched
- `drift`: runtime reported but missing or unexpected runtime ids exist
- `not_reported`: runtime did not report a summary for expected runtime ids

When `host_id` is provided, the read model is scoped to that host. When
`deployment_id` is provided, desired assignments, observed assignment statuses,
and runtime pipeline ids are scoped to that deployment before checks and rollout
summaries are computed. The two filters can be combined. Hosts without expected
runtime ids can still be `match` even if they did not report a runtime summary.
Runtime-produced service-module protocol package summaries should include
`assignment_id`, `deployment_id`, and `declared_version` when available so
deployment-scoped checks can attribute protocol readiness without guessing from
`package_id` alone.

## 11. Baseline HTTP Binding

The first concrete transport can be a simple JSON-over-HTTP binding.

Recommended `v1` paths:

- `POST /v1/admin/hosts/register`
- `POST /v1/admin/hosts/heartbeat`
- `POST /v1/admin/hosts/desired`
- `POST /v1/admin/hosts/observed`
- `POST /v1/admin/artifacts/manifest`
- `POST /v1/admin/read/runtime-summary`

Recommended baseline behavior:

- request body is JSON
- response body is JSON
- non-2xx responses are transport errors at the SDK layer
- schema validation still runs on successful responses

This binding is intentionally simple so it works for:

- a real admin service
- a mock admin service
- local integration tests

## 12. Reconciliation Loop

The intended runtime loop is:

1. runtime bootstraps with host identity and admin credentials
2. runtime calls `registerHost(...)`
3. runtime calls `getDesiredHostState(...)`
4. runtime compares desired revision with its current local revision
5. runtime prepares or updates local assignments
6. runtime activates new local generations and drains old ones
7. runtime reports `ObservedHostState`
8. runtime repeats via heartbeat / polling

This is a reconcile loop, not a push-command model.

## 13. Mock-Friendly Constraint

This protocol must work well with:

- real admin implementation
- mock admin implementation
- unit tests
- integration tests

So:

- payload shapes should stay explicit
- responses should be deterministic
- error shapes should be typed
- transports should remain replaceable

## 14. What Is Still Deferred

This baseline protocol intentionally leaves these for later:

- watch / stream-based desired-state push
- advanced scheduler policy
- affinity / anti-affinity semantics
- canary / gray release semantics
- multi-cluster federation
- final admin auth model

## 15. Recommended Next Step

That first implementation slice is already done in the current repo:

- shared TypeScript types
- shared schema validation
- mock admin adapter
- runtime host-agent reconcile loop

So the next protocol-facing TODO is no longer "define the protocol".

It is:

1. document the multi-node deployment rule for `service_module` so protocol
   actions do not land on a WebSocket ingress node that does not carry the
   required bound protocol package + module pair
2. finish the real admin publish / rollback shape beyond the current mock
   admin flow

Current implemented `service_module` replacement rule:

- runtime keeps removed or replaced `service_module` assignments in local
  `draining` state for a bounded grace window instead of unregistering
  immediately
- that drain window is node-local and grace-based, not per-socket version
  pinning
- during the grace window, `ObservedHostState.assignmentStatuses` still reports
  the removed assignment as `draining`
- once the grace window expires, runtime unregisters the old protocol module
  and the draining assignment disappears from observed state
- if the same assignment is re-added before the grace window expires, runtime
  cancels the drain and keeps the module active
