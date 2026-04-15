# External Client Contract Stability for the Pingora Experiment

Date: 2026-04-15

## Decision

During the `v1 -> v2` migration phase, `v1/v2` should be treated as an internal server-side distinction.

The client-facing requirement is:

- the existing external contract remains stable enough that client SDKs do not need to care whether the server implementation is `v1` or `v2-compat-v1`
- the compatibility burden should stay on the server side

Short version:

`Clients target one stable service contract. v1/v2 is an internal backend concern.`

## Why this matters

Server compatibility is only useful if the external service contract stays stable.

If `v2` is wire-compatible with `v1` but still requires:

- a new SDK
- new client error handling
- new reconnect logic
- new rollout code in applications

then the migration cost is still too high.

That creates avoidable client-side risk:

- parallel SDK adoption
- mixed semantics between client versions
- rollout sequencing complexity
- rollback complexity on both client and server sides

The cleaner path is:

- one primary external contract
- server versions evolve behind that contract

## Stability goal

The migration target should be:

- clients continue to use the existing service contract
- `v2-compat-v1` preserves that contract
- client SDKs remain unaffected by server generation

The key point is:

- applications and SDKs should not need to branch on backend generation

## Explicit rule

During migration:

- do not make client SDK rollout the main migration boundary
- make the server compatibility layer the main migration boundary

That means:

- upgrade the server first
- preserve the external contract for callers

## What external contract stability really means

Client stability is not only "the request succeeds".

It also means the following client-visible semantics remain stable enough:

- request and response shapes
- connection and handshake behavior
- retry expectations
- timeout classes
- public error codes/categories
- WebSocket reconnect behavior

If any of those change incompatibly, then the external contract is not really stable.

## Recommended client-facing strategy

### One logical client surface

The recommended approach is:

- keep one logical service contract for business callers

Possible implementation choices:

- keep the existing SDK unchanged
- or evolve it internally without changing its public contract

What should not happen during migration:

- "use one client contract for v1 and another for v2"

That splits the ecosystem too early.

### Capability model

The external contract can be divided conceptually into:

- stable compat capabilities
- optional future-native capabilities

#### Stable compat capabilities

These should work across:

- `v1`
- `v2-compat-v1`

Examples:

- standard request/response operations
- connection setup
- baseline auth/identity headers
- baseline error handling
- baseline WebSocket reconnect semantics

#### Optional future-native capabilities

These can be added later behind:

- feature flags
- version negotiation
- optional namespaces

But they must not break the shared compat path.

## Public error contract

The client-facing contract should not leak raw internal host/runtime errors.

It should rely on stable public categories and codes.

Recommended categories:

- `bad_request`
- `unauthorized`
- `forbidden`
- `not_found`
- `conflict`
- `rate_limited`
- `upstream_timeout`
- `execution_timeout`
- `temporarily_unavailable`
- `shutdown_draining`
- `internal_error`
- `network_lost`

These should map cleanly from the compat contract.

### Rule

If `v2` introduces richer internal failure detail:

- keep it internal by default
- only expose it to the SDK if it can be added without breaking the universal client surface

## Retry and reconnect semantics

The client-facing behavior should make stable decisions based on public categories, not backend generation.

Recommended default policy:

- `temporarily_unavailable` -> retryable
- `shutdown_draining` -> retryable
- `upstream_timeout` -> retryable depending on idempotency policy
- `execution_timeout` -> usually not blindly retryable unless operation semantics allow it
- `internal_error` -> cautious retry based on caller policy

For WebSocket-like or long-lived sessions:

- `1001 Going Away` -> reconnect with backoff
- drain/restart refusal -> reconnect with backoff
- normal application close -> no auto reconnect unless opted in

These rules should be stable across `v1` and `v2-compat-v1`.

## Protocol and handshake requirements

To keep the external contract stable, the compat server path should preserve:

- handshake expectations
- request framing where relevant
- version negotiation behavior
- auth/header requirements

If version negotiation is needed, it should be:

- backward-compatible
- server-tolerant
- optional for existing SDKs where possible

The server should carry more compatibility burden than the client.

## Observability and supportability

Clients should not need to know every internal server metric, but they should have stable support hooks.

Recommended stable client-visible diagnostics:

- request ID or trace ID propagation
- stable public error code/category
- server generation marker only when useful for debugging, not as a required business branch

Important:

- clients should not require applications to branch on `v1` vs `v2`

That is an implementation concern for operators, not business callers.

## Migration phases

### Phase 1

Keep current external behavior as the source of truth.

Server work required:

- `v2-compat-v1` must satisfy existing client assumptions

### Phase 2

Run mixed server rollout under the same client contract.

Validation required:

- request/response parity
- error parity
- reconnect parity

### Phase 3

Only after migration stability is proven, consider exposing:

- optional `v2-native` client features

Even then:

- do not break the shared compat path

## Red lines

The migration should be considered off track if it requires:

- separate mandatory client contracts for `v1` and `v2`
- application code branching on backend generation
- incompatible public error semantics for the same logical operation
- different default reconnect semantics for the same logical WebSocket/session behavior

Those are signs the SDK stopped being universal.

## Relationship to compat contract

This client-stability design depends on the compat contract preserving:

- normalized public errors
- normalized request/response semantics
- stable timeout/shutdown categories
- explainable shadow diffs

So the layering should be:

- compat contract defines stable external semantics
- client code continues consuming those semantics without server-generation awareness

## Final recommendation

Treat the external contract as the shared migration asset.

The server side should absorb most compatibility burden so that:

- existing client integrations can keep working
- rollout can happen server-first
- application teams do not need to coordinate a client rewrite with the backend migration

That is the lowest-risk path.
