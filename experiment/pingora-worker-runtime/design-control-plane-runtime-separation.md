# Control Plane / Runtime Separation for the Pingora Experiment

Date: 2026-04-16

## Decision

Hardess should use a control-plane-driven runtime model.

Short version:

`The admin server owns desired state and version history. The runtime node reconciles and executes.`

This is intentionally closer to a Ray-style node model than to a static
config-file gateway:

- runtime nodes start almost empty
- runtime nodes register to the admin server
- the admin server decides what each node should run
- runtime nodes prepare, activate, drain, and report

## Why

If a runtime node owns route choice, worker version choice, rollback choice, or
cluster rollout policy, the system gets the wrong operational boundary.

That creates avoidable problems:

- different nodes can drift into different versions without a single source of truth
- rollback becomes a local imperative action instead of a controlled fleet operation
- audit trails get weaker because "who changed what" is ambiguous
- runtime code grows policy that does not belong on the hot path
- worker, forwarding, websocket, and auth updates can split into incompatible versions

The node should be good at:

- bootstrap
- register
- receive desired state
- prepare
- verify
- warm
- cut over locally
- drain old generation
- report status

It should not be good at:

- deciding target version
- deciding rollback policy
- deciding rollout scope or tenant strategy
- creating or mutating version history

## Core Principle

Two concepts must stay separate:

- `version`: control-plane meaning
- `generation`: runtime meaning

More explicitly:

- `Hardess Admin` owns version history
- `Hardess Runtime` owns generation lifecycle
- `Hardess Runtime` stores source metadata, but does not define versions

This means:

- worker versions are published and tracked by the admin server
- websocket `serviceModule` versions are published and tracked by the admin server
- runtime nodes may report declared version markers back, but they do not create global version semantics
- local generation ids are only for prepare / activate / drain / rollback mechanics on one node

## Responsibility Split

### Control plane

Owns:

- worker publication and version history
- websocket `serviceModule` publication and version history
- desired-state assignment per cluster / node / tenant scope
- rollout and rollback policy
- cluster membership intent
- secret and config reference assignment
- orchestration across nodes
- audit trail of who changed what

### Runtime node

Owns:

- stable bootstrap identity
- secure registration to the admin server
- receiving the desired runtime state
- exposing stable execution contracts to worker code:
  - `fetch(request, env, ctx)`
- resolving `deno.json` / `deno.lock`
- preparing dependencies and local cache
- warming the next generation
- switching traffic only after prepare succeeds
- draining and retiring old generations
- exposing local status and metrics
- keeping a local last-known-good state for control-plane outages

## Runtime Bootstrap Model

The runtime node should start almost empty from a business point of view.

It should not boot with embedded business routing knowledge such as:

- which HTTP worker to run
- which upstream forward rules to use
- which websocket `serviceModule` to activate
- which tenant-specific auth policy to enforce

It still needs a small bootstrap substrate:

- node identity
- admin-server address
- bootstrap credential or trust root
- public/internal listener binding
- local cache and artifact directories
- read-only local admin endpoints

So the runtime is not "blank" in the literal sense. It is "business-empty but
operationally alive".

## Desired Runtime State

The runtime should converge on one declarative object, not a loose bag of
independent knobs.

Recommended shape:

```ts
type DesiredRuntimeState = {
  declared_version: string;
  declared_artifact_id?: string;
  worker_artifact?: {
    entry: string;
    source_uri: string;
    digest?: string;
  };
  http_forward_config?: {
    routes: unknown[];
  };
  websocket_modules?: Array<{
    name: string;
    source_uri: string;
    declared_version: string;
    digest?: string;
  }>;
  auth_policy?: {
    kind: string;
    ref?: string;
    config?: Record<string, unknown>;
  };
  secret_refs?: string[];
}
```

The important point is not the exact field names.

The important point is:

- the admin server sends one coherent desired state
- the runtime prepares one coherent next generation from that state
- cutover happens at the generation boundary

That avoids version skew between:

- worker code
- forward config
- websocket modules
- auth behavior

## Build-Time SDK Versus Runtime Artifact

Two dependency classes must stay separate.

### Build-time SDK

This is for:

- admin-side tooling
- publish scripts
- mock services used during integration work
- external business services that need admin APIs during build or deploy workflows

This SDK may be distributed through:

