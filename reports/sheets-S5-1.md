# S5-1 — the digest baseline, re-recorded from a render that was diffed row by row and looked at

**Agent S5, Baseline Custodian.** One file changed: `scripts/fixtures/drawing-set.baseline.json`
(+39 / −23 lines). Nothing else in the repository was touched.

`.claude/rules/gate-independence.md` Law 4 says a raster/digest baseline may only be regenerated from
a render a human or agent has actually looked at and signed off, with the causing commit cited.
**Silent regeneration is forbidden**, so this report is the sign-off, and it is built from two
independent instruments rather than from the implementers' reports:

1. **All 36 sheets viewed** — 3 packs × 12 sheets, read as images at full sheet, plus two 1:1 crops on
   the two fixes that moved the most ink (§4).
2. **Every changed digest diffed row by row against a verified pre-mission reconstruction** — not
   against a claim. 24 of 24 recorded digests are the md5 of the exact dump files I diffed (§2.1), so
   what is blessed is what was inspected.

```
BEFORE                                          AFTER
$ node scripts/drawing-set.test.mjs             $ node scripts/drawing-set.test.mjs
  drawing-set FAIL (281 checks)   rc=1            drawing-set PASS (283 checks)   rc=0
  14 FAIL lines, all baseline rows
```

**283 checks, up from the 252 at `1a2b8d5`** — and the increase is accounted for, check for check, in
§5. The main board is unmoved: `11/11 · 59·17·92·18·70·53·19·9·24·14·56 (+12) · ALL GATES GREEN`.

**One caveat the orchestrator must decide before close-out, and it is the reason the board reads 5/6
rather than 6/6.** SG5 pins the drawing-set check count at `252` with a **strict equality**, in a gate
file. My re-record turns SG5's first red green and leaves exactly one:

```
FAIL drawing-set.test.mjs still runs 252 checks — 283 checks now, 252 at the baseline
SG5  Board integrity   FAIL (27 checks, 1 failing)      ← was 2 failing
```

`scripts/gates/**` is not my lane and I did not touch it. See **§6** for the evidence that the pin
should move to 283 and for why moving it silently inside a baseline commit would be precisely the
failure this role exists to prevent.

---

## 1. Why the baseline was stale, and why that was correct

`scripts/fixtures/drawing-set.baseline.json` was recorded at `1a2b8d5` (`git log` shows that commit is
the only one to have touched it) and records an **11-sheet** set for two cases, `seeded` and `dwg`.
The set is now **12 sheets**: S2's schedule pagination adds `A.10 Door & Window Schedule (cont.)`,
which is the fix for D1 — rows W15–W24 printing across and below the title-block band.

It was kept stale all mission on purpose. Regenerating it after S2/S3 would have baked in whatever
those fixes produced and made S6's and S8's later changes invisible; regenerating it before looking
would have been the fixture equivalent of a gate calibrated to pass its own fix.

## 2. The instrument: a verified pre-mission reconstruction

A full `rsync` copy of the repo (`node_modules` symlinked) under the session scratchpad, with the five
product files this mission touched restored to their pre-mission state — `sheetSet.ts`,
`servicesSheets.ts`, `finishSchedule.ts`, `planGraphic.ts` restored from `HEAD`, and S3's new
`roomNaming.ts` deleted. Three of the four were diffed against `1a2b8d5` and are byte-identical; the
fourth, `sheetSet.ts`, differs from `1a2b8d5` by exactly S0's read-only `sheetGeometry()` export
(+48 lines, no drawing op). The **current** `drawing-set.test.mjs` was used in both trees, so the
digest producer is held constant and only the product varies.

```
$ cd <scratch>/pre && node scripts/drawing-set.test.mjs --dump <scratch>/digest-pre
  seeded: 11 sheets · 1088 text / 4204 line / 860 rect ops · rooms 22
  dwg:    11 sheets · 1111 text / 5110 line / 1089 rect ops · rooms 23
  FAIL dwg sheet A.01/A.02: 'OPEN WORKSPACE (5)/(6)/(7)' is drawn 0x for 1 zone(s)   ← ×6, D4 itself
  drawing-set FAIL (270 checks)
```

