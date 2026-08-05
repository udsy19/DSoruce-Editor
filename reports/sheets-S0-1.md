# S0-1 — the sheet harness: 33 sheets on disk, at a fixed DPI, with their template geometry

**Agent S0.** Standing infrastructure only. **No defect was fixed** — all four are still visibly
present (§6), which is the point: S1 needs them to write failing gates against.

Files changed
* `scripts/sheets/render-all.mjs` — **new**. The harness. Renders all 11 sheets × 3 packs to PNG at a
  fixed DPI, with a `geometry.json` beside every image.
* `scripts/render-sheets.mjs` — extended (no fork): the bundle now also exposes `sheetGeometry()`, and
  `renderSheetSet(name, { freezeDateAt })` can pin the page clock. Both additive; the default call
  behaves exactly as before, which is why `drawing-set.test.mjs` is untouched at **252 checks**.
* `web/src/export/sheetSet.ts` — **the one sanctioned change**: `export function sheetGeometry()` (+
  `export interface SheetRect`), 48 added lines, nothing else touched. It only *reads* the constants
  the sheets are already drawn with (`PAGE_W`/`PAGE_H`/`MARGIN`/`TITLE_BLOCK_H`/`PANEL_W`/`planBox()`)
  and returns them as rects. No drawing code calls it, so no sheet output can move — and the 252-check
  content baseline confirms it did not.
* `scripts/gates/run-all.sh` — a **step 0b**, off by default (§5).

---

## 1. The harness — API and on-disk layout

```
node scripts/sheets/render-all.mjs [--pack seeded|testfit|dwg|all] [--out out/sheets] [--dpi 144]
```

Importable, for gates that want to produce their own inputs:

```js
import { renderAllSheets, renderPackSheets, SHEET_SPEC, DEFAULT_DPI, FREEZE_DATE_AT }
  from './scripts/sheets/render-all.mjs'
await renderAllSheets({ packs, outDir, dpi, log })   // → per-pack manifests
```

```
out/sheets/index.json                  the packs this run rendered
out/sheets/<pack>/drawing-set.pdf      the PDF the PNGs come from
out/sheets/<pack>/cover.png            + cover.geometry.json
out/sheets/<pack>/contents.png         + contents.geometry.json
out/sheets/<pack>/A01.png … A09.png    + A01.geometry.json … A09.geometry.json
out/sheets/<pack>/index.json           per-sheet size + sha256, pdf sha256
```

`<pack>` ∈ `seeded` · `testfit` · `dwg` (the three `scripts/lib/demo-doc.mjs` builders, same as G9/G11).
Each pack directory is **deleted and rewritten** every run, so a gate can never grade a leftover sheet
from an older render.

**11 sheets per pack is asserted, and a short set is a hard failure** with the cause named:

```
seeded: drawing set came back with 9 sheets, expected 11. A short set means a sheet builder threw
and was swallowed by its try-wrapper — classically the two section sheets, when Chromium has no GL
context (render-sheets.mjs must launch with --use-gl=swiftshader).
```

That launch flag is preserved (`scripts/render-sheets.mjs:96`); the assertion is the tripwire proving
it still works. Measured: all three packs return 11, including **testfit**, which no baseline had ever
covered — I rendered and looked at all 11 of its sheets (§6).

Cost: `node scripts/sheets/render-all.mjs` → **13.3 s**, 33 PNGs, **13 MB** under `out/` (gitignored).

---

## 2. The pt→px scale, derived

PDF user space is 1/72 inch, so at a raster resolution of *D* dpi

> **ptToPx = D / 72**, and **px = pt × ptToPx**, origin top-left, y down — the same top-down space the
> `Page` helper and `sheetGeometry()` use, with **no offset**.

