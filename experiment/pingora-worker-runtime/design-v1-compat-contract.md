# V1 Compatibility Contract for the Pingora Experiment

Date: 2026-04-15

## Decision

The `v1 compatibility contract` should preserve `v1` as the canonical business contract during migration, while allowing a lossless technical execution envelope inside `v2`.

This contract exists for:

- request parsing and lossless technical normalization
- worker and `serviceModule` invocation
- `env` / `ctx` shape compatibility
- public error categories
- shadow comparison rules
- preserving the external client-facing contract without making clients care about `v1/v2`

Short version:

`Keep v1 as the business truth. Normalize only for execution.`

## Why this document exists

The previous design notes already decided:

- `v2` must speak `v1` during migration
- `worker` and `serviceModule` must remain TS business units
- the compat layer must translate rather than rewrite behavior

What is still needed is a concrete contract that tells implementers:

- what exact parsed `v1` shapes exist inside `v2`
- what host-only execution metadata may be added beside them
- what the compat adapter must build before invoking TS
- what the TS side can rely on
- what counts as "equivalent enough" in shadow mode

Without this, adapter implementation will drift.

## Scope

This contract applies to:

- `v2-compat-v1`

It does not try to define the final permanent `v2-native` authoring ABI.

It defines the minimum stable compatibility shape required to:

- run `v1` modules on `v2`
- compare `v1` and `v2` behavior safely

## Contract layers

The recommended flow is:

1. parse `v1` input
2. build a host execution envelope around the parsed `v1` contract
3. invoke TS worker or TS `serviceModule`
4. collect parsed `v1`-semantic output
5. map output back to `v1`-visible external form when required

The important rule is:

- TS executes against `v1` business semantics
- host-specific metadata is additive, not semantic translation
- external `v1` shape remains the source of truth

## Parsed v1 request contract

The parsed business request inside `v2-compat-v1` should be:

```ts
type ParsedV1Request = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
  protocolVersion: "v1";
};
```

### Notes

- both `bodyText` and `bodyBytes` are allowed, but at most one should be populated as the primary source
- the compat adapter may derive `path` and `query` from `url`
- header keys should be normalized consistently
- these fields represent the canonical migration-period business contract
- no business meaning should be added or removed by technical normalization

## Parsed v1 response contract

The parsed business response inside `v2-compat-v1` should be:

```ts
type ParsedV1Response = {
  status: number;
  headers: Record<string, string>;
  bodyText?: string;
  bodyBytes?: Uint8Array;
  error?: CompatPublicError;
};
```

### Notes

- a normal success path should use `status/headers/body*`
- an error path should still end in a normalized response or a normalized public error category
- the compat adapter is responsible for restoring exact `v1` wire shape if needed
- the business meaning of response fields should remain `v1`-native

## Host execution envelope

The host may add non-business execution metadata beside the parsed `v1` contract:

```ts
type HostExecutionEnvelope = {
  requestId: string;
  traceId?: string;
  receivedAtMs: number;
  deadlineMs?: number;
  shadowMode: boolean;
  protocolVersion: "v1";
};
```

### Rules

- this envelope is host/runtime metadata, not business protocol
- it may help with scheduling, tracing, deadlines, and diffing
- it must not redefine `v1` request/response semantics

## Normalized environment contract

The compat layer should expose a stable `env` shape to TS:

```ts
type CompatEnv = {
  workerId: string;
  mode: "v2-compat-v1";
  vars: Record<string, string>;
  compat: {
    protocolVersion: "v1";
    shadowMode: boolean;
  };
};
```

### Rules

- `workerId` should remain stable and externally meaningful
- `mode` makes it explicit that the module is running under compat semantics
- compat-specific flags should live under `compat`, not pollute the business namespace

## Normalized context contract

The compat layer should expose a stable `ctx` shape to TS:

```ts
type CompatContext = {
  requestId: string;
  traceId?: string;
  deadlineMs?: number;
  waitUntil(promise: Promise<unknown>): void;
  log?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
  compat: {
    protocolVersion: "v1";
    shadowMode: boolean;
  };
};
```

### Rules

- `ctx` should stay capability-oriented
- transport/runtime internals should not leak directly into business code
- compat-specific metadata should be explicit under `ctx.compat`

## Worker invocation contract

The normalized worker invocation should conceptually be:

```ts
type CompatWorkerHandler = (
  request: ParsedV1Request,
  env: CompatEnv,
  ctx: CompatContext,
) => Promise<ParsedV1Response> | ParsedV1Response;
```

### Requirements

- the compat adapter must be able to invoke existing `v1` worker logic through `v1` semantics
- TS remains the execution surface
- the adapter may wrap legacy exports, but should not change where business code runs
- any additional host metadata belongs in `ctx`, not in a redefined business request shape

## ServiceModule invocation contract

Because `serviceModule` often implies richer lifecycle than a single request, the compat contract should be split into:

- module lifecycle
- request/event invocation

A minimal conceptual shape is:

```ts
type CompatServiceModule = {
  init?(env: CompatEnv): Promise<void> | void;
  handle?(
    request: ParsedV1Request,
    env: CompatEnv,
    ctx: CompatContext,
  ): Promise<ParsedV1Response> | ParsedV1Response;
  dispose?(): Promise<void> | void;
};
```

### Requirements

- `serviceModule` logic must still execute in TS
- `init` and `dispose` are lifecycle hooks, not permission for Rust to absorb business behavior
- if `v1` has richer hook shapes, the adapter should translate them into this normalized model or an extension of it

## Public error contract

The public error surface in compat mode should be category-based.

The single machine-readable source for public codes in this experiment is:

- `contracts/public-errors.json`

Recommended categories:

```ts
type CompatPublicErrorCategory =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream_timeout"
  | "execution_timeout"
  | "temporarily_unavailable"
  | "shutdown_draining"
  | "internal_error"
  | "network_lost";

type CompatPublicError = {
  category: CompatPublicErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  status: number;
};
```

### Rules

- internal host/runtime failures must map into these public categories
- `code` should remain stable for SDKs and dashboards
- categories should be small and durable
- not every internal failure deserves a distinct public code
- canonical `status` and `retryable` should come from the shared error contract, not drift per adapter

## Error mapping principles

Recommended mapping direction:

- host overload -> `temporarily_unavailable`
- shutdown drain rejection -> `shutdown_draining`
- worker execution timeout -> `execution_timeout`
- upstream timeout -> `upstream_timeout`
- unknown internal failures -> `internal_error`

The goal is:

- stable external semantics
- hidden internal implementation variation

## Observability contract

Compat mode should preserve a small normalized observability record per invocation:

```ts
type CompatInvocationRecord = {
  requestId: string;
  workerId: string;
  mode: "v2-compat-v1";
  status?: number;
  publicErrorCode?: string;
  publicErrorCategory?: CompatPublicErrorCategory;
  latencyMs: number;
  timedOut: boolean;
  shadowMode: boolean;
};
```

This record is not the entire telemetry model.

It is the minimum comparable unit between:

- `v1`
- `v2-compat-v1`

## Shadow diff contract

Shadow mode should not require exact byte-for-byte identity for every case.

Instead, comparisons should be layered.

### Level 1: route outcome equivalence

Compare:

- status code
- public error category/code
- redirect location if any

This is the highest-priority diff layer.

### Level 2: body equivalence

Compare:

- exact body when practical
- or normalized semantic body when exact formatting differs but meaning should match

Recommended policy:

- default to exact comparison for plain text / JSON with stable formatting
- allow normalized JSON comparison where ordering/formatting is irrelevant

### Level 3: header equivalence

Compare:

- required business headers
- selected compatibility headers

Do not fail shadow diff on:

- unstable transport headers
- expected runtime-specific trace headers

### Level 4: latency comparison

Compare:

- absolute latency
- relative latency delta

Latency should be observed and classified, not treated as a semantic mismatch by default.

## Shadow diff result categories

Recommended result categories:

- `match`
- `acceptable_difference`
- `semantic_mismatch`
- `error_mismatch`
- `timeout_mismatch`

### Meaning

- `match`: behavior is effectively the same
- `acceptable_difference`: non-critical differences such as harmless headers or formatting
- `semantic_mismatch`: different business outcome
- `error_mismatch`: different public error code/category
- `timeout_mismatch`: one side timed out or crossed a timeout class differently

This classification is more useful than a single boolean pass/fail.

## Compatibility guarantees

The compat contract should guarantee:

- TS remains the business execution surface
- parsed `v1` business shapes remain canonical inside compat mode
- host-only execution metadata stays additive rather than semantic
- public error categories remain stable enough for SDKs and rollout tooling
- shadow diff uses explicit comparison rules rather than ad hoc judgment

The compat contract does not guarantee:

- identical internal implementation
- permanent preservation of every legacy private quirk
- zero latency difference

## Red lines

The compat contract should be considered broken if implementation requires:

- Rust reimplementation of worker business logic
- Rust reimplementation of `serviceModule` business logic
- manual per-module business rewrites to preserve baseline behavior
- shadow comparisons that cannot explain differences in normalized public terms

## Recommended next implementation step

After this contract, the next useful implementation task is:

- define the actual Rust-side structs that correspond to:
  - `ParsedV1Request`
  - `ParsedV1Response`
  - `CompatEnv`
  - `CompatContext`
  - `HostExecutionEnvelope`
  - `CompatPublicError`
  - `CompatInvocationRecord`

And then:

- build a tiny TS invocation shim in the experiment runtime that uses those exact shapes

## Final recommendation

Do not let compat mode become a vague promise.

Make it a real contract:

- parsed `v1` request/response plus host execution envelope
- stable public error categories
- stable TS invocation surface
- explicit shadow diff rules

That is the minimum shape required to turn `v1 compatibility` into something implementable.
