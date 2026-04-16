# Pingora Experiment Benchmark Optimization Log

Date: 2026-04-15

## Goal

Keep one stable benchmark ledger for the `v2 experiment`.

This file is not trying to prove that `v2` is ready.

It exists to answer a narrower question:

- after each optimization round, did the HTTP request path actually get better?

## WebSocket note

The mainline entries in this file are still the HTTP request-path benchmark.

For WebSocket, the experiment now also has a first benchmark scaffold:

- Pingora worker target:
  - `workers/benchmark_websocket/mod.ts`
- Bun native baseline target:
  - `bench/bun_native_websocket.ts`
- shared round-trip client:
  - `bench/ws_roundtrip.ts`

The intended comparison rule is:

- same host machine
- same client script
- same connection count
- same messages per connection
- same echo semantics
- Rust side must still use `release`

Suggested commands:

- Pingora worker target:
  - `cargo build --release -p gateway-host --bin pingora_ingress`
  - `./experiment/pingora-worker-runtime/target/release/pingora_ingress experiment/pingora-worker-runtime/workers/benchmark_websocket/mod.ts --listen 127.0.0.1:6190 --worker-id ws-bench --runtime-threads 1 --queue-capacity 64 --exec-timeout-ms 5000`
  - `WS_BENCH_URL=ws://127.0.0.1:6190/ws bun run experiment/pingora-worker-runtime/bench/ws_roundtrip.ts`
- Bun native baseline:
  - `BUN_NATIVE_WS_PORT=6191 bun run experiment/pingora-worker-runtime/bench/bun_native_websocket.ts`
  - `WS_BENCH_URL=ws://127.0.0.1:6191 bun run experiment/pingora-worker-runtime/bench/ws_roundtrip.ts`

This benchmark should be read as:

- first compare transport/runtime fixed cost on the same echo workload
- only then compare richer application semantics

### WebSocket baseline sample

Date: 2026-04-16

Measured shape:

- host machine: same local machine, sequential runs
- Pingora binary: `target/release/pingora_ingress`
- warmup: `1` run
- measured: `3` runs
- connections: `50`
- messages per connection: `200`
- total messages per run: `10,000`
- worker/runtime threads on Pingora side: `1`
- echo semantics: text frame in, same text frame out

Measured commands:

- Pingora worker target:
  - `cargo build --release --manifest-path experiment/pingora-worker-runtime/Cargo.toml -p gateway-host --bin pingora_ingress`
  - `./experiment/pingora-worker-runtime/target/release/pingora_ingress experiment/pingora-worker-runtime/workers/benchmark_websocket/mod.ts --listen 127.0.0.1:6190 --worker-id ws-bench --runtime-threads 1 --queue-capacity 64 --exec-timeout-ms 5000`
  - `WS_BENCH_URL=ws://127.0.0.1:6190/ws WS_BENCH_CONNECTIONS=50 WS_BENCH_MESSAGES_PER_CONNECTION=200 bun run experiment/pingora-worker-runtime/bench/ws_roundtrip.ts`
- Bun native baseline:
  - `BUN_NATIVE_WS_PORT=6191 bun run experiment/pingora-worker-runtime/bench/bun_native_websocket.ts`
  - `WS_BENCH_URL=ws://127.0.0.1:6191 WS_BENCH_CONNECTIONS=50 WS_BENCH_MESSAGES_PER_CONNECTION=200 bun run experiment/pingora-worker-runtime/bench/ws_roundtrip.ts`

Average of 3 measured runs:

| Case | Msg/s | p50 | p90 | p99 |
|---|---:|---:|---:|---:|
| `pingora-v2-ws` | `58,113` | `0.821 ms` | `1.074 ms` | `1.558 ms` |
| `bun-native-ws` | `83,515` | `0.549 ms` | `0.837 ms` | `1.278 ms` |

Raw measured runs:

- `pingora-v2-ws`
  - run1: `56,516 msg/s`, `p50 0.838 ms`, `p90 1.179 ms`, `p99 1.866 ms`
  - run2: `59,752 msg/s`, `p50 0.814 ms`, `p90 1.034 ms`, `p99 1.474 ms`
  - run3: `58,070 msg/s`, `p50 0.812 ms`, `p90 1.008 ms`, `p99 1.335 ms`
