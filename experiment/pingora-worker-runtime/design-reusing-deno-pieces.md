# Reusing Deno Pieces in the Pingora Runtime Experiment

Date: 2026-04-15

## Goal

Answer the practical question:

- can this experiment reuse `Deno` code instead of continuing to hand-roll the
  runtime surface?

The answer is:

- yes, but selectively
- and only at the layers that fit this runtime

## Short conclusion

The right approach is:

1. keep using `deno_core`
2. borrow the structure and semantics of `Deno`'s `Request/Body`
3. selectively adapt small JS/runtime pieces when the dependency surface stays
   under control
4. do not try to embed the whole `deno_fetch` / `deno_web` stack into this
   experiment right now

## 1. What is safe to reuse

## 1.1 `deno_core`

This is already the right foundation.

Why:

- it is the native `Rust + V8 + extension/op + CppGC` substrate
- it matches the current experiment's runtime model directly
- it is a better fit than trying to infer these patterns from a different
  engine/runtime stack

Keep:

- `JsRuntime`
- `op2`
- `CppGC`
- snapshot support

## 1.2 `Request` / `Body` design from Deno

This is the most valuable conceptual and structural reuse target.

Worth borrowing:

- lazy request field access
- body ownership model
- `bodyUsed` semantics
- clone restrictions for streaming bodies
- first-access caching

Why this layer is valuable:

- it is where this experiment still has visible request-path cost
- it has already produced real benchmark wins when moving toward the same shape

## 1.3 Small JS-side patterns

Some small JS-layer patterns are worth selectively adapting:

- lazy getter structure
- private/internal backing slots
- body helper shape
- normalized caching behavior

This is the most realistic form of "code reuse" in the near term:

- not wholesale vendoring
- but direct adaptation of small, stable patterns

## 2. What should not be reused wholesale right now

## 2.1 The full `deno_fetch` stack

Do not try to import the whole fetch extension stack into this experiment yet.

Why:

- `Request/Response/Body` in Deno are not isolated files in practice
- they rely on broader Deno runtime pieces:
  - streams
  - webidl-ish behavior
  - internal helpers
  - runtime bootstrapping conventions

The risk is:

- this experiment stops being a focused gateway runtime
- and turns into a partial Deno distribution

That would increase:

- code surface
- upgrade friction
- debugging cost
- mismatch risk with Pingora-specific runtime needs

## 2.2 Bun internals

Do not try to reuse Bun implementation code directly.

Why:

- the stack is too different:
  - Zig
  - JavaScriptCore
  - Bun-specific runtime internals

Bun is useful as a product/runtime design reference, not as a practical code
reuse target here.

## 3. Concrete Deno files worth studying

These are the most relevant source-level references:

- `ext/fetch/23_request.js`
- `ext/fetch/22_body.js`
- `ext/fetch/lib.rs`
- `deno_core` `op2` / `CppGC` patterns

What to extract from them:

- how request state is represented lazily
- where caching happens
- where body state lives
- what is JS policy vs what is native backing

What not to do:

- do not try to preserve Deno's full dependency structure
- do not import whole internal helper chains just to keep the code text similar

## 4. Mapping this to the current experiment

## 4.1 Current shape

Today the experiment roughly does:

- Rust owns request backing
- JS builds a `Request` facade
- some request fields are lazy
- body is lazy
- hot-path behavior is still more wrapper-heavy than ideal

## 4.2 Target shape

The next `Request` shape should move toward:

- one Rust-backed request object
- minimal JS wrapper logic
- native-backed lazy field access
- body represented as a true backed object, not just a wrapper convention

More concretely:

- `method`
  - native-backed
  - cache on first access or set once from host snapshot
- `url`
  - native-backed
  - cache on first access or set once from host snapshot
- `headers`
  - native-backed lazy view
  - avoid repeated normalization
- `body`
  - native-backed lazy reader/stream handle
  - no eager read

## 4.3 What to keep custom

These parts should remain Hardess/Pingora-specific:

- ingress request ownership
- drain/completion policy
- runtime pool execution path
- generation/rollout lifecycle
- timeout/drain interactions

This is important:

- Deno teaches the object/runtime shape
- Hardess still owns the network/runtime policy

## 5. Recommended reuse strategy

## Step 1

Use Deno's `Request/Body` files as a semantic reference, not a direct drop-in.

Output:

- a checklist of semantics to preserve

## Step 2

Refactor the current `Request` implementation so it looks structurally closer to
the Deno shape:

- fewer generic constructor branches on the hot path
- clearer internal slots
- clearer body state transitions

Output:

- a leaner host-backed `Request`

## Step 3

Only if a very small helper can be isolated cleanly, adapt code directly.

Criteria:

- small dependency surface
- obvious value
- no cascading vendoring

Output:

- targeted reuse, not large-scale transplant

## Step 4

Do not pull in full Deno fetch/web layers unless the experiment later decides to
move much closer to "embed a large subset of Deno runtime".

That is a separate architectural decision and should not happen accidentally.

## 6. Practical rule

If asking "should we reuse this Deno piece?", use this filter:

- does it match `Rust + V8 + host object` directly?
- can it be isolated without dragging a large dependency graph?
- does it reduce hot-path work or semantic risk?

If all three are true:

- reuse or adapt it

If not:

- learn from it, but reimplement locally in the smaller Hardess shape

## One-line takeaway

The right reuse strategy is:

- `reuse Deno's substrate`
- `borrow Deno's object model`
- `adapt small JS/runtime pieces`
- `avoid importing whole Deno subsystems`
