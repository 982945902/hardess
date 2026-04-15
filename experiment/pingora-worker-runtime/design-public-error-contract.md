# Public Error Contract Design for the Pingora Experiment

Date: 2026-04-15

## Decision

Public error definitions should come from one machine-readable source:

- `contracts/public-errors.json`

That file should define:

- stable `code`
- public `category`
- canonical HTTP `status`
- canonical `retryable`

Short version:

`One public error source. Many adapters.`

## Why this exists

If the server, worker runtime, and future SDK each maintain their own:

- code list
- status mapping
- retryability rules

then they will drift.

That drift is expensive because public errors are part of the external contract.

## Scope

This contract is only for public errors.

It should not try to enumerate every internal failure mode.

Internal causes can remain richer in logs, traces, and metrics.

The public contract only needs enough stability for:

- clients
- dashboards
- alerts
- runbooks

## Contract shape

The single source is JSON so both Rust and TypeScript can consume it.

Conceptual shape:

```json
{
  "version": 1,
  "errors": [
    {
      "code": "execution_timeout",
      "category": "execution_timeout",
      "status": 504,
      "retryable": false,
      "public": true
    }
  ]
}
```

## Rules

- `code` is the stable identifier that SDKs and dashboards should key on
- `category` is the smaller durable grouping
- `status` is canonical and should not be redefined ad hoc by adapters
- `retryable` is canonical and should not drift between server and SDK
- only public-facing codes belong here

## Adapter behavior

Adapters should:

1. look up the code in `public-errors.json`
2. use the contract's canonical `category/status/retryable`
3. preserve only the runtime message

If a worker or adapter emits an unknown public code:

- do not pass that unknown code through to clients
- normalize it to `internal_error`

That protects the public contract from accidental expansion.

## Error families

The file should contain both:

- shared platform-level codes
- selected business-level public codes

Examples:

- `bad_request`
- `execution_timeout`
- `temporarily_unavailable`
- `shutdown_draining`
- `tenant_over_quota`

That allows business-visible errors to stay on the same public taxonomy rather than creating a second side channel.

## Current experiment integration

In the experiment runtime:

- Rust host constructors derive public error metadata from `public-errors.json`
- TS workers can read the same contract through `globalThis.HardessPublicErrors`
- ingress error responses use the same mapping
- compat worker `ParsedV1Response.error` is normalized through the same contract

That means:

- ingress errors
- runtime errors
- compat worker public errors

all converge onto one source of truth.

## Non-goals

- no attempt yet to generate SDK code automatically
- no attempt yet to move the stable `v1` repo onto this contract
- no attempt yet to model private/internal diagnostic error trees here

## Recommended next steps

1. expose this contract to TS helpers or SDK build tooling
2. add lint/codegen so worker-side public codes import constants instead of string literals
3. eventually move production-facing SDK/server public error enums to this same source
