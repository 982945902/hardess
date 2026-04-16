# Runtime Invocation Bridge Design for the Pingora Experiment

Date: 2026-04-15

## Decision

Do not invoke workers by generating JavaScript source per request.

Use a startup-time cached invocation trampoline instead.

Short version:

`Import once. Resolve handler once. Cache one invoke function. Pass request data as V8 values.`

This design now assumes exactly one handler contract:

- `fetch(request, env, ctx)`

No alternate compatibility handler path remains in scope.

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
3. import the worker entry module
4. resolve `fetch(request, env, ctx)`
5. build one async JS trampoline
6. store that trampoline as `v8::Global<v8::Function>`

After that, each request:

1. is normalized on the Rust side into `WorkerRequest`
2. creates a gateway-local lazy body bridge when a request body is expected
3. is wrapped into a native `cppgc` host object inside V8
4. is materialized into a minimal Web `Request` facade by the cached trampoline
5. calls the cached trampoline through `call_with_args_and_await(...)`
6. deserializes the normalized response back into Rust

## Trampoline responsibilities

The cached trampoline is intentionally small.

Its job is only to:

- construct a minimal Web `Request` facade over a Rust-backed request object
- expose lazy request-body reads back into ingress on demand
- provide `ctx.waitUntil(...)`
- await the worker result
- normalize the result into the Rust-facing response shape

Business logic stays in TypeScript.

Rust is not taking over request semantics.

Rust also does not expose Pingora's Rust request struct directly to TS in the
current design.

Current boundary choice:

- Pingora request remains an ingress/internal Rust object
- `WorkerRequest` is the host transport shape
- a gateway-local request body bridge connects runtime body reads back to ingress
- a Rust-backed `WorkerRequestHandle`-style host object is the V8 bridge shape
- Web `Request` is the TS-facing business shape

This avoids the earlier JSON-shaped request serialization step without exposing
Pingora internals directly into the TS surface.

It also keeps the TS API stable while allowing lazy inbound body reads now,
while still leaving room for later lower-copy header/body access.

The important ownership rule is:

- the JS-visible backing object is runtime-scoped and strongly owned for the duration of the invocation
- this is intentionally not modeled as a `WeakRef`

Reason:

- a weak reference does not solve cross-boundary ownership
- it only makes request field access fail later and less predictably
- the safer first cut is a GC-managed host object with explicit runtime-scoped lifetime

## Next Request Shape

The next step for this bridge is not "add more JS wrapper code".

It is:

- move the current `Request` implementation closer to a real Rust-backed object
  with a thinner JS policy layer

The target internal shape is:

- one Rust-backed request backing object
- one JS-side internal request state object
- one JS-facing `Request` wrapper with minimal policy logic

More concretely:

- Rust backing owns:
  - request head source
  - lazy body source
- JS internal state owns:
  - cached `method`
  - cached `url`
  - cached `headers`
  - body state transitions
  - `bodyUsed`
- JS-facing `Request` owns:
  - Web-compatible surface methods and getters
  - very little transport logic

This is intentionally closer to the `Deno` posture:

- lazy first access
- cached request fields
- explicit body state machine

and intentionally not closer to:

- generic constructor-heavy wrapper logic
- repeated bridge helper lookups
- eager request normalization on the JS side

The network/runtime policy still remains Hardess-owned:

- ingress ownership
- drain policy
- timeout policy
- generation lifecycle

So the design goal is:

- `borrow Deno's object/runtime shape`
- `keep Hardess' transport/runtime policy`

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

## Request Body Strategy

Inbound request bodies are now lazy.

That means:

- ingress does not pre-read the body before worker execution
- runtime body reads send explicit "next chunk" requests back to ingress
- if worker code never touches `request.body`, `text()`, `json()`, or `arrayBuffer()`, the body is never read

This directly helps:

- auth / quota / routing rejection before body consumption
- proxy-style workers that may decide whether to forward before opening the body
- large request bodies that should not become one eager string allocation

Current completion policy after worker response:

- if the body was fully consumed, do nothing
- if the body was not consumed and the request is small with a known `Content-Length`, drain it
- otherwise disable keepalive instead of forcing a blind drain

This is a conservative first cut that favors correctness and predictable
ownership over maximum connection reuse.

## Response Body Strategy

Outbound response bodies are now also able to stream.

That means:

- the worker may return `new Response(asyncIterableBody, init)`
- runtime normalizes the response head first
- ingress receives status/header metadata before the full response body is buffered
- downstream body writes pull the next worker chunk on demand

Current boundary choice:

- buffered/direct call sites can still collapse the response into `WorkerResponse`
- Pingora ingress uses an internal gateway response bridge instead of `Response<Vec<u8>>`
- the runtime slot stays occupied until the response stream finishes or the ingress side drops it

This keeps the public TS surface stable while removing the earlier
"worker body must be fully materialized before Pingora can respond" limitation.

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
- no direct use of Pingora request structs inside the TS API surface yet
- no full Fetch standard compatibility yet
- no second protocol/compatibility invocation path

## Next steps

1. keep this cached trampoline model as the only request invocation path
2. add package-management support on top of it with `deno.json`, `jsr:`, and `npm:`
3. later evaluate lower-copy body transport without changing the TS business surface
4. later decide whether headers/body should stay op-backed or move to a deeper native Web object implementation
