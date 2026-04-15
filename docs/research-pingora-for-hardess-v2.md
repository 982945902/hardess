# Research: Can Pingora Be the Base of Hardess v2?

Date: 2026-04-14

## TL;DR

Short answer: `can, but not as a low-cost swap`.

`Pingora` is a strong candidate only if Hardess v2 is willing to become a `Rust-first network core` and accept a real server-side rewrite.

If the goal is:

- keep the current TypeScript-first programming model
- keep the current Workers-style `fetch(request, env, ctx)` extension feel
- keep iteration speed close to the current Bun version

then `Pingora` is not the natural next step.

In that case, the closer Cloudflare technology is `workerd`, not Pingora.

## The First Clarification: Pingora Is Not the Workers Runtime

Your intuition about "Cloudflare maybe built a TS interpreter on top of it for Workers" is not how their stack is split.

Based on Cloudflare's official materials:

- `Pingora` is a Rust framework for programmable network services and HTTP proxying.
- `workerd` is the JavaScript / Wasm runtime that powers Cloudflare Workers.

Official sources:

- Cloudflare says `workerd` is "the JavaScript / Wasm runtime based on the same code that powers Cloudflare Workers": [Introducing workerd](https://blog.cloudflare.com/workerd-open-source-workers-runtime/), [workerd GitHub README](https://github.com/cloudflare/workerd)
- Cloudflare says `Pingora` is a Rust framework / HTTP proxy used to build proxy services: [How we built Pingora](https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/), [Open sourcing Pingora](https://blog.cloudflare.com/pingora-open-source/), [Pingora GitHub README](https://github.com/cloudflare/pingora)

So the clean mental model is:

- `Pingora` = high-performance Rust network / proxy framework
- `workerd` = Workers runtime for JS/Wasm code
- `Workers` product = hosted platform built around `workerd`, with additional Cloudflare platform features and sandboxing layers

## What Pingora Actually Gives You

From Cloudflare's official Pingora materials, Pingora provides:

- HTTP/1 and HTTP/2 proxy building blocks
- gRPC and WebSocket proxying
- filters and callbacks for request/response processing
- load balancing and failover building blocks
- graceful restart / reload support
- observability integrations

Official references:

- [Pingora GitHub README](https://github.com/cloudflare/pingora)
- [Open sourcing Pingora](https://blog.cloudflare.com/pingora-open-source/)

Important nuance:

Cloudflare explicitly positions Pingora as a `library and toolset, not an executable binary`. Their own wording is that Pingora is the engine, not the whole car. That matters a lot for Hardess.

## What Hardess Actually Needs Today

Hardess today is not just an HTTP reverse proxy.

From the current Hardess architecture and implementation baseline, it is a combination of:

- HTTP gateway: `auth -> worker -> proxy`
- realtime WebSocket hub: `sys.auth`, routing, `recvAck`, `handleAck`, heartbeat
- unified SDK for connected peers
- business protocol registry
- runtime-side peer registry and fanout
- static multi-node routing baseline
- config reload / worker reload
- operator surfaces: readiness, metrics, graceful shutdown

Reference:

- [Hardess architecture](./hardess-architecture.md)

This means the v2 question is not "can Pingora proxy HTTP?".

The real question is:

`Can Pingora replace enough of Hardess's current runtime kernel without breaking the product model?`

## Capability Mapping: Pingora vs Hardess

### 1. HTTP gateway

Fit: `good`

Pingora is very well aligned with the HTTP ingress / proxy part of Hardess.

Why:

- Hardess already has a gateway-first shape
- Pingora is built exactly for high-performance programmable proxying
- Pingora's filters/callbacks map naturally to request mutation, routing, timeout policy, load balancing, and upstream selection

If Hardess v2 wants stronger HTTP proxy performance and more headroom, Pingora is a legitimate base for this part.

### 2. TypeScript worker stage

Fit: `poor` unless architecture changes

This is the biggest mismatch.

Hardess today intentionally uses a Workers-style worker contract:

- `fetch(request, env, ctx)`
- TypeScript
- same-process developer ergonomics

Pingora does not provide a JS/TS runtime.

So if Hardess v2 is built on Pingora, you must choose one of these:

1. Rewrite worker logic into Rust hooks
2. Embed or sidecar a JS runtime
3. Move policy execution out-of-process through RPC
4. Replace the current worker model entirely

That is not a small refactor. It is a product-level change.

If preserving the current TS worker ergonomics is important, `workerd` is much closer than Pingora.

## 3. WebSocket realtime hub

Fit: `partial`

Pingora supports `WebSocket proxying`, which is useful but not sufficient for Hardess's current WS model.

Hardess does not merely tunnel WS bytes. It owns application semantics:

- auth handshake
- local connection registry
- peerId to connection resolution
- sender-visible route / ack semantics
- partial delivery behavior
- cluster handleAck forwarding
- shutdown drain policy for existing connections

Pingora can help you with the transport layer, but it does not give you this application-level realtime hub.

So for WS, Pingora is at best:

- a transport/kernel helper

not:

- a ready-made Hardess hub runtime

## 4. Multi-node routing

Fit: `poor to partial`

Hardess today has a simple but clear multi-node baseline:

- static peer list
- remote locate
- internal cross-node delivery
- internal handleAck forwarding

Pingora gives you strong network primitives, but it does not directly solve:

- distributed peer registry
- recipient location cache
- sender/receiver correlation for ack flow
- business-aware fanout

Those would still be application code you build yourself.

## 5. SDK and protocol model

Fit: `contract reusable, implementation not reusable`

The good news:

- the SDK contract
- envelope model
- ack semantics
- business protocol registry idea

can mostly survive a server rewrite.

The bad news:

- the server implementation would not carry over cheaply

So Pingora does not invalidate Hardess's protocol design, but it does not preserve the current runtime implementation either.

## Where Pingora Is Actually Strong for Hardess v2

Pingora becomes attractive if Hardess v2 intentionally changes from:

- `TypeScript runtime with gateway + realtime capabilities`

to:

- `Rust network kernel with optional external scripting/policy plane`

That would be a different architecture, roughly:

1. Pingora owns:
   - HTTP ingress
   - upstream connection reuse / pooling
   - LB / failover
   - graceful process lifecycle
   - low-level observability hooks
2. Hardess-specific Rust services own:
   - WS session lifecycle
   - peer registry
   - routing / ack state
   - cluster relay
3. Optional JS policy layer owns:
   - request mutation / business worker logic
   - protocol customization

That is a valid v2 direction.

But it is a `new architecture`, not a framework swap.

## Where Pingora Is a Bad Fit

Pingora is a bad fit if your main v2 goal is any of the following:

- keep server-side extensions in TypeScript with roughly current ergonomics
- keep same-process TS workers as a first-class platform feature
- iterate quickly with small-team Bun-style productivity
- preserve the current runtime shape while only improving performance

In these cases, Pingora will probably make Hardess heavier before it makes it better.

## If You Want "Cloudflare + TS", The Closer Thing Is workerd

If what you really want is:

- Cloudflare's JS runtime model
- web-standard `fetch`
- self-hostable Workers-compatible code
- programmable HTTP interception in JS

then the better research target is `workerd`.

Why:

- Cloudflare explicitly describes `workerd` as the runtime that powers Workers
- it supports self-hosting Workers-style apps
- it can also act as a programmable forward/reverse proxy

Official references:

- [workerd GitHub README](https://github.com/cloudflare/workerd)
- [Introducing workerd](https://blog.cloudflare.com/workerd-open-source-workers-runtime/)

But even there, two cautions matter:

1. `workerd` is not the full Workers platform
2. Cloudflare explicitly warns that `workerd` by itself is not a hardened sandbox

So `workerd` is closer to Hardess's current extension model, but it still does not give you Hardess's WS hub semantics for free.

## Recommended Evaluation Conclusion

### Conclusion for Pingora

My recommendation is:

- `Do not treat Pingora as the default Hardess v2 path`
- `Treat Pingora as a deliberate Rust-core rewrite option`

More concretely:

- `Yes` for v2 if the plan is to rebuild Hardess around a Rust network core
- `No` if the plan is to keep the current TypeScript-first product model and just upgrade the transport framework

### Conclusion for the current stage of Hardess

Given Hardess's current size and goals:

- small scenario
- moderate QPS
- current architecture already "small and beautiful"
- upstream auth/control-plane dependencies are not complete yet

it is hard to justify a Pingora rewrite right now.

The architectural delta is too large relative to the current business need.

## Suggested Next Step

If you want to continue this research seriously, the right order is:

1. Decide what v2 is optimizing for:
   - `performance / network kernel`
   - or `TypeScript programmability / developer experience`
2. If the answer is `performance / Rust core`, continue with a Pingora feasibility design
3. If the answer is `TS programmability`, research `workerd` instead
4. Only after that decide whether Hardess v2 is:
   - `Pingora-first`
   - `workerd-first`
   - or `stay on current Bun architecture and evolve incrementally`

## My Current Recommendation

For Hardess specifically, my current recommendation is:

- `near term`: stay on the current architecture
- `v2 candidate A`: research `workerd` if you want to preserve Workers-style extension semantics
- `v2 candidate B`: research `Pingora` only if you are willing to make Hardess a Rust-first product

So the practical answer is:

`Pingora can be adapted into Hardess v2, but only by changing the character of Hardess itself.`

That is why I would not call it the natural next version. I would call it an `alternative product direction`.

## Sources

- Cloudflare Pingora GitHub README: https://github.com/cloudflare/pingora
- Cloudflare blog, Open sourcing Pingora: https://blog.cloudflare.com/pingora-open-source/
- Cloudflare blog, How we built Pingora: https://blog.cloudflare.com/how-we-built-pingora-the-proxy-that-connects-cloudflare-to-the-internet/
- Cloudflare Pingora security advisory GHSA-93c7-7xqw-w357: https://github.com/cloudflare/pingora/security/advisories/GHSA-93c7-7xqw-w357
- Cloudflare blog, Resolving a request smuggling vulnerability in Pingora: https://blog.cloudflare.com/resolving-a-request-smuggling-vulnerability-in-pingora/
- Cloudflare workerd GitHub README: https://github.com/cloudflare/workerd
- Cloudflare blog, Introducing workerd: https://blog.cloudflare.com/workerd-open-source-workers-runtime/
- Cloudflare Workers runtime APIs docs: https://developers.cloudflare.com/workers/runtime-apis/
