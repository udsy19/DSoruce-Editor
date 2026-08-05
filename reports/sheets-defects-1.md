# S4-1 — Judge, drawing-set mission, round 1

**Verdict: the drawing set is NOT shippable.** One blocker (D-A), found by looking, not by a gate:
**the D2 fix re-opened the D3 defect on A.02.** Confining opening tags to the plate moved them onto
room names, and `drawTagGlyph`'s white knockout mask now erases those names — in all three packs, on
the primary construction plan, under `SG1 201 / SG2 24 / SG3 295 / SG4 36 / SG6 16` all green.

Everything below is from commands that ran on this machine. Where a claim is about the pre-fix state
it comes from a **verified reconstruction**: the nine changed files restored from `HEAD` with
`git show`, rendered into a scratch tree, digests **byte-identical to the 33 recorded in
`reports/sheets-S0-1.md` §3** (`seeded/A02 4fe0dcdf…`, `seeded/A03 580429d2…`, `dwg/A03 98f5bb2b…`,
`seeded/A01 66aa3862…`). No repo file was modified except this report; no `git stash/reset/checkout/
clean/commit` was run.

---

## 0. Boards I ran myself

```
$ node scripts/gates/sheets/run-all.mjs                                    (330.8 s)
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  SG4  Name uniqueness              PASS  (36 checks)
  SG5  Board integrity              FAIL  (25 checks, 1 failing)
  SG6  Determinism + independence   PASS  (16 checks)
  5/6 passing
```

SG5's single red is `drawing-set.test.mjs reports a result — Node.js v24.9.0`, i.e. the S5 baseline
hand-off. **Verified it is the only reason** — see §5 (D-F) for the part that is *not* harmless.

```
$ SHEETS=1 bash scripts/gates/run-all.sh                                   rc=0
  G1 59 · G2 17 · G3 92 · G4 18 · G5 70 · G6 53 · G7 19 · G8 9 · G9 24 · G10 14 · G11 56
  11/11 passing · unchanged since G10 produced it; PASS (12 checks) · ALL GATES GREEN.
```

**Identical to the `1a2b8d5` baseline, check for check. Zero count delta.**

```
$ node scripts/drawing-set.test.mjs
  seeded: 12 sheets · 1120 text / 4221 line / 866 rect ops · rooms 22 ·
          A.01 2 off-room, 1 led [PHONE BOOTH 1] · A.02 4 off-room, 2 led [PRINT POINT 2, PHONE BOOTH 3]
  AssertionError: seeded: baseline has 11 sheets, this render has 12   (drawing-set.test.mjs:504)
```

Determinism: my `out/sheets` snapshot (36 PNGs) is byte-identical to `out/sheets` after two further
full re-renders driven by the two boards above. Every measurement below is on that exact artifact.

---

## 1. BLOCKER — D-A: opening tags erase room names on A.02 (all three packs)

**Gate ID: none.** Severity **blocker**. Introduced by the D2 fix; it is defect D3's mechanism
(white-knockout erasure of a room name) relocated from A.03/A.04 to A.02.

### What it looks like

`out/sheets/seeded/A02.png`, 1:1 crop at (880,490)–(1340,630) px. Before / after:

| | delivered text |
| --- | --- |
| pre-fix (`seeded/A02 4fe0dcdf…`) | `PHONE BOOTH 2` printed clean; tag **D12** sits above it |
| now (`seeded/A02` in `out/`) | `PHONE B` · **[D12 tag]** · `2` — `OOTH` is painted out |

Same event on the other two packs: `testfit/A02` reads `MEETI` · **[W11]** · `OOM 1` where
`MEETING ROOM 1` was clean before; `dwg/A02` reads `OPEN WORKSPA` · **[W9]** · `4)` and
`FOC` · **[W13]** · `ROOM 1`.

### Measured, with the gates' own instruments

Plan tags located by the gate's **own raster detector** (`scripts/gates/sheets/lib/tags.mjs`
`findTags`, 11 pt scale); word boxes are poppler's measurement of the delivered glyph runs. The tag's
knockout mask is the `2r × 2r` white square `drawTagGlyph` paints at `sheetSet.ts:1102`. Overlap as a
fraction of each word's own box, plate side of A.02 only, threshold >15 %:

```
                     PRE-FIX                       NOW
seeded/A02      0 words > 15 %      2:  76% "BOOTH"@(495,266)   74% "m²"@(500,277)
testfit/A02     0 words > 15 %      3:  34% "MEETING"@(155,520) 30% "ROOM"@(194,520) 28% "m"@(179,473)
dwg/A02         0 words > 15 %      4: 100% "m²"@(660,217)      43% "(4)"@(401,177)
                                        29% "WORKSPACE"@(346,177) 16% "FOCUS"@(627,206)
```

**0 → 9.** Note `100% "m²"` on dwg — a room's area string entirely gone — and `43% "(4)"`: the
disambiguation ordinal D4's fix introduced is itself 43 % erased by a tag.

Raster confirmation on the worst case, seeded `BOOTH` at (495.5, 265.6) pt, same word box in both
renders, ink = any pixel below 200 in any channel:

```
PRE :  ink 453/870 = 52.1 %   widestInteriorGap 0 px (0.00 em)
NOW :  ink 246/870 = 28.3 %   widestInteriorGap 2 px (0.13 em)
```

**46 % of the word's own ink is gone**, and what remains inside the box is mostly the tag's circle and
its `D12` glyphs, not the room name.

### Why every gate waved it through

* **SG3 3.1** finds `PHONE BOOTH 2` in the delivered **text layer** and passes. The glyphs are
  emitted; a later white rect paints over them. This is `.claude/rules/gate-independence.md`
  §"Emission is not visibility", verbatim — the same shape as E7 (furniture drawn then painted over).
* **SG3 3.2** compares label boxes to *label* boxes only (`sg3-label-integrity.mjs:166-179`). A tag is
  not a label.
* **SG3 3.3** is the raster net, and it is **defeated by construction**: it measures the widest
  *ink-free* column run inside a word box (`widestInteriorGap`, `sheetlib.mjs:566`), and the tag fills
  the region it erased with its own ink. Measured 0.13 em against a 0.50 em limit — the check is not
  merely close, it is nowhere near firing.
* **SG2** grades tags for containment and attribution (2.1–2.5) and never asks what is *underneath*
  one.

### Most likely responsible

`web/src/export/sheetSet.ts:923`
```ts
let pos = placeNear(occ, pt.x, pt.y, 24, 24, plate)
```
`occ` is the shared occupancy list that `roomLabels` (`:912`) has already seeded with every room-name
halo, so a tag *knows* where the labels are — but `placeNear` "always places": when every in-plate
candidate collides it returns the **least-overlapping** one, and with the escape route out of the
plate now closed that fallback fires onto a room name. The very next block re-places a tag that lands
on **another tag** (`:924-930`); no such treatment exists for a tag that lands on a **label**. Then
`drawTagGlyph` (`sheetSet.ts:1100-1102`) lays its white mask over whatever is already there.

The asymmetry is the tell: S2 correctly identified "a tag over a tag does not read" and fixed it; a
tag over a room name does not read either, and that case was left.

**This is not a tuning matter.** A room's name illegible on the Construction & Furnishing Plan is the
same failure the mission was opened to close.

---

## 2. MAJOR — D-B: no gate asserts the schedule is complete, or that the continuation pointer resolves

**Gate ID: none** (the gap sits between SG1 1.4 and SG2 2.3). Severity **major** — gate defect; the
shipped artifact is correct.

Falsified, not argued. Two sabotages in a scratch tree, `web/src/export/sheetSet.ts` only:

1. the A.02 pointer forced to `SCHEDULE CONTINUED ON A.99  (0 MORE)` — a cross-reference to a sheet
   that does not exist, and a count of zero;
2. `openingOverflow.slice(0, -1)` — the last overflow row silently dropped, so one tagged opening has
   **no schedule row anywhere in the set**.

