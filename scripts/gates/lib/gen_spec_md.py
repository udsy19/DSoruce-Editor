#!/usr/bin/env python3
"""Generate docs/reference/qbiq/spec/workbook-spec.md from workbook-spec.json."""
import json, os, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SPEC = os.path.join(ROOT, "docs/reference/qbiq/spec/workbook-spec.json")
MD = os.path.join(ROOT, "docs/reference/qbiq/spec/workbook-spec.md")
s = json.load(open(SPEC))
S, C = s["sheets"], s["contract"]
L = []
w = L.append

w("# qbiq Quantity Takeoff — workbook specification\n")
w("Machine-generated from the real reference file. **Do not hand-edit** — regenerate with:\n")
w("```bash\npython3 scripts/gates/lib/extract_workbook_spec.py   # structure + media + every formula\n"
  "python3 scripts/gates/lib/extract_contract.py         # the generalized contract block\n```\n")
w(f"- Source: `{s['source_file']}` ({s['source_bytes']:,} bytes)\n"
  f"- Machine-readable form: [`workbook-spec.json`](workbook-spec.json)\n"
  f"- Shared colour truth: [`palette.json`](palette.json)\n"
  f"- Generator output contract: [`ground-truth.schema.json`](ground-truth.schema.json)\n")

w("\n## 1. Sheets — exact names and order\n")
w("The 12-sheet order below was **verified against the real file** and matches "
  "`workbook-spec.provided.json`. Gate **G1** enforces it exactly.\n")
w("| # | Sheet | Used range | Rows | Cols | Gridlines | Images | Validations |")
w("|--:|-------|-----------|-----:|-----:|-----------|-------:|------------:|")
for i, n in enumerate(s["sheet_order"]):
    d = S[n]
    w(f"| {i+1} | `{n}` | {d['dimensions']} | {d['max_row']} | {d['max_col']} | "
      f"{'on' if d['gridlines'] else '**off**'} | {len(d['images'])} | {len(d['data_validations'])} |")
w("\nGridlines are **off on all 12 sheets**. Every sheet except `dropdowns` carries the logo.\n")

w("\n## 2. Embedded media\n")
med = s["media"]
w(f"`{len(med)}` files in `xl/media/`, all extracted to [`media/`](media/).\n")
w("| Role | File | Format | Pixels | Bytes | Where |")
w("|------|------|--------|--------|------:|-------|")
w(f"| **Master plan** | `image1.png` | PNG RGBA | **1040x780** | {med['image1.png']['bytes']:,} | `Plan!A1:M37` |")
w(f"| Logo (Plan) | `image1.jpeg` | JPEG | 199x92 | {med['image1.jpeg']['bytes']:,} | `Plan!B2` |")
w(f"| Logo (data sheets) | `image2.jpeg` | JPEG | 181x83 | {med['image2.jpeg']['bytes']:,} | `B2` on 9 sheets, `B3` on BOM - Glass Partitions |")
w(f"| Room thumbnails | `image2.png` … `image32.png` | PNG RGBA | **240x180** x31 | 763–11,171 | `Inventory!B5:B35`, one per row |")
w("\n> **The provided spec got this wrong.** It reports `image1.jpeg` as the logo on every "
  "data sheet and `image1.png` as every Inventory thumbnail, because openpyxl renumbers "
  "image references per drawing part. There are in fact **two distinct logo JPEGs** "
  "(`image1.jpeg` 199x92 for Plan, `image2.jpeg` 181x83 elsewhere) and **31 distinct "
  "thumbnails**. Building from the provided names would embed one image everywhere.\n")

pp = C["planSheet"]
w("\n## 3. `Plan` sheet\n### 3.1 Master plan image\n")
mp = pp["masterPlanImage"]
w(f"- Media `{mp['media']}`, **{mp['px'][0]}x{mp['px'][1]}** px, two-cell anchor `{mp['anchorFrom']}` → `{mp['anchorTo']}`.\n")
w(f"- Opaque bounding box: `{mp['opaqueBBox']}` = **{mp['opaqueBBoxSize'][0]}x{mp['opaqueBBoxSize'][1]}**.\n")
w(f"- {mp['note']}\n")
w("\n### 3.2 Wall-type legend block\n")
lb = pp["legendBlock"]
w(f"Header `{lb['headerCell']}` = `\"{lb['headerText']}\"`, merged `{lb['headerMerged'][0]}`, "
  f"fill `{lb['headerFill']}`, font `{lb['headerFontColor']}` at 10pt.\n")
