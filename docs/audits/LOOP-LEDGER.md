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
