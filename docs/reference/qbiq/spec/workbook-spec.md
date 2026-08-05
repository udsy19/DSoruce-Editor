# qbiq Quantity Takeoff — workbook specification

Machine-generated from the real reference file. **Do not hand-edit** — regenerate with:

```bash
python3 scripts/gates/lib/extract_workbook_spec.py   # structure + media + every formula
python3 scripts/gates/lib/extract_contract.py         # the generalized contract block
```

- Source: `Quantity Takeoff - Formal - modern.xlsx` (358,003 bytes)
- Machine-readable form: [`workbook-spec.json`](workbook-spec.json)
- Shared colour truth: [`palette.json`](palette.json)
- Generator output contract: [`ground-truth.schema.json`](ground-truth.schema.json)


## 1. Sheets — exact names and order

The 12-sheet order below was **verified against the real file** and matches `workbook-spec.provided.json`. Gate **G1** enforces it exactly.

| # | Sheet | Used range | Rows | Cols | Gridlines | Images | Validations |
|--:|-------|-----------|-----:|-----:|-----------|-------:|------------:|
| 1 | `Plan` | A1:S60 | 60 | 19 | **off** | 2 | 0 |
| 2 | `Furniture Inventory` | A1:BR79 | 79 | 70 | **off** | 1 | 0 |
| 3 | `Furniture Inventory Summary` | A1:BO37 | 37 | 67 | **off** | 1 | 0 |
| 4 | `Inventory` | A1:Z78 | 78 | 26 | **off** | 32 | 0 |
| 5 | `General` | A1:Y37 | 37 | 25 | **off** | 1 | 3 |
| 6 | `Main Summary` | A1:J15 | 15 | 10 | **off** | 1 | 0 |
| 7 | `BOM - Floors` | A1:J10 | 10 | 10 | **off** | 1 | 0 |
| 8 | `BOM - Ceilings` | A1:J10 | 10 | 10 | **off** | 1 | 0 |
| 9 | `BOM - Glass Partitions` | A1:J10 | 10 | 10 | **off** | 1 | 0 |
| 10 | `BOM - Doors` | A1:J10 | 10 | 10 | **off** | 1 | 0 |
| 11 | `BOM - Walls` | A1:J10 | 10 | 10 | **off** | 1 | 0 |
| 12 | `dropdowns` | A1:F100 | 100 | 6 | **off** | 0 | 0 |

Gridlines are **off on all 12 sheets**. Every sheet except `dropdowns` carries the logo.


## 2. Embedded media

`34` files in `xl/media/`, all extracted to [`media/`](media/).

| Role | File | Format | Pixels | Bytes | Where |
|------|------|--------|--------|------:|-------|
| **Master plan** | `image1.png` | PNG RGBA | **1040x780** | 118,219 | `Plan!A1:M37` |
| Logo (Plan) | `image1.jpeg` | JPEG | 199x92 | 7,285 | `Plan!B2` |
| Logo (data sheets) | `image2.jpeg` | JPEG | 181x83 | 6,242 | `B2` on 9 sheets, `B3` on BOM - Glass Partitions |
| Room thumbnails | `image2.png` … `image32.png` | PNG RGBA | **240x180** x31 | 763–11,171 | `Inventory!B5:B35`, one per row |

> **The provided spec got this wrong.** It reports `image1.jpeg` as the logo on every data sheet and `image1.png` as every Inventory thumbnail, because openpyxl renumbers image references per drawing part. There are in fact **two distinct logo JPEGs** (`image1.jpeg` 199x92 for Plan, `image2.jpeg` 181x83 elsewhere) and **31 distinct thumbnails**. Building from the provided names would embed one image everywhere.


## 3. `Plan` sheet
### 3.1 Master plan image

- Media `image1.png`, **1040x780** px, two-cell anchor `A1` → `M37`.

- Opaque bounding box: `[3, 433, 1011, 755]` = **1008x322**.

- The PNG canvas is 1040x780 but the drawn plate occupies only the lower band (bbox above); 71% of the canvas is fully transparent. Area-ratio gates must normalise against the OPAQUE BBOX, not the canvas.


