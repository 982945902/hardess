# Local Release Baseline

This note captures the current local release baseline observed in this repo on **April 13, 2026**. It is a working operator reference, not a permanent product contract.

Use it for two purposes:
- to quickly judge whether a local run still looks healthy after code changes
- to compare later benchmark runs against a concrete baseline instead of relying on memory

## 1. Short Commands

Healthy local baseline checks:

```bash
bun run release:gate:local
bun run release:gate:cluster:local
```

Healthy local capacity probes:

```bash
bun run bench:ws:local
bun run bench:cluster:local
```

## 2. Current Baseline

Single-node release gate:
- command: `bun run release:gate:local`
- current local SLO envelope: `http p99 <= 100ms`, `ws recvAck p99 <= 100ms`, `ws handleAck p99 <= 200ms`, `sysErr=0`, `egressOverflow=0`, `egressBackpressure=0`
- latest passing sample on this machine: `http p99 ~= 4ms`, `ws recvAck p99 ~= 13ms`, `ws handleAck p99 ~= 17ms`

Cluster release gate:
- command: `bun run release:gate:cluster:local`
- current local SLO envelope: `cluster recvAck p99 <= 300ms`, `cluster handleAck p99 <= 400ms`, `sysErr=0`, `routeCacheRetry=0`, `httpFallback=0`, `egressOverflow=0`, `egressBackpressure=0`
- latest passing sample on this machine: `cluster recvAck p99 ~= 110ms`, `cluster handleAck p99 ~= 113ms`

Single-node websocket benchmark:
- command family: `bun run bench:ws:local`
- tested shape: `BENCH_WS_PROFILE=high`, `BENCH_WS_SLO_PROFILE=local`, `20 sender / 20 receiver`
- current healthy operating tier from sampled runs: `messagesPerSender=240`
- current degraded but still draining tier from sampled runs: `messagesPerSender=360`
- observed reason for degradation at `360`: latency crossed the local SLO envelope, while `sysErr`, `egressOverflow`, and `egressBackpressure` still stayed at `0`

Cluster benchmark:
- command family: `bun run bench:cluster:local`
- tested shape: `BENCH_CLUSTER_PROFILE=high`, `BENCH_CLUSTER_SLO_PROFILE=local`, `10 sender / 10 receiver`
- sampled passing tiers on this machine: `messagesPerSender=60` and `100`
- observed cluster degradation counters in these sampled passing runs: `routeCacheRetry=0`, `httpFallback=0`, `egressOverflow=0`, `egressBackpressure=0`

## 3. How To Read It

If `release:gate:local` fails:
- first treat it as a regression signal, not as "local is noisy"
- inspect the returned `slo.violations` before changing thresholds

If `bench:ws:local` still drains but fails SLO:
- that means the node still works functionally, but has left the healthy realtime envelope
- this is usually the point where tuning or design review is needed, not where correctness is already broken

If `bench:cluster:local` fails with zero `sysErr` but high latency:
- treat it as cluster degradation, not protocol corruption
- inspect `routeCacheRetry`, `httpFallback`, and the p99 split before changing the cluster transport design

If a benchmark times out:
- inspect the returned `pendingMessages`, `oldestPendingAgeMs`, `topPendingSenders`, and `pendingSamples`
- for cluster runs, also inspect `clusterWsLoadSummary.pendingSamples` plus the cluster counters

## 4. Scope

This baseline intentionally ignores `auth` as a release blocker.

This baseline does not claim:
- production sizing
- cross-machine reproducibility
- final upstream-facing SLA

It only says:
- what currently looks healthy on this repo and this machine
- where the current local healthy envelope seems to end
