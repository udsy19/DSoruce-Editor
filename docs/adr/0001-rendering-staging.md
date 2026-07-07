# ADR 0001 — Staged rendering: TS canvas now, Rust/WebGL later

**Status:** Accepted · 2026-07-06

## Context

We committed to a Rayon-style **Rust → WebAssembly core** (`research/08-open-questions.md`). Rayon's
architecture keeps the Rust core "as pure as possible," with the **only** browser-touching part being a
custom WebGL renderer written in Rust. Building that custom GPU renderer is the single largest and
riskiest piece of the stack.

## Decision

Stage the renderer.

- **Now (v1):** the Rust core owns the document model, geometry, hit-testing, and (soon) the layout
  engine and evaluators. Rendering is done in the **TypeScript frontend** on a 2D canvas
  (`web/src/editor/EditorCanvas.ts`). The frontend reads `Editor.state()` and draws.
- **Later:** move rendering into Rust via a custom WebGL renderer (GPU-computed hatching/dashing like
  Rayon), once object counts or drawing fidelity justify it. The core is already the source of truth, so
  this is an additive change, not a rewrite.

## Why this is safe

- The Rust core is **UI-agnostic** today — swapping the renderer does not touch the document/geometry
  code. This preserves Rayon's "pure core, thin browser layer" principle.
- The TS canvas is a thin drawing pass over the serialized document; there is no business logic in it to
  port later.

## Consequences

- We ship an interactive editor fast without the WebGL renderer on the critical path.
- Very large drawings (10k+ objects) may need the Rust/WebGL renderer sooner; that's the trigger to
  promote this from "later" to "now."
