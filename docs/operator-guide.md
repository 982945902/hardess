# Operator Guide

This guide covers the current runtime workflow: startup, health checks, metrics export, alert thresholds, static multi-node routing, release-gate verification, and shutdown expectations. For the current measured local envelope, also see [local-release-baseline.md](local-release-baseline.md).

## Core Commands

```bash
bun run dev
bun run verify
bun run release:gate
bun run release:gate:cluster:high
bun run clean
```

## Runtime Env Vars

HTTP / process:

- `PORT`: legacy single-listener port, default `3000`
- `BUSINESS_PORT`: business listener port; if unset, falls back to `PUBLIC_PORT`, then `PORT`
- `CONTROL_PORT`: optional control listener port for `__admin/*`, `__cluster/*`, and node-to-node forward entrypoints; if unset, the runtime stays single-listener
- `PUBLIC_PORT`: legacy alias for `BUSINESS_PORT`
- `INTERNAL_PORT`: legacy alias for `CONTROL_PORT`
- `CONFIG_MODULE_PATH`: config module path, default `./config/hardess.config.ts`
- `SHUTDOWN_DRAIN_MS`: time to stay not-ready before stopping the server, default `250`
- `SHUTDOWN_TIMEOUT_MS`: hard stop timeout, default `10000`
- `WS_SHUTDOWN_GRACE_MS`: websocket drain grace after shutdown starts, default `3000`

Optional listener path policy:

- `BUSINESS_ALLOWED_PATH_PREFIXES`: comma-separated business-listener path prefixes
- `CONTROL_ALLOWED_PATH_PREFIXES`: comma-separated control-listener path prefixes
- `PUBLIC_ALLOWED_PATH_PREFIXES`: legacy alias for `BUSINESS_ALLOWED_PATH_PREFIXES`
- `INTERNAL_ALLOWED_PATH_PREFIXES`: legacy alias for `CONTROL_ALLOWED_PATH_PREFIXES`

Listener policy semantics:

- if a listener path policy env is unset, that listener stays unrestricted
- if set, only matching path prefixes are exposed on that listener
- `__admin/*` and `__cluster/*` are reserved control-only routes and are never exposed on the business listener, regardless of listener path policy
- the recommended dual-port shape is:
  - business listener: business HTTP paths plus `/ws`
  - control listener: `/__admin` plus `/__cluster`

Naming note:

- `business/control` is the runtime semantic split
- whether those listeners are actually public or private is a deployment concern handled by Swarm / LB / network policy

HTTP proxy timeout semantics:
- `connectTimeoutMs`: budget until Hardess gets the upstream response
- `responseTimeoutMs`: budget to read the upstream response body after headers are available
- when a pipeline sets `downstream.websocket=true`, websocket upgrade requests on that matched path are proxied to the downstream origin instead of using the normal HTTP fetch path
- for upstream websocket proxying, `connectTimeoutMs` still applies to the upstream websocket connect handshake; `responseTimeoutMs` remains HTTP-response specific

WebSocket ingress / egress:

- `WS_HEARTBEAT_INTERVAL_MS`: heartbeat interval
- `WS_STALE_AFTER_MS`: stale timeout
- `WS_MAX_CONNECTIONS`: total connection cap
- `WS_MAX_CONNECTIONS_PER_PEER`: per-peer cap
- `WS_RATE_LIMIT_WINDOW_MS`: inbound rate-limit window
- `WS_RATE_LIMIT_MAX_MESSAGES`: inbound rate-limit quota
- `WS_OUTBOUND_MAX_QUEUE_MESSAGES`: per-connection outbound queue depth cap
- `WS_OUTBOUND_MAX_QUEUE_BYTES`: per-connection outbound queue bytes cap
- `WS_OUTBOUND_MAX_SOCKET_BUFFER_BYTES`: socket buffered-amount cap before closing the connection
- `WS_OUTBOUND_BACKPRESSURE_RETRY_MS`: retry delay after Bun reports websocket backpressure

Metrics / alerts:

- `METRICS_SINK`: `windowed` or `inmemory`, default `windowed`
- `METRICS_MAX_TIMINGS_PER_METRIC`: retained timing samples per metric in `windowed` mode
- `PROMETHEUS_METRIC_PREFIX`: exporter metric prefix, default `hardess`
- `ALERT_WINDOW_MS`: alert evaluation window, default `30000`
- `ALERT_HTTP_ERRORS`
- `ALERT_UPSTREAM_TIMEOUTS`
- `ALERT_UPSTREAM_UNAVAILABLE`
- `ALERT_WORKER_ERRORS`
- `ALERT_WS_ERRORS`
- `ALERT_WS_BACKPRESSURE_EVENTS`
- `ALERT_WS_RATE_LIMIT_EXCEEDED`
- `ALERT_WS_HEARTBEAT_TIMEOUTS`
- `ALERT_HTTP_REQUEST_P99_MS`
- `ALERT_UPSTREAM_P99_MS`
- `ALERT_WORKER_P99_MS`

