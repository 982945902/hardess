# Package Management Design for the Pingora + Deno Core Experiment

Date: 2026-04-14

## TL;DR

For this experiment, package management should follow this rule:

`Reuse Deno's package-management model. Do not invent a custom Hardess package manager.`

Concretely:

- author-facing dependencies should use Deno-native specifiers such as `jsr:` and `npm:`
- dependency locking should use `deno.lock`
- worker project config should use `deno.json`
- Rust host-side module graph / resolution should follow Deno semantics via crates like `deno_graph`

The important separation is:

- `package management` is an authoring and resolution concern
- `deno_core` is an execution/runtime concern

`deno_core` alone is not the full answer for package management.

## Why package management matters here

If this experiment only proves "Rust can execute one JS string", it is not meaningful.

For Hardess-style worker hosting to be real, developers need:

- import third-party packages
- pin versions
- get deterministic builds
- avoid runtime surprises from drifting dependencies
- understand where packages come from

Without that, the experiment never gets past toy status.

## The key architectural decision

The host should not try to own all of the following itself:

- npm resolution rules
- registry protocol logic
- version solving
- lockfile format
- module graph resolution

That would turn the experiment into "build a package manager", which is the wrong project.

Instead, use Deno's model:

1. package authoring and dependency declaration use Deno conventions
2. lockfile semantics follow Deno
3. graph construction follows Deno
4. execution is done by the Rust host using `deno_core`

## Recommended package-management model

### 1. Author-facing specifiers

Use:

- `jsr:` for JSR packages
- `npm:` for npm packages
- relative/file specifiers for local modules

Why:

- this is already Deno's native story
- it keeps worker authoring close to modern Deno/TS usage
- it gives us a real ecosystem story without introducing a Hardess-specific import format

Official references:

- Deno npm support docs: https://docs.deno.com/runtime/manual/node
- Deno standard library / JSR docs: https://docs.deno.com/runtime/fundamentals/standard_library/

### 2. Worker project config

Each experimental worker package should eventually have:

- `deno.json`
- `deno.lock`

Reason:

- `deno.json` is the natural place for imports, compiler/runtime settings, and lockfile config
- `deno.lock` gives deterministic dependency resolution

Official reference:

- Deno config and lock docs: https://docs.deno.com/go/config

### 3. Locking

Recommendation:

- commit `deno.lock`
- use frozen lockfile semantics in CI / reproducible runs

Reason:

- worker dependencies should not drift between runs
- the experiment must be reproducible if we are evaluating runtime behavior

This is especially important if later we compare latency or cold-start behavior.

### 4. Graph construction on the Rust side

Recommendation:

- use `deno_graph` as the main graph / resolution primitive

Reason:

- `deno_graph` explicitly provides Deno CLI-style module graph logic
- it is the right place to reuse Deno resolution semantics from Rust instead of rebuilding them

Official reference:

- `deno_graph` docs: https://docs.rs/deno_graph/latest/deno_graph/

## What not to do

### Do not do this first

- invent a `hardess:` package registry
- invent a custom lockfile
- invent a custom package-install command
- require workers to use `node_modules` as the primary mental model

All of these create cost before the experiment proves value.

### Why not `node_modules` first

Deno can work with `node_modules` in some situations, but that should not be the default mental model for this experiment.

Why:

- it pulls the design back toward Node-first ergonomics
- it makes the experiment less aligned with the Deno toolchain we are intentionally borrowing
- it increases ambiguity about who is actually resolving dependencies

If some package later forces a `node_modules` fallback, that can be a compatibility escape hatch, not the primary model.

Official reference:

- Deno node/npm compatibility docs: https://docs.deno.com/runtime/manual/node

## Recommended split of responsibilities

### Developer / authoring layer

Owns:

- `deno.json`
- `deno.lock`
- imports using `jsr:` / `npm:` / local specifiers

Typical developer workflow:

1. write worker in TypeScript
2. add dependencies through Deno-native config/imports
3. lock dependencies
4. hand the worker root entrypoint to the Rust host

### Rust host layer

Owns:

- reading worker entrypoint
- resolving/building a module graph
- applying lockfile policy
- loading modules into `deno_core`
- exposing host APIs like `fetch(request, env, ctx)`

This is the clean boundary.

## Practical implementation recommendation

### Phase 1

Do not implement package installation inside Rust yet.

Instead:

- define that worker projects are Deno-style projects
- expect `deno.json` and `deno.lock`
- use `deno_graph` in Rust to understand the dependency graph

This keeps the experiment small and honest.

### Phase 2

Once the host contract works, decide whether the Rust host should:

1. directly resolve remote modules at runtime
2. rely on a prepared local cache/build step
3. support both development and packaged execution modes

My recommendation:

- development mode can allow graph resolution using Deno-style config
- packaged mode should prefer pre-resolved / locked / deterministic inputs

## Current recommendation

Use this stack for package management in the experiment:

- `deno_core` for execution
- `deno_graph` for module graph / resolution semantics
- `deno.json` for worker project config
- `deno.lock` for deterministic dependency locking
- `jsr:` and `npm:` specifiers for dependencies

Short version:

`Use Deno's package-management model around deno_core.`

Not:

`make Hardess invent its own package manager.`

## Current experiment status

The runnable experiment now has a first package-management slice:

- `deno.json#imports` is applied during worker resolution
- remote `http:` / `https:` modules can be fetched by the host
- `deno.json#lock.path` and `deno.json#lock.frozen` are recognized
- remote modules can be checked against `deno.lock` before a worker generation becomes active
- remote modules can be reused from a worker-local prepare cache between generations
- the prepare cache exposes entry-count / total-bytes visibility and prunes stale entries

This is enough to make generation prepare deterministic for the currently
supported remote-module path.

It is not yet the final package-management architecture because:

- the host does not write or update `deno.lock`
- `jsr:` and `npm:` are still experiment rewrites, not full Deno graph semantics
- there is no shared module cache yet
- there is no `deno_graph` integration yet

## Suggested next step

After the current workspace scaffold, the next design task should be:

- define the minimal worker project shape, for example:
  - `worker/deno.json`
  - `worker/deno.lock`
  - `worker/mod.ts`

Then:

- make the Rust host load that entrypoint using Deno-style graph semantics

That will be the first real proof that this runtime direction is viable.

## Sources

- Deno node/npm compatibility docs: https://docs.deno.com/runtime/manual/node
- Deno config and lockfile docs: https://docs.deno.com/go/config
- Deno standard library / JSR docs: https://docs.deno.com/runtime/fundamentals/standard_library/
- `deno_graph` docs: https://docs.rs/deno_graph/latest/deno_graph/
- `deno_core` GitHub README: https://github.com/denoland/deno_core