- `git` dependency during early development
- later `npm` or `jsr` publication if needed

Its job is to provide:

- shared request / response types
- admin API client helpers
- artifact manifest types
- polling / watch helpers
- mock-friendly interfaces

This SDK is a build-time dependency. It is not the runtime artifact format.

### Runtime artifact

This is for:

- HTTP worker code
- websocket `serviceModule` code
- runtime-consumed manifests and metadata

This is what the admin server delivers to runtime nodes as part of the desired
runtime state.

The runtime then owns:

- dependency prepare
- cache population
- warmup
- activation
- draining

The runtime should not infer release semantics from how the SDK itself was
consumed by developer projects.

## Host-Style Runtime Constraint

The admin-side contract should also assume the longer-term host model:

- one `Hardess` process is a host-level runtime owner
- it may own multiple workers, modules, listeners, and sessions
- it is closer to a node agent / serving host than to an embedded business SDK

This is closer to:

- Ray Serve node or replica management
- Kubernetes node-agent style reconciliation

And less like:

- a business application importing a helper SDK and directly running serving logic in-process

That distinction matters because the runtime-side SDK surface should be designed
for a host, not for arbitrary business code.

## Implication For SDK Shape

The admin SDK should support two consumers, but they should not be conflated.

### 1. External build-time consumers

Examples:

- admin-side tooling
- publish pipelines
- mock services
- external integration services

These consumers care about:

- publishing artifacts
- reading admin state
- triggering rollouts
- validating schemas

### 2. Runtime-host consumer

This is the `Hardess` node itself.

It cares about:

- register as a host
- heartbeat as a host
- fetch desired runtime state for the host
- report observed host state
- download runtime artifacts for the host

So the runtime-facing contract should be host-oriented, not worker-oriented.

Bad direction:

- `sdk.activateWorker(workerId)`
- `sdk.reloadServiceModule(name)`

Better direction:

- `registerHost(...)`
- `heartbeatHost(...)`
- `getDesiredHostState(hostId)`
- `reportObservedHostState(...)`
- `fetchArtifact(...)`

The runtime host then reconciles that desired host state internally.

## Desired Host State Versus Point APIs

Do not model the long-term admin/runtime protocol as a pile of narrow mutation
RPCs.

Avoid a design centered on calls such as:

- add worker
- remove worker
- patch auth
- patch one route
- reload one module

That style pushes imperative orchestration into the runtime and makes drift
handling harder.

Prefer:

- one host registration contract
- one desired host state payload
- one observed host state payload

This keeps the runtime in the familiar reconcile loop:

1. register host
2. learn desired host state
3. prepare next local generation
4. activate and drain
5. report observed host state

## Multi-Tenant And Multi-Session Consequence

Because one `Hardess` host may eventually carry:

- multiple workers
- multiple websocket service modules
- many concurrent sessions
- multiple listeners or routing domains

The SDK must not accidentally encode a one-worker-per-process assumption.

The host-facing contract should leave room for:

- host metadata
- capacity and labels
- assigned workloads
- active runtime generations
- per-assignment observed status

Even if the first implementation starts smaller, the model should point in this
direction.

## SDK Design Constraint: Admin + Mock First

For the near-term integration phase, assume:

- the real business service may not exist yet
- development may proceed with `admin + mock service`

That should shape the SDK design directly.

Recommended rule:

`Design the admin SDK against a transport-neutral contract and make mocking a first-class path.`

That means the SDK should not require:

- the real business service implementation
- the real runtime node implementation
- a live distributed environment

## Recommended SDK Split

The admin SDK should be split into three layers.

### 1. Contract layer

Contains only:

- types
- schemas
- error shapes
- artifact manifest definitions

This layer must have no network side effects.

### 2. Transport interface layer

Contains an abstract client boundary, for example:

```ts
interface AdminTransport {
  request<TReq, TRes>(operation: string, payload: TReq): Promise<TRes>;
}
```

The important point is:

- SDK call sites depend on an interface
- not directly on `fetch`
- not directly on a specific deployment topology

### 3. Adapter layer

Concrete implementations such as:

- real HTTP admin client
- in-memory mock adapter
- record/replay test adapter

With that split, the same SDK surface can be used by:

- real admin integration
- local mock integration
- unit tests
- contract tests

## Mock-First Requirements

