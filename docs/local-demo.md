# Local Demo

Use [../README.md](../README.md) as the repo entrypoint. This document stays focused on the local demo flow only.

## Quick Commands

```bash
bun run dev
bun run demo:upstream
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
- for HTTP / WS load and weak-network simulation, continue in [load-testing.md](load-testing.md)