w("| Chip cell | Chip fill | Label cell | Label string | Label fill |")
w("|-----------|-----------|------------|--------------|------------|")
for r in lb["rows"]:
    w(f"| `{r['chipCell']}` | `{r['chipFill']}` | `{r['labelCell']}` | `{r['label']}` | `{r['labelFill']}` |")
w("\nAll seven label strings are enforced by **G1**; the chip fills are enforced against "
  "`palette.json` by **G4**.\n")
w("\n### 3.3 Plan PNG pixel palette (counted, not eyeballed)\n")
w("| Element | Value | Pixels |")
w("|---------|-------|-------:|")
pd = pp["planPixelPalette"]
w(f"| Circulation | `rgba(255,0,0,25)` → **`#FFE6E6`** on white | {pd['circulation']['pixels']:,} "
  f"(**{pd['circulation']['pctOfOpaqueBBox']}%** of plate) |")
for k in ("drywall", "glass", "perimeter_windows", "perimeter_wall", "door_swing", "core", "half_drywall", "roomLabelText"):
    e = pd[k]
    w(f"| {k.replace('_',' ').title()} | `{e['hex']}` | {e['pixels']:,} |")
w(f"\n> **Reference inconsistency:** {pd['core']['warning']}\n")

w("\n## 4. Formula wiring — the part that matters\n")
w("Every body cell except one is a formula. Change a unit price in `General` and the whole "
  "workbook moves. Reproducing the *strings* is not enough — the **ranges must be literal and "
  "identical**, which is what makes it recalculate in Excel and LibreOffice. Gate **G2** proves "
  "liveness by actually recalculating through headless LibreOffice.\n")
w("\n### 4.1 `General` is the single lookup source\n")
w("| Category | Band header | Name column | Lookup table | Cols (id / unit / len / price) |")
w("|----------|-------------|-------------|--------------|-------------------------------|")
for cat, t in C["formulaPatterns"]["generalLookupTables"].items():
    cols = f"{t['idCol']} / {t.get('unitCol','-')} / {t.get('lengthCol', t.get('amountCol','-'))} / {t['priceCol']}"
    w(f"| {cat} | `{t['anchorHeader']}` | `{t['nameCol']}` | `{t['table']}` | {cols} |")
w("\nScalars on `General` row 5 (multipliers):\n")
for k, v in C["formulaPatterns"]["generalScalars"].items():
    w(f"- `General!{k}` — {v}")
w("\n### 4.2 Column formula patterns\n")
w("`{r}` = body row. These are the literal patterns to emit:\n")
w("```")
for k, v in C["formulaPatterns"]["columns"].items():
    w(f"{k:22s} {v}")
w("```")
w(f"\n- Area quantities: `{C['formulaPatterns']['sumifSourceColumns']['Floors']}`")
w(f"- Ceilings: `{C['formulaPatterns']['sumifSourceColumns']['Ceilings']}`")
w("\n### 4.3 `Main Summary`\n")
ms = C["formulaPatterns"]["mainSummaryLayout"]
w(f"Header row {ms['headerRow']}, body rows {ms['bodyRows']}. {ms['note']}\n")
w("| Row | Source |")
w("|----:|--------|")
for r, v in ms["rowToCategory"].items():
    w(f"| {r} | {v} |")
w(f"\n> **Do not replicate the reference's bug:** {ms['knownBug']}\n")
w("\n### 4.4 BOM sheets\n")
bs = C["formulaPatterns"]["bomSheetLayout"]
w(f"Header row {bs['headerRow']}, body starts row {bs['bodyStartRow']}. "
  f"**Exception:** {bs['exception']}\n")
w("Body row counts: " + ", ".join(f"`{k}` = {v}" for k, v in bs["bodyRowCounts"].items()) + ".\n")

fi = C["furnitureInventory"]
w("\n## 5. `Furniture Inventory`\n")
w(f"Header row {fi['headerRow']}, columns {', '.join('`'+c+'`' for c in fi['headerCols'])} = "
  + ", ".join(f"*{h}*" for h in fi["headers"]) + ".\n")
w(f"Body rows **{fi['bodyRows'][0]}–{fi['bodyRows'][1]}** ({fi['bodyRowCount']} rows).\n")
w(f"- Total Price column `{fi['totalColumn']}` is **`{fi['totalColumnFormula']}`** on every row — G2 enforces this.\n")
w(f"- {fi['seedValues']['note']}\n- Unit Price seeds to `{fi['unitPriceSeed']}`.\n")
idf = fi["itemDescriptionFormat"]
w(f"\n### Item Description format\n```\n{idf['composition']}\nregex: {idf['pattern']}\n```\n")
w("Examples: " + ", ".join(f"`{e}`" for e in idf["examples"]) + ".\n")
w(f"\n{idf['distinctCount']} distinct descriptions; **{idf['conformingPct']}%** match the canonical "
  f"regex. The {len(idf['nonConforming'])} that do not are supplier product names carried through "
  f"verbatim: " + ", ".join(f"`{repr(x)}`" for x in idf["nonConforming"]) + ". "
  "DSource should emit **100% canonical** — the outliers are data entry, not a format.\n")

