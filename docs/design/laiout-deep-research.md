# Laiout Deep Research — why their plans read clean & stay consistent, and our gap

Status: research / diagnosis. No code changed. Companion to
`research/03-laiout.md` (feature scan) and `docs/design/laiout-visual-system.md`
(screenshot-derived visual system). This doc goes one level deeper: it studies
**why Laiout's output looks professional and stays identical across 2D / 3D /
stats**, then diagnoses the root architectural reason DSource diverges, with a
prioritized fix list mapped to our files.

Sources are cited inline. Everything marked **[Unverified]** could not be
confirmed from public material and should be treated as a hypothesis.

---

## 0. TL;DR

Laiout is not "a 2D drawing plus a separate 3D render plus a stats calculator."
It is **one generated design object** — a set of *zones* (rooms) that tile a
*clean shell*, each zone holding *furniture instances* — and 2D, 3D, the stats
panel, and every export are all **pure projections of that one object**. Because
they all read the same object, they cannot disagree: same rooms, same furniture,
same counts, every time.

DSource, by contrast, currently carries **two parallel representations of the
same floor** — the **imported CAD `Drawing`** (raw walls + ~500 furniture blocks
from the DWG) and the **generated `Document`** (zones + placed components + core
metrics) — and different views read different ones. That is the single root
cause of all four reported symptoms (tiny framing, cluttered reader, 2D≠3D≠Plan,
and nonsense metrics like 113 workstations @ 1.8 m²/ws).

**The one change that matters most: collapse to a single canonical floor model
that every view renders from and every metric computes from — and, like Laiout,
strip the imported furniture/old-layout on import so only a clean shell survives
into that model.**

---

## 1. What Laiout does

### 1.1 The plan "reader" / 2D drawing — why it reads clean

Confirmed from the help center and the screenshot-derived
`docs/design/laiout-visual-system.md`:

- **Zones are the organizing unit, not loose furniture.** The floor is tiled by
  typed zones (Open Workspace, Meeting, Breakout/Collaboration, Closed Office,
  Amenity, Circulation, Core, Pod Area, …). "Adjust zones… change zone types,
  split or merge zones, add or remove walls, and place furniture *within them*"
  and dragging a wall "resizes adjacent zones accordingly" so the plan never
  fragments (help: *Zone Editing Overview*). Everything the reader draws hangs
  off a zone, so the drawing has structure instead of being a soup of blocks.
- **Flat pastel zone fills + one darker line per zone**, defined once in
  *Organisation Settings → Zones & Colours* ("input the HEX code or pick a
  colour"), and — critically — those colours "appear automatically across the
  interface" (help: *Zones & Colours*). One palette, one source, reused on the
  2D plan, the 3D zone overlay, and the stats donut/legend.
- **Furniture is drawn as clean technical line-symbols** (desk + chair-arc,
  table + seats), thin gray, no heavy fills — Laiout ships "100+ high-detail
  furniture blocks and typologies" as a curated library, so every desk is the
  *same* well-drawn symbol at the *same* scale (AEC Magazine; help: *Furniture
  Overview/Library*). Curated symbology is why theirs looks drafted and ours
  (rendering raw imported blocks of wildly varying quality) looks noisy.
- **Hierarchy of line weight:** heavy structural shell (exterior walls, core),
  medium partitions, hairline furniture. The plan reads because the eye can
  separate shell → rooms → furniture by weight and by the zone tint behind them.
- **Labels are per-zone, not per-object:** each zone carries a name + a small
  count (e.g. workstation count), placed once, top-left, in the zone's line
  colour. The reader is *not* cluttered with a price/qty on every single item —
  that lives in the stats panel, not on the drawing.

Net: **legibility comes from the model being zone-structured and from curated,
uniform symbology — not from clever rendering tricks.** A clean model renders
clean; a messy merged model renders messy no matter how good the renderer is.

### 1.2 2D ↔ 3D consistency — one model, many projections

- The 3D view "is activated after generating a floor plan"; "a full 3D model is
  also generated in around 4 seconds" from the same design (help: *How It
  Works*, *3D View & Walkthroughs*).