```
$ node scripts/sheets/render-all.mjs --pack all      → sheet harness OK — 3 pack(s) × 12 sheets
$ node scripts/gates/sheets/run-all.mjs --no-produce SG1 SG2 SG3
  SG1  Panel containment            PASS (201 checks)
  SG2  Plate confinement            PASS  (24 checks)
  SG3  Label integrity              PASS (295 checks)
  ALL SHEET GATES GREEN.

$ pdftotext -f 4 -l 4 -layout out/sheets/seeded/drawing-set.pdf - | grep CONTINUED
  SCHEDULE CONTINUED ON A.99 (0 MORE)
$ (plan tags vs schedule rows, both read out of the delivered PDF)
  seeded : plan tags 41 | A.02 rows 31 | A.10 rows 9  | plan tags with NO schedule row: W24
  testfit: plan tags 48 | A.02 rows 31 | A.10 rows 16 | plan tags with NO schedule row: W30
```

A drawing set with a dangling sheet reference and an unspecified opening is fully green.

**The shipped artifact is fine** — I checked it the same way, and it is exactly right:

```
seeded : plan tags 41 | A.02 31 + A.10 10 | union 41 | on both sheets: none | orphans: none
testfit: plan tags 48 | A.02 31 + A.10 17 | union 48 | on both sheets: none | orphans: none
dwg    : plan tags 44 | A.02 31 + A.10 13 | union 44 | on both sheets: none | orphans: none
```

Responsible: `scripts/gates/sheets/sg1-panel-containment.mjs:236-256` — 1.4 asks only "did a row print
*below* the panel?", never "is every opening scheduled exactly once across A.02 + the continuation?".
The companion that would keep it honest already exists one gate over: SG2 2.4 counts door tags against
core state. The same construction (`openings` are derived from core-state walls/components, so the
count is re-derivable) is missing for schedule rows. `scripts/gates/sheets/sg2-plate-confinement.mjs:74`
(`TAGGED_SHEET = A02`) is why SG2 never opens A.10.

---

## 3. MAJOR — D-C: the sheet-gate suite is inoperable for any document with ≤ 31 tagged openings

**Gate ID: none** (harness/infrastructure). Severity **major**.

S2 flagged the 12-sheet count as data-dependent. It is worse than flagged: the failure is total and
the diagnostic actively misdirects.

Falsified with `openingSchedule(state).slice(0, 25)` — a plausible small fit-out with 25 openings,
all of which fit the 31-row panel, so no continuation sheet is produced:

```
$ node scripts/sheets/render-all.mjs --pack seeded
sheet harness FAILED: seeded: drawing set came back with 11 sheets, expected 12. A short set means a
sheet builder threw and was swallowed by its try-wrapper — classically the two section sheets, when
Chromium has no GL context (render-sheets.mjs must launch with --use-gl=swiftshader).
$ echo $?
1
$ ls out/sheets/seeded/          (the pack directory was rm -rf'd and never rewritten)
$ node scripts/gates/sheets/run-all.mjs --no-produce SG1 SG3 SG4 --pack seeded
  FAIL missing input: out/sheets/seeded/drawing-set.pdf — render the sheets first
  FAIL missing input: out/sheets/seeded/A02.geometry.json — render the sheets first
  SG1 FAIL (1 checks, 1 failing) · SG3 FAIL (1 checks, 1 failing) · SG4 FAIL (2 checks, 1 failing)
```

Three separate hard-coded 12s: `scripts/sheets/render-all.mjs:80-94` + `:205`,
`scripts/gates/sheets/lib/sheetlib.mjs:141`, `scripts/drawing-set.test.mjs:472`. The product is
correct in this scenario (11 sheets is the right output); the standing gates simply cannot grade it,
and the error blames swiftshader. Loud rather than silent — good — but a mission that leaves permanent
gates behind should not leave gates that only work above an opening-count threshold.

---

## 4. Duty 1 — the gate amendments, audited by construction

### 4.1 `SHEET_SPEC` / `SHEETS` + A.10 — S2's claims **verified**

