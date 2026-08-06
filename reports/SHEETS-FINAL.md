# SHEETS-FINAL — drawing-set defect closure + permanent sheet gates

**Board: 12/12 on two consecutive full runs**, identical counts both times.

| G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | G10 | G11 | **G12** | integrity |
| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 59 | 17 | 92 | 18 | 70 | 53 | 19 | 9 | 24 | 14 | 56 | **587** | 12 |

= **1,022 gate + 12 integrity**. Standalone sheet board **6/6** (SG1 216 · SG2 24 · SG3 295 · SG4 36 ·
SG5 27 · SG6 16). `cargo test -p ds-core` 150 passed. `pnpm typecheck` clean. `drawing-set.test.mjs`
**283 checks**, up from 252.

G1–G11 counts are **byte-identical to the `1a2b8d5` baseline** — the mission added coverage without
disturbing a single existing check.

---

## 1. Why this mission existed

`buildDrawingSetPdf` was referenced only by `SheetsPanel.tsx` and sibling modules. **No test, script or
gate had ever rendered a sheet.** Four defects had been sitting in the architectural drawing set,
found only when the qbiq close-out rasterized all 22 sheets by hand for the first time.

## 2. What shipped

**Standing infrastructure that did not exist before**
- `scripts/sheets/render-all.mjs` — 12 sheets × 3 packs → PNG at 144 dpi (`ptToPx` exactly 2, verified
  against pixels), with a spec-derived `geometry.json` beside every image. Deterministic across four
  runs, date frozen. Asserts the sheet count and **stages-and-swaps**, so a render failure leaves the
  previous pack byte-identical plus `RENDER-FAILED.json` rather than emptying the directory.
- `scripts/gates/sheets/` — **SG1–SG6**, every one written *before* its fix and watched to fail.
- Wired as **G12** on the main board.

**Defects fixed — 10, against 4 reported**
| | Defect | Evidence |
| --- | --- | --- |
| D1 | A.02 schedule printed over the title block **and off the page** (rows at y 807–814 pt vs frame bottom 801.89; 2,975 ink px inside the sheet-number box) | paginates onto A.10, capacity measured from panel geometry (32 rows vs 41/48/44 openings) |
| D2 | **Five** opening tags outside the plate (W33 69.6 pt below it, inside NOTES) | 0 outside, 0 tag-on-tag overlaps, 104 leaders |
| D3 | Room labels mutually erasing | see §3 — root cause was not what was reported |
| D4 | Three rooms named "Open Workspace" | shared idempotent `roomNaming.ts`; 246/247/248 → (5)/(6)/(7). The one sanctioned cross-cutting change: `planGraphic.ts::planRoomList`, `finishSchedule.ts` and both sheet families all resolve names through it, so plan, sheets and workbook cannot diverge. G4 (18) and G11 (56) unmoved; G1/G3 unmoved. |
| D5 | Perimeter dimension string at x 16.26 pt, **outside `MARGIN = 40`** | found by SG1, not by the defect list |
| D6 | dwg `6.8 m²` across the title-block band | same |
| D-A | **The D2 fix re-opened D3**: confining tags pushed them onto room names, whose masks erased them | plan words >15% under a tag mask **9 → 0**, and 0 at a 0% threshold |
| D-G | A.03/A.04 circuit tags had no de-collision at all | knocked-out 10/9/18 → 0/0/2; tag-on-tag pairs 15/9/64 → **0/0/0** |
| D-O | SG1 blind to a dropped glazed run (gate defect) | new 1.5e anchors the Window half to core state |
| D-R | Two exit-luminaire glyphs on one point | `E`↔`E` 2.91 pt → 20.53 pt |

## 3. What gate-first bought — the whole argument for the discipline

Every gate was authored before its fix and watched to fail. Three of the four reported root causes
were **wrong**, and the gates said so before a line of fix code was written:

- **D3 was not clipping.** `roomLabelBoxes` placed every label at its zone centre **and nowhere else** —
  no de-collision on A.03/A.04 at all — and `drawRoomLabels`' per-label white knockout halo then
  erased whatever a previous label drew. The prescribed fit ladder would not have touched it. Worse,
  **two of its rungs are actively harmful**: wrapping dwg room 214 onto two lines made SG3 report
  `"Open Workspace (4)" rendered 0×`, because a wrapped name is no longer one recoverable glyph run.
  Rungs are now ordered by damage, **displacement first**.
