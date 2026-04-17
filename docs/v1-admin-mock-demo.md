# v1 Admin Mock Demo

This demo wires the current `v1` control-plane slice end to end:

- mock admin HTTP service
- runtime host-agent reconcile loop
- artifact manifest fetch
- worker artifact staging
- live HTTP pipeline apply
- per-host desired-state projection
- global topology snapshot projection (`membership` + `placement`)

## Start The Demo

Terminal 1:

```bash
bun run demo:upstream
```

Terminal 2:

```bash
bun run demo:admin
```

Optional:

```bash
ADMIN_DEMO_SHARED_DEPLOYMENT_REPLICAS=2 bun run demo:admin
```

That changes how many hosts receive the shared deployment.

Terminal 3, runtime `host-demo-a`:

```bash
ADMIN_BASE_URL=http://127.0.0.1:9100 \
ADMIN_HOST_ID=host-demo-a \
ADMIN_ARTIFACT_ROOT_DIR=.hardess-admin-artifacts-a \
PORT=3000 \
bun run dev
```

Terminal 4, runtime `host-demo-b`:

```bash
ADMIN_BASE_URL=http://127.0.0.1:9100 \
ADMIN_HOST_ID=host-demo-b \
ADMIN_ARTIFACT_ROOT_DIR=.hardess-admin-artifacts-b \
PORT=3001 \
bun run dev
```

Each runtime will:

- register the host to the mock admin
- fetch `DesiredHostState`
- fetch `ArtifactManifest`
- stage the remote worker source plus `deno.json` / `deno.lock`
- apply the shared HTTP pipeline only if this host is selected by the deployment replica placement
- apply one host-specific HTTP pipeline derived from its own `hostId`
- stage and activate one demo `service_module` artifact through the runtime
  WebSocket protocol registry
- update its cluster peer scope from `topology.membership`

## Verify The Flow

Shared deployment on both hosts:

```bash
curl -s \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/shared | jq .

curl -s \
  -H 'authorization: Bearer demo:bob' \
  http://127.0.0.1:3001/demo/shared | jq .
```

Expected:

- with the default mock setting `sharedDeploymentReplicas=1`, only the lexicographically first registered host gets `/demo/shared`
- in the default two-host demo, `host-demo-a` serves `/demo/shared`
- `host-demo-b` should not have that route
- upstream echoes `x-hardess-admin-scope=shared`

Host-specific deployment projection:

```bash
curl -s \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/hosts/host-demo-a | jq .

curl -s \
  -H 'authorization: Bearer demo:bob' \
  http://127.0.0.1:3001/demo/hosts/host-demo-b | jq .
```

Expected:

- runtime `host-demo-a` serves `/demo/hosts/host-demo-a`
- runtime `host-demo-b` serves `/demo/hosts/host-demo-b`
- upstream echoes `x-hardess-admin-scope=host`

Cross-check that projection is host-local:

```bash
curl -i \
  -H 'authorization: Bearer demo:bob' \
  http://127.0.0.1:3001/demo/shared

curl -i \
  -H 'authorization: Bearer demo:alice' \
  http://127.0.0.1:3000/demo/hosts/host-demo-b
```

Expected:

- runtime on `3001` should not have the shared deployment when `sharedDeploymentReplicas=1`
- runtime on `3000` should not have the `host-demo-b` route
- the request should fail with the normal "no pipeline" behavior

## Simulate A Rollout

Increase the shared deployment from `1` replica to `2`:

```bash
curl -s \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"sharedDeploymentReplicas":2}' \
  http://127.0.0.1:9100/__admin/mock/rollouts/shared-deployment | jq .
```

Then inspect desired state again:

```bash
curl -s \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"hostId":"host-demo-b"}' \
  http://127.0.0.1:9100/v1/admin/hosts/desired | jq .
```

Expected:

- the rollout response returns a higher `revisionToken`
- `host-demo-b` now receives the shared deployment assignment
- the host-local desired-state `revision` changes from `demo-rev:1:*` to `demo-rev:2:*`
- on the next host-agent poll, runtime `host-demo-b` should converge and start serving `/demo/shared`

Scale back down from `2` replicas to `1`:

```bash
curl -s \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"sharedDeploymentReplicas":1}' \
  http://127.0.0.1:9100/__admin/mock/rollouts/shared-deployment | jq .
```

Expected rollout states:

- for replica scale-down, desired state can immediately drop `host-demo-b` if
  the remaining owner set still satisfies the rollout availability budget
- if `host-demo-b` still reports the old shared assignment as `active`, the rollout summary will show `desiredHosts=1` but `activeHosts=2`
- once `host-demo-b` reports that assignment as `draining`, the rollout summary shows `drainingHosts=1`
- once `host-demo-b` stops reporting the shared assignment, the rollout summary returns to `desiredHosts=1`, `activeHosts=1`, `drainingHosts=0`

## Inspect Mock Admin State

```bash
curl http://127.0.0.1:9100/__admin/mock/state | jq .
```

That endpoint shows:

- registered hosts
- desired host states currently projected for each host
- last observed host states reported by each runtime
- artifact manifests currently served by the mock admin
- the shared topology snapshot currently attached to host desired state
- rollout summary aggregated by deployment, including `desiredHosts`, `activeHosts`, `pendingHosts`, `drainingHosts`, and per-host observed state

## Inspect Staged Artifacts

```bash
find .hardess-admin-artifacts-a -maxdepth 3 -type f | sort
find .hardess-admin-artifacts-b -maxdepth 3 -type f | sort
```

You should see the staged worker source and companion project files under each manifest cache directory.

## Demo Shape

The mock admin serves:

- `POST /v1/admin/hosts/register`
- `POST /v1/admin/hosts/heartbeat`
- `POST /v1/admin/hosts/desired`
- `POST /v1/admin/hosts/observed`
- `POST /v1/admin/artifacts/manifest`
- `GET /artifacts/demo-http-worker.ts`
- `GET /artifacts/demo-host-worker.ts`
- `GET /artifacts/demo-chat-service-module.ts`
- `GET /artifacts/deno.json`
- `GET /artifacts/deno.lock`
- `GET /__admin/mock/state`
- `POST /__admin/mock/rollouts/shared-deployment`

Current fixed control-plane shape:

- one shared `http_worker` deployment at `/demo/shared`, with replica count controlled by the mock admin
- one host-scoped `http_worker` deployment projected as `/demo/hosts/<hostId>`
- one all-host `service_module` deployment delivered through the same desired-state
  and artifact-manifest path
- three artifact manifests with remote source digests
- the same global deployment set, but different `DesiredHostState` per host
- the same `topology.membership` and `topology.placement` snapshot is attached to every host projection for that revision
- `topology.placement.routes` carries `pathPrefix -> ownerHostIds`, so a host can
  internally forward HTTP traffic to the correct owner when that route is not
  local
- the same route ownership can also be used to internally forward business
  WebSocket upgrade traffic to the correct owner host
- the demo `service_module` shows the non-HTTP artifact path too: runtime stages
  the module source, validates the explicit `{ protocol, version, actions }`
  export, and registers it into the WebSocket server registry
- when a `service_module` assignment is removed, runtime keeps it observable as
  `draining` for a bounded local grace window before final unregister, so the
  mock rollout page can show scale-down progress for long-lived WebSocket work
- the current mock placement strategy is still intentionally small, but no
  longer just `sort(hostId)`: it now filters out draining / unschedulable /
  over-capacity hosts, honors deployment scheduling metadata, and prefers
  sticky owners to reduce churn
- the shared deployment also uses a minimal gradual rollout policy:
  `batchSize=1`, `maxUnavailable=0`; when ownership must move to a different
  host, the mock admin first expands the desired owner set, then removes the
  previous owner after the replacement host reports `ready` or `active`
- rollout progress is derived from `ObservedHostState.assignmentStatuses`, so the mock state page can show "desired but not yet active" hosts during convergence
- scale-down progress is also visible there, including the "no longer desired but still draining" phase on the removed host

This is intentionally still small. The point is to make the `v1` boundary concrete:

- admin owns global deployment intent
- admin owns slow-changing topology
- admin projects host-local desired state
- runtime only reconciles its own assignments, narrows WS locate scope from
  topology, internally forwards non-local HTTP / business WS traffic, and
  reports which topology revision it has applied