**The 183 → 201 delta is exactly A.10, arithmetically.** SG1 spends per numbered sheet: 1.1 (1) +
1.2 ×3 + "the sheet number is drawn" (1) + 1.3 (1) = **6**, plus one 1.4 check per panel rect, plus one
1.4b per pack. Before: `9 sheets × 6 + 6 panels + 1 = 61`, `× 3 packs = 183`. After: `10 × 6 + 6 + 1 =
67`, `× 3 = 201`. **+18, all of it A.10 entering the four containment families. No other check moved.**

**Adding A.10 to `SHEETS` is a strengthening, and I proved both halves.**

*It buys real coverage.* Sabotage F5 — `CONT_COL_TOP = 560`, `contColCapacity() = 200`, i.e. a
continuation sheet that no longer measures its own page:

```
FAIL seeded/A10  title-block purity — 36 foreign word(s) … (tags W21 W22 W23 W24)
FAIL testfit/A10 title-block purity — 77 foreign word(s) … (tags W20 … W28)
FAIL testfit/A10 no ink below the frame — 7848 ink px, topmost row 1605, x 108..707
FAIL dwg/A10     title-block purity — 63 foreign word(s) … (tags W27 … W33)
SG1 FAIL (201 checks, 4 failing)
```

*It makes 1.4 stricter, not looser.* 1.4 excuses overflow only if the contents index lists a sheet
**not in `SHEETS`** (`sg1:247`). With A.10 now in `SHEETS`, A.10 no longer excuses anything. Sabotage
F1 — capacity measured against a panel bottom 100 pt too low, so rows print past the panel while a
continuation sheet still exists (set stays at 12):

```
FAIL seeded/A02  panel[legend-schedule] schedule overflow paginates — 5 row(s) (W16 W17 W18 W19 W20)
     print below the panel bottom 685.89 pt, and the contents index lists 0 continuation sheet(s)
FAIL seeded/A02  title-block purity — 56 foreign word(s) …
FAIL seeded/A02  sheet-number box carries only "A.02" — 2219 foreign ink px …
 (× 3 packs)                                    SG1 FAIL (201 checks, 9 failing)
FAIL seeded/A02  every schedule tag inside its panel — 5 of 37 outside; lowest y=749.0 pt
 (× 3 packs)                                    SG2 FAIL (24 checks, 3 failing)
```

**Verdict: S2's two table edits are legitimate and load-bearing.** One caveat, filed as D-J below.

### 4.2 SG3 `label` → `display` — **verified stricter**

Sabotage F3 — every A.03/A.04 label forced back to its zone centre with no de-collision
(`servicesSheets.ts:365`), the literal original D3:

```
FAIL seeded/A03 no two room labels overlap — 7 overlapping pair(s): FOCUS ROOM 1 ↔ FOCUS ROOM 2 |
     PRINT POINT 1 ↔ PRINT POINT 2 | PRINT POINT 2 ↔ PHONE BOOTH 1 | … (S1's exact 7)
FAIL seeded/A03 no glyph run is cut — POINT at (438.5,269.8)pt has a 8 px (0.53 em) run
FAIL seeded/A04 … same 7, same cut word
FAIL dwg/A03 no two room labels overlap — 16 overlapping pair(s)   (S1 recorded 14; longer names)
FAIL dwg/A04 … same 16
SG3 FAIL (295 checks, 6 failing)
```

The amendment did not touch a threshold, a tolerance or a comparison operator. It changed the string
the gate predicts, and the prediction is re-derived from core state
(`sheetlib.mjs displayNameByZoneId`), not imported from `roomNaming.ts`. Legal.

### 4.3 SG4 33 → 36 — **stricter where it matters, but two of S3's claims are false**

Sabotage F4 — `roomDisplayNames` returns an empty map, i.e. D4 exactly as it was:

```
FAIL dwg/A02|A03|A04 room 246/247/248 "Open Workspace (5)/(6)/(7)" rendered exactly once — rendered 0×
FAIL dwg/A09 room 246/247/248 … appears in the finish schedule — found 0×
FAIL dwg/A09 no two schedule rows share a room name — "Open Workspace" on rows 246, 247, 248
FAIL dwg/A09 every row's name is the one predicted from core state — row 246: "Open Workspace"
     vs predicted "Open Workspace (5)"; …
FAIL dwg workbook Inventory names are the ones predicted from core state — …          ← the NEW check
FAIL dwg workbook Inventory names are unique — "Open Workspace" on rooms 246, 247, 248
SG3 FAIL (295 checks, 12 failing) · SG4 FAIL (36 checks, 4 failing)
```

