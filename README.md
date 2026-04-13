# Hardess

Hardess is a Bun-based gateway plus realtime message hub. The current repo already runs a single-node HTTP path (`auth -> worker -> proxy`), a single-node WebSocket path (`sys.auth`, routing, ack flow, heartbeat, quota/rate-limit baseline), and a static multi-node baseline with HTTP peer locate plus an internal WS node-to-node channel for cross-node delivery.

## Main Workflows

Install dependencies:

```bash
bun install
```

Run the local demo stack:

```bash
bun run demo:upstream
PORT=3000 bun run dev
bun run demo:http
PEER_ID=bob bun run demo:client
PEER_ID=alice TARGET_PEER_ID=bob AUTO_SEND=true bun run demo:client
```

Run verification:

```bash
bun run verify
```

Run load tests:

```bash
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
bun run release:gate
bun run release:gate:cluster
bun run release:gate:cluster:local
```

Clean runtime-generated shadow files:

```bash
bun run clean
```

## Docs

- [Local demo walkthrough](docs/local-demo.md)
- [Load testing and weak-network simulation](docs/load-testing.md)
- [Current local release baseline](docs/local-release-baseline.md)
- [Operator guide](docs/operator-guide.md)
- [Grafana dashboard template](docs/grafana-hardess-overview.dashboard.json)
- [Architecture design and current status](docs/hardess-architecture.md)

## Still Not Done

- production auth provider integration still replaces only the demo auth path
- the shared runtime-schema layer still has a small tail of ad hoc validation, mostly around the hot-path envelope fast parser and a few runtime helper guards
- websocket egress and backpressure thresholds still need broader workload validation and tuning
- external observability stack rollout is still deployment-specific; the repo now ships Prometheus export, a sample Grafana dashboard, bounded metrics, and threshold-based log alerts
- dynamic membership, stronger cluster coordination, and non-static multi-node routing remain deferred
- the default ACL / capability policy for injected protocols is intentionally deferred until the upstream integration contract is stable
