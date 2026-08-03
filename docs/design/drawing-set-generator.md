# Drawing-Set Generator — Design + Research

Status: **design target**, not yet built. Trigger: turn a finished test-fit into a professional,
multi-sheet architectural drawing set that matches the quality bar of Rayon / Studio-Nova output.

**Code anchors:** `web/src/export/` — sheet composition `sheet.ts`, set assembly `sheetSet.ts`,
sheet index `sheetManifest.ts`, sections `section.ts` (+ `web/src/three/sectionRender.ts`), services
sheets `services.ts` / `servicesSheets.ts`, finish schedule `finishSchedule.ts`, quantity takeoff
`takeoff.ts` (`buildTakeoffModel`), report model `report.ts` (`buildReportModel`), and the emitters
`pdf.ts`, `dxf.ts`, `png.ts`, `ifc.ts`, `obj.ts`, `zip.ts`.

## What "the bar" looks like (grounded in two real deliverables)

Two Rayon-lineage sets were studied page-by-page and are the reference throughout:

- **`Cafe Drawing Set Template.pdf`** — a full ~10-sheet interior set, A3 landscape, sheets numbered
  **A.01–A.10** with a **Studio-Nova / "Rust Coffee & Co"** title block on every sheet.
- **`10-Seat office pack.pdf`** — the same discipline at *room* scale, with the **Rayon** title
  block ("The collaborative space design software"), portrait drawing tiles ganged on a landscape
  frame.

The one-sentence diagnosis of the gap (echoing `testfit-pro-quality.md`): **we today emit ONE
plan sheet + a comparison report; a professional set is a sequenced book of specialised sheets —
cover, contents, a family of *purpose-filtered* plans (demolition / construction / lighting / RCP),
sections & elevations with scale figures, construction & millwork details, product-card schedules,
and a moodboard — every one wearing the same title block with a key plan.** We already own most of
the *data* for that book; what's missing is the *sheet vocabulary* and a few genuinely-new renders.

---

## 1. Sheet-type catalogue

Each sheet type below is grounded in a specific page of the two reference PDFs. "Annotations" lists
the conventions a viewer reads the sheet by — these are the acceptance details that separate "looks
like Rayon" from "looks like a screenshot."

### 1.0 Title block + Key Plan (on **every** sheet)

The spine of the whole set. Studio-Nova anatomy (Cafe set, bottom band of A.01–A.07):

- **Studio logo** bottom-left ("RUST COFFEE & CO") + "Your business address here".
- **Key Plan** — a *miniature of the whole floor plan* with **this sheet's area filled solid blue**
  and the rest shown as light hatch, so a reader knows which part of the building the sheet covers.
- **Notes** — a ruled writing area (empty lines).
- **Client: / Project: / Revision: / Date:** (e.g. `Date: 28/1/26`).
- **Drawing Title:** (e.g. "Sections", "Demolition Plan"), **Drawn by:** (Ayse B.), **Approved by:**
  (Shira N.), **Scale:** (`1:60`, `1:75`, `1:50`, `1:25`, `1:5` — *per sheet*, not global).
- **Sheet number** big at bottom-right: `A.01` … `A.10`.

Rayon variant (office pack): a single-row strip block — `PROJECT NOTES · CLIENT · PROJECT ADRESS ·
SIGNATURE/STAMP · TEMPLATE|12 PEOPLE MEETING ROOM · MADE BY: Rayon · DATE · SCALE: NO SCALE ·
PROJECT NO: P001 · DRAWING NO: A01`, Rayon logo + contact bottom-right. Same fields, flatter layout.

**Convention:** the title block is *identical furniture on every sheet* except Drawing Title, Scale,
Key-Plan highlight, and sheet number. That invariance is what makes a stack of pages read as "a set."

### 1.1 Cover