- `bun-native-ws`
  - run1: `96,016 msg/s`, `p50 0.461 ms`, `p90 0.684 ms`, `p99 1.096 ms`
  - run2: `78,912 msg/s`, `p50 0.582 ms`, `p90 0.893 ms`, `p99 1.461 ms`
  - run3: `75,618 msg/s`, `p50 0.606 ms`, `p90 0.933 ms`, `p99 1.278 ms`

Gap summary:

- `pingora-v2-ws / bun-native-ws`
  - throughput: `0.696x`
  - p50: `1.50x`
  - p99: `1.22x`

Interpretation:

- this first WS path is already in the right order of magnitude
- Pingora worker WS echo is slower than Bun native, but not by an order of magnitude
- the next optimization focus should stay on the Rust <-> runtime event bridge and session scheduling path
- all conclusions above are based on `release` build only; `debug` samples are not comparable

## Benchmark rule

To keep the result comparable, use the same envelope every time unless the log
explicitly says otherwise.

- same host machine
- Rust `v2` binaries must be built with `release`
  - use `cargo build --release`
  - run `target/release/pingora_ingress`
  - `debug` numbers are allowed only for temporary diagnosis and must not be
    used for `v1` vs `v2` conclusions
- current HTTP benchmark mainline is `v2-async`
  - old `blocking` samples are kept only as historical experiment records
- same load generator:
  - [http.ts](/Users/lishuo121/hardess/src/load/http.ts)
- sequential benchmark runs, not concurrent benchmark runs
- warmup before sampling
- record the exact command shape
- separate:
  - fair shared-subset comparison
  - reference-only full-path comparison

## Current fair benchmark shape

Shared subset benchmark:

- `v1-short`
  - Bun Hardess runtime
  - `GET /benchmark/orders`
  - worker short-circuit response
- `v2-short`
  - Pingora + Rust + TS runtime experiment
  - `GET /benchmark/orders`
  - worker short-circuit response

Reference-only benchmark:

- `v1-full`
  - current real path:
  - auth -> worker -> upstream proxy

## Fixed benchmark config

- warmup:
  - `concurrency=20`
  - `requests=1000`
- measured run:
  - `concurrency=50`
  - `requests=5000`
- `v2` runtime threads:
  - `1`

## Baseline result

### Valid sample

The first `v2-short` sample on 2026-04-15 was invalid because the benchmark
worker used the `URL` global, but the current experiment runtime does not yet
inject that API. That sample returned `500` for all requests and is excluded.

The numbers below are the rerun after fixing the benchmark worker itself.

### Average of 3 measured runs

| Case | RPS | p50 | p90 | p99 | Result |
|---|---:|---:|---:|---:|---|
| `v1-short` | `35,986` | `1.28 ms` | `1.70 ms` | `3.66 ms` | `200 x 5000` |
| `v2-short` | `13,956` | `3.56 ms` | `4.08 ms` | `6.60 ms` | `200 x 5000` |
| `v1-full` | `16,930` | `2.65 ms` | `4.03 ms` | `6.50 ms` | `200 x 5000` |

### Gap summary

- `v2-short / v1-short`
  - RPS: `0.388x`
  - p50: `2.77x`
  - p99: `1.80x`
- `v2-short / v1-full`
  - RPS: `0.824x`
  - p50: `1.34x`
  - p99: `1.02x`

## What the baseline means

The current signal is:

- `v2` is not yet competitive with `v1` on the same short-circuit HTTP path
- the current fixed overhead on the `v2` request path is still heavy
- `v2-short` already lands close to the current `v1-full` path, which means
  the runtime bridge overhead is not yet cheap enough

This should be interpreted as:

- `the architecture direction is promising`

not:

- `the implementation is already fast enough`

## Optimization ledger

| ID | Topic | Current judgment | Why it likely matters | How to verify |
|---|---|---|---|---|
| `O1` | request bridge allocations | likely high | request metadata is still normalized into internal ABI before TS sees it | re-run short-circuit benchmark after reducing alloc/copy count |
| `O2` | JS/Rust boundary crossings | likely high | `Request` facade access may bounce across the bridge too often | add per-request bridge counters or micro benchmark |
| `O3` | runtime scheduler / queue overhead | likely medium-high | single-thread pool still pays submission / wakeup overhead | benchmark direct invoke vs queued invoke |
| `O4` | body/headers lazy path shape | medium | short-circuit traffic should avoid unnecessary body/header work entirely | profile request path when body is never consumed |
| `O5` | bootstrap/runtime helper cost | medium | Request/Response compatibility helpers may still do too much on hot path | measure with a worker that returns a constant response |
| `O6` | response bridge cost | medium | head normalization and body bridge still add fixed per-request overhead | compare tiny response vs empty response vs stream response |

