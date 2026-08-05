# S3-1 — D3 (over-printed room labels) and D4 (duplicate room names)

**Agent S3.** `SG3 PASS (295 checks)` · `SG4 PASS (36 checks)`, from 17 and 6 failing.
SG1/SG2 (S2's) and SG6 stayed green throughout; SG5 has one known red (below).

```
$ node scripts/gates/sheets/run-all.mjs --no-produce SG1 SG2 SG3 SG4
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  4/4 passing                      6.2 s
ALL SHEET GATES GREEN.
```

---

## 1. The root cause I found vs. what was prescribed

**D3 was prescribed as clipping with a fit ladder as the fix. S1 was right that it is
over-printing, and the ladder alone would not have touched it — but the mechanism is one step
further back than "draw order".**

`roomLabelBoxes` (servicesSheets.ts) computed every label's box **at its zone centre and nowhere
else**. There was no de-collision of any kind on A.03/A.04 — not a weak one, not a broken one, none.
`drawRoomLabels` then painted each box as a white knockout + its text, in zone order, so two labels
that landed on the same spot did not merely overlap: **the later halo erased the earlier glyphs.**
That is why `PHON PHON PHONE BOOTH 3` and `O OPEN WORKS OPEN WORKSPACE` appear, and why poppler
reads dwg's `Wellness Room` as `W` + `ELLNESS` — nothing is clipped, and no clip region exists in
that file.

Two corrections to S1's account, both measured:

* **The fit ladder as prescribed is actively harmful here, and the gates prove it.** SG3 3.1 requires
  a room's name to be recoverable from the delivered text layer as one glyph run. Rung (a) *wrap to
  two lines* breaks that run (`findLabelRuns` chains on one baseline), and rung (c) *abbreviate*
  removes the string outright. Measured: my first ladder wrapped exactly one label — dwg A.02 room
  214, `OPEN` / `WORKSPACE (4)` at 6.8 pt — and SG3 immediately reported
  `room 214 "Open Workspace (4)" rendered exactly once — rendered 0×`. So the rungs are ordered by
  **how much damage they do**, and displacement (which damages nothing) is tried *first*, not last.
* **A.02 was not clean either, it was lucky.** It de-collides via `placeNear`, which always places —
  when all 13 candidates collide it takes the least-overlapping one. Once the D4 fix made three
  labels ~20 pt wider, that fallback fired and printed `PRINT POINT 1` and `CORE 2` **1.6 pt apart on
  one baseline** (SG3 3.2, dwg/A02). A placer that cannot say "no" cannot be asked whether a form
  fits, which is exactly the hole the ladder needs.

**D4's suffixes: confirmed and quantified.** dwg has **seven** rooms with the base name
"Open Workspace" — 154/208/211/214 already numbered `(1)`…`(4)` by
`crates/ds-core/src/layout.rs:4340`, and 246/247/248 bare. A per-duplicate-group suffixer that
ignores existing ordinals yields `Open Workspace (1) (1)`; one that numbers only the bare three
collides with the generator's own `(1)`…`(3)`. The rule has to be defined over the **base** name.

---

## 2. The de-collision + ladder design

**Shared machinery, extended — not a second system.** `servicesSheets.ts` now imports
`tryPlaceNear` / `labelLeader` / `zoneBoxOnSheet` from `sheetSet.ts` (the plan graphic's own
machinery, commit `2420722`). `sheetSet.ts` gained:

* `placeCandidates(w,h)` — the 13-candidate stack, **extracted verbatim**, now shared by both
  placers so they cannot disagree. `placeNear`'s behaviour is bit-identical (it calls
  `tryPlaceNear` for the clear pass, then its own least-overlap fallback exactly as before).
* `tryPlaceNear(occ, cx, cy, w, h, bounds?)` — **strict**: returns `null` rather than settling.
  That refusal is the ladder's question. It also takes S2's `bounds` (the plate) as a hard container.
* `extendedCandidates(w,h)` — 20 wider rings (≤2 columns, ≤4 rows), tried **by the strict placer
  only, after** the shared stack. `placeNear`'s stack is untouched, so the plan graphic (G4/G11) is
  unaffected — verified: G4 18 checks, G11 56 checks, both PASS and both at their baseline counts.
  This ring is what let room 214 keep its full name at full size instead of wrapping.