Cluster / multi-node:

- `NODE_ID`: current runtime node id, default `local`
- `CLUSTER_PEERS_JSON`: static peer list JSON, for example `[{"nodeId":"node-b","baseUrl":"http://127.0.0.1:3101"}]`
- `CLUSTER_TRANSPORT`: `ws` or `http`, default `ws` in the runtime server entrypoint
- `CLUSTER_SHARED_SECRET`: optional shared secret for control-plane cluster locate requests and WS channel handshake
- `CLUSTER_REQUEST_TIMEOUT_MS`: timeout for cluster locate and cross-node request/response operations, default `10000`
- `CLUSTER_OUTBOUND_MAX_QUEUE_MESSAGES`: per-node internal WS channel outbound queue cap, default `16384`
- `CLUSTER_OUTBOUND_BACKPRESSURE_RETRY_MS`: retry delay after control-plane cluster WS backpressure, default `10`
- `CLUSTER_LOCATOR_CACHE_TTL_MS`: remote peer-location cache TTL on each node

Admin / host-agent control plane:

- `ADMIN_BASE_URL`: when set, enable the optional host-agent reconcile loop against the admin service
- `ADMIN_BEARER_TOKEN`: optional bearer token for admin HTTP requests
- `ADMIN_HOST_ID`: admin-facing host id; defaults to `NODE_ID`, then `local`
- `HOST_GROUP_ID`: optional host group identity; one runtime host belongs to exactly one group, and omitting it places the host in the default group
- `HARDESS_RUNTIME_VERSION`: runtime version string reported during host registration, default `v1`
- `ADMIN_BUSINESS_BASE_URL`: optional business base URL advertised in host registration; falls back to `ADMIN_PUBLIC_BASE_URL`
- `ADMIN_CONTROL_BASE_URL`: optional control base URL advertised in host registration; falls back to `ADMIN_INTERNAL_BASE_URL`
- `ADMIN_PUBLIC_BASE_URL`: legacy alias for `ADMIN_BUSINESS_BASE_URL`
- `ADMIN_INTERNAL_BASE_URL`: legacy alias for `ADMIN_CONTROL_BASE_URL`
- `ADMIN_STATIC_LABELS_JSON`: optional JSON object of static host labels
- `ADMIN_STATIC_CAPABILITIES`: optional comma-separated static host capabilities; defaults to `http_worker,service_module`
- `ADMIN_STATIC_CAPACITY_JSON`: optional JSON object of static host capacity such as `maxHttpWorkerAssignments`
- `ADMIN_REGISTRATION_DYNAMIC_FIELDS_JSON`: optional JSON object attached to host registration dynamic fields
- `ADMIN_OBSERVED_DYNAMIC_FIELDS_JSON`: optional JSON object attached to observed host-state dynamic fields
- `ADMIN_POLL_AFTER_MS`: optional default host-agent poll interval override
- `ADMIN_RETRY_POLL_AFTER_MS`: optional retry poll interval after reconcile failure
- `ADMIN_ARTIFACT_ROOT_DIR`: optional local cache root for admin-delivered artifacts; default `.hardess-admin-artifacts`
- `SERVICE_MODULE_DRAIN_GRACE_MS`: optional local grace drain window for removed `service_module` assignments; default `3000`

Current implementation note:

- the optional host-agent loop is now wired into runtime startup when `ADMIN_BASE_URL` is set
- when `HOST_GROUP_ID` is set, runtime registers that host group to admin and uses it as the boundary for group-local HTTP / WS forwarding and cluster locate
- the admin SDK, HTTP transport, mock transport, shared protocol types, and runtime-side reconcile loop all exist
- `http_worker` assignments now compile into live `HardessConfig` pipelines and are applied through the runtime config store
- for `http_worker`, the current artifact path treats `ArtifactManifest.source.uri` as the worker source file and stages it under `ADMIN_ARTIFACT_ROOT_DIR`
- `service_module` assignments now stage their module source under `ADMIN_ARTIFACT_ROOT_DIR`, load the staged entry, validate the explicit `{ protocol, version, actions }` export shape, and register or replace those actions in the runtime WebSocket protocol registry
- when `packageManager.kind=\"bun\"` and `packageJson` is present, runtime also runs `bun install` in the staged artifact directory before activation
- when `packageManager` declares Bun or Deno project files, runtime stages those files into the same local artifact directory using the worker source location as the resolution base
- Deno project files are currently staged only; the Bun host runtime does not yet run a Deno-native prepare step
- Bun artifact prepare now emits `artifact.prepare_ok`, `artifact.prepare_error`, `artifact.prepare_cache_hit`, `artifact.prepare_cache_miss`, and `artifact.prepare_ms`
- remote artifact cache reuse is only considered stable when the main worker source carries a `digest`; without that, runtime will restage remote sources instead of trusting cached metadata

