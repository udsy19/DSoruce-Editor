# W4 `fix/g14-generator` — pre-registration (2026-08-20)

Registered BEFORE any generator change, per `reports/editor-completion/phase0-leftovers.md` §W4.
Every number below is measured on this branch at `850a9d0` (instrument reconciliation committed,
generator untouched — byte-identical to `d868ec3` on `crates/`).

## Standing red, quoted

- `cargo test -p ds-core`: **215/215 green** (counted by name).
- `node scripts/gates/plan-quality/run-all.mjs --as-gate G14` → **G14 FAIL: 2 of 3**
  - `PQ0 PASS (14 checks)` (falsifier grew by the two unequal-size cases in `850a9d0`)
  - `PQ1 FAIL (63 checks): 63 desks -> 10 neighbourhood(s) [16, 12, 8, 8, 4, 4, 4, 4, 2, 1]; 7 outside 6-12`
  - `PQ2 FAIL (107 checks): 8 sub-minimum gap(s), 11.20 m2` — the RECONCILED red: the shipped
    instrument misread center-origin rects as corner-origin (commit `850a9d0`); its 12/12.62
    contained 8 phantoms and hid 4 real slivers. Honest rows:
    `0.40 Print1|Print2 · 0.40 Print2|Booth1 · 0.60 Pantry|Storage · 0.60 Storage|Wellness ·
     0.60 Collab|Pantry · 0.60 Wellness|Print1 · 0.60 Cabin2|Cabin3 · 0.80 Meeting2|IT/Server`
- Repro plate (wizard → furniture-plan.dwg → candidate A, `scripts/zone-dump.mjs` on :5314):
  **Unassigned 166.27 m² across 9 residuals** (dominant: the 80.43 m² south/east wall-following
  ribbon; 834+835 west 24.4; 1749-51 north 41.7; plus fingers ≤7.5) — reproduced this session,
  byte-equal to the committed `zone-dump.three-surface.postfix.json` byType.