## Optimization order

Breadth-first, low-risk order:

1. remove obviously avoidable allocations on the request path
2. measure JS/Rust bridge crossings and trim hot-path property access
3. isolate queue/runtime scheduling overhead from actual worker execution cost
4. then optimize response-path fixed overhead

This order is deliberate:

- it keeps the benchmark comparable
- it avoids premature deep work on package/runtime features
- it should expose the biggest fixed-cost wins first

## Next benchmark template

When a new optimization round lands, append one more section:

### Round N

- code change:
- benchmark shape:
- average RPS:
- average p50/p99:
- delta vs previous round:
- conclusion:

Do not overwrite the baseline.

The point of this file is trend visibility, not best-effort storytelling.

## Round 1

- code change:
  - make worker `Request.headers` lazy instead of eager
  - make worker `Request.body` lazy instead of eager
  - keep Rust-side request headers as a map until JS actually asks for headers
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `34,417`
    - p50: `1.15 ms`
    - p90: `1.95 ms`
    - p99: `2.97 ms`
  - `v2-short`
    - RPS: `14,113`
    - p50: `3.53 ms`
    - p90: `4.10 ms`
    - p99: `7.57 ms`
- delta vs baseline `v2-short`:
  - RPS: `+1.1%`
  - p50: `-0.7%`
  - p90: `+0.4%`
  - p99: `+14.7%`
- conclusion:
  - this optimization is directionally correct, but it is not the main bottleneck
  - removing eager header/body materialization did not materially improve the
    short-circuit path
  - inferred next focus:
    - request metadata normalization before TS sees it
    - JS/Rust boundary crossings for request property access
    - runtime queue / scheduling overhead

## Round 2

- code change:
  - collapse `request.method / request.url / hasBody` into one host snapshot op
  - stop constructing request head through multiple Rust bridge calls
  - keep headers lazy and body lazy
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `33,318`
    - p50: `1.32 ms`
    - p90: `2.16 ms`
    - p99: `3.46 ms`
  - `v2-short`
    - RPS: `14,696`
    - p50: `3.38 ms`
    - p90: `3.98 ms`
    - p99: `6.53 ms`
- delta vs Round 1 `v2-short`:
  - RPS: `+4.1%`
  - p50: `-4.4%`
  - p90: `-3.0%`
  - p99: `-13.6%`
- delta vs baseline `v2-short`:
  - RPS: `+5.3%`
  - p50: `-5.1%`
  - p90: `-2.5%`
  - p99: `-1.0%`
- conclusion:
  - reducing request head bridge crossings does help
  - this is the first optimization round with a clear non-noise win
  - the request bridge is still not cheap enough, but host-op count on the hot
    path was part of the problem
  - inferred next focus:
    - runtime pool queue / scheduling overhead
    - request normalization before the runtime sees it

## Round 3

- code change:
  - stop normalizing gateway request headers into `BTreeMap<String, String>`
  - let `GatewayRequest` own request head directly
  - gateway ingress now builds `Vec<(String, String)>` once and passes it
    through to the runtime
  - keep `worker_abi::WorkerRequest` unchanged for the non-gateway path
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `35,905`
    - p50: `1.28 ms`
    - p90: `1.78 ms`
    - p99: `3.15 ms`
  - `v2-short`
    - RPS: `15,385`
    - p50: `3.27 ms`
    - p90: `3.73 ms`
    - p99: `4.98 ms`
- delta vs Round 2 `v2-short`:
  - RPS: `+4.7%`
  - p50: `-3.2%`
  - p90: `-6.2%`
  - p99: `-23.9%`
- conclusion:
  - request normalization before the runtime sees it was a real hot path
  - replacing the gateway-side `BTreeMap` path produced another clear win
  - current `v2-short` is still behind `v1-short`, but the fixed overhead is
    coming down in measurable steps
  - inferred next focus:
    - request construction cost inside the JS runtime
    - runtime pool queue / oneshot scheduling overhead

## Round 4

- code change:
  - add a dedicated `Request._fromBacking(...)` fast path in the runtime bridge
  - internal worker invocation now skips the generic `new Request(...)` branch
    selection for ingress-backed requests
  - keep the public `Request` compatibility shape unchanged
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `34,819`
    - p50: `1.13 ms`
    - p90: `1.92 ms`
    - p99: `3.12 ms`
  - `v2-short`
    - RPS: `15,659`
    - p50: `3.21 ms`
    - p90: `3.65 ms`
    - p99: `5.45 ms`
