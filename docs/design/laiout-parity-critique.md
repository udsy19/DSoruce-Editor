# Deep critique — DSource test-fit vs Laiout (2026-07-12)

Grounded comparison of our current generated output (real 882 m² plate, default program)
against laiout.co's output, with the root cause and the fix owner for each gap. Reference:
the user's Laiout screenshots (108 pax, 10.8 m²/employee, 78% efficiency, one flowing
circulation, clustered workstations, refined furniture) + `laiout-visual-system.md`.

## Scorecard

| Dimension | Ours now | Laiout | Root cause | Fix / owner |
|---|---|---|---|---|
| **Efficiency** | ~~52%~~ **60%** | 78% | formula bug FIXED (`9392293`); remaining gap = genuinely too much leftover→circulation (34%) | **fill the plate better** → *generator* |
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

## Root-cause audit (2026-07-14, three parallel agents: generator · visual · agentic-designer)
The perceived gap has **three layers**; only the middle one is free (no seat trade).

**A. The generator's geometric vocabulary is the ceiling — [parked by seats-first].** Laiout composes an
irregular, boundary-conforming, neighbourhood plan; we compose *one* grid-packed bench field + a band of
**rectangular** rooms + a corridor (`layout.rs:9-16`, `pack_desks:3985`). The two dominant "boxy/robotic"
tells — (1) monolithic desk grid, not 6–12 team neighbourhoods (cluster aisles are 1-D and `max_aisles`
silently drops to 0 to protect density, `:4147-4152`), and (2) rooms placed in interior bands so only ~1
conforms to an angled wall (placement-limited, not a conform bug) — **both cost desks to close, so both are
correctly parked.** You cannot reach Laiout's *look* without spending seats.

**B. The efficiency NUMBER is dragged below what the geometry deserves — by two seat-neutral accounting facts
[genuinely fixable, no guardrail risk].** This is the free tier:
  - **b1. Facade ribbon taxed as circulation.** The 0.9 m `FACADE_GAP` clearance behind window-line desks
    (`:1303,:828`) is un-zoned → `fill_untyped_as_circulation` types it Circulation (~12% of an 882 m² plate).
    `conform_zones_to_plate` **refuses to reclaim it on straight/orthogonal walls** — it early-returns on
    axis-aligned geometry and rejects non-slanted growth (`:2021-2031,:2216-2224`). Growing Workspace to the
    straight wall (no desk moves) plausibly recovers **~8–12 efficiency pts, seat-neutral.**
  - **b2. Axis vs oriented path bucket leftover into opposite zones.** The oriented path lets Workspace absorb
    `floor − others` as **usable** (`lib.rs:182-190`); the axis path types the *same* open-floor leftover as
    **Circulation** (`:1886-1920`). Our real plate (`axis_cover ~0.80` > `ORIENTED_COVER_FRAC 0.70`) takes the
    pessimistic branch → reports ~15 pts worse than an identical-quality plate. Make the axis path absorb honest
    open-floor leftover like the oriented path → higher **and** consistent efficiency, **no desk moved.**
  - **b3. Circulation is 3 disjoint families** (drawn spine/seam rects + ~7 merged residual polys), never one
    loop — `fill_untyped` only melts zones labelled exactly `"Circulation"` (`:2505`), preserving the drawn net.
    Relabel + re-merge all circulation is mechanical + seat-neutral; a coherent *loop* is harder.

**C. The agentic designer is neutered on the exact path users run — [wiring bug, cheap to fix].** Whenever
Claude emits an explicit `rooms[]` (its prompt makes this near-certain), the generator **silently drops
`strategy` and the `meeting_rooms` override** (`layout.rs:156-181,1560-1561`) — Claude's two most spatial levers.
The options path uses a **single fixed seed** (`EditorCanvas.ts:1798`), so all `*_emphasis` weights are inert
and the 5 objective cards differ only in *counts*, not spatial character; cost/carbon barely move because a
fixed base-shell term is ~70% of both (`cost.rs:72,161`). Claude genuinely improves the *program* (GCC room-mix
sizing) but has **zero lever on spatial quality** — adding it is not moving geometry toward Laiout.

**Visual layer (renderer-only, compounds A).** Walls are single **round-capped centerlines, not architectural
poché** (`EditorCanvas.ts:2832-2848`) — the #1 "not a real drawing" tell, seat-neutral, medium effort. Furniture
**collapses to plain chips at plan-framing zoom** (`furniture.ts:37,61-69`) — the very first impression, low
effort. No plants/sofas/casework in 2D (generator never places them; the 3D models already exist in
`furniture3d.ts:430-519`). Monochrome grid + heavy solid monitor bars read robotic.

**Verdict.** The two things that most make it "not Laiout" are **parked by your own seats-first call** — a
deliberate GCC tradeoff (our dense fit is arguably *more* correct than Laiout's lower-density showcase), not a
bug. The free wins that close perceived gap with **no seat trade**: **b1 + b2** (efficiency accounting), **b3**
(unify circulation), the **AI-path un-neutering** (honor strategy/emphasis with explicit rooms; seed-search the
options), **wall poché**, and **furniture LOD**.

## Progress log (living tracker)
Guardrail for every generator change: workstations ≥ 80 on all A/B/C candidates, NIA ≤ GEA,
determinism, tests + timing green — verified in-browser on the real plate before merge.

- `2026-07-12` — **[done `1e65e62`]** circulation agent: `fill_untyped_as_circulation` — merges the
  whole walking area into **7 circulation polygons (was ~18 fragments), 0 stray rects**, hugging the
  angled walls; white wedges gone (untyped 7.4% → ~4%, residual is hairline wall-thickness seams, not
  triangles). Workstations at baseline (85/87), NIA ≤ GEA, deterministic, 130 tests, timing in budget.
- `2026-07-12` — **[done `9392293`]** metrics agent: fixed the efficiency-formula bug — `usable`
  now = every zone except Circulation+Core (was excluding private offices + amenity). Efficiency
  **52% → 60%** on the real plate; added an honest Usable/Circulation/Core rollup + aisle note to
  the Statistics panel. The residual gap to Laiout's ~78% is the generator's 34% circulation share
  (queued generator work) — the formula is now correct. 129 tests.
- `2026-07-12` — **[done `a1dc853`]** generator core: conformed enclosed ROOMS now re-emit their shell
  to follow the grown polygon (`reenclose_conformed_room`) — solid partitions on interior edges, glazed
  front + door on the unchanged front line, **nothing** on plate-boundary edges (the building wall
  encloses those). Fixes the latent **floating-wall bug** (a room that conformed `Rect→Poly` kept its
  walls at the old rectangle). **Seat-neutral by construction** (only walls + door move): workstations
  A:90·B:87·C:80 unchanged, scores unchanged, NIA ≤ GEA, byte-deterministic, 131 tests (+1), tsc clean.
  Honest caveat: the conforming-room **count did not rise** (1 on the real 882 m² plate) — it's
  **placement-limited**, not a fix limitation (other rooms sit behind corridors, not tight to an angled
  wall). The mechanism is proven safe for N wall-abutting rooms (`conformed_rooms_reenclose_to_the_wall_seat_neutral`);
  raising the count needs a separate, riskier placement change (parked under the seats-first decision).
- **[queued after]** workstation neighbourhoods + honest open-plan aisle→circulation carve (both
  trade against the density guardrail / lower the efficiency number honestly — attempt with care).
- **[done]** furniture (`6f01817`), cost/carbon India CAT-B (`f49248a`), residual sub-metre
  pockets (`2af78e8`).
