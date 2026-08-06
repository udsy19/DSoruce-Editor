# S1-1 — six sheet gates, written before the fix, red on the defects they exist for

**Agent S1.** Gates only. **No defect was fixed** — SG1–SG4 are red at HEAD, which is the deliverable:
a gate written after a fix is calibrated to pass whatever the fix produced
(`.claude/rules/gate-independence.md` §"write the gate first").

```
$ node scripts/gates/sheets/run-all.mjs
  SG1  Panel containment            FAIL (183 checks, 14 failing)
  SG2  Plate confinement            FAIL  (24 checks,  5 failing)
  SG3  Label integrity              FAIL (295 checks, 17 failing)
  SG4  Name uniqueness              FAIL  (33 checks,  6 failing)
  SG5  Board integrity              PASS  (27 checks)
  SG6  Determinism + independence   PASS  (16 checks)
  2/6 passing                    336.8 s
FAIL: 4 sheet gate(s) red.
```

Files added
* `scripts/gates/sheets/lib/sheetlib.mjs` — the shared primitives (PNG decoder, ink classifier,
  template-spec parser + geometry validator, delivered-PDF text/vector readers, core-state loader,
  label locator, scoreboard).
* `scripts/gates/sheets/lib/tags.mjs` — opening-tag detection from the raster, by construction.
* `scripts/gates/sheets/sg1…sg6-*.mjs` — the six gates. Each carries its **fail-first output in its
  own header**, naming the rows / tags / labels / rooms it caught.
* `scripts/gates/sheets/run-all.mjs` — the sheet board; runs its own producers first.

One file changed: `scripts/gates/run-all.sh` — **step 0b is now unconditional** (S0 left it behind
`SHEETS=1`). `IDS`/`CMDS`/`TITLES` are untouched: the sheet gates are red by design, so wiring them in
as G12 now would take the deliverable board red for the whole mission. That is the last step, after
S2/S3, and SG5 is what protects the board's numbers until then. `SHEETS=1` still works and is a no-op.

---

## 0. The four failure sources, and why the gates cannot read any of them

| the gate needs | where it gets it | why that is legal |
| --- | --- | --- |
| page/band/panel/plate rects | `geometry.json`, **after `loadGeometry()` re-derives them** from `PAGE_W`/`PAGE_H` (pdf.ts), `MARGIN`/`TITLE_BLOCK_H`/`RES` (sheet.ts), `PANEL_W` (sheetSet.ts) parsed out of source | "metadata the gate can *validate* is acceptable" — a moved rect is a hard failure (proved in §6) |
| what the title block says | `titleBlock()`'s literals + the harness's frozen `SHEET_META` (an **input**) + the static sheet table + `FREEZE_DATE_AT` | spec and inputs, never the page |
| room names, doors, walls | `buildCaseDoc(pack).state` — **core state** | the document the sheets are built from |
| tag palette + glyph shape | `const INK`/`const BLUE_WALL` and `drawTagGlyph`'s sides/rotation/radii, parsed out of sheetSet.ts | spec |
| where anything actually landed | the **delivered PNG's pixels** and the **delivered PDF's own text layer and content stream** | the artifact |

The producer's own account — `out/sheets/index.json`, `<pack>/index.json`, and the *measured* fields
inside `geometry.json` (`page.wPx/hPx`, `image`, `title`, `id`, `no`, `kind`, `index`, `derivedFrom`,
`units`, `note`) — is read by **nothing**. §6 proves it byte-for-byte.

There is no `continue`-on-missing anywhere: `must()` turns an absent file into a named `GateError`,
and a `GateError` is a FAIL line.

---

## 1. SG1 — panel containment

`node scripts/gates/sheets/sg1-panel-containment.mjs` · 183 checks over 27 numbered sheets

