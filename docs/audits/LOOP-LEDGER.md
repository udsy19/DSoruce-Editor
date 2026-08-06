# Circulation workstream — run-to-completion ledger

Append-only. One entry per queue item. Handoff artifact if any HALT fires.

Standing rulings in force: `§2` of the loop brief — classifier (Reading B @ 50%,
τ = 3π/16, RDP at 0.3 m); efficiency never redefined; fold rule; `Residual` is
generator-only; hatch ink registered met; ground carries no resting tag;
medial-axis parked; G10 human-written; C1–C10 → G13; BOMA band is context.

---

## A1 — Core poché disposition · **DONE** (`8112d25`, landed prior turn)

**Decision procedure executed.** `research/qbiq-plan-style-spec.json` →
`wall_poche`: *"There is NO dark poche anywhere in the reference. Walls are drawn
as thin DOUBLE LINES with unfilled interiors."* The only poché/hatch the spec
sanctions is between **wall faces** (Rayon grammar). `core` appears in the spec
exactly once — `"role": "core/service"`, a palette entry — with no texture.

**Verdict: spec SILENT on core-floor poché → editor-only.** Paper gets
`corePoche: null`; the editor profile keeps it as the documented divergence.
Not a HALT: no spec entry contradicts both readings.

Consequence recorded: every paper-parity judgment in this workstream — including
Phase 0's "presentation output is already fully correct" — was measured against a
render where the poché was dead. Null on paper keeps those judgments valid; the
alternative branch would have required re-measurement, golden re-capture and a
C-board note. Ramp fix stays regardless, as ruled.

`corePoche` is now a per-profile field, not a module constant.

## A2 — renders-at-all smoke · **DONE with a gap, closed below**

`web/src/editor/fillRenders.test.mjs`. Every declared fill must be able to draw;
pins the exact trap (`hatchLevel(0) == 0`).

Falsified prior turn: paper re-declaring `corePoche` → red (spec citation);
declared hatch at α 0 → red.

**GAP against this brief:** the brief's required sabotage is *re-break the ramp
(`referencePx = 0`) and watch it red* — the sabotage that reproduces the original
defect. Not run. Closed in entry **A2b**.

## B1 — 2.2 tag suppression · **DONE with a gap, closed below** (`2b028d3`)

Measured by the `zone_stats` census method, not screenshot counting:

| | tags at rest | of which ground |
|---|---|---|
| before | 24 | **17** (9 CIRCULATION, 8 CORRIDOR) |
| after | **7** | **0** |

Remaining seven: CABIN · BOARDROOM · RECEPTION · TEAM ROOM 1 ·
OPEN WORKSPACE (1) · CORE 1 · CORE 2 — all program rooms.

Selection exception threaded through the highlight set `drawZoneTags` already
uses. Verified on the 80.43 m² circulation `Poly` (tag returns on selection).

**GAP against this brief:** the brief requires verifying selection on a corridor
**AND an unassigned pocket**. Only circulation was checked. Closed in **B1b**.

Pre-existing limit recorded, not a regression: a thin corridor (widest here
0.6 m × 30.5 m = 11 px) shows no in-plan tag even when selected, because the
text-fit rule predating this work refuses a name that cannot fit. Still
selectable (`zone_at` returns it).

## A2b + B1b — gaps closed · **DONE**

**The A2 smoke did not catch its own defect.** Running the brief's required
sabotage (re-break the ramp, `referencePx = 0`) against the guard as written:
**PASS**. It inspected the style table — alpha > 0, spacing > 0, `hatchLevel(40)`
— and a call site that discards the table is invisible to a table inspection.
The guard for the fifth sighting would not have caught the fifth sighting.

Rewritten to exercise `drawZones` against a recording context, differencing the
same scene with and without the texture. **Three iterations, each caught by a
sabotage that should have failed and didn't:**

1. *Two bundles.* `planStyle` and `paint` were bundled separately, so each had
   its own copy of the style table; mutating one never reached the other, both
   runs rendered identically, and the difference measured nothing. Caught because
   the guard fired on known-good code. → single bundle re-exporting both.
2. *Counting calls, not marks.* `fillWith` emits `save`/`beginPath`/`rect`/
   `clip`/`restore` **before** consulting the LOD ramp, so a dead texture still
   raised the call count by five while putting no ink down. The ramp sabotage
   passed again. → count only `stroke`/`fill`/`fillRect`/`strokeRect`/`fillText`.
3. Third run: ramp sabotage **RED**, with the diagnostic naming `hatchLevel(0)`.

Falsified, all in disposable worktrees:

| sabotage | result |
|---|---|
| `referencePx = 0` (the original defect) | **RED** — "2 marks with vs 2 without" |
| paper re-declares `corePoche` | **RED** — spec citation |
| declared hatch at α 0 | **RED** — "would draw invisibly" |
| `suppressTag` ignores selection | **RED** — "a corridor you cannot name…" |
| `suppressTag` over-reaches to program | **RED** — "suppression over-reached" |

**B1b:** the selection exception is now asserted for **both** ground types
(Circulation and Unassigned), not just the circulation poly checked by hand, plus
a program-zone control proving suppression does not over-reach.

**Instrument discipline note:** three contradictory-then-corrected iterations on
one guard, each exposed only by running the sabotage. This is the second time
this cycle that an instrument, not the subject, was the finding. The brief's
"sabotage every enabling transform" is what produced all three.

## B2 — 2.3 `renderThumb` ground rule · **DONE**

Candidate cards were the last surface still contradicting figure/ground, and the
first thing anyone sees.

Colour census of the live card thumbnails (build-identity probe first, then
`drawImage` + histogram of the actual data-URLs — the same method that measured
the defect in Phase 0):

