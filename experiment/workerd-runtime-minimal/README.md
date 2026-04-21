# workerd Minimal Runtime Validation

Status: runnable

## Question

Can we run a minimal `workerd`-based HTTP worker locally, from inside the Hardess repo, with:

- a TypeScript worker entry
- a basic text binding
- a basic JSON binding
- request body handling
- a minimal WebSocket upgrade path
- a Hardess-style assignment object that stays separate from runtime adapter config
- a minimal planning fragment that resolves routeRefs into an actual route table
- a minimal protocol package that resolves route actions and method/websocket policy

This is intentionally not a Hardess runtime integration. It is only a feasibility spike.

## What this proves

- `workerd` can be built and executed locally on this machine
- a modules-based TypeScript worker can serve HTTP traffic
- capability-style bindings can be injected into the worker
- a small request/response path works without Bun
- a Hardess-style assignment object can be translated into `workerd` config through a thin adapter
- routeRefs can be resolved against a planning fragment and enforced at runtime
- protocol-package actions can drive worker dispatch and negative method checks
- a minimal WebSocket echo path works through the same local runtime
- the runtime can consume a single resolved-model binding in addition to compatibility-oriented bindings
- the resolved model carries ingress diagnostics that are directly usable for inspection and debugging
- the resolved model now emits non-blocking advisories for risky but still valid ingress shapes
- advisories are severity-ranked so callers can distinguish informational signals from warnings
- runtime dispatch now reads protocol metadata from the resolved model; `HARDESS_ROUTE_TABLE` and `HARDESS_PROTOCOL_PACKAGE` remain only as compatibility bindings
- the resolved model now carries an explicit binding contract describing the primary runtime binding and retained compatibility/metadata bindings

## What this does not prove

- no Hardess control-plane integration
- no dynamic artifact loading
- no multi-service planning or placement
- no singleton serve semantics

## Files

- `assignment.json`: Hardess-flavored assignment input
- `runtime-adapter.json`: workerd-specific runtime adapter input
- `planning-fragment.json`: minimal route planning input
- `protocol-package.json`: minimal protocol-package input for ingress actions
- `bad-fixtures/`: intentionally invalid inputs used by generator negative checks
- `config-model.ts`: typed input schemas plus JSON loading
- `resolved-runtime-model.ts`: validation plus resolved runtime model construction
- `config-render.ts`: renders runnable `workerd` config from validated inputs
- `generate-config.ts`: thin CLI entry that loads inputs and writes the generated config
- `print-resolved-model.ts`: prints the resolved runtime model as JSON for inspection
- `print-runtime-summary.ts`: prints a compact admin/debug summary derived from the resolved runtime model
- `config.capnp`: hand-written baseline config for comparison
- `worker.ts`: TypeScript worker entry
- `ws-smoke.ts`: local WebSocket validation client
- `run.sh`: starts the local server
- `verify.sh`: boots the server, sends requests, and checks responses
- `verify-negative.sh`: checks that invalid inputs fail during config generation

## Run

```bash
./experiment/workerd-runtime-minimal/run.sh
```

Default listen address is `127.0.0.1:6285`.

Before starting `workerd`, the script generates:

- `.generated.config.capnp`

from:

- `assignment.json`
- `runtime-adapter.json`
- `planning-fragment.json`
- `protocol-package.json`

The generator also supports overriding any input file:

```bash
bun run ./experiment/workerd-runtime-minimal/generate-config.ts \
  --assignment ./experiment/workerd-runtime-minimal/assignment.json \
  --runtime-adapter ./experiment/workerd-runtime-minimal/runtime-adapter.json \
  --planning-fragment ./experiment/workerd-runtime-minimal/planning-fragment.json \
  --protocol-package ./experiment/workerd-runtime-minimal/protocol-package.json \
  --output ./experiment/workerd-runtime-minimal/.generated.config.capnp
```

To inspect the resolved runtime model directly:

```bash
bun run ./experiment/workerd-runtime-minimal/print-resolved-model.ts
```

To inspect a shorter admin/debug summary:

```bash
bun run ./experiment/workerd-runtime-minimal/print-runtime-summary.ts
```

The resolved-model printer accepts the same input overrides as the generator:

```bash
bun run ./experiment/workerd-runtime-minimal/print-resolved-model.ts \
  --assignment ./experiment/workerd-runtime-minimal/assignment.json \
  --runtime-adapter ./experiment/workerd-runtime-minimal/runtime-adapter.json \
  --planning-fragment ./experiment/workerd-runtime-minimal/planning-fragment.json \
  --protocol-package ./experiment/workerd-runtime-minimal/protocol-package.json
```

## Verify

```bash
./experiment/workerd-runtime-minimal/verify.sh
```

The script checks:

- `GET /`
- `POST /echo`
- `GET /echo` negative method check
- `GET /ws` websocket upgrade and echo
- assignment-plus-adapter-plus-planning-plus-protocol-package to config generation

## Verify Negative Cases

```bash
./experiment/workerd-runtime-minimal/verify-negative.sh
```

The script currently locks in two core failures:

- assignment references a `routeRef` that planning does not contain
- planning resolves to an `actionId` that the protocol package does not contain

For those shared validation paths, the negative script checks both:

- `generate-config.ts`
- `print-resolved-model.ts`

It also locks in a few structural validation failures:

- duplicate `routeRef` inside assignment
- invalid `listenAddress` or duplicate runtime compatibility flags inside runtime adapter
- duplicate `routeId` or duplicate `pathPrefix` inside planning
- malformed `pathPrefix` such as trailing slash or double slash
- invalid HTTP method shape or duplicate methods inside the protocol package
- invalid `websocket` action declaration inside the protocol package
- websocket route planning that forgets to enable upstream websocket support
- upstream `baseUrl` scheme that does not match the resolved action kind

## Graduation bar

This experiment would only graduate into a real Hardess runtime track if all of the following stay true:

- the request contract remains simple and predictable
- bindings map cleanly onto Hardess-managed artifacts or runtime capabilities
- startup and local iteration are acceptable for development use
- the runtime model still leaves room for Hardess-owned planning and serve semantics
