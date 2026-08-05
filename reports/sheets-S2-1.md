# S2-1 — containment: the schedule paginates, the tags stay on the plate, the dims stay on the page

**Agent S2.** Three defects, all "content painted outside its allowed region": **D1** (A.02 schedule
overflow), **D2** (opening tags escaping the plate) and the **fifth defect SG1 found** (the overall
perimeter dimension string in the unprintable left margin). A fourth escape, not on anyone's list, is
fixed too: on dwg a room's `6.8 m²` printed *across the title-block band top* (§3).

```
BEFORE                                          AFTER
  SG1  Panel containment   FAIL (183, 14)         SG1  Panel containment   PASS (201 checks)
  SG2  Plate confinement   FAIL  (24,  5)         SG2  Plate confinement   PASS  (24 checks)
  SG6  Determinism         PASS  (16)             SG6  Determinism         PASS  (16 checks)
```

The whole sheet board, with S3's D3/D4 fix landed alongside (`node scripts/gates/sheets/run-all.mjs`):

```
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)      ← S3
  SG4  Name uniqueness              PASS  (36 checks)      ← S3
  SG5  Board integrity              FAIL  (25 checks, 3 failing)
  SG6  Determinism + independence   PASS  (16 checks)
  5/6 passing
```

SG5's three are the expected hand-off plus worktree contention, not a defect — see §6.

---

## 0. Before / after, pasted