- **3D is read-only.** "It is not currently possible to edit the floor in 3D
  view" — all edits happen in 2D (help: *3D View & Walkthroughs*). This is the
  tell: 3D is a **downstream projection**, never an independent editable copy.
  Because you can only mutate the 2D model, 3D can never drift from it.
- Furniture "renders in full 3D with accurate dimensions and proportions" — i.e.
  the *same* furniture instances, extruded, not a re-imported or re-derived set
  (help: *Furniture Overview*).
- 3D adds *view-only* affordances (walkthrough, camera height, ceiling height,
  zone-colour overlay) but **no new content** — so counts and rooms are
  identical to 2D by construction.

### 1.3 The generate → Review → Design → Immerse → Visualise flow

- **Upload** a plan (DWG/PDF). In Pro mode Laiout **cleans it first**: keep
  walls, boundary, columns (labelled "Pillar"), glass; **delete existing
  furniture "layer by layer, one click per layer," strip old layouts and
  annotations**; then flood-fill regions and draw corridors and mark the floor
  "clean = ready to generate" (help: *Cleaning Your Floor Plan (Pro)*). **The
  import is reduced to a clean shell before anything is generated.** Lite mode is
  even more aggressive: "uploads your file as-is, without reading its layers,"
  and the user draws the usable area + corridors by hand — the shell is defined,
  the raw content is ignored (help: *Lite Mode*).
- **Generate:** clicking the laiout button yields **three** options per click
  (must differ ≥10% from each other), "fully furnished, regulation-aware," in
  ~3–5 s (help: *Generating Layout Options*; *How It Works*).
- **Review:** option cards carry corner badges (lowest cost, lowest carbon, most
  workstations, highest area/employee); **hovering an option fills the stats
  panel with *that option's* stats** so you compare before committing (help:
  *Generating Layout Options*; *Interface Overview*).
- **Design:** edit zones/furniture. Edits apply only to "the option you edited,
  new options generated after, and favourites saved in that state — the base
  file is untouched" (help: *Zone Editing Overview*). The base shell and each
  option are cleanly separated objects.
- **Immerse (3D) / Visualise (AI render):** downstream projections of the chosen
  option — walkthrough, then text-to-render photoreal images "in seconds."
- **Original vs picked test-fit:** the *base* (clean shell) is one thing; each
  *option/favourite* is a self-contained furnished design. You never look at
  "base + option merged" — you look at one option at a time.

### 1.4 Metrics / insights — coherent because they read one object

From help: *Statistics & Metrics* and *Materials, Costs & CO2*:

- Metrics shown: **total area (GEA/NIA), area-efficiency %, desk/workstation
  count, total occupancy (pax), density (m²/person), room counts by type, area
  distribution by zone (% and m²), fit-out cost breakdown (furniture /
  partitions / custom), carbon estimate, full bill of quantities.**
- **Efficiency = "the utility of the space as measured in percentage of NIA."**
- **GEA/NIA "calculated based on RICS or GIF parameters."**
- **Density = m² per person.**
- **Cost/CO2 are per-element and rate-driven:** furniture = unit price × qty and
  itemCO2 × instances; partitions = per-metre rate × length of **new/generated**
  segments; floor + custom = rate × NIA. Rates live in shared org "Cost
  Profiles" so every project computes the same way (help: *Materials, Costs &
  CO2*).
- **Stats are snapshotted per option:** "each saved favourite stores the full
  set of statistics generated when the layout was created, including desk count,
  NIA, GEA, and zone breakdown" (help: *Saving Favourites & Comparing Options*).

Why the numbers are trustworthy: **there is only one furnished object per
option, and every metric is a function of it.** A "workstation" is a placed
workstation-furniture instance from the curated library (managed under *Presets
→ Furniture*, help: *Desk Sizes & Workstation Types*) — not "anything desk-shaped
in the drawing." Because the imported furniture was deleted at clean-time,
nothing spurious can be counted. Partition cost counts **only generated wall
segments**, so imported shell walls don't double-bill.

