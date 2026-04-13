# Load Testing

Use [../README.md](../README.md) as the repo entrypoint, [local-demo.md](local-demo.md) for the baseline demo flow, and [local-release-baseline.md](local-release-baseline.md) for the current local health envelope. This document only covers sustained load and weak-network simulation.

This project includes lightweight HTTP and WebSocket load scripts plus a containerized Toxiproxy setup for weak-network simulation without changing the host macOS network stack.

Env namespace guide:
- `HTTP_LOAD_*`: HTTP load script inputs
- `WS_LOAD_*`: single-node WebSocket load script inputs
- `CLUSTER_WS_LOAD_*`: cross-node WebSocket load script inputs
- `BENCH_WS_*`: single-node WebSocket stair-step benchmark inputs
- `BENCH_CLUSTER_*`: cluster stair-step benchmark inputs
- `RELEASE_GATE_*`: single-node release-gate inputs
- `CLUSTER_RELEASE_GATE_*`: cluster release-gate inputs
- `TOXI_*`: Toxiproxy setup and weak-network profile inputs
- the older generic aliases still work for the basic load scripts, but new examples below always use the namespaced form

Command summary:

```bash
bun run verify
bun run load:http
bun run load:ws
bun run load:cluster-ws
bun run bench:ws
bun run bench:ws:local
bun run bench:ws:high
bun run bench:cluster
bun run bench:cluster:local
bun run bench:cluster:high
bun run release:gate:local
bun run release:gate:cluster:high
bun run load:toxiproxy setup
bun run load:toxiproxy weak-client
bun run load:toxiproxy weak-upstream
bun run load:toxiproxy reset
bun run release:gate
bun run release:gate:cluster
bun run release:gate:cluster:local
```

## 1. Start the local runtime under test

Terminal 1:
```bash
bun run demo:upstream
```

Terminal 2:
```bash
PORT=3000 bun run dev
```

Optional before running load:

```bash
bun run verify
bun run release:gate
```

## 2. Optional: start containerized weak-network simulation

Start Toxiproxy in Docker:
```bash
docker compose -f docker/loadtest.compose.yml up -d
```

Create the default proxies:
```bash
bun run load:toxiproxy setup
```

Available default proxy ports:
- HTTP client to Hardess: `http://127.0.0.1:8666`
- WebSocket client to Hardess: `ws://127.0.0.1:8765/ws`
- Hardess to demo upstream: `http://127.0.0.1:8667`

Apply a weak client-network profile:
```bash
bun run load:toxiproxy weak-client
```

Apply a weak upstream-network profile:
```bash
bun run load:toxiproxy weak-upstream
```

Reset all toxics:
```bash
bun run load:toxiproxy reset
```

Notes:
- On macOS with Docker Desktop, the default proxy upstream uses `host.docker.internal`, so Toxiproxy stays inside Docker while still reaching the runtime or demo upstream running on the host.
- To simulate weak `Hardess -> upstream` behavior, point the runtime config downstream origin at `http://127.0.0.1:8667`.
- weak-network tuning now prefers `TOXI_LATENCY_MS`, `TOXI_JITTER_MS`, and `TOXI_BANDWIDTH_KBPS`; the older bare names still work as compatibility fallbacks
- the Toxiproxy helper now validates the `/proxies` API response shape before printing status, so malformed control-plane responses fail fast instead of silently drifting

## 3. Run HTTP load

Default run:
```bash
bun run load:http
```

Example with more concurrency:
```bash
HTTP_LOAD_CONCURRENCY=50 HTTP_LOAD_REQUESTS=2000 bun run load:http
```

Example through the Toxiproxy HTTP client proxy:
```bash
HTTP_LOAD_BASE_URL=http://127.0.0.1:8666 \
HTTP_LOAD_ADMIN_BASE_URL=http://127.0.0.1:3000 \
HTTP_LOAD_CONCURRENCY=50 \
HTTP_LOAD_REQUESTS=2000 \
bun run load:http
```

