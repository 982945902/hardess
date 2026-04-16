# Pingora Runtime Experiment Next-phase Plan

Date: 2026-04-15

Update: 2026-04-16

- `release` is now mandatory for `v2` benchmark conclusions
- HTTP completion has been collapsed to one mode: `async`
- the `blocking` branch is no longer the HTTP optimization target
- websocket runtime bridge is now in place inside `gateway-host`
- Pingora websocket upgrade/session handling is now in place for the first H1 text-only slice
- the next websocket items are breadth-first hardening, not basic bring-up
- ingress-state now exposes first websocket counters, so the next gap is
  end-to-end websocket smoke coverage rather than basic visibility

## Goal

Turn the current ad-hoc optimization work into a tighter execution plan.

This plan assumes the current facts are already known:

- the direction is still valid
- the current request path is still slower than the `v1` short-circuit path
- some request-path optimizations already helped
- further progress should be guided by the `Deno`/`Bun` study instead of local
  intuition alone

## Current state

From the benchmark log:

- baseline `v2-short`
  - RPS: `13,956`
  - p50: `3.56 ms`
  - p99: `6.60 ms`
- current best stable direction so far:
  - request head bridge reduction
  - gateway request normalization reduction

The best signal so far is:

- request-path bridge shape matters
- gateway-side normalization matters
- tiny metadata-object micro-optimizations do not matter much
- watchdog synchronization rewrites can easily make the system worse
- dispatch-level fast paths inside `execute_gateway(...)` did not show a stable
  win under same-machine reruns
- the later release-mode rerun showed the old `blocking` win was not a stable
  product direction

Concrete same-day sample after adding the extra metric:

- `average_queue_wait_ms`: `0.049`
- `average_invoke_ms`: `0.027`
- `average_roundtrip_ms`: `0.960`
- `average_response_handoff_ms`: `0.884`

Interpretation:

- runtime queue wait exists, but it is not the main cost anymore
- worker invoke itself is tiny
- most of the remaining fixed overhead appears after the runtime thread sends
  the response and before the caller task resumes
- that makes the current `oneshot` wakeup / cross-thread handoff path the first
  place to attack, ahead of more request-shape tweaks

Current HTTP mainline state:

- only the async completion path remains
- request-path tuning should now be evaluated only on the async mainline
- future work should not spend more time on `block_in_place` tradeoffs

The invocation envelope has now also been split more finely.

Current same-day sample on `v2-blocking`:

- `average_arg_serialize_ms`: `0.0055`
- `average_js_call_ms`: `0.0167`
- `average_response_decode_ms`: `0.0051`
- `average_invoke_ms`: `0.0297`

Interpretation:

- inside the remaining invoke envelope, the JS call itself is the largest piece
- but the full envelope is still tiny in absolute terms
- this means invocation-bridge micro-optimization is unlikely to produce the
  next big win by itself
- the remaining gap versus `v1-short` is now more likely to sit in the broader
  host/request path than in argument serialization or response decoding alone

The ingress path has now also been split at the app boundary.

Current same-day sample on `v2-blocking`:

- `average_request_read_ms`: `2.367`
- `average_request_build_ms`: `0.004`
- `average_runtime_execute_ms`: `0.110`
- `average_response_write_ms`: `0.027`
- `average_finish_ms`: `0.004`
- `average_request_total_ms`: `2.509`

Interpretation:

- the app-visible request build / runtime execute / response write path is
  already very small
- the dominant remaining portion at this boundary is `read_request`
- but that number should be treated carefully:
  - it includes the time until the app receives a parsed request
  - on localhost closed-loop benchmarking, that can include socket readiness
    and client pacing effects, not just server CPU work
- so the current evidence does **not** support more micro-optimization inside:
  - request construction
  - response writing
  - invocation envelope

Practical implication:

- the next meaningful question is less "what tiny object allocation is left?"
- and more:
  - how much of the remaining end-to-end gap is outside the worker host hot
    path entirely?
  - and what benchmark shape can separate socket/read-side pacing from actual
    server compute more cleanly?

One more same-day check is now done:

- Pingora listener/socket flag A/B
  - `tcp_fastopen` did not show a stable win
  - `tcp_keepalive` looked slightly better in one localhost run set, but the
    causal story is weak because the current load client mostly exercises
    steady-state keep-alive request reuse
  - conclusion:
    - keep these flags as operational controls
    - do not treat socket tuning as the next main optimization track on the
      current benchmark shape

Benchmarking support is also now slightly better:

- the repo HTTP load client can now switch between:
  - steady-state keep-alive reuse
  - one-request-per-connection mode
- entrypoint:
  - `HTTP_LOAD_CONNECTION_MODE=close bun run load:http`
