# Runtime Invocation Bridge Design for the Pingora Experiment

Date: 2026-04-15

## Decision

Do not invoke workers by generating JavaScript source per request.

Use a startup-time cached invocation trampoline instead.

Short version:

`Import once. Resolve handler once. Cache one invoke function. Pass request data as V8 values.`

## Why

Per-request script generation has the wrong shape for this host.

It creates unnecessary risk in four places:

- request-path overhead grows with string building and source compilation work
- error reporting gets mixed with generated code frames
- escaping / serialization concerns leak into the control path
- runtime reload gets blurry because code loading and request invocation are not clearly separated

For Hardess, the host boundary should be explicit:

- Rust owns lifecycle and transport
- TS owns request handling logic
- the handoff should be values, not ad hoc source strings

## Current model

Each runtime slot initializes in this order:

1. create `JsRuntime`
2. bootstrap minimal Web runtime helpers
3. inject `HardessPublicErrors`
4. import the worker entry module
5. resolve either `fetch(request, env, ctx)` or `fetchCompat(request, env, ctx)`
6. build one async JS trampoline
7. store that trampoline as `v8::Global<v8::Function>`

After that, each request:

1. is normalized on the Rust side
2. is serialized into V8 values with `serde_v8`
3. calls the cached trampoline through `call_with_args_and_await(...)`
4. deserializes the normalized response back into Rust

## Trampoline responsibilities

The cached trampoline is intentionally small.

Its job is only to:

- construct a minimal Web `Request` when using the Web fetch path
- pass compat structs through unchanged for the `v1` compatibility path
- provide `ctx.waitUntil(...)`
- await the worker result
- normalize the result into the Rust-facing response shape

Business logic stays in TypeScript.

Rust is not taking over request semantics.

## Warmup implications

This design gives the experiment a meaningful structural warmup stage.

A runtime slot is considered structurally warm only after:

- the module graph is loaded
- the handler mode is resolved
- the trampoline is cached

That is enough to remove first-request costs from module loading and handler
discovery.

It is not yet full request-path warmup, because there is still no safe generic
synthetic request hook that can run arbitrary business workers before cutover.

## Relation to worker generations

This bridge design fits generation-based reload naturally.

Each generation owns its own:

- runtime pool
- imported module graph
- cached invocation trampolines

That means reload is:

- create next generation
- complete structural warmup
- atomically switch traffic
- drain old generation

No runtime performs an in-place code mutation after it is serving traffic.

## Non-goals

- no zero-copy request/response body path yet
- no streaming body bridge yet
- no direct use of Pingora request structs inside the TS API surface yet
- no full Fetch standard compatibility yet

## Next steps

1. keep this cached trampoline model as the only request invocation path
2. add package-management support on top of it with `deno.json`, `jsr:`, and `npm:`
3. later evaluate lower-copy body transport without changing the TS business surface