The script prints JSON including:
- request counts
- status distribution
- error distribution
- p50 / p90 / p99 latency
- delta from runtime metrics snapshot when `__admin/metrics` is available

## 4. Run WebSocket load

Default run:
```bash
bun run load:ws
```

Example with more peers and messages:
```bash
WS_LOAD_SENDER_COUNT=50 WS_LOAD_RECEIVER_COUNT=50 WS_LOAD_MESSAGES_PER_SENDER=200 bun run load:ws
```

Example through the Toxiproxy WebSocket client proxy:
```bash
WS_LOAD_WS_URL=ws://127.0.0.1:8765/ws \
WS_LOAD_ADMIN_BASE_URL=http://127.0.0.1:3000 \
WS_LOAD_SENDER_COUNT=20 \
WS_LOAD_RECEIVER_COUNT=20 \
WS_LOAD_MESSAGES_PER_SENDER=100 \
bun run load:ws
```

The script prints JSON including:
- authenticated peer count
- sent and delivered message counts
- `recvAck` latency summary
- `handleAck` latency summary
- pending message diagnostics (`pendingMessages`, `oldestPendingAgeMs`, `topPendingSenders`, `pendingSamples`) when completion stalls
- close-code distribution
- `sys.err` distribution
- delta from runtime metrics snapshot when `__admin/metrics` is available

## 5. Suggested release-gate scenarios

Run these as a minimum:
- Baseline HTTP load against `http://127.0.0.1:3000`
- Baseline WebSocket load against `ws://127.0.0.1:3000/ws`
- Baseline cross-node WebSocket load with senders on one node and receivers on another
- Weak client-network HTTP + WebSocket through Toxiproxy
- Weak upstream HTTP forwarding by routing downstream traffic through the upstream proxy
- Shutdown validation while load is running to confirm `__admin/ready` drops before stop

Automation note:
- `bun run release:gate` now starts a temporary demo upstream plus runtime, waits for both to answer, then runs HTTP smoke, HTTP load, WebSocket load, and shutdown-readiness validation
- `bun run release:gate:cluster` now starts a temporary demo upstream plus two-node static cluster, waits for upstream and both nodes to answer, then runs cross-node WebSocket validation with `CLUSTER_TRANSPORT=ws`
- `bun run release:gate:cluster:high` runs the same cluster gate with the built-in `high` profile defaults applied
- Toxiproxy weak-network scenarios still remain a manual operator step
- both release-gate commands now also support optional SLO thresholds; if you set them, the gate fails even when traffic fully drains but latency or degradation counters exceed the configured envelope

Single-node release-gate SLO example:
```bash
RELEASE_GATE_HTTP_MAX_P99_MS=200 \
RELEASE_GATE_WS_MAX_RECV_ACK_P99_MS=500 \
RELEASE_GATE_WS_MAX_HANDLE_ACK_P99_MS=1000 \
RELEASE_GATE_WS_MAX_EGRESS_OVERFLOW_COUNT=0 \
RELEASE_GATE_WS_MAX_EGRESS_BACKPRESSURE_COUNT=0 \
RELEASE_GATE_WS_MAX_SYS_ERR_COUNT=0 \
bun run release:gate
```

Single-node release-gate layered profile example:
```bash
RELEASE_GATE_SLO_PROFILE=local bun run release:gate
```

Cluster release-gate SLO example:
```bash
CLUSTER_RELEASE_GATE_WS_MAX_RECV_ACK_P99_MS=500 \
CLUSTER_RELEASE_GATE_WS_MAX_HANDLE_ACK_P99_MS=1000 \
CLUSTER_RELEASE_GATE_WS_MAX_ROUTE_CACHE_RETRY_COUNT=0 \
CLUSTER_RELEASE_GATE_WS_MAX_HTTP_FALLBACK_COUNT=0 \
CLUSTER_RELEASE_GATE_WS_MAX_EGRESS_OVERFLOW_COUNT=0 \
CLUSTER_RELEASE_GATE_WS_MAX_EGRESS_BACKPRESSURE_COUNT=0 \
CLUSTER_RELEASE_GATE_WS_MAX_SYS_ERR_COUNT=0 \
bun run release:gate:cluster:high
```

