# Worker Generation Rollout Design for the Pingora Experiment

Date: 2026-04-16

## Decision

Runtime updates should use generation-based replacement.

Short version:

`Warm next generation. Atomically switch traffic. Drain the previous generation.`

This document now assumes the stronger control-plane boundary:

- the admin server owns versions
- the runtime node owns generations

## Why

Reloading code inside an already-running JS runtime is the wrong risk profile.

It mixes:

- old module graph
- old global state
- old cached function handles
- new code

That makes rollback and debugging worse.

For request handling, the safer model is whole-generation replacement.

## Version Versus Generation

These two words must not be conflated.

`Version` means:

- a control-plane release unit
- a published worker or websocket-module artifact
- an auditable rollout token

`Generation` means:

- one node-local prepared execution snapshot
- one active or draining runtime instance set
- one concrete local convergence step

So:

- rollback policy is version-level and belongs to the admin server
- activation and draining are generation-level and belong to the runtime node

## Model

Each generation owns:

- one `WorkerRuntimePool`
- one generation-local `RequestDrainController`
- one `generation_id`
- one prepared desired-runtime-state snapshot

That desired-runtime-state snapshot may include:

- HTTP worker artifact
- HTTP forward configuration
- websocket `serviceModule` set
- auth policy assignment
- secret/config references resolved for that generation

At any point:

- exactly one generation is `active`
- zero or more older generations may be `draining`

## Request Routing Rules

For a normal request:

1. ingress checks global shutdown draining
2. ingress snapshots the current active generation
3. request acquires that generation's in-flight guard
4. request executes on that generation's runtime pool

After a generation enters `draining`:

- it must not accept new requests
- it may finish requests that already acquired an in-flight slot

That keeps cutover semantics clean.

## Update Flow

Recommended flow:

1. admin declares desired version or desired runtime state `S(N+1)`
2. runtime creates generation `G(N+1)`
3. runtime initializes the new runtime pool and local state for `S(N+1)`
4. runtime completes prepare and warmup
5. runtime atomically switches active pointer from `G(N)` to `G(N+1)`
6. runtime marks `G(N)` as draining
7. runtime waits for `G(N)` in-flight requests to finish or timeout
8. runtime drops `G(N)` after drain completes

The runtime should not mutate the currently active generation in place.

## Warmup

Warmup has two layers.

### Structural warmup

Required before cutover:

- create `JsRuntime`
- bootstrap runtime helpers
- load worker module graph
- resolve the single `fetch(request, env, ctx)` handler
- initialize generation-local config/auth/module state

### Request-path warmup

Desired before cutover:

- exercise the invocation trampoline once per slot
- avoid first-real-request latency spikes

The first implementation may rely mostly on structural warmup.

That is acceptable for the experiment, but it is not the final target.

## Rollback

Rollback should be a generation transition triggered by the admin server's
desired-state change, not a local code mutation.

If a newly activated version is bad:

1. admin changes desired version back to the previous good release
2. runtime prepares a new local generation for that desired state
3. runtime activates it and drains the bad generation

That preserves the clean boundary:

- admin decides what the correct version is
- runtime decides how to converge locally without dropping traffic

## Last-Known-Good

The runtime should keep enough local history to continue serving when the
control plane is temporarily unavailable.

Required behavior:

- a failed prepare must not tear down the currently active good generation
- control-plane outage must not stop the active good generation
- old generations should be retained long enough for safe local rollback or reactivation

## Control Surface

The experiment currently exposes explicit local write controls:

- `POST /_hardess/apply-worker`
- `POST /_hardess/reload-worker`

In the experiment, those endpoints should:

- build the next generation using the desired input
- switch traffic only after the next generation is ready
- return a generation snapshot

That is acceptable as a local debug surface while the runtime is still being
built.

It is not the intended long-term production contract.

For production:

- version selection and rollback are driven by the admin server
- local write endpoints remain debug-only if they survive at all

The experiment should also expose visibility into generations:

- `GET /_hardess/generations`

## Observability

Generation snapshots should include:

- active generation id
- draining generation ids
- per-generation drain state
- per-generation runtime pool snapshot
- control-plane-declared source markers
- prepare / activate / fail timestamps

That makes cutovers debuggable without confusing local generations with global
release versions.

## Non-Goals

- no file watching as the production update mechanism
- no in-process hot patching of an existing runtime
- no cross-generation request migration
- no runtime-owned version history

## Recommended Next Steps

1. rename the experiment's "desired worker" path toward "desired runtime state"
2. keep generation snapshots explicit about local generation ids versus declared version markers
3. add a small retained last-known-good window in the generation manager model