The SDK should make the following easy:

- inject a mock transport
- return deterministic fake deployment state
- simulate long-running prepare / activate flows
- simulate retryable and terminal failures
- validate payloads with the same schemas used by the real client

This matters because the next few days may only have:

- admin server behavior
- mocked service-side behavior

So the SDK must help us verify contract shape before the full system exists.

## Recommended Minimal SDK Surface

Do not start with a giant admin SDK.

Start with a small contract:

- `registerNode(...)`
- `heartbeat(...)`
- `getDesiredState(...)`
- `reportObservedState(...)`
- `downloadArtifactManifest(...)`

And keep artifact upload / publish concerns separate from runtime-node
reconciliation concerns.

## Error And State Model Guidance

Because mock integration will arrive before full service integration, the SDK
should model state transitions explicitly instead of burying them in free-form
strings.

Examples:

- `unregistered`
- `registered`
- `preparing`
- `ready`
- `active`
- `failed`

And errors should be typed enough to distinguish:

- transport failure
- auth failure
- invalid desired state
- artifact integrity failure
- prepare failure

That lets mock runs exercise the real control logic instead of merely faking
"success".

## Registration And Reconciliation Model

The intended steady-state loop is:

1. runtime starts with bootstrap identity and credentials
2. runtime registers to the admin server
3. admin returns node-scoped desired state
4. runtime prepares the desired state locally
5. runtime reports `preparing`, `ready`, `active`, or `failed`
6. runtime activates only after local prepare and warmup succeed
7. runtime continues heartbeats / polling / watches and reconciles future updates

This should be treated as desired-state reconciliation, not a command-style
"reload now" interface.

## Source Metadata Versus Version Control

The runtime should keep two classes of information distinct.

### Control-plane-declared metadata

Examples:

- `declared_version`
- `declared_artifact_id`
- `source_uri`
- `published_at`
- `digest`
- signature or provenance metadata

The runtime stores and reports these fields, but does not assign their meaning.

### Runtime-observed state

Examples:

- `desired_generation`
- `prepared_generation`
- `active_generation`
- `failed_generation`
- `last_known_good_generation`
- `prepare_error`
- `prepared_at`
- `activated_at`

These fields describe runtime convergence state, not release management.

## Last-Known-Good Requirement

Control plane and runtime must be separated strongly enough that admin-server
failure does not stop traffic.

Required behavior:

- if the admin server is temporarily unavailable, the node keeps serving the last active good generation
- if a new desired state cannot be prepared, traffic stays on the current active good generation
- loss of control-plane reachability blocks change, not service

That keeps the control plane from poisoning the data plane.

## Auth Configuration Direction

Current direction:

- auth behavior may be assigned by the admin server
- runtime should execute that assignment as part of the desired state

But the boundary should stay explicit:

- the admin server owns auth policy choice
- the runtime enforces the selected auth policy inside the active generation

For this experiment, the more important point is lifecycle ownership, not the
final auth-plugin surface.

## Implication For Current Experiment Endpoints

The current experiment still exposes local write endpoints:

- `POST /_hardess/reload-worker`
- `POST /_hardess/apply-worker`
- `POST /_hardess/cleanup-cache`

These are acceptable for development and debugging.

They should be treated as:

- experiment-only
- debug-only
- wrappers around the internal desired-state apply path
- not the final production control contract

The read-only endpoints remain aligned with the long-term direction:

- `GET /_hardess/runtime-pool`
- `GET /_hardess/module-cache`
- `GET /_hardess/ingress-state`
- `GET /_hardess/generations`

Those surfaces help the admin server or operators observe runtime state without
giving the runtime node local policy ownership.

## Current Gap

The runtime already has most of the mechanics needed for the correct split:

- generation-based cutover
- prepare-time dependency checking
- cache preparation and cleanup
- drain-aware handoff
- local observability

What it still lacks is the final production control contract:

- registration protocol
- desired-state fetch / watch protocol
- stable admin-to-runtime auth
- full desired-state payload beyond worker entry only

## Recommended Next Steps

1. define the runtime-side registration and heartbeat contract
2. replace "desired worker" wording with "desired runtime state" in the experiment surfaces
3. keep local write endpoints, but explicitly as debug-only wrappers around the same reconciliation path
4. preserve the rule that the admin server owns versions and runtime nodes own generations
