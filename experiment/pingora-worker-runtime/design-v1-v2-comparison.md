# Hardess v1 vs Pingora Experiment Comparison

Date: 2026-04-15

Related benchmark record:

- [benchmark-optimization-log.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/benchmark-optimization-log.md)

## Goal

Compare the current Bun-based Hardess runtime (`v1`) with the Pingora + Rust +
TS runtime experiment (`v2 experiment`) based on what is actually implemented
today.

Short version:

`v1 is more complete as a product runtime. v2 experiment already has the cleaner HTTP kernel direction.`

## Scope

This comparison focuses on:

- HTTP request path
- worker execution boundary
- request / response body model
- reload / rollout model
- graceful shutdown
- observability and operator surface
- WebSocket / cluster completeness

It does not claim protocol compatibility.

## Current one-line judgment

If you want to ship the current Hardess product today:

- `v1` is stronger

If you ask which direction has the better long-term HTTP gateway kernel:

- `v2 experiment` is stronger

## Comparison Table

| Topic | v1 | v2 experiment |
|---|---|---|
| Runtime base | Bun + TypeScript | Pingora + Rust + embedded TS runtime |
| HTTP ingress | app-level Bun `fetch` path | direct Pingora `ServerSession` path |
| Worker contract | `fetch(request, env, ctx)` | `fetch(request, env, ctx)` |
| Request body | worker path effectively buffered / cloned in main flow | lazy ingress-driven streaming |
| Response body | upstream body buffered before return | worker response can stream chunk-by-chunk |
| Upstream proxy kernel | Bun `fetch` based | Pingora-native ingress, upstream proxy still evolving |
| Worker reload | file-based shadow-copy reload | generation-based prepare -> switch -> drain |
| Shutdown | Bun runtime drain + WS grace window | in-flight HTTP drain + generation drain model |
| Admin/observability | broader runtime/operator surface today | good HTTP/runtime surfaces for experiment |
| WebSocket | mature baseline exists | not yet the focus / not complete |
| Cluster path | static multi-node baseline implemented | not yet the focus / not complete |

## 1. HTTP kernel

## v1

The v1 HTTP path is:

- shared auth
- worker
- proxy upstream

Reference:

- [src/runtime/ingress/http.ts](/Users/lishuo121/hardess/src/runtime/ingress/http.ts)
- [src/runtime/proxy/upstream.ts](/Users/lishuo121/hardess/src/runtime/proxy/upstream.ts)

This is good enough for the current scale and product phase.

But structurally it still sits on Bun's app-level request path.

That means the kernel and lifecycle control are simpler, but less explicit than
the Pingora path.

## v2 experiment

The v2 experiment now uses Pingora directly and has already dropped the
`ServeHttp -> Response<Vec<u8>>` helper path for the main ingress logic.

Reference:

- [pingora_ingress.rs](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/crates/gateway-host/src/bin/pingora_ingress.rs)

That matters because:

- request read timing is explicit
- response write timing is explicit
- keepalive behavior is explicit
- drain behavior is explicit

This is a materially better HTTP kernel shape than v1.

## Verdict

On pure HTTP kernel shape:

- `v2 experiment` wins

## 2. Worker execution boundary

## v1

v1 already has the right interface shape:

- `fetch(request, env, ctx)`

Reference:

- [src/runtime/workers/runner.ts](/Users/lishuo121/hardess/src/runtime/workers/runner.ts)

But the runtime implementation is still Bun-first:

- worker module load through shadow-copy file import
- timeout through JS-side timer race
- same-process TS execution

This is productive, but not the cleanest runtime kernel if the system keeps
growing.

## v2 experiment

v2 keeps the same external worker contract, but the host boundary is cleaner:

- Rust owns lifecycle
- TS owns business logic
- request/response cross the boundary through explicit host/runtime bridge code

Reference:

- [design-runtime-invocation-bridge.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/design-runtime-invocation-bridge.md)
- [lib.rs](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/crates/gateway-host/src/lib.rs)

This is closer to the intended Hardess v2 architecture.

## Verdict

On worker boundary clarity:

- `v2 experiment` wins

On implementation maturity and simplicity today:

- `v1` wins

## 3. Request and response body model

## v1

v1 is explicitly still buffered on the proxy response side.

Reference:

- [src/runtime/proxy/upstream.ts](/Users/lishuo121/hardess/src/runtime/proxy/upstream.ts)

The code reads the full upstream body before building the final `Response`.

On the worker side, the main HTTP path also uses `request.clone()` before worker
execution.

Reference:

- [src/runtime/ingress/http.ts](/Users/lishuo121/hardess/src/runtime/ingress/http.ts)

That is fine for a small-and-beautiful service, but it is not the best shape
for:

- large bodies
- reject-before-read behavior
- pass-through proxy cases