fs = C["furnitureInventorySummary"]
w("\n## 6. `Furniture Inventory Summary`\n")
w(f"Header row {fs['headerRow']}, columns {', '.join('`'+c+'`' for c in fs['headerCols'])} = "
  + ", ".join(f"*{h}*" for h in fs["headers"]) + ".\n")
w(f"Body rows **{fs['bodyRows'][0]}–{fs['bodyRows'][1]}** ({fs['bodyRowCount']} rows). "
  f"Total column `{fs['totalColumn']}` = **`{fs['totalColumnFormula']}`**.\n")
w(f"Sort order: {fs['sortOrder']}.\n")

iv = C["inventorySheet"]
w("\n## 7. `Inventory` — the room schedule\n")
w(f"Header row {iv['headerRow']}, columns {', '.join('`'+c+'`' for c in iv['headerCols'])} = "
  + ", ".join(f"*{h.strip()}*" for h in iv["headers"]) + ".\n")
w(f"> {iv['headerNote']}\n")
w(f"\nBody rows **{iv['bodyRows'][0]}–{iv['bodyRows'][1]}** = **{iv['roomCount']} rooms**, "
  f"and exactly **{iv['thumbnailAnchoring']['count']} thumbnails** — one per room.\n")
w("\n### Per-row thumbnail anchoring (gate G5)\n")
ta = iv["thumbnailAnchoring"]
w(f"- Column **{ta['column']}**, image **{ta['pxSize'][0]}x{ta['pxSize'][1]}** px "
  f"(`ext` cx={ta['extEmu']['cx']} cy={ta['extEmu']['cy']} EMU).\n")
w(f"- Anchor: {ta['anchorKind']}.\n")
w(f"- Row height **{iv['rowHeight']}** pt on every body row; column B width **{iv['colBWidth']}**.\n")
w("\n### Area conversion\n")
ac = iv["areaConversion"]
w(f"- Observed factor: **{ac['observedFactor']}** — {ac['evidence']}\n")
w(f"- {ac['warning']}\n")
w(f"\n`Furniture Elements` format: `{iv['furnitureElementsFormat']}`\n")

w("\n## 8. `General` and `dropdowns`\n")
gs = C["generalSheet"]
w(f"`General`: scalars row {gs['scalarValueRow']} (headers row {gs['scalarHeaderRow']}), "
  f"category bands row {gs['categoryBandRow']} (merged: "
  + ", ".join(f"`{m}`" for m in sorted(gs["mergedCategoryBands"])) + "), "
  f"table headers row {gs['tableHeaderRow']}, body from row {gs['tableBodyStartRow']}.\n")
w("\n### Data validations — all three live on `General`\n")
w("| Type | List | Applied to |")
w("|------|------|-----------|")
for dv in gs["dataValidations"]:
    w(f"| {dv['type']} | `{dv['formula1']}` | {', '.join('`'+r+'`' for r in dv['ranges'])} |")
ds = C["dropdownsSheet"]
w(f"\n### `dropdowns` lists (header row {ds['headerRow']})\n")
w("| Column | Header | Members |")
w("|--------|--------|---------|")
for k, v in ds["lists"].items():
    col, name = k.split("_", 1)
    w(f"| `{col}` | {name} | " + ", ".join(f"`{x}`" for x in v) + " |")
w(f"\n> {ds['validationWiring']['note']}\n")
w(f"\n**Recommendation:** {ds['recommendation']}\n")

w("\n## 9. What DSource already has vs what must be added\n")
w("`web/src/export/takeoff.ts` (605 lines) is a **deliberately consolidated 4-sheet** takeoff. "
  "Its header comment argues the other 8 sheets are \"machinery, not content\". "
  "**That premise is what this deliverable reverses** — the machinery *is* the product, because "
  "it is what makes the workbook a live cost model a client can edit.\n")