**The ladder** (`roomLabelForms` in the new `roomNaming.ts`), widest rung first, ordered by damage:

| rung | form | damage |
| --- | --- | --- |
| 1 | full name, full size | none |
| 2 | full name at 85%, then **70%** (`MIN_LABEL_SCALE`) | smaller, still one intact run |
| 3 | full name wrapped to two lines (split at the space nearest the middle; a single word is never broken) | intact, but no longer one run |
| 4 | abbreviated via the one shared map, full size then 70% | a second vocabulary on the drawing |

**Displacement is not a rung** — it is orthogonal and damage-free, so *every position for a rung*
(13 + 20 candidates, plate-bounded) is tried before stepping down. A label whose centre leaves its
room's footprint gets a `labelLeader` back to it. Nothing ellipsizes; no fragment is ever printed.
On all three packs the ladder never gets past rung 1 — which is the point: the defect was collision,
and the ladder is the safety net under it.

Painting order in `drawRoomLabels` is now **all leaders, then all halos+text**, so a leader can
never be painted over finished type. The boxes themselves cannot collide — they were de-collided
before a mark was made.

One measured constant: placement reserves `PLACE_SLACK = 2 pt` more than the drawn halo, because
`textWidth` is an estimator and poppler measures the delivered run (`PRINT POINT 1`: estimator
62.4 pt, delivered 57.3 pt — it errs both ways). The drawn halo pad stays `+6`, which is the
constant SG3 3.2's anchor cites.

**A.02 uses the same ladder** (`roomLabels` in sheetSet.ts), with the name block's baselines
anchored to the block top/bottom so a single-line label lands *exactly* where it always did
(`pos.y-4` / `pos.y+7`).

---

## 3. The shared naming helper, and its idempotency proof

`web/src/export/roomNaming.ts` — **the one cross-cutting addition**, the single place a room's
printed name is decided. `buildTakeoffModel` was checked first: it carries **no room name at all**
(only Room ID + `roomTypeLabel`), so the workbook's `Program Room Name` comes solely from
`planRoomList`. Four call sites, one rule:

| consumer | what it prints |
| --- | --- |
| `planGraphic.planRoomList` | → workbook `Inventory!Program Room Name` |
| `finishSchedule.scheduleRows` | A.09 ROOM NAME |
| `sheetSet.roomLabels` | A.01 / A.02 plan labels |
| `servicesSheets.roomLabelBoxes` | A.03 / A.04 plan labels |

**The rule.** Base name = label minus a trailing ` (n)`. Group every non-circulation zone by base
name **over the whole document** (not one sheet's subset, so the plan — which drops `Core` — and the
schedule — which keeps it — cannot diverge). A group of one keeps its label untouched. A group of
more is numbered `(1)`, `(2)`, … **in Room ID order**.

**Idempotency proof** — the rule applied to the real dwg document, then fed back as the zones'
labels, twice:

```
$ node scratchpad/idem.mjs
pass1 == pass2 : true
pass2 == pass3 : true
154 "Open Workspace (1)" -> "Open Workspace (1)"
208 "Open Workspace (2)" -> "Open Workspace (2)"
211 "Open Workspace (3)" -> "Open Workspace (3)"
214 "Open Workspace (4)" -> "Open Workspace (4)"
246 "Open Workspace"     -> "Open Workspace (5)"
247 "Open Workspace"     -> "Open Workspace (6)"
248 "Open Workspace"     -> "Open Workspace (7)"
```

The four rooms the generator had already numbered come out **unchanged** — not by special-casing,
but because the generator numbers in creation order and creation order is id order. Delivered A.09:

```
$ pdftotext -f 11 -l 11 -layout out/sheets/dwg/drawing-set.pdf - | grep -i "open workspace"
 154   Open Workspace (1)   Open Workspace   …     328.3
 208   Open Workspace (2)   Open Workspace   …      38.4
 …
 248   Open Workspace (7)   Open Workspace   …       1.0
```

(column 2 = ROOM NAME, disambiguated; column 3 = ROOM TYPE, `roomTypeLabel`, correctly still
"Open Workspace" for all seven.) The workbook agrees row for row — SG4 4.4.

