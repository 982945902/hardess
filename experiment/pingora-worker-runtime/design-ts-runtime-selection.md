# TS Runtime Selection for the Pingora Experiment

Date: 2026-04-14

## Decision

For the `Pingora + Rust + Workers-style fetch(request, env, ctx)` experiment, the recommended first-choice TS runtime is:

- `deno_core`

Not the first choice:

- `workerd`
- `QuickJS` / `rquickjs`

## Why this is the recommendation

This experiment is not trying to answer:

- "what is the most compatible Cloudflare runtime in the world?"

It is trying to answer:

- "can a Rust-hosted Hardess kernel preserve a Workers-style programming model?"

That means the first runtime choice should optimize for:

1. embeddability inside a Rust host
2. control over host bindings
3. ability to model `fetch(request, env, ctx)` cleanly
4. incremental experimentation without taking on an entire foreign server stack

On those criteria, `deno_core` is the best starting point.

## Candidate Comparison

### Option A: `deno_core`

What it is:

- Deno's core engine
- Rust + V8
- exposed as an embeddable Rust runtime

Official sources:

- `deno_core` repo: https://github.com/denoland/deno_core
- `JsRuntime` docs: https://docs.rs/deno_core/latest/deno_core/struct.JsRuntime.html
- Deno repo: https://github.com/denoland/deno

Why it fits this experiment:

- it is already Rust-native and embeddable
- it gives direct control over runtime construction
- it is close to the "host-defined runtime" model we want
- it can expose Rust ops into JS cleanly
- it keeps the Pingora host as the outermost owner of process, sockets, and request lifecycle

What you pay for:

- it is not Cloudflare Workers compatibility out of the box
- TypeScript support needs an explicit story
- web APIs must be deliberately exposed rather than assumed
- isolation/sandboxing is your responsibility

Practical implication:

`deno_core` is the best tool if the question is "can Rust host a Workers-like API for Hardess?".

### Option B: `workerd`

What it is:

- the JavaScript / Wasm runtime that powers Cloudflare Workers
- also usable as an application server and programmable HTTP proxy

Official sources:

- `workerd` repo: https://github.com/cloudflare/workerd
- Cloudflare blog: https://blog.cloudflare.com/workerd-open-source-workers-runtime/

Why it is attractive:

- conceptually closest to real Cloudflare Workers
- built around web-standard `fetch()`
- strongest story if exact Workers semantics are the main goal

Why it is not the first choice here:

- it is not a small embeddable Rust crate
- operationally it is its own runtime/server world
- integrating it *inside* a Pingora-hosted Rust experiment is much heavier
- build/runtime complexity is much higher than a Rust-native embed route
- Cloudflare explicitly warns that `workerd` by itself is not a hardened sandbox

Practical implication:

`workerd` is better as:

- a comparison target
- a compatibility reference
- or a separate product direction

It is not the fastest path to proving the current experiment.

### Option C: `QuickJS` / `rquickjs`

What it is:

- a small embeddable JS engine
- Rust bindings exist through crates like `rquickjs`

Official sources:

- `rquickjs` repo: https://github.com/DelSkayn/rquickjs
- QuickJS documentation: https://docs.rs/crate/quickjs-wasm-sys/1.1.0/source/quickjs/doc/quickjs.pdf

Why it is tempting:

- lightweight
- easy to embed
- lower startup and conceptual overhead

Why it is not the right first target:

- much larger semantic distance from the Cloudflare/Deno/Workers model
- weaker compatibility story for web-standard runtime APIs
- likely more custom glue for async/fetch/module behavior
- a good spike tool, but a weak strategic choice for a Workers-like runtime

Practical implication:

`QuickJS` is acceptable for tiny host-concept spikes, but not for the main line of this experiment.

## The real tradeoff

There are actually two different goals hiding inside this project:

### Goal 1: preserve Cloudflare-Workers feel

If this is the top priority, `workerd` is the closest thing.

### Goal 2: build a Rust-hosted Hardess kernel with programmable TS policy

If this is the top priority, `deno_core` is the better starting point.

For this experiment, Goal 2 is the more useful first milestone.

Why:

- we are exploring `Pingora + Rust` as the core
- that means the host should stay in Rust
- the TS runtime should plug into Rust, not replace the outer host

That is why the selection is:

- `first`: `deno_core`
- `second track / comparison`: `workerd`
- `not recommended as main track`: `QuickJS`

## Recommended staged plan

### Stage 1

Use `deno_core` to prove a minimal hosted worker contract:

- load a module
- run a Workers-like `fetch(request, env, ctx)`
- map Rust request/response structs to JS `Request` / `Response`-like values

Success condition:

- the Rust host boundary feels clean

### Stage 2

Add the minimum TypeScript story:

- either pre-transpile TS before execution
- or integrate a Deno-side transpile path explicitly

Success condition:

- worker authoring still feels like TypeScript, not "JS with manual build pain"

### Stage 3

Only after the host contract feels good, do a comparison spike against `workerd`.

Question for that stage:

- is `workerd` materially better enough in compatibility to justify much higher integration complexity?

## What I would do next

Concrete next move:

1. keep the current Rust workspace
2. add `deno_core` to a dedicated experimental crate
3. prove one tiny `fetch(request, env, ctx)` execution path
4. keep `workerd` as a parallel research note, not the first implementation track

## Final Recommendation

My recommendation is:

- `Use deno_core first`

Reason:

- best fit for a Rust-hosted experiment
- lowest architecture friction with Pingora
- enough control to model a Workers-style host contract
- avoids prematurely committing the experiment to Cloudflare's full runtime stack

Short version:

`If the host is Rust, the first runtime should also think like Rust. That is deno_core, not workerd.`

## Sources

- `deno_core` GitHub README: https://github.com/denoland/deno_core
- `deno_core::JsRuntime` docs: https://docs.rs/deno_core/latest/deno_core/struct.JsRuntime.html
- Deno GitHub README: https://github.com/denoland/deno
- `workerd` GitHub README: https://github.com/cloudflare/workerd
- Cloudflare blog, Introducing workerd: https://blog.cloudflare.com/workerd-open-source-workers-runtime/
- `rquickjs` GitHub README: https://github.com/DelSkayn/rquickjs
- QuickJS documentation: https://docs.rs/crate/quickjs-wasm-sys/1.1.0/source/quickjs/doc/quickjs.pdf
