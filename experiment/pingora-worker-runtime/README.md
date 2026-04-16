# Pingora + Rust + TS Runtime Experiment

Status: exploratory, runnable

Current fixed direction:

- one worker entry contract: `fetch(request, env, ctx)`
- one TS request model: minimal Web `Request` / `Response`
- no `v1` compatibility layer in this experiment

Related docs:

- [TS runtime selection note](./design-ts-runtime-selection.md)
- [Package management design note](./design-package-management.md)
- [Public error contract design note](./design-public-error-contract.md)
- [Pingora / runtime event alignment note](./design-pingora-runtime-event-alignment.md)
- [Runtime invocation bridge design note](./design-runtime-invocation-bridge.md)
- [Low-copy response bridge note](./design-low-copy-response-bridge.md)
- [v1 vs v2 comparison note](./design-v1-v2-comparison.md)
- [Benchmark optimization log](./benchmark-optimization-log.md)
- [Learning from Deno and Bun](./design-learning-from-deno-and-bun.md)
- [Reusing Deno pieces](./design-reusing-deno-pieces.md)
- [Next-phase plan](./plan-next-phase.md)
- [Control Plane / Runtime Separation note](./design-control-plane-runtime-separation.md)
- [Worker generation rollout design note](./design-worker-generation-rollout.md)
- [Breadth-first TODO note](./TODO-breadth-first.md)
- [WebSocket runtime design note](./design-websocket-runtime.md)

## Question

Can Hardess v2 use a `Pingora + Rust` network core while still preserving a `Cloudflare-Workers-style` server-side programming model for request handling?

More concretely:

- Pingora owns the high-performance HTTP ingress / proxy layer
- Rust owns runtime lifecycle, routing, and hosting
- a TS runtime hosts worker code with a `fetch(request, env, ctx)` contract

## Why this exists

The main repo currently proves that Hardess works well as a small Bun/TypeScript service.

This experiment is not trying to replace that immediately.

It exists to answer whether a future version could:

- gain a stronger proxy/network kernel
- keep a programmable worker model
- preserve enough of the current Hardess contract to avoid a full product reset

## What this experiment is trying to prove

Phase 0:

- can we define a clean Rust-side host boundary for a Workers-style `fetch(request, env, ctx)` contract?

Phase 1:

- can Pingora act as the HTTP ingress / proxy kernel for that host?

Phase 2:

- can a TS runtime be embedded or attached cleanly enough for request-path worker execution?

Phase 3:

- can the resulting design still feel like Hardess rather than a generic Rust proxy with custom scripts bolted on?

## Non-goals for the first iteration

- no attempt to replace the current Bun runtime
- no attempt to carry over the full WebSocket hub yet
- no attempt to reach production-grade isolation or sandboxing
- no attempt to finalize the TS runtime choice before the host contract is clear

## Locked decisions

The following are now fixed for this experiment track:

- the TS handler shape is `fetch(request, env, ctx)`
- the runtime exposes a Web-style request surface to TS
- `v1` compatibility is out of scope and removed from this workspace
- the HTTP runtime pool now uses one completion strategy: `async`
- Pingora request handling is normalized into the host ABI and then exposed to TS through a Rust-backed Web `Request` facade

The main open runtime choice that remains is implementation depth, not external contract shape.

## Initial workspace layout

- `Cargo.toml`: isolated Rust workspace
- `crates/worker-abi`: shared Rust-side contract types for a Workers-style host boundary
- `crates/gateway-host`: experimental binary that will eventually host Pingora plus worker execution
- `workers/hello`: local TypeScript sample worker for bootstrap verification

## What works now

This repository now contains a real minimal prototype:

- Rust host uses `deno_core`
- local `.ts` worker modules are loaded and transpiled inside the host
- the worker contract is `fetch(request, env, ctx)`
- workers receive a minimal Web-compatible `Request`
- workers can return a minimal Web-compatible `Response`
- `Headers` is available in the worker runtime
- a Pingora HTTP ingress can route requests into the worker host
- a local worker can import another local `.ts` module
- worker project discovery walks upward to find `deno.json`
- `deno.json#imports` is honored for worker-local import aliases
- `deno.json#lock` supports `path` and `frozen`
- remote `http:` / `https:` modules can be integrity-checked against `deno.lock`
- remote modules are cached under a worker-local prepare cache directory and reused by later prepares
- prepare cache snapshots now expose `entry_count` and `total_bytes`
- worker project snapshots now expose a local `artifact_id` marker as `local-sha256:<hex>`
- direct `jsr:` specifiers are rewritten to `https://jsr.io/...`
- direct `npm:` specifiers are rewritten to `https://esm.sh/...` for the experiment
- the host returns a Rust `WorkerResponse`
- worker modules can now optionally export `websocket = { onOpen, onMessage, onClose }`
- the runtime now captures `ctx.send(string)` / `ctx.close(code?, reason?)` as Rust-owned websocket commands
- Pingora ingress now supports a first websocket path on HTTP/1.1
- current websocket scope is intentionally narrow:
  - text frames only
  - ping/pong supported
  - close supported
  - no binary frames
  - no fragmented frames
  - no direct socket ownership in TS
- `/_hardess/ingress-state` now includes websocket ingress counters:
  - upgrade requests / accepted / rejected
  - active / peak / completed sessions
  - average open callback runtime / open command write cost
  - inbound / outbound message counts
  - average per-message runtime / command write / total handling cost
  - ping/pong counts
  - close counts
  - protocol/runtime error counts
- websocket experiment benchmark scaffold now exists:
  - Pingora worker echo target:
    - `workers/benchmark_websocket/mod.ts`
  - Bun native echo baseline:
    - `bench/bun_native_websocket.ts`
  - shared round-trip client:
    - `bench/ws_roundtrip.ts`
  - runtime-only websocket micro-benchmark:
    - `crates/gateway-host/examples/websocket_runtime_micro.rs`

The current prototype now uses a mixed bridge:

- request metadata crosses the Rust <-> V8 boundary as a native Rust-backed host object
- inbound request body is now lazy and ingress-driven instead of being pre-read into a string
- `env` and `ctx` still cross via `serde_v8`

The execution model should now be read as:

- host owns global lifecycle
- Pingora session owns network lifecycle
- request task is the execution unit
- runtime shard is the async execution container
- response head is normalized first, and response body can now stream back through an internal gateway bridge

Current request path:

1. Pingora reads the incoming HTTP request
2. Rust normalizes it into the internal host ABI `WorkerRequest`
3. Rust creates an internal gateway request bridge for the body when a request body is expected
4. Rust wraps the request metadata plus body bridge as a `cppgc` host object inside V8
5. the cached JS trampoline materializes a minimal Web `Request` facade over that backing object
6. TS business logic runs only against `fetch(request, env, ctx)`

The experiment now keeps only one invocation path:

- `fetch(request: Request, env, ctx)`

It no longer builds per-request JavaScript source strings to invoke the
worker.

Instead, each runtime slot now:

- bootstraps minimal Web runtime helpers once
- imports the worker module once
- resolves `fetch(...)` once
- caches one async invocation trampoline function in V8

Each request is then passed into that cached trampoline as native V8 values.

When worker code consumes the request body, the runtime asks ingress for the
next chunk on demand. If worker code never touches the body, ingress never
reads it.

That means this is still proving the host/runtime contract first, not the
final zero-copy or Web-standards-complete runtime shape, but the request path
is now materially closer to the target architecture than the earlier
JSON-shaped request bridge.

This workspace no longer contains a second protocol path.

The host now supports one TS invocation style:

- `fetch(request: Request, env, ctx)` for the Workers-style Web path

For package resolution, the current experiment supports:

- local relative/file imports
- `deno.json#imports` alias resolution
- remote `http:` / `https:` module loading
- `deno.lock` discovery and frozen integrity checks for remote modules
- direct `jsr:` / `npm:` specifier rewriting

This is enough to prove the package-management direction, but it is not yet a
full Deno CLI-compatible graph / cache / lockfile implementation.

It is also not yet the final low-copy ingress path. Today the host still
normalizes Pingora input into the internal ABI before creating the Web
`Request` seen by TS.

## Run It

Run the Pingora ingress:

```bash
cargo run -p gateway-host --bin pingora_ingress -- \
  workers/hello/mod.ts \
  --listen 127.0.0.1:6190 \
  --worker-id pingora-demo \
  --runtime-threads 2 \
  --queue-capacity 64 \
  --exec-timeout-ms 5000 \
  --shutdown-drain-timeout-ms 30000
```

Optional Pingora listener/socket tuning flags:

- `--tcp-fastopen-backlog <N>`
- `--tcp-keepalive-idle-secs <N>`
- `--tcp-keepalive-interval-secs <N>`
- `--tcp-keepalive-count <N>`
- `--tcp-reuseport <true|false>`
- Linux only:
  - `--tcp-keepalive-user-timeout-ms <N>`

Then send a request:

```bash
curl -X POST 'http://127.0.0.1:6190/demo?x=1' \
  -H 'x-test: 7' \
  -H 'content-type: text/plain' \
  --data 'hello-from-pingora'
```

Inspect runtime pool metrics:

```bash
curl 'http://127.0.0.1:6190/_hardess/runtime-pool'
```

Inspect the active worker project's prepare cache:

```bash
curl 'http://127.0.0.1:6190/_hardess/module-cache'
```

Inspect ingress drain state:

```bash
curl 'http://127.0.0.1:6190/_hardess/ingress-state'
```

`/_hardess/ingress-state` now also includes coarse ingress timing breakdowns:

- `average_request_read_ms`
- `average_request_build_ms`
- `average_runtime_execute_ms`
- `average_response_write_ms`
- `average_finish_ms`
- `average_request_total_ms`
- `active_request_tasks`
  - current inflight request-task count plus per-task method / uri / client /
    body-mode / phase / age snapshot
- `recent_request_tasks`
  - a bounded recent-completion view with per-task outcome / last-phase /
    duration snapshot

Inspect worker generations:

```bash
curl 'http://127.0.0.1:6190/_hardess/generations'
```

The generation snapshot now includes:

- `desired_artifact_id`
- `prepared_artifact_id`
- `active_artifact_id`
- `failed_artifact_id`
- `desired_declared_artifact_id`
- `desired_declared_version`
- `prepared_declared_artifact_id`
- `prepared_declared_version`
- `active_declared_artifact_id`
- `active_declared_version`
- `failed_declared_artifact_id`
- `failed_declared_version`

For the current experiment, these are local runtime-visible markers derived from
the worker project files. They are not yet control-plane-issued version ids, but
they are stable enough to answer "which local artifact did this generation load?"

The `declared_*` fields are different: they are optional control-plane-facing
markers copied from the desired-worker payload, so status APIs can show both:

- what the node actually loaded locally
- what artifact / version the control plane said it should be loading

Reload the configured worker entry as a new generation:

```bash
curl -X POST 'http://127.0.0.1:6190/_hardess/reload-worker'
```

Apply a debug desired-worker payload that simulates future control-plane input:

```bash
curl -X POST 'http://127.0.0.1:6190/_hardess/apply-worker' \
  -H 'content-type: application/json' \
  --data '{
    "worker_entry": "workers/hello/mod.ts",
    "declared_artifact_id": "cp-artifact-42",
    "declared_version": "worker-v2"
  }'
```

Force a prepare-cache cleanup pass for the active worker project:

```bash
curl -X POST 'http://127.0.0.1:6190/_hardess/cleanup-cache'
```

## Verify It

```bash
cargo check
cargo test
```

## Current Contract

The current Rust-side prototype ABI is intentionally small:

- `WorkerRequest`: `method`, `url`, `headers`, optional buffered `body` for direct/internal call sites
- `WorkerEnv`: `worker_id`, `vars`
- `WorkerContext`: metadata plus injected `waitUntil(...)`
- `WorkerResponse`: `status`, `headers`, `body`

For Pingora ingress specifically, the host now wraps `WorkerRequest` in an
internal gateway request type so the request body can stay lazy and stream on
demand.

The host injects a `ctx.waitUntil(...)` function and waits for all registered
promises with `Promise.allSettled(...)` before finishing the invocation. This
is good enough for a phase-0 experiment, but it is not the final production
semantics.

Inside the worker runtime, the host now bootstraps a small Web runtime layer:

- `Headers`
- `Request`
- `Response`

This layer is intentionally small. It currently focuses on:

- request method / url / headers / lazy request body
- response status / headers / buffered or async-iterable body
- `request.body` async iteration
- `text()`, `json()`, `arrayBuffer()`

It still does not try to implement the broader Fetch/Web platform surface, and
`Request.clone()` with a streaming body is intentionally unsupported in this
experiment.

For Pingora integration, the current implementation now uses a small runtime
thread pool:

- each runtime thread owns one initialized `deno_core` runtime
- each runtime slot imports the worker and caches an invocation trampoline during initialization
- Pingora request handling forwards work into that pool
- Pingora request bodies are now read lazily only when the worker asks for the next chunk
- Pingora response bodies can now be streamed back chunk-by-chunk from the worker runtime
- requests are distributed round-robin across runtime threads
- each runtime thread has a bounded queue
- when all runtime queues are full, Pingora returns `503 Service Unavailable`
- each runtime thread has an execution watchdog
- when a worker execution exceeds `--exec-timeout-ms`, Pingora returns `504 Gateway Timeout`
- a timed-out runtime slot is treated as unhealthy and rebuilt before reuse
- requests that were queued on that old slot are retried once after rebuild
- if that retry still cannot find a healthy slot, Pingora returns `503 Service Unavailable`
- `SIGTERM` / `SIGQUIT` first switch the ingress into draining mode
- while draining, new requests are rejected with `503 Service Unavailable`
- existing in-flight requests are allowed to finish until `--shutdown-drain-timeout-ms`
- after app-level draining finishes, Pingora shutdown proceeds without adding another fixed grace-period sleep
- ingress-side `bad_request`, `overloaded`, `execution_timeout`, `temporarily_unavailable`, and `shutdown_draining` now use the same public JSON error surface
- a JSON metrics endpoint is exposed at `/_hardess/runtime-pool`
- a JSON module-cache endpoint is exposed at `/_hardess/module-cache`
- a JSON ingress-state endpoint is exposed at `/_hardess/ingress-state`
- a JSON generation snapshot endpoint is exposed at `/_hardess/generations`
- a cache-cleanup control endpoint is exposed at `POST /_hardess/cleanup-cache`
- a debug desired-worker apply endpoint is exposed at `POST /_hardess/apply-worker`
- a reload control endpoint is exposed at `POST /_hardess/reload-worker`
- the local `reload-worker` path is now a debug-only wrapper around an internal desired-worker apply path
- worker reload is generation-based: warm next pool, switch active generation, then drain the old one
- generation snapshots now include worker project prepare metadata such as `deno.json`, `deno.lock`, and frozen-lock status
- generation snapshots now include `module_cache_dir`, so the prepare cache location is visible from the control surface
- generation snapshots now include `module_cache.entry_count` and `module_cache.total_bytes`
- generation manager snapshots now include `version_state` with `desired`, `prepared`, `active`, and `failed` generation tracking
- `version_state` and `last_prepare` now include timestamps, and failure paths carry an experiment-level `error_kind`
- generation and prepare snapshots now carry optional control-plane-facing markers such as `declared_artifact_id` and `declared_version`
- `version_state` now also carries declared markers, so control-plane polling does not need to reconstruct desired/active status from nested generation entries
- generation manager snapshots now include `last_prepare` so a failed reload attempt is still visible even if traffic stays on the old generation
- generation snapshots pin the project metadata that was actually loaded for that generation
- the module-cache endpoint still inspects the current on-node worker project state