### 1.5 Framing / viewport

Not documented in detail, but by construction the thing being framed is a single
clean design whose extents = the shell polygon. **[Inferred]** Auto-fit frames to
the **shell/plate boundary**, which is a clean closed polygon with no outliers —
so the plan always opens centered and correctly scaled. (Contrast: framing to a
raw CAD entity set that may contain stray far-away leaders/site lines.)

**[Unverified]** Exact camera math, exact efficiency formula (which zones count
as "utile"), and the precise workstation definition are not public.

---

## 2. Diagnosed root gaps in DSource

### 2.1 The root: two parallel representations of one floor

DSource keeps the same floor in **two** forms, each with its own 2D and 3D
renderer:

| Concern            | Imported-drawing representation                  | Generated-document representation                    |
|--------------------|--------------------------------------------------|------------------------------------------------------|
| Data               | `import/types.ts` `Drawing` (raw DXF entities: ~745 wall polylines, ~533 furniture blocks — see `three/buildFromDrawing.ts` header) | core `Document`: `walls`, `components`, `zones` (`crates/ds-core`) |
| 2D render          | `web/src/import/DrawingCanvas.ts` (own `fitToView`, `FIT_PADDING`) | `web/src/editor/EditorCanvas.ts` (`frameContent`)    |
| 3D render          | `web/src/three/buildFromDrawing.ts` + `DrawingScene3D.tsx` | `web/src/three/Scene3D.tsx` + `Viewer3D.ts`          |
| Metrics            | (item counts off the raw drawing)                | `Editor.metrics()` / `stats.ts` off the `Document`   |

When the same floor is shown through different pipes, the views disagree:

- **113 vs 1 workstations, GEA 256 vs 247, 543 vs 538 items** are two datasets
  reporting on two representations of the "same" floor. One view is reading the
  raw imported `Drawing` (≈543 items, ≈113 desk-like blocks); another is reading
  the generated `Document` (a handful of placed desks). They were never the same
  object, so they never matched.

*(The Explore agent's mapping of exactly which tab reads which representation is
folded into §2.5.)*

### 2.2 Why the reader looks worse / cluttered

The reader is drawing the **raw imported drawing** — hundreds of heterogeneous
CAD furniture blocks of varying line quality, plus every stray annotation the DXF
carried — instead of a **clean zone-structured model with curated symbology**.
Laiout's cleanliness is 80% *model* (zones + deleted import clutter + one curated
symbol per furniture type) and 20% *renderer*. We inherited the DWG's mess into
the view, so no amount of line-weight tuning makes it read like Laiout. We also
lack Laiout's **zone-first hierarchy** (tint behind rooms, per-zone labels), so
there's nothing organizing the eye.

### 2.3 Why metrics are wrong/inconsistent

Confirmed in `crates/ds-core/src/lib.rs` (`metrics()`, lines ~361–389):

```rust
let workstations = self.doc.components.iter()
    .filter(|c| c.category == "Desk")
    .count();
...
let area_per_workstation = if workstations > 0 { nia / workstations as f64 } else { 0.0 };
let efficiency_pct = if nia > 0.0 { programmed / nia * 100.0 } else { 0.0 };
```

- **A "workstation" = any component categorized `"Desk"`.** Import normalization
  maps anything named workstation/bench/desk to category `"Desk"`
  (`import/normalize.ts:110`: `/WORKSTATION|\bBENCH\b|\bDESK\b/ → 'Desk'`), and
  `mergeFit.ts` stamps those blocks into Model B as `"Desk"` components
  (`mergeFit.ts:120` → `add_component`). So **every imported desk-shaped block
  counts 1:1 as a workstation** → the 113. There is **no seat-geometry check and
  no de-dup**: a bench that seats 6 counts as 1, a decorative desk-block counts
  as 1, and nothing distinguishes "real seat in a Workspace zone" from "imported
  drawing artifact."
