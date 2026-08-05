# S4b-2 — Judge, drawing-set mission, round 2

**Verdict: no blocker. Every defect this mission opened against — D1–D5 — and every finding round 1
filed — D-A through D-G, D-I — is CLOSED, and I re-proved each one with my own instruments rather
than re-reading S6's and S7's.** Both boards are identical to the `1a2b8d5` baseline, check for check.

**But the drawing set is not issuable as a construction drawing set**, and the reason is the defect
the orchestrator found by looking: **107 room names, area strings and dimension strings print across
wall geometry or door-swing arcs on the 12 plan sheets, and 14 print outside the building outline.**
I measured that class at three points in time and it is **pre-existing and essentially flat** —
`103` at pre-mission `1a2b8d5`, `106` after S2/S3, `107` now. **S6 did not introduce it; S6 also did
not touch it.** No lane ever owned it and no gate looks at it.

One new **major gate hole**, falsified not argued: a glazed run silently dropped upstream of
`openingSchedule` loses its plan tag *and* its schedule row together, and **SG1 71 / SG2 8 / SG3 97
all stay green** — S7's new 1.5 anchors only the Door half to core state.

Everything below is from commands that ran on this machine. Two reconstructions were rendered in
scratch trees and are **verified**: the pre-S6 tree reproduces round 1's nine D-A words *coordinate
for coordinate*, and the pre-mission tree's digests are S0's recorded `1a2b8d5` hashes
(`seeded/A02 4fe0dcdf…`, `seeded/A03 580429d2…`, `dwg/A03 98f5bb2b…`, `seeded/A01 66aa3862…`).
No repo file was modified except this report; no `git stash/reset/checkout/clean/commit` was run —
`git status --porcelain` is unchanged apart from this file.

---

## 0. Duty 4 — the boards, run by me, in a quiet tree

```
$ node scripts/gates/sheets/run-all.mjs                                    (343.4 s)
  SG1  Panel containment            PASS (213 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (27 checks, 2 failing)
  SG6  Determinism + independence   PASS  (16 checks)
  5/6 passing
```

**SG5's two reds are the S5 baseline hand-off and nothing else — verified by reading the run, not by
assumption.** They are, verbatim, the only two FAIL lines the whole board printed:

```
FAIL drawing-set.test.mjs passes — it says FAIL
FAIL drawing-set.test.mjs still runs 252 checks — 281 checks now, 252 at the baseline
```

```
$ SHEETS=1 bash scripts/gates/run-all.sh                                   rc=0
  G1 59 · G2 17 · G3 92 · G4 18 · G5 70 · G6 53 · G7 19 · G8 9 · G9 24 · G10 14 · G11 56
  11/11 passing · unchanged since G10 produced it; PASS (12 checks) · ALL GATES GREEN.
```

**Zero count delta on either board.** No check appeared or vanished.

**Determinism.** I snapshotted the 39 PNG/PDF digests, then let three independent full renders run
(mine, SG5's, `run-all.sh`'s). `diff` of the digest lists: **IDENTICAL** after all three.

```
$ node scripts/drawing-set.test.mjs ; echo $?          →  drawing-set FAIL (281 checks)   rc=1
$ grep -c "^  FAIL"  → 14      all 14 are baseline rows:
  seeded/dwg: baseline has 11 sheets, this render has 12
  seeded sheet 2/4/5/6 · dwg sheet 2/3/4/5/6/11: content digest changed
  seeded/dwg sheet 12: the baseline has no row for this sheet
```

Both cases render and are graded. **Every structural, determinism, room-labelled-once and
off-room-leader assertion passes on both.** D-F is closed; only S5's re-record remains.

---

## 1. Duty 1 — the defect the orchestrator found, quantified across 12 sheets × 3 packs

### What it is

`out/sheets/seeded/A02.png`, 1:1 crop at (880,440)–(1180,640) px: **`PHONE BOOTH 2` and its
`1.4 m²` print straight across three booth outlines and their door-swing arcs.** Fully legible —
S6's paint order works, nothing is erased. It is a drafting defect, not an erasure defect, and no
gate asserts against it.

### The instrument

`scratchpad/overlap.mjs`. Wall segments and door-swing arcs come from **core state** (`coreState(pack)`),
re-projected with the same `planMap` `sg2-plate-confinement.mjs:76-120` uses (`stateBbox` fit, `pad = 48`,
`RES`, validated `plate` rect). Nothing is read from the renderer. Text boxes are poppler's measurement
of the delivered runs, chained into strings on the gate's own `SAME_LINE = 0.05` / `WORD_GAP = 3.5` rule.

