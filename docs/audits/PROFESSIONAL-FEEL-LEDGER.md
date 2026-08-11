# PROFESSIONAL-FEEL — Ledger

Append-only. Mission: `docs/missions/PROFESSIONAL-FEEL-MISSION.md`. Branch `PROFESSIONAL-FEEL`.

Every entry states what was measured, with what instrument, over what population. A claim
without a named population is not an entry — see `.claude/rules/gate-independence.md`
("Reporting convention: scope every negative claim").

---

## 2026-08-08 · Step 0 · baseline · commit f42b196 + merge of `main`

### Intent

Establish a reproducible baseline BEFORE any product code, and re-measure the mission's
premise ("the editor looks like a colored packing demo") against the tree as it actually
stands — because that premise was written against an older tree.

### Change

No product code. Base moved: merged `main` into `PROFESSIONAL-FEEL` (was 0 ahead / 18
behind; clean fast-forward, no conflicts).

### Environment faults found and fixed (not code defects)

1. **`web/node_modules` absent in this worktree.** The first `verify-all.sh --full` run
   reported **42 of 61 red**. Every one was `tsc`/`esbuild` not found. After `pnpm install`
   the same battery ran green. *A red board whose cause is a missing dependency is not a
   measurement of the code* — the number to quote is the post-install one.

2. **`wasm-pack` was an x86_64 binary** while `cargo`/`rustc` are arm64. It ran under
   Rosetta, its child `cargo build` inherited x86_64, so `/usr/bin/cc` launched its x86_64
   slice and could not `dlopen` `libxcrun.dylib` (which ships arm64/arm64e only).
   `make wasm` failed with 8 × `linking with 'cc' failed`, looking exactly like a code
   break. Fixed by `cargo install wasm-pack --force` (now native arm64). `make wasm` green.

### Baseline measured (post-merge, post-fix)

| Metric | Instrument | Value |
|---|---|---|
| Rust suite | `cargo test -p ds-core` | **206 passed, 0 failed** (CLAUDE.md records 198) |
| Standing battery | `bash scripts/verify-all.sh --full` | **61/62 green, exit 0** |
| — skipped, named | | `supabase/tests/rls.test.mjs` — no reachable Postgres. Tenancy RLS; explicitly out of mission scope. |
| Typecheck | `tsc --noEmit` (inside battery) | green |
| wasm | `make wasm` | green |

### Generated-plan census — seeded demo plate, seed 7

Population: `scripts/lib/demo-doc.mjs` → `samplePlan.json`, a **synthetic 40 × 24 m
rectangular plate, 960 m²**. This is NOT the real irregular DWG plate (`samples/
furniture-plan.dwg`) the mission's §1.1 rubric names. Scope every claim below accordingly.

| Metric | Value |
|---|---|
| Walls / components / zones | 97 / 206 / 24 |
| Workstations (`score.placed_desks`) | **63** |
| Desks / Chairs in Open Workspace | 63 / 63 |
| Floor area | 960 m² |
| Enclosed rooms | 20 (all `shape.kind == Rect`; 0 Poly) |
| Circulation zones | 2 — Corridor 57.3 m², Entry 6.2 m² (**63.5 m² drawn, 6.6% of plate**) |
| Open Workspace zone | 1 × 668.5 m² holding all 63 desks |
| Doors | present, one per enclosed room, passable in the circulation grid |
| Glazing | Glass 27.1 m over 20 segments (`quantities()`) |
| Drywall | 158.7 m over 65 segments |
| Layout score | total **79.37** — capacity 100, density 100, program_fit 100, adjacency 85.40, circulation 79.73, daylight 42.86, entry_adjacency 47.60 |
| `circulation()` | score 87.63, **min_corridor_width 0.30 m**, **pct_corridors_below_min 0.501**, circulation_ratio 0.862, entry_reachable 0.9987 |
| Determinism | `plan.png` and `plan.repeat.png` byte-identical |

Unfurnished rooms (0 non-door components by core membership): **130 IT/Server, 137 Storage,
144 Wellness Room**.

### §1.1 visual acceptance, scored against the rendered artifact