- **`area_per_workstation = NIA / workstations`** then yields the absurd
  1.8 m²/ws: a small generated NIA divided by 113 phantom desks. The metric is
  arithmetically fine; its **inputs are polluted** by counting the wrong things.
- **Pax** in `stats.ts` (`zonePax`) is *separately* derived from zones (desks
  seat 1, enclosed rooms use area-capacity), so **Pax and Workstations can
  disagree** — two definitions of "how many people," neither authoritative.
- **GEA = `floor_area`** of whichever document is in hand; two documents (imported
  plate vs generated plate) → GEA 256 vs 247.

### 2.4 Why a saved plan opens tiny/off-screen

`EditorCanvas.frameContent()` (lines ~1710–1749) accumulates the bbox over
`st.walls` **plus every `this.cad.store.entities`** and clamps
`k = min(availW/spanX, availH/spanY)` to `[8, 300]` px/m. Two failure modes,
both consistent with "tiny/off-screen":

1. **Outlier entities blow up the span.** Imported DXFs routinely carry stray
   geometry far from the plate (title blocks, site lines, leaders at large
   coordinates). Framing to the *raw entity set* makes `spanX/spanY` huge, `k`
   clamps to the 8 px/m floor, and the real plan shrinks to a corner sliver.
2. **Frame computed before the canvas is measured / not re-called on open.** If
   `w||h === 0` at call time it early-returns and the default view (tiny) sticks;
   if the saved-plan open path doesn't call `frameContent()` after content is in
   and the element is sized, the plan never fits. *(Open-path specifics from the
   Explore agent are in §2.5.)*

Laiout avoids both by framing to the **clean shell polygon** (no outliers) after
the single model is loaded.

### 2.5 Saved-plan open path & view→dataset mapping (confirmed)

The two representations have concrete names and homes:

- **Model A — imported `Drawing`** (`web/src/import/types.ts:70` — `bounds`,
  `entities`, `furniture`), held in React state
  (`App.tsx:258` `const [drawing, setDrawing] = useState<Drawing|null>`).
- **Model B — core `DocState`** (`EditorCanvas.ts:108`; walls + components +
  zones), the Rust `Editor` document (`crates/ds-core/src/lib.rs:66`).

The app's render switch (`App.tsx:1053–1080`) binds each surface to **one** model:

| Surface | Reads | Where |
|---|---|---|
| 2D editor canvas | **Model B** | `EditorCanvas.getState()` (`EditorCanvas.ts:1064`) |
| 3D editor (`Scene3D`) | **Model B** | `Viewer3D.setState(state)` (`Scene3D.tsx:164`) |
| 2D imported plan (`DrawingView`) | **Model A** | `App.tsx:1068` |
| 3D imported plan (`DrawingScene3D`) | **Model A** | `buildFromDrawing(drawing)` (`buildFromDrawing.ts:194`) |
| Plan reader (`CategoryPlan`) | **Model A** | `buildCategoryGroups(drawing,…)` (`App.tsx:2051`, `:2153`) |
| Statistics panel (`StatsPanel`) | **Model B** | `ec.getMetrics()/getZoneStats()` (`StatsPanel.tsx:16`) |
| Import panel stats | **Model A** | `drawing.furniture.length`, `entities.length` (`App.tsx:2128`) |

So the **editor 2D/3D + Stats** are one family (Model B) and the **imported
Plan reader + imported 3D + Import panel** are another family (Model A). The
"113 vs 1 workstations" is exactly this: the Plan/import surfaces count
`drawing.furniture` (≈113 imported desk blocks) while the editor/Stats surfaces
count Model B (`category=="Desk"` components — here 1). "GEA 256 vs 247 / 543 vs
538" is two *separately computed* extents/tallies over almost-the-same geometry
(import bbox + `entities.length` vs wall-bbox + component/zone counts) — the
signature of two datasets, not one number formatted twice.

**The bridge between them is one-way, partial, and lossy.**
`import/mergeFit.ts` `baseStampAround` stamps imported furniture *outside* a
selected fit region into Model B via `add_component` — but only when a sub-area
test-fit runs, and it leaves the full `drawing` (Model A) untouched in parallel.
After a partial fit you hold the fit in B **and** the whole original in A at once.