Two corrections I had to make, both material, both from reading the renderer rather than assuming:

* **Layer-aware.** `pdf.ts:496-510` gates the component loop — the only thing that draws a door
  swing — on `furniture`, and `pdf.ts:533-536` gates the two wall classes. A.01 draws neither
  furniture nor generated walls; A.03 draws no furniture. Measuring against geometry a sheet does not
  draw is a false positive, so the instrument draws the same layers the sheet does. This removed 42
  false hits.
* **No mirror.** `pdf.ts:496-510` never passes `mirror` to `drawFurnitureSymbol`, so the sheet raster
  never flips a leaf. The instrument does not either.

A hit is a string whose box is within a wall's own half-thickness (`w.thickness × ptPerM / 2`) of that
wall's centreline, or within 0.7 pt of a door-swing arc polyline (`furniture.ts:255-274`: hinge at
`-w/2`, radius `w`, `-π/2 … 0`, plus the leaf line).

### The count — and the answer to "pre-existing or introduced by S6"

```
                             1a2b8d5      after S2/S3      NOW (after S6)
strings on wall / arc ink      103            106              107
strings outside the footprint    –             16               14
```

**106 of the 107 are identical to pre-S6 coordinate for coordinate.** Diffed as sets:

```
only in PRE (fixed by S6):   (none)
only in NOW (new under S6):  testfit/A02 roomlabel "MEETING ROOM 4" @ (381.7, 490.9)
common: 106      pre: 106      now: 107
```

The single new entry is a label S6 **moved back inside the building** from 21.9 pt outside — a net
improvement that trades one out-of-building label for one in-building label that crosses a wall.
And the orchestrator's exact case is byte-for-byte unchanged by S6:

```
PRE: PHONE BOOTH 2@(464.8,265.6)  wall 22.3 pt  arc 23.8 pt
NOW: PHONE BOOTH 2@(464.8,265.6)  wall 22.3 pt  arc 23.8 pt
PRE: 1.4 m²@(487.4,277)           wall 26.6 pt  arc  8.9 pt
NOW: 1.4 m²@(487.4,277)           wall 26.6 pt  arc  8.9 pt
```

**Verdict: PRE-EXISTING. Not introduced by S6's placement change, and untouched by it.**

### Per sheet (layer-aware, all three packs)

```
dwg/A01      8 (wall 8,  arc 0)     seeded/A02  12 (wall 7,  arc 10)     testfit/A02  22 (wall 17, arc 15)
dwg/A02     21 (wall 19, arc 8)     seeded/A03   4 (wall 4,  arc 0)      testfit/A03   4 (wall 4,  arc 0)
dwg/A03      9 (wall 9,  arc 0)     seeded/A04   6 (wall 4,  arc 5)      testfit/A04   5 (wall 4,  arc 4)
dwg/A04     11 (wall 9,  arc 9)     seeded/A01   0                       testfit/A01   5 (wall 5,  arc 0)
TOTAL 107
```

Worst individual cases, by wall centreline crossing the string's own box:

```
dwg/A01     "PHONE BOOTH 1"@(207,204)      66.2 pt of wall inside a 66.2 pt box  = 100%
dwg/A01     "OPEN WORKSPACE (3)"@(322,645) 89.7 pt inside an 89.8 pt box         = 100%
seeded/A02  "CABIN 2"@(544,255) / "CABIN 3"@(610,313)  31.9 pt inside 32.0 pt    = 100%
seeded/A02  "1.4 m²"@(487,277)   26.6 pt wall + 8.9 pt arc across a 21.3 pt box  = 125%
testfit/A02 "9.9 m²"@(375,226)   21.2 pt inside a 21.3 pt box                    = 100%
dwg/A02     "3.00 m"@(272,130)   22.9 pt inside a 22.9 pt box                    = 100%
```

### Ranked severity: MAJOR (product), gate ID none

The label is illegible-adjacent rather than illegible, so it is not a blocker; it is squarely a
drafting defect on the primary construction plan and it is on **every** plan sheet of **every** pack.

### File:line most likely responsible

`web/src/export/sheetSet.ts:1021`
```ts
const occ: OccBox[] = []
```
The construction plan's shared occupancy **starts empty**. Four annotation families reserve into it —
and nothing else ever does. The base raster's ink (walls, door swings, furniture symbols, the
demolition hatch on A.01) is invisible to every placer, so `tryPlaceNear` reports "clear" for a
position sitting on a wall.

**The asymmetry is the tell, and it is inside this repo.** `web/src/export/planGraphic.ts:300-304`,
the workbook's plan, does the opposite:

```ts
const occ: OccBox[] = []
for (const c of state.components) {
  if (c.category === 'Door') continue
  occ.push(componentBox(c, X, Y, k))
}
```

That is defect E7's landing fix ("labels now step aside for furniture exactly as they already step
aside for each other"). The drawing set never got it, and it needs walls and swings as well as
furniture. The booth case is exactly the one the mission brief describes: the booth is 1.4 m², the
label is wider than the room, so no in-room position exists and the correct answer is displace +
leader — machinery that already exists (`labelLeader`, `sheetSet.ts:724`) and that `PHONE BOOTH 1`
on the same sheet already uses.

### Why no gate sees it

* **SG3 3.2** compares label boxes to *label* boxes. A wall is not a label.
* **SG3 3.3** measures ink-free column runs inside a word box. A wall under a word adds ink; it never
  removes it. Structurally unable to fire.
* **SG2 2.5** asks whether a tag is *near* a wall — it wants attribution, the opposite assertion.
* **SG1** grades containment against the frame, band and panel, not against drawn geometry.

---

## 2. MAJOR — D-O (new, gate): a dropped glazed run is invisible to the entire sheet board

**Gate ID: SG1 1.5 (and SG2 2.4).** Severity **major** — gate defect; the shipped artifact is correct.
This is D-B's other half, and S7 closed only the half round 1 named.

1.5's own header states the design honestly: *"(a) and (b) compare two readings of the same artifact;
this one [1.5d] compares the delivered rows to the document"* — but 1.5d is
`components.filter(cc => cc.category === 'Door')` (`sg1-panel-containment.mjs:323`). **The Window
half has no external anchor at all**, and SG2 2.4 also counts door tags only. Both the plan tags and
the schedule rows descend from one `openingSchedule()` call, so they agree with each other by
construction — `.claude/rules/gate-independence.md` §"never calibrate against the population under
test", exactly.

Falsified in a scratch copy. One line, `web/src/export/sheetSet.ts:249`, drops one real glazed run
*before* tags or rows exist:

```js
const windows = mergeGlazedRuns(state.walls).sort(…)
  .filter((_, i) => i !== 3)     // one glazed run silently dropped
```

```
$ node scripts/sheets/render-all.mjs --pack seeded    → sheet harness OK — 1 pack(s) × 12 sheets
$ node scripts/gates/sheets/sg1-panel-containment.mjs --pack seeded   SG1 PASS (71 checks)
$ node scripts/gates/sheets/sg2-plate-confinement.mjs --pack seeded   SG2 PASS  (8 checks)
$ node scripts/gates/sheets/sg3-label-integrity.mjs   --pack seeded   SG3 PASS (97 checks)

$ pdftotext -f 4 … | grep -oE '\bW[0-9]+\b' | sort -uV
  sabotaged: W1 … W23        (24 windows → 23; W24 is gone from the set entirely)
  shipped  : W1 … W24
$ pdftotext -f 4 … | grep CONTINUED
  sabotaged: SCHEDULE CONTINUED ON A.10 (9 MORE)
  shipped  : SCHEDULE CONTINUED ON A.10 (10 MORE)
```

**A window that exists in the building is neither tagged on the plan nor scheduled anywhere, and the
sheet board is fully green.** The fix shape is a legal core-state anchor for the window half — the
total glazed wall length in core state must equal the sum of the scheduled window widths — the same
construction 1.5d already uses for doors. (I am reporting, not fixing.)

**File:line:** `scripts/gates/sheets/sg1-panel-containment.mjs:319-330`.

---

## 3. Duty 2 — the round-1 fixes, re-falsified with my own instruments

### 3.1 D-A — **CLOSED**, and the design survives attack

`scratchpad/j2-covered.mjs` — written independently of S6's `covered.mjs`, same anchors (the gate's
raster detector `lib/tags.mjs findTags` at plan scale, the `2r × 2r` mask, poppler word boxes, plate
rect from the validated `geometry.json`; a tag's own `[DW]\d+` token excluded).

**On the pre-S6 reconstruction it reproduces round 1's nine word for word and coordinate for
coordinate**, which is what makes "before" real:

```
seeded  A02  41 tags  193 plate words  >15%: 2   76% "BOOTH"@(495,266)  74% "m²"@(500,277)
testfit A02  48 tags  210 plate words  >15%: 3   34% "MEETING"@(155,520) 30% "ROOM"@(194,520) 28% "m"@(179,473)
dwg     A02  44 tags  185 plate words  >15%: 4  100% "m²"@(660,217) 43% "(4)"@(401,177)
                                                 29% "WORKSPACE"@(346,177) 16% "FOCUS"@(627,206)
TOTAL 9        (touched at all, threshold 0%: 13)
```

