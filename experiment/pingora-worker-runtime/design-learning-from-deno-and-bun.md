# Learning from Deno and Bun for the Pingora Runtime Experiment

Date: 2026-04-15

## Goal

Stop guessing the next optimization target in a vacuum.

This note answers a narrower question:

- what do `Deno` and `Bun` already do that is relevant to the current
  `Pingora + Rust + TS runtime` experiment?

The point is not to copy either runtime wholesale.

The point is:

- learn the right low-level shape from `Deno`
- learn the right product/runtime control shape from `Bun`

## Short conclusion

The current experiment should learn more from `Deno` than from `Bun`.

Reason:

- `Deno` is also a `Rust + V8 + embedder + extension/op` system
- `Bun` is valuable, but it is built on a different engine/runtime stack

So the practical split is:

- `Deno` teaches:
  - host object shape
  - fast op shape
  - lazy Web object materialization
  - snapshot/runtime bootstrap strategy
- `Bun` teaches:
  - server API shape
  - per-request control shape
  - reload/stop/metrics ergonomics

## 1. What Deno is doing that matters here

## 1.1 Runtime architecture

From `deno_core` architecture:

- `JsRuntime` is the embedder-owned runtime shell
- embedders attach `extension`s
- extensions provide:
  - JS/TS modules
  - `op`s
  - host/runtime services
- `cppgc` objects are a first-class way to let Rust own data while JS holds the
  object

Why this matters to this experiment:

- it validates the direction of using Rust-backed host objects for request/runtime
  state instead of pushing everything through serialization
- it also validates that the right boundary is:
  - Rust owns lifecycle/state/resources
  - JS sees a Web-like API backed by Rust

## 1.2 `op2` fastcalls and CppGC are the intended hot-path tools

`deno_core` explicitly supports:

- `#[op2(fast)]` for fastcall-compatible ops
- `cppgc` native JS classes backed by Rust types

That is important because it means:

- Deno does not treat serde-style conversion as the only bridge
- the framework itself expects embedders to use:
  - fast ops for tiny hot-path calls
  - CppGC objects for native-backed JS objects

For this experiment, that reinforces one strong design rule:

- `Request` and later `Response` should become deeper Rust-backed objects
  instead of thin JS wrappers that repeatedly ask Rust for pieces

## 1.3 Deno's `Request` implementation is aggressively lazy

Reading `ext/fetch/23_request.js` and `22_body.js` gives three useful signals.

Signal A:

- `InnerRequest` stores method/url/header access behind inner functions and lazy
  getters

Signal B:

- `Request.method` and `Request.url` cache after first access

Signal C:

- body is represented by an `InnerBody` that can hold:
  - static bytes
  - a stream
  - clone/proxy behavior

The important part is not the exact Deno implementation detail.

The important part is the posture:

- do not eagerly materialize Web request state if user code may never touch it
- keep body as a lazily consumed object
- cache first access instead of rebuilding every access

This lines up with the wins already seen in this experiment:

- lazy request head/body work helped
- removing eager gateway normalization helped

## 1.4 Deno snapshot support matters, but not for the current hottest path

`deno_core` architecture also emphasizes snapshot support.

That matters for:

- runtime slot bootstrap cost
- generation prepare time
- cold-start jitter

It probably does not explain the current short-circuit request-path benchmark gap.

So snapshot work is valid, but later than the current request-path hot-path work.

## 2. What Bun is doing that matters here

## 2.1 Bun's server API is runtime-integrated, not bolted on later

From the `Bun.serve` docs, Bun bakes server lifecycle and request controls into
the runtime-facing server object:

- route table support
- `server.reload()`
- `server.stop()`
- per-request `server.timeout(req, seconds)`
- built-in counters like:
  - `pendingRequests`
  - `pendingWebSockets`

Why this matters:

- Bun's lesson is not "use Zig" or "copy Bun internals"
- Bun's lesson is:
  - good server runtimes expose lifecycle and control as first-class runtime
    capabilities

This matches the product direction already emerging in this repo:

- drain state
- generation rollout
- runtime pool metrics

## 2.2 Bun's timeout model is especially instructive

Bun exposes:

- a global `idleTimeout`
- a per-request override with `server.timeout(req, seconds)`
- explicit guidance for long-lived streaming responses

This is the cleanest product-facing shape among the sources reviewed.

For Hardess v2, the lesson is:

- timeouts should not only exist as internal knobs
- the runtime should have a clear per-request control point
- long-lived or special traffic should be able to override default timeout
  behavior without changing the whole server's policy

## 2.3 Bun's reload/stop API shape is also worth copying

Bun exposes:

- `server.reload()` for live handler updates
- `server.stop()` for graceful or forceful shutdown

This mirrors the shape that a future Hardess runtime should present to the
control plane and operator surface:

- apply new generation
- graceful drain
- forceful shutdown fallback

The experiment already has the beginnings of this, but Bun is a good reminder
that these controls should feel runtime-native, not debug-endpoint-native.

## 3. What this means for the current experiment

## 3.1 Strongly validated directions

These directions are reinforced by the Deno/Bun study:

1. keep Rust ownership of runtime/request state
2. expose JS-facing Web objects backed by Rust host objects
3. make request fields lazy and cache first access
4. avoid serde-style bridge work on the hot request path
5. keep timeout/reload/stop/state as first-class runtime controls

## 3.2 Directions that now look weaker

These now look like lower-value directions for the next iteration:

- micro-optimizing tiny `env/ctx` object creation
- changing watchdog synchronization primitives without stronger evidence
- doing broad response-bridge rewrites before fixing deeper request/runtime path
  costs

## 3.3 Concrete recommendations for Hardess v2

### Immediate

- deepen `Request` into a true Rust-backed host object
  - less JS facade logic
  - more native getters/methods
- keep `headers/url/body` lazy
- continue removing request-path normalization before runtime invocation
- design a first-class per-request timeout control surface

### Near term

- investigate runtime queue/oneshot handoff cost with targeted profiling
- consider whether the request invocation path should move closer to a native
  method call shape instead of generic bridge-object normalization
- evaluate startup snapshots for generation prepare/runtime slot bootstrap

### Deliberately later

- full `Response` host-object migration
- full Bun-like route table integration
- full Web-standard parity

## 4. The one-line design takeaway

If this experiment keeps chasing the right shape, it should evolve toward:

- `Pingora ingress`
- `Rust-owned runtime state`
- `CppGC-backed Web request objects`
- `minimal hot-path ops`
- `runtime-native lifecycle controls`

That is much closer to `Deno's embedder model` plus `Bun's server-control model`
than to the current thin-JS-wrapper plus repeated bridge-call shape.