Cluster release-gate layered profile example:
```bash
CLUSTER_RELEASE_GATE_SLO_PROFILE=local bun run release:gate:cluster
```

## 6. Run Cross-Node WebSocket load

This script assumes a two-node static cluster and measures the current cross-node path:

- peer locate still goes over internal HTTP
- remote `deliver` and `handleAck` go over the internal WebSocket cluster channel by default

```bash
CLUSTER_WS_LOAD_SENDER_WS_URL=ws://127.0.0.1:3000/ws \
CLUSTER_WS_LOAD_RECEIVER_WS_URL=ws://127.0.0.1:3001/ws \
CLUSTER_WS_LOAD_SENDER_ADMIN_BASE_URL=http://127.0.0.1:3000 \
CLUSTER_WS_LOAD_RECEIVER_ADMIN_BASE_URL=http://127.0.0.1:3001 \
bun run load:cluster-ws
```

The script prints JSON including:
- cross-node send throughput
- `recvAck` latency summary
- unique `recvAckCount` plus `duplicateRecvAckCount` for diagnostics when the sender sees repeated ack events
- `handleAck` latency summary
- `routeCacheRetryCount`, `clusterHttpFallbackCount`, `clusterEgressOverflowCount`, and `clusterEgressBackpressureCount` so you can tell whether the run stayed mostly on the internal WS channel or degraded onto internal HTTP fallback
- sender and receiver metrics deltas
- close-code distribution
- `sys.err` distribution

## 7. Run Cluster Stair-Step Benchmark

Use this when you want a more repeatable picture of cluster capacity and the first unstable load tier instead of a single short run.

Default run:
```bash
bun run bench:cluster
```

Tuned high-load profile:
```bash
bun run bench:cluster:high
```

Tuned local-envelope shortcut:
```bash
bun run bench:cluster:local
```

Equivalent explicit profile form:
```bash
BENCH_CLUSTER_PROFILE=high bun run bench:cluster
```

Useful overrides:
```bash
BENCH_CLUSTER_SCENARIOS=30,60,80,100 \
BENCH_CLUSTER_RUNS=3 \
BENCH_CLUSTER_SENDERS=10 \
BENCH_CLUSTER_RECEIVERS=10 \
BENCH_CLUSTER_SEND_INTERVAL_MS=0 \
BENCH_CLUSTER_COMPLETION_TIMEOUT_MS=40000 \
bun run bench:cluster
```

Important note:
- cluster benchmark scenarios still pass through the normal websocket ingress guards
- the default runtime inbound rate limit is `100` messages per `1s` per connection
- the auth message counts toward that limit, so `messagesPerSender=100` with `sendIntervalMs=0` can intentionally hit the policy guard instead of a transport capacity ceiling
- the cluster transport request timeout also matters under sustained load; the runtime default is now `10000ms`
- if you want to benchmark transport headroom beyond that policy boundary, raise `WS_RATE_LIMIT_MAX_MESSAGES` or add a non-zero send interval
- the benchmark output now marks each scenario with `likelyPolicyLimited` and reports the first such tier in the summary

Example for transport-headroom testing beyond the default policy guard:
```bash
WS_RATE_LIMIT_MAX_MESSAGES=300 \
BENCH_CLUSTER_SCENARIOS=100,150,200 \
BENCH_CLUSTER_RUNS=2 \
bun run bench:cluster
```

Current high-load profile notes:
- the tuned profile now lives behind `BENCH_CLUSTER_PROFILE=high`, so the package script no longer needs a long inline env chain
- `bench:cluster:high` raises the default ingress rate-limit, sender outbound queue, and cluster request timeout so the benchmark is less likely to stop at default policy guards
- it also raises `CLUSTER_LOCATOR_CACHE_TTL_MS` so the benchmark is less sensitive to locator refresh churn during steady-state traffic
- for boundary probing, keep the high profile and override only `BENCH_CLUSTER_SCENARIOS` / `BENCH_CLUSTER_RUNS`
- timeout failures now include pending-ack samples and the top senders still waiting, which makes long-tail diagnosis much easier than a plain `expected vs actual` counter