## Verification Env Vars

Load script namespaces:

- `HTTP_LOAD_*`: HTTP load inputs; prefer these over legacy aliases such as `BASE_URL`, `CONCURRENCY`, and `REQUESTS`
- `WS_LOAD_*`: single-node websocket load inputs; prefer these over legacy aliases such as `WS_URL`, `SENDER_COUNT`, and `MESSAGES_PER_SENDER`
- `CLUSTER_WS_LOAD_*`: cross-node websocket load inputs
- `TOXI_*`: Toxiproxy setup and weak-network profile inputs

Cluster benchmark:

- `BENCH_CLUSTER_*`: stair-step benchmark sizing, ports, profile selection, and optional SLO thresholds

Single-node websocket benchmark:

- `BENCH_WS_*`: single-node websocket stair-step benchmark sizing, profile selection, runtime tuning, and optional SLO thresholds

Single-node release gate:

- `RELEASE_GATE_*`: single-node gate ports, sizing, readiness timing, metrics mode, an optional layered `RELEASE_GATE_SLO_PROFILE`, and optional HTTP / WS SLO thresholds, including optional `ws.egress_overflow` / `ws.egress_backpressure` guards

Cluster release gate:

- `CLUSTER_RELEASE_GATE_*`: cluster gate profile, ports, shared-secret wiring, sizing, readiness timing, metrics mode, an optional layered `CLUSTER_RELEASE_GATE_SLO_PROFILE`, and optional cluster SLO thresholds
- `CLUSTER_RELEASE_GATE_LISTENER_MODE`: `single` or `dual`; `dual` runs client WS on business ports and admin/cluster traffic on control ports
- `CLUSTER_RELEASE_GATE_CONTROL_PORT_A` / `CLUSTER_RELEASE_GATE_CONTROL_PORT_B`: optional explicit control ports when the cluster release gate runs in `dual` mode
- `CLUSTER_RELEASE_GATE_INTERNAL_PORT_A` / `CLUSTER_RELEASE_GATE_INTERNAL_PORT_B`: legacy aliases for the control-port envs above

Cluster benchmark:

- `BENCH_CLUSTER_LISTENER_MODE`: `single` or `dual`; `dual` benchmarks the split-path shape where client WS uses business ingress and node-to-node/admin traffic uses control listeners

Detailed per-variable examples and the full verification env reference live in [load-testing.md](load-testing.md).

## Health And Metrics

- `GET /__admin/health`: liveness view
- `GET /__admin/ready`: readiness view; returns `503` after shutdown starts
- `GET /__admin/metrics`: counter/timing snapshot from the configured metrics sink
- `GET /__admin/metrics/prometheus`: Prometheus scrape endpoint
- when admin host-agent mode is enabled, runtime also reports a compact metrics summary in `ObservedHostState.dynamicState.dynamicFields.metrics` so control-plane heartbeat/report traffic can carry counters and timing counts without shipping raw timing arrays
- `GET /__admin/cluster/peers`: static cluster peer view for the current node

Recommended minimum checks:

- readiness must be `200` before receiving traffic
- readiness must flip to `503` before process exit during graceful shutdown
- websocket upgrades should stop once readiness drops, while existing websocket sessions should only keep protocol-level shutdown cleanup such as `pong` / `handleAck`
- monitor `http.error`, `http.upstream_timeout`, `http.upstream_unavailable`, `worker.run_error`, `ws.error`, `ws.egress_backpressure`, `ws.heartbeat_timeout`
- when debugging worker side effects, also inspect `worker.wait_until_error`
- when debugging best-effort fanout behavior, inspect `ws.partial_delivery` and `ws.delivery_target_error`
- when debugging websocket failures, also inspect per-code counters such as `ws.error_code.route_no_recipient` or `ws.error_code.route_peer_offline`

External observability bootstrap:

- sample Prometheus scrape config: [../docker/prometheus.yml](../docker/prometheus.yml)
- sample Grafana dashboard: [grafana-hardess-overview.dashboard.json](grafana-hardess-overview.dashboard.json)
- cluster transport counters now include `cluster.message_in`, `cluster.message_out`, `cluster.egress_backpressure`, `cluster.egress_overflow`, `cluster.request_timeout`, `cluster.auth_rejected`, and `cluster.channel_closed`

## Release Gate

`bun run release:gate` currently does all of the following automatically:

- starts a dedicated demo upstream and runtime instance on isolated ports
- waits for the upstream and runtime to answer before sending smoke/load traffic
- runs HTTP smoke
- runs HTTP load
- runs WebSocket load
- sends `SIGTERM` and verifies readiness drops to `503` before runtime exit

Useful overrides live in the `Verification Env Vars` section above.

## Static Multi-Node Routing

The current multi-node baseline is static-peer based:

- each node keeps local websocket connections in-memory
- `PeerLocator` expands recipients from local memory plus cached remote lookups
- peer locate uses control HTTP `POST /__cluster/locate`
- remote `deliver` and `handleAck` use a long-lived control websocket channel at `GET /__cluster/ws`
- `CLUSTER_TRANSPORT=http` keeps the older pure-HTTP transport available as a fallback path
- when `CLUSTER_TRANSPORT=ws`, per-request fallback to the control HTTP endpoints is now used if the cluster WS channel is temporarily unavailable or its outbound queue overflows
- in dual-port deployments, cluster peer `baseUrl` entries should point to the control listener, not the business listener

Current boundary:

- this is a static cluster peer list, not automatic membership or gossip
- there is no durable distributed state, only per-node in-memory connection state plus short peer-location caches
- rollout, retries, channel lifecycle, and topology management still need deployment-specific conventions

High-load benchmark workflow:

- use `bun run bench:ws:high` when you want to calibrate single-node websocket egress / backpressure instead of relying on one short `load:ws` sample
- use `bun run bench:ws:local` when you want the tuned single-node runtime profile plus the current built-in local SLO envelope in one command
- the tuned single-node benchmark resolves its runtime defaults from an internal `high` profile, so the benchmark is less likely to stop at the default websocket policy guard before you can observe queue / backpressure behavior
- then override only `BENCH_WS_SCENARIOS` and `BENCH_WS_RUNS` to probe the next single-node boundary
- if you want an immediately usable pass/fail envelope instead of hand-writing thresholds, set `BENCH_WS_SLO_PROFILE=local|high`
- use `bun run bench:cluster:high` as the default tuned profile before concluding the transport itself is the bottleneck
- use `bun run bench:cluster:local` when you want the tuned cluster runtime profile plus the current built-in local cluster SLO envelope in one command
- the tuned benchmark and cluster release-gate scripts now resolve their runtime defaults from an internal `high` profile instead of a long inline env chain
- then override only `BENCH_CLUSTER_SCENARIOS` and `BENCH_CLUSTER_RUNS` to probe the next boundary
- if you want the same kind of layered pass/fail envelope for cluster runs, set `BENCH_CLUSTER_SLO_PROFILE=local|high` or `CLUSTER_RELEASE_GATE_SLO_PROFILE=local|high`
- if you need a release-style boundary instead of a raw completion boundary, also set SLO envs such as `BENCH_CLUSTER_MAX_HANDLE_ACK_P99_MS`, `BENCH_CLUSTER_MAX_RECV_ACK_P99_MS`, `BENCH_CLUSTER_MAX_HTTP_FALLBACK_COUNT`, `BENCH_CLUSTER_MAX_ROUTE_CACHE_RETRY_COUNT`, and `BENCH_CLUSTER_MAX_SYS_ERR_COUNT`
- treat `highestFullyStableMessagesPerSender` as "eventual completion capacity" and `highestSloPassingMessagesPerSender` as the more meaningful "healthy operating tier"
- if a run times out, inspect the returned `clusterWsLoadSummary.pendingSamples`, `topPendingSenders`, and cluster counters before changing transport design

Release-gate interpretation:

- by default the release gates still require basic correctness only: no transport errors, no `sys.err`, full ack completion, and graceful-shutdown readiness behavior
- `RELEASE_GATE_SLO_PROFILE=local|high` and `CLUSTER_RELEASE_GATE_SLO_PROFILE=local|high` now apply built-in latency / degradation envelopes without changing the old default behavior
- `bun run release:gate:local` and `bun run release:gate:cluster:local` are the shortest local "healthy baseline" checks
- when single-node WS SLO envs are set, the gate can now also fail on `ws.egress_overflow` or `ws.egress_backpressure` counters from the runtime metrics delta instead of only checking ack latency and `sys.err`
- if you set the new gate SLO envs, the release gate also fails on excessive p99 latency or cluster degradation counters even when the run eventually drains

## Close Codes

- `4400`: protocol / payload invalid
- `4401`: auth invalid / expired / revoked
- `4403`: ACL denied
- `4429`: rate limit or connection quota exceeded
- `4508`: websocket backpressure or outbound overflow guard fired

## Current Limits

- external production `AuthProvider` wiring is still intentionally not part of this guide
- dashboard rollout and Prometheus/Grafana hosting still stay deployment-specific
- cluster membership is static; there is no leader election, gossip, or shared distributed registry yet
