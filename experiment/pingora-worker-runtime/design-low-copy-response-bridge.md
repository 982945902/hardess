# Low-copy Response Bridge Design for the Pingora Experiment

Date: 2026-04-15

## Goal

Reduce response-path copy and normalization overhead without changing the TS
business contract.

Short version:

`Keep Response streaming semantics. Shrink Rust <-> V8 body bridging cost.`

## Current state

The experiment now supports streaming response bodies end-to-end:

- worker returns `new Response(body, init)`
- body may be buffered or async-iterable
- runtime returns response head first
- Pingora ingress pulls body chunks on demand and writes them to downstream

The first low-copy tightening is now in place:

- JS response chunks stay as `Uint8Array` / `ArrayBufferView`
- Rust reads them through native V8 typed-array access instead of plain array decoding

What still remains deliberately conservative is:

- Rust still copies those bytes into owned memory before handing them to Pingora

This is correct and easy to reason about, but it is not the final shape.

## What is suboptimal today

The current response bridge still pays cost in two places:

- Rust copies chunk bytes out of V8-managed memory
- downstream writes still require owned bytes on the Rust side

For this experiment scale, this is acceptable.

For the longer-term Hardess v2 direction, this becomes worth tightening because
response bodies sit on the hot path for every proxied success case.

## Non-goal

This design is not trying to:

- expose Pingora response internals directly to TS
- move business logic into Rust
- redesign the public TS `Response` API
- solve zero-copy networking all the way to the socket

The target is narrower:

- reduce bridge overhead
- keep ownership explicit
- preserve the current worker-facing `Request/Response` model

## Design options

## Option A

Keep the current byte-array bridge.

Pros:

- already works
- easy to debug
- lowest implementation risk

Cons:

- extra copy/normalization cost remains
- not the right long-term hot-path shape

## Option B

Move response chunks to a typed-array-native bridge.

Shape:

- JS still returns `Response`
- runtime extracts each chunk as `Uint8Array` / `ArrayBufferView`
- Rust reads V8 backing memory through a narrower native bridge path
- ingress writes those bytes immediately to Pingora

Pros:

- materially less normalization overhead
- preserves current TS surface
- keeps response streaming model unchanged

Cons:

- tighter coupling to V8/`deno_core` internals
- requires more careful lifetime handling

## Option C

Make `Response` itself a deeper Rust-backed host object.

Shape:

- JS `Response` becomes more natively hosted
- status/header/body access are all op-backed or host-backed

Pros:

- potentially best long-term control
- can unify semantics more tightly

Cons:

- much larger implementation surface
- risks over-investing in host internals too early
- slows down the experiment

## Recommendation

The experiment has now completed the first half-step of Option B.

Current recommendation:

`keep the current Request/Response facade, keep the typed-array-native bridge, and only go deeper if profiling shows the remaining copy matters`

## Suggested staged rollout

## Stage 1

Keep current semantics and only change the internal chunk transport:

- no TS API change
- no ingress API change
- no generation/reload model change

Status:

- done

## Stage 2

Tighten accepted body chunk types:

- `Uint8Array`
- `ArrayBuffer`
- string

Everything else should still normalize conservatively or fail clearly.

Status:

- mostly done for the current experiment surface
- the bridge now expects `ArrayBuffer` / `ArrayBufferView` on the Rust boundary

## Stage 3

Only if needed later, evaluate a deeper native `Response` hosting path.

This should be deferred until there is evidence that:

- typed-array-native bridging is still not enough
- or broader Web runtime fidelity is already worth the complexity

## Ownership model

The key rule should stay the same:

- runtime owns the active response bridge
- ingress pulls chunks explicitly
- no background autonomous body pump is required for correctness

This mirrors the inbound request-body design and keeps the mental model clean.

## Open technical questions

- whether `serde_v8` should stay in the response head path or whether status/header extraction should also go more native
- whether response trailers should be considered now or explicitly deferred
- whether runtime slot occupancy during long response streaming is acceptable for the intended pool sizing

## Recommendation for now

- keep response head extraction as-is
- defer trailers
- accept runtime-slot occupancy for now because architecture clarity matters more than premature multiplexing tricks

## Exit criteria

This topic is done for the current experiment stage when:

- response streaming stays correct
- the Rust <-> V8 chunk bridge no longer goes through plain JS array normalization
- docs describe the ownership and failure model clearly

That bar is now met for the experiment's current scope.