| # | assertion | external anchor |
| --- | --- | --- |
| 1.1 | every word touching the `titleBlock` rect is one of the title block's **own** strings | `titleBlock()`'s literals (sheet.ts:311-373) + `SHEET_META` (input) + the sheet no/title table + the frozen date |
| 1.2 | **zero ink pixels** below / left of / right of the `frame` rect, ± half of the band's own 1.1 pt stroke | `MARGIN` (sheet.ts:20); stroke width from sheet.ts:318. *Top excluded and why: `p.text(MARGIN + 6, 42, 15, …)` puts a 15 pt ascender above y=40 by construction* |
| 1.3 | inside the big sheet-number box, the only ink is the `A.NN` glyph run | sheet.ts:325 `x5 = right - 130`, :371 `p.box(x5+12, top+24, right-x5-24, TITLE_BLOCK_H-44)`; inset 2 px for the box's own 0.6 pt outline |
| 1.4 | a schedule row rendered below its panel ⇒ continuation sheets exist **and are in the contents index**; and always: the contents index's `A.NN` list equals the delivered set's | the panel's legal extent = `bandTop` (template); the contents page is read from the artifact |

**Failing output at HEAD** (`node scripts/gates/sheets/sg1-panel-containment.mjs`):

```
FAIL seeded/A02 title-block purity — 80 foreign word(s) printed over the title block:
     W16 W16 Window 1.85 × 1.50 m Glazed partition +0.80 W17 W17 …
     (tags W16 W17 W18 W19 W20 W21 W22 W23)
FAIL seeded/A02 no ink below the frame — 2760 ink px, topmost row 1605, x 1685..2284
FAIL seeded/A02 no ink left of the frame — 255 ink px, topmost row 730, x 33..77
FAIL seeded/A02 sheet-number box carries only "A.02" — 2975 foreign ink px inside the number box,
     first at 2067,1424
FAIL seeded/A02 panel[legend-schedule] schedule overflow paginates — 9 row(s)
     (W16 W17 W18 W19 W20 W21 W22 W23 W24) print below the panel bottom 685.89 pt,
     and the contents index lists 0 continuation sheet(s)
FAIL testfit/A02 title-block purity — 80 foreign word(s) … (tags W15 W16 W17 W18 W19 W20 W21 W22)
FAIL testfit/A02 no ink below the frame — 6775 ink px, topmost row 1605, x 1685..2284
FAIL testfit/A02 no ink left of the frame — 255 ink px, topmost row 730, x 33..77
FAIL testfit/A02 sheet-number box carries only "A.02" — 2975 foreign ink px …
FAIL testfit/A02 panel[legend-schedule] schedule overflow paginates — 10 row(s)
     (W15 W16 W17 W18 W19 W20 W21 W22 W23 W24) …
FAIL dwg/A02 title-block purity — 83 foreign word(s) printed over the title block:
     W22 W22 Window 6.8 m² W33 2.80 × 1.50 m Glazed partition …
     (tags W22 W33 W23 W24 W25 W26 W27 W28 W29)
FAIL dwg/A02 no ink below the frame — 6754 ink px, topmost row 1605, x 1685..2284
FAIL dwg/A02 sheet-number box carries only "A.02" — 2975 foreign ink px …
FAIL dwg/A02 panel[legend-schedule] schedule overflow paginates — 10 row(s)
     (W22 W23 W24 W25 W26 W27 W28 W29 W30 W31) …
SG1 FAIL (183 checks, 14 failing)
```

All 14 failures are on **A.02**; the other 24 numbered sheets pass all four families. That asymmetry
is the evidence the gate is measuring the defect and not just printing red.

Three things the defect report did not say:

* **The overflow runs off the *page*, not merely into the title block.** The band bottom is
  `y = 801.89 pt`; row W24's text box on seeded is `yMin 807.615 … yMax 814.5525`. 2 760 ink px sit
  below the printable frame entirely.
* **It reaches the sheet number.** Schedule column 4 starts at `panelX + 200 = 1034.55 pt`, and the
  `A.02` box runs `1032.55 … 1138.55 pt`: the "Glazed partition +0.80" cell prints *inside the sheet
  number's box*, 2 975 ink px of it.
* **A fifth defect, not on anyone's list** — see §7.

