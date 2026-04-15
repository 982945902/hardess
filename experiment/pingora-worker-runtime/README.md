# Pingora + Rust + TS Runtime Experiment

Status: exploratory, runnable

Related docs:

- [TS runtime selection note](./design-ts-runtime-selection.md)
- [Package management design note](./design-package-management.md)
- [Public error contract design note](./design-public-error-contract.md)
- [Runtime invocation bridge design note](./design-runtime-invocation-bridge.md)
- [Control Plane / Runtime Separation note](./design-control-plane-runtime-separation.md)
- [Worker generation rollout design note](./design-worker-generation-rollout.md)
- [WebSocket runtime design note](./design-websocket-runtime.md)
- [V1 to V2 compatibility design note](./design-v1-v2-compatibility.md)
- [V1 compatibility adapter design note](./design-v1-compat-adapter.md)
- [V1 compatibility contract design note](./design-v1-compat-contract.md)
- [SDK compatibility design note](./design-sdk-compatibility.md)

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

## Open technical choices

The TS runtime is intentionally not locked yet. Real options include:

- embed a JS engine directly in Rust
- use a runtime like `deno_core`
- run a separate worker runtime process and talk over RPC
- compile workers to another portable form and host that

This experiment should compare those options after the Rust host contract is clear.

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
- direct `jsr:` specifiers are rewritten to `https://jsr.io/...`
- direct `npm:` specifiers are rewritten to `https://esm.sh/...` for the experiment
- the host returns a Rust `WorkerResponse`

The current prototype intentionally uses a JSON-shaped bridge for
`request/env/ctx/response` at the Rust <-> V8 value boundary.

It no longer builds per-request JavaScript source strings to invoke the
worker.

Instead, each runtime slot now:

- bootstraps minimal Web runtime helpers once
- imports the worker module once
- resolves either `fetch(...)` or `fetchCompat(...)` once
- caches one async invocation trampoline function in V8

Each request is then passed as V8 values into that cached trampoline.

That means this is still proving the host/runtime contract first, not the
final zero-copy or Web-standards-complete runtime shape, but the request path
is now materially closer to the target architecture.

The host now supports two TS invocation styles:

- `fetch(request: Request, env, ctx)` for the Workers-style Web path
- `fetchCompat(request: ParsedV1Request, env: CompatEnv, ctx: CompatContext)` for the `v1` compatibility path

For package resolution, the current experiment supports:

- local relative/file imports
- `deno.json#imports` alias resolution
- remote `http:` / `https:` module loading
- `deno.lock` discovery and frozen integrity checks for remote modules
- direct `jsr:` / `npm:` specifier rewriting

This is enough to prove the package-management direction, but it is not yet a
full Deno CLI-compatible graph / cache / lockfile implementation.

## Run It

From this directory:

```bash
cargo run -p gateway-host -- workers/hello/mod.ts
```

With explicit request fields:

```bash
cargo run -p gateway-host -- \
  workers/hello/mod.ts \
  --method POST \
  --url http://localhost/demo \
  --body hello \
  --worker-id demo-worker
```

Expected output is a JSON response printed by the Rust host.

Run the `v1 compat` sample worker:

```bash
cargo run -p gateway-host -- workers/compat_v1/mod.ts --method POST --url 'http://localhost/compat?x=1&x=2' --body ping
```

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

Inspect worker generations:

```bash
curl 'http://127.0.0.1:6190/_hardess/generations'
```

Reload the configured worker entry as a new generation:

```bash
curl -X POST 'http://127.0.0.1:6190/_hardess/reload-worker'
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

- `WorkerRequest`: `method`, `url`, `headers`, `body`
- `WorkerEnv`: `worker_id`, `vars`
- `WorkerContext`: metadata plus injected `waitUntil(...)`
- `WorkerResponse`: `status`, `headers`, `body`

The host injects a `ctx.waitUntil(...)` function and waits for all registered
promises with `Promise.allSettled(...)` before finishing the invocation. This
is good enough for a phase-0 experiment, but it is not the final production
semantics.

For the `v1 compat` worker path, the host additionally:

- parses the incoming `WorkerRequest` into `ParsedV1Request`
- builds `CompatEnv` and `CompatContext` from the Rust-side request metadata
- returns public compat errors as JSON responses when request normalization fails
- normalizes `ParsedV1Response.error` into the same public compat JSON error surface
- injects `globalThis.HardessPublicErrors` from `contracts/public-errors.json` so TS can read the shared public error contract at runtime

Inside the worker runtime, the host now bootstraps a small compatibility layer:

- `Headers`
- `Request`
- `Response`

This layer is intentionally small. It currently focuses on:

- request method / url / headers / text body
- response status / headers / text body
- `text()`, `json()`, `clone()`

It does not yet try to implement streaming bodies or the broader Fetch/Web
platform surface.

For Pingora integration, the current implementation now uses a small runtime
thread pool:

- each runtime thread owns one initialized `deno_core` runtime
- each runtime slot imports the worker and caches an invocation trampoline during initialization
- Pingora request handling forwards work into that pool
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
- ingress-side `bad_request`, `overloaded`, `execution_timeout`, `temporarily_unavailable`, and `shutdown_draining` now use the same public compat JSON error surface
- a JSON metrics endpoint is exposed at `/_hardess/runtime-pool`
- a JSON module-cache endpoint is exposed at `/_hardess/module-cache`
- a JSON ingress-state endpoint is exposed at `/_hardess/ingress-state`
- a JSON generation snapshot endpoint is exposed at `/_hardess/generations`
- a cache-cleanup control endpoint is exposed at `POST /_hardess/cleanup-cache`
- a reload control endpoint is exposed at `POST /_hardess/reload-worker`
- the local `reload-worker` path is now a debug-only wrapper around an internal apply-state transition
- worker reload is generation-based: warm next pool, switch active generation, then drain the old one
- generation snapshots now include worker project prepare metadata such as `deno.json`, `deno.lock`, and frozen-lock status
- generation snapshots now include `module_cache_dir`, so the prepare cache location is visible from the control surface
- generation snapshots now include `module_cache.entry_count` and `module_cache.total_bytes`
- generation manager snapshots now include `version_state` with `desired`, `prepared`, `active`, and `failed` generation tracking
- generation manager snapshots now include `last_prepare` so a failed reload attempt is still visible even if traffic stays on the old generation
- generation/project snapshots are refreshed from disk when queried, so cache stats reflect the current on-node state

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
- `runtime_pool` with the same runtime metrics as `/_hardess/runtime-pool`
- `generations` with the same live project/cache metadata as `/_hardess/generations`
  and the runtime-side `version_state`

## Deliberate Gaps

This first runnable version still does not do the following:

- no production-grade Pingora integration yet
- no streaming request / response bodies yet
- no `deno.lock` writes or additive updates yet
- no lock coverage for the full future `jsr:` / `npm:` package graph yet
- no full Deno package graph semantics yet
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
