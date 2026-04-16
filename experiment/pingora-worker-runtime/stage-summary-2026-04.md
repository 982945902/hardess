# Pingora Worker Runtime Stage Summary

Date: 2026-04-16

Status: good checkpoint, stop active optimization

## Summary

This experiment has now reached a reasonable stage boundary.

What is proven already:

- `Pingora + Rust + embedded TS runtime` is a workable direction for a Hardess v2-style host
- the experiment has one stable worker contract:
  - `fetch(request, env, ctx)`
- the request path is no longer built around per-request JS source-string invocation
- local TS workers, `deno.json#imports`, remote module loading, and lockfile integrity checks all work in the current experiment envelope
- the first WebSocket path works for:
  - HTTP/1.1 upgrade
  - text frames
  - ping/pong
  - close
  - TS-side `onOpen / onMessage / onClose`
  - Rust-owned `ctx.send(...)` / `ctx.close(...)` command capture
- ingress/runtime observability is now strong enough to explain most local benchmark behavior

## What Is Good Enough

For the current experiment goal, the following should be treated as good enough:

- the runtime contract shape
- the package-management direction
- the generation / prepare / active state model
- the first websocket ownership model:
  - Rust owns transport and lifecycle
  - TS owns behavior
- the current performance level

Latest clean same-envelope websocket comparison on 2026-04-16:

- `pingora-v2-ws`
  - `55,432 msg/s`
  - `p50 0.840 ms`
  - `p90 1.200 ms`
  - `p99 1.736 ms`
- `bun-native-ws`
  - `71,477 msg/s`
  - `p50 0.616 ms`
  - `p90 1.115 ms`
  - `p99 1.692 ms`

Interpretation:

- throughput is about `0.776x` of Bun native on this local echo benchmark
- `p90` and `p99` are already close
- the remaining gap is real, but it is no longer large enough to justify more local optimization churn by default

## Kept Wins

The following websocket-side optimization results are worth keeping:

- remove the extra JS-side websocket event reshaping
- cache websocket `connectionId` / `workerId` as V8 strings
- cache fixed websocket V8 property/value strings
- preallocate one websocket command slot with `Vec::with_capacity(1)` for the common `message -> send` path

## Explicitly Rejected Directions

The following were tried and should not be retried casually:

- caching the whole websocket `ctx` object in V8
- splitting websocket dispatch into pre-bound `open / message / close` wrappers
- moving `ctx.send / ctx.close` attachment from JS-side decoration into Rust-side context materialization

Short version:

- "less JS code" did not automatically mean "faster"
- the stable wins came from lower-level materialization and allocation cost, not wrapper cleverness

## What Is Still Missing

This stage is not claiming production completeness.

Still missing or intentionally deferred:

- binary websocket frames
- fragmented websocket frames
- deeper streaming / lower-copy response path
- fuller Deno-compatible package graph semantics
- stronger worker isolation / sandboxing
- real control-plane apply protocol
- generation retention / rollback window
- broader websocket hardening beyond the current first slice

## Recommended Policy From Here

For the next stage:

- stop active optimization work unless a concrete regression or product need appears
- keep benchmark discipline:
  - `release` only
  - same envelope
  - serial runs
- treat the current benchmark level as a guardrail, not a new optimization target
- focus on feature completeness, control-plane integration, and architecture cleanup

## Next-phase Focus

The next useful work should be functional, not benchmark-driven:

1. tighten control-plane to runtime apply/state contracts
2. continue generation / rollout / artifact management
3. deepen package-management correctness where needed
4. only then revisit low-copy runtime deepening if a real product need justifies it

## Bottom Line

This experiment is now at a point where it is fair to say:

- the direction is validated
- the architecture is coherent
- the websocket path is real enough to learn from
- performance is respectable
- there is no need to keep squeezing benchmark points right now