On the delivered set:

```
seeded  A02  41 tags  193 plate words  >0%: 0   (touched at all: 0)   tag-on-tag: 0
testfit A02  48 tags  210 plate words  >0%: 0   (touched at all: 0)   tag-on-tag: 0
dwg     A02  44 tags  185 plate words  >0%: 0   (touched at all: 0)   tag-on-tag: 1
TOTAL >0%: 0
```

**9 → 0, and 0 at a 0 % threshold.** Tag counts unchanged (41 / 48 / 44), so nothing was bought by
losing tags. S6's claim verified.

**Can any family's mask still reach another family's glyphs?** I traced every path that draws on a
plate, not just the ones S6 edited:

| sheet | builder | sink | masks queued | can a mask precede foreign type? |
| --- | --- | --- | --- | --- |
| A.01 | `demolitionSheet` `sheetSet.ts:838` | `paintNow` | none — `roomLabels` (`:774-831`) draws **no halo at all** | no: nothing opaque is drawn on the plate after the names |
| A.02 | `constructionSheet` `:980` | three passes | `tagMask` only | no: all masks flushed before all type (`paintPlanInk`, `:447`) |
| A.03 | `rcpSheet` `servicesSheets.ts:499` | three passes | fixture masks + label halos | no |
| A.04 | `powerSheet` `:578` | three passes | fixture masks + label halos | no |
| A.05–A.10, cover, contents | — | — | no plan annotation | n/a |

`drawTagGlyph` — the one-pass composite where a mask still precedes a body — has **exactly one call
site**, `sheetSet.ts:944` (`scheduleRow`, in the panel, over blank paper). Verified by grep across
`web/src/export/*.ts`. S6's open item #1 is correctly scoped.

Two residual observations, neither a defect today:

* **The three-pass order is a convention, not an invariant** — `p` is still reachable directly, and
  two call sites already draw on the plate outside the ink sink: `servicesSheets.ts:560`
  (`FINISHED CEILING HEIGHT …`) and `sheetSet.ts:863` (`NO DEMOLITION (NEW BUILD)`). Both are type,
  so neither can erase; neither reserves a box either. Measured: no collision on any pack.
* **dwg's one tag-on-tag mask overlap is harmless by construction** — both masks are in `masks`, both
  bodies in `symbols`, so a mask can only clip another mask (white on white). Confirmed by the ink
  measurement: 0 words degraded anywhere.

### 3.2 D-G on A.03 — **CLOSED**, and it was worse than round 1 measured

`scratchpad/j2-lc.mjs` — a third instrument, artifact-side: `CIRCUIT`-coloured ink
(`hex2rgb('#4f8a72')`, parsed out of `servicesSheets.ts:73` — palette is spec) inside each `LC-nn`
word box, against the median density over the sheet's own tags; plus overlapping `LC` word-box pairs.

```
                       tags with < 55 % of median green ink      overlapping LC word-box pairs
1a2b8d5                seeded  8 · testfit 0 · dwg  6            15 · 9 · 64
after S2/S3 (pre-S6)   seeded  0 · testfit 0 · dwg 18            15 · 9 · 64
NOW                    seeded  0 · testfit 0 · dwg  0             0 · 0 ·  0
```

S6's `15 / 9 / 64 → 0 / 0 / 0` verified exactly, on an instrument that reads delivered ink rather
than content-stream rects. The pre-S6 dwg figure (18) reproduces S6's own "18/40 before" number, and
shows S3's label fix had made dwg *worse* before S6 fixed all of it.

**The residual 2 S6 reported are placement residue, not ink loss.** My ink measurement finds **zero**
degraded tags on dwg. They are two `LC` tags that land under a fixture symbol whose knockout is now
painted before all type — visible in dwg A.03's top-left cluster, where the tag reads and the fixture
reads, stacked.

### 3.3 S7's gate repairs — SG4 4.1 and 4.2

Sabotage F4 re-applied in my own scratch tree (`roomDisplayNames` returns an empty `Map`), dwg
re-rendered, workbooks re-produced:

```
$ node scripts/gates/sheets/sg4-name-uniqueness.mjs --pack dwg
  FAIL dwg every scheduled room is given a name of its own in the delivered set
       (1 core-state label collision(s) to resolve: "Open Workspace" on 246/247/248) — …          ← 4.1
  FAIL dwg/A02 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (416,101) …       ← 4.2
  FAIL dwg/A03 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× …                    ← 4.2
  FAIL dwg/A04 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× …                    ← 4.2
  FAIL dwg/A09 no two schedule rows share a room name …                                           ← 4.3
  FAIL dwg/A09 every row's name is the one predicted from core state …                            ← 4.3
  FAIL dwg workbook Inventory names are the ones predicted from core state …                      ← 4.4
  FAIL dwg workbook Inventory names are unique …                                                  ← 4.4
SG4 FAIL (12 checks, 8 failing)          $ …sg3-label-integrity.mjs --pack dwg → SG3 FAIL (101, 12)
```

**All six of S1's original fail-first lines fire again.** D-D and D-E are closed. 4.1 is not a
tautology: every value on its assertion side is read out of the delivered A.09 rows; only the
condition comes from core state, and on seeded/testfit (no collisions) its `unnamed` arm still does
22 real lookups per pack.

**4.1's own blind spot, by construction, non-blocking.** `new Set(got).size !== ids.length` is checked
*within* a collision group. If the drawing disambiguated zone 246 to `"Open Workspace (1)"` — already
zone 154's core label — 4.1 would see three distinct names in the group and pass. **4.3's
"no two schedule rows share a room name" catches it**, and 4.3's prediction arm catches any
non-predicted name. Net coverage is sound; 4.1 alone is not a duplicate-name detector across groups.

### 3.4 SG1 §1.5 catches the fabricated schedule

Both round-1 sabotages re-applied (`where = 'A.99'`, `(0 MORE)` literal, `openingOverflow.slice(0,-1)`) —
the artifact round 1 measured as `SG1 201 / SG2 24 / SG3 295` all green:

```
$ node scripts/gates/sheets/sg1-panel-containment.mjs --pack seeded
  FAIL seeded every tagged opening has exactly one schedule row in the set — 1 of 41 plan tag(s)
       have NO schedule row anywhere: W24 (plan tags 41, rows 40 across A.02+A.10)
  FAIL seeded/A02 the continuation pointer resolves — the pointer names A.99, which the delivered
       set does not carry; the pointer says (0 MORE) but 9 row(s) are continued
SG1 FAIL (71 checks, 2 failing)
```

Verified. Its hole is D-O (§2), not this class.

### 3.5 D-C — the derived sheet count at the capacity boundary

The mission named 31/32; the measured boundary is **32/33** (`capFull = 32` without the continuation
note, `cap = 31` with it). I ran all four values through `openingSchedule(state).slice(0, n)`:

```
n = 31   → 11 sheets, rc=0, no pointer   SG1 PASS (65)  SG2 PASS (8)
n = 32   → 11 sheets, rc=0, no pointer   SG1 PASS (65)  SG2 PASS (8)     ← exactly capacity
n = 33   → 12 sheets, rc=0, "SCHEDULE CONTINUED ON A.10 (2 MORE)"   SG1 PASS (71)
n = 34   → 12 sheets, rc=0, "SCHEDULE CONTINUED ON A.10 (3 MORE)"   SG1 PASS (71)
```

`65 = 71 − 6`, i.e. exactly A.10's six containment checks and nothing else; 1.5c's "the pointer is
absent exactly when nothing overflowed" is green on both 31 and 32, and the counts are right on 33
and 34. **D-C is closed, including the boundary.** (Minor: `sg1-panel-containment.mjs:57` states the
threshold as "<= 31 tagged openings"; it is 32. Filed as D-T.)

### 3.6 The harness stage-and-swap really preserves evidence

Sabotage: the section-sheet builder throws inside its try-wrapper (`sheetSet.ts:1810`) — the
swiftshader failure mode.

```
$ shasum -a256 out/sheets/seeded/*.png out/sheets/seeded/*.pdf | sort > before.txt   (13 files)
$ node scripts/sheets/render-all.mjs --pack seeded
sheet harness FAILED: seeded: drawing set came back with 10 sheets, and 11 are unconditional. …
  the pack directory was NOT emptied — its previous contents are intact and RENDER-FAILED.json names
  this failure, so every sheet gate fails on this error rather than on "missing input".
$ echo $?                                 1        ← fails CLOSED
$ ls out/sheets/seeded | wc -l           27        ← 26 + RENDER-FAILED.json
$ diff before.txt after.txt              (empty)   ← BYTE-IDENTICAL, evidence preserved
$ for g in sg1 sg2 sg3 sg4 …
  FAIL seeded: the sheet harness FAILED on its last run and this pack was not re-rendered — …
       (the previous render is still on disk beside RENDER-FAILED.json; it is not the artifact under test)
  SG1 FAIL (1) · SG2 FAIL (1) · SG3 FAIL (1) · SG4 FAIL (1)
```

