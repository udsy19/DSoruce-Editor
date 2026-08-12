# Workstream A — pre-registration (committed BEFORE any classifier code changes)

Branch `fix/wing-classifier`. Registered against the three-surface dump
`reports/editor-completion/zone-dump.three-surface.json` (commit f10f9a8), captured on this
worktree's dev server through the exact user path. All measurements below were computed from the
committed dump's polygons by an offline instrument at 0.05 m resolution; the classifier itself
runs at `CirculationConfig` cell 0.15 m, and the margin analysis uses that coarser cell.

## A1 — settled empirically before this file (finding restated for the record)

**Fixture rows 834-840/796 were instrument conflation.** On the document surface
(`Editor.state()`) and the honest stats surface (`zone_stats()`) the eight residuals are
`Unassigned · Unassigned`; on the published surface (`zone_stats_published()`) they are
`Circulation · Circulation`. Label and type move together on every surface. The old fixture's
`label: Unassigned, zone_type: Circulation` rows exist on **no** surface — they joined document
labels to published types. The invariant Gate A1 asserts already holds at the document level:
**green-by-construction**, so A1 ships as (a) a Rust invariant test proven by sabotage in a
scratch worktree, and (b) the committed three-surface instrument (`scripts/zone-dump.mjs`) whose
every emitted value carries its surface prefix.

A corollary worth stating: the *published* surface folds every `Unassigned` into `Circulation`,
so **published circulation can never move with any classifier verdict** (298.07 m² before and
after any fix, by construction). A window registered "on the folded surface" is therefore a
window on a constant — more evidence the Phase 0 window was drawn against the conflated
instrument. The honest window is re-stated below.

## A2 — the geometric discriminant (registered before implementation)

### The property

**Bounded local width: a corridor is thin everywhere.** A residual pocket is *path-shaped* only
if its own footprint contains no clear spot wider than a corridor — operationally, the maximum
inscribed disc diameter of the pocket's footprint mask (grid cells inside the polygon, distance
measured to the nearest cell outside it) must satisfy

```
max_inscribed_width ≤ MAX_CORRIDOR_WIDTH_M = 2 × MIN_CIRC_CLEAR_M = 2.4 m
```

This is a **conjunct added to** the classifier (wide-fraction ∧ connectivity ∧ compactness ∧
bounded-width). It takes over the decision for **elongated** regions, which is precisely where
the compactness scalar misfires: a wall-following ribbon wrapped around a wing is *elongated*
(compactness 0.085, corridor-like) but not *thin everywhere* (it swallows a 4.5 m clearing).
Compactness keeps its legitimate narrower role — rejecting compact clearings (a 3.8 × 3.1 m
near-square) that bounded width alone would admit at small scale. Each conjunct now states one
property; neither is asked to do the other's job.

Distinction from "a scalar is not geometry" instance 1 (gate-independence.md): the pocket-mask
distance transform was the WRONG instrument for *clearance* (a person's space extends past the
pocket boundary); it is the RIGHT instrument for *shape* — "is this footprint a path" is a
property of the footprint. The clearance conjunct (`wide_frac`) keeps using the whole walkable
mask, unchanged.

### The bound is derived, not fitted

`MIN_CIRC_CLEAR_M = 1.2 m` already exists and is code-anchored (IBC 2024 §1020.2 44 in + raster
headroom). The factor 2 is the smallest width at which a strip stops being *a* path: it can host
two full code-width paths side by side, i.e. it is floor that *contains* a path rather than floor
that *is* one. The fixture measurements below are the **check** (margins on both sides), not the
source of the number. Pre-commitment: if the margins had come out inside one grid cell of 2.4 m,
that would have been a reported finding and a re-registration, never a nudged constant.

### Evidence table (offline, 0.05 m cells, from the committed dump's polygons)