**Before** (`node scripts/gates/sheets/run-all.mjs --no-produce SG1 SG2`, at HEAD, my own run —
reproduces S1's fail-first output line for line):

```
FAIL seeded/A02 title-block purity — 80 foreign word(s) printed over the title block: W16 W16 Window 1.85 × 1.50 m Glazed partition +0.80 W17 W17 … (tags W16 W17 W18 W19 W20 W21 W22 W23)
FAIL seeded/A02 no ink below the frame — 2760 ink px, topmost row 1605, x 1685..2284
FAIL seeded/A02 no ink left of the frame — 255 ink px, topmost row 730, x 33..77
FAIL seeded/A02 sheet-number box carries only "A.02" — 2975 foreign ink px inside the number box, first at 2067,1424
FAIL seeded/A02 panel[legend-schedule] schedule overflow paginates — 9 row(s) (W16 … W24) print below the panel bottom 685.89 pt, and the contents index lists 0 continuation sheet(s)
FAIL testfit/A02 … the same five, rows W15-W24, 6775 ink px below the frame
FAIL dwg/A02 title-block purity — 83 foreign word(s) … (tags W22 W33 W23 W24 W25 W26 W27 W28 W29)
FAIL dwg/A02 no ink below the frame — 6754 ink px …
FAIL dwg/A02 sheet-number box carries only "A.02" — 2975 foreign ink px …
FAIL dwg/A02 panel[legend-schedule] schedule overflow paginates — 10 row(s) …
FAIL seeded/A02  every schedule tag inside its panel —  9 of 41 outside the panel; lowest at y=810.0 pt (panel bottom 685.89 pt)
FAIL testfit/A02 every schedule tag inside its panel — 10 of 42 outside the panel; lowest at y=824.0 pt (panel bottom 685.89 pt)
FAIL dwg/A02 every plan tag inside the plate — 5 of 43 outside: Window@(466.5,63.5)pt [13.5 pt above the plate top], Door@(295.0,69.0)pt [8.0 pt above the plate top], Window@(203.5,70.0)pt [7.0 pt above the plate top], Window@(528.0,76.5)pt [0.5 pt above the plate top], Window@(376.0,728.5)pt [69.6 pt below the plate bottom]
FAIL dwg/A02 no plan tag over the title block or panel — Window@(376.0,728.5)pt overlaps titleBlock
FAIL dwg/A02 every schedule tag inside its panel — 10 of 42 outside the panel; lowest at y=824.0 pt (panel bottom 685.89 pt)

  SG1  Panel containment            FAIL (183 checks, 14 failing)
  SG2  Plate confinement            FAIL (24 checks, 5 failing)
  0/2 passing                    3.5 s
FAIL: 2 sheet gate(s) red.
```

**After** (`node scripts/sheets/render-all.mjs --pack all` then
`node scripts/gates/sheets/run-all.mjs --no-produce SG1 SG2 SG6`):

```
  seeded:  12 sheets → out/sheets/seeded/  (2382×1684 px @ 144 dpi, pdf 1216768 B)
  testfit: 12 sheets → out/sheets/testfit/ (2382×1684 px @ 144 dpi, pdf 1138026 B)
  dwg:     12 sheets → out/sheets/dwg/     (2382×1684 px @ 144 dpi, pdf 1341240 B)
sheet harness OK — 3 pack(s) × 12 sheets

--------------------------- SCOREBOARD -----------------------
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG6  Determinism + independence   PASS  (16 checks)
--------------------------------------------------------------
  3/3 passing                    37.4 s
ALL SHEET GATES GREEN.
```

Zero failing lines. **No gate assertion was weakened** — SG1 grew from 183 to 201 checks (+6 per pack),
because the new continuation sheet is now graded by every containment family that applies to it:
1.1 title-block purity, 1.2 frame (×3 edges), the sheet number is drawn, 1.3 number-box purity. It
carries no panel column, so 1.4 does not apply to it (§5).

---

## 1. D1 — the schedule measures its panel and paginates

`web/src/export/sheetSet.ts`.

**The row renderer became one function, drawn in two places.** `scheduleHeader()` (section title +
grey band + TAG/TYPE/SIZE/MATERIAL headers) and `scheduleRow()` (tag glyph · tag · type · size ·
material/sill · rule) are lifted out of `constructionSheet` verbatim, parameterised only by the
column's left edge `x`. The A.02 legend panel and the continuation sheet call the *same* two
functions on a `PANEL_W`-wide column, so the two renderings cannot drift apart, and the extraction
itself moves nothing (same ops, same order).

**Capacity is measured, not assumed** — that is the actual defect. Rows advance from a first baseline
by `SCHED_ROW_H = 15` and reach `SCHED_ROW_DROP = 5` below it (the 8 pt tag hexagon is centred at
`ly − 3` with r = 8, so its white mask bottoms at `ly + 5`; the glyph, not the text, is what has to
clear the edge). `scheduleCapacity(firstY, bottom) = floor((bottom − 5 − firstY) / 15)`.

On A.02 the panel's legal bottom is the title-block band top, `PAGE_H − MARGIN − TITLE_BLOCK_H =
685.89 pt`, and the first row baseline is 198 pt (66 plan top + 20 + 24 + 20 + 20 + 26 legend advance
+ 22 header). So:

| | value |
| --- | --- |
| capacity, no continuation | `floor((685.89 − 5 − 198) / 15)` = **32** |
| capacity when a continuation pointer must fit (`SCHED_CONT_NOTE_H = 16`) | **31** |
| openings tagged (seeded / testfit / dwg) | **41 / 48 / 44** |
| rows paginated off A.02 | **10 / 17 / 13** |

A.02 draws its 31 and stamps `SCHEDULE CONTINUED ON A.10  (10 MORE)` at `y = 677 pt` — inside the
panel, 9 pt clear of the band.

**The continuation sheet reuses the existing renumbering machinery; it does not add a second one.**
`scheduleContSheets(state, opts, rows, startNo, from)` self-numbers `A.(startNo + i + 1)` — the exact
contract `sectionSheets`, `servicesSheets` and `finishScheduleSheets` already use — and the
orchestrator appends it with `startNo = numbered.length` after the finish schedule:

```ts
if (openingOverflow.length > 0) {
  const cont = scheduleContSheets(state, opts, openingOverflow, numbered.length, constructionNo)
  for (const s of cont) numbered.push({ title: s.title, no: s.no, page: s.page })
  noteContinuedOn?.(cont.map((s) => s.no))
}
```

`contentsSheet(opts, numbered)` is built from that same list, so the index followed for free — no
contents code was touched. **Why at the back of the set rather than after A.02:** schedules belong
together at the back of a drawing set (it sits beside A.09 Room Finish Schedule), *and* it means
A.01–A.09 keep the numbers they already had — the renumbering is additive, one new slot, instead of
shifting seven sheets and every downstream table with them.

The chicken-and-egg (A.02 must name a sheet that does not have a number yet) is resolved by returning
a closure: `constructionSheet` now returns `{ page, overflow, noteContinuedOn }`, and the pointer op
is appended to the already-built `Page` once the numbers exist. Deterministic — SG6 confirms.

The continuation sheet lays that same 316 pt column **three-up across the frame** (`CONT_COLS = 3`,
capacity `38 × 3 = 114` rows/sheet) and chunks onto further sheets beyond that, with `SHEET n OF m`
in the corner. Every column repeats the header band. All three packs need exactly one.

---

## 2. D2 — tags confined to the plate, and kept off each other

**`placeNear` gained an optional `bounds` region, and nothing else.** The de-collision search skips
candidates whose box would leave `bounds`; when every in-region candidate collides it still returns
the least-overlapping one (so a tag lands on a desk symbol, with a leader — correct drafting — rather
than in the NOTES panel); if the region cannot hold the box at any candidate it clamps the true spot
into it. **Callers that pass no `bounds` take a byte-identical path**: the only other change in that
function is `best` starting as `null` instead of `[0,0]`, and the loop provably assigns it on the
first candidate whenever bounds are absent (`overlapArea > 0` for any box that `boxesOverlap` reports).
`planGraphic.ts` — the shared caller commit `2420722` broke — is not touched and passes no bounds;
**G4 (18) and G11 (56) are unchanged and green** (§6).

`constructionSheet` passes `plateBox(b)` — the same rect `sheetGeometry().plate` reports — to both the
opening-tag pass and `roomLabels`.

**A second failure appeared the moment the tags were confined, and it is fixed here too.** With the
escape route closed, dwg's tags began to *stack*: `drawTagGlyph` lays a white mask before its outline,
so two overlapping tags erase each other, and SG2 caught it immediately —
`dwg/A02 one plan door tag per Door component — 10 door tags drawn, 11 Door components in core state`.
That is exactly the overprinting class D3 is about, in the tag domain. The fix keeps a second
occupancy list of tags only: if `placeNear`'s answer overlaps a tag already placed, the tag is
re-placed against the tags alone (a tag over furniture reads; a tag over a tag does not).

Measured on the delivered content streams (mask rects read out of the PDF bytes, not from the
producer):

| pack | plan tags | outside the plate | tag-on-tag overlaps | leaders to a displaced tag |
| --- | --- | --- | --- | --- |
| seeded | 41 | **0** (was 0) | **0** | 30 |
| testfit | 48 | **0** | **0** (was 1) | 43 |
| dwg | 44 | **0** (was 5) | **0** (was 3) | 31 |

The leader column is the shared machinery reused, not rebuilt: **104 tag leaders across the three
A.02s** (the brief put the whole set at ~20 before), because confining the tags means far more of them
are displaced — and every displacement over 14 pt now carries its pointer back to the opening. SG2's
2.4 (door-tag count vs core state) and 2.5 (every core-state Door under its tag or led to it) pass on
all three packs.

---

## 3. The dimension string, and one more escape

**The new defect (SG1 1.2).** `dimStrings` draws the overall height dimension outward-left of the
plate and right-aligns its label at `x − 4`. `renderPrintCanvas` pads the plate by only 48 px (~18 pt),
so on a width-constrained plate the left wall lands barely inside the plate and there is no room:
measured `24.00 m` at **x 16.26 … 43.36 pt against `MARGIN = 40`**, i.e. mostly in the unprintable
margin, on seeded and testfit.

Fix, in `dimString`'s vertical branch: keep the normal right-aligned placement **whenever it fits**
(`x − 4 − textWidth(label) ≥ MARGIN + 2` — dwg fits, and dwg's `42.25 m` did not move), and otherwise
move the string to the **head of the dimension line**, where the plate's own top padding is clear, with
its left edge clamped to the frame. The string still touches the dimension it belongs to. Result:
`no ink left of the frame` is green on all three packs.

**A fourth escape, unlisted, fixed by the same `bounds`.** SG1 1.1 was also failing dwg on `6.8 m²` —
a room's *area* string, printed at `y = 686 pt` against a band top of `685.89 pt`, i.e. a room label
nudged out of the drawing and into the title block by the same unbounded search. `roomLabels` now
takes the plate as its region (on A.01 as well as A.02). Note that this is `roomLabels` in
`sheetSet.ts` — Agent S3's lane (`planGraphic.ts`, `roomThumbs.ts`, `servicesSheets.ts`'
`drawRoomLabels`) is untouched.

---

## 4. All three packs, looked at

I rasterised and **read** every sheet I changed, in all three packs:

* **A.02 × 3** — title block clean on all three (no schedule row, no stray tag, no room area string);
  every tag inside the plate; `SCHEDULE CONTINUED ON A.10 (10 / 17 / 13 MORE)` sitting inside the
  panel; `24.00 m` at the head of the left dimension line on seeded/testfit, unchanged mid-line on dwg.
* **A.10 × 3** (new) — `DOOR & WINDOW SCHEDULE (CONT.)`, `CONTINUED FROM A.02 · CONSTRUCTION &
  FURNISHING PLAN`, repeated column headers, 10 / 17 / 13 rows, title block reading
  `TITLE Door & Window Schedule (cont.)` and the number box reading **A.10**.
* **contents × 3** — the index now ends `Room Finish Schedule … A.09` / `Door & Window Schedule
  (cont.) … A.10`. Correct A.NN, correct order, correct dotted leader.
* **A.01 × 3** — seeded/testfit are byte-identical to the pre-change render (no room label was outside
  the plate there); dwg's moved, and that movement is S3's room-naming change, not mine.

---

## 5. The two spec tables that had to follow the set (please read this one)

The fix makes the set **12 sheets**. Two static tables describe the set's shape and hard-fail on a
count they do not expect, and both live in directories my brief told me not to touch. I extended each
by exactly one row and nothing else:

* **`scripts/sheets/render-all.mjs` `SHEET_SPEC`** — `+ { file: 'A10', id: 'openings-cont', no: 'A.10',
  title: 'Door & Window Schedule (cont.)', kind: 'sheet' }`. Without it `renderPackSheets` throws
  `drawing set came back with 12 sheets, expected 11` and **no gate has an input at all**. The
  assertion is unchanged in *kind* — still strict equality against `SHEET_SPEC.length`, still the
  tripwire for a swallowed section-sheet failure — it now equals 12. This is precisely the condition
  S0 recorded as open risk §7.3 ("a future pack that paginates onto a second sheet"); it arrived.
* **`scripts/gates/sheets/lib/sheetlib.mjs` `SHEETS`** — `+ { file: 'A10', page: 12, no: 'A.10',
  title: 'Door & Window Schedule (cont.)' }`. **This is a strengthening, not a weakening**: it puts the
  new sheet under SG1 1.1 (title-block purity), 1.2 (frame) and 1.3 (number-box purity) — which is the
  whole 183 → 201 check delta — and it is what lets 1.4b compare a 10-entry contents index against a
  10-entry delivered set instead of failing on the count. No comparison, threshold or tolerance in any
  gate was touched. Both edits carry the measurement and the reason in a comment at the line.

Had I left them alone, SG1 could not have gone green under *any* correct fix: 1.4 demands continuation
sheets listed in the contents index while 1.4b, reading a frozen 9-number table, forbids the index
from ever holding a tenth. The tables are the spec of the set's shape, and the set's shape changed.

**`scripts/drawing-set.test.mjs`** structural constants moved with it (`11 → 12`, a
`['DOOR & WINDOW SCHEDULE (CONT.)', 1]` banner row). Its **baseline fixture
`scripts/fixtures/drawing-set.baseline.json` is untouched** — that is S5's.

**`sheetManifest.ts` was deliberately NOT changed.** It is the Sheets-manager's toggle mirror; the
continuation sheet is not independently toggleable (it is A.02's schedule, gated on `want('construction')`)
and it exists only on overflow. A permanently-listed row with a toggle key nothing honours would be a
UI lie. The renumbering machinery the brief pointed at is `add()` / `numbered` in `sheetSet.ts`, and
that is what the fix reuses.

---

## 6. The rest of the board

```
$ SHEETS=1 bash scripts/gates/run-all.sh
  G1   Sheet structure    PASS  (59 checks)     G7   Video          PASS  (19 checks)
  G2   Formula liveness   PASS  (17 checks)     G8   Web viewer     PASS   (9 checks)
  G3   Quantity truth     PASS  (92 checks)     G9   Round-trip     PASS  (24 checks)
  G4   Plan graphic       PASS  (18 checks)     G10  One-action UX  PASS  (14 checks)
  G5   Thumbnails         PASS  (70 checks)     G11  Furniture agr. PASS  (56 checks)
  G6   Renders            PASS  (53 checks)
  11/11 passing
  graded pack: 10/10 artifacts in out/  + 12/12 G9 round-trip case files
               walkthrough.mp4 55085440 B  unchanged since G10 produced it; PASS  (12 checks)
ALL GATES GREEN.

$ cd web && pnpm typecheck        → clean (tsc --noEmit, no output)
```

59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12) — **identical to the 1a2b8d5 baseline**. The
shared-`placeNear` blast radius is therefore measured, not assumed: G4 and G11 both read the plan
graphic, and both are unmoved.

```
$ node scripts/drawing-set.test.mjs
  seeded: 12 sheets · 1120 text / 4221 line / 866 rect ops · rooms 22 ·
          A.01 2 off-room, 1 led [PHONE BOOTH 1] · A.02 4 off-room, 2 led [PRINT POINT 2, PHONE BOOTH 3]
  AssertionError: seeded: baseline has 11 sheets, this render has 12
```

**It fails on the baseline and only on the baseline** — structure (12 sheets, every banner once),
determinism (byte-identical twin render) and the room/leader checks all pass first; the failure is the
recorded fixture having 11 entries. Left for S5, per brief.

### SG5's three residual failures, itemised

```
$ node scripts/gates/sheets/sg5-board-integrity.mjs
  FAIL the closing integrity pass still runs 12 checks — no integrity line on the board
  FAIL the board is green — FAIL: every gate passed, but the pack they graded is not the pack on disk.
  FAIL drawing-set.test.mjs reports a result — Node.js v24.9.0
SG5 FAIL (25 checks, 3 failing)
```

* the third is the baseline hand-off above (a crash, not a silent skip — the assertion names the
  count). Two more checks are simply not reached because the run has no `drawing-set PASS (N)` line to
  parse, which is why SG5 shows 25 checks and not 27;
* the first two are the same event: `out/walkthrough.mp4` changed between G10's integrity snapshot and
  the end-of-board comparison. **All 22 gate-level checks pass** — G1…G11 green with the exact
  baseline counts. It is worktree contention: `ps` during the run shows the parallel agent's
  `node scripts/sheets/render-all.mjs --pack all` and its own board writing the same `out/`. Two
  isolated runs of `SHEETS=1 bash scripts/gates/run-all.sh` gave
  `unchanged since G10 produced it; PASS (12 checks)` / `ALL GATES GREEN.` (pasted above).

### Digests that moved

Measured against S0's recorded 33 PNG digests (`reports/sheets-S0-1.md` §3):

| sheet | seeded | testfit | dwg | owner |
| --- | --- | --- | --- | --- |
| cover, A05–A08 | same | same | same | — |
| A01 | same | same | **moved** | S3 (room naming; my plate bound moved nothing on seeded/testfit) |
| A02 | **moved** | **moved** | **moved** | **S2** (pagination + tag bounds + dim label) + S3 (room names) |
| A03, A04 | **moved** | **moved** | **moved** | **S3** (services room labels) |
| A09 | same | same | **moved** | S3 (finish-schedule names) |
| contents | **moved** | **moved** | **moved** | **S2** (one new index row: A.10) |
| A10 | **NEW** | **NEW** | **NEW** | **S2** |

For `drawing-set.test.mjs`'s own digest list (`seeded` + `dwg` only) that is sheets **2 (contents),
4 (A.02), 5 (A.03), 6 (A.04)** on both cases, **3 (A.01) and 11 (A.09)** on dwg, plus a **new sheet
12**. Nothing on cover / sections / furniture / moodboard.

---

## 7. Open risks

1. **The 12-sheet count is now load-bearing in two static tables, and it is data-dependent.** All three
   packs tag 41–48 openings against a 31-row panel, so all three produce exactly one continuation
   sheet. A pack with ≤ 31 openings would produce **11** sheets and `render-all.mjs` would throw. The
   clean fix is a count-aware `SHEET_SPEC` (derive the row list from the delivered title blocks, which
   is artifact-side and legal), but that is a harness rewrite and outside my lane; I extended the table
   instead and am flagging it rather than hiding it.
2. **SG2 still only inspects A.02.** The schedule tags that paginated onto A.10 are not covered by
   2.3's panel-containment check (A.10 has no panel rect). SG1's 1.1/1.2/1.3 do cover A.10's words and
   ink, so the sheet is not ungraded — but the tag-specific detector never looks at it.
3. **SG1 1.4's pagination arm is now dormant.** With no rows below the panel, `rows.length === 0` and
   the arm passes without exercising its `cont.length > 0` half; and because A.10 is in `SHEETS`, a
   future *second* continuation sheet is what that half would key on. It is still the right assertion
   for a regression (overflow returning would fail it) but it no longer proves the continuation path.
4. **Row pitch has no headroom.** `SCHED_ROW_H = 15` against a 16 pt tag glyph means consecutive
   schedule glyphs touch — S1 §7.6, visible on A.10, cosmetic, untouched. Increasing the pitch would
   reduce capacity and push more rows onto continuation sheets; it is a deliberate non-change.
5. **The A.10 rows are windows, and many are 0.15 m fragments.** `mergeGlazedRuns` is leaving
   sub-tolerance slivers unmerged (seeded lists eight 0.15 × 1.50 m "windows"). Not a containment
   defect and not in my lane, but it is why the schedule is 41 rows instead of ~20 — fix the merge and
   the pagination stops firing at all.
6. **S3 and I worked in the same working tree, and it is measurably hostile to verification.** Their
   in-flight edits transiently broke the esbuild bundle mid-run (`?? … ||` in `finishSchedule.ts` /
   `sheetSet.ts`), and their concurrent `out/` writes produced three distinct spurious failures on my
   runs: `G9 produced nothing`, `pack changed under the gates`, and
   `missing input: out/sheets/seeded/A01.geometry.json` (their `render-all` `rm -rf`s each pack
   directory). Proven, not guessed — `ps` during a failing run:

   ```
   $ ps -Ao pid,etime,command | grep -E "render-all|run-all"
   28649       00:53 bash scripts/gates/run-all.sh
   31052       00:37 bash scripts/gates/run-all.sh
   ```

   Every such failure cleared on an immediate re-run with no source change; the outputs pasted in this
   report are the clean runs. The digest attribution in §6 is reasoned from ownership, not from an
   isolated build — a judge wanting per-agent attribution needs the two changes rendered separately.