**Not one baseline digest failed on the reconstruction.** All 22 recorded md5s reproduced exactly, and
its only failures are the six D4 room-naming assertions — the defect the pre-mission tree still has.
That is what makes the "before" real: the recorded baseline provably *is* the pre-mission product, and
every row-level difference below is caused by this mission and nothing else.

### 2.1 What is blessed is what was inspected

```
$ python3 …  # md5 of each dumped rows file vs the digest just recorded
all 24 recorded digests equal the md5 of the dumped rows I diffed: True
```

The digest is `md5(rows.join('\n'))` and `--dump` writes exactly that string, so this is an identity,
not a coincidence — it proves the baseline I wrote is the render I diffed and viewed, not a later one.
The two independent renders (the diff run and the `--update` run) produced identical digests, which is
the determinism assertion holding across processes as well as within one.

---

## 3. Per-digest justification — every changed row accounted for

**Byte-identical in both packs, unchanged from `1a2b8d5`: sheets 1 (cover), 7 (A.05), 8 (A.06),
9 (A.07), 10 (A.08)** — plus seeded 3 (A.01) and seeded 11 (A.09). S6's "sheets 1/7/8/9/10 are
byte-identical" was re-measured and **still holds**.

### seeded

| # | sheet | md5 was → now | ops | cause | what visibly changed |
| --- | --- | --- | --- | --- | --- |
| 2 | contents | `afd477a1` → `169597d9` | T 25→27, L 11→12 | **S2** | one new index row: `Door & Window Schedule (cont.)` + `A.10` (2 text ops) and its dotted leader rule (1 line). Nothing else on the sheet moved. |
| 4 | A.02 | `069a8303` → `7b1cc800` | T 351→302, L 1068→998, R 91→81 | **S2** (D1, D2, D5) + **S6** | **50 text ops gone — the 10 schedule rows W15–W24, 5 cells each, every one of them printing at y 678…813 pt against a title-block band top of 685.89.** Replaced by 1 op, `SCHEDULE CONTINUED ON A.10  (10 MORE)` at y 677, inside the panel. `24.00 m` moved from x = 16.26 pt — inside the 40 pt unprintable margin — to the head of the dimension line at (42.00, 142.20). 7 opening tags (W12 W13 W14 W19 W21 D11 D12) re-placed, each with its 22×22 knockout and 6-line hexagon. |
| 5 | A.03 | `9aa16439` → `5e59b6e6` | L 1086→1096 (+10 leaders), T/R identical | **S3** + **S6** + **S8** | all 18 room-name baselines re-anchored **+2.02 pt** (the halo box is now derived from the type's ascent/descent instead of a fixed `cy − 8`); 14 of 24 `LC-nn` circuit tags de-collided — **five of them (LC-15/16/21/23/24) were printing on one point at (472.14, 281.25)** and are now spread over 222…340 pt with leaders; 30 of 115 luminaires nudged (the shared candidate stack's dv = 15 / dh = 12.6 replacing the old private step of 14); 7 exit `E` tiles re-seated. |
| 6 | A.04 | `0d4ed3b7` → `8dd02496` | all four op counts identical | **S3** + **S6** + **S8** | 21 room-name baselines +2.02 pt; 4 labels displaced further (PRINT POINT 1, PHONE BOOTH 1 and 2, FOCUS ROOM 2); the `DB` tile moved 202.88 → 217.88 — S8's word-carrying-glyph seat. No op appeared or vanished. |
| 12 | **A.10 (new)** | — → `f4d685ce` | T 79, L 87, R 16, I 1 | **S2** | the continuation sheet itself: banner, `CONTINUED FROM A.02 · CONSTRUCTION & FURNISHING PLAN`, column headers, 10 rows W15–W24, title block `Door & Window Schedule (cont.)`, number box `A.10`. |

### dwg