### 3.2 Wall-type legend block

Header `Q4` = `"Wall type"`, merged `Q4:R4`, fill `#0B67F9`, font `#FFFFFF` at 10pt.

| Chip cell | Chip fill | Label cell | Label string | Label fill |
|-----------|-----------|------------|--------------|------------|
| `Q5` | `#FFDC60` | `R5` | `Drywall` | `#FCF5F2` |
| `Q6` | `#72BDA1` | `R6` | `Half Drywall` | `#FCF5F2` |
| `Q7` | `#77DBF1` | `R7` | `Glass` | `#FCF5F2` |
| `Q8` | `#D5BDD6` | `R8` | `Core` | `#FCF5F2` |
| `Q9` | `#DCDBEE` | `R9` | `Perimeter windows` | `#FCF5F2` |
| `Q10` | `#AEB6FF` | `R10` | `Perimeter wall` | `#FCF5F2` |
| `Q11` | `#FFC393` | `R11` | `Door_length` | `#FCF5F2` |

All seven label strings are enforced by **G1**; the chip fills are enforced against `palette.json` by **G4**.


### 3.3 Plan PNG pixel palette (counted, not eyeballed)

| Element | Value | Pixels |
|---------|-------|-------:|
| Circulation | `rgba(255,0,0,25)` → **`#FFE6E6`** on white | 41,726 (**12.86%** of plate) |
| Drywall | `#FFDC60` | 3,811 |
| Glass | `#77DBF1` | 1,245 |
| Perimeter Windows | `#DCDBEE` | 5,999 |
| Perimeter Wall | `#AEB6FF` | 236 |
| Door Swing | `#FFC393` | 570 |
| Core | `#A0A0A0` | 8,640 |
| Half Drywall | `#72BDA1` | 0 |
| Roomlabeltext | `#000000` | 2,346 |

> **Reference inconsistency:** The PLAN draws core as #A0A0A0 but the LEGEND chip Q8 is #D5BDD6. The reference is internally inconsistent here; DSource should use ONE value for both (palette.json.plan.core).


## 4. Formula wiring — the part that matters

Every body cell except one is a formula. Change a unit price in `General` and the whole workbook moves. Reproducing the *strings* is not enough — the **ranges must be literal and identical**, which is what makes it recalculate in Excel and LibreOffice. Gate **G2** proves liveness by actually recalculating through headless LibreOffice.


### 4.1 `General` is the single lookup source

| Category | Band header | Name column | Lookup table | Cols (id / unit / len / price) |
|----------|-------------|-------------|--------------|-------------------------------|
| Floors | `'General'!$B$7` | `'General'!B{9..10}` | `'General'!$B$9:$E$10` | 2 / 3 / - / 4 |
| Ceilings | `'General'!$F$7` | `'General'!F{9..10}` | `'General'!$F$9:$I$10` | 2 / 3 / - / 4 |
| Walls | `'General'!$J$7` | `'General'!J{9..12}` | `'General'!$J$9:$N$12` | 2 / 4 / 3 / 5 |
| Glass Partitions | `'General'!$O$7` | `'General'!O{9}` | `'General'!$O$9:$S$9` | 2 / 4 / 3 / 5 |
| Doors | `'General'!$T$7` | `'General'!T{9..10}` | `'General'!$T$9:$X$10` | 2 / 3 / 4 / 5 |

Scalars on `General` row 5 (multipliers):

- `General!B5` — Floor Height (400)
- `General!D5` — Ceiling Height (3) — MULTIPLIER for wall area
- `General!F5` — Door Height (2.1)
- `General!H5` — Glass Partition Height (2.98) — MULTIPLIER for glass area
- `General!J5` — Glass Plaster Wall Height (1)

### 4.2 Column formula patterns

`{r}` = body row. These are the literal patterns to emit:

```
B_materialCategory     =IF(ISBLANK(C{r}),"",{anchorHeader})
C_materialName         ={nameCol}
D_materialId           =IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{idCol},FALSE))
E_unitType             =IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{unitCol},FALSE))
F_quantity_AREA        =ROUND(IF(ISBLANK(C{r}),"",SUMIF('Inventory'!${col}1:${col}78,$C{r},'Inventory'!$K1:$K78)),2)
F_quantity_LINEAR      =ROUND(IF(ISBLANK(C{r}),"",'General'!$D$5*(VLOOKUP(C{r},{table},{lengthCol},FALSE))),2)
F_quantity_GLASS       =ROUND(IF(ISBLANK(C{r}),"",'General'!$H$5*(VLOOKUP(C{r},{table},{lengthCol},FALSE))),2)
F_quantity_COUNT       =IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{amountCol},FALSE))
G_quantityAmount       LITERAL 0 (user override slot — the ONLY hardcoded body cell)
H_unitPrice            =IF(ISBLANK(C{r}),"",VLOOKUP(C{r},{table},{priceCol},FALSE))
I_totalCost_AREA       =IF(ISBLANK(C{r}),"",H{r}*G{r})
I_totalCost_LINEAR     =IF(ISBLANK(C{r}),"",H{r}*F{r})
```

- Area quantities: `Inventory!$L (Floor Material) summed over Inventory!$K (Area sqf)`
- Ceilings: `Inventory!$M (Ceiling Material) summed over Inventory!$K (Area sqf)`

### 4.3 `Main Summary`

Header row 4, body rows 5..15 (11 rows). Main Summary is the UNION of the five BOM sheets' body rows, in Floors→Ceilings→Walls→Glass→Doors order, with identical formulas.

| Row | Source |
|----:|--------|
| 5 | Floors / General!B9 |
| 6 | Floors / General!B10 |
| 7 | Ceilings / General!F9 |
| 8 | Ceilings / General!F10 |
| 9 | Walls / General!J9 |
| 10 | Walls / General!J10 |
| 11 | Walls / General!J11 |
| 12 | Walls / General!J12 |
| 13 | Glass Partitions / General!O9 |
| 14 | Doors / General!T9 |
| 15 | Doors / General!T10 |

> **Do not replicate the reference's bug:** B7/B9/B14 reference C5 and B8/B10/B13/B15 reference C6 instead of their own row's C — a copy-paste slip in the reference. Do NOT replicate; emit '=IF(ISBLANK(C{r}),"",...)' consistently.


### 4.4 BOM sheets

Header row 4, body starts row 5. **Exception:** 'BOM - Glass Partitions' has headerRow=5, bodyStartRow=6 (shifted one row).

Body row counts: `BOM - Floors` = 2, `BOM - Ceilings` = 2, `BOM - Walls` = 4, `BOM - Doors` = 2, `BOM - Glass Partitions` = 1.


## 5. `Furniture Inventory`

Header row 4, columns `B`, `C`, `D`, `E`, `F`, `G`, `H`, `I`, `J` = *Cost Code*, *Floor*, *Room ID*, *Room Type*, *Item Description*, *Supplier*, *Quantity*, *Unit Price*, *Total Price*.

Body rows **5–79** (75 rows).

- Total Price column `J` is **`=H{r}*I{r}`** on every row — G2 enforces this.

- Cost Code and Supplier are written ONCE on the first body row only.
- Unit Price seeds to `0`.


### Item Description format
```
'{Label} {CatalogFamily} W{width_cm} X L{length_cm}' — W is the SHORTER side, L the LONGER; both integer centimetres.
regex: ^(?P<name>.+?) W(?P<w_cm>\d+) X L(?P<l_cm>\d+)$
```

Examples: `Desk Table W70 X L140`, `Conference Chairs W58 X L55`, `Coffee Table Table W40 X L40`, `Low Storage Storage W30 X L100`.


33 distinct descriptions; **88.0%** match the canonical regex. The 2 that do not are supplier product names carried through verbatim: `'Portico W 1400 x D 700 mm'`, `'Vicarrbe Season S Sofa\ntable\n'`. DSource should emit **100% canonical** — the outliers are data entry, not a format.


## 6. `Furniture Inventory Summary`

Header row 4, columns `B`, `C`, `D`, `E`, `F`, `G` = *Cost Code*, *Item Description*, *Supplier*, *Quantity*, *Unit Price*, *Total Price*.

