# Design — Autonomous Test-Fit Generation Loop

**Status:** Draft · 2026-07-06 · owner: layout engine
**Scope:** the product's core differentiator — user sets criteria, the system
recursively **generates → evaluates → optimizes** office layouts until the criteria
are met. This doc covers the input schema, the v1 deterministic generator, the
objective function, the agentic loop, stop conditions, and the path to a
Claude-in-the-loop evaluator.

Prior research this builds on: `research/06-layout-generation-algorithms.md`
(algorithm menu + agentic-loop pattern) and `research/07-synthesis-and-proposed-pipeline.md`
(the 7-stage pipeline; this doc details **Stage 3, Generate**).

The v1 generator + objective live in `crates/ds-core/src/layout.rs`. Circulation is a
**separate** evaluator a teammate is building in `crates/ds-core/src/circulation.rs`;
this design references it but does not implement it.

---

## 1. Input schema — Program / Criteria (what the user sets)

The literature's central design principle is that **the human sets the search space,
the constraints, and the evaluation protocol; the agent explores within it**
([research/06 §3](../../research/06-layout-generation-algorithms.md);
Anthropic *Building Effective Agents* — evaluator-optimizer, see §4). We therefore split
user input into three buckets, all captured in one `Program` object.

### 1a. Program (what to place — drives the generator)
| Field | Meaning | Default |
|---|---|---|
| `desks` | target number of workstations | — |
| `meeting_rooms` | number of enclosed meeting rooms | — |
| `desk_w` × `desk_h` | desk footprint, m | 1.6 × 0.8 |
| `meeting_w` × `meeting_h` | meeting-room footprint, m | 4.0 × 4.0 |
| `cluster_cols` | desks per bench group before an aisle | 4 |

