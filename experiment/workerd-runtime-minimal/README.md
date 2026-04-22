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
- resolved model and summary now carry explicit schema versions, and compatibility bindings can be disabled from the runtime adapter
- the worker side now has an explicit singleton runtime layer with instance state, request sequencing, route-hit tracking, and websocket session tracking
- the worker runtime exposes local inspection endpoints under `/_hardess/runtime` for overview, stats, and resolved route views
- the runtime admin surface now carries an explicit schema version so overview/stats/routes and admin error responses can evolve as a versioned contract

## What this does not prove

- no Hardess control-plane integration
- no dynamic artifact loading
- no multi-service planning or placement
- no multi-instance serve semantics

## Files

- `assignment.json`: Hardess-flavored assignment input
- `runtime-adapter.json`: workerd-specific runtime adapter input
- `runtime-adapter-route-table-only.json`: variant adapter that keeps only `HARDESS_ROUTE_TABLE`
- `runtime-adapter-protocol-package-only.json`: variant adapter that keeps only `HARDESS_PROTOCOL_PACKAGE`
- `runtime-adapter-no-compatibility-bindings.json`: variant adapter input that disables compatibility bindings
- `planning-fragment.json`: minimal route planning input
- `protocol-package.json`: minimal protocol-package input for ingress actions
- `bad-fixtures/`: intentionally invalid inputs used by generator negative checks
- `config-model.ts`: typed input schemas plus JSON loading
- `resolved-runtime-model.ts`: validation plus resolved runtime model construction
- `config-render.ts`: renders runnable `workerd` config from validated inputs
- `generate-config.ts`: thin CLI entry that loads inputs and writes the generated config
- `assert-json-field.ts`: small JSON assertion helper used by verification scripts
- `print-resolved-model.ts`: prints the resolved runtime model as JSON for inspection
- `print-runtime-summary.ts`: prints a compact admin/debug summary derived from the resolved runtime model
- `config.capnp`: hand-written baseline config for comparison
- `worker.ts`: small TypeScript worker entry that owns the singleton runtime instance
- `worker-runtime.ts`: runtime core for route matching, request sequencing, dispatch, and WebSocket handling
- `worker-admin.ts`: local runtime inspection handlers under `/_hardess/runtime`
- `worker-admin-contract.ts`: shared admin contract constants such as schema version and stable endpoint names
- `worker-actions.ts`: protocol action handlers for the demo HTTP actions
- `worker-response.ts`: shared JSON response helper
- `worker-types.ts`: worker-side runtime and environment types
- `ws-smoke.ts`: local WebSocket validation client
- `run.sh`: starts the local server
- `verify-lib.sh`: shared helpers for runtime smoke verification
- `verify.sh`: boots the server, sends requests, and checks responses
- `verify-binding-matrix.sh`: checks all compatibility-binding combinations at model and config level
- `verify-binding-runtime-matrix.sh`: boots all compatibility-binding variants and checks runtime behavior
- `verify-no-compat-runtime.sh`: boots the server with compatibility bindings disabled and proves runtime dispatch still works
- `verify-all.sh`: runs standard, no-compat, and negative verification as one local matrix
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

It also supports overriding `listenAddress` without editing the adapter file:

```bash
bun run ./experiment/workerd-runtime-minimal/generate-config.ts \
  --listen-address 127.0.0.1:7299
```

The runtime adapter may disable legacy compatibility bindings while keeping `HARDESS_RESOLVED_RUNTIME_MODEL` as the primary runtime contract:

```bash
./experiment/workerd-runtime-minimal/run.sh \
  --listen-address 127.0.0.1:7299 \
  --runtime-adapter ./experiment/workerd-runtime-minimal/runtime-adapter-no-compatibility-bindings.json
```

To inspect the resolved runtime model directly:

```bash
bun run ./experiment/workerd-runtime-minimal/print-resolved-model.ts
```

To inspect a shorter admin/debug summary:

```bash
bun run ./experiment/workerd-runtime-minimal/print-runtime-summary.ts
```

Once the worker is running, inspect the in-process worker runtime directly:

```bash
curl http://127.0.0.1:6285/_hardess/runtime
curl http://127.0.0.1:6285/_hardess/runtime/stats
curl http://127.0.0.1:6285/_hardess/runtime/routes
```

