# WebSocket Runtime Design for the Pingora Experiment

Date: 2026-04-15

Update: 2026-04-16

- `gateway-host` now has a runtime-side WebSocket event bridge
- worker modules can optionally export:
  - `websocket.onOpen(ctx)`
  - `websocket.onMessage(message, ctx)`
  - `websocket.onClose(event, ctx)`
- `ctx.send(string)` and `ctx.close(code?, reason?)` now map to Rust-captured commands
- Pingora ingress now has a first H1 websocket session path wired to that bridge
- `/_hardess/ingress-state` now exposes first websocket timing breakdowns:
  - average open callback runtime / open command write cost
  - average per-message runtime / command write / total handling cost
- current transport scope is intentionally narrow:
  - text messages only
  - ping/pong supported
  - close supported
  - binary frames rejected
  - fragmented frames rejected
  - connection stays Rust-owned for its entire lifetime

## Decision

For the next WebSocket-capable version of this experiment, the recommended model is:

- Pingora and Rust own the WebSocket connection lifecycle
- TypeScript owns WebSocket event handling logic
- the first design target is not "full socket ownership inside TS"

Short version:

`Rust owns connections. TS owns behavior.`

## Current assessment

The current experiment is request/response oriented:

- Pingora ingress currently uses `ServeHttp`
- worker execution is modeled as `fetch(request, env, ctx) -> response`
- the response must be fully materialized before the call returns

That means the current implementation is not a real full-duplex WebSocket runtime.

At most, it is a good base for:

- HTTP ingress
- worker invocation
- runtime lifecycle
- backpressure on request execution

It is not yet the right host shape for:

- bidirectional long-lived socket sessions
- streaming message flow
- runtime-held connection objects

## Why not put socket ownership in TS first

The most tempting design is:

- upgrade to WebSocket
- create a JS `WebSocket` object
- let the worker keep that object alive
- run everything through the embedded TS runtime

This is not the recommended first step.

Why:

- long-lived connections are operational state, not just business logic
- backpressure needs to be enforced outside the worker
- shutdown behavior must remain predictable
- a wedged runtime should not directly own network sockets
- runtime rebuilds become much more dangerous if a worker directly owns connection state

For this experiment, correctness of lifecycle is more important than API purity in v1.

## Recommended ownership model

### Rust owns

- WebSocket upgrade acceptance
- connection IDs
- socket read/write loops
- outbound send queues
- connection registry
- per-connection limits
- global connection limits
- draining and shutdown behavior
- connection metrics

### TypeScript owns

- `onOpen`
- `onMessage`
- `onClose`
- routing/business logic
- deciding whether to send/close
- optional application-level room/broadcast logic

This preserves a clean host boundary:

- transport and lifecycle remain in Rust
- programmable logic remains in TS

## Recommended event model

The first TS-facing API should stay small:

- `onOpen(ctx)`
- `onMessage(message, ctx)`
- `onClose(event, ctx)`

Where:

- `message` is text or bytes
- `event` contains close code / reason / whether closure was remote
- `ctx` is a host-provided capability object

Recommended `ctx` surface:

- `ctx.connectionId`
- `ctx.workerId`
- `ctx.send(data)`
- `ctx.close(code?, reason?)`
- `ctx.tags` or metadata if needed later

Important constraint:

- `ctx.send()` should enqueue into a Rust-managed outbound queue
- it should not synchronously write to the socket from inside JS

That makes backpressure enforceable.

## Recommended host architecture

### Ingress layer

Pingora should detect:

- `Connection: Upgrade`
- `Upgrade: websocket`

Then switch from the simple `ServeHttp` path to a lower-level HTTP application path that supports:

- upgrade
- connection task ownership
- long-lived session handling

This means the WebSocket path should not be built on the current "one request, one buffered response" API.

### Connection task model

For each accepted WebSocket connection:

1. Rust allocates a `connection_id`
2. Rust registers per-connection state
3. Rust spawns read/write tasks or an equivalent session loop
4. TS receives lifecycle events through bounded execution calls
5. TS replies by enqueuing commands such as `send` or `close`