- delta vs Round 3 `v2-short`:
  - RPS: `+1.8%`
  - p50: `-1.7%`
  - p90: `-2.2%`
  - p99: `+9.5%`
- conclusion:
  - request-construction fast path helps a bit, but the gain is much smaller
    than Round 2 and Round 3
  - this suggests the remaining cost is less about request object branching and
    more about deeper runtime/queue overhead
  - inferred next focus:
    - runtime pool queue / oneshot path
    - response normalization cost

## Abandoned Attempt

- idea:
  - change response bridge headers from object normalization to entries-array
    normalization
- result:
  - benchmark regressed badly and variance widened
- action:
  - reverted

This attempt is intentionally not counted as a valid optimization round.

## Post deadlock-fix sanity rerun

Date:

- `2026-04-16`

Build mode:

- `debug`

Why this rerun exists:

- the streaming request-body deadlock under `completion_mode=blocking` was fixed
- that fix should not affect the short-circuit `GET` benchmark path directly
- so this rerun is only checking whether the current code still preserves the
  previous steady-state benchmark shape

Benchmark shape:

- same host
- warmup `20 x 1000`
- measured `50 x 5000`
- `v2` runtime threads `= 1`
- `v2-async`
  - `--completion-mode async`
- `v2-blocking`
  - `--completion-mode blocking`
- worker:
  - `workers/benchmark_short_circuit/mod.ts`

### Average of 3 measured runs

| Case | RPS | p50 | p90 | p99 | Result |
|---|---:|---:|---:|---:|---|
| `v2-async` | `13,441` | `3.71 ms` | `4.47 ms` | `5.61 ms` | `200 x 5000` |
| `v2-blocking` | `9,552` | `4.56 ms` | `7.39 ms` | `17.39 ms` | `200 x 5000` |

### Current A/B signal

- `v2-blocking / v2-async`
  - RPS: `0.711x`
  - p50: `1.23x`
  - p90: `1.65x`
  - p99: `3.10x`
- this is the opposite of the `2026-04-15` A/B result
- so this rerun should be treated as a regression-check data point, not as a
  replacement for the earlier completion-mode conclusion

### Spot-check pool metrics

One fresh spot-check run was taken for each mode to inspect pool timings:

- `v2-blocking`
  - RPS: `6,821`
  - `average_queue_wait_ms`: `0.367`
  - `average_roundtrip_ms`: `0.529`
  - `average_response_handoff_ms`: `0.075`
- `v2-async`
  - RPS: `13,089`
  - `average_queue_wait_ms`: `0.070`
  - `average_roundtrip_ms`: `0.972`
  - `average_response_handoff_ms`: `0.864`

### Interpretation

- the blocking path still collapses response handoff cost
- but on the current code path it no longer wins end-to-end throughput or tail
  latency
- the current degradation does not look like a simple response-handoff problem
  anymore
- a more likely explanation is that under the current ingress / request-task
  shape, the blocking completion path is paying elsewhere:
  - caller-thread parking / contention
  - queue wait growth
  - some interaction with the new observability and lifecycle bookkeeping

### Action

- do not overwrite the previous A/B conclusion yet
- keep the deadlock fix
- treat `blocking` as correctness-preserving but performance-suspicious on the
  current tree
- this rerun is now retained only as a debug-mode diagnostic record
- the later release-mode comparison on `2026-04-16` is the valid benchmark
  conclusion
- next step should be targeted profiling of:
  - `WorkerRuntimeSlot::execute` blocking path
  - queue wait growth under `completion_mode=blocking`
  - ingress-thread behavior while many short requests complete concurrently

## Release benchmark comparison

Date:

- `2026-04-16`

Build mode:

- `v2`: `release`
- `v1`: Bun installed binary

Benchmark shape:

- same host
- warmup `20 x 1000`
- measured `50 x 5000`
- `v2` runtime threads `= 1`
- `v2-async`
  - current async mainline
- `v2-blocking`
  - historical A/B sample before removing the blocking branch
- `v1-short`
  - `bun run src/runtime/server.ts`

### Average of 3 measured runs