| # | sheet | md5 was → now | ops | cause | what visibly changed |
| --- | --- | --- | --- | --- | --- |
| 2 | contents | `afd477a1` → `169597d9` | T 25→27, L 11→12 | **S2** | identical to seeded's, and identical md5 — the contents sheet's index rows do not depend on the pack. |
| 3 | A.01 | `03b00533` → `1721072e` | all identical | **S3** | **exactly 3 text ops**: `OPEN WORKSPACE` → `OPEN WORKSPACE (5)` / `(6)` / `(7)`, each x shifted left by 6.19 pt to keep the wider label centred. Nothing else on the sheet. |
| 4 | A.02 | `6ae21f48` → `904b219f` | T 360→296, L 944→854, R 97→84 | **S2** + **S3** + **S6** | 13 schedule rows (65 text ops, W21–W33) paginated off; `SCHEDULE CONTINUED ON A.10  (13 MORE)`. The two escapes S2 named are gone from the bytes: **`6.8 m²` at y = 690.90 — inside the title-block band — is back in the drawing at (476.30, 632.90)**, and plan tag **`W33` at y = 732.59 — 69.6 pt below the plate bottom, over the title block — is at (368.85, 570.59), inside the plate.** Plus the three `OPEN WORKSPACE (5)/(6)/(7)` names and ~20 re-placed tags. |
| 5 | A.03 | `fdb016c9` → `b8a71150` | L 1790→1824 (+34 leaders) | **S3** + **S6** + **S8** | same three families as seeded A.03, on the irregular plate: room names re-anchored, circuit tags de-collided with leaders, exit tiles re-seated. |
| 6 | A.04 | `7761b4cb` → `73dc7e90` | L 2215→2216 (+1) | **S3** + **S6** + **S8** | 23 room labels: 3 suffixed `(5)/(6)/(7)`, the rest re-anchored +2.02 pt, 6 displaced further; the `DB` tile seated. |
| 11 | A.09 | `03659262` → `b3bd38c9` | all identical | **S3** | **exactly 3 text ops**: the ROOM NAME cells for zones 246/247/248, `Open Workspace` → `Open Workspace (5)` / `(6)` / `(7)`. |
| 12 | **A.10 (new)** | — → `069955ee` | T 94, L 108, R 19, I 1 | **S2** | 13 rows, W21–W33. |

**Checked against the brief's list of known movers, rather than trusted:** contents ×3 ✓, A.02 ×3 ✓,
A.10 ×3 new ✓, A.03/A.04 ×3 ✓, dwg A.01 ✓, dwg A.09 ✓. (The baseline covers `seeded` and `dwg` only —
`testfit` is rendered and gated but not digested, so "×3" is two rows here and a third sheet I viewed.)
S8's "3 words moved, all exit `E` glyphs on page 5, plus +3/+2/+9 leader strokes on A.03" is a delta
against *pre-S8*; measured against *pre-mission* the same sheets carry S6's circuit-tag work as well,
which is why A.03's line delta reads +10 / +34 rather than +3 / +9. Both are consistent — I diffed the
wider interval on purpose, because that is the interval the baseline spans.

**Nothing is unexplained.** Every added or removed row in all ten changed sheets falls into one of the
five families above; there is no residue.

### The one delta that needed chasing

30 of 115 seeded-A.03 luminaires moved, many by exactly ±1.00 pt — not a candidate step, and not
obviously anyone's fix. It is neither: the old `clearOfLabels` had a **private** nudge stack with
`step = s*2 + 2 = 14 pt`; S6/S8 replaced it with the shared `tryPlaceNear` stack, whose vertical step
is `dv = h + 3 = 15 pt`. A fixture that was nudged one step under both codebases therefore lands 1 pt
apart, and one nudged in opposite directions lands 29 pt apart — which is exactly the delta histogram
(±1, ±15, ±29, ±44, ±12.6 = `dh`). Mechanically accounted for; nothing moved that had no reason to.

---

## 4. Per-sheet inspection sign-off — all 36 sheets viewed

