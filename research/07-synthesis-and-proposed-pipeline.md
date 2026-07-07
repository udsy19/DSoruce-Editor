# Synthesis — One Pipeline From Three Inspirations

This file turns the research into a **proposed** end-to-end workflow. It is a strawman for discussion,
**not** a committed design and **not** built. It combines what the user described with what the research
supports. Open decisions are called out and collected in `08-open-questions.md`.

## The blend, in one line

> **Rayon's editing** + **Laiout's AI generation** + **Materio's product binding** + an **agentic loop**
> that optimizes for the user's criteria (including circulation), viewable in **2D or 3D**.

## Proposed pipeline (stages)

```
1. INPUT / IMPORT        2. DEFINE CRITERIA        3. GENERATE (agentic)
   ┌───────────────┐        ┌────────────────┐        ┌────────────────────┐
   │ Draw walls or │        │ Program: rooms,│        │ Generator makes     │
   │ import DWG/PDF│───────▶│ headcount,     │───────▶│ candidates          │
   │ + CAD cleaner │        │ adjacency,     │        │  ↓                  │
   └───────────────┘        │ circulation,   │        │ Evaluator scores vs │
                            │ cost/carbon,   │        │ criteria            │
                            │ hard rules     │        │  ↓                  │
                            └────────────────┘        │ Optimizer re-rolls  │
                                                      │ weak zones (freeze  │
                                                      │ good ones) — LOOP   │
                                                      │ until criteria met  │
                                                      └─────────┬──────────┘
                                                                │
4. REVIEW / EDIT (Rayon-like)     5. RE-IMAGINE (Materio-like)  │
   ┌────────────────────────┐        ┌───────────────────────────▼─────┐
   │ Hand-edit any element, │◀──────▶│ Select ANY component (chair,    │
   │ 2D ↔ 3D toggle,        │        │ table, fall ceiling…) → side    │
   │ live metrics panel     │        │ panel of options from the       │
   └───────────┬────────────┘        │ SEARCHABLE MATERIAL BANK        │
               │                     │ (separate repo) → swap/confirm  │
               │                     └───────────────┬─────────────────┘
               ▼                                     ▼
6. SPEC & COST (Materio-like)              7. EXPORT / SHARE
   selections (open/in-review/confirmed),     DWG/DXF/IFC/OBJ/PDF/CSV,
   costed schedule by room/vendor             shareable 2D/3D link
```

## Stage detail

### 1. Input / Import
- Draw walls with a Rayon-like wall tool, **or** import DWG/PDF and run a **CAD cleaner** (Laiout/qbiq
  both treat this as a required normalization step) to get planning-ready geometry.

### 2. Define criteria (this is what makes the loop "smart")
- **Program:** room/zone mix, headcount, desk ratios, required adjacencies.
- **Hard constraints:** clearances, **minimum circulation width**, egress/code, frozen elements.
- **Objectives (soft, weighted):** capacity, adjacency satisfaction, daylight, **circulation quality
  ("walking place")**, cost, carbon.
- These criteria become **both** the generator's inputs **and** the evaluator's rubric
  (see `06-layout-generation-algorithms.md`).

### 3. Generate — the agentic, recursive core
- Generator → Evaluator → Optimizer loop (documented pattern). Runs until criteria pass / user approves /
  budget hit. **Freeze/Regenerate** (Laiout) lets the user or the agent lock good zones and re-roll the rest.
- **Circulation** is a first-class evaluator: build a walkability graph over free space and score path
  widths, dead-ends, and travel distances.

### 4. Review / Edit — Rayon layer
- Everything the agent produces is **hand-editable** vector geometry. **2D↔3D toggle.** A **live metrics
  panel** (area, capacity, cost, carbon, circulation score) updates on every edit, so a human can judge
  "good enough" the same way the evaluator does.

### 5. Re-imagine — Materio layer (the interaction the user emphasized)
- **Click any component** in 2D or 3D → geometry gets **selected** → a **side panel** opens with options
  **for that component's category**, drawn from the user's **searchable material bank** (separate repo).
- Swap the product; the choice updates geometry (3D asset), spec, and cost simultaneously.
- Multi-select + "re-imagine these together" is a natural extension (agent proposes a coherent set).

### 6. Spec & cost — Materio layer
- Each placed component is also a **selection** with lifecycle (**open → in-review → confirmed**) and
  approval history. Output is a **costed schedule** by room/zone/vendor — a real, procurable spec, not
  just a picture.

### 7. Export / Share
- Export DWG/DXF/IFC/OBJ/PDF/CSV (Laiout's matrix is the bar). Shareable interactive 2D/3D link, no
  install for viewers.

## The unifying data model (proposed)

The whole pipeline works if a **placed component is one object with four facets**:

1. **Geometry** — position/shape in the 2D plan (and its 3D extrusion/asset).
2. **Semantics** — type + **category** (chair / table / fall-ceiling…) → drives the re-imagine panel.
3. **Product binding** — the selected item from the material bank (vendor, cost, 3D asset, finish).
4. **Decision state** — open/in-review/confirmed + history.

This single object is what lets Rayon-style editing, Materio-style specification, and Laiout-style
generation all operate on the **same** entities. **[Inferred]** design proposal — to validate with you.

## What is deliberately NOT decided here
- Tech stack (TS-first vs Rust/Wasm), 2D engine (Pixi/tldraw/custom), 3D depth, multiplayer, and the
  material-bank API contract. All in `08-open-questions.md`.
