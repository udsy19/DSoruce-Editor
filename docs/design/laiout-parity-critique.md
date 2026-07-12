# Deep critique — DSource test-fit vs Laiout (2026-07-12)

Grounded comparison of our current generated output (real 882 m² plate, default program)
against laiout.co's output, with the root cause and the fix owner for each gap. Reference:
the user's Laiout screenshots (108 pax, 10.8 m²/employee, 78% efficiency, one flowing
circulation, clustered workstations, refined furniture) + `laiout-visual-system.md`.

## Scorecard

| Dimension | Ours now | Laiout | Root cause | Fix / owner |
|---|---|---|---|---|
| **Efficiency** | 52% | 78% | `metrics()` efficiency = (Workspace+Meeting+Collab)/NIA — **excludes ClosedOffice + Amenity from "usable"** (a formula bug); plus genuinely too much leftover→circulation | **(1) fix the formula** (usable = everything except Circulation+Core) → *metrics agent*; **(2) fill the plate better** → *generator* |
| **Circulation coherence** | fragmented into many rects/polys | one flowing network | residual-fill + conform emit many separate Circulation zones | **unify contiguous walking area into one poly** → *circulation agent (running)* |
| **White / negative space** | 7.4% / 65 m² wedges | ~0 | axis-aligned rectangles can't fill a diagonal wedge | **polygon sweep of untyped floor** → *circulation agent (running)* |
| **Workspace accounting** | "Open Workspace 342 m²" bundles desks **and** the walking aisles between them | desk neighbourhoods vs circulation kept separate | open-plan aisles bucketed as Workspace | **carve open-plan aisles into circulation** → *generator* (visual + honest split) |
| **Workstation arrangement** | one monolithic desk grid | clustered team neighbourhoods (~6–12), circulation between | `pack_desks` is a single field; splitting costs rows (density guardrail) | **cluster with a density/guardrail-aware split** → *generator (hard)* |
| **Rooms vs angled walls** | 2 of 19 conform; the rest are boxy rects leaving wedges | rooms fit the boundary | rooms placed interior + as Rect | **place rooms on the perimeter + conform them** → *generator (hard)* |
| **Furniture** | contoured chairs, racetrack conference tables, desk+monitor+chair ✓ | refined | — | **DONE** (`6f01817`) |
| **Room count / design sense** | 19 rooms, 1 cabin, sensible | sensible | — | acceptable (guardrail keeps it sane) |
| **Insights panel** | Areas / Zones / CO2 / Costs present | richer per-element, honest usable split | efficiency formula + presentation | *metrics agent* |
| **Cost / carbon** | ₹20.2k/m², 147 kg/m² (India CAT-B) ✓ | plausible | — | **DONE** (`f49248a`) |

## The two big levers

1. **Efficiency is understated AND genuinely low.** The formula bug (offices/amenity not
   "usable") is a quick correctness fix (+~10 pts). The rest is real: too much leftover floor
   becomes circulation, so usable% is low. Filling the plate better (clustered desks that reach
   more of it, rooms that conform, less silent leftover) is the only way to Laiout's 78% — you
   can't type-your-way there (typing leftover as circulation keeps usable% low).
2. **Everything reads "boxy."** Rooms are rectangles, the desk field is one block, circulation
   is fragmented. Laiout's polish is neighbourhoods + boundary-conforming rooms + one flowing
   circulation. This is the generator's hard core, and it's serial (`layout.rs`).

## Sequencing (why not all-parallel)
The generator gaps (efficiency-fill, neighbourhoods, rooms-conform, workspace accounting) all
live in `layout.rs` → they must run **one agent at a time**, and the circulation-unify agent
owns it now. The **metrics/insights** work (`lib.rs` efficiency formula + `stats.ts` +
`StatsPanel.tsx`) is a separate lane → runs in parallel today. Generator core follows the
circulation agent as a careful, guardrailed pass (workstations ≥ 80, NIA ≤ GEA, determinism).

## Progress log (living tracker)
Guardrail for every generator change: workstations ≥ 80 on all A/B/C candidates, NIA ≤ GEA,
determinism, tests + timing green — verified in-browser on the real plate before merge.

- `2026-07-12` — **[running]** circulation agent: unify walking area into one network + polygon
  sweep to kill the 65 m² white wedges (`layout.rs`).
- `2026-07-12` — **[running]** metrics agent: fix efficiency formula (usable excludes only
  Circulation+Core) + Laiout-depth Areas/Zones/CO₂/Costs panel (`lib.rs`, `stats.ts`, `StatsPanel.tsx`).
- **[queued]** generator core: workstation neighbourhoods + rooms conform to angled walls +
  carve open-plan aisles into circulation → higher genuine efficiency. Runs after the circulation
  agent frees `layout.rs`.
- **[done]** furniture (`6f01817`), cost/carbon India CAT-B (`f49248a`), residual sub-metre
  pockets (`2af78e8`).