Standard office metrics used for the defaults: a workstation "capsule" of ~5.5–6.5 m²
for a 140×70–160×80 cm desk, and 40–50 % of floor to workstations
([Arcedior](https://arcedior.com/blog/open-office-layout-standards-clearances-2025),
[factoryoficina](https://www.factoryoficina.com/gb/blog/office-space-planning-how-many-workstations-fit-per-m-quick-rule-templates.html)).

### 1b. Hard constraints (must never be violated — bound the generator)
| Field | Meaning | Default |
|---|---|---|
| `target_corridor_m` | perimeter circulation corridor width, m | 1.2 |
| `desk_clearance_m` | clear gap around each desk (aisle/access), m | 0.9 |

Grounding: primary two-way circulation aisles want **0.9–1.2 m** (IBC 2024 §1020.3 sets a
1.118 m / 44-inch minimum for ≥50 occupants); clear passages between desk rows want
**0.6–0.9 m**
([Arcedior](https://arcedior.com/blog/open-office-layout-standards-clearances-2025),
[Dimensions.com](https://www.dimensions.com/element/office-workstation-clearances)).
Frozen elements (see §4) are also hard constraints once locked.

### 1c. Objective weights (soft goals — drive the evaluator)
`w_capacity`, `w_adjacency`, `w_circulation`, `w_density` — how the user trades off
"fit everyone" vs "tight clusters" vs "generous walking space" vs "dense floor". These
weight the sub-scores in §3. Defaults sum to 1.0 (capacity 0.35, circulation 0.25,
adjacency 0.20, density 0.20).

A `seed: u64` (passed separately to `generate`) makes every run reproducible and gives
the optimizer a knob to re-roll variants — the same role Laiout's Regenerate button plays.

---

## 2. Generator strategy (v1 — deterministic, seeded, heuristic)

Chosen approach: **heuristic space-subdivision + grid packing**, the "fast, controllable,
explainable" default engine from `research/06 §1`. Rejected for v1: GA/NSGA-II, physics
relaxation, and learned (GAN/RL/LLM) generators — they are the v2/v3 upgrades in the
research build order, needing tuning or training data. v1 front-loads controllability and
exact constraint satisfaction (clearance, corridor) which a heuristic guarantees by
construction.

The generator carves the wall bounding box into concentric/banded zones:

```
┌─────────────────────────────────────────────┐  ← wall bbox
│  perimeter corridor (target_corridor_m)      │
│  ┌───────────────────────────────────────┐   │
│  │ meeting-room band  [MR][MR][MR] ...    │   │  packed L→R
│  │ · · · · · · · · aisle · · · · · · · · ·│   │
│  │ desk grid   [D][D][D][D] | [D][D][D][D]│   │  clusters of
│  │             [D][D][D][D] | [D][D][D][D]│   │  cluster_cols,
│  │             ... aisles every cluster   │   │  aisle gaps between
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

Steps:
1. **Floor rect** = axis-aligned bbox of wall endpoints (matches `Document::floor_area`).
   Empty walls ⇒ no-op.
2. **Inset** the floor rect by `target_corridor_m` on all four sides → the *work zone*.
   Everything placed lives strictly inside this, guaranteeing the perimeter corridor.
3. **Meeting-room band**: pack up to `meeting_rooms` fixed-size rooms left-to-right along
   the top of the work zone, each separated by `desk_clearance_m`. Consumes a band of
   height `meeting_h` (+ one clearance aisle below it).
4. **Desk grid**: fill the remaining work zone with desks on a pitch of
   `(desk_w + desk_clearance_m) × (desk_h + desk_clearance_m)`. Every `cluster_cols`
   desks a wider aisle gap is inserted → bench clusters with circulation between them.
   Place `min(desks, grid_capacity)`.
5. **Seeded variation**: an inline xorshift64\* PRNG (no `rand` crate) applies a small
   deterministic per-desk jitter bounded to ±25 % of the clearance, so a given seed always
   yields an identical layout but different seeds yield distinct candidates for the
   optimizer to compare. The jitter can never consume the clearance, so constraints hold.

Determinism is a hard requirement: `generate(doc, program, seed)` is a pure function of
its inputs, so the loop, tests, and Freeze/Regenerate are all reproducible.

---

## 3. Objective function (the evaluator's rubric)

`score(doc, program) -> LayoutScore` returns four sub-scores in **0..100** plus a weighted
`total`. Each is serde-`Serialize` so the frontend metrics panel and the loop read the same
numbers a human judges by (`research/07 §4`).

| Sub-score | What it measures | v1 computation |
|---|---|---|
| **capacity** | did we seat the program? | `100 · placed_desks / requested_desks` (clamped) |
| **adjacency** | are desks in tight benches? | nearest-neighbour pitch ratio: `100 · ideal_pitch / avg_nn_distance` |
| **density** | sensible floor utilisation | reward desk-area / floor-area inside the 30–55 % band, taper outside |
| **circulation** | walkable, no dead-ends | **placeholder** — see below |

`total = w_capacity·capacity + w_adjacency·adjacency + w_circulation·circulation + w_density·density`
(weights from §1c, normalised).

### Circulation hook (teammate-owned — wired in, not implemented here)
Circulation ("walking place") is a first-class evaluator owned by a teammate in
`crates/ds-core/src/circulation.rs`. It landed with this API:

```rust
// crates/ds-core/src/circulation.rs  (teammate-owned)
pub fn evaluate(doc: &Document, cfg: &CirculationConfig) -> CirculationScore; // .score is 0..100
```

`layout::score` calls it directly, passing the program's `target_corridor_m` through
`CirculationConfig::target_corridor_width` so the corridor the generator *reserves* is the
same width the evaluator *measures against*, and uses the returned `.score` (0..100) as the
circulation sub-score. Under the hood it rasterises the plan into an occupancy grid, runs a
chamfer distance transform to get local clearance, and scores corridor widths, dead-ends and
free-region connectivity — the walkability-graph / medial-axis approach anticipated in
`research/06 §3`. `layout` treats this module as a black box (headline score only).

---

## 4. The evaluate → optimize → freeze loop

The production-shaped pattern from `research/06 §3` and Anthropic's *Building Effective
Agents* **evaluator-optimizer** workflow: one stage generates, another scores against an
explicit rubric, and the two iterate until quality is met. It is the right pattern precisely
because test-fit has *clear evaluation criteria* and *benefits from iterative refinement* —
the conditions Anthropic names for this workflow
([anthropic-cookbook evaluator_optimizer](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/evaluator_optimizer.ipynb),
[Building Effective AI Agents](https://resources.anthropic.com/building-effective-ai-agents)).

```
criteria (Program) ──▶ ┌─────────────┐  candidate  ┌────────────┐ LayoutScore
                       │  GENERATE   │────────────▶│  EVALUATE  │──────┐
                  ┌───▶│ layout::gen │             │layout::score│      │
                  │    └─────────────┘             └────────────┘      │
                  │        seed++ / re-roll weak zones                 │
                  │    ┌─────────────┐                                 ▼
                  └────│  OPTIMIZE   │◀──── feedback (which sub-  ┌──────────┐
                       │ freeze good │      score is weakest)     │  STOP?   │
                       │ zones,      │◀──────────────────────────│ criteria │
                       │ re-roll rest│                            │ met? │
                       └─────────────┘                            └──────────┘
```

- **Generate**: v1 re-rolls by incrementing `seed` (cheap, deterministic candidates).
- **Evaluate**: `layout::score`; the loop keeps the best `total` seen.
- **Optimize / Freeze**: the loop identifies the weakest sub-score and either (a) re-rolls
  with a new seed, or (b) — the richer path — **freezes** components the user/agent marked
  good (Laiout's Freeze/Regenerate UX) and regenerates only the rest. A component is
  "frozen" when `decision == Confirmed`; the generator will skip re-placing confirmed
  components and pack around them. (Hook exists in the model already via `DecisionState`.)

### Stop conditions
1. **Criteria met** — every weighted sub-score ≥ its target, or `total ≥ target_total`.
2. **Budget hit** — `max_iterations` reached (bounds latency/cost; the loop is only worth
   running when latency is acceptable — `research/06 §3`).
3. **No improvement** — best `total` did not improve for `patience` consecutive iterations
   (plateau detection), the standard early-stop for reflect-refine loops.

Return the best-scoring candidate seen, never a worse final roll.

---

## 5. Path to a Claude-in-the-loop evaluator (soft / aesthetic goals)

v1's evaluator is pure metric validators — objective and cheap. Many real criteria are
**soft**: "does this feel open?", "is the exec cluster appropriately private?", daylight
quality, brand fit. These are exactly where the research says an **LLM critique** slots in
as (or alongside) the evaluator (`research/06 §3`, table row *Evaluator*).

Migration, additive and non-breaking:
1. Keep `layout::score` as the **hard-metric floor** — a candidate that fails clearance or
   capacity is rejected before Claude is ever called (cheap gate; avoids spending tokens on
   invalid layouts — Anthropic's guidance: add the LLM loop only where first-draft quality
   demonstrably falls short).
2. Render the candidate (plan image / structured JSON of the `Document`) and send it to
   Claude with the user's soft criteria as the rubric → get a critique + a soft-score
   0..100 + targeted feedback ("meeting rooms block the daylight on the south wall").
3. Feed the critique back as the **Optimize** step's guidance: which zone to re-roll or
   which frozen set to keep. This is the evaluator-optimizer loop with an LLM evaluator and
   a deterministic generator — a validated-generator / "physics-in-the-loop" hybrid
   (`research/06 §3`), which keeps geometry always valid while Claude judges aesthetics.
4. Blend: `final = α·metric_total + (1-α)·claude_soft`, α exposed as a criterion so users
   who want purely objective fits can set α=1.

This staging matches the research build order: **v1 deterministic engine → v2 agentic
wrapper with LLM evaluator → v3 learned generation** (`research/06`, recommended build order).

---

## Sources
- `research/06-layout-generation-algorithms.md`, `research/07-synthesis-and-proposed-pipeline.md` (in-repo)
- Anthropic, *Building Effective Agents* — evaluator-optimizer workflow:
  <https://resources.anthropic.com/building-effective-ai-agents> ·
  <https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/evaluator_optimizer.ipynb>
- AWS, *Evaluator reflect-refine loop*:
  <https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html>
- Office clearance / circulation standards:
  <https://arcedior.com/blog/open-office-layout-standards-clearances-2025> ·
  <https://www.dimensions.com/element/office-workstation-clearances> ·
  <https://www.factoryoficina.com/gb/blog/office-space-planning-how-many-workstations-fit-per-m-quick-rule-templates.html>
- Layout optimisation background (NSGA-II / heuristic subdivision):
  <https://www.mdpi.com/2075-5309/13/7/1793>