The defect is caught, and the two new checks (A.09 and workbook against the exact predicted name) are
genuinely stronger than the shipped `admissible()` grammar, which accepted any ordinal. **But:**

* **D-D (major, gate).** `sheets-S3-1.md` §4 claims "All 6 fail-first failures above still fire on the
  pre-fix sheets." **Four do not.** `dwg/A02`, `dwg/A03`, `dwg/A04 no room name is rendered twice`
  (4.2) fired 3× at HEAD and are **silent** under the amendment, because `expected` now holds only
  predicted display names (`sg4-name-uniqueness.mjs:227,231`) and the defective drawing prints the raw
  name — which is no longer in the search set. 4.2's population narrowed from "any room name the
  drawing prints" to "names the gate predicted". Net coverage survives (SG3 3.1 goes 0× and SG4
  4.3/4.4 fire), so this is not a blocker, but the report's claim is disproved by construction and the
  check no longer covers what it is named for.
* **D-E (minor, gate).** 4.1 (`sg4:209-216`) is now **a tautology — it can never fail.** Proof:
  `display` is `scheduledRooms()`'s own output. Two zones sharing a raw label share a base and are
  therefore in a group of ≥2, which is renumbered `(1)…(n)` — unique within the group. A singleton
  keeps its label `L`; if `L` equalled some group's `"G (i)"` then `strip(L) = G`, so the singleton
  would be in G's group — contradiction. Hence no two `display` values can ever collide. Three checks
  per board that measure nothing. The information it used to carry survives only in the check's
  *label text* ("1 core-state label collision(s) to resolve"), which no runner grades.

### 4.4 What the gates consume — no new independence violation

I found nothing consuming a producer value. `scheduledRooms().display` is re-derived in the gate from
core state; `roomNaming.ts` is not imported by any gate (`grep -r roomNaming scripts/gates` → nothing).
SG6 re-proved byte-identical gate output over pristine/corrupted/deleted producer metadata,
`PASS (16 checks)`, in my run.

---

## 5. MAJOR — D-F: `drawing-set.test.mjs` throws, so the **dwg** case is currently ungraded

Severity **major**, S5's to fix, but it is more than "one red check". The assertion at
`scripts/drawing-set.test.mjs:504` is an `assert.ok` that **throws**, and it fires on the *first*
case. `CASES = [seeded, dwg]`, so:

* seeded is graded up to the baseline comparison only;
* **dwg is never rendered or graded at all** — its structure, determinism, room-labelled-once and
  off-room-leader assertions have not run on the delivered set;
* SG5 therefore reports **25 checks, not 27** — two of its own checks are unreachable. SG5's stated
  contract is "a count delta is a FAILURE even if every check passes"; its own count has moved.

Do not read "SG5 red on one check" as "nothing else is unmeasured". Baseline re-recording must be
followed by a clean 252-check run before close-out.

---

## 6. Minor / cosmetic