The connection remains Rust-owned for its entire lifetime.

## Backpressure and limits

This is the main reason to keep ownership in Rust.

The first version should explicitly enforce:

- max active WebSocket connections
- max outbound queue length per connection
- max outbound buffered bytes per connection
- max inbound message size
- max message rate per connection if needed
- max global buffered outbound bytes

Recommended default policy:

- if a single connection becomes a slow consumer: close that connection
- if global connection capacity is exhausted: reject new upgrades
- if a message is too large: close with a policy/error close code

This is much safer than allowing a worker to buffer arbitrarily in JS.

## Shutdown and draining

The recommended shutdown policy is:

1. receive `SIGTERM` / `SIGQUIT`
2. stop accepting new WebSocket upgrades
3. reject new upgrades immediately
4. mark existing connections as draining
5. send close frames to existing connections with `1001 Going Away`
6. allow a short drain period for clean close
7. force-close anything still open after the drain timeout

Why this policy:

- it is operationally simple
- it is widely understandable by clients and SDKs
- it aligns with rolling restart behavior
- it does not pretend WebSocket sessions are durable across process death

For this experiment, that is the right compromise.

## SDK behavior recommendation

The SDK should treat certain close reasons as reconnectable by default.

Recommended behavior:

- `1001 Going Away`: reconnect with backoff
- connection refused during draining/overload: reconnect with backoff
- normal application close: do not reconnect unless caller opts in

The SDK should not expose low-level server internals directly.

It should expose stable categories such as:

- `closing_for_restart`
- `temporarily_unavailable`
- `application_closed`
- `network_lost`

That keeps product semantics cleaner than leaking internal runtime errors.

## What "full duplex" should mean here

There are two different meanings people often mix together:

### Transport full duplex

The socket can send and receive independently.

This should absolutely be supported by the Rust transport layer.

### Runtime full duplex

TS code directly owns a long-lived socket object and can read/write it continuously.

This is not the recommended first milestone.

So the answer is:

- the future WebSocket transport should be real full duplex
- the TS runtime should not initially be given raw full-duplex socket ownership

That distinction matters.

## Recommended staged plan

### Stage 1

Seal the TS runtime event contract first.

Success condition:

- worker modules can export `websocket`
- Rust can invoke `onOpen` / `onMessage` / `onClose`
- TS-issued `ctx.send` / `ctx.close` become Rust-managed commands without giving TS socket ownership

### Stage 2

Build Rust-native WebSocket ingress and connection registry.

Current status:

- H1 upgrade is now wired through Pingora
- the connection is pinned to one runtime shard for its lifetime
- app-level drain and generation-level drain now both hold the websocket session open until it exits

Remaining gap inside this stage:

- broaden frame support beyond text-only / non-fragmented
- add more explicit websocket connection metrics

### Stage 3

Wire Stage 1 and Stage 2 together behind a minimal product-facing API:

- `onOpen`
- `onMessage`
- `onClose`
- `ctx.send`
- `ctx.close`

Success condition:

- TS can express the product logic without owning the transport

### Stage 4

Add targeted higher-level features only if needed:

- rooms/channels
- server push helpers
- subscription helpers
- broadcast primitives

Success condition:

- product needs are met without making the runtime boundary too magical

### Stage 5

Only then evaluate whether a more worker-native long-lived object model is worth the complexity.

For now, the answer is:

- probably not

## Explicit non-goals for v1

- no direct JS ownership of raw socket handles
- no attempt to clone Cloudflare Durable Objects semantics
- no attempt to make WebSocket sessions survive process restart
- no attempt to turn the runtime into a general actor system

## Final recommendation

For Hardess-style traffic, the right first WebSocket design is:

- `real WebSocket transport in Rust`
- `event-driven business logic in TS`
- `bounded queues and explicit shutdown in Rust`

Not:

- `let the embedded TS runtime directly own long-lived sockets from day one`

That second path is more impressive on paper, but much worse for lifecycle control.