Body rows **5–37** (33 rows). Total column `G` = **`=E{r}*F{r}`**.

Sort order: Item Description, case-sensitive ASCII ascending (lowercase 'printer' sorts LAST).


## 7. `Inventory` — the room schedule

Header row 4, columns `B`, `C`, `D`, `E`, `F`, `G`, `H`, `I`, `J`, `K`, `L`, `M`, `N` = *Room Image*, *Floor*, *Department*, *Space Type*, *Subcategory*, *Room ID*, *Program Room Name*, *Headcount*, *Area (m2)*, *Area (sqf)*, *Floor Material*, *Ceiling Material*, *Furniture Elements*.

> B4 is 'Room Image ' WITH a trailing space in the reference.


Body rows **5–35** = **31 rooms**, and exactly **31 thumbnails** — one per room.


### Per-row thumbnail anchoring (gate G5)

- Column **B**, image **240x180** px (`ext` cx=2286000 cy=1714500 EMU).

- Anchor: twoCellAnchor, from=B{r} offset 0/0, to=B{r} offset cx/cy (i.e. fully contained in the single cell B{r}).

- Row height **180.0** pt on every body row; column B width **70.0**.


### Area conversion

- Observed factor: **10.76** — J5=12.58 K5=135.3608 (12.58*10.76=135.3608 exactly); J7=25.53 K7=274.7028 (25.53*10.76=274.7028 exactly)

- The true m2->sqft factor is 10.7639. The reference workbook uses a rounded 10.76. DSource must pick ONE; gates default to 10.7639 and expose --sqf-factor to re-check against the reference.


`Furniture Elements` format: `'{Item Description}: {qty}, {Item Description}: {qty}' (comma+space separated; blank when the room has no furniture)`


## 8. `General` and `dropdowns`

`General`: scalars row 5 (headers row 4), category bands row 7 (merged: `B7:E7`, `F7:I7`, `J7:N7`, `O7:S7`, `T7:X7`), table headers row 8, body from row 9.


### Data validations — all three live on `General`

| Type | List | Applied to |
|------|------|-----------|
| list | `"cm,m,f,inch"` | `M9:M12`, `K3`, `C3`, `G3`, `E3`, `I3`, `R9` |
| list | `"cm^2,m^2,f^2,inch^2"` | `D9:D10`, `H9:H10` |
| list | `"Number"` | `V9:V10` |

### `dropdowns` lists (header row 1)

| Column | Header | Members |
|--------|--------|---------|
| `A` | MaterialCategory | `Floors`, `Ceilings`, `Walls`, `Doors` |
| `B` | LengthUnitType | `cm`, `m`, `f`, `inch` |
| `C` | AreaUnitType | `cm^2`, `m^2`, `f^2`, `inch^2` |
| `D` | VolumeUnitType | `cm^3`, `m^3`, `f^3`, `inch^3` |
| `E` | GeneralUnitType | `Number` |
| `F` | units | `cm`, `m`, `feet`, `inch` |

> The reference does NOT reference this sheet by range. The three data validations all live on 'General' and use INLINE literal lists whose members mirror these columns.


**Recommendation:** DSource SHOULD wire validations to 'dropdowns'!$B$2:$B$5 style ranges instead of inline literals — same UX, and the gate can verify the range.


## 9. What DSource already has vs what must be added

`web/src/export/takeoff.ts` (605 lines) is a **deliberately consolidated 4-sheet** takeoff. Its header comment argues the other 8 sheets are "machinery, not content". **That premise is what this deliverable reverses** — the machinery *is* the product, because it is what makes the workbook a live cost model a client can edit.