---

## 2. SG2 — plate confinement

`node scripts/gates/sheets/sg2-plate-confinement.mjs` · 24 checks

Tags are found **in the raster, by construction** (`lib/tags.mjs`): `drawTagGlyph` paints a pure-white
`2r × 2r` mask, then a regular polygon — a 16-gon at `rot 0` in `INK` for a door, a hexagon at
`rot π/6` in `BLUE_WALL` for a window — then a **pure-neutral** bold glyph run at the centre. The
detector re-derives that outline from `polyOutline`'s own parameterisation, anchors a candidate centre
on every outline pixel (both shapes have a vertex at their topmost point), and scores outline
coverage. Two call sites give two radii, and the radius is the classification: **11 pt = plan tag
(belongs in the plate), 8 pt = schedule tag (belongs in the panel)**. No producer position list is
read; `openingSchedule()` is never called.

| # | assertion | external anchor |
| --- | --- | --- |
| 2.1 | every plan tag's glyph box lies inside `plate` | template rect |
| 2.2 | no plan tag box touches `titleBlock` or a panel | template rects |
| 2.3 | every schedule tag lies inside its panel | template rect |
| 2.4 | plan **door**-tag count == `components.filter(category === 'Door')` | **core state** — geometry a flag cannot drop |
| 2.5 | every core-state Door is either under its tag or joined to one by a leader in the delivered content stream; and the gate's own re-projection is validated first (every wall must land in the plate) | core state + `renderPrintCanvas`'s documented fit (`stateBbox`, `pad = 48`, `RES`), re-derived, not read |

Two classifier decisions worth recording, both forced by the *contaminated-reference* corollary:

* the ink→white blend test is capped at `t ≤ 1.06`, and **pure-neutral pixels are rejected**, because
  `INK = #2e343b` is nearly grey: without that, the 34 pt `A.02` numeral scored as a 16-gon and the
  gate reported four phantom door tags *in the title block of every sheet in every pack*. Palette is
  chromatic by definition; text is neutral by renderer definition — the same anchor pair the rule
  names.
* outline samples are taken along the polygon's **straight edges**, not its circumscribed circle.
  Sampling the circle put a hexagon's edge midpoint `r(1−cos 30°) = 3 px` outside its own stroke and
  detected **zero** plan-scale window tags while happily finding the 16-gons.

**Failing output at HEAD:**

```
FAIL dwg/A02 every plan tag inside the plate — 5 of 43 outside:
     Window@(466.5,63.5)pt [13.5 pt above the plate top],
     Door@(295.0,69.0)pt [8.0 pt above the plate top],
     Window@(203.5,70.0)pt [7.0 pt above the plate top],
     Window@(528.0,76.5)pt [0.5 pt above the plate top],
     Window@(376.0,728.5)pt [69.6 pt below the plate bottom]
FAIL dwg/A02 no plan tag over the title block or panel — Window@(376.0,728.5)pt overlaps titleBlock
FAIL seeded/A02  every schedule tag inside its panel —  9 of 41 outside, lowest at y=810.0 pt
                 (panel bottom 685.89 pt)
FAIL testfit/A02 every schedule tag inside its panel — 10 of 42 outside, lowest at y=824.0 pt
FAIL dwg/A02     every schedule tag inside its panel — 10 of 42 outside, lowest at y=824.0 pt
SG2 FAIL (24 checks, 5 failing)
```

`Window@(376.0,728.5)pt` **is S0's W33** — 69.6 pt below the plate, inside the title block's
NOTES/CLIENT band. **S0 reported one escaped tag; the gate names five.** Four more break the plate's
top edge by 0.5–13.5 pt.

2.4 and 2.5 **pass** — 17 / 18 / 11 plan door tags found in the raster against 17 / 18 / 11 `Door`
components in core state, and every one of those doors is under its tag or led to it. They are the
companions that keep 2.1–2.3 honest: an under-counting detector would show up as a 2.4 failure.

---

## 3. SG3 — label integrity