Optional SLO thresholds:
```bash
BENCH_CLUSTER_MAX_RECV_ACK_P99_MS=500 \
BENCH_CLUSTER_MAX_HANDLE_ACK_P99_MS=1000 \
BENCH_CLUSTER_MAX_HTTP_FALLBACK_COUNT=0 \
BENCH_CLUSTER_MAX_ROUTE_CACHE_RETRY_COUNT=0 \
BENCH_CLUSTER_MAX_EGRESS_OVERFLOW_COUNT=0 \
BENCH_CLUSTER_MAX_EGRESS_BACKPRESSURE_COUNT=0 \
BENCH_CLUSTER_MAX_SYS_ERR_COUNT=0 \
bun run bench:cluster:high
```

Notes:
- all SLO thresholds are optional; if you do not set them, the benchmark still reports completion stability only
- available built-in SLO profiles are `local` and `high`; `default` keeps the old "no thresholds unless you set them" behavior
- current single-node SLO profile defaults:
- `local`: `recvAck p99 <= 100ms`, `handleAck p99 <= 200ms`, `sysErr=0`, `egressOverflow=0`, `egressBackpressure=0`
- `high`: `recvAck p99 <= 150ms`, `handleAck p99 <= 300ms`, `sysErr=0`, `egressOverflow=0`, `egressBackpressure=0`
- when thresholds are set, each successful run is additionally marked `sloPassed=true|false`
- scenario-level `sloPassed` means every run completed and every run stayed within the configured limits
- this lets you separate "the system eventually drained" from "the system stayed inside an acceptable realtime envelope"

The benchmark prints:
- per-scenario success count
- per-scenario SLO-passing count when thresholds are configured
- throughput mean / min / max / stddev
- `recvAck p99` mean / min / max / stddev
- `handleAck p99` mean / min / max / stddev
- `sysErrCount` mean / min / max / stddev
- `stablePrefixUpToMessagesPerSender`: the last continuously stable tier from the start of the ladder
- `highestFullyStableMessagesPerSender`: the highest tier that happened to pass all configured runs
- `stableSloPrefixUpToMessagesPerSender`: the last continuously SLO-passing tier from the start of the ladder
- `highestSloPassingMessagesPerSender`: the highest tier that passed all configured runs and all configured SLO thresholds
- `firstObservedFailureMessagesPerSender`: the first tier where any run failed
- `firstObservedSloFailureMessagesPerSender`: the first tier that either failed outright or exceeded one of the configured SLO thresholds

The current built-in `high` profile applies these defaults unless you explicitly override them:
- `WS_RATE_LIMIT_MAX_MESSAGES=2200`
- `WS_OUTBOUND_MAX_QUEUE_MESSAGES=8192`
- `WS_OUTBOUND_MAX_QUEUE_BYTES=8388608`
- `CLUSTER_REQUEST_TIMEOUT_MS=30000`
- `CLUSTER_LOCATOR_CACHE_TTL_MS=10000`
- `BENCH_CLUSTER_COMPLETION_TIMEOUT_MS=420000`

## 8. Run Single-Node WebSocket Stair-Step Benchmark

Use this when you want a repeatable picture of single-node websocket sender/receiver headroom, especially around outbound queueing and backpressure, instead of a single short `load:ws` run.

Default run:
```bash
bun run bench:ws
```

Tuned high-load profile:
```bash
bun run bench:ws:high
```

Tuned local-envelope shortcut:
```bash
bun run bench:ws:local
```

Equivalent explicit profile form:
```bash
BENCH_WS_PROFILE=high bun run bench:ws
```

