# Control Plane / Runtime Separation for the Pingora Experiment

Date: 2026-04-15

## Decision

Hardess should separate:

- control-plane responsibility
- runtime-node responsibility

Short version:

`The control plane decides versions. The runtime node executes them safely.`

## Why

If the runtime node owns version choice, rollback choice, or rollout strategy,
the system gets the wrong failure and audit model.

That creates avoidable problems:

- different nodes can drift into different versions without a single source of truth
- rollback becomes a local imperative action instead of a controlled fleet operation
- audit trails get weaker because "who changed what" is ambiguous
- runtime code grows extra policy that does not belong on the hot path

The node should be good at:

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

## Responsibility split

### Control plane

Owns:

- worker version publication
- desired-version assignment
- rollout and rollback policy
- tenant / cluster targeting
- orchestration across nodes

### Runtime node

Owns:

- receiving the desired worker artifact or version reference
- exposing one stable execution contract to worker code:
  - `fetch(request, env, ctx)`
- resolving `deno.json` / `deno.lock`
- preparing dependencies and local cache
- warming the next generation
- switching traffic only after prepare succeeds
- draining and retiring old generations
- exposing local status and metrics

## Desired runtime contract

The runtime node should converge on a declarative model:

1. control plane says "desired worker version is `V`"
2. runtime node prepares `V`
3. runtime node reports `preparing`, `ready`, `active`, or `failed`
4. runtime node switches local active generation only after `V` is ready

If rollback is needed:

1. control plane changes desired version back to `V-1`
2. runtime node repeats the same prepare / activate flow

That keeps the node state machine simple.

## Implication for current experiment endpoints

The current experiment exposes local write endpoints:

- `POST /_hardess/reload-worker`
- `POST /_hardess/cleanup-cache`

These are acceptable for development and debugging.

They should be treated as:

- experiment-only
- debug-only
- not the final production control contract

The read-only endpoints are aligned with the long-term direction:

- `GET /_hardess/runtime-pool`
- `GET /_hardess/module-cache`
- `GET /_hardess/ingress-state`
- `GET /_hardess/generations`

Those surfaces help the control plane or operators observe runtime state
without giving the runtime node local policy ownership.

## Current gap

The runtime already has most of the mechanics needed for the correct split:

- generation-based cutover
- prepare-time dependency checking
- cache preparation and cleanup
- drain-aware handoff
- local observability

What it still lacks is the right top-level contract.

Right now the main mutable path is still "reload locally".

The direction should be "apply desired version from control plane".

## Breadth-first roadmap

Prefer low-coupling, broad-value steps first.

### Tier 1: low-hanging fruit

- mark local write endpoints as debug-only in docs and code comments
- add a neutral runtime state-machine concept such as `desired_version` / `prepared_version` / `active_version`
- expose a runtime-local artifact marker even before the real control-plane version exists
- keep strengthening read-only observability for generations, prepare state, and cache state

The experiment now exposes a local `artifact_id` on worker project snapshots and
generation state.

Current semantics:

- format: `local-sha256:<hex>`
- source: hash of the local worker project files under the discovered root
- purpose: runtime-local observability and correlation
- non-goal: this is not a globally assigned control-plane version id

### Tier 2: control-plane handoff shape

- define the minimal desired-artifact payload the runtime consumes
- define runtime status reporting fields for `preparing`, `ready`, `active`, `failed`
- make local apply logic reusable from a future control-plane adapter

The experiment now has a concrete minimal desired-worker payload:

- `worker_entry`
- `declared_artifact_id` optional
- `declared_version` optional

Current intent:

- `worker_entry` tells the runtime what local artifact entry to prepare
- `declared_artifact_id` lets the control plane correlate a node-local prepare with a published artifact
- `declared_version` lets operators and status APIs keep a human-meaningful rollout token

The local `POST /_hardess/apply-worker` endpoint is debug-only, but it now exercises
the same internal apply path that a future control-plane adapter should call.

The runtime status surface now preserves both classes of identifiers:

- local runtime-derived identifiers such as `desired_artifact_id` / `active_artifact_id`
- control-plane-declared identifiers such as `desired_declared_artifact_id` / `active_declared_version`

That split is important:

- the local artifact id answers "what bytes did this node actually prepare?"
- the declared id/version answers "what rollout unit did the control plane intend?"

This experiment no longer carries a separate compatibility protocol path.

Current assumption:

- the control plane delivers a worker artifact whose TS entry exports `fetch(request, env, ctx)`
- the runtime node is not responsible for adapting legacy business protocols inside this workspace

### Tier 3: production convergence

- remove version-choice semantics from local public endpoints
- let fleet rollout / rollback happen only through the control plane
- preserve local endpoints only for diagnostics and emergency debugging if needed

## Non-goals

- no distributed scheduler design yet
- no multi-cluster control-plane protocol yet
- no final authentication model for control-plane to node communication yet

## Recommended next steps

1. define the runtime-side desired-version state model
2. rename internal reload logic toward "apply prepared worker version" semantics
3. keep local reload/cleanup endpoints, but explicitly as debug-only wrappers around that internal state transition