Verified on all four counts.

---

## 4. Duty 3 — I looked at all 36 sheets. What the gates waved through

Everything in this section is **pre-existing** unless stated, and none of it is covered by any gate.

### 4.1 MAJOR — D-Q: room names and areas printed outside the building, in the dimension band

`scratchpad/j2-outside.mjs` — the footprint is the core-state wall bbox, projected with the same
`planMap`; a string whose centre falls outside it is out of the building.

```
testfit/A02  7 strings outside          testfit/A01  4 strings outside
  "MEETING ROOM 2"@(231,607)  21.9 pt     "14.0 m²"@(255,589)   4.1 pt
  "MEETING ROOM 6"@(532,607)  21.9 pt     "14.0 m²"@(405,589)   4.1 pt
  "MEETING ROOM 8"@(683,607)  21.9 pt     "14.0 m²"@(556,589)   4.1 pt
  "14.0 m²"@(255,618)         33.1 pt     "14.0 m²"@(707,589)   4.1 pt
  "14.0 m²"@(556,618)         33.1 pt   seeded/A02  "FOCUS ROOM 2"  7.1 pt outside
  "14.0 m²"@(707,618)         33.1 pt   dwg/A01     "6.8 m²"        8.6 pt outside
  "12.8 m²"@(104,587)          1.3 pt   dwg/A02     "CORE 2"        5.9 pt outside
TOTAL 14   (was 16 before S6 — S6 improved this by 2)
```

Viewed at 1:1, `testfit/A02` px (150,1120)–(1620,1290): **`MEETING ROOM 2 / 14.0 m²`,
`MEETING ROOM 6 / 14.0 m²` and `MEETING ROOM 8 / 14.0 m²` sit below the bottom shell wall, on the
same baseline band as the overall `40.00 m` dimension and interleaved with the `W11 W18 W19 W25 W29`
tags.** A reader cannot tell which string is a dimension and which is a room name. On `testfit/A01`,
four `14.0 m²` strings are printed *on* the heavy black shell wall and read as struck through
(px (420,1130)–(1560,1200)). `RECEPTION`'s `12.8 m²` is struck the same way on both A.01 and A.02.

Same root cause and same file:line as §1 (`sheetSet.ts:1021`); the plate bound is honoured
(`plateBox`), the *building* bound is not.

### 4.2 Per-sheet notes (36 sheets, all viewed)

| sheet | seeded | testfit | dwg |
| --- | --- | --- | --- |
| cover | clean | clean | clean (irregular plate reads well) |
| contents | clean, 12 rows, byte-identical across packs | " | " |
| **A.01** | 22 names floating in an empty shell (demolition hides generated walls) — nothing to anchor to; 0 wall hits | 4 areas struck by the shell wall (§4.1) | **worst sheet in the set**: `PRINT POINT 1/2`, `PHONE BOOTH 1`, `IT / SERVER`, `CORE 1`, `WELLNESS ROOM`'s `7.2 m²` and `OPEN WORKSPACE (2)`'s `38.4 m²` all print over dense pink demolition hatch or the shell wall |
| **A.02** | the booth cluster (§1); `CABIN 2/3` 100 % on wall; the `24.00 m` overall dim still floats at the head of its line (D-M) | 22 hits; §4.1 | 21 hits; `OPEN WORKSPACE (1) 328.3 m²` prints straight through a row of desk symbols; `PRINT POINT 2`'s `2.8 m²` on the black shell wall |
| **A.03** | **two exit-luminaire `E` glyphs printed on the same point** (§4.3); long diagonal circuit legs cross the plate | long diagonal circuit leg from (150,258) to (545,430) px | **ceiling grid and fixtures are not clipped to the building polygon** — luminaires and grid lines print outside the shell (§4.4); a knot of 3 luminaires + 1 diffuser overlaps into illegibility top-left |
| **A.04** | clean apart from 6 wall hits | `PHONE BOOTH 1` crosses the right shell wall; the `DB` chip overlaps it | outlets print outside the shell at the bottom edge |
| **A.05 / A.06** | correct section, but it occupies the top ~45 % of the drawing area with ~55 % blank below | " | " |
| **A.07** | product cards carry **placeholder thumbnails (`CHA` / `DES` / `TAB`)** and `- ea` / `LINE TOTAL -`; 8 cards, ~⅔ page blank | 9 cards | 7 cards |
| **A.08** | **"NO PRODUCTS SPECIFIED YET"** — a ~95 % blank sheet in the delivered set | " | " |
| **A.09** | clean, 22 rows | clean, 22 rows | clean, 22 rows, `Open Workspace (1)…(7)` + `Core 1/2/3` all distinct — **D4 visibly closed** |
| **A.10** | 10 rows on a 3-column sheet, ~85 % blank (D-K) | 17 rows | 13 rows |