- Dev-fixture reproduction of candidate A (headless, `Editor.restore(captured state)` →
  `generate(program, Open, seed 1)`, wall-set at fixed point): same program (93 headcount,
  50-room explicit brief, 84-desk target), `layout_diag` says: 6 regions, **135.25 m² tiling
  residue**, fill budget 19/19 exhausted, and **38 of ~50 rooms dropped** (`rooms_unplaced`:
  22 cabins, 8 team rooms, 2 meetings, pantry, wellness, 4 collabs). Candidate A is not
  byte-reproducible headlessly (the wizard's glaze-split wall evolution is sequential); the
  mechanism surface is identical and final verdicts are taken in-browser via zone-dump.

## 1 · Wing coverage (Unassigned 166.27 m²)

**Mechanism.** The maximal-rectangle decomposition stops at `REGION_MIN_DIM`(≈3.5 m effective on
the 0.5 m raster), stranding 135 m² of room-scale pockets (5.5×2.5, 5×3, 7×3, …) with no region,
no band, no pocket scan — while 38 briefed rooms drop unplaced. Fix in `regions.rs`/`layout.rs`:
a SECOND-CHANCE decomposition of the residue at room scale (`WING_MIN_DIM` = 2.0 m ≈ the 0.7
clamp of the 3.0 m support-room module − `BAND_BACK_GAP`; `WING_MIN_AREA` = 6.0 m² ≈ a clamped
cabin + gaps), appended as regions so the EXISTING allocate/band/pocket/desk machinery reaches
them. No new placement mechanism; more ground for the ones already proven.

**Expectation (registered):** zone-dump Unassigned falls **166.27 → 35–80 m²** (a small nonzero
residual is honest; 0.0 would be suspicious). Expected named survivors: the west stub
x[2,3.25]·y[10.25,16.5] (~7 m²), the top-left notch (~5 m²), the NW strip (~7 m²), and diagonal
wedge tails of the south/east ribbon that no axis-aligned program can occupy. `rooms_unplaced`
on the dev fixture: 38 → **≤ 10**.

**Falsifier (pre-registered in phase 0, restated):** if wing furnishing pushes honest circulation
outside **12–18 % NIA** on the repro plate, or breaks the containment gate, STOP and report the
tension — do not trade one red for another. Plate yardsticks 930.1 m² gross / 906 NIA must
survive; pax/desks reported old → new.

## 2 · PQ1 — target: 10/10 in-band

Offender mechanisms, measured on the demo doc (seed 7):
1. **Aisle starvation** — `max_aisles` caps cluster aisles by leftover slack, so the third aisle
   never opens and 8 columns fuse: the `[16]` cluster.
2. **Fragment runts** — obstacle-fragmented row segments of 1–2 columns pack anyway: `[2]`, two
   `[4]`s, the `[4]` pocket pair.
3. **Tail runts** — the unpaired trailing lattice line and target exhaustion mid-segment: `[4, 4, 1]`.

Fix, all inside `FieldGrid` (the ONE obstacle model, so capacity and placement cannot disagree):
structural aisles (unconditional every `cluster_cols` columns; slots pushed off the field are
bounds rejects); a segment floor under bench pairing (a contiguous pair-segment must hold
≥ `CLUSTER_MIN`(6) free slots or its slots are not free — new named reject class); pair
separation at `SECONDARY_W` (1.15 m IBC secondary aisle — the constant's own documented meaning)
instead of `clear` 0.9 so adjacent pair-blocks can never fuse; and a shared take-resolution so a
target that would strand a <6 tail is resolved identically by allocator and packer
(`placed == allocated` stays an invariant, never relaxed).

**Registered target: 10/10 neighbourhoods in 6–12** on the demo board. If any holdout survives,
it is named individually with its mechanism. Expected side effects, registered as intended:
demo desk count may drop from 63 by up to ~8 (runt slots removed); the dominant-field density on
the repro plate rises from 4.29 m²/pax toward the professional band (this IS the density fix —
reported old → new). This also moves goldens (re-captured once, at the end).

## 3 · PQ2 — target: 0 sub-minimum gaps (honest instrument)

**Mechanism.** Rooms are placed with only a MINIMUM separation (`ROOM_GAP` 0.1); the pocket scan
(0.6 m grid, nearest-circulation-wins) freely lands rooms 0.4–0.8 m apart — dead slivers. Fix in
`place.rs`: a placement invariant — a candidate room's face gap to every already-placed room must
be ≤ `PARTITION_T + GLAZING_T` (0.15, a shared wall) or ≥ `SECONDARY_W` (1.15, a walkable
passage); the band in between is rejected ground. Plus flush-snap candidates in the pocket scan
so rooms still pack shoulder-to-shoulder instead of drifting a full aisle apart.

**Registered target: 0**, else each survivor named with the pair, the true gap, and why the
invariant could not close it. Band edges (`WALL_MAX_M` 0.155 / `WALK_MIN_M` 1.1 / 6–12) are
rubric constants and are not touched.

## 4 · Chair-bound invariant (Ruling 1: ALLOW, BOUNDED)

New Rust gate over all ten golden cases: every generated Chair may project past its own zone's
edge only over CIRCULATION/ground, by at most `CHAIR_PROJECT` (0.35 m) + float slack — never into
another room-type zone. Ground truth re-derived from geometry (`zone_index_at` semantics
replicated, never `component_ids`). Current behavior satisfies it (12/128 chairs tuck 0.20 m over
zone 680's west edge, within bound), so **non-vacuity is proven by sabotage in a scratch
worktree**: raising a chair's projection past the bound, and planting a chair inside a
neighbouring room zone, must each produce exactly one red. Golden output must NOT move from this
item alone (test-only change).

## 5 · Zone 311 — pinned Unassigned verdict (Ruling 2, delegated-blessed)

Captured THIS SESSION from the unmodified generator (real_plate, `Program::default()`, seeds
1–3 — byte-stable across all three): zone 311, 63.5 m², polygon
`[[24.2485294117647,21.0191176470588],[27.25,21.25],[27.25,39],[28.0202702702703,39.1283783783784],[28.9612068965517,39.1594827586207],[30.5,38.5],[30.75,39.75],[24.2712180746562,41.3366404715128]]`
(8 vertices, widest clearing ≈ 3.25 m > 2×`SPINE_W`). Registered as a captured-shape fixture
line beside 833/794 in `gate_a2_bounded_width_on_captured_shapes`: NOT `path_shaped`, verdict
**Unassigned**. A fixture line, so the flip is intended, not incidental; reversal is one line +
a bound re-registration should Udaya overrule.

## Execution order

instrument-reconcile (done, `850a9d0`) → this registration → PQ1 (FieldGrid) → PQ2 (place.rs) →
wings (regions/layout) → chair gate + 311 fixture → goldens re-captured ONCE with per-case
justification → roster re-pin `--why` → full verification (cargo, typecheck, fences quoted,
browser verify on :5314 with provenance, zone-dump re-run + committed, G14 quoted).