| # | sev | finding | evidence | file:line |
| --- | --- | --- | --- | --- |
| D-G | minor | Room-label knockout halos erase **ceiling-circuit tags** on A.03. **Pre-existing, not a regression:** tags under a label halo — pre `2 / 2 / 6` (seeded/testfit/dwg) → now `2 / 0 / 9`. Visible: `FOCUS ROOM 2 02` on seeded A.03 (the `LC-` of `LC-02` eaten). Also two circuit tags print **on top of each other** (`LC-01` and `LC-02` both at (754,185) pt). No gate looks at A.03's non-room-label marks. | measured on the delivered text layer, both renders | `web/src/export/servicesSheets.ts:420-429` |
| D-H | minor | **A.01 is graded by no label gate.** `sg3 NAMED = A02, A03, A04` only. On testfit A.01 the `MEETING ROOM 2/4/6/8` labels and their areas straddle the building outline; on dwg A.01 they sit over demolition hatch. Both byte-identical to `1a2b8d5`, i.e. pre-existing and never covered. | viewed all 36 sheets | `scripts/gates/sheets/sg3-label-integrity.mjs:115-119` |
| D-I | minor | **SG1 1.4b does not do what its header says.** The header claims the contents index is compared to "the A.NN numbers the **delivered title blocks** carry". It is compared to the static `SHEETS` table (`inTitleBlocks`, `:260`). The `delivered` array built at `:138`/`:170` is **never read** — dead code that makes the check look artifact-side when it is table-side. (1.3's "the sheet number is drawn" gives partial artifact cover.) | code read; `delivered` has no consumer | `scripts/gates/sheets/sg1-panel-containment.mjs:138,170,260` |
| D-J | minor | The A.10 row widened SG1 1.1's vocabulary: `allowedWords` splits `sheet.title` (`:116`), so `Door`, `Window`, `Schedule`, `&`, `(cont.)` are admissible inside **A.10's** title block — and `Door`/`Window` are exactly the schedule's TYPE-column values. Not exploitable today (F5 still fired on the tag/size/material words), but the containment vocabulary and the content vocabulary now intersect on the one sheet that carries a schedule. | F5 | `sg1-panel-containment.mjs:110-120` |
| D-K | cosmetic | A.10 fills 1 of its 3 columns (10 / 17 / 13 rows against a 38-row column) and leaves ~70 % of the sheet blank. | viewed all three A.10s | `web/src/export/sheetSet.ts:1005` |
| D-L | cosmetic | `SCHED_ROW_H = 15` against a 16 pt tag hexagon: consecutive schedule tag glyphs touch on A.02 and A.10. Known (S1 §7.6); still true. | raster | `sheetSet.ts:814` |
| D-M | cosmetic | The overall-width dimension label (`24.00 m`) now floats at the **head** of the vertical dimension line on seeded/testfit A.02, reading as a stray number near the top-left corner rather than as a dimension on its line. Correct containment (D5 closed), weaker drafting. | viewed seeded/testfit A.02 | `web/src/export/sheetSet.ts` `dimString` vertical branch |
| D-N | cosmetic | `mergeGlazedRuns` leaves sub-tolerance slivers: 8 of seeded's 41 "windows" are `0.15 × 1.50 m`. This is the only reason pagination fires at all — fix the merge and A.10 disappears (taking D-C's fragility with it). | `A.10` rows, all packs | upstream of `openingSchedule` |

---

## 7. Duty 4 — nothing regressed outside the sheets

* **Main board: 11/11, `59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12)` — identical to
  `1a2b8d5`.** No check appeared or vanished.
* **`out/plan.png` is byte-identical pre-fix vs now**: `4bfd3e45adfe29acf5bf1e5b2c09e36095228b1c91d53a8f1f1108dd0a86d6cb`
  in both trees. The shared `placeNear` / `planGraphic.ts` edits moved zero pixels of the plan
  graphic — S2/S3's blast-radius claim holds by measurement, not assertion.
* **QTO workbooks.** `out/cases/seeded` and `out/cases/testfit` are byte-identical
  (`9edc94a198c8…`, `c0fe0a32e2d0…`). `out/cases/dwg` differs in **exactly three cells**, all column H
  (`Program Room Name`): `Open Workspace → Open Workspace (5) / (6) / (7)`. Parsed row-by-row out of
  the ZIP bytes, 25 rows pre / 25 rows post: **no quantity, formula, id or other string moved.** The
  intended change and nothing else — and SG4 4.4's new check now pins it to the core-state prediction.
* **SG6** `PASS (16 checks)` in my board run — determinism plus the three-run independence proof.

---

## 8. Which of the six defects are genuinely CLOSED

