# Pingora / Runtime Event Alignment Design

Date: 2026-04-16

## Goal

Define the execution model more explicitly than the current
`request -> runtime pool -> response` shorthand.

The important problem is not just "how to invoke TS".

It is:

- how Pingora's network/session lifecycle aligns with
- request-level worker execution and
- the embedded runtime's async event loop.

If this model stays blurry, performance and correctness work will keep showing
up as isolated fixes:

- completion-mode rewrites
- drain logic
- body ownership questions
- shutdown edge cases
- future WebSocket upgrade handling

This note makes the ownership and scheduling model explicit.

## Decision

Model the host in four layers:

1. `Host`
2. `Session`
3. `RequestTask`
4. `RuntimeShard`

Relationship:

- `Host 1 -> N Session`
- `Session 1 -> N RequestTask`
- `Host 1 -> N RuntimeShard`
- `RequestTask N -> 1 RuntimeShard`

This is the mental model the implementation should converge toward.

## Why

The current experiment already has the right ingredients:

- Pingora owns HTTP ingress and request/response IO
- runtime generations own prepare/load/reload lifecycle
- worker runtimes already execute multiple requests over time
- body reads and response streaming are already bridge-mediated

What was still too implicit is the execution unit.

The execution unit is **not**:

- the whole host
- the whole session
- a generic remote-function call

It is:

- one `RequestTask` bound to one `RuntimeShard`
- while the surrounding connection/session lifecycle stays host-owned

This is important because worker workloads are usually not heavy compute jobs.

They are request-scoped async control logic.

That means:

- fixed cross-thread or cross-runtime overhead matters a lot
- ownership of cancellation and body streaming matters a lot
- "just hand the request to another sidecar" is often the wrong mental model

## Layer definitions

## Host

The `Host` is the process-level owner.

It owns:

- runtime generations
- runtime pools / shards
- worker prepare cache
- global config
- global shutdown state
- observability

The host serves many downstream sessions.

The host is also the final policy owner for:

- timeout
- shutdown
- drain
- connection reuse policy

## Session

The `Session` is the Pingora-side network lifecycle object.

For HTTP ingress today this is `ServerSession`.

It owns:

- request read lifecycle
- body read lifecycle
- response write lifecycle
- keep-alive / connection reuse
- downstream disconnect visibility

Important rule:

- session state remains host-owned
- TS worker code should not own or directly manipulate Pingora session objects

This keeps the transport boundary clean.

## RequestTask

`RequestTask` is the real execution unit.

A request task begins when:

- a parsed downstream request is accepted for execution

It ends when:

- the worker result is fully resolved for buffered responses
- or the streaming response bridge is fully drained / aborted

It owns request-scoped state such as:

- request identity
- request metadata exposed to worker code
- body bridge state
- response bridge state
- timeout / abort linkage

One session may create multiple request tasks over time.

## RuntimeShard

`RuntimeShard` is one embedded runtime execution container.

Today this corresponds to one runtime slot / dedicated runtime thread.

It owns:

- one `JsRuntime`
- one imported worker module graph
- one cached invocation trampoline
- multiple request tasks over time

Important rule:

- once a request task is bound to a runtime shard, it should not migrate

This keeps execution semantics simpler for:

- cancellation
- streaming
- long-lived async work
- future WebSocket upgrade handling

## Ownership rules

The key ownership rules are:

1. transport lifecycle is host-owned
2. session lifecycle is Pingora-owned
3. request execution is request-task-scoped
4. runtime async is shard-owned

More concretely:

- host owns final timeout and shutdown decisions
- runtime observes timeout/abort through explicit bridge signals
- request bodies are host-backed and lazily read
- response bodies are runtime-backed and lazily pulled by ingress

This means the bridge should mostly transfer:

- references
- capabilities
- state transitions

not:

- reconstructed full objects
- eager body materialization
- synthetic sidecar-style task payloads

## Current implementation mapping

Current code already roughly maps to this model:

- `Host`
  - `RuntimeGenerationManager`
  - `WorkerHttpApp`
- `Session`
  - Pingora `ServerSession`
- `RequestTask`
  - one `handle_request(...)` execution plus request/response body bridges
- `RuntimeShard`
  - one `WorkerRuntimeSlot`

What was still missing before this note:

- explicit request-task identity
- explicit runtime-shard identity in worker-facing metadata
- a single document that explains why these are the important boundaries

## Worker-facing metadata

The worker-facing `ctx.metadata` should expose request-task-level facts,
not hidden transport internals.

Current reserved keys:

- `hardess_request_task_id`
- `hardess_client_addr`
- `hardess_http_version`
- `hardess_request_body_mode`
- `hardess_request_completion_policy`
- `hardess_runtime_shard`

These keys make the execution model more explicit without exposing Pingora
internals directly into the TS contract.

This is intentionally a low-risk first step:

- it improves observability immediately
- it gives later scheduling work a stable vocabulary
- it does not lock the public worker API to Pingora types

## Scheduling implications

This note does **not** require immediate session affinity.

Current practical guidance:

- request is the scheduling unit
- runtime shard is the execution unit
- session remains a transport lifecycle unit

So the short-term scheduler can stay simple.

What matters first is:

- make request-task identity explicit
- make runtime-shard binding explicit
- avoid hiding cross-shard execution behind vague pool semantics

Later, if evidence supports it, the next scheduling questions are:

- should requests from the same session prefer the same shard?
- should HTTP/2 streams prefer shard stickiness?
- should upgraded WebSocket sessions become shard-pinned?

Those questions should be answered after the current request-task model is
measurable, not before.

## Body and response flow

The intended direction is:

- request head:
  - host parses once
  - runtime sees a host-backed request object
- request body:
  - host-owned
  - lazily read on worker demand
- response head:
  - runtime resolves head first
  - host writes it
- response body:
  - runtime-owned reader
  - host pulls and writes it

This keeps ownership asymmetric in the correct direction:

- network ingress stays host-driven
- user async stays runtime-driven

## Shutdown and cancellation

Shutdown and downstream disconnect are still host-owned events.

The runtime should cooperate, not own the final decision.

Practical rule:

- host may stop accepting new request tasks
- host may abort or drain existing request tasks
- runtime should observe those transitions through explicit bridge state

This becomes especially important for:

- unread request bodies
- streaming responses
- future WebSocket upgrade support

## What this means for performance work

This model explains why pure TCP/listener tuning is unlikely to be decisive on
its own.

The more important path is usually:

- request-task creation cost
- runtime-shard handoff cost
- completion handoff cost
- request/response bridge shape

That is also what the current benchmark data already suggests.

## Next implementation moves

1. keep request-task identity explicit in ingress and worker metadata
2. keep runtime-shard identity explicit in worker metadata
3. continue reducing fixed host/runtime handoff cost
4. only evaluate session affinity once the current request-task model is well
   measured
5. carry this same model into future WebSocket runtime design
