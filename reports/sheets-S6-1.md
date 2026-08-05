# S6-1 — D-A closed: one occupancy per region, and type painted last

**Agent S6.** The Judge's blocker is closed at the class level, not at the symptom.

**Plan words on A.02 more than 15 % covered by an opening-tag mask, measured with the gates' own
instruments (`lib/tags.mjs findTags` against poppler word boxes): 9 → 0.**

```
BEFORE  (my reproduction of the Judge's measurement, on the delivered set they graded)
seeded  A02  plan tags  41  plate words  193  covered >15%: 2   76% "BOOTH"@(495,266) 74% "m²"@(500,277)
testfit A02  plan tags  48  plate words  210  covered >15%: 3   34% "MEETING"@(155,520) 30% "ROOM"@(194,520) 28% "m"@(179,473)
dwg     A02  plan tags  44  plate words  185  covered >15%: 4   100% "m²"@(660,217) 43% "(4)"@(401,177) 29% "WORKSPACE"@(346,177) 16% "FOCUS"@(627,206)
TOTAL covered words > 15%: 9

AFTER
seeded  A02  plan tags  41  plate words  193  covered >15%: 0  (words touched at all: 0)  tag-on-tag: 0
testfit A02  plan tags  48  plate words  210  covered >15%: 0  (words touched at all: 0)  tag-on-tag: 0
dwg     A02  plan tags  44  plate words  185  covered >15%: 0  (words touched at all: 0)  tag-on-tag: 1
TOTAL covered words > 15%: 0
```

My "before" run reproduced the Judge's list **word for word and coordinate for coordinate** (§1), so
the instrument is the same one; the tag count per pack is unchanged (41 / 48 / 44). "Words touched at
all" is the same measurement with the threshold dropped to 0 %: **not one plan word is under a tag
mask by any amount**, in any pack.

---

## 1. The instrument, and why it is the Judge's

`scratchpad/covered.mjs` imports `readPng` / `pageWords` / `loadGeometry` from
`scripts/gates/sheets/lib/sheetlib.mjs` and `findTags` from `scripts/gates/sheets/lib/tags.mjs`
(read-only — no file under `scripts/**` was modified). Plan tags come from the gate's **raster**
detector at its 11 pt plan scale; the mask is the `2r × 2r` square `tagMask` paints; word boxes are
poppler's measurement of the delivered runs, filtered to the plate rect from `A02.geometry.json`. A
tag's own glyph run (`D12`, `W11`, …) is excluded — it is the mask's intended content.

Run against the pack as it stood when the Judge graded it, that script printed the nine lines above,
identical to `reports/sheets-defects-1.md` §1. Nothing was calibrated to my fix.

## 2. Root cause, and the design that closes it

The defect had **two** halves, and each alone leaves the other live.

**Half 1 — placement.** Every family de-conflicted only within itself. Room labels avoided room
labels; tags avoided tags through a second, private occupancy list (`tagOcc`). A tag *did* see the
label boxes in `occ`, but it was placed with `placeNear`, which **always places**: when every in-plate
candidate collided it returned the least-overlapping one, and with D2's plate bound closing the escape
route that fallback started parking tags on room names.

**Half 2 — paint order.** Whichever family painted last won, and several of them paint something
opaque: `drawTagGlyph`'s white knockout, a room label's halo, an exit luminaire's amber tile. So a
placement that merely *touched* a name did not overlap it — it **erased** it, which is why SG3 3.1
stayed green (`.claude/rules/gate-independence.md` §"Emission is not visibility") and why SG3 3.3's
widest-blank-run test read 0.13 em against a 0.50 em limit: the tag filled the hole it made.

### The design

**One occupancy per region.** On A.02 a single `occ: OccBox[]` is now reserved by, in order:

| # | family | placer | why this rank |
| --- | --- | --- | --- |
| 1 | perimeter dimension strings | `dimString` reserves its own label box | they measure the building; their position is not negotiable |
| 2 | per-room dimension strings | same | anchored inside the room they dimension |
| 3 | room names + ordinals + area strings | `tryPlaceNear` ladder (S3's), plate-bounded | movable, and already carry a leader |
| 4 | opening tags | `tryPlaceNear`, plate-bounded | the family that carries a leader **by construction** — so it is the family that yields |

The perimeter dimension labels were reserving **nothing** before (`dimStrings` never touched `occ`);
they do now. The per-room ones reserved a *predicted* box; `dimString` now reserves the box it
actually draws on, from the baseline it draws at, so one annotation's reserved box means the same
thing as another's (`textBoxAt`).

**The tag ladder** (`sheetSet.ts`, the opening-tag pass) — no new placement system, three calls to
the two shared placers:

1. `tryPlaceNear(occ, …, PLAN_TAG_BOX = 24, plate)` — strict, the shared 13 candidates then
   `extendedCandidates`' 20 wider rings. A "no" means *no spot near this opening is clear of a
   dimension, a room name or another tag*.
2. `tryPlaceNear(occ, …, PLAN_TAG_MASK = 22, plate)` — strict again, asking for the knockout's true
   extent with no slack. The candidate steps are derived from the box, so this is a genuinely
   different lattice, not a retry. Measured: it rescues 2 of dwg's 4 failures.
3. `placeNear(occ, …, 24, plate)` — least-overlapping in-plate spot, so a tag is never dropped.

`tagOcc`, the private tag-only occupancy S2 added, is **deleted**: with strict placement against the
shared `occ`, a tag avoids another tag for the same reason it avoids a name.

**Three paint passes, not one.** `PlanInk { masks, symbols, type }` + `paintPlanInk()`
(`sheetSet.ts`). Nothing is painted until every box is reserved, and then:

1. **masks** — every knockout / backdrop (`tagMask`, room-label halos, fixture glyph masks)
2. **symbols** — glyphs that are shapes (`tagBody`'s outline, fixture symbols, opaque fills)
3. **type** — every glyph run that has to be READ (dimension labels, room names + areas, circuit tags)

`drawTagGlyph` is split into `tagMask` + `tagBody` for this; it survives as the one-pass composite the
schedule column still uses (a tag on blank panel has nothing underneath to protect). Line work
(leaders, dimension lines) is still drawn in place — it belongs under everything, and a tag mask
clipping a dimension line where the tag sits is the drafting convention.

**With all type painted last, by every family at once, nothing any family draws can reach another
family's words** — whatever order the families ran in, and whether or not placement found a clear
spot. That is the property the fix rests on; strict placement is what keeps the drawing *tidy* on top
of it.

A.01 has no opaque mark of any kind, so `roomLabels` there takes `paintNow` and draws in place,
exactly as before.

## 3. The same class on A.03 / A.04 (defect D-G), fixed with the same machinery

D-G was filed minor and pre-existing. Measured with a second instrument (`scratchpad/rcp.mjs` — white
filled rects read out of the delivered PDF's own content stream vs poppler word boxes) it was much
larger than reported, and it is exactly this defect: the lighting-circuit tags (`LC-01` …) were
printed straight at their switch with **no de-collision and no seat in any occupancy**, then the room
labels painted their halos over them.

```
                        circuit tags knocked out          circuit tags printed on top of each other
                        (any opaque knockout)             (delivered word boxes)
BEFORE   seeded 10/24 · testfit 9/24 · dwg 18/40          15 · 9 · 64 pairs
AFTER    seeded  0/24 · testfit 0/24 · dwg  2/40           0 · 0 ·  0 pairs
         └ under a room-label halo (the D-G defect proper): 0 / 0 / 0   (Judge's before: 2 / 0 / 9)
```

Six of one switch's circuits printed their tags on the identical point on seeded, five on dwg. All of
that is gone. What changed in `servicesSheets.ts`:

* `roomLabelBoxes` takes the **sheet's** occupancy instead of a private one, so what follows sees the
  names. Room-label positions are unchanged (the occupancy still starts empty and they still go
  first) — A.03/A.04 label placement is untouched, which is why SG3 stays at 295.
* `circuitTags()` places each tag with `tryPlaceNear` against that occupancy, plate-bounded, with
  `placeNear` as last resort — the **original spot is candidate one**, so a tag with room around it
  does not move — and draws a `labelLeader` back to its switch when it does.
* `drawRoomLabels` queues instead of painting: leaders in place, halos → `masks`, text → `type`.
* `clearOfLabels` **is no longer a placement system of its own.** Its bespoke 11-candidate ring is
  deleted; it now calls the shared `tryPlaceNear` on a *copy* of the occupancy — a copy deliberately,
  because a fixture must not reserve against its neighbours (the ceiling/power grid is regular by
  intent, and glyph-on-glyph is not a defect; glyph-on-type is). This alone took dwg from 9 knocked-out
  tags to 2, and cleared the last three overlapping word pairs on A.03. `servicesSheets`' duplicate
  `boxesOverlap` went with it — one predicate now, in `sheetSet.ts`.

## 4. Whole-plate check: no two delivered words overlap

The property "annotations that share a region share one occupancy" is directly testable on the
artifact — take every word poppler reads inside the plate and look for overlapping boxes (excluding
words on one baseline, which are one drawn run). `scratchpad/words2.mjs`:

```
seeded  A02  193 plate words · overlapping word pairs >15%: 0
testfit A02  210 plate words · overlapping word pairs >15%: 0
dwg     A02  185 plate words · overlapping word pairs >15%: 0
seeded  A03   97 plate words · overlapping word pairs >15%: 0
testfit A03   98 plate words · overlapping word pairs >15%: 0
dwg     A03  117 plate words · overlapping word pairs >15%: 0
seeded  A04   52 plate words · overlapping word pairs >15%: 0
testfit A04   52 plate words · overlapping word pairs >15%: 0
dwg     A04   62 plate words · overlapping word pairs >15%: 0
```

**Zero, on all three plan sheets of all three packs.** (A.03 read 3 before the `clearOfLabels` change
— an exit luminaire's amber tile and its `E` landing on `PHONE BOOTH` / `RECEPTION` / `LC-01`.)

## 5. Where the plate genuinely cannot hold everything

Instrumented the two last-resort branches with `console.warn` (forwarded by `render-sheets.mjs`) and
re-rendered; the instrumentation is removed from the shipped code.

```
$ node scripts/sheets/render-all.mjs --pack all
  seeded:  … (no fallback)
  testfit: … (no fallback)
  dwg:     console: TAGFALLBACK D04   console: TAGFALLBACK W33
           console: LCFALLBACK LC-11 LC-21 LC-22 LC-27 LC-37 LC-38
```

* **seeded and testfit: zero.** Every annotation on both packs is placed strictly clear.
* **dwg A.02: 2 of 44 opening tags** could not find a clear spot within reach (the irregular imported
  plate, 23 rooms, 44 openings). They take the least-overlapping in-plate spot and carry their leader.
  The visible consequence is **one** pair of window-tag masks clipping at a corner, `10.0 × 6.0 pt`
  out of `22 × 22` (`Window@(376.5,566.0) ↔ Window@(388.5,582.0)`): the outlines touch, the two
  numbers are 16 pt apart and both read, and **neither can erase the other** — both masks are painted
  before either body. Both tags are still found by the gate's raster detector (44 = 44).
* **dwg A.03: 6 of 40 circuit tags.** They land on a fixture symbol, not on type; 2 of the 40 end up
  under a fixture's own knockout, which since this change is painted before any type and therefore
  erases nothing.

That is the whole of "the plate cannot hold everything", and in every one of those 8 cases the
annotation is displaced with a leader rather than dropped, and nothing is erased.

## 6. Verification

```
$ node scripts/sheets/render-all.mjs --pack all
  seeded:  12 sheets → out/sheets/seeded/  (2382×1684 px @ 144 dpi, pdf 1217220 B)
  testfit: 12 sheets → out/sheets/testfit/ (2382×1684 px @ 144 dpi, pdf 1138204 B)
  dwg:     12 sheets → out/sheets/dwg/     (2382×1684 px @ 144 dpi, pdf 1342864 B)
sheet harness OK — 3 pack(s) × 12 sheets

$ node scripts/gates/sheets/run-all.mjs
  SG1  Panel containment            PASS (213 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (27 checks, 2 failing)
  SG6  Determinism + independence   PASS  (16 checks)
  5/6 passing

$ SHEETS=1 bash scripts/gates/run-all.sh
  G1 59 · G2 17 · G3 92 · G4 18 · G5 70 · G6 53 · G7 19 · G8 9 · G9 24 · G10 14 · G11 56
  11/11 passing
  graded pack: 10/10 artifacts in out/ + 12/12 G9 round-trip case files
               walkthrough.mp4 55043620 B  unchanged since G10 produced it; PASS (12 checks)
  ALL GATES GREEN.

$ cd web && pnpm typecheck        → clean (tsc --noEmit, no output)
```

**59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12) — identical to the `1a2b8d5` baseline,
check for check.** G4 (18) and G11 (56) are unmoved, as required: `planGraphic.ts` is untouched and
`placeNear`'s candidate stack was not altered.

SG1's 201 → 213 and SG5's 25 → 27 are **not mine** — S7 is amending the gate suite in the same
worktree (`git status` shows their unstaged edits to `scripts/gates/sheets/*` and
`scripts/sheets/render-all.mjs`). SG5's two remaining reds are both `drawing-set.test.mjs` against the
un-re-recorded baseline (S5's hand-off):

```
$ node scripts/drawing-set.test.mjs
  seeded: 12 sheets · 1120 text / 4229 line / 866 rect ops · rooms 22 · A.01 2 off-room, 1 led · A.02 4 off-room, 2 led
  dwg:    12 sheets · 1143 text / 5155 line / 1095 rect ops · rooms 23 · A.01 9 off-room, 6 led · A.02 14 off-room, 10 led
  FAIL seeded: baseline has 11 sheets, this render has 12          } every failing line is a
  FAIL seeded/dwg sheet 2,3,4,5,6,11: content digest changed       } baseline digest or count.
  FAIL seeded/dwg sheet 12: the baseline has no row for this sheet } Every structural assertion
  drawing-set FAIL (281 checks)                                    } passes, on BOTH cases.
```

The closing integrity pass failed on three earlier board runs and passed on the fourth. Both failures
were **worktree contention**, proven not guessed: one run showed
`scripts/sheets/render-all.mjs FAILED` while `ps` had another agent's `render-all.mjs` live; another
showed `out/ground-truth.json`, the four renders and `out/share.json` changing **mtime only, byte
sizes identical** — a parallel producer re-running mid-board. The runs pasted above were taken in a
verified-quiet window (`until ! ps … ; do sleep 5; done`). This is the race
`.claude/rules/gate-independence.md` already records and that S2 §6 and S3 §5–6 both hit.

## 7. Looked at — all three packs, A.02, then A.03/A.04

Read the delivered PNGs at full sheet and at 1:1 crops over every location the Judge named.

* **seeded A.02** — `PHONE BOOTH 2` prints whole; the D12 tag that ate `OOTH` is gone from it, and
  `1.4 m²` under it is intact. `CABIN 2 / 9.9 m²`, `W14`, `D16` all clear.
* **testfit A.02** — `MEETING ROOM 1` prints whole; `W13` and `D10` sit above the wall line on
  leaders, which is what a drafter would draw. Whole-sheet: every one of the eight meeting rooms,
  `RECEPTION`, `PANTRY`, `COLLAB`, `IT / SERVER`, `STORAGE`, `PRINT POINT`, `CORE`,
  `OPEN WORKSPACE 687.6 m²` complete and legible.
* **dwg A.02** — `OPEN WORKSPACE (4)`, `(7)`, `MEETING ROOM 1`, `MEETING ROOM 2`, `FOCUS ROOM 1`,
  `1.0 m²`, `20.0 m²`, `4.3 m²` all complete; the `(4)` ordinal that was 43 % erased is whole. `W3`,
  `W9`, `W17`, `D08` sit on furniture with leaders. Whole-sheet: all 23 rooms named, nothing cut.
* **A.03 seeded / dwg** — the ceiling grid is still regular; `LC-01` … `LC-24` (seeded) and `LC-01` …
  `LC-40` (dwg) each print once, separated, with green leaders where displaced. `FOCUS ROOM 2 02`
  (the `LC-` eaten by the halo) is gone: the tag and the room name are both whole and apart.
* **A.04 × 3** — 0 knocked-out words, 0 overlapping pairs; visually unchanged apart from the paint
  order.

No tag sits on a room name in any pack, and no name is partly erased anywhere.

## 8. What changed, and what did not

Two files, both in my lane:

* **`web/src/export/sheetSet.ts`** — `PlanInk`/`planInk()`/`paintPlanInk()`, `textBoxAt`;
  `drawTagGlyph` split into `tagMask` + `tagBody` (composite kept for the schedule);
  `dimString`/`dimStrings`/`roomDims`/`roomLabels` take an ink sink and reserve their real boxes;
  `constructionSheet` rebuilt around one occupancy + the tag ladder; `tagOcc` deleted; `boxesOverlap`
  is now the single predicate.
* **`web/src/export/servicesSheets.ts`** — shared occupancy through `roomLabelBoxes`; new
  `circuitTags()`; `drawRoomLabels` queues into the three passes; `clearOfLabels` reduced to the
  shared strict placer; its duplicate `boxesOverlap` deleted.

Untouched, as required: `scripts/gates/**`, `scripts/sheets/**`, `crates/**`, `planGraphic.ts`,
`placeNear`'s candidate stack, `extendedCandidates`, `roomNaming.ts`. No `git stash / reset /
checkout / clean / commit` was run.

## 9. Open

1. **`drawTagGlyph`'s composite path is the only place a mask can still precede foreign type**, and
   it is only reachable from the schedule column, where the panel is blank. If a future sheet draws a
   plan tag with it, the class returns. The honest guard is a gate: assert no plan-tag mask rect
   intersects a plan word box that is not the tag's own — the Judge's own §9.1 recommendation, and the
   exact measurement in §1 above. It belongs in SG2 (which already grades plan tags) and is a gate
   change, so it is outside my lane; `scratchpad/covered.mjs` is the working implementation to lift.
2. **The three-pass model is a convention, not an invariant.** Nothing stops a future family painting
   straight onto `p` between the passes. A stronger version would hand the sheet builders an ink sink
   instead of the `Page` for anything drawn on the plate.
3. **dwg's 2 tag + 6 circuit-tag last-resort placements** (§5) are the real residue. The lever that
   would remove them is not more reach — it is fewer annotations: `mergeGlazedRuns`' 0.15 m slivers
   (D-N) put 8 spurious windows on seeded and inflate dwg's tag count too. Fix the merge and the
   crowding, the pagination (D-C's fragility) and these fallbacks all shrink together.
4. **`clearOfLabels` no longer reserves**, by design, so two services glyphs can be nudged onto the
   same free spot. Measured on all three packs it does not happen; it is a latent case, and the fix if
   it ever fires is to reserve and accept a slightly less regular grid.
