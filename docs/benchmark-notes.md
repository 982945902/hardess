# Benchmark Notes

## Scope
These benchmarks are for `hardess` only. They are not meant to reproduce Bun's published Linux microbenchmarks.

The goal is to answer two practical questions:
1. What is the relative cost of each Hardess layer on the same machine?
2. When reliability features are enabled, do failures stay visible to the SDK?

## HTTP Matrix
Use:
```bash
bun run bench:compare
```

Cases:
- `bun-bare`: raw `Bun.serve()` JSON response
- `hardess-short-circuit`: auth + worker short-circuit, no upstream hop
- `hardess-full-chain`: auth + worker + upstream proxy

Interpretation:
- `hardess-short-circuit / bun-bare` approximates ingress overhead
- `hardess-full-chain / bun-bare` approximates full HTTP data-plane overhead

## WebSocket Matrix
Use:
```bash
bun run bench:ws-compare
```

Cases:
- `bun-ws-bare`: raw Bun WebSocket echo
- `hardess-ws-auth-only`: shared auth + self-loop route + `recvAck`
- `hardess-ws-full-recvAck`: auth + peer route + `recvAck`
- `hardess-ws-full-handleAck`: auth + peer route + receiver-side `handleAck`
- `hardess-ws-partial-failure`: peer fanout with one online recipient and one missing recipient

Interpretation:
- `auth-only` isolates runtime/auth/envelope cost
- `full-recvAck` adds normal route fanout cost
- `full-handleAck` adds receiver-side completion signaling cost
- `partial-failure` verifies that route failures are collected and returned instead of being hidden by runtime retries

## Reliability Rules
Hardess benchmark scripts intentionally follow these rules:
- No automatic application-level retry inside the benchmark client
- Timeout and system errors must be observable by the caller
- Partial route failure must be visible in `receipt.route.failed[]`

## Stress vs Benchmark
Use the load scripts when you want operational reliability data:
- `bun run load:http`
- `bun run load:ws`

Use the compare scripts when you want relative layer cost:
- `bun run bench:compare`
- `bun run bench:ws-compare`

## Caveats
- Local Windows loopback results are useful for regression tracking, not for headline performance claims
- Small-message microbenchmarks exaggerate framework overhead relative to real workloads
- If you change rate limits, queue bounds, or ack mode, rerun the compare scripts before drawing conclusions