The minimal desired-worker payload shape is now:

- `worker_entry`: local worker entry path on the node
- `declared_artifact_id`: optional control-plane artifact marker
- `declared_version`: optional control-plane version marker

In this experiment the runtime still prepares from a local `worker_entry`, but the
apply path no longer depends on the old `reload current config` assumption.

This is still an experiment-level execution model, but it is materially closer
to the target architecture than creating a fresh runtime per request.

The current runtime pool snapshot includes:

- `runtime_threads`
- `queue_capacity_per_thread`
- `exec_timeout_ms`
- `submitted`, `completed`, `failed`
- `overloaded`, `timed_out`, `recycled`, `rebuilt`
- `inflight`, `queued`
- `average_exec_ms`
- per-thread `queued`, `inflight`, `completed`, `failed`, `timed_out`, `recycled`, `rebuilds`

These counters currently reflect runtime attempt events. A request that first
hits a recycling slot and then succeeds on retry can increment both
`recycled` and `completed`.

The ingress-state snapshot includes:

- `drain.draining`
- `drain.inflight_requests`
- `active_request_tasks`
- `recent_request_tasks`
- `runtime_pool` with the same runtime metrics as `/_hardess/runtime-pool`
- `generations` with the same live project/cache metadata as `/_hardess/generations`
  and the runtime-side `version_state`

## Deliberate Gaps

This first runnable version still does not do the following:

- no production-grade Pingora integration yet
- no `deno.lock` writes or additive updates yet
- no lock coverage for the full future `jsr:` / `npm:` package graph yet
- no full Deno package graph semantics yet
- no zero-copy response handoff into Pingora yet
- no sandbox or isolate pooling yet
- no zero-copy body pipeline yet
- no business-safe request-path warmup hook yet; current warmup is structural

The current remote-module cache cleanup policy is intentionally simple:

- delete orphaned or malformed cache files
- when `deno.lock` exists, delete cache entries no longer referenced by the current lockfile
- cap retained cache entries and total bytes with a small experiment-level limit

The mutable `/_hardess/*` endpoints are experiment/debug surfaces.

They are useful while building the runtime, but the intended production
direction is control-plane / runtime separation:

- the control plane decides worker versions, rollout, and rollback
- the runtime node prepares and serves the requested version
- local write endpoints should eventually become debug-only or disappear from the mainline production path

## Why This Is Enough For Phase 0

This prototype answers the immediate experiment question:

- Rust can host a Workers-style TypeScript execution model
- `deno_core` is workable as the embedded runtime
- the host/runtime ABI can be expressed cleanly enough to keep iterating
- Pingora can hand requests into a reusable runtime-thread pool

The next step is not more stub code. The next step is choosing which direction
to deepen first:

- move upward into package resolution and `deno.json`
- move downward into body ownership / low-copy transport
- move deeper into Pingora/runtime execution model, backpressure, and isolate lifecycle

## Graduation criteria

This experiment is worth promoting only if it can show all of the following:

- the Rust host contract is simpler, not more confusing, than the current Bun worker path
- TS worker execution latency is acceptable for Hardess-style gateway traffic
- the operational model stays understandable
- the resulting system still supports Hardess's product direction rather than forcing a different product

## Current recommendation

Treat this as a research track, not the default roadmap.

The current Bun/TS runtime remains the main line until this experiment proves a material advantage.