`DEFAULT_DPI = 144` is chosen so **ptToPx = 2 exactly** (no rounding anywhere in a gate's conversion).
A3 landscape `1190.55 × 841.89 pt` → poppler emits `ceil(pt × 2)` = **2382 × 1684 px**; the harness
computes that expectation itself and fails if the raster differs by more than 1 px. Every
`geometry.json` carries `dpi` and `ptToPx`, so a gate converts independently.

Verified on the pixels, not by eye — the title-block band's frame rule is drawn at `gray 0.3`,
`width 1.1` pt (`sheet.ts:317`), i.e. a 2.2 px stroke centred on the rect edge:

```
$ magick out/sheets/seeded/A02.png -crop 1x30+600+1360 +repage -colorspace gray txt:
  1370 #FFFFFF        1371 #4C4C4C        1372 #4C4C4C        1373 #FFFFFF
$ magick out/sheets/seeded/A02.png -crop 12x1+74+1450 +repage -colorspace gray txt:
    78 #FFFFFF          79 #4C4C4C          80 #4C4C4C          81 #FFFFFF
```

`A02.geometry.json` says `titleBlock.px = { x: 80, y: 1371.78, w: 2221.1, h: 232 }`. The drawn band
top lands on rows 1371–1372 and its left edge on columns 79–80: the template rect sits dead centre of
the stroke, in both axes. Scale and origin confirmed.

---

## 3. Determinism — the actual digests

Three ingredients: the packs are seeded documents, the title block is the frozen `SHEET_META`, and the
one legitimately-varying value — `todayLabel()` — is pinned. `renderSheetSet(..., { freezeDateAt })`
sets the page timezone to UTC and freezes `Date` to `2026-01-01T12:00:00Z` **before** the set builds,
so every sheet stamps `DATE 01/01/2026` and no clock reaches a pixel. Fonts are the PDF base-14
(`/Helvetica`, `/Helvetica-Bold`); nothing calls `Math.random`.

Two consecutive full runs, digested per PNG:

```
$ node scripts/sheets/render-all.mjs
$ find out/sheets -name "*.png" | sort | xargs shasum -a 256 > run1.txt
$ node scripts/sheets/render-all.mjs
$ find out/sheets -name "*.png" | sort | xargs shasum -a 256 > run2.txt
$ diff run1.txt run2.txt && echo "IDENTICAL: $(wc -l < run1.txt) PNGs"
IDENTICAL:       33 PNGs
```

A third run, driven through the gate runner (`SHEETS=1 bash scripts/gates/run-all.sh G1`), matched
run 1 too:

```
$ diff run1.txt run3.txt && echo "run3 (via run-all.sh SHEETS=1) IDENTICAL to run1"
run3 (via run-all.sh SHEETS=1) IDENTICAL to run1
```

And a fourth, after a `--pack seeded` single-pack run and a rejected `--pack bogus` run in between:
`run4 IDENTICAL to run1 (4 runs, 33 PNGs each)`. Four renders, one digest set.

The 33 digests (from `out/sheets/<pack>/index.json`, and reproducible with the command above):

```
751a750beb2644a5453e1236ee274d8facd787d4279f2fabf9b92081dd146c21  dwg/A01.png
c5661519a2a9309b01c79afca49a9d9f889509951e62fdf0663267022eca733c  dwg/A02.png
98f5bb2b441e5f5771efdde8a81438f365752e7cc74e644125fe7fbc3da92585  dwg/A03.png
a3a35e579a54adad3e2f0e43641e9c13ec9bc4533d14ed272bfd475d3bf05414  dwg/A04.png
21f98a8e2d73fbde53494a748b09063b6912e50d5aa99c7d9394268781e2bd49  dwg/A05.png
f592e22c2e2a367a412d7cc9e40f307d259c7931cdeba33947e4f0b5d4a70608  dwg/A06.png
b5555f9cc5d2e9364dda811053b1c93e7655e1fe8ba9418f6cc3ab7b16c72373  dwg/A07.png
4799b10e921dc41ec36003455a4dbffbc91209b0ce980a8b3ca69d647fa1a371  dwg/A08.png
ad1e36be29019641395659494aec77902dae7cb7ed71190a7ae1878f72576f4d  dwg/A09.png
28d669b646e0e07df321a62929cb060aa45448668f13a88e7c909e28c5981c94  dwg/contents.png
679b7c2cc45dc5684e9c0644410bc6ec0a5bcde13e129c668907b5bfb22a92ec  dwg/cover.png
66aa386210b2d351553fb26e1697c9be9f5705f80884019c18a655a2a74442a5  seeded/A01.png
4fe0dcdfb52e108ff6efca2d7154cd23a9da7496f72d924644d0557e555907ee  seeded/A02.png
580429d2e04b52f3dfc9a888350943e1bd1037d01c336fa484cbcafbd41a16b0  seeded/A03.png
969774163c92d7eb310773eb93bd6af089b078dc52e423c2ead200f4cc6367de  seeded/A04.png
b1ac3beeec2e4fd3b675cf526d1c530f5e678a27e34adf5d0559de06424d801d  seeded/A05.png
77e9d15b89f000dba422cfd9b833d83014401e74c314b958006c6b0bb1044336  seeded/A06.png
082f0fb3fb29097894a85b9b6913e2d98b0eb32e8d31949ca7cd79de64045026  seeded/A07.png
0f0921c982f06d5745d861aa8bf8889e97ded1969b884ea5d909f8c7ddbc9b9f  seeded/A08.png
cb5978c39ac98334058b9a6d3cdc986574031c2a7ae2fda6ceee43b9f04474dc  seeded/A09.png
28d669b646e0e07df321a62929cb060aa45448668f13a88e7c909e28c5981c94  seeded/contents.png
61834ea2257a43fbd334ee7e49cfa34f27b5eeba758ab00a335184120e7505c9  seeded/cover.png
e16d910d97063093928b3ba41e4012a347c1ca39dafec30f02cc632021663679  testfit/A01.png
61631525a7a32508bee87f04dc4cd170feeda5243a6b8bb3b4d9e4048e7a8083  testfit/A02.png
c16f50143c686030d25367318993904d78200a7037a80aa664ead2b2e2b71f46  testfit/A03.png
42ec45a871972d3ec9546aa391352bcf94773a35073b62f75f9a64d5e1c87aa5  testfit/A04.png
a36dab8480bf3519f8279bdf5450e8f546288efa839f6b7852f3daaa204c5b50  testfit/A05.png
c4629ab1fd1f9c151405c6d58e7eaeec665e9bd616123186d08487fd887134ca  testfit/A06.png
c8f6acf789c963312523737de4aaffe9b235884e3eeec0185dd4bd3b36c09194  testfit/A07.png
52d9d607c1df3b6bdd2316b29823eb40bd547cafd93f26c0005b5f97be0c94b1  testfit/A08.png
08b2065c90e9cfc5f88ff1beecd721b3773cdbb9c905803fe7b7e724832a299f  testfit/A09.png
28d669b646e0e07df321a62929cb060aa45448668f13a88e7c909e28c5981c94  testfit/contents.png
bbc772c571393eab21255a8f09997b44a4509ca4d11cf1619ad37add13ff8fe7  testfit/cover.png
```

(`contents.png` is byte-identical across all three packs — the same 11-row index and the same project
block. A useful sanity signal, not a bug.)

---

## 4. `geometry.json` — schema, and where every number comes from

One file per sheet, e.g. `out/sheets/seeded/A02.geometry.json`:

```jsonc
{
  "pack": "seeded", "sheet": "A02", "index": 4, "no": "A.02",
  "id": "construction", "title": "Construction & Furnishing Plan", "kind": "plan",
  "image": "A02.png",
  "units": "PNG pixels, origin top-left, y down; `pt` is the same rect in top-down sheet points",
  "dpi": 144, "ptToPx": 2,
  "derivedFrom": [
    "web/src/export/sheetSet.ts sheetGeometry() — PAGE_W/PAGE_H/MARGIN/TITLE_BLOCK_H/PANEL_W/planBox()",
    "web/src/export/section.ts:67 PANEL_W=300 (section sheets)",
    "web/src/export/servicesSheets.ts:55 PANEL_W=316 (services sheets)"
  ],
  "page":      { "wPt": 1190.55, "hPt": 841.89, "wPx": 2382, "hPx": 1684, "note": "…" },
  "constants": { "margin": 40, "titleBlockH": 116, "panelW": 316,
                 "sectionPanelW": 300, "titleBlockBandTopPt": 685.89 },

  "frame":      { "pt": { "x": 40,     "y": 40,     "w": 1110.55, "h": 761.89 },
                  "px": { "x": 80,     "y": 80,     "w": 2221.1,  "h": 1523.78 } },
  "titleBlock": { "pt": { "x": 40,     "y": 685.89, "w": 1110.55, "h": 116 },
                  "px": { "x": 80,     "y": 1371.78,"w": 2221.1,  "h": 232 } },
  "panels":   [ { "id": "legend-schedule",
                  "pt": { "x": 834.55, "y": 66,     "w": 316,     "h": 619.89 },
                  "px": { "x": 1669.1, "y": 132,    "w": 632,     "h": 1239.78 } } ],
  "plate":      { "pt": { "x": 46,     "y": 66,     "w": 772.55,  "h": 603.89 },
                  "px": { "x": 92,     "y": 132,    "w": 1545.1,  "h": 1207.78 } }
}
```

* every rect appears in **both** spaces (`pt`, `px`); `px` values are exact `pt × ptToPx`, unrounded, so
  a gate picks its own floor/ceil convention;
* `frame` is the printable area (page inset by `MARGIN`) — a layout region, not necessarily drawn;
* `titleBlock` is `x=MARGIN, y=PAGE_H−MARGIN−TITLE_BLOCK_H, w=PAGE_W−2·MARGIN, h=TITLE_BLOCK_H` — the
  band `titleBlock()` fills, identical on every numbered sheet;
* `panels[]` is the right-hand column's **legal extent**: from the top of the plan band down to the
  title-block band top. Nothing in the render marks that boundary, which is exactly why a gate cannot
  measure it and must be told it by the template — and it is the line the A.02 schedule breaks
  through (§6.1);
* `plate` is `planBox()`'s viewport — where the plan raster is placed;
* front matter (`cover`, `contents`) has `titleBlock: null`, `panels: []`, `plate: null` plus a `note`:
  `coverSheet`/`contentsSheet` draw no title block and no panel column and lay out inline rather than
  through the shared plan template. Nothing is invented for them.

Per `kind`: `plan`/`services` (A.01–A.04) get the shared plan template; `section` (A.05/A.06) get the
same band and plan origin with section.ts's narrower 300 pt notes column; `sheet` (A.07–A.09) get the
title block only (their content spans the full frame).

### Why this is a legal anchor (`.claude/rules/gate-independence.md`)

* **Not one number is measured off the drawing.** `sheetGeometry()` is evaluated in the page *before*
  `buildDrawingSetPdf` is called, and returns constants. Template constants are spec; the drawn page is
  the system under test.
* **The two modules that own their own column are read from their source, not copied.**
  `sourceConst('web/src/export/section.ts', 'PANEL_W')` parses the declaration and reports the file:line
  in `derivedFrom`. A private copy in the harness would be the drift the no-bloat rule exists to stop.
* **Drift between the two 316s is a hard failure**, not a silent mismatch:
  `panel width drift: sheetSet.sheetGeometry() says 316, web/src/export/servicesSheets.ts:55 says N …`
* **A missing input fails.** No `pdftoppm` → a named error with the install line; no `const PANEL_W`
  → `the harness cannot read the template geometry`; wrong page count, wrong image count, or a raster
  whose size disagrees with the template → throw. There is no `continue` anywhere.

---

## 5. Wiring — step 0b, off by default

`scripts/gates/run-all.sh` gains one block, in the shape of the existing step 0:

```bash
#   SHEETS=1 bash scripts/gates/run-all.sh        # also render the drawing sheets (step 0b)
SHEETS_NOTE=""
if [ "${SHEETS:-0}" = "1" ]; then
  echo "  rendering the drawing sheets: node scripts/sheets/render-all.mjs"
  node "$REPO/scripts/sheets/render-all.mjs" --out "$OUT/sheets" …
  if [ $? -ne 0 ]; then SUITE_FAIL=1; SHEETS_NOTE="… FAILED — out/sheets is whatever was on disk"; fi
fi
```

Off by default because nothing grades sheets yet and the board's gate list and counts must not move.
**S1: make this unconditional (or condition it on `selected G12`) in the same change that adds the
first sheet gate**, and append to `IDS`/`CMDS`/`TITLES`. `IDS`, `CMDS`, `TITLES`, `PRODUCER_IDX`,
`PACK_FILES` and `CASE_FILES` are untouched. Wiring verified live:

```
$ SHEETS=1 bash scripts/gates/run-all.sh G1
  rendering the drawing sheets: node scripts/sheets/render-all.mjs
  G1   Sheet structure    PASS  (59 checks)
  1/1 passing … ALL GATES GREEN.                                          14.1 s
```

### The board, unchanged

```
$ bash scripts/gates/run-all.sh
  G1   Sheet structure    PASS  (59 checks)      G7   Video          PASS  (19 checks)
  G2   Formula liveness   PASS  (17 checks)      G8   Web viewer     PASS   (9 checks)
  G3   Quantity truth     PASS  (92 checks)      G9   Round-trip     PASS  (24 checks)
  G4   Plan graphic       PASS  (18 checks)      G10  One-action UX  PASS  (14 checks)
  G5   Thumbnails         PASS  (70 checks)      G11  Furniture agr. PASS  (56 checks)
  G6   Renders            PASS  (53 checks)
  11/11 passing
               unchanged since G10 produced it; PASS  (12 checks)
ALL GATES GREEN.                                                          4:31
```

59 · 17 · 92 · 18 · 70 · 53 · 19 · 9 · 24 · 14 · 56 (+12) — identical to R-1/Q-1.

```
$ cd web && pnpm typecheck                 → clean (tsc --noEmit, no output)
$ node scripts/drawing-set.test.mjs        → drawing-set PASS (252 checks)
```

The 252-check run reproduces R-1's numbers line for line (`seeded: 11 sheets · 1088 text / 4204 line /
860 rect ops · rooms 22 · A.01 2 off-room, 1 led …`), which is the proof that **no sheet output moved**:
that test digests the text+vector content of all 11 sheets of both packs against a recorded fixture.

---

## 6. The four defects are still there — looked at, sheet by sheet

I rasterised and opened all 33 sheets. The four pre-existing defects R-1 recorded are all still
present, and the harness captures every one of them.

**6.1 A.02's door/window schedule prints over the title block — seeded, testfit and dwg.**
The proof the brief asked for. Cropping `seeded/A02.png` at *exactly* the `titleBlock.px` rect from
its `geometry.json` (`80, 1371.78, 2221.1 × 232`):

> rows **W16–W23** of the DOORS & WINDOWS SPECIFICATIONS table run straight through the band — over
> `TITLE  Construction & Furnishing Plan`, over `DRAWN DS` / `APPROVED UT` / `SCALE 1:155`, and across
> the big `A.02` sheet-number box. The table has no pagination and no clip: on the full sheet it starts
> at the panel top and simply keeps going past the panel's bottom edge (`panel.px.y + panel.px.h =
> 1371.78`, the same line) to W24 at the very foot of the page.

Worse on **dwg** (33 windows): the same crop shows **W22–W29** over the title block. On **testfit**,
**W15–W22**. Three packs, three overprinted title blocks — the defect no gate could see, because no
gate had a sheet.

**6.2 Opening tags escape the plate — dwg A.02.** In that same title-block crop, tag **W33** is drawn
*inside the title block's NOTES panel*, with its leader crossing the band frame from the plate above.
`plate.px` from `geometry.json` bounds the region a tag may occupy: `92, 132, 1545.1 × 1207.78`.

**6.3 The services sheets clip and collide their room labels — A.03/A.04, all packs.** On
`seeded/A03.png`: `PRINT POIN`, `PRINT P`, `PHON PHON PHONE BOOTH 3`, `WELLNESS ROOm` — truncated
mid-word and overprinting each other. Same on dwg (`OOTH 3`, `O OPEN WORKS OPEN WORKSPACE`).

**6.4 Three rooms share one name — dwg.** From the A.09 finish schedule of `out/sheets/dwg/`:

```
$ pdftotext -f 11 -l 11 -layout out/sheets/dwg/drawing-set.pdf - | grep -i "open workspace"
  246   Open Workspace   Open Workspace   …   1.0
  247   Open Workspace   Open Workspace   …   1.0
  248   Open Workspace   Open Workspace   …   1.0     ← three rows, mutually indistinguishable
```

and `grep -c "OPEN WORKSPACE"` on sheet 4 returns **7** labels for a plan that labels by name.

Nothing else about the sheets changed: the 252-check content baseline is exactly R-1's.

**Also looked at, for the record:** all 11 **testfit** sheets, which no baseline had ever covered
(`drawing-set.test.mjs` records `seeded` + `dwg` only). They render correctly — cover hero, 11-row
contents, both section cuts on the real WebGL path, furniture cards, the "NO PRODUCTS SPECIFIED YET"
moodboard, and a full finish schedule — and testfit carries defect 6.1 too.

---

## 7. Open risks

1. **Font substitution is machine-local.** The PDF uses the base-14 `/Helvetica`, which poppler
   substitutes via fontconfig. Digests are reproducible on a machine, but a different box (or a
   fontconfig change) will move every PNG. **A gate must not hash whole sheets** — measure ink against
   the geometry rects, which is what `geometry.json` is for. Same for a poppler upgrade.
2. **The date is frozen to `2026-01-01`**, so the harness PNGs differ from what the app prints today in
   exactly that one field. Deliberate: it is the only value that would otherwise change daily. A gate
   asserting on the title block's `DATE` should read `FREEZE_DATE_AT`, not `new Date()`.
3. **`SHEET_SPEC` is positional.** Sheet *k* of the PDF is assumed to be spec entry *k*. Guarded by the
   hard 11-sheet assertion, and verified for all three packs with `pdftotext` page by page (cover,
   contents, A.01…A.09 in order). It would break if a pack ever paginated furniture onto a second
   sheet (12 pages) — which fails loudly rather than mislabelling, but a future pack with >12 bound
   products will need `SHEET_SPEC` to become count-aware.
4. **`pdftoppm` (poppler) is a new external dependency** for the harness. Absent → a named failure with
   the install line, never a silent skip. It was already the de-facto tool (R-1 used it by hand).
5. **13 MB per full run** under `out/sheets/` (gitignored). At 144 dpi a 6 pt schedule row is ~12 px
   tall — enough for ink measurement, not enough for OCR of the smallest type. Raise `--dpi` if a gate
   needs more; `ptToPx` follows, but the digests above are 144-dpi digests.
6. **The section/services panel widths are read out of source text** (`const PANEL_W = 300`). If those
   modules ever compute the width instead of declaring it, `sourceConst` fails loudly — by design, but
   it is the one place the harness is coupled to a module's *shape* rather than its exports. The clean
   fix, when someone may edit those files, is to have them import `sheetGeometry()`.
7. **The harness renders its own PDFs** rather than grading a shipped artifact. That is correct for a
   producer, but it means a sheet gate grades the *harness's* render of the drawing set — so step 0b
   must run in the same invocation as any sheet gate (as step 0 does for G9), or the gate is measuring
   a stale directory. The `rm -rf` of each pack directory per run is the local half of that guarantee.