- **D4 would have produced `Open Workspace (1) (1)`** — the generator already suffixes 154/208/211/214.
- **D1 and D2 were both worse than reported** (off-page, five tags not one).
- **"A.02 was never clean, only lucky."** `placeNear` always places — least-overlap fallback — so once
  D4 widened three labels it printed `PRINT POINT 1` and `CORE 2` 1.6 pt apart. Hence `tryPlaceNear`,
  strict, returning `null`: *a placer that cannot say "no" cannot be asked whether a form fits.*

## 4. The recurring root cause, and its fourth instance

`.claude/rules/gate-independence.md` exists because a gate kept trusting the thing it tested. **It
recurred here, inside a gate written to enforce it**: SG1 §1.5d anchored only the *Door* half of
schedule completeness to core state; the *Window* half compared two readings of **one contaminated
population**. Dropping a glazed run upstream removed the tag *and* the row together, both sides
agreed, and SG1/SG2/SG3 all passed. Fixed by anchoring windows to core-state geometry — proven by a
falsification that drops a segment *inside* the merge, so the anchor demonstrably reaches the geometry
rather than the producer's list.

**And "emission is not visibility" recurred verbatim**: while D-A was live, SG3 3.1 passed on the
*text layer* — the glyphs were emitted, then painted over.

D-A's fix is structural rather than tuned: **one occupancy per region** (dims → names → tags, reserved
in rank order) and **three paint passes** (all masks → all symbols → all type), so no family's mask can
reach another family's glyphs *regardless of placement*.

## 5. Two runner defects found while wiring G12

- **The board could disagree with its own rows.** `FAILED` incremented on exit code alone, so a gate
  that exited 0 while printing `FAIL` was tallied as passing — observed live: `12/12 passing` printed
  directly above `G12 FAIL`. Both runners now fail on the exit code **or** the scoreboard line.
- **Naive G12 wiring would have manufactured an integrity failure.** `sg5-board-integrity.mjs:78`
  invokes `run-all.sh`; nested inside G12 that re-runs producer G10, rewriting `out/` while the outer
  integrity pass holds a BEFORE snapshot. G12 therefore runs `--no-produce SG1 SG2 SG3 SG4 SG6` —
  SG5 is redundant there by construction (the board it checks is the one running) and is exercised by
  the standalone sheet board.

## 6. Baseline (Law 4)

`scripts/fixtures/drawing-set.baseline.json` was kept stale all mission on purpose. S5 **inspected all
36 sheets before blessing them**, then verified the *old* baseline by reconstructing the pre-mission
product (restore 4 files from HEAD, delete `roomNaming.ts`) and reproducing **all 22 recorded md5s
exactly** — proving every delta is this mission's. Each changed digest is justified individually in
`reports/sheets-S5-1.md`; one puzzling delta (30 of 115 luminaires moving ±1.00 pt) was chased to its
mechanical cause (nudge step 14 pt → shared `dv = 15`/`dh = 12.6`). **Nothing was blessed unexplained.**

`BASELINE_DRAWING_SET` 252 → **283**, raised deliberately with the split measured, not inferred: **+18**
checking layer (S7 made failures recorded not thrown, so the dwg case is graded again — at `1a2b8d5`
it was never rendered after the first throw) and **+13** product (12th sheet + dwg's distinct names).
A *decrease* remains a defect.

## 7. Known open — routed, not hidden (`docs/ROADMAP.md`)

- **D-P (major): 107 room-name / area / dimension strings print across wall and door-swing ink.**
  Proven pre-existing by measurement at three commits — **103 at `1a2b8d5` → 106 after S2/S3 → 107
  now**, with 106 of 107 identical coordinate-for-coordinate. Root cause is precise:
  **`sheetSet.ts:1021` starts the plan's occupancy empty and never seeds it with the base raster's
  ink**, where `planGraphic.ts:300-304` does — the sheets never received E7's landing fix.
- **D-Q (major): 14 strings print outside the building footprint** (up to 33 pt).
- dwg A.01 labels over demolition hatch; dwg A.03 ceiling grid unclipped to the irregular polygon;
  A.08 ~95% blank; A.07 placeholder thumbnails.

**Therefore: the drawing set is shippable as the client-facing deliverable this program targets, and
NOT yet shippable as a construction set.** D-P and D-Q are the entry cost for the latter.

Full history: `reports/sheets-S{0,1,2,3,5,6,7,8}-1.md`, `reports/sheets-defects-{1,2}.md`.
