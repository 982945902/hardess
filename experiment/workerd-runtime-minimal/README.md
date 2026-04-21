# workerd Minimal Runtime Validation

Status: runnable

## Question

Can we run a minimal `workerd`-based HTTP worker locally, from inside the Hardess repo, with:

- a TypeScript worker entry
- a basic text binding
- a basic JSON binding
- request body handling
- a minimal WebSocket upgrade path

This is intentionally not a Hardess runtime integration. It is only a feasibility spike.

## What this proves

- `workerd` can be built and executed locally on this machine
- a modules-based TypeScript worker can serve HTTP traffic
- capability-style bindings can be injected into the worker
- a small request/response path works without Bun
- a Hardess-flavored static manifest can be translated into `workerd` config
- a minimal WebSocket echo path works through the same local runtime

## What this does not prove

- no Hardess control-plane integration
- no dynamic artifact loading
- no multi-service planning or placement
- no websocket path
- no singleton serve semantics

## Files

- `bridge-manifest.json`: Hardess-flavored static input for the runtime bridge
- `generate-config.ts`: converts the manifest into a runnable `workerd` config
- `config.capnp`: hand-written baseline config for comparison
- `worker.ts`: TypeScript worker entry
- `ws-smoke.ts`: local WebSocket validation client
- `run.sh`: starts the local server
- `verify.sh`: boots the server, sends requests, and checks responses

## Run

```bash
./experiment/workerd-runtime-minimal/run.sh
```

Default listen address is `127.0.0.1:6285`.

Before starting `workerd`, the script generates:

- `.generated.config.capnp`

from:

- `bridge-manifest.json`

## Verify

```bash
./experiment/workerd-runtime-minimal/verify.sh
```

The script checks:

- `GET /`
- `POST /echo`
- `GET /ws` websocket upgrade and echo
- manifest-to-config generation

## Graduation bar

This experiment would only graduate into a real Hardess runtime track if all of the following stay true:

- the request contract remains simple and predictable
- bindings map cleanly onto Hardess-managed artifacts or runtime capabilities
- startup and local iteration are acceptable for development use
- the runtime model still leaves room for Hardess-owned planning and serve semantics