Cafe cover: a **full-bleed hero photo** (interior render) on the left ~60%, a **translucent white
panel** on the right carrying the **project name** ("Cafe' Rust"), a **subtitle/tagline** ("A
Contemporary Space with a Bold Spirit"), **studio + date** ("Architecture & Interior Concept
Presentation / Studio Nova | 28/01/2026"), and a **concept blurb** paragraph. Studio logo bottom-left.

- **Annotations:** no drawing chrome; this is a marketing page. Typography-led. One hero image, one
  headline, one paragraph.

### 1.2 Table of Contents / Legend

Cafe TOC: hero photo left, a **right-hand list of sheets** each with **dotted leader → sheet number**
(`Sections … A.01`, `Demolition Plan … A.02`, `Construction & Furnishing Plan … A.03`, `Lighting
Plan … A.04`, `Design Details … A.05`, `Staircase Millwork … A.06`, `Bathroom Millwork … A.07`,
`Furniture and Fixtures … A.08`, `Lighting Fixtures … A.09`, `Material Choices … A.10`). A companion
"Technical Plan" legend page enumerates the same 9 drawings + a one-line spec of each.

- **Annotations:** dotted-leader list, grouped with subtle gaps; sheet numbers right-aligned.

### 1.3 Plan family (four filtered views of the SAME plan)

The single most important insight: **demolition / construction / lighting / RCP are not four drawings
— they are one plan drawn four times with different layers turned on.** Each still carries dims, room
labels, section marks, and its own legend.

**(a) Demolition Plan** (Cafe A.02, `1:75`):
- **Existing walls** = solid grey poché; **Demolished walls** = **red/magenta cross-hatch** overlay.
- Room labels **ROOM 01–05** with **m² areas** + floor-finish notes ("Floor to be Demolish diagonal
  Tiles 30x30cm"; "15x15 cm white tiles for ROOM 5").
- Dimension strings around the perimeter; door swings; section marks (A, B triangular flags).
- **Legend box:** Existing walls / Demolished walls / Square tiles 15×15 / Diagonal tiles 30×30.

**(b) Construction & Furnishing Plan** (Cafe A.03, `1:75`):
- **Existing walls** grey; **New walls** highlighted **blue**; **Furniture layout** in blue linework.
- **Door / window / floor TAGS**: `D01` in a circle, `W1` in a hexagon, `03` in a triangle (floor tag).
- **"Doors and windows specifications" schedule** beside the plan: one row per tag —
  `W1 Window 2.250 × 1.500 +0.80`, `D01 Door 2.200 × 800 × 24  Painted wood frame`, etc.
  (dimensions + sill height + material).
- **Legend:** Existing walls / New walls / Furniture layout / tag glyphs.

**(c) Lighting Plan / RCP** (Cafe A.04 `1:75`; office pack "Reflected Ceiling" D 1.3 `1:50`):
- Ceiling-mounted fixtures distributed on a grid; **dashed switch-leg curves** from switch → fixture.
- **Ceiling-height** note (office pack: `2.75 m`), light-spacing dimension strings.
- **Big symbol legend:** Ceiling lamp / Pendant / Suspended light / Motion sensor / Track lights /
  Recessed wall light / Plafond lamp / Spotlight / HVAC vent.

**(d) Electrical Layout** (office pack D 1.2, `1:50`):
- **Outlet / floor-box symbols** with `x2 / x4 / x6` count multipliers.
- **Legend:** Double outlet / Built-in box (3 outlets + 1 USB) / Recessed outlets in a floor box /
  TV socket / RJ-45 / router socket / switch / double switch.

**Shared plan annotations across (a)–(d):** dimension strings on the perimeter, room labels + areas,
section-cut marks, north/entry flag, and a per-sheet legend.

### 1.4 Sections & Elevations (Cafe A.01 `1:60`; office pack D 1.4 `1:40`)

- **Vertical cuts** through the space: walls in poché, floor/ceiling lines, furniture in elevation.
- **Scale-figure human silhouettes** (a standing person, a seated person) — the signature "this is
  architecture" tell.
- **Dimension strings**: widths (`4.88 m`, `3.29 m`, `0.97 m`) and **ceiling heights** (`265`, `217`,
  `48` cm; office `2.75 m`).
- **Material callout notes** with leader lines ("Wall painted in off-white color with matte
  finishing", "Wall covered in a custom wooden panel with storage space").
- **Section labels** (SECTION AA / SECTION BB, keyed to marks on the plan) + a right-column text
  description per section, and a **moodboard swatch cluster** (tile/wood circles, pendant, chair render).

### 1.5 Construction & Millwork Details (Cafe A.05 `1:5`, A.06/A.07 `1:25`)

- **A.05 Design Details:** 6 **wall-type build-up** tiles (Wall type 01–06), each a layered section
  with **numbered callout bubbles** (①②③…) → a **material spec list** ("12.5mm Gyproc Wallboard with
  3mm skim / 100×50mm C24 Timber studs / 50mm Isover Acoustic Partition Roll").
- **A.06 Staircase Millwork:** spiral-stair **section** + **plan** + a riser/going/spindle **detail**,
  annotated (steel pillar Ø200mm, Ø50mm tubular railing, wooden handrail 2"×3", balustrade Ø20 steel).
- **A.07 Bathroom Millwork:** vanity **plan + elevation + section AA + drawer detail**, detail callout
  bubbles, dimension strings, material notes (MDF white finish, side-mount slides 55cm).

- **Annotations:** callout bubbles with numbers, tight dimensions, per-detail material paragraph.
  These are the most bespoke sheets and the *least* auto-derivable (see §2).

### 1.6 Furniture & Fixtures schedule (Cafe A.08 / office "FURNITURE AND FIXTURES")

- A **grid of product cards** (8 per sheet): **product photo** (on white), **name** (LIGHTING FIXTURE
  - PLAFOND, OFFICE CHAIR, CONFERENCE DESK…), **code `#P29A4T`**, a **description** paragraph, and specs.
- **Lighting Fixtures (A.09)** is the same card format filtered to luminaires.

### 1.7 Materials / Moodboard (Cafe A.10; office "MOODBOARD")

- A **large interior render** + **cut-out product renders** (chair, plant) + a **color-swatch palette**
  column (4–5 stacked swatches) + optional **material swatches** (tile / wood circles).

---

## 2. Data mapping — what we can derive NOW vs. new work

The happy surprise: **our document model is already an architectural model, not a picture.** A placed
component is one object with geometry · category · product-binding · decision-state (CLAUDE.md), walls
carry a `generated` flag and `glazing`, zones carry type/label/area, and we already have a costed
furniture BOM and a lit 3D model. Below, every claim cites `file:line`.

### 2.1 The biggest existing-data wins (these make whole sheets nearly free)

| Sheet need | We already have | Where |
|---|---|---|
| **Demolition vs Construction split** | `DocWall.generated` — **existing/imported walls (`generated:false`) vs new generated partitions (`generated:true`)**. This *is* the demolition/new-wall distinction Studio-Nova hatches red vs blue. | `web/src/editor/EditorCanvas.ts:15-16`; already exploited by takeoff at `web/src/export/takeoff.ts:275-284` |
| **Glass fronts (window schedule, 3-line glazing)** | `DocWall.glazing` — glazed partition flag, already rendered triple-line in 2D. | `EditorCanvas.ts:17-18`; render at `EditorCanvas.ts:975`, `1212-1220` |
| **Furniture & Fixtures cards + product schedule** | `buildTakeoffModel` already produces per-room BOM rows with **supplier, unit price, W×L dims, cost code, room type** — 90% of a card's text. Bindings give the **product image, brand, supplier, price**. | `takeoff.ts:185-324` (model), `TakeoffFurnitureRow` `takeoff.ts:54-65`; `BankProduct.image/vendor/supplier/price` `web/src/materialBank/client.ts:13-21` |
| **Room / area schedule + room labels** | `ZoneStat{ label, area, capacity, seated, zone_type, pct_of_nia }` + `getZoneStats()`. Directly the "ROOM 01 — 9.70 m²" labels and any room schedule. | `EditorCanvas.ts:81-89`, `getZoneStats` at `EditorCanvas.ts:445` |
| **Title block fields** | `ProjectRecord{ name, propertyName, address, logo, floor }` + `ReportMeta{ client, project, style, address, floor, logo }`. Client / Project / Address / logo / floor all present. | `web/src/persist/projects.ts:81-96`; `ReportMeta` `web/src/export/report.ts:55-63` |
| **Colored / furnished plan raster** | `renderPrintCanvas(state,w,h)` already draws zone tints + CAD furniture symbols + true-thickness walls to a clean white canvas and returns `metersPerPx` for a real plot scale. The construction & demolition base view is a re-layer of this. | `web/src/export/pdf.ts:320-414` |
| **Door / window entities for tags + schedule** | CAD `DoorEnt{ at,width,angle,hinge,flip }`, `WindowEnt{ at,width,angle,thickness }` + generator-placed `Door` components. Doors already carry a **swing arc** in render. | `web/src/cad/model.ts:83-102`; door swing at `web/src/cad/render.ts:327`; doors as components in takeoff `takeoff.ts:290-292` |
| **Hatching for demolition** | CAD `HatchEnt{ pts, pattern:'diag'|'cross'|'solid', spacing }` — a ready cross-hatch primitive for "demolished walls." | `cad/model.ts:111-118`; rendered in `cad/render.ts` |
| **Dimension strings** | CAD `DimensionEnt{ a,b,offset,text }` already rendered (dimension line + text) — the annotation primitive sections & plans need. | `cad/model.ts:65-74`; render `cad/render.ts:192-196,257` |
| **Moodboard swatches / material palette** | Bank product images + the design's bound products → cut-out renders; zone/finish colors → palette swatches. | `client.ts:13-21` |
| **Multi-page PDF engine (RGB, images, vector text)** | `buildMultiPagePdfBytes` + `ContentOp` (text/line/rect with `gray`/`rgb`, JPEG images) + `sheetChrome` (frame, panel, footer) + `PdfPage`. Already A3 landscape at `PAGE_W/PAGE_H`. | `pdf.ts:193-247` (engine), `ContentOp` `pdf.ts:49-55`, `sheetChrome` `pdf.ts:478-531`, page size `pdf.ts:32-33` |
| **Per-page render harness (Page class, scale bar, legend)** | `report.ts` already wraps the engine in a `Page` helper with top-down coords, `text/box/line/image`, plan raster embedding, scale-bar, and zone legend — directly reusable per sheet. | `report.ts:369-421` (Page), scale bar `report.ts:679-695`, legend `report.ts:698-713` |
| **Metrics for schedules / notes** | `Metrics{ gross_external_area, net_internal_area, workstations, efficiency_pct, indicative_cost }`. | `EditorCanvas.ts:65-80` |

### 2.2 Genuinely-new work (be honest)

| New capability | Why it's new | Rough shape |
|---|---|---|
| **Orthographic section / elevation render from the 3D model** | The 3D viewer camera is a **`PerspectiveCamera`** (`Viewer3D.ts:230,450`), read-only walkthrough. Sections need an **orthographic** camera + a **cut plane** + white-line NPR styling + scale-figure people. New render path (can reuse the existing Three scene graph). | New `sectionRender(state, cutLine, dir)` → canvas → JPEG; add an OrthographicCamera; draw poché at the cut, elevation lines beyond. |
| **RCP / lighting layer + electrical symbol library** | We place `FallCeiling` and furniture, but there is **no lighting-fixture, switch, outlet, HVAC, or floor-box entity type**, and no ceiling-grid. Need a symbol set + a placement pass (or a light layout derived from zones). | New symbol glyphs (SVG/canvas) + a `ceilingLayout(zones)` that scatters fixtures on a grid; legend generator. |
| **Key-plan generator** | New: render the *whole* plate as a thumbnail with the current sheet's covered area filled. For plan sheets it's the full plate; for section sheets, the cut line + covered strip; for detail sheets, the detail's zone. | `renderKeyPlan(plate, highlightRegion)` — a tiny reuse of `renderPrintCanvas` at thumbnail size + one filled poly. |
| **Tag placement (D01 / W1 / floor tags)** | We have door/window entities but **no tag numbering or leader placement**. Need deterministic numbering (`D01…`, `W1…`) + non-overlapping tag glyph placement + the paired schedule rows. | `tagOpenings(walls, components)` → `{tag, kind, w, h, sill, material}[]`, drives both plan glyphs and the schedule table. |
| **Millwork / construction details** | Wall-type build-ups, staircase, vanity are **bespoke shop drawings** with no source in our model. Not derivable from a furniture test-fit. | Ship as a **library of parametric detail templates** (e.g. a generic "stud partition build-up" keyed to wall thickness/glazing), NOT per-project custom geometry. Lowest priority. |
| **Finish / material notes on plans** | We don't yet model floor finishes per room ("30×30 diagonal tiles"). | Optional: extend `DocZone` with a `finish` field later; until then, notes are generic per zone type. |
| **Demolition red cross-hatch styling** | The hatch primitive exists (CAD) but `renderPrintCanvas` (`pdf.ts:320`) doesn't currently hatch walls. Add a wall-hatch pass keyed on `generated`. | Extend the print renderer with a `wallStyle` param. |

**Net:** roughly **70% of the set is a re-layering / re-templating of data we already compute**; the
truly new engineering is the orthographic section render and the lighting/electrical symbol layer.

---

## 3. Architecture

### 3.1 It slots onto the existing hand-written PDF engine — no new deps

The set is just **more `PdfPage`s** through the same `buildMultiPagePdfBytes` (`pdf.ts:193`). We keep
the "no new PDF engine, no new deps" invariant that `report.ts` already honours (`report.ts:7-12`).
The `Page` helper class in `report.ts:369-421` (top-down coords, `text/box/line/image`) is promoted to
a **shared module** (`export/sheet.ts`) so every sheet builder uses one primitive set. `renderPrintCanvas`
(`pdf.ts:320`) is extended (not forked) with per-layer toggles.

### 3.2 A `SheetSpec` / template model

```
type SheetKind =
  | 'cover' | 'toc'
  | 'plan'          // parameterised by PlanLayers (see below)
  | 'section'       // parameterised by a cut line + direction
  | 'details'       // wall-type / millwork template id
  | 'furniture'     // product cards
  | 'moodboard'
  | 'schedule'      // door/window or room schedule as a full sheet

interface SheetSpec {
  kind: SheetKind
  no: string                 // 'A.01', 'A.02', …
  title: string              // 'Demolition Plan'
  scale?: string             // '1:75' — per sheet
  keyPlanRegion?: Region     // what the key plan highlights
  layers?: PlanLayers        // for kind==='plan'
  cut?: SectionCut           // for kind==='section'
  detailTemplate?: string    // for kind==='details'
}

// The plan family is ONE renderer with a layer mask:
interface PlanLayers {
  existingWalls: boolean     // generated:false
  newWalls: boolean          // generated:true, highlight blue
  demolishHatch: boolean     // red cross-hatch on removed walls
  furniture: boolean
  dims: boolean
  roomLabels: boolean        // ZoneStat.label + area
  openingTags: boolean       // D01/W1 glyphs
  lighting: boolean          // RCP fixtures + switch legs
  electrical: boolean        // outlets/floor boxes
  legend: LegendKind
}
```

A **`buildSheetSet(state, meta, opts): SheetSpec[]`** decides which sheets to emit (cover → toc →
demolition → construction → lighting → electrical → sections → furniture → moodboard), assigns
`A.0N` numbers and per-sheet scales, then each spec is dispatched to a `render<Kind>(spec, ctx)`
that returns a `PdfPage`. Same shape as `report.ts`'s `coverPage/tourPage/altPage/summaryPage`
orchestration (`report.ts:918-937`), generalised.

### 3.3 Shared components (build once, used by every sheet)

- **`titleBlock(page, spec, meta, keyPlanJpeg)`** — draws the Studio-Nova block (logo, key plan,
  Client/Project/Revision/Date, Drawing Title, Drawn/Approved, Scale, sheet no.). One function; the
  only per-sheet inputs are `title`, `scale`, `no`, and the key-plan raster.
- **`keyPlan(plate, region)`** — reuses `renderPrintCanvas` at thumbnail size + one filled highlight.
- **`planRender(state, layers)`** — the extended `renderPrintCanvas`; toggles decide which of
  {existing walls, new walls, demolish hatch, furniture, dims, tags, lighting, electrical, labels}
  draw. **This one function backs all four plan-family sheets** — the core no-bloat win.
- **`openingSchedule(state)`** — tags + rows, shared by the construction plan glyphs and the schedule.
- **`productCard(page, x, y, product, binding)`** — reused by Furniture (A.08) and Lighting (A.09).
- **`sectionRender(state, cut)`** — the new orthographic path (§2.2).

### 3.4 Scale handling

`report.ts`/`pdf.ts` already compute a true plot scale: `renderPrintCanvas` returns `metersPerPx`
(`pdf.ts:413`) and `scaleNote()` converts it to `1:N @ A3` (`pdf.ts:456-461`), plus a physical scale
bar (`report.ts:679-695`). The set generalises this so **each sheet requests a target scale** (`1:75`
plan, `1:50` room, `1:25` millwork, `1:5` detail) and the renderer sizes the drawing box to hit it,
printing the matching `Scale: 1:N` in the title block. Sections reuse the same meters→points math.

### 3.5 Where it lives / no-bloat

New file **`web/src/export/sheetSet.ts`** (orchestrator + sheet builders) + a promoted
**`web/src/export/sheet.ts`** (the `Page` helper lifted out of `report.ts` so both share it — delete
the private copy in `report.ts` in the same change per `.claude/rules/no-bloat.md`). `renderPrintCanvas`
gains a `layers`/`wallStyle` param **in place** (report.ts and pdf.ts both call it — keep the default
behaviour identical so existing single-sheet + report exports are byte-stable). No new dependencies.

---

## 4. Milestone plan (independently shippable, ordered by value-per-effort)

### M1 — Skeleton set: title block + cover + TOC + one colored plan  ·  **~S, high value**
The frame that makes everything after it read as "a set."
- Files: `export/sheet.ts` (promote `Page`), `export/sheetSet.ts` (new), `export/pdf.ts`
  (`keyPlan` helper), reuse `renderPrintCanvas` as-is, `ReportMeta`/`ProjectRecord` for fields.
- Deliver: `A.01 Cover` (hero = plan raster or bound render), `A.02 Contents` (dotted-leader list),
  `A.03 Floor Plan` (existing furnished plan + title block + key plan).
- **Acceptance:** a 3-page PDF opens with a consistent Studio-Nova title block on the plan sheet, a
  correct key plan highlight, a working `1:N` scale, and a contents list whose numbers match the sheets.

### M2 — Demolition + Construction plans + door/window schedule  ·  **~M, highest uniqueness**
The sheets we can build that competitors can't trivially, because we already carry `generated`.
- Files: `export/pdf.ts` (`renderPrintCanvas` gains `layers` + wall hatch by `generated`),
  `export/sheetSet.ts` (demolition/construction builders, `openingSchedule`, tag placement),
  reuse `DocWall.generated/glazing` (`EditorCanvas.ts:15-18`), door/window entities (`cad/model.ts:83-102`).
- Deliver: `Demolition Plan` (existing grey vs demolished/removed red cross-hatch + room labels/areas
  + demolition legend), `Construction & Furnishing Plan` (existing grey / new blue / furniture + D01/W1
  tags + "Doors and windows specifications" schedule + legend).
- **Acceptance:** on a generated test-fit, existing plate walls render grey and generated partitions
  render blue/highlighted; every door and window carries a unique tag that appears once in the plan and
  once in the schedule with its size + material.

### M3 — Furniture & Fixtures cards + Materials/Moodboard  ·  **~M, high value, low risk**
Pure reuse of takeoff + bank data; no geometry.
- Files: `export/sheetSet.ts` (`productCard`, card grid, moodboard), reuse `buildTakeoffModel`
  (`takeoff.ts:185`), `BankProduct` image/brand/supplier/price (`client.ts:13-21`), bindings map.
- Deliver: `Furniture and Fixtures` (8-card grid: image, name, `#code`, description, W×L + price),
  `Lighting Fixtures` (same filtered to luminaires), `Material Choices` (render + swatch palette).
- **Acceptance:** every bound product in the design appears as a card with its real photo, supplier,
  and INR price; unbound components fall back gracefully (spec-only, em-dash price) exactly as takeoff does.

### M4 — Sections / Elevations from the 3D model  ·  **~L, the "wow" sheet**
The signature architectural page; genuinely new render.
- Files: new `three/sectionRender.ts` (OrthographicCamera + cut plane over the existing scene graph
  from `Viewer3D`/`furniture3d`), `export/sheetSet.ts` (section sheet + material-note leaders + scale
  figures), reuse `DimensionEnt` styling for the dimension strings.
- Deliver: `Sections` sheet with ≥2 cuts (AA/BB), scale-figure people, ceiling-height + width dims,
  material-callout notes, section marks placed back on the plan sheets.
- **Acceptance:** a section cut through the plan shows walls in poché, furniture in elevation, at least
  one human figure, correct ceiling height, and its cut line is marked on the construction plan.

### M5 — Lighting / RCP + Electrical layers  ·  **~L, completes the "technical" half**
- Files: new `export/symbols.ts` (lighting/electrical/HVAC glyph library + legend generator),
  `export/sheetSet.ts` (RCP + electrical builders), a `ceilingLayout(zones)` fixture-placement pass.
- Deliver: `Lighting Plan / RCP` (fixtures on grid, switch-leg dashes, ceiling-height note, symbol
  legend) and `Electrical Layout` (outlets/floor boxes with x2/x4 multipliers + legend).
- **Acceptance:** each enclosed room shows ≥1 ceiling fixture, the legend lists every symbol used, and
  ceiling heights/spacings carry dimensions.

*(Millwork/construction-detail sheets (Cafe A.05–A.07) are explicitly deferred to a later "detail
template library" milestone — they are bespoke shop drawings with no source in a furniture test-fit,
so they'd be templated stock details, lowest value-per-effort.)*

---

## 5. The 3 highest-leverage sheets + a build-ready first slice

### The 3 to ship first (max "this looks like Rayon" per unit effort)

1. **The plan sheet with a full Studio-Nova title block + key plan** (M1). Nothing signals "architect,
   not app" faster than the title block + key plan wrapping a drawing we *already render*. Near-zero
   new geometry.
2. **The Demolition + Construction plan pair** (M2). This is our **unique** capability: `DocWall.generated`
   (`EditorCanvas.ts:15-16`) already encodes existing-vs-new, so red-hatch demolition and blue new-walls
   fall out of data no competitor's furniture layout carries. Highest differentiation.
3. **The Furniture & Fixtures schedule sheet** (M3). `buildTakeoffModel` (`takeoff.ts:185`) + bank
   images already contain the entire card — it's a layout job, not a data job. Very high value, low risk.

### First-slice spec (build-ready): title block + the demolition/construction plan pair

This is M1's title block + M2's plan pair — the smallest slice that is unmistakably "a drawing set,"
built entirely on `buildMultiPagePdfBytes` and an extended `renderPrintCanvas`.

**New file `web/src/export/sheet.ts`** — lift the `Page` class verbatim from `report.ts:369-421`
(top-down `text/box/line/image`, `MARGIN`, `pageHeader`), export it; delete the copy in `report.ts`
and import from here (no-bloat, same change).

**Extend `renderPrintCanvas` in `web/src/export/pdf.ts:320`** — add an optional
`layers?: { existing?: boolean; generated?: boolean; demolishHatch?: boolean; furniture?: boolean;
newWallHighlight?: boolean }` param, default = current behaviour (all walls, furniture, labels). New
branches:
- when `demolishHatch`, over-stroke `generated:false` walls (or a caller-supplied removed set) with a
  red cross-hatch (reuse the CAD `HatchEnt`/`cross` math conceptually, `cad/render.ts`);
- when `newWallHighlight`, stroke `generated:true` walls in blue (`#3b6fd4`) over the grey.

**New file `web/src/export/sheetSet.ts`:**

```
export interface SheetSetMeta extends ReportMeta {   // reuse report.ts:55
  drawnBy?: string; approvedBy?: string; revision?: string; studio?: string
}

// Shared title block — the whole set's spine.
function titleBlock(p: Page, o: {
  no: string; title: string; scale: string; meta: SheetSetMeta; keyPlan: PdfJpeg | null
}): void { /* logo · key plan · Client/Project/Revision/Date · Drawing Title ·
             Drawn/Approved · Scale · big sheet no. — one band at page bottom */ }

// Whole-plate thumbnail with `region` filled — reuses renderPrintCanvas small.
function keyPlanJpeg(state: DocState, region: Region | 'all'): PdfJpeg

// Deterministic opening tags + schedule rows.
interface Opening { tag: string; kind: 'Door'|'Window'; w: number; h: number;
                    sill?: number; material?: string }
function openingSchedule(state: DocState): Opening[]   // 'D01','D02','W1',… stable order

function demolitionSheet(state, meta): PdfPage   // layers: existing + demolishHatch + labels + dims + legend
function constructionSheet(state, meta): PdfPage // layers: existing + newWallHighlight + furniture + tags + schedule + legend

export async function buildDrawingSetBytes(state, meta): Promise<Uint8Array>  // → buildMultiPagePdfBytes([...])
export async function exportDrawingSet(state, meta, filename?): Promise<void>  // triggerDownload
```

**Wiring:** both sheets call `planRender = renderPrintCanvas(state, wPx, hPx, layers)`, embed the JPEG
left, draw `titleBlock` in the bottom band, and draw a legend box (Existing / Demolished (red) — or
Existing / New (blue) / Furniture / tag glyphs). Room labels + areas come from `getZoneStats()`
(`EditorCanvas.ts:445`). Scale from `metersPerPx` via the existing `scaleNote` (`pdf.ts:456`).

**Acceptance for the first slice:**
- A 2-page A3 PDF: `A.01 Demolition Plan` + `A.02 Construction & Furnishing Plan`.
- Both carry an identical title block differing only in Drawing Title / Scale / sheet no. / key-plan
  highlight, populated from `ProjectRecord`/`ReportMeta`.
- Demolition: existing walls grey; removed/existing distinction hatched red; each room labelled with
  its `ZoneStat` name + `area` m²; a demolition legend present.
- Construction: existing grey + generated partitions blue + furniture; every door/window carries a
  unique `D0N`/`W N` tag that also appears exactly once in a "Doors and windows specifications"
  schedule with its W×H (+ material where known); a construction legend present.
- Built only on `buildMultiPagePdfBytes` + `renderPrintCanvas` (no new deps); `report.ts` and the
  single-sheet `exportPlanPDF` still produce byte-identical output (default `layers` unchanged).

---

## Appendix — file references used in this spec

- PDF engine + print render: `web/src/export/pdf.ts` (`buildMultiPagePdfBytes` :193, `ContentOp` :49,
  `sheetChrome` :478, `renderPrintCanvas` :320, `scaleNote` :456, `PAGE_W/H` :32).
- Report harness (Page/scale/legend/orchestration): `web/src/export/report.ts` (:369, :679, :698, :918).
- Furniture BOM: `web/src/export/takeoff.ts` (`buildTakeoffModel` :185, `TakeoffFurnitureRow` :54).
- Document model: `web/src/editor/EditorCanvas.ts` (`DocWall` :10, `generated` :15, `glazing` :17,
  `DocComponent` :20, `ZoneStat` :81, `Metrics` :65, `getZoneStats` :445, `getMetrics` :442).
- CAD entities: `web/src/cad/model.ts` (`DoorEnt` :83, `WindowEnt` :95, `HatchEnt` :111,
  `DimensionEnt` :65); render `web/src/cad/render.ts` (door swing :327, dimension :192).
- 3D: `web/src/three/Viewer3D.ts` (`PerspectiveCamera` :230/:450 — section render is new).
- Bank + project: `web/src/materialBank/client.ts` (`BankProduct` :13), `web/src/persist/projects.ts`
  (`ProjectRecord` :81).
- Related design: `docs/design/testfit-pro-quality.md`, `docs/design/workflow.md`, `docs/ROADMAP.md`
  (Track C, Qbiq-grade deliverables).
</content>
