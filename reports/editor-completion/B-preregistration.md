# Workstream B — D-P pre-registration (committed BEFORE any fix code)

Branch `fix/sheet-occupancy`, base: merge of `main` @ 4ea630b. Scope: the sheet
extraction path only (`web/src/export/sheetSet.ts` + `servicesSheets.ts` call
sites); root cause recorded in `reports/SHEETS-FINAL.md` §7 (D-P) and
`reports/sheets-defects-2.md` §1.

## 1. The instrument is reconstructed and PROVEN to be the frozen one

The D-P instrument (`scratchpad/overlap.mjs`, ephemeral, lost) is reconstructed
as the committed gate **`scripts/gates/sheets/sg8-string-ink-crossing.mjs`**,
from the documented method only: wall segments and door-swing arcs from core
state re-projected with SG2's `planProjection` (stateBbox fit, pad 48, RES,
validated plate rect); poppler word boxes chained on SAME_LINE 0.05 /
WORD_GAP 3.5; layer-aware per sheet; no mirror; hit = string box within
`thickness × ptPerM / 2` of a wall centreline or within 0.7 pt of the swing
polyline (hinge −w/2, radius w, −π/2…0, + leaf); candidates are the three
annotation families the corpus names (room-name / area / dimension strings —
opening tags, circuit tags and word-carrying fixture glyphs are attached to
walls BY DESIGN and SG2 2.5 asserts exactly that, so they are not candidates).

**Validation, in a scratch worktree at the corpus commit `f95c9b0`** (its own
Rust built to wasm, its own render of all three packs — the exact tree the 107
was measured on):

```
seeded/A01  0            testfit/A01  5 (wall 5,  arc 0)   dwg/A01  8 (wall 8,  arc 0)
seeded/A02 12 (w7,a10)   testfit/A02 22 (wall 17, arc 15)  dwg/A02 21 (wall 19, arc 8)
seeded/A03  4 (w4,a0)    testfit/A03  4 (wall 4,  arc 0)   dwg/A03  9 (wall 9,  arc 0)
seeded/A04  6 (w4,a5)    testfit/A04  5 (wall 4,  arc 4)   dwg/A04 11 (wall 9,  arc 9)
TOTAL 107   — identical, sheet for sheet AND wall/arc split for split,
              to reports/sheets-defects-2.md §1's table
D-Q (outside footprint, names/areas, centre rule): 14 — identical to §4.1,
              distribution 7/4/1/1/1 across the same five sheets
```

Named worst cases reproduce too: `PHONE BOOTH 2 @ (465,266)` wall+arc,
`CABIN 2 @ (544,255)` wall, `3.00 m` arc hits — the §1 exhibits.

## 2. The pre-fix baseline on THIS branch is 87, and why that is not 107

Run on the working tree (merge of main @ 4ea630b, fresh wasm, fresh render):

```
seeded/A01  0            testfit/A01  5                    dwg/A01  8
seeded/A02  4            testfit/A02  8                    dwg/A02 20
seeded/A03  4            testfit/A03  4                    dwg/A03 11
seeded/A04  6            testfit/A04  5                    dwg/A04 12
TOTAL 87        D-Q outside-footprint total: 37
```

The corpus and method are FROZEN and unchanged — the same instrument reads 107
at the corpus commit and 87 here. The delta is the artifact moving under
already-merged main-line work, not the yardstick moving: every sheet whose
producer and document did not change between f95c9b0 and this base matches the
frozen table EXACTLY (seeded A01/A03/A04, testfit A01/A03/A04 — six sheets,
digit for digit). The two mismatch groups each have a named cause:

* **A.02 (seeded 12→4, testfit 22→8, dwg 21→20):** commit `46908c6` ("E7 on the
  sheet path: labels step aside for furniture") seeded A.02's occupancy with
  furniture footprints after the 107 was measured — label positions on A.02
  legitimately moved.
* **dwg all sheets (A03 9→11, A04 11→12) and testfit/dwg A02 residue:** the
  Rust core changed under the packs (`df10cfa` conform-on-edit and the ground
  re-classification series), so the dwg/testfit documents themselves differ.

87 is therefore the operative RED baseline for this workstream; 107 remains the
frozen corpus figure the instrument is calibrated against.

## 3. Pre-registered post-fix expectation

**Registered: 0 strings crossing wall or door-swing ink, on all 12 plan sheets,
all three packs** (Phase 0's registration, kept). Reasoning: every hit at the
baseline is a placed annotation (room name, area, room dim) or a room dim whose
skip-guard reads the same occupancy; seeding the base raster's ink as hard
occupancy makes the strict/soft/forms ladder step every one of them aside, and
`placeNear`'s weighted fallback prefers soft furniture (0.02) to hard ink (1.0)
where nothing is clear.

* Any survivor requires a NAMED per-string reason (e.g. a room too small for
  its label at maximum displacement with every candidate on ink), or the
  terminal state is RED-WITH-ROOT-CAUSE — never GREEN-with-asterisk.
* **Falsifier of the mechanism (pre-registered in Phase 0):** if seeding moves
  the count by <50% (87 → >43), the asymmetry was not the main cause — stop and
  re-register before proceeding.
* **D-Q guard:** the outside-footprint count (same instrument, note line) is 37
  at the baseline and MUST NOT INCREASE post-fix. D-Q itself is a different
  defect and is not being fixed here.
* Opening tags are exempt from the seeded ink (they live on their openings;
  SG2 2.5 asserts the attribution) — the seeded boxes are removed from the
  occupancy before the tag pass, so tag placement semantics do not change.

## 4. What the fix is (one asymmetry, closed)

`sheetSet.ts`'s plan occupancy starts empty of the base raster's ink while
`planGraphic.ts:300-304` seeds it (E7's landing fix) — and the ink needs walls
and door swings as well as furniture. The fix seeds, per plan sheet, hard
occupancy boxes for exactly the ink that sheet draws: wall bands (chopped along
the segment, inflated by half thickness + a stroke pad) for the wall classes
its layer set enables, door-swing bounding boxes where furniture is drawn, and
A.01's demolition-hatch segments. Applied to A.01 (`demolitionSheet`), A.02
(`constructionSheet`), A.03/A.04 (`servicesSheets.ts` — outside the named file
but inside the sheet path; flagged in the workstream report).
