# V1 to V2 Compatibility Design for the Pingora Experiment

Date: 2026-04-15

## Decision

The future `Hardess v2` should treat `v1 compatibility` as a hard requirement for the migration phase.

That means `v2` should support both:

- running existing `v1` worker / serviceModule logic through a compatibility layer
- protocol interoperability between `v1` and `v2` instances during rollout
- preserving TypeScript as the required business-runtime surface for `worker` and `serviceModule`
- preserving the existing external client contract while `v1/v2` remains an internal server-side distinction

Short version:

`v2 must be able to speak v1 before it asks production traffic to trust it.`

Another hard rule:

`v2 must not require business logic to be rewritten in Rust.`

Migration-period contract rule:

`v1 protocol and behavior remain the canonical business contract during migration.`

## Why this matters

If `v2` is only "better architecture" but cannot coexist with `v1`, the rollout cost becomes too high.

That creates avoidable risk:

- hard cutovers
- difficult rollback
- duplicated module development
- inability to shadow or canary in production

The safer migration shape is:

- `v1` remains the production baseline
- `v2` can run beside it
- `v2` can consume the same inputs
- `v2` can be validated under real traffic before taking ownership

This is the right migration posture.

Just as important:

- `worker` remains a TypeScript business unit
- `serviceModule` remains a TypeScript business unit
- Rust remains the host/kernel, not the business-authoring surface
- client code should not need to know or care whether the backend implementation is `v1` or `v2`

## Compatibility goals

### Goal 1: protocol interoperability

`v1` and `v2` instances should be able to coexist in the same deployment topology.

This enables:

- mixed clusters
- canary rollout
- shadow traffic
- rollback without global format changes

This is the highest-priority compatibility goal.

This also means:

- `v1` protocol remains the canonical migration-period contract
- `v2-compat-v1` should parse and emit `v1` semantics directly
- normalization is allowed only as a lossless technical step for execution/observability

### Goal 2: module compatibility

Existing `v1` worker and `serviceModule` logic should be able to run on `v2` with:

- no change when possible
- very thin adaptation when unavoidable

This enables:

- low-cost migration
- fewer parallel codepaths
- realistic production testing

This goal explicitly does **not** mean:

- "translate business logic into Rust"
- "keep TS only for light scripting"
- "move `serviceModule` logic into the host layer"

### Goal 3: operational compatibility

Even when implementation details differ, operations should still remain understandable.

That includes:

- similar error semantics
- similar timeout behavior where externally visible
- similar shutdown behavior where externally visible
- similar observability field meanings

## Explicit non-goals

At least for the migration phase, `v2` does not need:

- internal implementation parity with `v1`
- identical performance characteristics in every codepath
- identical internal module loading internals
- permanent support for every legacy edge case
- Rust as an application-business authoring model

The goal is safe migration, not permanent architectural hostage-taking.

## Recommended architecture

The right split is:

- `v2 core`
- `compat-v1 layer`

Not:

- mixing `v1` assumptions directly into the `v2 core`
- asking product/business code to move into Rust
- inventing a second migration-period business contract inside `v2`

### V2 core should own

- Pingora/Rust ingress
- runtime lifecycle
- request execution
- shutdown/draining
- metrics/tracing foundation
- future native `v2` APIs

It should not own:

- business routing rules that belong to workers
- business `serviceModule` logic
- application handlers that require product engineers to write Rust

### Compat-v1 layer should own

- `v1` protocol codec
- `v1` config translation
- `v1` worker / `serviceModule` adapter
- `v1` error mapping
- `v1` observability field mapping

This keeps the new architecture clean while still allowing safe adoption.

Important boundary:

- the compat layer may normalize `v1` messages for technical execution
- it must not redefine `v1` business semantics into a second internal protocol contract

### TypeScript business constraint

For this project, the language boundary should be treated as an architectural constraint:

- `worker` logic runs in TS
- `serviceModule` logic runs in TS
- `v2-native` feature evolution still targets TS as the authoring surface

Rust is allowed to provide:

- host APIs
- runtime services
- lifecycle control
- transport primitives

Rust is not allowed to become:

- the default business implementation language
- the required rewrite target for migration
- the place where existing module behavior gets re-authored

## Compatibility modes

The recommended runtime modes are:

- `v2-native`
- `v2-compat-v1`

### `v2-native`

Use the future `v2` model directly.

This mode is for:

- new capabilities
- new ABI
- new protocols

### `v2-compat-v1`

Use `v2` infrastructure but preserve `v1`-visible behavior as much as possible.

This mode is for:

- production migration
- shadow validation
- canary rollout
- rollback-friendly deployment

This mode should exist explicitly, not implicitly.

## Compatibility matrix

The migration should be judged against a concrete matrix.

### 1. Northbound protocol compatibility

Questions:

- can `v2` parse and emit `v1` protocol frames/messages?
- can `v1` peers talk to `v2` without feature negotiation failure?
- are version/capability mismatches explicit?

Requirement:

- `v2` must support a `v1` wire/protocol mode during migration
- parsing and normalization should preserve `v1` business semantics rather than reinterpret them

### 2. Worker ABI compatibility

Questions:

- can a `v1` worker entrypoint run on `v2`?
- are `env`, `ctx`, and request/response shapes still accepted?
- are lifecycle hooks preserved where externally visible?

Requirement:

- `v2-compat-v1` should provide an adapter that preserves `v1` invocation shape
- this compatibility must preserve TS execution, not replace it with Rust business handlers

### 3. `serviceModule` compatibility

Questions:

- can current `serviceModule` definitions load into `v2`?
- if not directly, can they be translated deterministically?
- does configuration meaning remain stable?

Requirement:

- `serviceModule` compatibility should be designed as an adapter, not manual rewrites by default
- `serviceModule` semantics should still execute inside the TS runtime surface

### 4. Error compatibility

Questions:

- do externally visible error codes remain stable?
- are legacy client-facing errors still understandable?
- are internal `v2` errors hidden behind stable public categories?

Requirement:

- the public error surface should be compatibility-mapped

### 5. Timeout and shutdown compatibility

Questions:

- do callers still observe the same broad timeout classes?
- are draining/restart behaviors still understandable to existing clients/SDKs?

Requirement:

- differences are allowed internally, but externally visible semantics must be deliberate and documented

### 6. Observability compatibility

Questions:

- can dashboards compare `v1` and `v2` side-by-side?
- do key counters and dimensions still mean roughly the same thing?
- can diffing and shadow validation be done without custom one-off scripts for every metric?

Requirement:

- `v2-compat-v1` should preserve enough field shape for practical comparison

## Recommended rollout strategy

This should be a multi-stage migration.

### Stage 1: make `v2` speak `v1`

Before asking `v2` to own real traffic:

- implement `v1` protocol compatibility
- implement `v1` module adapter
- implement stable error mapping
- keep `worker` and `serviceModule` running in TS during the entire path

Success condition:

- `v2` can join a `v1` environment without forcing global change

### Stage 2: shadow mode

Run `v2` beside `v1`:

- same inputs
- no traffic ownership
- response diffing
- error diffing
- latency diffing

Success condition:

- differences are measurable and explainable

### Stage 3: canary mode

Move a small subset of production traffic to `v2-compat-v1`.

Keep:

- rapid rollback
- shared observability
- explicit fallback to `v1`

Success condition:

- `v2` proves operationally boring

### Stage 4: selective native adoption

Only after compatibility mode is stable:

- enable targeted `v2-native` features
- migrate specific modules to native APIs when they actually benefit

Success condition:

- `v2-native` is adopted because it is useful, not because compatibility was missing

## Shadow and diff strategy

To make this rollout safe, the compatibility plan should assume:

- request mirroring or shadow execution
- response/result diffing
- error class diffing
- timing comparison

The important point is not absolute equality.

The important point is:

- differences are expected
- differences are classified
- differences are reviewed before promotion

## Rollback requirement

Rollback should not require:

- protocol migration rollback
- mass module rewrites
- simultaneous fleet restart everywhere

The compatibility design is successful only if rollback remains cheap.

That implies:

- `v1` protocol support stays available throughout the migration window
- `v1` modules do not need to be permanently forked into separate `v2-only` variants
- deployment control can move traffic back to `v1` quickly

## Recommended implementation shape

### Adapter direction

Prefer:

- `v1 model -> compat adapter -> v2 execution core`

Avoid:

- forcing the `v2 core` itself to look like `v1`

This allows:

- a clean new core
- explicit compatibility boundaries
- later removal or shrinking of the compatibility layer

### Error surface

Prefer one public error taxonomy with compatibility mapping.

That means:

- internal errors can stay `v2`-specific
- public/client-facing errors should map into stable categories

This is especially important if SDKs already depend on current semantics.

### Configuration

Prefer a translation layer:

- parse `v1` config/serviceModule shape
- normalize into a `v2` internal model

Not:

- duplicating `v1` config semantics all through the core

## Migration red lines

The following should be treated as migration failures, not acceptable tradeoffs:

- requiring existing `worker` code to be rewritten in Rust
- requiring existing `serviceModule` code to be rewritten in Rust
- redefining TS modules as "thin config" while moving real business behavior into Rust
- making `v2` rollout depend on product teams learning Rust to preserve current behavior

If any of those become necessary, the design has drifted off the intended path.

## Exit criteria for compatibility mode

`v2-compat-v1` can stop being the default only when:

- protocol interoperability has been proven in production
- module compatibility has been proven in production
- rollback drills are boring
- the value of `v2-native` is clear enough to justify migration effort

Until then, compatibility mode is not temporary scaffolding.

It is the migration path.

## Final recommendation

Treat the migration strategy as part of the product architecture, not an afterthought.

The correct order is:

1. `v2` can speak `v1`
2. `v2` can run `v1` logic
3. `v2` can coexist with `v1`
4. only then should `v2-native` become the main path

If that discipline is kept, `v2` can be tested under real traffic while `v1` remains the production anchor.