| defect | verdict | evidence |
| --- | --- | --- |
| **D1** A.02 schedule overflow | **CLOSED** | A.02 31 rows + A.10 10/17/13 = 41/48/44 = the plan's tag count exactly, no row on both sheets, no orphan row, pointer counts correct. Falsified (F1): re-introduce overflow → `SG1 FAIL (201, 9)` incl. the 1.4 pagination arm, `SG2 FAIL (24, 3)`. |
| **D2** tags escaping the plate | **CLOSED for containment — but the fix caused D-A** | Falsified (F2): drop the `plate` bound → `SG2 2.1` names **7** tags outside on dwg, `2.2` names the title-block one, `SG1 1.1` names W33. Containment holds today (`0` outside, all packs). The tags now land on room names instead: §1. |
| **D3** over-printed labels A.03/A.04 | **CLOSED on A.03/A.04 — the class is NOT closed set-wide** | Before/after on the same crops: `PRINT POIN` / `PHON PHON PHONE BOOTH 3` → `PRINT POINT 1`, `PRINT POINT 2`, `PHONE BOOTH 1/2/3`; dwg's `O OPEN WORKS OPEN WORKSPACE` → `(5) (6) (7)`. Falsified (F3): labels back at zone centres → `SG3 FAIL (295, 6)` reproducing S1's exact 7 pairs. The identical mechanism now runs on **A.02** — §1. |
| **D4** duplicate room names | **CLOSED** | dwg A.09, all three plan sheets and the workbook all read `Open Workspace (1)…(7)`; generator ordinals `(1)…(4)` unchanged; workbook diff is exactly 3 cells. Falsified (F4): remove disambiguation → `SG3 FAIL (295, 12)`, `SG4 FAIL (36, 4)` incl. both new prediction checks. Caveat D-D: 4 of SG4's 6 original fail-first lines no longer fire. |
| **D5** perimeter dim in the unprintable margin | **CLOSED** | `no ink left of the frame` green on all three packs, inside the 201. Drafting quality degraded slightly — D-M. |
| dwg `6.8 m²` over the title-block band (S2's fourth escape) | **CLOSED** | `dwg/A02 title-block purity` green; `roomLabels` now takes the plate as its region. |

---

## 9. What has to happen before this ships

1. **D-A.** Give a tag that lands on a room label the same treatment a tag that lands on another tag
   already gets (`sheetSet.ts:924-930`) — or draw tags **before** labels so the label's own halo wins,
   or drop the tag's white mask where it would cover type. Whichever, the gate that proves it must
   read **delivered ink**, not the text layer: assert that each room-name word retains ≥ N % of the ink
   it has when drawn in isolation, or that no tag mask rect intersects a room-label word box. SG3 3.3's
   blank-run test cannot do this — the tag fills the hole it made.
2. **D-B.** One new SG2 check: every opening in core state has exactly one schedule row across
   A.02 + every continuation sheet, and the `SCHEDULE CONTINUED ON A.NN` pointer names a sheet that
   exists and a count that matches.
3. **D-C.** Make `SHEET_SPEC` / `SHEETS` count-aware (derive the row list from the delivered title
   blocks — artifact-side and legal) before this suite meets a document with fewer than 32 openings.
4. **D-D / D-E.** Restore 4.2's population to "any room name the drawing prints"; delete or re-point
   4.1 rather than shipping a check that cannot fail.
5. **D-F.** After S5 re-records, confirm `drawing-set PASS (252 checks)` and `SG5 PASS (27 checks)`
   — the dwg case has not been graded once on the fixed set.

I found nothing else blocking. D1, D4 and D5 are closed cleanly; D2 and D3 are closed for the
specific symptoms they were written against and have re-opened one another's defect class on A.02.
That single interaction — a fix in one lane creating the other lane's defect on a sheet neither lane
re-inspected together — is the whole of the blocking finding.

---

### Method note

Reconstruction: nine files restored from `HEAD` via `git show HEAD:<path>` into
`scratchpad/prerepo`, `roomNaming.ts` removed, `node_modules` symlinked; render digests match
`sheets-S0-1.md` §3 exactly, so "before" is the real before. Sabotages F1–F7 each patched **one**
construct in `scratchpad/scratchrepo` (a full copy), re-rendered all three packs, ran the gates, then
restored. The repository under `/Users/udsy/.superset/worktrees/DSource-Editor/export` was never
edited except for this file; `git status --porcelain` is unchanged apart from it.