**Saved-plan open path** (`App.tsx:458 applyOpenedFile` → `file.ts:263`
`applyProject`): a `.dsource` persists **both** models independently
(`persist/file.ts:46` — `snapshot` *and* `drawing`). On open it restores only the
core `snapshot` into the editor, then *separately* `setDrawing(f.drawing)`, and
restores the saved `mode`/`planView`. **Nothing reconciles A against B**, and the
library card's denormalized metrics come from Model B only (`plans.ts:114`), so
the card can disagree with what the Plan reader shows for the same record.

This confirms §2.4's second failure mode precisely: `frameEditor()`
(`App.tsx:424`) frames the 2D canvas **only if `mode==='2d'`** at open; otherwise
it latches `pendingFrameRef` and waits. A plan saved in 3D or import mode
**never runs `frameContent` on open**, and the 3D re-frame is *stale-gated*
(`Viewer3D.setState` only re-frames when bounds shift >25–40%, `Viewer3D.ts:886`)
— so it can keep the previous camera. Imported plans also sit ~1000 m from origin
and are recentered only on the Model-A path (`Viewer3D.setContent`,
`Viewer3D.ts:911`). Result: open-tiny/off-screen depends on which model+mode the
plan was saved in.

---

## 3. Prioritized recommendations (mapped to our parts)

Ordered by leverage. P0 items are the ones that make the other problems dissolve.

### P0 — One canonical floor model; delete the parallel representation
- **Make the core `Document` (zones + components + walls) the single source of
  truth for 2D, 3D, Plan reader, and metrics.** No view may read the raw
  imported `Drawing` after import. Retire the `Drawing`-based render paths
  (`import/DrawingCanvas.ts` as a *viewer*, `three/buildFromDrawing.ts`,
  `DrawingScene3D.tsx`) as **display** surfaces — import becomes a *conversion
  step into the Document*, not a second live representation. (No-bloat: this
  removes a whole duplicate render stack rather than adding one.)
- **On import, do what Laiout does: reduce to a clean shell.** Extract
  walls/boundary/columns/glazing into the Document; **drop imported furniture and
  old-layout blocks** (or quarantine them on a hidden, non-counted "reference"
  layer the generator and metrics ignore). The generator then furnishes the clean
  shell; the furnished Document is the only thing rendered and measured. This
  single change eliminates the 113-vs-1 and 543-vs-538 divergences at the source.

### P0 — Fix the metric definitions
- **Define "workstation" as a real seat, not a desk-shaped block.** Count only
  desks that are (a) generator-placed workstation instances and/or (b) inside a
  `Workspace` zone — never imported/reference furniture. Update
  `crates/ds-core/src/lib.rs` `metrics()` accordingly.
- **Unify Pax and Workstations** to one occupancy definition (open-desk seats +
  enclosed-room capacity), computed once in the core and reused by `stats.ts` /
  `StatsPanel.tsx` — kill the second definition so they cannot disagree.
- **Sanity-guard `area_per_workstation`** (NIA / real workstations) — with the
  count fixed it lands in the sane 6–10 m²/ws band; the 1.8 m² symptom is a
  count bug, not a formula bug.
- **State the efficiency formula explicitly** and match Laiout's framing
  (utile/programmed NIA ÷ NIA). Current `programmed/nia*100` is close; document
  which zone types are "utile."