| Case | RPS | p50 | p90 | p99 | Result |
|---|---:|---:|---:|---:|---|
| `v1-short` | `35,139` | `1.09 ms` | `1.99 ms` | `2.75 ms` | `200 x 5000` |
| `v2-async` | `32,624` | `1.43 ms` | `1.76 ms` | `3.32 ms` | `200 x 5000` |
| `v2-blocking` | `25,624` | `1.81 ms` | `2.28 ms` | `3.75 ms` | `200 x 5000` |

### Valid conclusion

- `v2-async / v1-short`
  - RPS: `0.928x`
  - p50: `1.32x`
  - p90: `0.88x`
  - p99: `1.21x`
- `v2-blocking / v1-short`
  - RPS: `0.729x`
  - p50: `1.66x`
  - p90: `1.14x`
  - p99: `1.36x`
- `v2-blocking / v2-async`
  - RPS: `0.785x`
  - p50: `1.26x`
  - p90: `1.29x`
  - p99: `1.13x`

### Interpretation

- the earlier debug-mode pessimism was mostly a build-mode artifact
- on a fairer release-vs-release-style comparison, `v2-async` is already close
  to `v1-short`
- `v2-blocking` still loses to `v2-async`, so `async` remains the mainline
- the blocking branch has since been removed from the HTTP path
- the short-circuit HTTP path no longer shows a large structural gap between
  `v2-async` and `v1`

## Pingora listener/socket A/B

Date:

- `2026-04-15`

Benchmark shape:

- same host
- same worker:
  - `workers/benchmark_short_circuit/mod.ts`
- same runtime shape:
  - `runtime_threads = 1`
  - `queue_capacity = 64`
  - `completion_mode = blocking`
- warmup `20 x 1000`
- measured `50 x 5000`
- each case runs on its own fresh process / port
- current load client is still the repo `fetch(...)` loop:
  - it does not force a new TCP connection per request
  - so this benchmark mostly stresses steady-state request handling, not
    connection-establishment cost

Cases:

- `baseline`
  - default listener/socket settings
- `fastopen`
  - `--tcp-fastopen-backlog 10`
- `keepalive`
  - `--tcp-keepalive-idle-secs 60`
  - `--tcp-keepalive-interval-secs 5`
  - `--tcp-keepalive-count 5`

### Measured samples

- `baseline`
  - RPS: `15,244`, `14,706`, `15,873`
  - p50: `3.02 ms`, `3.08 ms`, `3.00 ms`
  - p90: `3.94 ms`, `4.48 ms`, `3.69 ms`
  - p99: `6.21 ms`, `7.66 ms`, `5.39 ms`
- `fastopen`
  - RPS: `16,779`, `14,925`, `14,205`
  - p50: `2.88 ms`, `3.15 ms`, `3.20 ms`
  - p90: `3.18 ms`, `4.10 ms`, `4.61 ms`
  - p99: `4.87 ms`, `5.79 ms`, `6.47 ms`
- `keepalive`
  - RPS: `15,723`, `16,393`, `16,393`
  - p50: `2.99 ms`, `2.94 ms`, `3.01 ms`
  - p90: `3.52 ms`, `3.47 ms`, `3.34 ms`
  - p99: `6.86 ms`, `4.81 ms`, `3.90 ms`

### Average of 3 measured runs

| Case | RPS | p50 | p90 | p99 |
|---|---:|---:|---:|---:|
| `baseline` | `15,274` | `3.04 ms` | `4.04 ms` | `6.42 ms` |
| `fastopen` | `15,303` | `3.08 ms` | `3.96 ms` | `5.71 ms` |
| `keepalive` | `16,170` | `2.98 ms` | `3.45 ms` | `5.19 ms` |

### Delta vs baseline

- `fastopen / baseline`
  - RPS: `+0.2%`
  - p50: `+1.3%`
  - p90: `-1.8%`
  - p99: `-11.1%`
  - note:
    - variance was visibly higher than baseline
    - this does not read like a stable win
- `keepalive / baseline`
  - RPS: `+5.9%`
  - p50: `-1.8%`
  - p90: `-14.7%`
  - p99: `-19.1%`
  - note:
    - the numbers are directionally better
    - but this is still hard to attribute to the keepalive flags themselves on
      this benchmark shape

### Supporting snapshots after each run

- `baseline`
  - ingress:
    - `average_request_read_ms`: `2.872`
    - `average_runtime_execute_ms`: `0.126`
    - `average_request_total_ms`: `3.036`
  - runtime:
    - `average_queue_wait_ms`: `0.068`
    - `average_invoke_ms`: `0.035`
    - `average_roundtrip_ms`: `0.120`
    - `average_response_handoff_ms`: `0.016`