| | `#d8d8d8` (Circulation fill) |
|---|---|
| Phase 0 | **1 226 px** per card |
| now | **0 px**, all three cards |

Top colours now: `#ffffff` 21 048 · `#d9e7f4` Workspace · `#d1f1d5` Core ·
`#6e9af0` desks · `#f6dadf` ClosedOffice — every one a program mark.

Reads the **paper** profile deliberately: a card is a miniature sheet, not a
working surface, so it takes no editor affordances (no ground tint, no hatch).

Guard: `fillRenders.test.mjs` asserts `renderThumb` consults `groundZones` at
all. Node has no 2D context, so the pixel proof is the census above rather than
a unit assertion — stated rather than papered over.

Evidence: `B2-after-candidate-gallery.png`, `B2-thumb-A-zoom.png`.

**Discipline miss, self-caught and recorded.** The first B2 commit went in with
the style gate RED. My verification line chained `node bench/style-gate.mjs &&
echo OK`, the echo did not print, and I read past it. The gate was correct: I had
written the Circulation hex into comments in `paint.ts` and `fillRenders.test.mjs`,
and the palette is banned by VALUE — comments included, per the amber ruling.
Amended, gate green. The lesson is the one already in this file about success
messages: **a verification step that can silently not-run is not a verification
step.** Check exit codes explicitly, never by the presence of a chained echo.

## B3 — 2.4 3D ground floors · **DONE**

`buildZonePlate` resolves `zoneFloorMats.get(type) ?? floorBaseMat`, so the
change is to stop ALLOCATING a material for ground rather than to change one:
ground falls through to the neutral base. `NEUTRAL_FLOOR_ZONES` in `theme.ts`,
consulted by `Viewer3D.applyTheme`.

`floorByZone` keeps all eight keys in all four presets — `ViewerToolbar` reads
`floorByZone.Circulation` for its per-theme swatch, and deleting a key to change
a material would break an unrelated consumer.

Guard `src/three/groundFloors.test.mjs`: the set is exactly the two ground types;
all 4 presets carry all 8 keys plus `floorBase`; and **Viewer3D actually
references the set** — a set nobody reads is a declaration, and this cycle has
already shipped one of those.

| sabotage | result |
|---|---|
| Viewer3D stops consulting the set (the enabling step) | **RED** |
| a preset drops its `Circulation` key | **RED** — names the toolbar swatch |