### 4.3 minor — D-R: two exit luminaires printed on the same point (seeded A.03)

`scratchpad/j2-wordpairs.mjs` re-runs S6 §4's claim ("0 overlapping word pairs on all three plan
sheets of all three packs") with the overlap taken as a fraction of the **smaller** box:

```
seeded   A03    97 plate words · pairs >0%: 1     39% "E"@(459,305) ↔ "E"@(461,306)
all other 8 sheet×pack combinations                0
```

Confirmed by raster at px (880,570)–(990,650): an amber exit tile sits on top of a second exit tile
and a ceiling luminaire symbol. **S6 §9.4 says of `clearOfLabels`' non-reserving copy of `occ`:
"Measured on all three packs it does not happen; it is a latent case."** It does happen — once. The
consequence is cosmetic (two `E` glyphs, neither erased, both painted in `symbols` before all type),
but the claim is disproved by construction and it is the same class the mission exists for.
**File:line: `web/src/export/servicesSheets.ts:412`** (`tryPlaceNear([...occ], …)` — the deliberate copy).

### 4.4 minor — D-S: the RCP ceiling grid and fixtures are not clipped to the building outline

On the dwg (irregular) plate, `out/sheets/dwg/A03.png` px (580,1180)–(1250,1360): a recessed
luminaire is drawn fully **below** the bottom shell wall, several fixtures straddle the diagonal
shell, and the 600×600 grid extends past the boundary on the right. `ceilingLayout` lays the grid
over the state bbox. Pre-existing, upstream of this mission, no gate.

---

## 5. Which defects are CLOSED, with evidence

| defect | verdict | my evidence |
| --- | --- | --- |
| **D1** A.02 schedule overflow | **CLOSED** | 41/48/44 plan tags = 31 A.02 rows + 10/17/13 A.10 rows, no orphan, pointer counts right; F1-class sabotage (`A.99` + dropped row) now reds SG1 1.5a/1.5c; the 32/33 capacity boundary paginates correctly (§3.5) |
| **D2** tags escaping the plate | **CLOSED** | SG2 24 green; 0 tags outside on all packs; and the side-effect it caused (D-A) is closed too |
| **D3** over-printed labels A.03/A.04 | **CLOSED** | 0 overlapping word pairs on all 9 plan sheets except the one `E`↔`E` services pair (D-R); 0 knocked-out circuit tags |
| **D4** duplicate room names | **CLOSED** | dwg A.09 reads `Open Workspace (1)…(7)`; F4 reds SG4 8/12 and SG3 12/101 |
| **D5** perimeter dim in the margin | **CLOSED** | SG1 1.2 green all packs; drafting quality still degraded (D-M) |
| **D-A** tag masks erasing plan words | **CLOSED** | my own instrument: **9 → 0**, 0 even at a 0 % threshold, tag counts unchanged; pre-S6 reconstruction reproduces round 1's nine exactly (§3.1) |
| **D-B** no gate on schedule completeness | **CLOSED for the fabrication class** | 1.5 fires by tag and by pointer on the exact artifact round 1 measured green. **The upstream half is open — D-O** |
| **D-C** suite inoperable below capacity | **CLOSED** | 31 / 32 / 33 / 34 openings all graded; fails closed with evidence preserved (§3.5, §3.6) |
| **D-D** 4.2 gone silent | **CLOSED** | fires 3× under F4 |
| **D-E** 4.1 tautological | **CLOSED** | fires under F4; assertion side is the delivered A.09; `unnamed` arm keeps it live on collision-free packs |
| **D-F** `drawing-set.test.mjs` aborts | **CLOSED** | 281 checks, both cases graded, 14 failures all baseline rows; SG5 back to 27 checks |
| **D-G** halos erasing circuit tags | **CLOSED** | 15/9/64 → 0/0/0 overlapping pairs; 8/0/6 (HEAD) and 0/0/18 (pre-S6) → 0/0/0 degraded tags |
| **D-I** 1.4b dead `delivered` array | **CLOSED** | both sides of 1.4b are now artifact-side |
| **D-H** A.01 graded by no label gate | **OPEN** | `sg3-label-integrity.mjs` `NAMED = A02, A03, A04`. dwg A.01 is the worst sheet in the set (§4.2) |
| **D-J** A.10 title widens 1.1's vocabulary | **OPEN**, minor | unchanged |
| **D-K** A.10 ~85 % blank · **D-L** schedule tags touch · **D-M** `24.00 m` at the head of its line · **D-N** 0.15 m sliver "windows" | **OPEN**, cosmetic | all still visible in the delivered set |

