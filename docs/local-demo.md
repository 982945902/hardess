# Local Demo

## 1. Start Demo Upstream
```bash
bun run demo:upstream
```

Default port: `9000`

## 2. Start Hardess Runtime
```bash
PORT=3000 bun run dev
```

## 3. Exercise HTTP Gateway
```bash
curl -i \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/orders
```

or

```bash
bun run demo:http
```

Expected result:
- request passes shared auth
- demo worker injects worker/auth headers
- request is proxied to demo upstream

## 4. Start Receiver Client
```bash
PEER_ID=bob bun run demo:client
```

## 5. Start Sender Client
```bash
PEER_ID=alice TARGET_PEER_ID=bob AUTO_SEND=true bun run demo:client
```

Expected result:
- both clients receive `sys.auth.ok`
- sender logs `sys.route` and `sys.recvAck`
- receiver logs `chat.message`
- sender logs `sys.handleAck` after receiver auto-acks handled delivery

Notes:
- `demo:client` now defaults to `PROTOCOL=chat`
- set `PROTOCOL=demo` if you want the older echo-style demo payload

## 6. Stress HTTP Proxy
```bash
REQUESTS=1000 CONCURRENCY=100 TIMEOUT_MS=6000 bun run load:http
```

Optional upstream chaos:
```bash
UPSTREAM_DELAY_MS=200 UPSTREAM_JITTER_MS=300 UPSTREAM_FAILURE_RATE=0.05 bun run demo:upstream
```

Optional timeout verification:
```bash
UPSTREAM_DELAY_MS=6000 bun run demo:upstream
```

## 7. Stress WebSocket Messaging
```bash
SENDERS=20 RECEIVERS=20 MESSAGES_PER_SENDER=200 MAX_INFLIGHT_PER_SENDER=20 bun run load:ws
```

Handle-ack timeout verification:
```bash
ACK_MODE=handle RECEIVER_PROCESS_DELAY_MS=20000 HANDLE_ACK_TIMEOUT_MS=5000 bun run load:ws
```

Notes:
- `load:http` prints status counts, platform error codes, transport errors, and latency percentiles
- `load:ws` prints auth counts, `route/recvAck/handleAck` success counts, failure codes, close codes, and latency percentiles
- Both scripts intentionally do not retry failures; timeout and system errors are surfaced directly in the summary

## 8. Compare Bun Baseline vs Hardess Layers
One-shot comparison:
```bash
REQUESTS=1000 CONCURRENCY=100 bun run bench:compare
```

Comparison groups:
- `bun-bare`: raw `Bun.serve()` JSON response
- `hardess-short-circuit`: Hardess auth + worker short-circuit, no upstream proxy
- `hardess-full-chain`: Hardess auth + worker + upstream proxy

Standalone servers:
```bash
bun run bench:bare
bun run bench:short
```

Notes:
- `bench:compare` is for relative layer cost inside Hardess, not for comparing against Bun's published Linux microbenchmarks
- Run it on the same machine with no extra background load if you want stable ratios

## 9. Compare WebSocket Layers
One-shot comparison:
```bash
CLIENTS=10 MESSAGES_PER_CLIENT=50 bun run bench:ws-compare
```

Comparison groups:
- `bun-ws-bare`: raw Bun WebSocket echo
- `hardess-ws-auth-only`: Hardess shared auth + self-loop route + `recvAck`
- `hardess-ws-full-route`: Hardess auth + peer routing + `recvAck`

Standalone servers:
```bash
bun run bench:ws-bare
bun run bench:ws-auth
```

Notes:
- The WS compare focuses on relative layer cost, not maximum million-msg/sec synthetic throughput
- `hardess-ws-auth-only` removes cross-peer fanout cost so you can separate auth/runtime overhead from routing overhead