Useful overrides:
```bash
BENCH_WS_SCENARIOS=30,60,90,120 \
BENCH_WS_RUNS=3 \
BENCH_WS_SENDERS=10 \
BENCH_WS_RECEIVERS=10 \
BENCH_WS_SEND_INTERVAL_MS=0 \
BENCH_WS_COMPLETION_TIMEOUT_MS=40000 \
bun run bench:ws
```

Important note:
- single-node benchmark scenarios still pass through the normal websocket ingress guards
- the auth message counts toward the default inbound rate limit, so `messagesPerSender=100` with `sendIntervalMs=0` can intentionally hit policy before it hits egress capacity
- if you want to probe egress / queue headroom beyond that policy boundary, raise `WS_RATE_LIMIT_MAX_MESSAGES` or add a non-zero send interval
- the benchmark output marks each scenario with `likelyPolicyLimited` and reports the first such tier in the summary

Optional SLO thresholds:
```bash
BENCH_WS_MAX_RECV_ACK_P99_MS=200 \
BENCH_WS_MAX_HANDLE_ACK_P99_MS=400 \
BENCH_WS_MAX_EGRESS_OVERFLOW_COUNT=0 \
BENCH_WS_MAX_EGRESS_BACKPRESSURE_COUNT=0 \
BENCH_WS_MAX_SYS_ERR_COUNT=0 \
bun run bench:ws:high
```

Optional layered SLO profile:
```bash
BENCH_WS_SLO_PROFILE=local bun run bench:ws
```

Notes:
- all SLO thresholds are optional; if you do not set them, the benchmark still reports completion stability only
- available built-in SLO profiles are `local` and `high`; `default` keeps the old "no thresholds unless you set them" behavior
- current cluster SLO profile defaults:
- `local`: `recvAck p99 <= 300ms`, `handleAck p99 <= 400ms`, `sysErr=0`, `routeCacheRetry=0`, `httpFallback=0`, `egressOverflow=0`, `egressBackpressure=0`
- `high`: `recvAck p99 <= 450ms`, `handleAck p99 <= 600ms`, `sysErr=0`, `routeCacheRetry=0`, `httpFallback=0`, `egressOverflow=0`, `egressBackpressure=0`
- when thresholds are set, each successful run is additionally marked `sloPassed=true|false`
- this separates "the node eventually drained" from "the node stayed within an acceptable realtime envelope"

The benchmark prints:
- per-scenario success count
- per-scenario SLO-passing count when thresholds are configured
- throughput mean / min / max / stddev
- `recvAck p99` mean / min / max / stddev
- `handleAck p99` mean / min / max / stddev
- `sysErrCount` mean / min / max / stddev
- `egressOverflowCount` mean / min / max / stddev
- `egressBackpressureCount` mean / min / max / stddev
- `stablePrefixUpToMessagesPerSender`: the last continuously stable tier from the start of the ladder
- `highestFullyStableMessagesPerSender`: the highest tier that happened to pass all configured runs
- `stableSloPrefixUpToMessagesPerSender`: the last continuously SLO-passing tier from the start of the ladder
- `highestSloPassingMessagesPerSender`: the highest tier that passed all configured runs and all configured SLO thresholds
- `firstObservedFailureMessagesPerSender`: the first tier where any run failed
- `firstObservedSloFailureMessagesPerSender`: the first tier that either failed outright or exceeded one of the configured SLO thresholds

The current built-in `high` profile applies these defaults unless you explicitly override them:
- `WS_RATE_LIMIT_MAX_MESSAGES=2200`
- `WS_OUTBOUND_MAX_QUEUE_MESSAGES=8192`
- `WS_OUTBOUND_MAX_QUEUE_BYTES=8388608`
- `WS_OUTBOUND_MAX_SOCKET_BUFFER_BYTES=1048576`
- `BENCH_WS_COMPLETION_TIMEOUT_MS=180000`

## 9. Env Reference