### New this round

| # | sev | finding | file:line |
| --- | --- | --- | --- |
| **D-O** | **major** (gate) | A glazed run dropped upstream loses its tag *and* its row together; SG1 71 / SG2 8 / SG3 97 all PASS. 1.5's Door half is anchored to core state, the Window half is not. Falsified (§2) | `scripts/gates/sheets/sg1-panel-containment.mjs:319-330` |
| **D-P** | **major** (product) | 107 room names / areas / dimension strings print across drawn wall geometry or door-swing arcs, on every plan sheet of every pack. Pre-existing: 103 at `1a2b8d5`, 106 pre-S6, 107 now (§1) | `web/src/export/sheetSet.ts:1021` (cf. `planGraphic.ts:300-304`) |
| **D-Q** | **major** (product) | 14 room names / areas printed outside the building footprint, up to 33 pt out, interleaved with the overall dimension string; 4 more struck through by the shell wall. Pre-existing: 16 pre-S6 → 14 now (§4.1) | same |
| **D-R** | minor | Two exit-luminaire `E` glyphs on the same point, seeded A.03 — S6 §9.4's "latent case" is live, and S6 §4's "0 overlapping pairs" is one short (§4.3) | `web/src/export/servicesSheets.ts:412` |
| **D-S** | minor | RCP ceiling grid + fixtures not clipped to the building polygon on the irregular dwg plate (§4.4) | `ceilingLayout`, upstream |
| **D-T** | cosmetic | SG1's header documents the pagination threshold as "<= 31 tagged openings"; measured 32 | `sg1-panel-containment.mjs:57` |
| **D-U** | cosmetic | A.08 is ~95 % blank ("NO PRODUCTS SPECIFIED YET"); A.07's cards carry placeholder `CHA`/`DES`/`TAB` thumbnails and no prices; A.05/A.06 leave ~55 % of the drawing area blank below the section | `moodboardSheet`, `furnitureSheet`, `sectionSheets` |

---

## 6. Is it shippable?

**Two different questions, and they have different answers. I will not blur them.**

**As the mission defined itself — close D1–D5, close round 1's findings, leave permanent gates
behind — YES, and nothing blocks close-out.** Every one of the eleven defects the mission and round 1
named is closed on evidence I generated myself; both boards match the `1a2b8d5` baseline check for
check; the sheets are byte-deterministic across three independent renders; the harness fails closed
and keeps its evidence. The only red is SG5's two baseline lines, which is S5's job and the correct
end state. **I found nothing that blocks.**

**As a drawing set an architect would issue — NO, not yet.** D-P and D-Q are real drafting defects on
the primary construction plan, on every sheet of every pack: the annotation system de-conflicts
annotation against annotation and is blind to the drawn building underneath it. The same repo already
solved that on the other plan (`planGraphic.ts:300-304`, defect E7's landing fix) and the drawing set
never inherited it. That is one file:line, one occupancy seeded with what is already drawn, and the
displace+leader machinery to absorb it is already there and already used.

**One gate item I would close before the sheet gates are treated as a standing contract: D-O.** A
window that exists in the building and appears nowhere in the deliverable is exactly the class the
sheet gates were built to make impossible, and today it passes.

---

### Method note

Two scratch trees, each a full `rsync` copy with `node_modules` symlinked. `scratchpad/preS6`
restored `sheetSet.ts` and `servicesSheets.ts` from the index (`git show :<path>`) — the state round 1
graded, verified by reproducing its nine D-A words exactly. `scratchpad/prerepo` is round 1's own
pre-mission reconstruction, verified against S0's recorded `1a2b8d5` digests. `scratchpad/j2repo`
carried each sabotage one construct at a time and was restored from the real repo between them.
Five instruments, all written for this round: `overlap.mjs` (strings vs core-state walls and door
swings), `j2-covered.mjs` (D-A), `j2-lc.mjs` (D-G), `j2-outside.mjs` (footprint), `j2-wordpairs.mjs`
(delivered-word overlap). The repository under
`/Users/udsy/.superset/worktrees/DSource-Editor/export` was never edited except for this file.