Read as images at full sheet; `·` marks a sheet whose digest changed. Known-open defects observed
during inspection are named in §7, not repeated in every row.

| sheet | seeded | testfit | dwg |
| --- | --- | --- | --- |
| cover | OK — plan, client block, orange rule | OK | OK — irregular plate reads correctly |
| contents · | **OK — 12 rows, ends `Room Finish Schedule … A.09` / `Door & Window Schedule (cont.) … A.10`**, dotted leaders aligned | OK, identical | OK, identical |
| A.01 · | OK — 22 room names, all complete, title block clean | OK — 21 names; 4 `14.0 m²` struck by the bottom shell wall (**D-Q, known-open**) | OK — **`OPEN WORKSPACE (5)/(6)/(7)` distinct: D4 visibly closed**; names over demolition hatch (**known-open**) |
| A.02 · | **OK — title block and number box clean, no schedule row below the panel, `SCHEDULE CONTINUED ON A.10 (10 MORE)` inside the panel, all 41 tags on the plate, `24.00 m` at the head of the left dim line** | OK — `(17 MORE)`, 48 tags on the plate, title block clean | OK — `(13 MORE)`, 44 tags on the plate, `W33` and `6.8 m²` back inside the drawing |
| A.03 · | **OK — every room name legible and complete; LC-01…LC-24 all separate, each displaced one carrying a leader; 7 exit tiles separate** | OK — same; one long diagonal circuit leg (pre-existing, cosmetic) | OK — same on the irregular plate; grid/fixtures unclipped (**D-S, known-open**) |
| A.04 · | OK — 21 names legible, `DB` tile clear of `FOCUS ROOM 1` with a leader | OK | OK — 23 names incl. `(5)/(6)/(7)`, `DB` seated |
| A.05 | OK — Section A-A, poché correct, scale figure | OK | OK |
| A.06 | OK — Section B-B | OK | OK |
| A.07 | OK — 8 cards (**placeholder `CHA`/`DES`/`TAB` thumbs, `- ea`, known-open**) | OK — 9 cards | OK — 7 cards |
| A.08 | **`NO PRODUCTS SPECIFIED YET` — ~95 % blank (known-open)** | same | same |
| A.09 · | OK — 22 rows, every name distinct | OK — 22 rows | **OK — `Open Workspace (1)…(7)` + `Core 1/2/3`, 23 rows, all distinct** |
| A.10 · | **OK (new) — W15…W24, 10 rows, banner + `CONTINUED FROM A.02`, number box `A.10`** | OK — W14…W30, 17 rows | OK — W21…W33, 13 rows |

### Two 1:1 crops on the fixes that moved the most ink

* **`seeded/A02.png` px (1620,1280)–(2382,1500), 2×.** The last drawn row is `W14 · Window ·
  3.85 × 1.50 m · Glazed partition +0.80`; below it `SCHEDULE CONTINUED ON A.10  (10 MORE)`, then
  clear paper, then the title-block band reading `Construction & Furnishing Plan` and a number box
  containing `A.02` and nothing else. **D1 and the title-block purity defect are closed in the
  pixels, not just in the assertion.**
* **`seeded/A03.png` px (860,500)–(1120,680), 2×.** Four exit `E` tiles, all separate, all legible,
  each with a leader stub back to its fixture; `LC-15`, `LC-16`, `LC-17`, `LC-18`, `LC-19`, `LC-23`
  each on their own, and `PHONE BOOTH 1/2/3` and `PRINT POINT 2` intact with no halo eating a
  neighbour. **The five-tags-on-one-point knot and the two-`E`-on-one-point pair are both gone.**

---

## 5. The check count: 252 → 283, accounted for

| what was run | checks |
| --- | --: |
| the **old** test on the **pre-mission** product, at `1a2b8d5` | **252** |
| the **current** test on the **pre-mission** product (my reconstruction, §2) | **270** |
| the **current** test on the **delivered** product — now | **283** |

The +31 is not drift, and it splits cleanly at the reconstruction, which is why the reconstruction was
worth building. Both halves are *more* grading, never less:

* **+18, from the checking layer (252 → 270), all S7's.** At `1a2b8d5` the first failing
  `assert.ok` threw and aborted the run, so the second case — `dwg` — was **never rendered and never
  graded at all** (D-F). Failures are now recorded rather than thrown, so `dwg`'s structure,
  determinism, 23 rooms × A.01/A.02 label-and-leader assertions and 11 digests are back on the board.
  Measured, not inferred: the same current test scores 270 on the pre-mission product.
* **+13, from the product (270 → 283).** The 12th sheet contributes **+4** — a `w != null` check and
  a digest check on each of the two cases. The remaining **+9** are room-label and leader assertions
  on dwg's A.01/A.02: with `(5)/(6)/(7)` now distinct, three rooms per sheet that previously failed
  their "drawn exactly once" lookup and skipped the rest are graded through to the end, and more
  labels are displaced and therefore leader-checked — the test's own console line records the shift,
  `A.01 7 off-room / 5 led → 9 / 6` and `A.02 13 / 10 → 14 / 10`.

The arithmetic closes from the other side too: `--update` skips the baseline block and reports
`231 checks passed on the way`; the block is `1 + 1 + 12 × 2` per case = 26, ×2 cases = **52**, and
231 + 52 = **283**.

---

## 6. ⚠ SG5 cannot go green on 283 without an edit outside my lane

`scripts/gates/sheets/sg5-board-integrity.mjs:51`

```js
/** `node scripts/drawing-set.test.mjs` — the sheet-content regression fixture. */
const BASELINE_DRAWING_SET = 252
…
c.ok(`drawing-set.test.mjs still runs ${BASELINE_DRAWING_SET} checks`,
     Number(m[2]) === BASELINE_DRAWING_SET,
     `${m[2]} checks now, ${BASELINE_DRAWING_SET} at the baseline`)
```

It is a **strict equality**, by design — SG5's own message says a check that appeared *or* vanished is
a defect either way, which is the right posture and is why the number is pinned rather than floored.
My re-record turns SG5's first red (`drawing-set.test.mjs passes — it says FAIL`) green and leaves the
second one red, measured on the board above:

```
SG5  Board integrity  FAIL (27 checks, 1 failing)
     FAIL drawing-set.test.mjs still runs 252 checks — 283 checks now, 252 at the baseline
```

That is the whole of the delta: 27 checks, unchanged; 2 failing → 1 failing.

**I did not change it.** `scripts/gates/**` is not my lane, and Law 4's whole point is that a pinned
expectation is only moved by someone who has looked and said why — so moving it silently inside a
baseline commit would be the exact failure this role exists to prevent. The evidence for moving it is
in §5: the count rose because S7 restored grading that `1a2b8d5` was silently skipping, and because the
set legitimately grew a sheet. **Recommendation: the orchestrator updates `BASELINE_DRAWING_SET` to
283 in the same commit, citing §5.** Until then the board reads 5/6 with exactly one red line.

---

## 7. Known-open defects observed while inspecting — not fixed, not masked

All routed to `docs/ROADMAP.md`; all pre-existing; all confirmed by eye during this pass, and all
confirmed by the row diff to be untouched by the re-record:

* **D-P** — room names, area strings and dimension strings printing across wall geometry and
  door-swing arcs. Seen on every plan sheet of every pack: e.g. seeded A.02's `PHONE BOOTH 2 / 1.4 m²`
  across three booth outlines and their swings, `CABIN 2` and `CABIN 3` on their walls, dwg A.02's
  `OPEN WORKSPACE (1) 328.3 m²` through a desk row.
* **D-Q** — strings outside the building footprint. Clearest on testfit A.01/A.02: four `14.0 m²` and
  three `MEETING ROOM n` sit on or below the bottom shell wall, interleaved with the `40.00 m` overall
  dimension.
* **dwg A.01 labels over the demolition hatch** — `PRINT POINT 1/2`, `PHONE BOOTH 1`, `STORAGE`,
  `CORE 2` and their areas over dense pink hatch. Still the least legible sheet in the set.