w("\n| Reference sheet | In `takeoff.ts` today | Work |")
w("|-----------------|----------------------|------|")
rows = [
    ("Plan", "absent", "**new** — embed 1040x780 plan PNG + 7-row legend block"),
    ("Furniture Inventory", "present, 9 cols verbatim", "add `=H{r}*I{r}` formula (currently a baked number)"),
    ("Furniture Inventory Summary", "present as *Furniture Summary*", "**rename**; add `=E{r}*F{r}`"),
    ("Inventory", "absent", "**new** — 13-col room schedule + 31 per-row 240x180 thumbnails"),
    ("General", "absent", "**new** — scalars + 5 lookup tables + 3 validations"),
    ("Main Summary", "present, 2-col totals only", "**replace** with the 8-col 11-row formula-wired grid"),
    ("BOM - Floors", "absent", "**new** — VLOOKUP/SUMIF against General"),
    ("BOM - Ceilings", "absent", "**new**"),
    ("BOM - Glass Partitions", "absent", "**new** (note the row-5 header offset)"),
    ("BOM - Doors", "absent", "**new**"),
    ("BOM - Walls", "collapsed into *Wall Schedule*", "**split out**; re-wire to General"),
    ("dropdowns", "absent", "**new** — 6 lists"),
]
for a, b, c in rows:
    w(f"| `{a}` | {b} | {c} |")
w("\n### Blocking capability gaps in the current XLSX writer\n")
w("`takeoff.ts` hand-writes OOXML (`sheetXml`/`takeoffToXlsx`) and emits **only** "
  "`inlineStr` and numeric cells. To hit parity it must also gain:\n")
w("1. **Formula cells** — `<c><f>…</f></c>`. Nothing in the writer emits `<f>` today.\n"
  "2. **Image embedding** — `xl/media/*`, `xl/drawings/drawing{n}.xml`, drawing rels, "
  "`[Content_Types]` overrides for png/jpeg. Currently no drawing layer at all.\n"
  "3. **`sheetView showGridLines=\"0\"`** — currently every sheet ships with gridlines on.\n"
  "4. **Column widths / row heights** (`<cols>`, `<row ht=…>`) — needed for the 180pt "
  "thumbnail rows and the 70-wide column B.\n"
  "5. **Merged cells** (`<mergeCells>`) — the legend header and `General`'s 5 category bands.\n"
  "6. **Data validation** (`<dataValidations>`).\n"
  "7. **Solid fills in `styles.xml`** — the palette currently has 2 fills and no colours.\n")
w("\nThese are additive to the existing `zipStore`/`esc`/`cellXml` scaffolding — extend "
  "`takeoff.ts`, do not fork it (`.claude/rules/no-bloat.md`).\n")

w("\n## 10. Gate coverage\n")
w("| Gate | Enforces | Script |")
w("|------|----------|--------|")
for gid, what, sc in [
    ("G1", "12 sheets in order, gridlines off, logos, plan images, legend strings", "`g1-sheet-structure.py`"),
    ("G2", "≥90% formula body + `=H*I` totals + **live LibreOffice recalc**", "`g2-formula-liveness.py`"),
    ("G3", "walls ±1cm, exact doors, areas ±0.01, sqf factor, 1:1 plan labels", "`g3-quantity-truth.py`"),
    ("G4", "plan dims, circulation %, wall hues, legend chips == palette, determinism", "`g4-plan-graphic.py`"),
    ("G5", "one 240x180 thumbnail per room in column B, no duplicates", "`g5-thumbnails.py`"),
    ("G6", "4 stills ≥1920x1080, floor hue matches Inventory material, luminance", "`g6-renders.py`"),
    ("G7", "h264 1920x1080 ≥30fps 30–45s, distinct frames, branding", "`g7-video.py`"),
    ("G8", "`/share/:planId` 200, WebGL canvas paints, walk mode toggles", "`g8-web-viewer.mjs`"),
    ("G9", "opens in LibreOffice with zero repair warnings, 3 inputs x G1–G5", "`g9-roundtrip.py`"),
    ("G10", "one click → xlsx + 4 renders + mp4 + share link", "`g10-one-action.mjs`"),
]:
    w(f"| **{gid}** | {what} | {sc} |")
w("\n```bash\nbash scripts/gates/run-all.sh          # scoreboard, non-zero if any red\nVERBOSE=1 bash scripts/gates/run-all.sh\nbash scripts/gates/run-all.sh G1 G2    # subset\n```\n")
w("\nArtifact contract (gate defaults):\n")
w("```\nout/quantity-takeoff.xlsx     out/plan.png          out/renders/{Reception,Open_space,Work_stations,Conference_room}.png\n"
  "out/ground-truth.json         out/plan.repeat.png   out/walkthrough.mp4\n"
  "out/share.json                out/cases/{seeded,dwg,testfit}/…   (G9)\n```\n")

open(MD, "w").write("\n".join(L) + "\n")
print("wrote", MD, len("\n".join(L)), "chars")
