# Experiments

This directory is intentionally isolated from the main Hardess runtime.

Use it for:

- architecture spikes
- runtime/kernel experiments
- integration feasibility checks
- throwaway prototypes that may or may not graduate into the main product

Current experiments:

- [Pingora + Rust + TS runtime / Workers-style host](./pingora-worker-runtime/README.md)
- [workerd minimal runtime validation](./workerd-runtime-minimal/README.md)

Rules for this directory:

- do not couple experiment code to the main Bun runtime unless there is a clear reason
- prefer small, inspectable prototypes over ambitious half-built rewrites
- write down the question each experiment is trying to answer
- keep the graduation bar explicit: what would have to be true to move this into the main runtime