- `fastopen`
  - ingress:
    - `average_request_read_ms`: `2.860`
    - `average_runtime_execute_ms`: `0.120`
    - `average_request_total_ms`: `3.019`
  - runtime:
    - `average_queue_wait_ms`: `0.062`
    - `average_invoke_ms`: `0.034`
    - `average_roundtrip_ms`: `0.114`
    - `average_response_handoff_ms`: `0.018`
- `keepalive`
  - ingress:
    - `average_request_read_ms`: `2.727`
    - `average_runtime_execute_ms`: `0.113`
    - `average_request_total_ms`: `2.876`
  - runtime:
    - `average_queue_wait_ms`: `0.057`
    - `average_invoke_ms`: `0.033`
    - `average_roundtrip_ms`: `0.108`
    - `average_response_handoff_ms`: `0.018`

### Conclusion

- `tcp_fastopen` is not a meaningful lever on the current localhost benchmark
  shape
  - this is expected:
    - the load client is mostly exercising keep-alive request reuse
    - `fastopen` helps around connection establishment, which is barely exposed
      here
- the `keepalive` case looks a bit better than baseline, but the causal story
  is weak
  - TCP keepalive is primarily a dead-peer / idle-connection liveness knob, not
    a throughput optimization knob
  - on this benchmark shape, the observed gain should be treated as
    measurement noise unless it reproduces under:
    - connection-churn-heavy traffic
    - remote-host testing
    - a benchmark that explicitly controls connection reuse
- practical decision:
  - keep the socket/listener flags as optional runtime controls
  - do not treat them as the next main optimization track
  - the next real gains are still more likely to come from:
    - request/runtime architecture
    - lower-copy request/response bridging
    - a benchmark shape that separates connection setup from steady-state
      request handling

## Request-task observability surfacing

Date:

- `2026-04-16`

Code change:

- make the request-task model more explicit in worker-facing metadata
- ingress now injects:
  - `hardess_request_task_id`
  - `hardess_client_addr`
  - `hardess_http_version`
  - `hardess_request_body_mode`
  - `hardess_request_completion_policy`
- runtime shard now injects:
  - `hardess_runtime_shard`
- ingress now also keeps an active request-task registry and exposes it through:
  - `/_hardess/ingress-state`
  - `active_request_tasks`
  - `recent_request_tasks`
- each tracked request task now carries:
  - host-side phase
  - terminal outcome for recently completed tasks

Smoke validation:

- with the blocking worker running, `/_hardess/ingress-state` now shows:
  - `inflight_count = 1`
  - task metadata like:
    - method
    - uri
    - client address
    - http version
    - request body mode
    - completion policy
    - current phase
    - task age
- after completed short-circuit benchmark traffic, `recent_request_tasks` rolls
  forward as a bounded completion history
  - benchmark snapshot showed `count = 32`

Benchmark shape:

- same host
- same worker:
  - `workers/benchmark_short_circuit/mod.ts`
- `v2-blocking`
- `runtime_threads = 1`
- warmup `20 x 1000`
- measured `50 x 5000`

Measured samples:

- RPS: `15,674`, `15,385`, `14,881`
- p50: `3.17 ms`, `3.19 ms`, `3.34 ms`
- p90: `3.35 ms`, `3.41 ms`, `3.72 ms`
- p99: `4.32 ms`, `5.02 ms`, `4.06 ms`

Average:

- RPS: `15,513`
- p50: `3.19 ms`
- p90: `3.41 ms`
- p99: `5.12 ms`

Comparison versus the previous same-shape baseline from the listener/socket A/B
round:

- RPS: `+1.6%`
- p50: `+5.0%`
- p90: `-15.5%`
- p99: `-20.2%`

Supporting snapshots:

- ingress:
  - `average_request_read_ms`: `2.887`
  - `average_runtime_execute_ms`: `0.104`
  - `average_request_total_ms`: `3.029`
- runtime:
  - `average_queue_wait_ms`: `0.048`
  - `average_invoke_ms`: `0.036`
  - `average_roundtrip_ms`: `0.096`
  - `average_response_handoff_ms`: `0.011`

Conclusion:

- the explicit request-task observability work still does not show a meaningful
  regression on the short-circuit path
- this is expected because:
  - worker-facing metadata is still a small `ctx.metadata` map
  - the request-task registry only tracks ingress-side lifecycle metadata
  - the hot request object and body path are unchanged