* **D-S — dwg A.03 ceiling grid and fixtures not clipped to the building polygon.** A luminaire prints
  below the bottom shell edge; grid lines run past the boundary.
* **D-U — A.08 is ~95 % blank** (`NO PRODUCTS SPECIFIED YET`) on all three packs; **A.07 carries
  placeholder `CHA`/`DES`/`TAB` thumbnails** with `- ea` and `LINE TOTAL -`; A.05/A.06 leave ~55 % of
  the drawing area blank below the section.
* Cosmetic, also seen: **D-K** A.10 is ~85 % blank on seeded; **D-L** consecutive schedule tag
  hexagons touch (`SCHED_ROW_H = 15` against a 16 pt glyph); **D-N** many 0.15 m sliver "windows" in
  the schedule.

None of these blocks the baseline, and none of them was touched: the row-level diff shows every
changed op belongs to one of the five explained families.

---

## 8. Verification, pasted

```
$ node scripts/sheets/render-all.mjs --pack all
sheet harness: seeded · testfit · dwg → out/sheets/ at 144 dpi
  seeded:  12 sheets → out/sheets/seeded/  (2382×1684 px @ 144 dpi, pdf 1217356 B)
  testfit: 12 sheets → out/sheets/testfit/ (2382×1684 px @ 144 dpi, pdf 1138295 B)
  dwg:     12 sheets → out/sheets/dwg/     (2382×1684 px @ 144 dpi, pdf 1343276 B)
sheet harness OK — 3 pack(s) × 12 sheets

$ node scripts/drawing-set.test.mjs --update
  recorded scripts/fixtures/drawing-set.baseline.json — 231 checks passed on the way

$ node scripts/drawing-set.test.mjs ; echo $?
  seeded: 12 sheets · 1120 text / 4232 line / 866 rect ops · rooms 22 ·
          A.01 2 off-room, 1 led · A.02 4 off-room, 2 led
  dwg:    12 sheets · 1143 text / 5164 line / 1095 rect ops · rooms 23 ·
          A.01 9 off-room, 6 led · A.02 14 off-room, 10 led
  drawing-set PASS (283 checks)
  0
```

```
$ node scripts/gates/sheets/run-all.mjs
         FAIL drawing-set.test.mjs still runs 252 checks — 283 checks now, 252 at the baseline

--------------------------- SCOREBOARD -----------------------
  SG1  Panel containment            PASS (216 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (27 checks, 1 failing)
  SG6  Determinism + independence   PASS  (16 checks)
--------------------------------------------------------------
  5/6 passing                    345.1 s
```

**SG5 went 2 failing → 1 failing, and the surviving line is the pinned 252 of §6 and nothing else.**
`drawing-set.test.mjs passes` is now green; SG1 216 · SG2 24 · SG3 295 · SG4 36 · SG5 27 · SG6 16 are
otherwise exactly as S8 left them. No check appeared or vanished on any sheet gate.

```
$ SHEETS=1 bash scripts/gates/run-all.sh
--------------------------- SCOREBOARD -----------------------
  G1   Sheet structure    PASS  (59 checks)     G7   Video           PASS  (19 checks)
  G2   Formula liveness   PASS  (17 checks)     G8   Web viewer      PASS   (9 checks)
  G3   Quantity truth     PASS  (92 checks)     G9   Round-trip      PASS  (24 checks)
  G4   Plan graphic       PASS  (18 checks)     G10  One-action UX   PASS  (14 checks)
  G5   Thumbnails         PASS  (70 checks)     G11  Furniture agr.  PASS  (56 checks)
  G6   Renders            PASS  (53 checks)
--------------------------------------------------------------
  11/11 passing

  graded pack: 10/10 artifacts in out/
               + 12/12 G9 round-trip case files, written 03:58:56
               walkthrough.mp4  55027945 B  mtime 04:02:48  43.00s
               unchanged since G10 produced it; PASS  (12 checks)

ALL GATES GREEN.
```