| Reference sheet | In `takeoff.ts` today | Work |
|-----------------|----------------------|------|
| `Plan` | absent | **new** — embed 1040x780 plan PNG + 7-row legend block |
| `Furniture Inventory` | present, 9 cols verbatim | add `=H{r}*I{r}` formula (currently a baked number) |
| `Furniture Inventory Summary` | present as *Furniture Summary* | **rename**; add `=E{r}*F{r}` |
| `Inventory` | absent | **new** — 13-col room schedule + 31 per-row 240x180 thumbnails |
| `General` | absent | **new** — scalars + 5 lookup tables + 3 validations |
| `Main Summary` | present, 2-col totals only | **replace** with the 8-col 11-row formula-wired grid |
| `BOM - Floors` | absent | **new** — VLOOKUP/SUMIF against General |
| `BOM - Ceilings` | absent | **new** |
| `BOM - Glass Partitions` | absent | **new** (note the row-5 header offset) |
| `BOM - Doors` | absent | **new** |
| `BOM - Walls` | collapsed into *Wall Schedule* | **split out**; re-wire to General |
| `dropdowns` | absent | **new** — 6 lists |

### XLSX writer capabilities parity requires — ALL IMPLEMENTED

This section was originally a gap analysis: `takeoff.ts` hand-wrote OOXML and emitted **only** `inlineStr` and numeric cells. All seven gaps are now closed in `web/src/export/workbook.ts` (`buildXlsx`), and `takeoff.ts` was migrated onto it with its inline OOXML layer deleted, so no duplicate xlsx path remains:

1. **Formula cells** — `<c><f>…</f></c>`, with `fullCalcOnLoad` so cached values are unneeded.
2. **Image embedding** — `xl/media/*`, `xl/drawings/drawing{n}.xml`, drawing rels, `[Content_Types]` overrides. two/oneCellAnchor with EMU offsets.
3. **`sheetView showGridLines="0"`** per sheet.
4. **Column widths / row heights** (`<cols>`, `<row ht=…>`) — the 140pt thumbnail rows.
5. **Merged cells** (`<mergeCells>`) — the legend header and `General`'s 5 category bands.
6. **Data validation** (`<dataValidations>`) against the `dropdowns` sheet ranges.
7. **Solid ARGB fills in `styles.xml`** — the legend chips match `palette.json` byte-exactly.


One trap worth keeping in mind: a twoCellAnchor's extent must NOT be derived from `to.colOff - from.colOff` unless the anchor starts and ends in the same cell — across cells that omits every intervening column and collapses the image (the 1040x780 plan rendered as a ~19x3 px smudge, invisibly to every structural gate). Cross-cell anchors size from the image's intrinsic pixels.


## 10. Gate coverage

| Gate | Enforces | Script |
|------|----------|--------|
| **G1** | 12 sheets in order, gridlines off, logos, plan images, legend strings | `g1-sheet-structure.py` |
| **G2** | ≥90% formula body + `=H*I` totals + **live LibreOffice recalc** | `g2-formula-liveness.py` |
| **G3** | walls ±1cm, exact doors, areas ±0.01, sqf factor, 1:1 plan labels | `g3-quantity-truth.py` |
| **G4** | plan dims, circulation %, wall hues, legend chips == palette, determinism | `g4-plan-graphic.py` |
| **G5** | one 240x180 thumbnail per room in column B, no duplicates | `g5-thumbnails.py` |
| **G6** | 4 stills ≥1920x1080, floor hue matches Inventory material, luminance | `g6-renders.py` |
| **G7** | h264 1920x1080 ≥30fps 30–45s, distinct frames, branding | `g7-video.py` |
| **G8** | `/share/:planId` 200, WebGL canvas paints, walk mode toggles | `g8-web-viewer.mjs` |
| **G9** | opens in LibreOffice with zero repair warnings, 3 inputs x G1–G5 | `g9-roundtrip.py` |
| **G10** | one click → xlsx + 4 renders + mp4 + share link | `g10-one-action.mjs` |

```bash
bash scripts/gates/run-all.sh          # scoreboard, non-zero if any red
VERBOSE=1 bash scripts/gates/run-all.sh
bash scripts/gates/run-all.sh G1 G2    # subset
```


Artifact contract (gate defaults):

```
out/quantity-takeoff.xlsx     out/plan.png          out/renders/{Reception,Open_space,Work_stations,Conference_room}.png
out/ground-truth.json         out/plan.repeat.png   out/walkthrough.mp4
out/share.json                out/cases/{seeded,dwg,testfit}/…   (G9)
```