- practical takeaway:
  - keep this metadata model
  - keep the request-task registry with phase/outcome history
  - it improves observability and future scheduling/cancellation work without
    materially harming the current request path

## Abandoned Attempt

- idea:
  - replace watchdog `arm/disarm` per-request channel messages with shared state
    plus `Condvar`
- result:
  - benchmark became unstable and the rerun median regressed versus the previous
    stable round
- action:
  - reverted

This attempt is intentionally not counted as a valid optimization round.

## Round 5

- code change:
  - remove unnecessary `request/env/ctx` clones in
    `RuntimeGenerationManager::execute(...)` on the common active-generation
    success path
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `34,490`
    - p50: `1.21 ms`
    - p90: `1.94 ms`
    - p99: `2.82 ms`
  - `v2-short`
    - RPS: `15,530`
    - p50: `3.28 ms`
    - p90: `3.73 ms`
    - p99: `5.32 ms`
- delta vs Round 4 `v2-short`:
  - RPS: `-0.8%`
  - p50: `+2.0%`
  - p90: `+2.2%`
  - p99: `-2.4%`
- conclusion:
  - removing generation-manager clones is cleaner, but it is not a material hot
    path win
  - remaining fixed overhead is likely deeper in:
    - runtime queue / oneshot handoff
    - V8 invocation / serde boundary

## Round 6

- code change:
  - replace per-request `serde_v8` serialization for `env/ctx` with manual V8
    object construction
  - change invocation arg container from heap `Vec` to fixed-size array
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v1-short` vs `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- average result:
  - `v1-short`
    - RPS: `33,862`
    - p50: `1.26 ms`
    - p90: `1.92 ms`
    - p99: `2.90 ms`
  - `v2-short`
    - RPS: `15,628`
    - p50: `3.25 ms`
    - p90: `3.67 ms`
    - p99: `5.57 ms`
- delta vs Round 5 `v2-short`:
  - RPS: `+0.6%`
  - p50: `-0.7%`
  - p90: `-1.8%`
  - p99: `+4.7%`
- conclusion:
  - hand-building `env/ctx` objects is not a meaningful win
  - the remaining bottleneck is unlikely to be tiny per-request metadata object
    construction
  - inferred next focus:
    - runtime queue / oneshot handoff
    - watchdog arm/disarm overhead

## Abandoned Attempt

- idea:
  - add a dedicated single-slot fast path in `WorkerRuntimePool::execute_gateway`
  - bypass round-robin selection when `runtime_threads = 1`
  - keep the current transient-error retry semantics for retry-safe requests
- measured result:
  - first same-day run with the fast path:
    - RPS samples: `15,060`, `14,836`, `14,326`
    - p50 samples: `3.29 ms`, `3.20 ms`, `3.40 ms`
    - p99 samples: `6.30 ms`, `7.46 ms`, `8.63 ms`
  - immediate same-machine rerun after reverting the fast path:
    - RPS samples: `11,600`, `15,290`, `13,698`
    - p50 samples: `3.63 ms`, `3.33 ms`, `3.36 ms`
    - p99 samples: `16.05 ms`, `5.56 ms`, `12.19 ms`
- conclusion:
  - this branch-level optimization did not produce a stable, repeatable win
  - the benchmark signal became noisier than the expected gain
  - keeping extra dispatch complexity here is not justified
- action:
  - reverted

This attempt is intentionally not counted as a valid optimization round.

## Round 7

- code change:
  - replace the hot-path per-request async completion wait on the multithreaded
    ingress runtime
  - keep `tokio::mpsc` for request submission into the dedicated runtime thread
  - change response completion from `tokio::oneshot` to:
    - `std::sync::mpsc::sync_channel(1)` + `tokio::task::block_in_place(...)`
    - only on multithreaded caller runtimes
  - keep `tokio::oneshot` fallback for `current_thread` test/runtime contexts
- benchmark shape:
  - unchanged from baseline
  - same host
  - `v2-short`
  - warmup `20 x 1000`
  - measured `50 x 5000`
  - `v2` runtime threads `= 1`
- measured samples:
  - RPS: `17,605`, `17,064`, `16,835`
  - p50: `2.78 ms`, `2.88 ms`, `2.96 ms`
  - p90: `3.10 ms`, `3.19 ms`, `3.15 ms`
  - p99: `6.22 ms`, `6.51 ms`, `3.49 ms`