## v2 experiment

v2 now has:

- lazy inbound request-body streaming
- streaming worker response body
- typed-array-native response chunk bridge

References:

- [design-runtime-invocation-bridge.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/design-runtime-invocation-bridge.md)
- [design-low-copy-response-bridge.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/design-low-copy-response-bridge.md)

This is a major structural improvement over v1.

## Verdict

On body-path architecture:

- `v2 experiment` wins clearly

## 4. Reload and rollout model

## v1

v1 supports config reload and worker reload and is already usable.

Reference:

- [docs/hardess-architecture.md](/Users/lishuo121/hardess/docs/hardess-architecture.md)
- [src/runtime/workers/loader.ts](/Users/lishuo121/hardess/src/runtime/workers/loader.ts)

But the worker model is still local-file / shadow-copy oriented.

That is convenient for repo development, but less clean as a long-term node-side
runtime state machine.

## v2 experiment

v2 has already moved to a better runtime state model:

- desired
- prepared
- active
- failed

And reload is generation-based:

- prepare next generation
- switch traffic
- drain old generation

References:

- [design-worker-generation-rollout.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/design-worker-generation-rollout.md)
- [pingora_ingress.rs](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/crates/gateway-host/src/bin/pingora_ingress.rs)

This is better than v1 from a control-plane and production-lifecycle point of
view.

## Verdict

On rollout model:

- `v2 experiment` wins

## 5. Graceful shutdown

## v1

v1 already has real shutdown thinking:

- shutdown signal handling
- HTTP drain wait
- WS shutdown grace window

Reference:

- [src/runtime/server.ts](/Users/lishuo121/hardess/src/runtime/server.ts)
- [src/runtime/app.ts](/Users/lishuo121/hardess/src/runtime/app.ts)

This is product-shaped and includes WebSocket semantics, which matters because
v1 is not just an HTTP gateway.

## v2 experiment

v2 now has:

- in-flight HTTP request drain
- generation drain
- explicit keepalive disable when request body is intentionally left unread

This is very clean for HTTP.

But it does not yet carry the same full WebSocket/runtime shutdown scope as v1.

## Verdict

On HTTP-only shutdown semantics:

- `v2 experiment` is cleaner

On full-product shutdown completeness:

- `v1` wins today

## 6. Observability and operator surface

## v1

v1 has the broader operator surface today:

- health
- ready
- metrics
- Prometheus export
- cluster peers
- threshold-based alerts
- broader WS/runtime counters

References:

- [src/runtime/app.ts](/Users/lishuo121/hardess/src/runtime/app.ts)
- [src/runtime/observability/metrics.ts](/Users/lishuo121/hardess/src/runtime/observability/metrics.ts)
- [docs/hardess-architecture.md](/Users/lishuo121/hardess/docs/hardess-architecture.md)

## v2 experiment

v2 has good experiment-grade introspection:

- runtime pool
- module cache
- ingress state
- generations
- prepare/version state

This is strong for the HTTP/runtime-generation part, but still narrower than
the whole v1 product runtime.

## Verdict

On breadth of observability today:

- `v1` wins

On clarity of runtime-generation state:

- `v2 experiment` wins

## 7. WebSocket and cluster completeness

This is the biggest non-symmetric area.

## v1

v1 already includes:

- WS auth handshake
- heartbeat
- routing
- recvAck / handleAck
- SDK delivery semantics
- static cluster baseline

## v2 experiment

The current experiment is not there yet.

Its value today is:

- proving the future HTTP/runtime kernel

not:

- replacing the full Hardess realtime product

## Verdict

On actual product completeness:

- `v1` wins by a large margin

## Final judgment

## What v1 is still better at

- it is the real product baseline today
- it already includes WS + SDK + cluster semantics
- it has broader operator and test coverage across the full runtime
- it is simpler to iterate on for current product work

## What v2 experiment is already better at

- HTTP ingress kernel shape
- request/response body architecture
- worker runtime boundary clarity
- generation-based rollout model
- explicit drain and lifecycle control

## Recommendation

The clean conclusion is:

- do not frame this as "v2 already replaces v1"
- do frame it as "v2 already has the better HTTP kernel, while v1 still owns full-product completeness"

That means the practical strategy should be:

1. keep `v1` as the shipping/product baseline
2. keep using the experiment to harden the HTTP/runtime kernel
3. only start serious replacement discussions once v2 has a believable WS/runtime story too

## Benchmark note

As of the current same-host fair shared-subset benchmark:

- `v1-short` is still materially faster than `v2-short`
- `v2-short` is currently closer to `v1-full` than to `v1-short`

That means the architecture direction remains valid, but the current `v2`
implementation still needs hot-path optimization before it can be considered a
real replacement candidate.