- **Snapshot stats per saved plan** (like Laiout's favourites) so an opened plan
  shows the numbers it was generated with, and 2D/3D/Plan read that one snapshot.

### P0 — Framing
- **Frame to the plate/shell polygon, not the raw entity set.** In
  `EditorCanvas.frameContent()`, compute bounds from the Document's plate polygon
  (`Document::plate_polygon` already exists, used by `effective_zone_areas`) +
  zones, and **exclude outlier CAD entities** (or drop them entirely once import
  is a conversion step). This directly fixes the tiny/off-screen open.
- **Guarantee a re-frame after the canvas is measured on open** (re-run
  `frameContent()` once `w>0 && h>0`, e.g. via a ResizeObserver first paint), so
  a plan opened from the library always lands centered.

### P1 — The reader render (clean, Laiout-like symbology)
- **Draw zone-first:** flat pastel `--zone-*` fill behind each room + 1px
  `-line` border + one per-zone label in the line colour (top-left). The
  `ZONE_META` palette in `stats.ts` and the tokens in
  `docs/design/laiout-visual-system.md` already define these — reuse them on
  canvas, in 3D, and in the donut so all three read as one key.
- **Curated furniture symbology:** one clean line-symbol per furniture kind
  (desk+chair-arc, meeting table+seats), thin gray, no fills — drawn from our
  own catalog, **not** the raw imported blocks. Uniform scale + weight is what
  makes it look drafted.
- **Line-weight hierarchy:** exterior/structural walls heavy, partitions medium,
  furniture hairline (see `--wall-ext` / `--wall` / `--furniture` tokens).
- **Move per-item price/qty off the drawing** into the stats panel; keep the plan
  itself to shell + zones + furniture + per-zone labels.

### P1 — 3D as a pure read-only projection
- **Build 3D only from the Document** (`Scene3D`/`Viewer3D`), extruding the same
  zones + components + walls; retire the `buildFromDrawing` path as a display
  surface. Adopt Laiout's stance explicitly: **3D is view-only**, so it can never
  carry different content or counts than 2D.

### P2 — Reader/Plan tab = the same model, tabulated
- The "Plan" reader (`CategoryPlan.tsx`) should tabulate the **same Document's**
  furniture schedule + bindings that 2D/3D render and stats count — not a
  separate list. (Also swap its hardcoded `IBM Plex Mono` for the project's
  `--font-ui` tabular figures per the visual-system doc — minor, but it's the
  last monospace island.)

---

## 4. What we could NOT verify
- Laiout's exact **efficiency formula** (which zone types count as utile) and
  exact **workstation definition** — inferred from "% of NIA" and "Presets →
  Furniture," not stated numerically.
- Laiout's **auto-framing math** — inferred (frames to shell polygon).
- Whether Laiout's 3D geometry is literally the same instance objects or a
  re-derivation — strongly implied by "read-only" + "full 3D model generated,"
  but not stated.
- The AI generation algorithm (GAN/RL/solver/LLM) — proprietary, unconfirmed
  (consistent with `research/03-laiout.md`).
- Fine visual specs (exact line weights, hatch/poché usage) — taken from our
  screenshot-derived `docs/design/laiout-visual-system.md`, not from live DOM.

---

## Sources
- Laiout site: <https://laiout.co/>, blog
  <https://www.laiout.co/blog-posts/how-ai-floor-plans-revolutionize-the-sales-process-for-office-spaces>
- Help center (llms map): <https://help.laiout.co/llms.txt> — articles read:
  *How It Works*, *Interface Overview*, *Generating Layout Options*, *Zone
  Editing Overview*, *3D View & Walkthroughs*, *Furniture Overview*, *Desk Sizes
  & Workstation Types*, *Statistics & Metrics*, *Materials, Costs & CO2*, *Zones
  & Colours*, *Saving Favourites & Comparing Options*, *Cleaning Your Floor Plan
  (Pro)*, *Lite Mode*.
- AEC Magazine: <https://aecmag.com/news/laiout-enhances-automated-floor-planning-software/>
- DataDrivenAEC: <https://datadrivenaec.com/tools/laiout>
- Demo (not transcribed here): <https://www.youtube.com/watch?v=VT3k2wZ2mEs>
- Internal: `docs/design/laiout-visual-system.md`, `research/03-laiout.md`,
  `crates/ds-core/src/lib.rs`, `web/src/editor/stats.ts`,
  `web/src/editor/EditorCanvas.ts`, `web/src/three/buildFromDrawing.ts`.
</content>
</invoke>