Instrument: `node scripts/render-plan.mjs` — the app's own `planGraphic.ts` in headless
Chromium, then read the PNG. Artifact: the qbiq deliverable plan, not the editor view.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Rooms read as architecture | **PASS** (room band) | partitions with thickness, glazed fronts, door + swing per room, zone tint — all legible in the render |
| 2 | Desks read as neighbourhoods (6–12 clusters) | **FAIL** | one 668.5 m² Workspace zone; render shows a monolithic field of uniform rows across the plate |
| 3 | Circulation reads as one network | **FAIL** | 63.5 m² drawn circulation on a 960 m² plate; `min_corridor_width` 0.30 m; 50.1% of corridor cells below minimum; no spine legible through the desk field |
| 4 | Alignment / module discipline | **PASS** | module-snapped, rooms in depth bands, no jitter visible |
| 5 | Line hierarchy | **WEAK** | shell (lavender) reads *lighter* than the yellow partitions — inverted vs "shell heavy, partitions medium, furniture hairline" |
| 6 | 2D/3D/stats/exports one Document | not measured | — |
| 7 | A/B/C spatially different | not measured | `strategies_are_structurally_distinct` asserts a desk-COUNT spread, not spatial distinctness |

### Two false defects caught before they were recorded

Both would have been reported as real had the check stopped at the image:

- **Bare numeric room labels** (30, 39, 55…) read as a debug view. They are **correct**:
  they are `Room ID` keys cross-referencing the workbook's BOM and Inventory sheets
  (`workbook-spec.md` L171/L204), enforced 1:1 by G3. Real names ride in `rooms[].label`
  ("Reception", "Meeting Room 1", "Focus Room 1").
- **Rooms 145/147 render as empty boxes** — and 145/147/155/171 are the exact four rooms in
  `gate-independence.md`'s E7 worked case. They are **Print Point 1/2**, each holding one
  Table; the rounded box *is* the table glyph. Not the E7 defect resurfacing.

### Instrument failure, reported not hidden

A first census keyed components to zones by comparing `component.x/y` against
`zone.shape.x/y/w/h`. It returned `NaN m²` and 0 components everywhere (wrong field names),
and after that was fixed it still disagreed with the core's own `component_ids` — zone 12
holds 3 members but scored 1, because component coordinates are centre-based while
`zone.shape` is corner-based. **The geometry column was discarded, not averaged in.** Every
census number above comes from `zone.component_ids`, which is the core's own answer.

### Guardrail status

Dense seats: n/a, no generator change. NIA ≤ GEA: not re-derived this entry.
Determinism: verified (byte-identical repeat render).

### Falsification run

None — no product code changed. The battery's own lying-gate fixture (`GATE_SELFTEST`)
was not exercised this entry.

### Finding that reframes the mission

The mission's §5 build checklist is **~90% already landed**, under `M1`–`M7` commit names
rather than the `pro-feel(*)` prefix the doc specifies — all ancestors of HEAD:
`Wall.generated`, `Wall.glazing`, `emit_room` with doors, doors passable in the circulation
grid, `SPINE_W = 1.5` + secondary aisles + entry connector, `Document.entries`,
`cluster_cols` packing, 0.05 m module snap with discrete seed choices, `Strategy`
{Open,Balanced,Cellular}, `dynamicInput.ts` with polar snap, command palette, inspector,
click-a-dimension-to-edit.

Genuinely unbuilt: **`density: dense | showcase`** — zero hits repo-wide outside the mission
doc. Note it overlaps `Strategy`, which already trades seats for enclosure; the two need
reconciling before either is extended (no-bloat).

**But the mechanisms landing did not deliver the outcome.** §1.1 criteria 2 and 3 — the two
that carry "professional feel" — fail on measurement. The commit messages were true about
mechanisms and silent about result, and nothing in the tree had ever looked at the plan.
That gap is the mission.

### Open risks

- Findings 2/3 are measured on the **synthetic 40 × 24 plate**. They are geometry-level and
  likely transfer to the real irregular plate, but that is an expectation, not a measurement.
