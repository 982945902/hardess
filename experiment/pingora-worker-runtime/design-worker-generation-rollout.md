# Worker Generation Rollout Design for the Pingora Experiment

Date: 2026-04-15

## Decision

Worker updates should use generation-based replacement.

Short version:

`Warm next generation. Atomically switch traffic. Drain the previous generation.`

## Why

Reloading code inside an already-running JS runtime is the wrong risk profile.

It mixes:

- old module graph
- old global state
- old cached function handles
- new code

That makes rollback and debugging worse.

For HTTP request handling, the safer model is whole-generation replacement.

## Model

Each generation owns:

- one `WorkerRuntimePool`
- one generation-local `RequestDrainController`
- one `generation_id`
- one worker entry path / runtime config

At any point:

- exactly one generation is `active`
- zero or more older generations may be `draining`

## Request routing rules

For a normal request:

1. ingress checks global shutdown draining
2. ingress snapshots the current active generation
3. request acquires that generation's in-flight guard
4. request executes on that generation's runtime pool

After a generation enters `draining`:

- it must not accept new requests
- it may finish requests that already acquired an in-flight slot

That keeps cutover semantics clean.

## Update flow

Recommended flow:

1. create generation `N+1`
2. initialize its runtime pool
3. complete generation warmup
4. atomically switch active pointer from `N` to `N+1`
5. mark generation `N` as draining
6. wait for generation `N` in-flight requests to finish or timeout
7. drop generation `N`

## Warmup

Warmup has two layers.

### Structural warmup

Required before cutover:

- create `JsRuntime`
- bootstrap runtime helpers
- load worker module
- detect invocation mode

### Request-path warmup

Desired before cutover:

- exercise the invocation trampoline once per slot
- avoid first-real-request latency spikes

In this experiment, the first implementation will rely on structural warmup because it does not yet have a business-safe no-op request hook.

That is acceptable for the first generation rollout implementation, but it is not the final target.

## Rollback

Rollback should be a pointer swap, not a code mutation.

If generation `N+1` is bad:

- switch active pointer back to `N`
- drain `N+1`
- keep the previous good generation alive long enough for rollback safety

That requires old generations not to be destroyed immediately at cutover time.

## Control surface

The experiment currently exposes an explicit reload control:

- `POST /_hardess/reload-worker`

In the experiment, that endpoint should:

- build the next generation using the configured worker entry
- switch traffic only after the next generation is ready
- return a generation snapshot

That is acceptable as a local debug surface while the runtime is still being
built.

It is not the intended long-term production contract.

For production, version selection and rollback should be driven by the control
plane, not by a mutable local runtime endpoint.

The experiment should also expose visibility into generations:

- `GET /_hardess/generations`

## Observability

Generation snapshots should include:

- active generation id
- draining generation ids
- per-generation drain state
- per-generation runtime pool snapshot

That makes cutovers debuggable.

## Non-goals

- no file watching yet
- no distributed control plane yet
- no in-process hot patching of an existing runtime
- no cross-generation request migration

## Recommended next steps

1. replace local reload semantics with a control-plane-driven desired-version apply flow
2. add rollback policy and retention window for previous generations
3. keep local write endpoints as debug-only surfaces while preserving read-only observability
