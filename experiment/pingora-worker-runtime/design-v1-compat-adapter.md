# V1 Compatibility Adapter Design for the Pingora Experiment

Date: 2026-04-15

## Decision

The `v1 compatibility adapter` should translate `v1` protocol and module semantics into the `v2` host, while preserving:

- TypeScript as the business execution layer
- Rust as the host/kernel layer

Short version:

`Adapt at the boundary. Do not re-author business behavior in Rust.`

## Purpose

This document is narrower than the broader `v1 -> v2` compatibility note.

Its purpose is to define:

- what the adapter owns
- what the adapter must not own
- how `v1` workers and `serviceModule`s continue to execute in TS on top of the `v2` host

## Core rule

The adapter is a compatibility translator.

It is not:

- a business rewrite layer
- a Rust business framework
- a justification for moving application logic out of TS

The adapter should make this possible:

- `v1 input`
- `compat translation`
- `v2 host/runtime execution`
- `TS business logic still runs`

## Ownership split

### Rust host owns

- ingress and protocol framing
- connection and request lifecycle
- timeout enforcement
- shutdown/draining
- runtime pool management
- metrics/tracing collection
- capability exposure into TS
- compatibility translation of protocol/config/error surfaces

### TS runtime owns

- worker business logic
- serviceModule business logic
- request handling semantics at the module layer
- business routing and dispatch rules
- app-visible lifecycle hooks

That ownership split should remain true in both:

- `v2-compat-v1`
- `v2-native`

## Adapter responsibilities

The compatibility adapter should provide the following translations.

### 1. Protocol adapter

Translate:

- `v1` wire messages
- `v1` request envelopes
- `v1` response envelopes

Into:

- the normalized `v2` internal request model

And translate results back into:

- `v1`-compatible outputs when needed

### 2. Module adapter

Translate:

- `v1 worker` loading conventions
- `v1 serviceModule` loading conventions
- `v1` invocation shape

Into:

- a normalized `v2` runtime invocation

Important:

- this adapter must still invoke TS modules in the TS runtime
- it must not replace them with Rust implementations of their business behavior

### 3. Environment adapter

Translate:

- `v1 env`
- `v1 ctx`
- `v1 capability expectations`

Into:

- `v2` host services and runtime capabilities

This is where things like:

- IDs
- metadata
- send helpers
- close helpers
- timing/shutdown hints

should be mapped.

### 4. Error adapter

Translate:

- internal `v2` errors

Into:

- stable public categories
- `v1`-compatible externally visible errors when in compat mode

The adapter should hide internal host differences wherever possible.

## Worker path

For `worker`, the target shape is:

1. accept `v1`-style invocation
2. normalize into `v2` internal request/context
3. invoke TS worker runtime
4. collect result
5. map result back into `v1`-compatible external semantics if compat mode requires it

The key constraint is step 3:

- the worker logic still runs inside TS

## ServiceModule path

For `serviceModule`, the target shape is similar:

1. load `v1` serviceModule definition
2. normalize config and lifecycle expectations
3. expose the expected host capabilities
4. execute the serviceModule logic in TS
5. map outputs and errors back through compat surfaces

This means `serviceModule` should still be treated as a TS module with business meaning.

It must not become:

- Rust-implemented business middleware
- hand-rewritten Rust route logic
- a config-only declaration whose behavior moved into host code

## Boundary rules

These rules should be treated as strict.

### Allowed in Rust

- parsing
- validation
- normalization
- scheduling
- retries
- queue management
- connection management
- timeout handling
- shutdown behavior
- capability plumbing

### Not allowed in Rust

- rewriting module business logic
- hardcoding product rules that belong to workers
- implementing service business behavior that existing TS modules already express
- requiring product engineers to migrate module logic into Rust

## Adapter API shape

The exact API can evolve, but the conceptual interface should look like this:

- `parse_v1_input(...)`
- `normalize_to_v2_request(...)`
- `build_v1_compat_env(...)`
- `invoke_ts_worker(...)`
- `invoke_ts_service_module(...)`
- `map_result_to_v1_output(...)`
- `map_internal_error_to_v1_public_error(...)`

The important thing is not the function names.

The important thing is the flow:

- all roads still pass through TS for business execution

## Why this matters operationally

If the adapter drifts into Rust-side business rewrites:

- shadow comparisons become meaningless
- rollback becomes harder
- parity debugging becomes much harder
- migration becomes a hidden rewrite project

That is exactly what this compatibility strategy is trying to avoid.

## Recommended implementation order

### Stage 1

Define normalized internal shapes:

- request
- response
- env
- context
- error category

### Stage 2

Implement `v1` parsing and mapping into those shapes.

### Stage 3

Invoke the existing TS runtime with compat-facing env/context.

### Stage 4

Add result and error mapping back to `v1` externally visible forms.

### Stage 5

Add shadow diff tooling around this path.

## Success criteria

The adapter is successful when:

- existing `v1` workers can run on `v2` without Rust rewrites
- existing `v1 serviceModule`s can run on `v2` without Rust rewrites
- protocol interop works in mixed rollout
- product engineers still think in TS module terms
- Rust remains the infrastructure layer, not the business rewrite target

## Failure criteria

The adapter design should be considered failed if rollout depends on:

- rewriting business handlers into Rust
- translating each `serviceModule` manually into Rust
- keeping TS modules only as compatibility wrappers around real Rust behavior

Those are signs that the boundary has collapsed.

## Final recommendation

The `v1 compat adapter` should be strict about one thing:

- preserve TS as the business language

Everything else:

- protocol mapping
- env translation
- error mapping
- lifecycle adaptation

can and should be handled by Rust at the boundary.