| id | origin | doc type today | area m² | max inscribed width m | compactness (RDP 0.3) |
|---|---|---|---|---|---|
| 833 | Residual | Circulation | 80.43 | **4.50** | 0.085 |
| 794 | Residual | Circulation | 7.50 | 1.90 | 0.392 |
| 796 | Residual | Unassigned | 7.19 | 0.90 | 0.228 |
| 834 | Residual | Unassigned | 10.83 | 3.00 | 0.771 |
| 835 | Residual | Unassigned | 13.56 | 1.80 | 0.202 |
| 836 | Residual | Unassigned | 5.15 | 0.58 | 0.018 |
| 837 | Residual | Unassigned | 7.44 | 1.80 | 0.649 |
| 838 | Residual | Unassigned | 11.54 | 2.30 | 0.413 |
| 839 | Residual | Unassigned | 18.36 | 1.30 | 0.078 |
| 840 | Residual | Unassigned | 11.78 | 1.60 | 0.168 |
| 664-679 | Drawn | Circulation | 1.8-18.3 | **≤ 1.50** (16 of 16) | 0.059-0.775 |

Margins at the classifier's 0.15 m cell: nearest pass 1.90 m (794) reaches at most
1.90 + 2·0.15 = 2.20 < 2.4; nearest fail 3.00 m (834) falls no lower than 3.00 − 2·0.15 = 2.70
> 2.4; 833 at 4.50 − 0.30 = 4.20 > 2.4. No verdict sits within one cell of the bound.

### Predicted verdicts (the registered predictions Gate A2 tests against)

- **Zone 833** (pts in the dump): bounded-width **fails** (4.50 > 2.4) → NOT path-shaped →
  **Unassigned**. This is the reclassification the fix exists for.
- **Drawn corridors 664-679** (shapes from the dump; production never routes Drawn zones through
  the residual classifier — the gate applies the discriminant to their shapes as fixtures):
  bounded-width **passes** on all sixteen (≤ 1.5 m). No real corridor is declassified.
- **Zone 794**, the genuinely corridor-shaped residual: 1.90 ≤ 2.4 → bounded-width passes; all
  prior conjuncts already passed → **remains Circulation**.
- **Residuals 834-840, 796**: a new conjunct can only narrow an AND — **remain Unassigned**.

### Predicted post-fix totals, on the honest surface (`zone_stats()` raw)

- Circulation: 18 → **17 zones**, 212.23 → **131.80 m²** (−80.43, zone 833 flips; = 14.5 % of
  the 906.33 m² NIA).
- Unassigned: 8 → **9 zones**, 85.84 → **166.27 m²**.
- Published surface: **unchanged by construction** (fold); Phase 0's "132-180 m² (14.6-19.9 %
  NIA)" window, reinterpreted on the honest surface, is exactly the raw circulation figure —
  prediction 131.8 m² sits at the window's lower edge, the "833 flips, 794 stays" case the
  window's own derivation described as ≈132.
- `golden_generate_output_is_frozen` is EXPECTED to move iff the golden cases produce residuals
  wider than 2.4 m; any re-capture ships with the per-case verdict diff in the same commit.

### The falsification round (all constructed negatives in a scratch worktree)

1. **Gate A2 watched red first**: the discriminant test on 833's polygon runs against the
   UNFIXED classifier and must FAIL (833 classified Circulation) before the conjunct lands.
2. **Sabotage the new conjunct** (disable bounded-width): 833 test goes red again.
3. **Sabotage the enabling step** (measure width on the whole walkable mask instead of the
   pocket's own footprint): the drawn-corridor half must go red — a corridor beside open floor
   inherits the clearing's width and gets declassified. Proves the footprint truncation is
   load-bearing, per "the falsification round must include the enabling step".
4. **Sabotage A1's mechanism** (stamp `Circulation` onto residual types after classification):
   the A1 invariant test must fire. A structurally-unavailable "true red" on the live tree is
   reported as such, not papered over.
5. **RDP sabotage** (disable boundary simplification): the compactness conjunct's existing
   guards must fire; if nothing fires, that is a missing guard to add in this workstream, not a
   pass.

## Q4 (the invisible wing) — resolved before this file, no paint change required

Differencing two renders that differ only in the eight zones' type (stateCache toggle,
byte-identical across two runs: 9,266 px both times) proves the editor DOES draw the Unassigned
hatch + dashed outline at HEAD. The wing reads empty because (a) its dominant void is zone 833 —
80.43 m² typed Circulation, which is deliberately unmarked ground; fixing the classifier is what
fixes the picture — and (b) the true-Unassigned pockets are thin wall-hugging ribbons (max
inscribed widths 0.6-3.0 m) whose deliberately subtle marks (hatch Δ16/255, 0.45-alpha dashed
hairline) read as wall shadow at overview zoom. No `paint.ts` edit; the contested-file protocol
was not invoked.
