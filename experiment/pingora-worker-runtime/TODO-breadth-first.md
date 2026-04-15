# Breadth-first TODO for the Pingora Experiment

Date: 2026-04-15

## Goal

Prefer low-coupling, broad-value work first.

Short version:

`Stabilize the runtime contract and observability before deepening the package/runtime stack.`

## P0

- keep local mutable `/_hardess/*` endpoints explicitly debug-only
- keep read-only runtime state strong:
  - `runtime-pool`
  - `module-cache`
  - `ingress-state`
  - `generations`
- strengthen the runtime-side state model:
  - `desired`
  - `prepared`
  - `active`
  - `failed`
- add clearer prepare status fields:
  - active artifact/version marker
  - desired/prepared/failed artifact marker visibility
- keep one runtime invocation contract only:
  - `fetch(request, env, ctx)`
  - no compatibility side path

## P1

- tighten the desired-worker payload contract the runtime should consume
- tighten runtime status reporting fields for control-plane polling / callbacks
- continue shrinking local `reload` semantics in favor of `apply desired worker`
- keep debug wrappers thin around the real internal state transition path

## P2

- split prepare cache from generation-local prepared artifacts
- add cache/config policy fields:
  - max entries
  - max bytes
  - cleanup mode
- add retention/rollback window for previous generations
- replace the current response byte-array bridge with a lower-copy typed-array/native bridge

## P3

- move from experiment rewrite semantics toward fuller Deno graph semantics
- evaluate `deno_graph` integration
- improve `jsr:` / `npm:` handling beyond the current experimental rewrite path
- define the real control-plane-to-node apply protocol
- evaluate whether the JSON-shaped request bridge should later be replaced by host objects for a lower-copy ingress path
- only later evaluate whether `Response` itself should become a deeper Rust-backed host object

## Intentionally later

- full WebSocket runtime model
- full streaming body support
- deep sandbox / isolation work
- distributed rollout orchestration details

## Commit guidance

This experiment is already at a good checkpoint for a first milestone commit.

Reasonable milestone label:

`generation prepare/cache/observability foundation`