Also in `roomNaming.ts`: `ROOM_ABBREVIATIONS`, the **single** exported abbreviation map
(`PHONE BOOTH → PH BOOTH → PB`, 15 entries), reached by both sheet families through
`roomLabelForms`, so two sheets can never abbreviate the same room differently. An unknown room
type is printed in full rather than mangled by a guess.

---

## 4. Gate amendments — two, both recorded in the gates' own headers

Both were forced, both make the gate **stricter**, and neither imports anything the drawing layer
produces: `lib/sheetlib.mjs` gains `scheduledRooms().display`, an **independent re-derivation** of
the naming rule from core state (the producer's helper is never imported by any gate).

**SG3 3.1/3.4 — `label` → `display`.** As written, 3.1 demanded `"OPEN WORKSPACE"` be found exactly
once on a sheet, *for each of the three rooms that share it*. No correct drawing can satisfy that:
printing one string for three rooms **is** D4, and printing three distinct strings makes the raw
label unfindable. The check was asserting the defect. All 17 fail-first failures still fire under
the amendment — 3.2's four overlap failures, the cut `POINT` and the unreadable `Wellness Room`
involve no duplicated name at all.

**SG4 4.1 → display names; 4.3/4.4 → exact prediction.** 4.1 read `zone.label` and required the
**core's** labels to be distinct — unsatisfiable without editing `crates/**`, which this mission is
barred from; it was grading the wrong system. Its own header always said it meant the *display*
name ("the drawing layer is where the disambiguation is meant to happen"). It now says so in code,
and still prints the input defect on a green board:

```
dwg every scheduled room ends up with a distinct name
    (1 core-state label collision(s) to resolve: "Open Workspace" on 246/247/248)
```

What got **stricter**: 4.3 shipped with a *grammar* — "the label plus at most a deterministic ` (n)`
ordinal" — which admits any ordinal. It now compares against the one name the gate predicts from
core state, so room 246 must read `Open Workspace (5)` and nothing else; and the same prediction is
now applied to the workbook as a **new check** (36 checks, was 33), on top of the workbook↔A.09
agreement check. The sheets and the workbook can no longer be consistently *wrong* together — the
hole SG4's own §4.4 note flagged. The now-dead `admissible`/`SUFFIX` helpers were deleted.

`scripts/drawing-set.test.mjs` also re-derives room names from core state; it gained a local
`displayGroups()` with the same rule (like its local `textWidth`, deliberately not imported). Its
**digests were not touched.**

---

## 5. Verification

```
$ node scripts/sheets/render-all.mjs --pack all
  sheet harness OK — 3 pack(s) × 12 sheets

$ node scripts/gates/sheets/run-all.mjs                      (full board, 332.7 s)
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (25 checks, 1 failing)
       └ FAIL drawing-set.test.mjs reports a result — the recorded baseline has 11
         sheets and the set now renders 12 (S2's A.10). S5 re-records; see §6.
  SG6  Determinism + independence   PASS  (16 checks)

$ SHEETS=1 bash scripts/gates/run-all.sh
  G1  Sheet structure  PASS (59)   G7   Video           PASS (19)
  G2  Formula liveness PASS (17)   G8   Web viewer      PASS  (9)
  G3  Quantity truth   PASS (92)   G9   Round-trip      PASS (24)
  G4  Plan graphic     PASS (18)   G10  One-action UX   PASS (14)
  G5  Thumbnails       PASS (70)   G11  Furniture agr.  PASS (56)
  G6  Renders          PASS (53)
  11/11 passing
  graded pack: 10/10 artifacts in out/ … unchanged since G10 produced it; PASS (12 checks)
ALL GATES GREEN.

$ cd web && pnpm typecheck      → clean
```

**59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12) — identical to the baseline**, with the
workbook's Inventory strings changed for three dwg rooms. G1/G3/G11 counts did not move, as asked.

`drawing-set.test.mjs` cannot reach its 252-check total while the baseline says 11 sheets. With the
baseline block bypassed (a throwaway copy, nothing written): **`drawing-set PASS (231 checks)` on
both packs** — every structural assertion, including "each room named exactly once" and "an off-room
label has a leader", holds for the new names and the new placements:

```
seeded: 12 sheets · 1120 text / 4221 line / 866 rect ops · rooms 22 ·
        A.01 2 off-room, 1 led · A.02 4 off-room, 2 led
dwg:    12 sheets · 1143 text / 5126 line / 1095 rect ops · rooms 23 ·
        A.01 9 off-room, 6 led · A.02 14 off-room, 11 led
```

### Digests that moved, and why (for S5)

| sheet | seeded | dwg | cause |
| --- | --- | --- | --- |
| 2 contents | moved | moved | **S2** — the A.10 row |
| 3 A.01 | same | moved | **S3** — a room label displaced by the ladder/strict placer |
| 4 A.02 | moved | moved | **S2** (schedule pagination) **+ S3** (display names, ladder) |
| 5 A.03 | moved (identical op counts) | moved (+1 line) | **S3** — label positions; the extra line is a leader |
| 6 A.04 | moved (identical op counts) | moved (+1 line) | **S3** — same |
| 11 A.09 | same | moved (identical op counts) | **S3** — `Open Workspace (5)/(6)/(7)` |
| 12 A.10 | new | new | **S2** |

Sheets 1, 7, 8, 9, 10 are byte-identical in both packs.

### Looked at, all three packs, A.03 and A.04

Read the PNGs at full sheet and at 1:1 crops. Every room name is complete and legible; no
over-print anywhere; the three phone booths, the two print points and the seven workspaces each
carry a distinct name with a leader where the label sits off its room. Before/after on dwg A.03:
`O OPEN WORKS OPEN WORKSPACE` and `IT / SERVI W` → `OPEN WORKSPACE (5)`, `(6)`, `(7)`,
`IT / SERVER`, `WELLNESS ROOM`, each on its own. seeded A.03's `PRINT POIN` / `PHON PHON PHONE
BOOTH 3` → `PRINT POINT 1`, `PRINT POINT 2`, `PHONE BOOTH 1/2/3`. testfit was already clean and
stays clean.

---

## 6. Open risks

1. **SG5 stays red until the baseline is re-recorded.** Not mine to fix (S5), and the *cause* is
   split: the 11→12 sheet count is S2's, the moved digests are both of ours. Everything else in SG5
   — the whole G1–G11 board and its counts — passes.
2. **The wrap and abbreviate rungs are live but never fire on these three packs.** They are the
   safety net under a pathological name, and if one ever fires SG3 3.1 will go red, because a
   wrapped or abbreviated name is not locatable as one glyph run. That is a *deliberate* tripwire,
   not a latent bug: the two rungs damage the name, and the gate is the thing that says so. If a
   future document legitimately needs them, the honest fix is to teach `findLabelRuns` about a
   two-baseline run — with the same care about not splicing two stacked labels into one phantom
   string that its `WORD_GAP` comment already documents.
3. **`drawing-set.test.mjs` filters A.02 labels on `t.size === 8`.** If the ladder ever shrinks an
   A.02 name, that test reports "drawn 0x for 1 zone(s)" rather than the real story. Flagged rather
   than fixed — changing it would be calibrating a test to a fix that has not happened.
4. **`extendedCandidates` widens displacement, and displacement costs attention.** dwg A.02 now has
   14 off-room labels (11 with leaders, 3 within the 6 pt leader threshold). That is a busier plan
   than a plan whose labels sit inside their rooms — but the alternative measured on the same sheet
   is a label with its neighbour's halo through it.
5. **Two runs of the full board failed their closing integrity pass** on `out/walkthrough.mp4`
   changing size (~1 KB) between the snapshot and the end, while a parallel agent's board was
   running. It is the ffmpeg-mtime race `.claude/rules/gate-independence.md` already records, not a
   product change (nothing here touches video). The quiet re-run printed
   `unchanged since G10 produced it; PASS (12 checks)`.
6. **One sheet render failed inside `run-all.sh`** (`render-all.mjs FAILED — out/sheets is whatever
   was on disk`) during the same contended window; the standalone re-run and every subsequent board
   run succeeded. Worth watching if it recurs on a quiet machine — a swiftshader/Chromium
   contention failure would be a flake the sheet gates cannot tolerate silently.