`node scripts/gates/sheets/sg3-label-integrity.mjs` · 295 checks

Expected strings come from **core state** (`zone.label`); the gate then locates each one in the
delivered text layer. Text extents are **poppler's own measurement of the delivered glyph runs, laid
out with the very font it rasterises with** — the producer's `textWidth()` estimator is part of the
system under test and is never called.

| # | assertion | external anchor |
| --- | --- | --- |
| 3.1 | every scheduled room's string is rendered **exactly once** on A.02, A.03, A.04 | core state |
| 3.2 | no two rendered labels overlap, counting the knockout halo | the halo pad is half the `+ 6` in `roomLabelBoxes` (servicesSheets.ts:291) and half the `+ 4` in `roomLabels` (sheetSet.ts) |
| 3.3 | **on the raster**: no ink-free column run wider than **0.5 em** inside a label word's own box | Helvetica's own metrics — the widest blank an intra-word pair can leave is two side bearings, ≈0.26 em at worst (a digit's 0.556 em advance around a ~0.30 em bowl). 0.5 em is ~2×. Corroborated, not calibrated: clean A.02 labels top out at 0.13 em |
| 3.4 | every room's name also appears on the A.09 finish schedule | core state |
| 3.5 | no room name is rendered truncated (`clip()`'s ellipsis) | sheet.ts `clip()` |

The word-chaining rule is anchored too, and it mattered: two words join into one drawn string only if
they are **one Helvetica space apart** (0.278 em → 2.78 pt at the largest label face), because two
*different* room labels printed side by side on one baseline sit ~2.6 pt apart. A loose gap spliced
them into phantom strings and hid the defect.

**Failing output at HEAD:**

```
FAIL seeded/A03 no two room labels overlap — 7 overlapping pair(s):
     FOCUS ROOM 1 ↔ FOCUS ROOM 2 | PRINT POINT 1 ↔ PRINT POINT 2 |
     PRINT POINT 2 ↔ PHONE BOOTH 1 | PRINT POINT 2 ↔ PHONE BOOTH 2 |
     PHONE BOOTH 1 ↔ PHONE BOOTH 2 | PHONE BOOTH 1 ↔ PHONE BOOTH 3 |
     PHONE BOOTH 2 ↔ PHONE BOOTH 3
FAIL seeded/A03 no glyph run is cut — 1: POINT at (438.5,267.8)pt has a 8 px (0.53 em)
     ink-free column run inside its own box
FAIL seeded/A04 … the same 7 pairs, the same cut word
FAIL dwg/A03 room 118 "Wellness Room" rendered exactly once — rendered 0× — the string is not
     recoverable from the delivered page (an overlapping label has broken the glyph run)
FAIL dwg/A03 rooms 246 / 247 / 248 "Open Workspace" rendered exactly once — rendered 3× (each)
FAIL dwg/A03 no two room labels overlap — 14 overlapping pair(s):
     MEETING ROOM 1 ↔ MEETING ROOM 2 | FOCUS ROOM 2 ↔ RECEPTION | STORAGE ↔ PRINT POINT 2 |
     PRINT POINT 1 ↔ PRINT POINT 2 | IT / SERVER ↔ OPEN WORKSPACE (2) |
     PHONE BOOTH 1 ↔ PHONE BOOTH 2 | PHONE BOOTH 1 ↔ PHONE BOOTH 3 |
     PHONE BOOTH 1 ↔ OPEN WORKSPACE (4) | …
FAIL dwg/A04 … the same 14 pairs, the same 0×, the same 3×
FAIL dwg/A02 rooms 246 / 247 / 248 "Open Workspace" rendered exactly once — rendered 3× (each)
SG3 FAIL (295 checks, 17 failing)
```

`testfit/A03` and `testfit/A04` pass 3.2 with **0** overlapping pairs, and so do all three A.02s —
the check measures collisions, it does not just print red.

**The defect is misdescribed as "clipping."** It is **overprinting**: `drawRoomLabels`
(servicesSheets.ts:326) paints each label as a white knockout box then its text, in order, so a later
label's halo *erases* an earlier label's glyphs. `PRINT POIN` is `PRINT POINT` (369.73→417.24 pt) with
its final `T` under the halo of a second `PRINT POINT` (413.87→461.38 pt). Nothing is clipped by a
region boundary; the ladder S2/S3 build has to solve **collision**, and a fit-ladder alone will not.

**Worse than reported on dwg.** Room 118 `Wellness Room` is not merely damaged: another label's
glyphs are interleaved so far into it that poppler reads **`W` + `ELLNESS` as two words**
(`xMax 541.25` / `xMin 541.25` on page 5). The room's own name is *not recoverable from the delivered
page at all*, on both A.03 and A.04.

---

## 4. SG4 — name uniqueness

`node scripts/gates/sheets/sg4-name-uniqueness.mjs` · 33 checks

| # | assertion | external anchor |
| --- | --- | --- |
| 4.1 | no two scheduled rooms end up with the same display name | core state |
| 4.2 | no rendered room-name string appears twice on A.02 / A.03 / A.04 | core state → delivered text layer |
| 4.3 | A.09's rows (parsed off the delivered page: leftmost word on a baseline = room id, the single-space run after it = name) have unique names; every id is a core-state zone; every name is its zone's label plus **at most a deterministic ` (n)` ordinal** | core state; the suffix grammar is asserted, so an unpredictable scheme is a failure |
| 4.4 | `out/cases/<pack>/quantity-takeoff.xlsx` → `Inventory!Room ID` / `Program Room Name` agrees with A.09 row for row, and is itself unique | the workbook, parsed from its ZIP bytes |

**Failing output at HEAD:**

```
FAIL dwg core state gives every scheduled room a distinct name —
     "Open Workspace" is the label of 3 zones: 246, 247, 248
FAIL dwg/A02 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (469,101) (407,130) (416,159)
FAIL dwg/A03 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (412,130) (421,130) (473,130)
FAIL dwg/A04 no room name is rendered twice — "OPEN WORKSPACE" rendered 3× at (412,130) (421,130) (473,130)
FAIL dwg/A09 no two schedule rows share a room name — "Open Workspace" on rows 246, 247, 248
FAIL dwg workbook Inventory names are unique — "Open Workspace" on rooms 246, 247, 248
SG4 FAIL (33 checks, 6 failing)
```

seeded and testfit pass all four — 22 rooms, 22 distinct names, 22 schedule rows, and a workbook that
agrees with every one of them.

**A finding for S3's design.** The consistency half (4.4) is **green on this defect**: A.09 and the
workbook *agree*, room for room, that three rooms are called "Open Workspace". A cross-artifact
consistency check written on its own would have certified the defect. It is 4.1–4.3 that catch it,
and 4.4 exists to stop the fix landing in one artifact and not the other. Related: rooms 154 / 208 /
211 / 214 **already** carry `(1)`…`(4)` — those suffixes are in `zone.label` in core state, not added
by any drawing layer, so a shared helper must be idempotent over names that already end in ` (n)`.

---

## 5. SG5 — board integrity

`node scripts/gates/sheets/sg5-board-integrity.mjs` · 27 checks · **PASS**

Runs `bash scripts/gates/run-all.sh G1 … G11` and `node scripts/drawing-set.test.mjs`, and compares
every check count against the orchestrator's own `1a2b8d5` baseline (`reports/ORCHESTRATOR_LOG.md`) —
an external anchor recorded before any sheet work began, never read back off today's board. A count
delta is a FAILURE even if every check still passes.

```
$ SHEETS=1 bash scripts/gates/run-all.sh
  producing G9's round-trip cases: node scripts/export-pack.mjs
  rendering the drawing sheets: node scripts/sheets/render-all.mjs
--------------------------- SCOREBOARD -----------------------
  G1   Sheet structure    PASS  (59 checks)     G7   Video          PASS  (19 checks)
  G2   Formula liveness   PASS  (17 checks)     G8   Web viewer     PASS   (9 checks)
  G3   Quantity truth     PASS  (92 checks)     G9   Round-trip     PASS  (24 checks)
  G4   Plan graphic       PASS  (18 checks)     G10  One-action UX  PASS  (14 checks)
  G5   Thumbnails         PASS  (70 checks)     G11  Furniture agr. PASS  (56 checks)
  G6   Renders            PASS  (53 checks)
  11/11 passing
               unchanged since G10 produced it; PASS  (12 checks)
ALL GATES GREEN.                                                                (rc=0)

$ cd web && pnpm typecheck        → clean (tsc --noEmit, no output)
$ node scripts/drawing-set.test.mjs
  seeded: 11 sheets · 1088 text / 4204 line / 860 rect ops · rooms 22 …
  dwg:    11 sheets · 1111 text / 5110 line / 1089 rect ops · rooms 23 …
  drawing-set PASS (252 checks)
```

59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12) = **443**, and **252** — identical to the
baseline, with step 0b now unconditional. No sheet output moved: S1 wrote no drawing code.

There is no recursion risk. The sheet gates are not on `run-all.sh`'s board, so SG5 runs the suite and
nothing runs SG5.

---

## 6. SG6 — determinism + independence

`node scripts/gates/sheets/sg6-determinism.mjs` · 16 checks · **PASS**

```
  A: 33/33 PNGs byte-identical across two independent renders
  B: SG1 identical over {pristine, corrupted, deleted} (2060 B each)
  B: SG2 identical over {pristine, corrupted, deleted} (860 B each)
  B: SG3 identical over {pristine, corrupted, deleted} (2686 B each)
  B: SG4 identical over {pristine, corrupted, deleted} (684 B each)
  C: a deleted geometry.json fails SG1 by name; a moved titleBlock rect fails SG1 with the
     template-drift message
SG6 PASS (16 checks)
```

**A — determinism.** A second full render is compared to the one on disk **per PNG digest**, on this
machine, in this run. Per S0's §7.1 risk, no digest is ever compared against a checked-in constant —
font substitution is machine-local, so a recorded hash would be a landmine on another box.

**B — the three-run independence proof, reproduced by hand.** Three copies of `out/sheets`:
`A` pristine, `B` with both `index.json` manifests replaced by `{}` and `page.wPx`/`page.hPx`/`image`/
`title`/`id`/`no`/`kind`/`index`/`derivedFrom`/`units`/`note` set to `"CORRUPTED"` in all 33
`geometry.json`s, `C` with the same fields deleted outright. Each gate run against all three, its
whole stdout+stderr digested:

```
             pristine                    corrupted                   deleted
SG1   2060B ced6291bb8097d2e  |  2060B ced6291bb8097d2e  |  2060B ced6291bb8097d2e  → IDENTICAL
SG2    860B f29f7ed35b6dd04b  |   860B f29f7ed35b6dd04b  |   860B f29f7ed35b6dd04b  → IDENTICAL
SG3   2686B 41ca2c5cc9c974df  |  2686B 41ca2c5cc9c974df  |  2686B 41ca2c5cc9c974df  → IDENTICAL
SG4    684B a54cfca4a3e4801a  |   684B a54cfca4a3e4801a  |   684B a54cfca4a3e4801a  → IDENTICAL
```

Identical bytes, not "still fails the same way": the producer's account of its own work has no
influence left. (Sheet identity comes from the on-disk filename `A02.png` ↔ `A02.geometry.json` and
the static `SHEETS` table, which is why `image`/`title`/`no` can be vandalised with no effect.)

**C — the falsification, the other way round.** What the gates *do* consume must be load-bearing:

* delete `seeded/A02.geometry.json` → `SG1 FAIL (8 checks, 1 failing)` with
  `missing input: <…>/seeded/A02.geometry.json — render the sheets first: node
  scripts/sheets/render-all.mjs`. A missing input is a failure, never a skip.
* move `titleBlock.pt.y` by −200 → `SG1 FAIL (8 checks, 1 failing)` with
  `seeded/A02.geometry.json: titleBlock.pt.y=485.89 but the template says 685.89 (PAGE_W/PAGE_H from
  pdf.ts, MARGIN/TITLE_BLOCK_H from sheet.ts, PANEL_W from sheetSet.ts)`.
  `geometry.json` is admissible *only* because it is validated, and this is the validation firing.

---

## 7. What the four defect descriptions missed

1. **D5 (new) — the overall perimeter dimension string prints outside the page frame.** SG1's 1.2
   catches it on seeded and testfit A.02: 255 ink px at `x 33..77 px`, and in the delivered text layer
   `24.00` occupies `xMin 16.26 … xMax 35.03 pt` with its `m` at `37.11 … 43.36 pt`. `MARGIN = 40`,
   so the building's own width dimension straddles the frame and mostly sits in the unprintable left
   margin. Same family as D1 (containment), different producer (`dimStrings`, not the schedule).
   **Not routed to anyone. Needs an owner.**
2. **D1 is worse than "over the title block."** It runs off the bottom of the printable page (rows at
   `y 807–814 pt` against a frame bottom of `801.89 pt`), and it prints *inside the A.02 sheet-number
   box* (2 975 ink px). Nine to ten rows per pack, not "W17–W24".
3. **D2 is five tags, not one.** W33 in the NOTES panel is the worst, at 69.6 pt below the plate; four
   more break the plate's top edge by 0.5–13.5 pt on dwg.
4. **D3 is overprinting, not clipping.** A fit ladder (wrap → shrink → abbreviate) does not address
   it: the labels *fit*, they are drawn on top of each other, and each one's white knockout halo eats
   its neighbour. Displacement + leader is the operative rung. On dwg it is severe enough that
   `Wellness Room` is unreadable to poppler itself.
5. **D4's suffixes already exist, partially.** Rooms 154/208/211/214 carry `(1)`…`(4)` **in
   `zone.label`, from the generator**; 246/247/248 do not. A drawing-layer helper must therefore be
   idempotent over labels that already end in ` (n)`, or the fix produces `Open Workspace (1) (1)`.
6. **Schedule glyphs already collide with each other.** A schedule row is `rowH = 15 pt` = 30 px, and
   the 8 pt tag hexagon is 32 px tall: consecutive glyphs touch. Visible in the raster, cosmetic
   today, but it means the schedule's row pitch has no headroom — worth knowing before pagination is
   designed.
7. **`contents.png` is byte-identical across all three packs** (S0 noted it). SG1's contents-index
   check now depends on that: if pagination adds a continuation sheet, the contents page must change,
   and that check is what will notice.

---

## 8. Known limits of these gates

* **SG2's leader assertion covers doors only.** A window's anchor is the midpoint of a merged glazed
  run, and merging (`mergeGlazedRuns`) is producer logic a gate must not re-run. Doors are components
  in core state, so their anchors are re-derivable; windows are checked for containment (2.1–2.3) but
  not for attribution.
* **SG2's leader is read from the PDF content stream, not the pixels.** For a 0.4 pt stroke over a
  white mask, emission and visibility coincide closely — but this is the one place a sheet gate
  grades vector ops rather than delivered ink, and it is recorded here rather than glossed.
* **SG3's 0.5 em cut test is a coarse net.** It caught one word (`POINT`, 0.53 em). The overlap check
  (3.2) is the sharp instrument; 3.3 exists so that a fix which merely *moves* labels apart without
  removing the erasure cannot pass on geometry alone.
* **SG1's 1.1 is a vocabulary check.** It cannot see a *vector* intrusion into the title block that
  carries no text. 1.2 and 1.3 cover ink; 1.1 covers words. Between them the band is covered, but not
  by a single assertion.
* **The sheet gates take ~5.5 min end to end**, dominated by SG5 (the full G1–G11 board, 4:30) and
  SG6 (a second 33-sheet render). `node scripts/gates/sheets/run-all.mjs SG1 SG2 SG3 SG4` is the
  ~40 s loop for S2/S3 to iterate against.
