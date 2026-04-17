# Hardess

Hardess is a Bun-based gateway plus realtime message hub. The current repo already runs a single-node HTTP path (`auth -> worker -> proxy`), a single-node WebSocket path (`sys.auth`, routing, ack flow, heartbeat, quota/rate-limit baseline), and a static multi-node baseline with HTTP peer locate plus an internal WS node-to-node channel for cross-node delivery.

## Main Workflows

Install dependencies:

```bash
bun install
```

Run the local demo stack:

```bash
# quick single-node path
bun run demo:upstream
PORT=3000 bun run dev
bun run demo:http
PEER_ID=bob bun run demo:client
PEER_ID=alice TARGET_PEER_ID=bob AUTO_SEND=true bun run demo:client

# admin-projected path
bun run demo:stack

# or start the four processes manually
bun run demo:upstream
bun run demo:admin
ADMIN_BASE_URL=http://127.0.0.1:9100 ADMIN_HOST_ID=host-demo-a PORT=3000 bun run dev
ADMIN_BASE_URL=http://127.0.0.1:9100 ADMIN_HOST_ID=host-demo-b PORT=3001 bun run dev
```

The admin-projected flow is the current better demo: it exercises host registration, desired-state reconcile, artifact staging, shared/per-host HTTP projection, `serve`, and group-local placement/topology projection. See [docs/v1-admin-mock-demo.md](docs/v1-admin-mock-demo.md).

Useful overrides for `demo:stack`:

- `DEMO_STACK_RESET_ARTIFACTS=1` clears the two local artifact cache directories before boot
- `DEMO_STACK_SHARED_DEPLOYMENT_REPLICAS=2` starts the mock admin with two shared owners

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

## SDK Quick Start

Recommended client flow:

1. `connect(...)`
2. `waitUntilReady()`
3. `send(...)` or `emitTracked(...)`
4. branch on structured SDK errors instead of parsing error strings

Example:

```ts
import {
  CLIENT_ERROR_CODES,
  ERROR_CODES,
  HardessClient,
  type HardessSdkErrorShape
} from "./src/sdk/index.ts";

const client = new HardessClient("ws://127.0.0.1:3000/ws", {
  systemHandlers: {
    onClose(info) {
      console.log("ws closed", info);
    },
    onDeliveryEvent(event) {
      if (event.sdkError) {
        console.log("delivery failed", event.sdkError.code, event.sdkError.source);
      }
    }
  }
});

client.connect("demo:alice");
await client.waitUntilReady();

try {
  await client.send({
    protocol: "demo",
    version: "1.0",
    action: "send",
    payload: {
      toPeerId: "bob",
      content: "hello"
    }
  });
} catch (error) {
  const sdkError = error as Partial<HardessSdkErrorShape>;

  if (sdkError.code === CLIENT_ERROR_CODES.CLIENT_NOT_READY) {
    // local client state is not ready yet; wait for auth.ok or reconnect
  } else if (sdkError.code === CLIENT_ERROR_CODES.CLIENT_TRANSPORT_CLOSED) {
    // transport closed before ack completed; usually safe to retry after reconnect
  } else if (sdkError.code === CLIENT_ERROR_CODES.CLIENT_DELIVERY_TIMEOUT) {
    // sender-side timeout waiting for recvAck / handleAck
  } else if (sdkError.code === ERROR_CODES.SERVER_DRAINING) {
    // remote node is draining; retry on another healthy node / after reconnect
  } else if (sdkError.code === ERROR_CODES.ROUTE_PEER_OFFLINE) {
    // remote peer is currently offline
  }

  throw error;
}

client.close();
```

SDK behavior notes:

- business sends should start after `sys.auth.ok`; use `waitUntilReady()` instead of assuming `WebSocket open` is enough
- `send(...)` rejects with a structured SDK error carrying `code`, `source`, and `retryable`
- pending tracked sends fail immediately on transport close, including shutdown-driven `1001 / server shutting down`
- server-side `sys.err` surfaces as `source="remote"`; SDK-local state failures surface as `source="client"`

## HTTP Authoring

`worker` is still the lowest-level HTTP primitive:

```ts
export default {
  async fetch(request, env, ctx) {
    return new Response("ok");
  }
};
```

`serve` is the higher-level HTTP app form now supported by runtime:

```ts
import { createApp, createRouter, defineServe } from "./src/sdk/index.ts";

const users = createRouter();
users.get("/:id", (_request, _env, ctx) => {
  return Response.json({
    userId: ctx.params.id,
    path: ctx.path,
    originalPath: ctx.originalPath
  });
});

const app = createApp();
app.get("/health", () => new Response("ok"));
app.use("/users", users);

export default defineServe(app);
```

Current `serve` behavior:

- runtime strips the pipeline `matchPrefix` before route matching
- supports `app.use(...)`, nested router mount, per-method routes, and `:param`
- adapts back into the current worker `fetch(request, env, ctx)` ABI at load time

## Group Model

The current `v1` group model is runtime-side, not client-side:

- `admin` is global and can manage multiple groups
- one `hardess` host belongs to exactly one group, decided at startup by `HOST_GROUP_ID`
- if `HOST_GROUP_ID` is omitted, that host joins the default group
- HTTP forwarding, WS peer locate, and cross-node relay stay inside the host's group-local topology
- clients do not need to pass a `groupId`; upstream control-plane routing should send them to the correct host set

## Docs

- [Local demo walkthrough](docs/local-demo.md)
- [v1 Admin mock demo](docs/v1-admin-mock-demo.md)
- [Load testing and weak-network simulation](docs/load-testing.md)
- [Current local release baseline](docs/local-release-baseline.md)
- [Operator guide](docs/operator-guide.md)
- [v1 Admin / control-plane design](docs/hardess-v1-admin-control-plane.md)
- [v1 Host protocol design](docs/hardess-v1-host-protocol.md)
- [Dual-port cluster and Swarm design](docs/swarm-dual-port-cluster-design.md)
- [Swarm v1 cluster deployment design](docs/swarm-v1-cluster-deployment.md)
- [Grafana dashboard template](docs/grafana-hardess-overview.dashboard.json)
- [Architecture design and current status](docs/hardess-architecture.md)
- [Pingora / workerd as Hardess v2 research](docs/research-pingora-for-hardess-v2.md)
- [Experimental Pingora + Rust + TS runtime workspace](experiment/README.md)

## Still Not Done

- production auth provider integration still replaces only the demo auth path
- the shared runtime-schema layer still has a small tail of ad hoc validation, mostly around the hot-path envelope fast parser and a few runtime helper guards
- websocket egress and backpressure thresholds still need broader workload validation and tuning
- external observability stack rollout is still deployment-specific; the repo now ships Prometheus export, a sample Grafana dashboard, bounded metrics, and threshold-based log alerts
- dynamic membership, stronger cluster coordination, and non-static multi-node routing remain deferred
- the default ACL / capability policy for injected protocols is intentionally deferred until the upstream integration contract is stable
