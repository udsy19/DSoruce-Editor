# Research: A Smart 2D/3D Interior Space Editor

This folder collects grounded research for building an interior-design / space-planning editor that
combines the strengths of three reference products:

- **Rayon** — effortless, collaborative, browser-based CAD (the *drawing & editing* layer)
- **Materio** — selecting elements and attaching real products/materials to a room (the *specification & product-bank* layer)
- **Laiout** — AI-generated, regulation-aware test fits with 2D/3D viewing (the *intelligence & generation* layer)

The goal is a single workflow: **draw/import a space → generate smart test-fits with AI → re-imagine
by selecting any component and swapping it from a searchable material bank → view in 2D or 3D → export.**

## How to read this folder

| File | What's in it |
|------|--------------|
| `01-rayon.md` | Deep dive on Rayon: features + confirmed tech stack (Rust/Wasm/custom WebGL, multiplayer) |
| `02-materio.md` | Deep dive on Materio: selections workflow, Floor Plan Mapping, product/material libraries |
| `03-laiout.md` | Deep dive on Laiout: AI generation, regulation-aware layouts, 2D/3D, exports |
| `04-competitive-landscape.md` | Adjacent players (qbiq, Archilogic, etc.) and what they reveal about the space |
| `05-open-source-building-blocks.md` | Real OSS we can fork/extend, with stacks and licenses to verify |
| `06-layout-generation-algorithms.md` | The academic + practical toolbox for automated/agentic test-fit generation |
| `07-synthesis-and-proposed-pipeline.md` | How the three inspirations combine into one pipeline + the "re-imagine" flow |
| `08-open-questions.md` | Decisions I need from you before designing/building anything |

## Evidence discipline

Every claim in these files is tagged:

- **[Confirmed]** — stated directly on the company's site or a cited technical source.
- **[Inferred]** — a reasonable deduction from the feature set; not stated outright.
- **[Unknown]** — proprietary / not public. Flagged rather than guessed.

Nothing here is invented. Where a detail is proprietary (e.g. Laiout's exact algorithm), it is marked
**[Unknown]** instead of being filled in.

## Status

Research pass complete. **No editor code has been written yet.** See `08-open-questions.md` —
I need your answers before proposing a concrete architecture and starting a build.

_Last updated: 2026-07-06_
