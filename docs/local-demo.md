# Local Demo

Use [../README.md](../README.md) as the repo entrypoint. This document stays focused on the local demo flow only.

## Quick Commands

```bash
bun run dev
bun run demo:upstream
bun run demo:admin
bun run demo:stack
bun run demo:client
bun run demo:http
bun run verify
bun run clean
```

Focused checks when you only changed one area:

```bash
bun run test:runtime
bun run test:sdk
```

## Flows

There are now two useful local flows:

- quick single-node path: direct runtime config, good for smoke-testing the basic HTTP / WS path
- admin-projected path: mock control-plane, good for exercising `DesiredHostState`, artifact staging, `serve`, rollout, and host-group-scoped placement/topology

## 1. Quick Single-Node Flow

### 1.1 Start Demo Upstream
```bash
bun run demo:upstream
```

Default port: `9000`

### 1.2 Start Hardess Runtime
```bash
PORT=3000 bun run dev
```

### 1.3 Exercise HTTP Gateway
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

### 1.4 Start Receiver Client
```bash
PEER_ID=bob bun run demo:client
```

### 1.5 Start Sender Client
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
- for HTTP / WS load and weak-network simulation, continue in [load-testing.md](load-testing.md)

## 2. Admin-Projected Demo Flow

This flow is the better fit when you want to observe the current `v1` runtime boundary:

- host registration to admin
- desired-state projection per host
- artifact manifest fetch and local staging
- shared vs host-local HTTP deployment projection
- `serve` deployment projection
- host registration with `HOST_GROUP_ID`
- group-local topology projection

### 2.0 One-Command Start

```bash
bun run demo:stack
```

Useful overrides:

- `DEMO_STACK_RESET_ARTIFACTS=1 bun run demo:stack`
- `DEMO_STACK_SHARED_DEPLOYMENT_REPLICAS=2 bun run demo:stack`

The script starts `upstream`, `admin`, `host-demo-a`, and `host-demo-b`, waits for readiness, prints useful URLs, and shuts the full stack down on `Ctrl+C`.

### 2.1 Start Upstream And Mock Admin

Terminal 1:

```bash
bun run demo:upstream
```

Terminal 2:

```bash
bun run demo:admin
```

### 2.2 Start Two Runtime Hosts

Terminal 3:

```bash
ADMIN_BASE_URL=http://127.0.0.1:9100 \
ADMIN_HOST_ID=host-demo-a \
ADMIN_ARTIFACT_ROOT_DIR=.hardess-admin-artifacts-a \
HOST_GROUP_ID=group-personnel \
PORT=3000 \
bun run dev
```

Terminal 4:

```bash
ADMIN_BASE_URL=http://127.0.0.1:9100 \
ADMIN_HOST_ID=host-demo-b \
ADMIN_ARTIFACT_ROOT_DIR=.hardess-admin-artifacts-b \
HOST_GROUP_ID=group-personnel \
PORT=3001 \
bun run dev
```

### 2.3 Verify Admin-Projected Routes

Shared route:

```bash
curl -s \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/shared | jq .
```

Host-local route:

```bash
curl -s \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/hosts/host-demo-a | jq .
```

Serve route inside the host group:

```bash
curl -i \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/serve/health
```

Expected:

- `/demo/shared` only exists on the selected owner host when `sharedDeploymentReplicas=1`
- `/demo/hosts/<hostId>` is projected per host
- `/demo/serve/health` is projected to both hosts in `group-personnel`
- serve response includes `x-hardess-admin-scope=serve`
- serve response includes `x-hardess-group-id=group-personnel`

### 2.4 Inspect Mock Admin State

```bash
curl -s http://127.0.0.1:9100/__admin/mock/state | jq .
```

That is the fastest way to inspect:

- registered hosts
- desired projections
- observed assignment state
- topology membership / placement
- rollout summary

For the full walkthrough, including rollout simulation and artifact endpoints, continue in [v1-admin-mock-demo.md](v1-admin-mock-demo.md).