- practical use:
  - this makes it possible to measure connection-establishment-sensitive tuning
    separately from steady-state request handling
  - so future Pingora listener tuning should be re-evaluated with this mode
    before drawing stronger conclusions

The execution model is also now more explicit:

- see:
  - [design-pingora-runtime-event-alignment.md](/Users/lishuo121/hardess/experiment/pingora-worker-runtime/design-pingora-runtime-event-alignment.md)
- practical implication:
  - think in `Host -> Session -> RequestTask -> RuntimeShard`
  - treat request task, not session or host, as the main execution unit
  - keep runtime-shard binding explicit before attempting session-affinity
    optimizations
  - host-side `active_request_tasks` tracking now exists in ingress-state, so
    later cancellation/drain work has a concrete request-task registry to build
    on
  - request tasks now also carry host-side phase/outcome history through
    `recent_request_tasks`, so shutdown/timeout/cancel work can attach to an
    explicit lifecycle model instead of ad hoc logs

## Phase goal

The next phase should not be:

- random micro-optimization rounds

It should be:

- make the request/runtime boundary look more like a real Rust-backed runtime
- measure and shrink the real fixed costs
- expose one cleaner runtime control surface

## Phase 1

## Request object deepening

Goal:

- move from `JS facade over multiple bridge helpers` toward `real Rust-backed
  request object`

Scope:

- keep external TS contract unchanged:
  - `fetch(request, env, ctx)`
- deepen the internal request representation
- keep body lazy

What to do:

1. define the target shape of the next `Request` backing object
2. identify which fields/methods should be native-backed first:
   - `method`
   - `url`
   - `headers`
   - `body`
3. reduce JS-side branching in request construction even further

Expected outcome:

- fewer request-path bridge hops
- less JS-side wrapper work
- clearer long-term shape for a host-backed Web request

## Phase 2

## Measure queue and invocation costs

Goal:

- stop inferring queue/runtime overhead indirectly

Scope:

- add measurement, not broad refactor first

What to do:

1. add focused timing around:
   - enqueue/send
   - worker invoke start
   - worker invoke finish
   - response handoff
   - runtime thread wakeup
   - `oneshot` completion
2. measure:
   - queue wait time
   - actual worker execution time
   - bridge/invocation overhead
   - request submission to runtime-thread pickup
   - runtime completion to caller wakeup
3. compare:
   - total request time
   - pool execution time
   - runtime-reported execution time

Expected outcome:

- separate:
  - queue cost
  - invoke/bridge cost
  - worker code cost
  - response wakeup / handoff cost

This is the prerequisite for any serious runtime-pool rewrite.

This prerequisite is now mostly satisfied for the current hot path.

The next practical move is no longer "measure more first".

It is:

- keep the HTTP path on the async mainline
- remove dead-end complexity from the temporary blocking branch
- spend the next optimization cycles only on the async request path

## Phase 3

## Per-request timeout control surface

Goal:

- introduce the product/runtime shape learned from `Bun`

Scope:

- no broad policy rewrite yet
- define the control surface first

What to do:

1. define a runtime-facing per-request timeout override mechanism
2. decide where it lives:
   - `ctx`
   - runtime helper
   - internal host API
3. make sure it composes with:
   - default exec timeout
   - streaming requests
   - graceful drain/shutdown

Expected outcome:

- the runtime starts feeling more product-shaped
- timeout behavior becomes explicit instead of only being an internal queue slot
  setting

## Phase 4

## Snapshot/bootstrap evaluation

Goal:

- use `Deno`'s runtime model where it helps most

Scope:

- generation prepare/runtime startup
- not hot-path request execution first

What to do:

1. identify what can be snapshotted safely:
   - web-runtime bootstrap
   - stable runtime helper JS
   - maybe invocation bridge bootstrap
2. measure:
   - slot creation time
   - generation prepare time
   - cold slot request latency

Expected outcome:

- lower bootstrap tax
- cleaner generation prepare story

## Not next

These should not be the next focus:

- response bridge redesign
- watchdog redesign
- more tiny `env/ctx` allocation tweaks
- more branch shaving in `execute_gateway(...)` before the queue/handoff cost is
  reduced
- broad Web-standard completeness work

## Exit criteria for this phase

The next phase is successful if all of the following become true:

1. request/runtime boundary shape is clearly closer to a real host-backed
   request object
2. queue cost vs invoke cost is measurable and visible
3. per-request timeout control has a concrete runtime design
4. benchmark log shows at least one more stable, repeatable request-path win

## One-line execution order

If choosing one strict order, use:

1. deepen `Request`
2. add queue/invoke measurements
3. design per-request timeout control
4. only then evaluate snapshots/bootstrap work