Those endpoints are intentionally local to this experiment. They do not expose secrets; they report singleton runtime identity, request counters, registered action IDs, and the resolved route shape currently held by the worker.
Non-`GET` requests return `405`, and unknown `/_hardess/runtime/*` paths return `404`, so the admin surface does not fall through into the normal business route table.
Admin responses currently use schema version `hardess.workerd.worker-runtime-admin.v1`.

The resolved-model printer accepts the same input overrides as the generator:

```bash
bun run ./experiment/workerd-runtime-minimal/print-resolved-model.ts \
  --assignment ./experiment/workerd-runtime-minimal/assignment.json \
  --runtime-adapter ./experiment/workerd-runtime-minimal/runtime-adapter.json \
  --planning-fragment ./experiment/workerd-runtime-minimal/planning-fragment.json \
  --protocol-package ./experiment/workerd-runtime-minimal/protocol-package.json \
  --listen-address 127.0.0.1:7299
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
- `GET /_hardess/runtime` worker runtime overview
- `GET /_hardess/runtime/stats` worker runtime counters
- `GET /_hardess/runtime/routes` worker runtime route view
- non-`GET` admin requests fail with `405`
- unknown `/_hardess/runtime/*` paths fail with `404`
- assignment-plus-adapter-plus-planning-plus-protocol-package to config generation
- compatibility-binding disablement at config-generation time

To lock in all compatibility-binding combinations:

```bash
./experiment/workerd-runtime-minimal/verify-binding-matrix.sh
```

That script currently verifies four adapter variants:

- default: `HARDESS_ROUTE_TABLE` and `HARDESS_PROTOCOL_PACKAGE`
- route-table-only
- protocol-package-only
- no compatibility bindings

To prove those same four variants also work at runtime:

```bash
./experiment/workerd-runtime-minimal/verify-binding-runtime-matrix.sh
```

To prove the runtime itself does not require compatibility bindings:

```bash
./experiment/workerd-runtime-minimal/verify-no-compat-runtime.sh
```

That script boots `workerd` with `runtime-adapter-no-compatibility-bindings.json` and checks:

- `GET /`
- `POST /echo`
- `GET /echo` negative method check
- `GET /ws` websocket upgrade and echo
- generated config omits `HARDESS_ROUTE_TABLE` and `HARDESS_PROTOCOL_PACKAGE`
- runtime responses still dispatch correctly from `HARDESS_RESOLVED_RUNTIME_MODEL`

Both verification scripts now pick an ephemeral local port automatically, so they do not depend on `127.0.0.1:6285` being free.

## Verify Negative Cases

```bash
./experiment/workerd-runtime-minimal/verify-negative.sh
```

To run the whole local verification matrix in one command:

```bash
./experiment/workerd-runtime-minimal/verify-all.sh
```

`verify-all.sh` prints per-suite durations and reports the failed suite name before exiting non-zero.

The runtime responses now also expose a small `workerRuntime` snapshot so the singleton worker instance can be observed directly during verification.

## Verification Matrix

- `verify.sh`: default adapter end-to-end HTTP, WebSocket, admin overview/stats/routes, admin 405/404 guards, generated config content, resolved-model inspection, and admin response schema version
- `verify-binding-matrix.sh`: all four compatibility-binding adapter variants at model/config level, including explicit checks that all split worker modules are embedded into generated `workerd` config
- `verify-binding-runtime-matrix.sh`: the same four compatibility-binding variants at live runtime level, including admin surface and admin negative paths
- `verify-no-compat-runtime.sh`: no-compat runtime boot path proving dispatch still works from `HARDESS_RESOLVED_RUNTIME_MODEL` alone
- `verify-negative.sh`: invalid input and CLI failure paths across config generation, resolved model printing, and runtime summary printing
- `verify-all.sh`: full local matrix runner with per-suite timing and failed-suite labeling

The script currently locks in two core failures:

- assignment references a `routeRef` that planning does not contain
- planning resolves to an `actionId` that the protocol package does not contain

For those shared validation paths, the negative script checks all three entry points:

- `generate-config.ts`
- `print-resolved-model.ts`
- `print-runtime-summary.ts`

It also locks in a few structural validation failures:

- duplicate `routeRef` inside assignment
- invalid `listenAddress` or duplicate runtime compatibility flags inside runtime adapter
- malformed `listenAddress`, unbracketed IPv6, or invalid `compatibilityDate` inside runtime adapter
- invalid CLI `--listen-address` override
- unknown, duplicate, or positional CLI arguments
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