Compatibility note:
- the load scripts prefer namespaced envs such as `HTTP_LOAD_*`, `WS_LOAD_*`, and `CLUSTER_WS_LOAD_*`
- older generic aliases like `BASE_URL`, `WS_URL`, `SENDER_COUNT`, and `MESSAGES_PER_SENDER` still work as compatibility fallbacks for the basic load scripts
- prefer the namespaced form when running multiple commands in the same shell so they do not accidentally reuse each other's settings

HTTP load:
- `HTTP_LOAD_BASE_URL`
- `HTTP_LOAD_ADMIN_BASE_URL`
- `HTTP_LOAD_PEER_ID`
- `HTTP_LOAD_PATHNAME`
- `HTTP_LOAD_METHOD`
- `HTTP_LOAD_CONCURRENCY`
- `HTTP_LOAD_REQUESTS`
- `HTTP_LOAD_DURATION_MS`
- `HTTP_LOAD_REQUEST_BODY`

WebSocket load:
- `WS_LOAD_WS_URL`
- `WS_LOAD_ADMIN_BASE_URL`
- `WS_LOAD_PROTOCOL`
- `WS_LOAD_SENDER_COUNT`
- `WS_LOAD_RECEIVER_COUNT`
- `WS_LOAD_MESSAGES_PER_SENDER`
- `WS_LOAD_SEND_INTERVAL_MS`
- `WS_LOAD_CONNECT_TIMEOUT_MS`
- `WS_LOAD_COMPLETION_TIMEOUT_MS`

Cluster WebSocket load:
- `CLUSTER_WS_LOAD_SENDER_WS_URL`
- `CLUSTER_WS_LOAD_RECEIVER_WS_URL`
- `CLUSTER_WS_LOAD_SENDER_ADMIN_BASE_URL`
- `CLUSTER_WS_LOAD_RECEIVER_ADMIN_BASE_URL`
- `CLUSTER_WS_LOAD_PROTOCOL`
- `CLUSTER_WS_LOAD_SENDER_COUNT`
- `CLUSTER_WS_LOAD_RECEIVER_COUNT`
- `CLUSTER_WS_LOAD_MESSAGES_PER_SENDER`
- `CLUSTER_WS_LOAD_SEND_INTERVAL_MS`
- `CLUSTER_WS_LOAD_CONNECT_TIMEOUT_MS`
- `CLUSTER_WS_LOAD_COMPLETION_TIMEOUT_MS`

Single-node websocket benchmark:
- `BENCH_WS_PROFILE`
- `BENCH_WS_SLO_PROFILE`
- `BENCH_WS_SCENARIOS`
- `BENCH_WS_RUNS`
- `BENCH_WS_SENDERS`
- `BENCH_WS_RECEIVERS`
- `BENCH_WS_SEND_INTERVAL_MS`
- `BENCH_WS_COMPLETION_TIMEOUT_MS`
- `BENCH_WS_READY_TIMEOUT_MS`
- `BENCH_WS_PORT_BASE`
- `BENCH_WS_METRICS_SINK`
- `BENCH_WS_MAX_RECV_ACK_P99_MS`
- `BENCH_WS_MAX_HANDLE_ACK_P99_MS`
- `BENCH_WS_MAX_EGRESS_OVERFLOW_COUNT`
- `BENCH_WS_MAX_EGRESS_BACKPRESSURE_COUNT`
- `BENCH_WS_MAX_SYS_ERR_COUNT`

Cluster benchmark:
- `BENCH_CLUSTER_PROFILE`
- `BENCH_CLUSTER_SLO_PROFILE`
- `BENCH_CLUSTER_SCENARIOS`
- `BENCH_CLUSTER_RUNS`
- `BENCH_CLUSTER_SENDERS`
- `BENCH_CLUSTER_RECEIVERS`
- `BENCH_CLUSTER_SEND_INTERVAL_MS`
- `BENCH_CLUSTER_COMPLETION_TIMEOUT_MS`
- `BENCH_CLUSTER_PORT_BASE`
- `BENCH_CLUSTER_UPSTREAM_PORT_BASE`
- `BENCH_CLUSTER_MAX_RECV_ACK_P99_MS`
- `BENCH_CLUSTER_MAX_HANDLE_ACK_P99_MS`
- `BENCH_CLUSTER_MAX_HTTP_FALLBACK_COUNT`
- `BENCH_CLUSTER_MAX_ROUTE_CACHE_RETRY_COUNT`
- `BENCH_CLUSTER_MAX_EGRESS_OVERFLOW_COUNT`
- `BENCH_CLUSTER_MAX_EGRESS_BACKPRESSURE_COUNT`
- `BENCH_CLUSTER_MAX_SYS_ERR_COUNT`