Evidence: `B3-3d-studio-neutral-ground.png`. **Caption is honest:** the Frame
control did not re-fit the camera, so this is a close view rather than the whole
model; what it shows is the floor plane uniformly neutral with no cool-blue
circulation carpet, which is the assertion. A properly framed shot is produced in
the F2 gallery pass, where viewports are normalised (this capture came back
1200×744 against Phase 0's 1600×1000, so no pixdiff was possible here).

## B4 — 2.5 `printPlan` roomLabels · **DONE**

The audit flagged this as **latent**: the fill branch honours the ground rule
(measured 1 px of composited circulation grey across 1400×1000), the roomLabels
branch did not — it printed `z.label` for any `Rect` clearing a size gate, with
no ground check. Residual pockets are `Poly` and escaped by accident; the DRAWN
network (`Corridor`/`Entry`/`Aisle`) is all `Rect`.

**Falsified live rather than argued.** `B4-corridor-on-sheet-probe.mjs` renders a
14 m × 4 m corridor through the real `renderPrintCanvas` with a text-recording
context:

| | sheet text |
|---|---|
| before | `["CORRIDOR", "BOARDROOM"]` — `corridorOnSheet: true` |
| after | `["BOARDROOM"]` — `corridorOnSheet: false` |
| ground check removed again | `["CORRIDOR", "BOARDROOM"]` |

On the reference plate no corridor cleared the gate, which is why it never fired
— a property of one plate at one scale, not a fix. The probe builds the plate
that triggers it instead of waiting for one to arrive.

Guard `src/export/printLabels.test.mjs` asserts the branch consults the ground
rule **and** keeps its fit gate (so the fix cannot degrade into "label everything
that is not ground"). Its own first run failed on the fit-gate assertion because
the comment I added pushed the gate past the 900-char slice — the guard reported
"the gate vanished" when the gate had merely moved. Slice widened, and noted:
**a source-slicing assertion is a positional assumption, and positions move.**

Probe kept at `docs/evidence/circulation-audit/B4-corridor-on-sheet-probe.mjs`.

## B5 — 2.6 legend parity across all three surfaces · **DONE**

Three independent legend implementations, found by the audit in three different
states: app panel listed Circulation, `pdf.ts` correctly excluded ground,
`report.ts` listed it deliberately ("qbiq lists rooms first, circulation last").
A legend is the ONLY identification a sheet carries, so three surfaces
disagreeing about what a plan contains is worse than any one being wrong.

`report.ts::LEGEND_ORDER` drops `'Circulation'`. `'Unassigned'` is absent for a
second, independent reason — it never reaches a published surface at all, so if
it ever appears there the fold was bypassed.

`legendParity.test.mjs` is a CENSUS, not three assertions: each surface is
program-only **and** the app and report legends must list the identical set.

| sabotage | result |
|---|---|
| `report.ts` re-adds Circulation | **RED** |
| `pdf.ts` stops skipping ground | **RED** |
| app `legendEntries` stops excluding ground | **RED** |

All three surfaces now agree: 6 program entries.

## B6 — 2.8 style-gate extension · **DONE** (Phase 2 closed)

New check: no file outside the style table may read `ZONE.Circulation.fill` or
`ZONE.Unassigned.fill`.

Deliberately NARROW. The entries still hold values — a ground zone falls back to
them when drawn as figure (selection/hover) — so the ban is on reading `.fill`
off a **ground** entry specifically. `ZONE.Workspace.fill` is fine.
`ZONE[z.zone_type]` is fine: that is the polymorphic path every renderer uses,
and the ground decision happens before it. A broader rule would have flagged the
correct code and taught people to silence the gate.

This is precisely what `renderThumb` did for the life of the candidate gallery
(B2), so the gate now forbids the shape of that defect.

| sabotage | result |
|---|---|
| a renderer reads `ZONE.Circulation.fill` | **RED** — `GROUND FILL: …paint.ts` |

Own bug, caught by running it: `TABLE` was block-scoped to the earlier
palette-copy check, so the new block threw `ReferenceError` — the gate CRASHED
rather than passing, which is the good failure mode, but it would have been read
as "gate broken" not "gate says no". Scoped locally.

**Phase 2 complete: 2.1–2.8 all landed.**

## ⚠ PARKED BLOCKER — `generate` performance regression from the classifier

**Not a HALT** (no invariant moved, no registered value needs changing), but a
live defect I introduced and did not detect until B6's verification.

`layout::tests::real_building_plate_spreads_the_program` asserts a 300 ms
debug-build budget for `generate`, with one retry. Measured:

| tree | full parallel suite |
|---|---|
| pre-workstream `425232c` | **157 passed, 0 failed** |
| HEAD | **168 passed, 1 failed** — "seed 3: generate took 336 ms (debug budget 300)" |

**CORRECTED after more runs.** I first wrote "fails consistently under the
parallel suite" on the strength of two consecutive failures. Measured properly:
**3 pass / 1 fail across 4 full-suite runs**, plus 3/3 in isolation. It is
INTERMITTENT, not deterministic — a margin sitting just under the budget that
crosses it under load. The correction matters rather than being pedantic: an
intermittent budget failure reads as flake and gets ignored, which is the more
corrosive failure mode.

Attribution is still not inferred: the pre-workstream baseline was run in the
same worktree under the same parallel conditions and was green 157/0, while HEAD
produced "seed 3: generate took 336 ms (debug budget 300)" — 12% over.

**Mechanism.** `conform::classify_residual_zones` builds a `WalkClassifier` on
every `generate`: a 0.15 m occupancy grid over the padded wall bbox (`≈10⁵` cells
on this plate), a chamfer distance transform, a BFS, then a point-in-polygon
sweep per pocket. That is new work `generate` did not previously do.

**Why I did not just fix it.** The obvious lever is the grid cell size, which
comes from `CirculationConfig::new()` (0.15 m). Coarsening it would change
`wide_frac` for every pocket and therefore verdicts — including the two
pre-registered outcomes (847 stays Circulation, 848 flips). Cell size is not in
§2's registered list, but changing it moves registered results, so it is a
re-registration question, not a free optimisation.

**Recommended ruling / fix, in preference order:**
1. **Verdict-preserving optimisation.** Profile `walkable_grid`'s zone stamping
   (per-zone bbox iteration calling `shape.contains` per cell) — likely the hot
   loop, and reducible without touching resolution. Preferred: no re-registration.
2. Compute the classifier lazily per residual region rather than one global grid,
   if connectivity can be answered on a reduced mask without changing answers.
3. Only if 1 and 2 fail: a ruling on classifier grid resolution, with the full
   validation round re-run (three plate families + the two binding outcomes).

**Explicitly NOT done:** raising `BUDGET_MS`. Relaxing a budget to accommodate a
real slowdown is the move this programme forbids.

**Second discipline miss, same shape as B2's.** The B6 verification chained
`cargo test … | grep "test result"` and I read the line without checking it said
`ok`. It said FAILED, and the commit went in anyway. Both misses this loop have
the same cause: **reading a summary line instead of an exit code.** Every
verification step in the remainder of this loop checks `$?`.

## C4 — daylight mirror registered in `coreParity` · **DONE**

`score.rs`'s `DAYLIGHT_REACH_M` (5.0) and `report.ts`'s `DAYLIGHT_RADIUS_M` (5)
both answer "is this desk daylit?". They must agree or the Rust sub-score the
optimiser maximises and the KPI the client report prints describe different
buildings. `score.rs` already carried the claim in prose; CLAUDE.md is explicit
that **a `mirrors X` comment is a claim to verify, not documentation** — and it
had never been registered.

Found in the Phase 0 audit as a live unpinned mirror. Now pinned.

| sabotage | result |
|---|---|
| Rust 5.0 → 7.0 | **RED** — `rust: 7 / ts: 5` |
| TS 5 → 9 | **RED** — `rust: 5 / ts: 9` |

---

# E1 — final quantitative restatement

Measured on the DXF reference plate through the wizard; core numbers unchanged
since Phase 1b (B2–B6 are renderer-only and touch no core value).

| quantity | Phase 0 | E.2 predicted | Phase 1 | **Phase 1b (final)** | registered? |
|---|---|---|---|---|---|
| Circulation, honest | 295.89 m² (26 z) | 125–170 | 231.43 (20 z) | **213.16 (18 z)** | — |
| — network (drawn) | 125.23 | unchanged | 125.23 | **125.23** | ✔ unchanged |
| — residual kept | 170.66 | — | 106.20 | **87.93** | — |
| Unassigned | 0 | 130–160 | 64.47 | **82.74 (8 z)** | ✘ missed, mechanism recorded |
| Circulation, published | 295.89 | — | 295.89 | **295.89** | ✔ byte-exact |
| `efficiency_pct` | 61.63 | 57–60 ↓ | 61.63 | **61.63** | ✔ invariant (prediction wrong) |
| `unassigned_pct` | — | — | — | **9.11** | new, internal only |
| Workstations | 101 | 101 | 101 | **101** | ✔ invariant |
| Candidate A / C / B | 88 / 87 / 86 | — | 87.14 / 85.92 / 85.71 | **A > C > B** | ✔ ordering preserved |
| Zone tags at rest | 24 (17 ground) | — | — | **7 (0 ground)** | ✔ |
| Card `#d8d8d8` px | 1 226 | — | — | **0** | ✔ |

**Three predictions missed, all with mechanism recorded, none absorbed:**
1. `efficiency_pct` invariant, not ↓ — circulation was already outside `usable`.
2. Unassigned 82.74 not 130–160 — §E.1's DT was computed *within* each pocket.
3. `zone_index_at` tie-break broke nothing — residual pockets are disjoint by
   construction, so it never fires.

Each came from a scalar standing in for geometry; each was corrected by a table.
That pattern is now `.claude/rules/gate-independence.md` § *A scalar is not
geometry*.

# Queue state at stop

**Complete:** A1 · A2 (+A2b) · B1 (+B1b) · B2 · B3 · B4 · B5 · B6 · C4.
Phase 2 (2.1–2.8) is closed. Nine committed items, each with its own commit,
falsification and sabotage round.

**Parked with written blocker:** the `generate` perf regression (above), with a
three-step fix ladder, verdict-preserving options first.

**Not reached — no blocker, simply not built:**
- **C1–C3** (Phase 3 promotion: shared KPI module, on-screen metrics card with
  average ticks, candidate-card headline trio). Substantial UI work; `report.ts`
  already holds the computations, so this remains a promotion, not construction.
- **D1–D3** (C-board: `scripts/gates/circulation/run-all.mjs`, C1–C10, G13 fold,
  lying gate, board sabotage).
- **E2** (golden provenance stamp), **F2–F4** (gallery, discovered-not-fixed
  filings, G10 packet).

These are unreached rather than blocked: every ruling they need is in §2, and
each has a written specification in the loop brief. A successor can start at C1
without re-deriving anything.

**Suite state at stop:** Rust 169/169 (perf test intermittent, 3/4); all node
tests green by exit code; typecheck 0; style gate 0; accent univalence 0.

---

# RELAUNCH — queue 2

## R1 — commit-gate mechanization · **DONE**

Twice in loop 1 a commit landed on a red signal (red style gate; red Rust suite).
Same cause both times: the verification was a pipeline ending in `grep "test
result"` or `&& echo OK`, and the **deciding act was a human reading a line**.
Both self-caught, and "I will read more carefully" is a promise from the faculty
that just failed.

`scripts/verify-all.sh` — every step's exit code captured, scoreboard derived
from the codes, non-zero exit if any step is red. `.githooks/pre-commit` refuses
the commit on that code (`git config core.hooksPath .githooks`). Rust suite runs
only when the change touches `crates/` (`--full` forces it), so the gate is
affordable on every commit.

Carries its own lying step, `VERIFY_SELFTEST=1` → `VSELF`, exiting 1 while
printing "everything is fine" — the GSELF pattern this repo already uses for the
gate board. A battery that cannot detect its own false green is not a battery.

| falsification | result |
|---|---|
| `VERIFY_SELFTEST=1` | **VERIFY FAIL — 1 of 38 red**, names `VSELF` |
| real red (a renderer reads `ZONE.Circulation.fill`) + `git commit` | **COMMIT REFUSED**, nothing landed |
| clean tree | **VERIFY OK — 37/37**, commit proceeds |

Third promotion of a vigilance failure into harness this workstream, after the
empty-file assertion and the build-identity probe.

## R2 — perf regression fixed, verdict-preserving · **DONE**

**My parked mechanism was wrong in its specifics, and profiling said so.** I
attributed the cost to "a 0.15 m grid + distance transform + BFS on every
generate". Measured:

| | ms |
|---|---|
| `generate`, pre-workstream baseline (`425232c`, best-of-3) | **272.5** |
| `generate`, HEAD before this fix | **326.0** |
| `WalkClassifier::build` (grid + DT + BFS) | **8.4** — 16% of the delta |
| `generate` with the whole classify sweep disabled | **273.7** ≈ baseline |

So the sweep cost 52.3 ms and the part I blamed was 8.4 of it. The other ~44 ms
was `classify_poly` calling `geometry::point_in_polygon` **once per grid cell per
pocket** — O(cells × vertices), and the merged pockets carry up to 62 vertices
over bboxes spanning much of the plate.

**Fix: scanline.** Crossings depend only on the row, so compute them once per row
and walk the spans — O(cells + rows × vertices). The predicate is
`point_in_polygon`'s transposed verbatim: same half-open `(pi.y > py) != (pj.y >
py)` rule, same interpolation, same strict `px < x_cross`, so a cell centre
exactly on an edge falls the same side it always did.

**Acceptance test met first, speed second.** Verdict digest — every residual
zone's `(type, area)` across all three plate families, 10 cases — captured before
and after and differenced:

```
bytes: before=1257  after=1257
VERDICTS BYTE-IDENTICAL ✓  md5 ae49c475ad91ce15935872facb7c7f0e  rows=56
```

Non-vacuity asserted in the probe (`rows >= 30`), because two empty digests are
also byte-identical.

**Result: 326.0 → 286.5 ms**, against a 300 ms budget; full suite **5/5 green**
(was 3/4). No registered value touched, so no re-registration and no HALT.
`BUDGET_MS` untouched.

**Lesson, third of its kind this workstream:** a mechanism asserted from
plausibility rather than measurement pointed at the wrong 8 ms and would have had
me optimising the grid — the one lever that changes verdicts — while the real
cost sat in a loop I had not considered. Same family as the scalar-for-geometry
entries: *profile before you optimise* is that rule wearing performance clothes.

---

# ⛔ HALT-ENV — commit signing unavailable

Fired after R2 was complete and verified. `commit.gpgsign=true` with SSH signing
through 1Password; the agent is locked:

```
error: 1Password: failed to fill whole buffer
fatal: failed to write commit object
```

Attempted per §1 step 5: once immediately, once after a 60 s wait. Both failed.
This is the second signing lock this session; the first cleared when the user
unlocked the app.

## Uncommitted work — explicit inventory

Nothing is lost; all of it is on disk and verified green. Three files:

| file | change | state |
|---|---|---|
| `crates/ds-core/src/layout/conform.rs` | R2 — the scanline in `classify_poly` (+40/−2) | **verified**: verdicts byte-identical (md5 `ae49c475…`, 56 rows), 326→286 ms, suite 5/5 |
| `crates/ds-core/src/layout/tests.rs` | trailing-newline tidy after probe removal | cosmetic |
| `docs/audits/LOOP-LEDGER.md` | the R2 entry + this HALT entry | documentation |

Verification battery run immediately before the first commit attempt: **38/38
green**, including the Rust suite (the gate correctly detected `crates/` in the
change and ran it).

The prepared commit message is in the session transcript; it can be reconstructed
from the R2 ledger entry above, which carries every number.

## What reopens the loop

Unlock 1Password, then:

```
git add -A && git commit -F <message>      # the gate re-runs and must be green
```

Queue position on resume: **R3 = C1** (shared KPI module), then C2, C3, D1–D3,
E1 verification/E2, F2–F4. R1 (commit gate) and R2 (perf) are done — R2 needs
only the commit.

## C1 — shared KPI module · **DONE**

`report.ts` held the only derivation of density / daylight / privacy /
efficiency, and the on-screen card was going to need the same numbers. Two
derivations of one number drift, and the reader cannot tell which is lying.

Extracted **unchanged** into `web/src/export/kpis.ts`: `ReportMeta`,
`AlternativeInput`, `SpaceMix`, `AltKpis`, `ReportModel`, `DAYLIGHT_RADIUS_M`,
`OPEN_ZONE_TYPES`, `LEGEND_ORDER`, `ZONE_LABEL`, `computeAltKpis` and its
helpers. `report.ts` imports and **re-exports** the public types, so every
existing importer (`App.tsx`, `GenerateStep.tsx`) is untouched.

**Acceptance test — the same instrument as R2, different artifact**, as ruled:

```
bytes: before=1580  after=1580
REPORT MODEL BYTE-IDENTICAL ✓  md5 2d956b4a3f2f6ac7edc2e42fb91e7f1a  KPI_ROWS 57
```

57 KPI fields across 3 alternatives plus winners and the radar, non-vacuity
asserted. Instrument kept at `docs/evidence/circulation-audit/C1-kpi-digest.mjs`.

**Two guards followed their constants**, which is the whole job of a parity
guard: `coreParity` now reads `DAYLIGHT_RADIUS_M` from `kpis.ts`, and
`legendParity` reads `LEGEND_ORDER` from `kpis.ts`. The guard that did NOT follow
`OPEN_SHARE` crashed for two months while listed as passing — this is that lesson
applied before the fact rather than after.

## C2 — on-screen metrics card · **DONE** · C3 — **already satisfied**

`ui/MetricsCard.tsx`: net area · seats · open space · offices · conf rooms ·
density, then Daylight / Privacy / Efficiency as ratio bars with a **per-batch
average tick**. Every value is read from `AltKpis` — the module C1 extracted, the
same one the PDF report consumes. Nothing in the card derives a metric.

`batchMean` recomputes per generation and returns `null` for a batch of one,
because the mean of one plan is that plan and a tick there would be theatre.

Dynamic values ride CSS custom properties (`--v`, `--at`) rather than an inline
style dictionary, so appearance stays in `styles.css` per the standing rule and
only the datum crosses the boundary. The tick is neutral ink above the track, not
part of the accent fill: "where this plan is" and "where the batch averages"
must not blur into one bar.

| sabotage | result |
|---|---|
| the tick becomes a constant | **RED** |
| the card imports `Editor` to derive a metric | **RED** — "must FORMAT AltKpis" |

**C3 needed no work.** The candidate cards already render the headline trio
(workstations · m²/person · efficiency) from the same shared `AltKpis`, in the
same grammar. Adding a second trio would have been the duplication this phase
exists to remove — recorded rather than churned. (The brief says "seats"; the
card shows *workstations*, which is the sharper number for comparing desk counts
and is pre-existing. Flagged, not changed.)

**Not done in C2:** the presentation-side-panel mount. The card is one component
and mounting it there is a second call site, not new logic.

## D1–D3 — the circulation board · **DONE**

`scripts/gates/circulation/run-all.mjs`, C1–C10, folded into
`scripts/gates/run-all.sh` as **G13** — the `sheets/` precedent exactly: own
board, one parent row. Reusing G-numbers would have made the parent ambiguous and
broken `GSELF`'s scoreboard-line matching.

**Mostly delegation, on purpose.** Nine of these properties are already guarded
by node tests written alongside the changes that introduced them, each with its
own falsification round. A gate re-implementing those assertions would be a
SECOND derivation of the same ground truth — the defect this workstream spent
itself removing. The board runs them under one scoreboard with exit-code
counting; it does not restate them.

C6 is the one new gate — the re-registered assertion (`foldParity.test.mjs`):
efficiency re-derived **independently** from the honest rows (not read back from
the number under test), fold exact in area *and* row count, and no `Unassigned`
string in any published projection. Non-vacuity asserted: if no seed produced
unassigned floor the fold assertions would compare two identical sets.

```
  9/9 passing · 1 pending-human · 31.6 s
  ALL AUTOMATED CIRCULATION GATES GREEN (9) — 1 awaiting a human.
  G13 PASS (9 gates, 1 pending-human)
```

| sabotage | result |
|---|---|
| `CSELF=1` (lying gate, exits 0 printing FAIL) | **9/10, FAIL: 1 red** — caught |
| `groundZones = []` | **C1, C3, C5 RED** (C9 correctly unaffected — it guards the sheet's label branch, not the ground list) |
| LOD ramp re-broken (`referencePx = 0`) | **C1, C2, C3 RED** through the board |

**C10 never passes.** It reports `PENDING-HUMAN` and is excluded from the
passing count in both boards. Packet at
`docs/evidence/circulation-audit/G10-walkthrough.md` with the verdict line blank —
an agent filling it in would be producing the artifact whose whole worth is that
a human produced it.

## E1/E2 — closeout · **DONE**

**E1** — the quantitative restatement is the table already written above
(§ *E1 — final quantitative restatement*), verified current: workstations **101**,
`efficiency_pct` **61.63** (invariant), published fold **295.89 m²** byte-exact,
candidate ordering **A > C > B**, tags **24 → 7** with ground **17 → 0**, card
circulation grey **1 226 px → 0**.

**E2** — `golden_generate_output_is_frozen` passes and now carries a provenance
stamp naming its last re-capture (Phase 1b, the shape conjunct), what moved (two
of ten cases; only `total` and the digest — geometry identical in all ten), and
what the digest additionally pins (`Zone.origin`, the wasted-floor penalty).

## F2–F4 — handoff · **PARTIAL, stated**

- **F4 — the G10 packet: DONE.** `docs/evidence/circulation-audit/G10-walkthrough.md`
  — setup, a ten-step script, the question, seven sub-questions, and a blank
  verdict block. The "what changed" context is behind a fold so it cannot
  contaminate the answers. This is the artifact the workstream ends on.
- **F3 — discovered-not-fixed:** the pack-dock overlapping the wizard's primary
  CTA (`elementFromPoint` at the Next button's centre returns `pack-btn`;
  measured rects in the Phase 0 audit §A). Filed there with repro evidence, not
  fixed — out of scope, and the boundary-discard defect that shared its filing
  was fixed instead (`8f06e83`) once it started costing verification time.
- **F2 — the before/after gallery: DONE.** `F2-before-after-gallery.png`, four
  surfaces paired left/right at a normalised 1600×1000 viewport: editor canvas,
  candidate gallery, presentation/paper, 3D. Re-captured through the full wizard
  rather than reusing mismatched shots (the earlier 3D capture came back
  1200×744 against Phase 0's 1600×1000, which is why pairing had been deferred).

  What the pairs show, at a glance: the editor loses every CIRCULATION /
  CORRIDOR label; the candidate cards lose the grey flood and gain the metrics
  card with its three benchmark bars; paper is unchanged (it was already
  correct — the point of the poché ruling); 3D floor is neutral under the
  circulation spine.


---

# QUEUE 2 — CLOSED

R1 · R2 · C1 · C2 · C3 (already satisfied) · D1 · D2 · D3 · E1 · E2 · F2 · F3 · F4.

**Board state:** circulation board **9/9 automated green, C10 PENDING-HUMAN**;
`G13 PASS (9 gates, 1 pending-human)` parses for the parent runner; verification
battery **40/40**.

**The one remaining action is not an agent's.** Run
`docs/evidence/circulation-audit/G10-walkthrough.md` and write the verdict.

---

# QUEUE 3 — QBIQ PARITY: THE EDITOR AS A DRAWING

Mandate: plans this editor renders must read as an architect's test fit, and
metrics must be impossible to silently break. Standing rule for the whole queue:
**both populations, always** — every gate runs against freshly generated plans
AND against edited ones.

## Phase 0.1 — the edited-plan fixtures · **DONE**

Five frozen states in `crates/ds-core/src/fixtures.rs`, built from the sample
plate's generate output and reachable from BOTH sides of the wasm boundary
(`Editor::load_fixture`), so a browser capture and a Rust assertion look at one
document rather than at two that were meant to match.

| id | state |
|----|-------|
| F1 | pristine `generate` on the sample plate |
| F2 | F1 + a user-drawn 1.2 × 1.0 m closed wall loop; envelope intact |
| F3 | F2 with one plate wall removed — **the GEA-collapse state** |
| F4 | generate → select a zone → resize → reassign to Circulation |
| F5 | edit soup: eleven mixed mutations across walls, zones, components |

The plate boundary is the one thing that crosses from TypeScript: captured from
`samples/furniture-plan.dxf` by `scripts/capture-plate-fixture.mjs` into
`crates/ds-core/fixtures/plate-furniture-plan.json` — **34 vertices, 930.06 m²,
method `partition-envelope`** — and frozen like a golden. Re-capturing it is a
re-registration event.

**Wall deletion has no `Editor` mutator at all** (`delete_selected` deletes
components only; the frontend has no wall-delete path). F3 therefore edits the
document directly. That is *not* a claim the state is unreachable — the second
route is a CAD-committed line that snaps across the plate and subdivides its
face, which needs no deletion and is covered separately by
`a_wall_drawn_across_the_plate_cannot_halve_the_floor`.

## Q3-A — the metrics collapse · **DONE, mechanism named and reproduced**

### The repro, and what it printed

Reproduced exactly, and the numbers match the report. Sabotage S1 (below)
restores the pre-fix plate rule and the battery prints:

```
efficiency 1466.6666666666129 > 100: usable 17.600000000000023 / nia 1.2000000000000455 (plate traced)
```

**NIA 1.2 m²** — the drawn box — against a 930 m² floor, and an efficiency of
**1466%** against the reported **1159%**. Same mechanism, same order of
magnitude; the difference is the size of the scratch loop the user happened to
draw. The previous session's hypothesis (delete the outer walls after generate)
was correctly reported as falsified: with no closed loop at all the trace returns
`None` and the bbox fallback made GEA go *up*. It takes a surviving *closed* loop.

### Three mechanisms, not one

1. **Plate selection.** `trace_floor_polygon` took the largest closed loop.
   Correct only while the envelope's loop is the largest — one drawn box while
   the envelope is open, and the box IS the building.
2. **Two NIA owners in the core.** `metrics()` summed and clamped with
   `.min(floor_area)`; `zone_rows()` summed unclamped. On a collapsed plate the
   pair disagreed by two orders of magnitude and the panel showed both at once.
3. **A THIRD owner in the panel.** `StatsPanel.tsx` read
   `zones.totalArea || m.net_internal_area` — a TS-side sum of the Zones tab's
   rows, printed beside a GEA from `metrics()`. This is the pairing that was on
   screen. It was not in the mission's mechanism list and was found by reading
   the panel.

### The fix

- `geometry::trace_floor_faces` enumerates every closed positive-area face
  (largest-first, stable); `trace_floor_polygon` is now its first element.
- `Document::plate_resolution` → `Traced | Open | Unresolved`. A face must
  contain ≥ `PLATE_CONTAINMENT` (0.9) of the plan's anchor points — every
  component centre and zone representative point, derived from the document and
  never from the trace. Under `MIN_PLAN_ANCHORS` (8) there is no evidence and
  largest-wins stands, which is what a plate confirmed in the wizard needs.
- `Metrics.plate_state` crosses the boundary; `StatsPanel` renders GEA as an
  explicit **error row** when unresolved and an **approx row** when open, never a
  number in the same slot with the same weight.
- **One `net_internal_area`**, read by `compute_metrics` and `zone_rows` alike;
  the panel reads the core's. `compute_metrics` was lifted out of the
  `#[wasm_bindgen]` method — the panel's arithmetic was the one part of the core
  no Rust test could reach, which is where the 1159% lived.

**The threshold is a gap, not a knob.** Measured on the sample plate's generated
plan: **253/254 anchors = 0.9961**. A scratch loop contains ~0; a plate halved by
a committed line contains ~0.5. Nothing legitimate lives between 0.5 and 0.99.
`plate_containment_on_a_real_plan_is_not_near_the_threshold` re-derives the
number so the doc comment cannot drift from it.

### The battery

`crates/ds-core/src/metrics_tests.rs` — 8 tests. 120 seeds × 10 mutations from
each fixture = **1 200 metric evaluations** over a seeded xorshift (the repo's own
PRNG convention; no new dependency). Invariants: efficiency ≤ 100 · NIA ≤ GEA
when traced · no NaN/negative · never workstations > 0 with area/WS == 0 ·
`plate_state` is one of three known strings · the two NIA readers agree.
Non-vacuity is asserted, not assumed: `the_randomized_battery_reaches_broken_plates`
requires the population to include both traced and unresolved plates, and it
prints the census — `{open: 123, traced: 501, unresolved: 576}`.

### Sabotage round — three parts, and TWO NULL RESULTS

Run in a disposable worktree (`/tmp/q3-falsify-a`, removed after), never against
the real tree.

| sabotage | result |
|---|---|
| **S1** — plate selection reverted to largest-closed-loop | **4 of 7 RED**, including the reproduced `efficiency 1466%` above |
| **S2** — the second NIA owner restored in `zone_rows` | **GREEN.** The check compared `compute_metrics` against `net_internal_area` — two calls to the same function. Rewritten to re-derive NIA from the Zones tab's own `pct_of_nia` rows; S2 then **RED**, caught by the random battery at seed 31 (rows 973.745 vs metrics 930.063), *not* by any of the five fixtures |
| **S3** — the conditional clamp reverted to clamping always | **GREEN.** Cause is benign: once selection is fixed, an unresolved plate falls back to the wall bbox, which dominates every face inside it, so the clamp is inert on every state reachable. Inert is not guarded — added `nia_is_never_capped_by_a_plate_we_do_not_trust`, which builds a document whose bbox is 2 m long while its plan is 940 m², making the conditional load-bearing. S3 then **RED** |

Two of three parts shipped unguarded and were only found because the round was
run exhaustively rather than to a checklist. S2 is also the case for the random
battery earning its keep: **no fixture separated the two NIA owners**; a
five-mutation random sequence did.

### A latent verdict-mover, found on the way

Rewriting `trace_floor_polygon` as `max_by(area)` over the enumerated faces
re-hashed **five of the ten frozen golden cases** while leaving every count and
every coordinate identical (`c222 w155 z40 desks88 total90806929`, digest
`54c08e26…` → `604f449b…`). Cause: the sample plate's envelope is enumerated
**twice** at 930.06 m² — ties are real — and `max_by` returns the LAST maximum,
so the plate polygon came back with a different vertex order, moving every
clipped zone area and every score that reads them. Restored to first-wins over a
stable sort; goldens unchanged, not re-captured. Recorded because the failure
mode is invisible: identical geometry, different hash, and the only signal was a
frozen test.

**Board:** `cargo test -p ds-core` **178 green** (was 170; +8 battery), goldens
unchanged; verification battery **41/41**.

## Phase 0.2 — the capture harness · **DONE**

`scripts/capture-fixtures.mjs` → `docs/evidence/qbiq-parity-q3/<tag>/` : F1–F5 ×
{fit, 2×, 4×} = 15 PNGs, plus `manifest.json` and `tag-census.json`.

**It renders through `paint.ts::paintPlan`, which is the editor's own sequence.**
That needed a refactor and it was worth it: a capture harness with its own draw
order measures a renderer nobody ships. `EditorCanvas.render()` now calls
`paintPlan` too, so the two cannot drift. The script owns only what is not the
plan — the mat, the white plate, the viewport.

Provenance is asserted before a pixel is written: the bundle is grepped for
`paintPlan`, `drawWallNetwork`, `drawZoneTags`, and a capture under 1 000 bytes
is a failure rather than a file.

## Q3-C — the wall network · **DONE, ruling A1 refined not reversed**

**Mechanism.** `drawWall` stroked each wall's two faces and two end caps
independently. At every corner and T-junction four of those strokes lie *inside*
the solid. It was never a stroke-weight problem — the extra ink was **geometry
that is not on the boundary of the union**, and no weight ladder can fix a line
that should not exist.

**A1 stands.** No poché, no fill, the wall interior stays white. What changed is
*which lines exist*. The reference's clean double line IS the union outline; we
were drawing the correct weight over the wrong geometry.

**`crates/ds-core/src/wallnet.rs`** — the union boundary, exactly, with **no new
dependency**. Each wall contributes a thickness rectangle, mitred at junctions
(an end that meets another wall extends by half its own thickness, so the corner
closes); each rectangle edge is split at its crossings with the others; a piece
survives iff its midpoint is in no other rectangle's interior. `wall_outlines()`
crosses the boundary with `{a, b, wall, exterior, glazed}`; cut/interior
classification moves into the core with it (it was re-derived TS-side from a
serialized plate on every wall change).

Four unit tests, each naming the artifact it forbids: a lone wall keeps its whole
rectangle · an L-junction draws nothing through the corner · a closed room yields
exactly its outer and inner rings and no caps · collinear runs lose their shared
caps (the shape every imported boundary polyline has). On the sample plate:
**131 walls → 554 outline segments**, against 131 × 4 = 524 strokes before, but
now they are the boundary rather than 524 boxes.

**`punchOpening` deleted, and the reason is better than "unused".** It overdrew
in white to fake a door break. Openings in this model are already *geometry* —
generated room shells are emitted with a real 0.9 m gap in the wall run
(`assert_room_enclosed`) — so the punch had nothing to do and was never called
from the render loop. Grep confirms zero remaining references.

**Glazing** keeps the triple-line convention: the union supplies the two faces,
`drawGlazing(…, centreOnly)` adds the glass centre line, so a glass front meeting
a partition is now as clean as any other junction.

## Q3-E — room tags · **PARTIAL, measured in both directions**

**The defect was label-over-FURNITURE, and the first gate could not see it.**

Tags were anchored at their zone's geometric centre. For a 536 m² open-plan
field that is the middle of the desk grid, which is the worst spot on the sheet
and exactly where every capture showed the label. Placement now scores a 9 × 9
grid of anchors inside the zone by how clear the label's box stays of the
furniture beneath it, breaking ties toward the centre — the pole of
inaccessibility with the furniture counted as boundary. A tag that fits nowhere
inside its **own** room is culled rather than allowed to spill onto the next room
(that is how `MEETING ROOM 2`'s tag came to sit across the cabin beside it); the
legend still identifies it. A knockout halo goes on only where a tag does land on
line-work.

**Sabotage found the gate vacuous — the third null result of this queue.**
Reverting placement to centre-pinning in a disposable worktree left the census
reporting **0 collisions**, because the census only checked label-vs-label and
`hits()` had always prevented that. The check was measuring a property that was
already guaranteed while the defect it was named for went straight past it.

Extended to the real property — a text box overlapping a component box, both
recorded at the **canvas API** by wrapping `ctx.fillText`, so the boxes carry
real text metrics and no producer claim is consulted:

| | label-on-label | **label-on-furniture** | text draws |
|---|---|---|---|
| centre-pinned (shipped) | 0 | **127** | 211 |
| furniture-aware (now) | 0 | **29** | 205 |

`FURNITURE_OVERLAP_BUDGET = 32`, set from the measurement, so a regression toward
centre-pinning fails loudly. It is a budget and not zero because a small room
whose table fills it has nowhere else for its own tag to go. Both non-vacuity
guards are asserted (≥20 text draws, ≥100 furniture boxes) — a census that
recorded nothing would report zero and mean nothing.

**Still open on E:** the 29, and tags on zones whose rect is larger than the room
drawn inside it (`OPEN WORKSPACE (2)` spilling over a cabin wall).

## What the captures show that is NOT yet fixed

Read off `docs/evidence/qbiq-parity-q3/q3-current/F1@fit.png` and `@4x`:

1. **The plan does not use the floor.** The desk field is one tall blue rectangle;
   the entire left third and the bottom of the plate are empty white with no
   program at all. This is the largest remaining visual defect and it is a
   GENERATOR problem (Q3-F), not a renderer one.
2. **No legible circulation hierarchy.** There is no spine to trace from the
   entry — the ground is one undifferentiated field (Q3-F).
3. **Chairs read as lozenges**, not as task chairs: a rounded rectangle with one
   ticked edge. It is the most repeated glyph on the sheet (229 components), so
   it carries more of the "does this look professional" verdict than anything
   else (Q3-D3).
4. **Desk rows are ragged** — rows end in single unpaired desks.
5. Q3-B (the area tool) and Q3-D2 (extracting the symbol spec from the reference
   PDF) are **not started**.