- No editor-view or paper-mode capture yet; §1.1 names both.
- `zone_stats_published` reports `seated: 0` for every enclosed room while chairs are placed
  (Meeting Room 1: capacity 10, 8 chairs, seated 0). Not chased this entry; may be the
  ROADMAP's open "briefed seats vs placed seats" item.

---

## 2026-08-08 · WS-T · plan-quality board G14 (PQ0-PQ2) · gate-first, shipped red

### Intent

Convert §1.1's two failing criteria — neighbourhoods and circulation legibility — from prose
into a gate, **written before any generator change and watched fail**, so the eventual fix is
calibrated against the rubric rather than against whatever the fix produces.

### Change

New board `scripts/gates/plan-quality/` — `checks.mjs` (the two checks, ONE implementation),
`run-all.mjs` (board), `falsify.mjs` (sabotage + falsification). Folded into
`scripts/gates/run-all.sh` as row **G14**, and registered in `reconcile.mjs`'s `RUNNERS`.

- **PQ1 — desk neighbourhoods.** Partitions desks into connected components where two desks
  are linked iff their footprint gap is below the walkable aisle minimum. A cluster is then
  exactly a group you cannot walk into the middle of. Asserts every cluster is 6-12 (§1.1.2).
- **PQ2 — no sub-minimum room gaps.** Every gap between two rooms must be a shared wall
  (≤ 0.155 m, from `PARTITION_T = 0.1` / `GLAZING_T = 0.05`) or a usable passage (≥ 1.1 m,
  the mission's secondary-aisle figure). Anything between is floor that is billed and cannot
  be used.
- **PQ0 — the sabotage round, re-run on every board execution**, as SG5 re-runs GSELF. An
  independence proof that ran once at authoring time is a claim, not a measurement.

### Measured — day one, unmodified generator

```
PQ0 PASS (12 checks): sabotage round holds
PQ1 FAIL (63 checks): 63 desks -> 10 neighbourhood(s) [16, 12, 8, 8, 4, 4, 4, 4, 2, 1]; 7 outside 6-12
PQ2 FAIL (91 checks): 12 sub-minimum gap(s), 12.62 m2
G14 FAIL: 2 of 3 plan-quality check(s) red
```

Population widened to seeds 7, 11, 23, 42 — **both checks fail on all four**, so the defect
is structural, not a seed fluke:

| seed | neighbourhoods | offenders | sub-minimum gaps |
|---|---|---|---|
| 7 | [16, 12, 8, 8, 4, 4, 4, 4, 2, 1] | 7 | 12, 12.62 m² |
| 11 | [16, 16, 6, 6, 6, 5, 3, 3, 2] | 6 | 9, 6.23 m² |
| 23 | [12, 12, 10, 8, 8, 6, 2, 2, 2, 1] | 4 | 9, 6.23 m² |
| 42 | [14, 14, 12, 9, 8, 6] | 2 | 9, 6.23 m² |

### The gate corrected the defect report — again

The Step-0 entry above called the desk field "monolithic", read off the render. **It is not.**
PQ1 finds ten neighbourhoods; the defect is that seven are mis-sized (one 16, and a tail of
4/4/4/4/2/1), not that clustering is absent. Seed 42 gets within two offenders. That changes
the fix from "add clustering" to "regularise cluster sizes" — split the oversized, merge the
fragments — and it is the E7 pattern exactly: a prose label is a scalar, and the table beat it.

PQ2 likewise found **12** gaps where the hand table found 9, because the hand pass waved
through the 1.00-1.05 m pairs as "marginal". They are below the cited standard; the gate does
not get to round in the generator's favour.

### Falsification run

`node scripts/gates/plan-quality/falsify.mjs` — **12/12, exit 0.**

Sabotage (verdict tuple must be byte-identical): S1 blanked every zone label · S2 destroyed
every component label · S3 corrupted `seats`/`decision` · S4 flipped every `wall.generated`
· S5 emptied every `zone.component_ids` · S6 **deleted** those fields outright rather than
corrupting them. All six identical.

Falsification (the gate must go both ways): N1 a clean synthetic plan goes GREEN on both
checks — proving neither is vacuously red · N2 injecting one 0.50 m sliver reds PQ2 with
exactly one row · N3 closing one aisle reds PQ1 with a 16-desk super-cluster · N3b an aisle
of **exactly** 1.10 m stays separate, pinning the boundary so the gate cannot demand more
than the standard it cites · N4 asserts the clean case actually inspected 24 desks, so a pass
cannot come from having looked at nothing.

**The round caught a real bug in its own fixture.** N3's first attempt shifted desks 1.6 m,
which puts the aisle at exactly 1.10 m — where the merge correctly does not fire. The
boundary was behaving properly and the *sabotage* was too weak. That failure is why N3b now
exists as a permanent boundary pin.

### Reconciliation with the existing suite

Adding the board turned `reconcile.mjs` red — correctly: *"`falsify.mjs` exists, passes, and
NO runner invokes it. A gate nobody runs has never graded a commit."* Resolved by making the
board run its own sabotage round (PQ0) rather than by adding an exemption. Reconcile now
reports **"27 gates on disk, all invoked; board declares 14 rows against 14 commands and 14
titles"**.

### Guardrail status

Dense seats: unchanged, no generator change (63 desks before and after). Determinism:
unchanged. NIA ≤ GEA: not touched.
Standing battery after the change: **`verify-all.sh --full` 61/62 green, exit 0**, 1 skipped
and named (`supabase/tests/rls.test.mjs`, no Postgres). Rust 206/206.

### Why it ships red

House precedent is explicit — `composition.mjs` and `cost-reconciliation.mjs` are both
QUARANTINED and red at HEAD, on the stated grounds that writing the fix first produces a gate
calibrated to the fix. G14 is red for the same reason. Its redness is a **generator** change,
not a gate fix. `verify-all.sh` does not run the deliverable-pack board, so the standing
battery is unaffected.

### Open risks

- **PQ2 trusts `zone.zone_type`** to select rooms (excluding Circulation/Workspace/Core).
  Documented in `checks.mjs`, not hidden. Direction of trust is safe — corrupting a type can
  only remove pairs from consideration, never falsely accuse — but a genuine sliver beside a
  mistyped zone would be missed. Closing it needs enclosure re-derived from wall geometry.
- Both checks run on the **synthetic 40 × 24 plate** only. The real irregular DWG plate is
  still unmeasured, and §1.1 names it.
- PQ3 (spine connectivity) and PQ4 (line hierarchy) from the proposed L3 layer are **not
  built**. §1.1 criteria 3 and 5 remain unguarded; criterion 3's evidence so far is the
  `circulation()` summary, which is the core's own account and not gate-grade.

---

## 2026-08-08 · WS-V · editor UI appraisal · NO CODE SHIPPED (one change attempted and reverted)

### Intent

Answer "how do we make the editor UI more appealing, like qbiq / Rayon / Laiout" by driving
the real path on the real plate, then fix the highest-leverage findings.

### What was driven

Real wizard path, `samples/furniture-plan.dwg` (2.6 MB; the 15 MB DXF exceeds the browser
bridge's 10 MB limit). Imported → 930 m², 525 components, 4 rooms, program auto-detected
(78 desks / 14 conference / 34 collaboration / 17 amenity). Generated A/B/C, opened
candidate A, inspected 2D + 3D. Dev server on **:5190** (never 5173), build identity asserted
with `verify-preflight.sh` before every cited capture.

### Result: FIVE findings raised, FOUR retracted on measurement

This entry is mostly a record of being wrong, which is the useful part.

| # | Claim | Verdict |
|---|---|---|
| 1 | 2D opens "crammed left" | **RETRACTED.** Plan is centred. Span 37.9 × 42.4 m (portrait) in a 1273 × 872 px (landscape) canvas — side gutters are geometry, not a bug. `entityCount: 0`, so the stray-CAD-entity hypothesis was also wrong. Residual: canvas was 777 px at frame time and 872 px after, so the plan sits ~12% smaller than it could. Real but minor. |
| 2 | Zone fills too saturated vs Laiout | **RETRACTED, and it would have made things worse.** `planStyle.ts` records the measured gap the other way: all fills but ClosedOffice sit UNDER the reference band, and "the correction is MORE saturation, not less". My "Laiout is paler" was an unmeasured impression. |
| 3 | Line hierarchy inverted (shell lighter than partitions) | **UNVERIFIED.** Not measured; stated as impression only. Do not act on it without a measurement. |
| 4 | Zone labels collide; `OPEN.` is truncated | **HALF RETRACTED.** `OPEN.` is `abbreviate()` — "the reference's own abbreviation shape", deliberate. The placement system scores a 10×10 anchor grid for clear floor and has a knockout-halo fallback. The label-over-desks case on the real plate is real but its cause was not isolated. |
| 5 | Unassigned ground reads as construction hatch | **UNVERIFIED.** Not measured. |

**The pattern:** every impression that could be checked against a measurement in this repo
lost to it. This codebase is considerably more deliberate than a visual read suggests, and
`planStyle.ts` / `paint.ts` already encode the reference's own rules with their reasoning.

### The one change attempted, and why it was reverted

`Viewer3D.frameAllPose()` — two edits: (a) choose the camera AZIMUTH from the plan's aspect
so the longer footprint axis lands on the longer screen axis, (b) recentre the aim on the
PROJECTED extent rather than the 3D box centre, because a flat slab at three-quarter view
projects asymmetrically.

The diagnosis was sound and measured: box centre projected to NDC (0, 0) while the corners
spanned y −0.90…+0.35, so the model hugged the bottom edge.

**It shipped a regression and was reverted.**

| state | coverage | clipped |
|---|---|---|
| stock, on open (the control) | 64% × 65% | **no** |
| stock, after pressing Frame | 67% × 63% | no |
| changed, after pressing Frame | 87% × 63%, NDC symmetric | no |
| **changed, on open** | 105% × 96% | **YES — model clipped at two edges** |

The recentring drove the aim to y = −5.4 m (below a slab spanning y 0…2.6), and the
containment guard I had written specifically to prevent that did not fire. I could not
explain why, and **a framing change that clips the model on open is worse than one that
wastes margin**, so it was reverted rather than shipped on a partial understanding.

**The control was taken last, which is the process error.** I measured "after Frame" states
for three variants before ever measuring stock-on-open, and so spent the whole investigation
believing the baseline was catastrophic (the "55% empty sky" in the first report) when it is
merely wasteful and correctly contained. Take the control first.

### Findings that stand, unfixed

- **3D framing wastes ~35% of the frame** (64% × 65% coverage) and sits low-right rather than
  centred. Real, modest, and the recentring idea is probably right — but it needs a fix whose
  containment guard is understood, not assumed.
- **The 3D toggle needs TWO clicks after a page load.** Reproducible across every reload this
  session; the first click never mounts the viewer.
- **The same saved plan yields different metrics on each open.** Three consecutive opens of
  one URL, no regeneration: NIA 906 → 879 → 879 m²; Open Workspace zone 434 → 407 m²;
  efficiency 61% → 60%; total cost **₹1,80,32,644 → ₹1,76,54,224 → ₹1,76,35,704**. This is a
  determinism/persistence defect and it outranks every UI item in this entry.
- **A/B/C thumbnails are near-identical** while seats differ 115 / 100 / 84 — §1.1.7, same
  root as PQ1 rather than a UI problem.
- **`planStyle.ts` cites a spec that does not exist.** The ZONE palette claims provenance
  "spec `laiout.palette` … two owner app views agreeing to the exact hex, sampled losslessly".
  No such resource is anywhere in the tree — the only file mentioning `laiout.palette` is the
  file making the claim. Meanwhile `docs/design/laiout-visual-system.md` carries materially
  PALER hexes (`#E8EEFC` vs `#bdddfb`). Two disagreeing palettes, one unresolvable citation:
  a level-3 failure under CLAUDE.md §3.6.3, and exactly the "a comment is a claim to verify"
  case. `bench/style-progress/2e-laiout-palette.png` does not settle it — it is a capture of
  OUR app at Phase 1, not of Laiout.

### Guardrail status

No product code changed. `Viewer3D.ts` is byte-identical to HEAD (experiment stashed, measured,
dropped). Battery after: **`verify-all.sh --full` 61/62 green, exit 0**, 1 skipped and named.
G14 still red as designed.