Release gates:
- single-node gate: `RELEASE_GATE_SLO_PROFILE`, `RELEASE_GATE_PORT`, `RELEASE_GATE_UPSTREAM_PORT`, `RELEASE_GATE_READY_TIMEOUT_MS`, `RELEASE_GATE_METRICS_SINK`, `RELEASE_GATE_SHUTDOWN_DRAIN_MS`, `RELEASE_GATE_HTTP_CONCURRENCY`, `RELEASE_GATE_HTTP_REQUESTS`, `RELEASE_GATE_HTTP_MAX_P99_MS`, `RELEASE_GATE_WS_SENDERS`, `RELEASE_GATE_WS_RECEIVERS`, `RELEASE_GATE_WS_MESSAGES_PER_SENDER`, `RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS`, `RELEASE_GATE_WS_MAX_RECV_ACK_P99_MS`, `RELEASE_GATE_WS_MAX_HANDLE_ACK_P99_MS`, `RELEASE_GATE_WS_MAX_EGRESS_OVERFLOW_COUNT`, `RELEASE_GATE_WS_MAX_EGRESS_BACKPRESSURE_COUNT`, `RELEASE_GATE_WS_MAX_SYS_ERR_COUNT`
- cluster gate: `CLUSTER_RELEASE_GATE_PROFILE`, `CLUSTER_RELEASE_GATE_SLO_PROFILE`, `CLUSTER_RELEASE_GATE_PORT_A`, `CLUSTER_RELEASE_GATE_PORT_B`, `CLUSTER_RELEASE_GATE_UPSTREAM_PORT`, `CLUSTER_RELEASE_GATE_READY_TIMEOUT_MS`, `CLUSTER_RELEASE_GATE_SHARED_SECRET`, `CLUSTER_RELEASE_GATE_METRICS_SINK`, `CLUSTER_RELEASE_GATE_WS_SENDERS`, `CLUSTER_RELEASE_GATE_WS_RECEIVERS`, `CLUSTER_RELEASE_GATE_WS_MESSAGES_PER_SENDER`, `CLUSTER_RELEASE_GATE_WS_SEND_INTERVAL_MS`, `CLUSTER_RELEASE_GATE_WS_COMPLETION_TIMEOUT_MS`, `CLUSTER_RELEASE_GATE_WS_MAX_RECV_ACK_P99_MS`, `CLUSTER_RELEASE_GATE_WS_MAX_HANDLE_ACK_P99_MS`, `CLUSTER_RELEASE_GATE_WS_MAX_ROUTE_CACHE_RETRY_COUNT`, `CLUSTER_RELEASE_GATE_WS_MAX_HTTP_FALLBACK_COUNT`, `CLUSTER_RELEASE_GATE_WS_MAX_EGRESS_OVERFLOW_COUNT`, `CLUSTER_RELEASE_GATE_WS_MAX_EGRESS_BACKPRESSURE_COUNT`, `CLUSTER_RELEASE_GATE_WS_MAX_SYS_ERR_COUNT`

Toxiproxy:
- `TOXIPROXY_API_URL`
- `TOXI_HTTP_PORT`
- `TOXI_WS_PORT`
- `TOXI_UPSTREAM_PORT`
- `TOXI_HTTP_UPSTREAM`
- `TOXI_WS_UPSTREAM`
- `TOXI_UPSTREAM_TARGET`
- `TOXI_LATENCY_MS`
- `TOXI_JITTER_MS`
- `TOXI_BANDWIDTH_KBPS`