- average result:
  - `v2-short`
    - RPS: `17,168`
    - p50: `2.87 ms`
    - p90: `3.14 ms`
    - p99: `5.41 ms`
- delta vs Round 6 `v2-short`:
  - RPS: `+9.9%`
  - p50: `-11.6%`
  - p90: `-14.3%`
  - p99: `-2.9%`
- supporting runtime-pool metrics after the run:
  - `average_queue_wait_ms`: `0.045`
  - `average_invoke_ms`: `0.030`
  - `average_roundtrip_ms`: `0.088`
  - `average_response_handoff_ms`: `0.013`
- conclusion:
  - this is the clearest runtime-pool win so far
  - the previous fixed cost was indeed dominated by response handoff / caller
    wakeup, not worker invoke itself
  - removing async caller wakeup from the hot path materially reduced the fixed
    overhead
  - tradeoff:
    - this win is buying latency with a blocking wait on the multithreaded
      ingress runtime
    - that shape is probably acceptable for the current small-scale experiment
      and short worker path
    - it should be re-evaluated before treating it as the final architecture

## Completion-mode A/B and v1 comparison

Date:

- `2026-04-15`

Benchmark shape:

- same host
- warmup `20 x 1000`
- measured `50 x 5000`
- `v2` runtime threads `= 1`
- `v2-async`
  - `--completion-mode async`
- `v2-blocking`
  - `--completion-mode blocking`
- `v1-short`
  - Bun runtime short-circuit path

### Average of 3 measured runs

| Case | RPS | p50 | p90 | p99 | Result |
|---|---:|---:|---:|---:|---|
| `v1-short` | `34,647` | `1.13 ms` | `1.94 ms` | `2.71 ms` | `200 x 5000` |
| `v2-async` | `16,043` | `3.18 ms` | `3.55 ms` | `6.30 ms` | `200 x 5000` |
| `v2-blocking` | `16,970` | `2.91 ms` | `3.08 ms` | `5.43 ms` | `200 x 5000` |

### v2 A/B conclusion

- `v2-blocking / v2-async`
  - RPS: `+5.8%`
  - p50: `-8.6%`
  - p90: `-13.2%`
  - p99: `-13.8%`
- supporting pool metrics:
  - `v2-async`
    - `average_roundtrip_ms`: `0.954`
    - `average_response_handoff_ms`: `0.873`
  - `v2-blocking`
    - `average_roundtrip_ms`: `0.084`
    - `average_response_handoff_ms`: `0.011`
- interpretation:
  - the completion-mode change is real and repeatable
  - the main gain comes from collapsing response-handoff wakeup cost, not from
    faster worker execution

### v2 vs v1 conclusion

- `v2-blocking / v1-short`
  - RPS: `0.490x`
  - p50: `2.58x`
  - p90: `1.59x`
  - p99: `2.00x`
- `v2-async / v1-short`
  - RPS: `0.463x`
  - p50: `2.82x`
  - p90: `1.83x`
  - p99: `2.32x`
- interpretation:
  - fixing the completion path materially narrows the gap
  - but `v2` is still roughly half of `v1-short` on this tiny short-circuit
    HTTP path
  - the remaining gap is no longer dominated by response wakeup alone
  - the next hot spots are more likely in:
    - request submission / runtime-thread handoff shape
    - the dedicated runtime-thread architecture itself
    - the remaining Rust <-> V8 invocation envelope

## Abandoned Attempt

- idea:
  - keep the current queue type, but change the dedicated runtime thread from
    `receiver.recv().await` to `receiver.blocking_recv()`
  - execute each request with `current_thread` runtime `block_on(...)`
  - goal:
    - remove request-pickup async wakeup on the runtime thread side
- measured result:
  - same benchmark shape as `v2-blocking`
  - measured samples:
    - RPS: `16,835`, `16,835`, `17,483`
    - p50: `2.91 ms`, `2.93 ms`, `2.82 ms`
    - p90: `3.08 ms`, `3.07 ms`, `2.99 ms`
    - p99: `6.23 ms`, `6.09 ms`, `3.47 ms`
  - supporting pool metrics:
    - `average_queue_wait_ms`: `0.044`
    - `average_roundtrip_ms`: `0.086`
    - `average_response_handoff_ms`: `0.011`
- conclusion:
  - this was effectively flat versus the previous `v2-blocking` baseline
  - receiver-side async wakeup on the dedicated runtime thread is not the next
    meaningful bottleneck
- action:
  - reverted

This attempt is intentionally not counted as a valid optimization round.