`59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12)` — the `1a2b8d5` numbers, check for check.

```
$ node scripts/drawing-set.test.mjs        # again, on the board's own re-render
  drawing-set PASS (283 checks)
```

Run after `run-all.sh` re-rendered every pack, so the recorded digests hold across a third
independent render as well as the two that produced and verified them.

```
$ git status --porcelain -- scripts/fixtures/
 M scripts/fixtures/drawing-set.baseline.json
```

No `git stash / reset / checkout / restore / clean / commit` was run. Both scratch trees live under
the session scratchpad; the repository was never sabotaged and no file outside
`scripts/fixtures/drawing-set.baseline.json` and this report was written.

---

## 9. Commit-ready message

```
sheets: re-record the drawing-set digest baseline — 12 sheets, inspected

The set is 12 sheets, not 11: S2's schedule pagination adds A.10 Door & Window
Schedule (cont.), the fix for D1 (rows W15-W24 printing across and below the
title-block band). The recorded baseline was kept stale all mission on purpose
so that no fix could bless itself; this re-records it from a render whose every
changed row was diffed against a verified pre-mission reconstruction and whose
36 sheets were viewed.  Evidence: reports/sheets-S5-1.md.

Per digest (was -> now), all against the 1a2b8d5 recording:

  seeded/dwg  contents  afd477a1 -> 169597d9   S2: one index row, "Door & Window
              Schedule (cont.) .. A.10", 2 text ops + 1 leader rule.
  seeded      A.02      069a8303 -> 7b1cc800   S2+S6: 10 schedule rows (50 text
              ops) that printed at y 678-813 pt against a band top of 685.89 are
              paginated off, replaced by "SCHEDULE CONTINUED ON A.10 (10 MORE)"
              at y 677; "24.00 m" out of the 40 pt unprintable margin (x 16.26)
              to the head of its dimension line; 7 opening tags re-placed.
  seeded      A.03      9aa16439 -> 5e59b6e6   S3+S6+S8: 18 room-name baselines
              re-anchored +2.02 pt; 14 of 24 LC tags de-collided (five were on
              one point at 472.14,281.25); 7 exit E tiles re-seated; +10 leaders.
  seeded      A.04      0d4ed3b7 -> 8dd02496   S3+S6+S8: 21 baselines +2.02 pt,
              4 labels displaced, DB tile seated. Op counts unchanged.
  seeded      A.10      (new)    -> f4d685ce   S2: the continuation sheet, 10
              rows W15-W24.
  dwg         A.01      03b00533 -> 1721072e   S3: exactly 3 text ops, OPEN
              WORKSPACE -> (5)/(6)/(7).
  dwg         A.02      6ae21f48 -> 904b219f   S2+S3+S6: 13 rows paginated off;
              "6.8 m2" out of the title-block band; tag W33 back on the plate
              from 69.6 pt below it; the three (5)/(6)/(7) names.
  dwg         A.03      fdb016c9 -> b8a71150   S3+S6+S8, as seeded A.03; +34
              leaders.
  dwg         A.04      7761b4cb -> 73dc7e90   S3+S6+S8, as seeded A.04.
  dwg         A.09      03659262 -> b3bd38c9   S3: exactly 3 text ops, the ROOM
              NAME cells of zones 246/247/248.
  dwg         A.10      (new)    -> 069955ee   S2: 13 rows W21-W33.

Byte-identical and re-recorded unchanged: cover, A.05, A.06, A.07, A.08 on both
cases, plus seeded A.01 and seeded A.09.

drawing-set PASS (283 checks), up from 252 at 1a2b8d5: the set grew a sheet, and
S7's recorded-not-thrown failures mean the dwg case is rendered and graded again
instead of being skipped after the first red (D-F).

NOTE FOR THE NEXT COMMIT: sg5-board-integrity.mjs:51 pins BASELINE_DRAWING_SET =
252 with a strict equality, deliberately. It needs to become 283. That line is
outside the baseline custodian's lane and was left alone.
```
