# DSource Editor — Roadmap & Delivery Checklist

**Living document.** The canonical "what's left" tracker. Update it in the *same change* as the work:
tick `[x]` when done, mark `🔄` when an agent/slice is in flight, leave `[ ]` for not-started.
Keep it honest — a half-working feature stays unchecked with a note.

North star: **a floor plate in → a priced, buildable, professional test-fit out** — blending Rayon
(effortless CAD), Materio (bind real products), and Laiout/qbiq (AI regulation-aware test-fits, 2D/3D,
report + takeoff). India-first (₹, NBC 2016). Full vision: `vision.md`. Design specs: `docs/design/`.

Legend: `[x]` done & verified · `🔄` in flight · `[ ]` planned · `⏸` parked (deliberate) ·
`~` partial / needs more.

---

## Track A — Guided project workflow (`docs/design/workflow.md`)
The qbiq-style flow: Project → Upload → Program → Generate → Editor → Export.

- [x] **S0 — App shell + project library + create-project.** AppShell view-state machine (no router),
  hash routes, editor kept mounted; ProjectRecord (property/address/logo/floor) in IndexedDB `projects`
  store; DSOURCE STUDIO landing + create form. `web/src/shell/*`, `persist/projects.ts`.
- [x] **S1 — Space step chrome.** WizardChrome (Property/Space/Program/Generate) + Space step: DXF/DWG
  upload (reuses the editor import path) → detected readouts (usable m²+sf, bill of components via
  buildCategoryGroups, detected program, best-effort labelled rooms incl. CAD text labels); persists to
  the draft, resumes on reload. `shell/WizardChrome.tsx`, `shell/steps/SpaceStep.tsx`. E2E 7/7.
- [x] **S2 — Area selection.** DrawingCanvas `area` tool: wall-snapping editable polygon, masks outside;
  `restrictDrawing()` scopes readouts + test-fit plate to the sub-area (real DWG 882→287 m²).
  `import/area.ts`. Persists to draft.
- [x] **S3 — Room markers + reference numbers.** DrawingCanvas `marker` tool: typed room pins with ref #s;
  `buildRoomRefs/zoneAtPoint` make a marker's ref win as the takeoff **Room ID** (openpyxl-confirmed "502"/
  "503") and expose them via `controller.roomRefs()` for the AI. `import/markers.ts`. Persists to draft.
- [x] **S5 — Program builder.** Concept (templates Small/Mid/Large + headcount + enclosed-office %) /
  Detailed (full room-by-room tree with −/+ steppers + Window/Core/Flexible chips + desk type/size).
  Rust `Program.rooms: Vec<RoomReq>` (serde-additive); generator honors explicit counts + soft placement
  bias, falls back to derive() when empty; `sanitizeProgram` carries rooms through save/open. 78 Rust
  tests, E2E 7/7 (explicit counts honored on generate). `program/spec.ts`, `shell/steps/ProgramStep.tsx`.
- [x] **S6 — Anchor pins.** "Place on Plan": pick a room type, drop a pin on the plan → generator places
  that room FIRST at/near the pin (nearest-feasible, surfaced via program_fit) and bumps the count.
  `Document.anchors` + add_anchor/clear_anchors; blue-diamond pins; `pushAnchorsToEditor`. 83 Rust tests.
  Pinned Reception landed 1.8m from the click. Persists; cleared on re-upload.
- [x] **S7 — Generate step + real export meta.** "Pick a test-fit" A/B/C gallery (plan thumbnails,
  KPIs from buildReportModel, winner badges Most-seats/Best-daylight/Best-density, soft-goal verdicts);
  pick → `openCandidate` saves it as a project floor + opens live in the editor; ProjectRecord threads
  into report+takeoff so exports are branded (verified: "Chronos HQ"/address/floor in the PDF, "Untitled
  Plan" gone). `shell/steps/GenerateStep.tsx`. **Full-flow E2E 10/10 on the real DWG.**
- **Track A end-to-end verified:** create → upload → area → markers → program → anchors → generate A/B/C
  → pick → edit → branded report + costed takeoff. **S0–S7 all shipped — Track A closed.**
- [x] **Workflow bug fixes (user-reported, 2026-07-09)** — three confirmed bugs from a real small-area
  test-fit, root-caused via live browser repro on the sample DWG:
  1. **0 workstations on small plates** — generator dead zone: plates < ~100 m² produced 0 desks
     regardless of program (overflow rooms poisoned the desk field + a shallow-field lattice phase).
     Fixed in `layout.rs` (SMALL_PLATE_FIELD_AREA gate + degenerate-field fallback); 81 m²→6, 88 m²→4,
     140 m²→10, large plates unchanged. Rust regression test `small_plates_pack_desks_not_zero` (95 tests).
  2. **Blank editor after generate** — no frame-to-content existed; the view kept its default scale/offset
     so content sat off-screen. Added `EditorCanvas.frameContent()` wired into testFit/generate/
     open-candidate/open-saved-plan (`App.tsx`).
  3. **Confined Space-step preview** — fixed 460px `.space-preview` height too short for a near-square
     plate; now `clamp(460px,74vh,880px)` + re-fit on resize (`DrawingCanvas.ts`). Content fill 42%→72%.
  Verified end-to-end: an 88 m² plate now generates 4 workstations, framed + fully visible.
- [x] **Sub-area plate-tracing shrinkage** — a lasso traced a tight hull around the caught furniture
  (~88 m² lasso → ~36 m² plate → 1 desk). Fixed: `plateFromArea` clips the lasso to the building bbox
  and uses it as the plate; shared `import/plate.ts` `derivePlate()` feeds BOTH the Space readout and the
  test-fit. Verified: 88→88 m² (4 desks), 140→140 (10), 81→81 (6); full plate unchanged (882→80). Unit
  test `plate.test.mjs`. Limitation: clips to the building bounding box, not its concave outline (fine
  for in-bounds selections; a wild over-draw gets the bbox).
- [x] **Full-wizard E2E re-verified in the real UI** (not console) after all four fixes: create project →
  upload sample DWG → Space preview fills the box (BUG 1 ✓, 882 m²/533 comps) → Program → Generate (3
  candidates) → Open in editor → **editor opens FRAMED on the whole irregular plan with 80 workstations**
  (BUG 2a ✓), not blank. Area-select math (BUG 2b + plate-match) console-proven (88→88 m²→4 desks).
- [x] **Routing "quirk" investigated → NOT a bug.** The always-mounted editor never drives the hash: the
  wizard route held steady for 6 s + a resize in isolation. The earlier report was shared-Playwright-tab
  contention (parallel agents navigating one browser to `#/editor`). Note: the dev `#/editor` route does
  auto-restore the last doc (dev-only convenience; harmless in the prod wizard flow) — left as-is.
- [x] **Batch 2 fixes (user-reported from real use, 2026-07-10)** — 5 parallel agents, each root-caused +
  browser-verified + committed:
  1. **0 workstations on area-select** — the real cause was ANGLED plates: a hand-drawn lasso is never
     axis-aligned, so its tilted polygon defeats the axis-aligned desk lattice → 0 desks (my synthetic
     axis-aligned lassos hid it). Fix (`layout.rs`): a zero-desk rescue that packs on a grid rotated to
     the plate's principal axis; fires only at placed_desks==0 so all working plates are byte-identical.
     Verified: angled 20°→16, 35°→18, angled bands 9/5 desks; full plate 80→80. +1 test (96 Rust tests).
  2. **Tool dock "doesn't work"** (`ui/ToolDock.tsx`+CSS) — flyouts were positioned past the rail's
     `overflow` clip edge → rendered but unclickable. Now `position:fixed` anchored to the tile; click
     opens, tool activates, Esc/outside-click close.
  3. **3D not framing + white Render** (`three/Viewer3D.ts`) — framing fit a bounding SPHERE to the
     vertical FOV only (over-zoomed on landscape → off-screen); now box-corner fit on both axes. White
     render = UnrealBloom blooming the HDR Sky dome; bloom disabled + exposure 0.75→0.5. Both verified.
  4. **AI note only on winner** (`ai/evaluator.ts`+`GenerateStep.tsx`) — evaluator sent only gate-passing
     (top) candidates to Claude; now all candidates evaluated, uniform off/pending/ready state; "—"
     m²/person when 0 workstations (honesty).
  5. **Merge test-fit into imported plan** (`import/mergeFit.ts`+App) — user chose "one merged document":
     region's original furniture removed, test-fit stamped in, surroundings intact. Verified 407 kept +
     92 generated = 499, no leftovers inside.
  Combined re-verification on merged main: angled plates seat desks; 3D framed + Render legible (not
  white); tool-dock flyout opens + activates; typecheck clean, 96 Rust tests, report 43/43, plate 9/9.
- [x] **Batch 3 — Laiout-parity push (user-reported from real use, 2026-07-10)** — laiout.co is the
  north-star ([[laiout-parity-north-star]]). 5 parallel research+build agents, each browser-verified +
  committed; room-editing hit the stale-worktree hazard and was re-applied cleanly on current main:
  1. **Generator FILLS irregular/weird space** (`layout.rs`) — the oriented desk field only fired at 0
     desks, so tilted/hex/angled plates filled only their inscribed axis-aligned rect (a corner box).
     Now a coverage gate (`ORIENTED_COVER_FRAC=0.70`) flips irregular plates to a principal-axis oriented
     field packed desks-FIRST; rooms settle into the core. tilted 25×8→**20**, angled band→**20**,
     hex→**20** desks, all ~10 m²/person; axis-aligned + 843 m² real plate unchanged. +1 test (97 Rust).
  2. **Furniture normalization** (`import/normalize.ts`+`mergeFit.ts`) — imported CAD blocks map to
     canonical Desk/Chair/Table/Door/Window (block-name/layer/size), snapped to catalog sizes, so
     imported + generated render identically (editor + exports, which are category-driven). 78 Desk/120
     Chair/21 Table on the real 533-block DWG; +12-assertion test.
  3. **Laiout-grade insights** (`editor/stats.ts`+`StatsPanel.tsx`) — Zones (per-room-type Count·Pax·
     Area·Area% with S/M/L sub-classes + totals), CO2 by element (partition/floor/furniture/lighting),
     Costs by element (₹), enriched Areas. Internally consistent (Σ area%=100, Σ lines=total).
  4. **Intuitive room editing** (`EditorCanvas`+`ui/RoomTools.tsx`+additive `document.rs`/`lib.rs` zone
     bindings) — click a room → contextual toolbar (Assign-to type / Split / Duplicate / Delete); drag
     the room (zone+furniture+interior walls together, snapped); 8-handle Canva-style resize with live
     W×H badge + furniture re-flow. M1/M4/framing/pan regressions verified intact. Rotate deferred.
  5. **Naive-user workflow** (`shell/*`) — legible linear stepper (Property·Space·Program·Generate + a
     dimmed editor tail), per-step guidance strips, self-explaining disabled Next, guided Generate→editor
     hand-off. 100 Rust tests, typecheck clean. Combined verified: filled tilted plate + room toolbar +
     resize handles + Zones breakdown all render together.
- [x] **(a) tilted-plate stats** — builder+reviewer. Root cause: the plate-spanning Workspace zone
  overlaps nested rooms → summing zone areas double-counts → NIA>GEA + area-capacity pax. Fix (`lib.rs`):
  `effective_zone_areas()` de-overlaps the spanning Workspace (`plate − Σ other zones`), reports seated
  pax. Reviewer broke the builder's 0.9-area detector (mis-fired on large bare axis rects, 100×60→0.953)
  and replaced it with an exact wall-bbox footprint signature. NIA≤GEA + seated-pax hold across 880
  shape×rotation×seed combos. 105 Rust tests.
- [x] **(b) normalize furniture on INITIAL import** — builder+reviewer. `DrawingCanvas` renders imported
  furniture via `normalizeFurniture`+`drawFurnitureSymbol` (editor view + Space preview). Reviewer caught
  that 35% of desks (27/78 on the real DWG) were drawn UPRIGHT/misoriented (w/h aspect only encodes
  landscape/portrait, conflating 0/180 & 90/270); added a `rotation` facet (parity pinned to aspect so
  mergeFit stays byte-identical) + un-swap-and-rotate. Perf ~0.9 ms/533 items. normalize.test extended.
- [x] **(c) merge stamping: rotation + product price** — builder+reviewer. `mergeFit` un-swaps the
  aspect footprint + sets `rotation = norm.rotation + π` (the `+π` is the import↔editor Y-mirror);
  App `stampBaseInto` re-binds via `assign_product` so ₹ price flows to `specified_cost`/takeoff.
  Reviewer proved orientation-equivalence pixel-by-pixel (merged == mirror(import view)) for all 5
  symmetric categories + pricing robust across missing/dup/0/re-merge/generated-region edges; added
  `mergeOrient.test.mjs` + `mergePricing.test.mjs`. Known limit: **Door** is the one asymmetric symbol —
  a rotation can't express its hinge mirror (pre-existing: normalize emits door rotation 0 anyway);
  a true fix needs a `mirror` facet in the Rust component model + `drawFurnitureSymbol`/`drawComponent`.
- [x] **(d) room Rotate** — builder+reviewer. `rotateRoom(id,90°)` composes existing bindings: zone
  w/h swap + each member position `(dx,dy)→(−dy,dx)` about center + `rotation+=π/2` + interior-wall
  rotate + grid-snap/clamp. Reviewer broke it (a wide room rotated onto a too-short plate escaped
  furniture off-plate + half-applied + threw); fixed with a pre-mutation fit-guard (clean no-op) + a
  DEV off-plate invariant. Swept 360 aspect×position×member cases (0 escapes), 4×=identity, worst
  drift 0.0014 m. Rotate button gated to Rect zones.
- [~] **(e) non-rectangular room resize — DEFERRED (low value).** The only non-Rect zone is the
  Circulation ring (its outer box == the plate); resizing it via handles is meaningless/confusing.
  Genuine L/T-shaped rooms need a richer zone model (multi-rect / polygon zones) — a larger design
  decision, not a quick polish. Revisit if arbitrary room shapes are wanted.
- [x] **(f) Door orientation + mirror** — builder+reviewer. `Component` gains `mirror: bool`
  (`#[serde(default)]` false → all existing callers/blobs unaffected) + additive `set_component_mirror`.
  `normalize.ts::recoverDoorPose` recovers a door's opening axis + hinge hand from the SWING ARC's
  geometry (circumcenter=hinge, endpoints=leaf tip/strike, cross-product=hand) — 17/17 real doors;
  `drawDoor` reflects on mirror; merge carries it (a door is a true reflection under the import↔editor
  Y-flip → `rotation` w/o `+π` + inverted `mirror`). Reviewer found the product code correct but the
  merge-equivalence TEST stale (still pinned Door as unmirrorable) → rewrote `mergeOrient.test.mjs` to
  prove Door merge==mirror(import) across 4 axes×2 hands + a pose robustness matrix (degenerate/off-
  cardinal/reversed-winding/double-door). 106 Rust tests.
- [x] **S4 — Wall healing.** `healWalls(drawing)` bridges near-miss partition gaps (degree-1 wall ends
  within 0.25 m that are near-collinear or perpendicular, + endpoint→segment T-junctions; doorway guard
  at 0.8 m). Space-step **Heal gaps / As drawn** toggle (default heal on; testids space-heal-toggle/on/off)
  runs before plate/keepout extraction + readouts and again at test-fit. Synthetic near-miss DXF: heal
  flips the plate hull→**loop** (exact) in the readout; real DWG: traced faces 114→125 (+1 room-scale
  face closed). `import/heal.ts` (+ heal.test.mjs, 10/10). E2E: toggle flips 78 m² loop ↔ 79 m² hull.
- Decisions locked: upload **CAD-only v1** (raster/PDF deferred); Window/Core/Flexible = **soft bias**;
  Space step **re-editable** after generate; DB v2 forward-only upgrade accepted.

## Track B — Test-fit generator quality (`docs/design/testfit-pro-quality.md`)
Make generated plans read like a senior architect's work, not a diagram.

- [x] **M1 — Enclosed rooms.** Generated partitions + glazed corridor front + 0.9m door w/ swing;
  circulation door-whitelist; `Wall.generated/glazing` flags.
- [x] **M2 — Alignment discipline.** Jitter removed, 0.05m module snap, portrait bench-pair fix,
  discrete seed diversity.
- [x] **M3 — Professional space program.** `SpaceProgram::derive(headcount)`: cabins/phone/focus/pantry/
  reception/print/IT/storage; `support_spaces` flag.
- [x] **M4 — Drawn circulation.** `Document.entries` + spine (replaces perimeter ring); desks to facade;
  `program_fit` in score.
- [x] **M5 — Density + scoring.** Headcount drives rooms+desks coherently; density score peaks 8–12
  m²/person; +daylight/entry sub-scores. Clean rects now professional (~9.7 m²/person).
- [x] **M6 — Graphic polish.** Room area/pax tags, wall lineweight hierarchy, presentation/paper mode,
  summary block.
- [x] **Real-plate arbitration.** Real 882m² building went **14→52 workstations, 31→28 rooms (5
  meetings), 57→13.5 m²/workstation = 10.0 m²/person**, open-desk-dominant (Workspace 42% / Circ 25% /
  office 9% / meeting 6%). Fixes: `suggestProgram` derives an open-plan program from area/headcount
  (meetings ~1/17 ppl clamped 2–6, not inherited from old clusters); layout.rs reserves the dominant
  wing for the open field (rooms band the edges/small wings). Rust 74 tests.
- [x] Fresh-fit generates into the **base shell** (not around old tenant partitions).
- [x] **Leaner support ratio (qbiq-dominant open field).** Booths N/12→N/25, focus N/30→N/60, collab
  /8→/12, open-share 0.85→0.90, + a SUPPORT_AREA_CAP (0.22) that trims discretionary rooms so the open
  field always keeps the majority. Real DWG: rooms 28→20, open field now 62% of area (was a minority),
  54 workstations @ 13 m²/ws, density in band. Explicit S5 counts still win; only derived defaults got
  leaner. 84 Rust tests. `layout.rs`, `suggestProgram.ts`.
- [x] **Room concentration → 80+ workstations.** `allocate_rooms` now gives field (dominant) wings ZERO
  band capacity — the largest wing packs desks edge-to-edge with no room band/spine eating it; rooms
  concentrate in the smaller wings. Real DWG: **Open 75→80+ desks, Balanced 67→76**, largest wing is a
  pure desk field across every strategy, density in the 8-12 band. 91 Rust tests. (Cellular stays ~61 by
  design; program_fit dips as rooms overflow the reserved desk area — the inherent trade-off.)
- [x] **Circulation "walking place" depth.** Root cause of the ~50 dip: a scoring artifact — the desk
  field's legit 0.9m bench-access gaps were counted as sub-1.2m corridor failures. Split the corridor
  *target* from a hard sub-code *pinch floor* (0.8m); new score = connectivity + entry-reachability +
  (1−genuine-pinch) + corridor-coverage (rewards a primary/secondary hierarchy). Replaced the dead-end
  entry stub with a full-length 1.15m secondary boulevard (no blind ends). **Real DWG: circ ~50→81**
  (all strategies ≥79), 84 ws @ 8.3 m²/ws. `circulation.rs` + `layout.rs`.
- [x] **Focus↔facade hard placement.** Focus rooms now Window-placed + rear-aligned to the facade wall;
  measured avg focus-to-facade 1.3m < meetings 2.8m (the inequality M7 couldn't guarantee). 94 Rust tests.
- [x] **Smarter test-fits** (user: "needs to be smarter"). `Strategy {Open,Balanced,Cellular}` shifts
  the derived mix + scoring weights so A/B/C are genuinely distinct (real DWG: Open 76 desks/5 offices →
  Balanced 67/10 → Cellular 61/19; gallery labels "A · Open / B · Balanced / C · Cellular"); explicit
  program counts still win. Adjacency model: meetings↔entry cluster, focus↔facade, pantry central, IT↔
  core, desk-cluster coherence (soft score + placement bias). `autoGenerate` runs one search per
  strategy. 89 Rust tests. `layout.rs`, `editor/strategy.ts`.
- [x] **Keep-existing / respect-partitions mode** — Space-step "Layout · Fresh fit / Keep existing walls"
  toggle (default fresh); keep-existing pushes the imported partitions so generate() fits around them
  (verified: 337 walls retained, 0 component straddles; fresh = 31-wall shell, 67 ws). `draft.keepExisting`.

## Track C — Qbiq-grade deliverables (`docs/reference/qbiq/`)
- [x] **Space-planning report PDF** — cover, 3D-tour page, A/B/C KPI-rail + colored plan + legend,
  summary (comparison table + radar + space-mix). `export/report.ts`.
- [x] **Quantity takeoff Excel** — hand-rolled .xlsx, per-room BOM + wall schedule, ₹. `export/takeoff.ts`.
- [x] DXF · [x] PDF sheet · [x] IFC (BIM) · [x] OBJ+MTL · [x] PNG · [x] CSV.
- ⏸ **Photoreal renders** — deprioritized (needs 3D-asset library + path tracer / cloud render).
- [ ] **RVT** — native Revit is proprietary; we export IFC (imports to Revit). Revit sample = web viewer.
- [x] **Report cover branding + A/B/C differentiation** — client logo focal on the cover, project/address/
  floor laid out qbiq-style; per-alt accent chips + winner ribbons (shared `computeWinners` w/ the S7
  gallery); summary highlights each metric's leading alternative. (Building *photo* still N/A — no source.)

## Track D — CAD editing (Rayon-grade)
- [x] Draw: line/polyline/rect/circle/arc/ellipse/dimension/text/door/window/column/hatch.
- [x] Modify: move/copy/rotate/mirror/scale/offset, **grip-drag**, trim/extend/fillet, layers panel.
- [x] OSNAP engine, CAD ⌘Z, commit-sketch-to-plan (CAD → document walls).
- [ ] Deferred CAD: array tool (thin), spline, DXF layer-name export for CAD entities.

### Editor UX — Rayon parity (`docs/design/editor-ux-rayon-parity.md`)
User: "our editor doesn't feel as intuitive/detailed as Rayon… most of it is through the cursor."
- [x] **M1 Dynamic input** — cursor-first, type-as-you-draw: floating Distance/Angle widget (Tab
  switches, Enter commits, Esc clears), live per-segment dimension chips, ortho/polar snap (Shift=ortho,
  Alt=45°), OSNAP wins. Additive on Line + Wall (click-to-place unchanged). Verified: type 5→5.0m wall.
  `cad/dynamicInput.ts`.
- [x] **M2 Command palette (⌘K) + real letter shortcuts** — `editor/commands.ts` single registry
  (derived from CAD_RAIL+CATALOG, no duplicated tool list) · `ui/CommandPalette.tsx` fuzzy modal ·
  App-level window keydown with typing-guard: V/W/L/R/C/A/D/T/M fire tools, ⌘K toggles palette. Rail
  badges now reflect real bindings. Verified: ⌘K→"wall"→Enter sets wall tool; typing-guard blocks
  shortcuts in inputs.
- [x] **M3 context object inspector** — `ui/ObjectInspector.tsx`: selected component → editable
  geometry card (X/Y/W/H/rotation/category, IBM Plex Mono, commit on blur/Enter) above ReimaginePanel;
  nothing selected → Canvas card (Presentation wired; units/grid/axis/bg display-only). Additive
  EditorCanvas `selectedInfo()`/`updateSelected()` + additive ds-core `set_component_size`/
  `set_component_category`. 94 Rust tests.
- [x] **M5 grouped tool dock** — `ui/ToolDock.tsx` replaces the flat left rail with 6 Rayon-style
  clusters (Select/Draw/Place/Measure/Build/Modify) derived from the existing CAD_RAIL+CATALOG (one
  tool list); hover/click flyouts, active-tool lit, ≤2 clicks to any tool; per-tool testids preserved.
- [x] **M4 live dims on selection + click-to-edit** — `cad/dimEdit.ts` + EditorCanvas
  `drawSelectionDims`: selected component shows W/H size labels + editable X/Y position chips (rotated
  local frame, zoom-independent); selected CAD line shows an editable length chip. Click a chip →
  inline `<input>` → Enter commits (`move_component` for X/Y; anchored re-length for the line), Esc
  cancels. Scoped to position + line-length (no wasm resize/wall mutator exists — documented). Reuses
  M1 chip styling; does not touch dyn*/pan.
- [x] **M6 sheets/publish** — `ui/SheetsPanel.tsx` + `export/sheetManifest.ts`: a sheets manager modal
  (Export → "Sheets…") listing the drawing set with per-sheet include/exclude toggles + an editable
  title-block/project-metadata form, publishing via `exportDrawingSet`. Toggles are load-bearing —
  they feed `DrawingSetOpts.include` (a de-selected sheet's builder is skipped). Verified live: full
  set 6 pp · `[cover,construction,furniture]` 3 pp · `[moodboard]` 1 pp.

### Drawing-set output (`docs/design/drawing-set-generator.md`)
User showed Rayon drawing-set PDFs as the output bar (`docs/reference/rayon-output/`).
- [x] **First slice** — title block + key plan + cover + TOC + demolition & construction plans + door/
  window schedule (leverages our unique existing-vs-`generated` wall split). Shipped:
  `export/{sheet.ts,sheetSet.ts}`, `renderPrintCanvas` layers/demolish param, ExportMenu "Drawing set"
  (`export-drawing-set`). Demolition re-derives the imported plate → red cross-hatch of removed walls;
  retained shell grey; D01/W1 tags drive both plan glyphs and a doors-&-windows spec table. Report
  primitives (`Page`, `titleBlock`, `keyPlanJpeg`) promoted to `sheet.ts`; report byte-identical (43/43).
- [x] **Furniture cards + moodboard + plan quality** — new `productCard` primitive + Furniture &
  Fixtures sheet (4×3 card grid from `buildTakeoffModel`, paginated, graceful empty state) + Moodboard
  sheet (bound-product tiles grouped by room type). Plan polish: collinear glazing-run merging (20
  fragments → 4 real windows), deterministic label/tag de-collision (shared occupancy + leaders), true
  circle/hex tag glyphs (polyline fans, no arc op), overall perimeter dimension strings. Auto A.NN
  renumbering keeps contents+title blocks in sync. report byte-identical (43/43).
- [x] **Sections from 3D** — `three/sectionRender.ts` (reused Viewer3D meshes + `buildFurniture3D` via
  shared `WALL_HEIGHT`/`CEILING_HEIGHT`/`furnitureHeight`, OrthographicCamera + clip plane; Canvas2D
  fallback when no WebGL) + `export/section.ts` (`sectionSheets` → A3 pages: cut-wall poché, beyond in
  depth-faded elevation, floor/ceiling datum + 2.60 m height dim + F.F.L/C.L tags, scale figures,
  longitudinal + cross cut). Wired into `buildDrawingSetPdf` at the `sections` slot (auto-numbered,
  include-filtered, try-wrapped). Verified live: full set 8 pp, both cuts WebGL; Viewer3D unaffected.
- [x] **Per-room dimension runs** — `constructionSheet` dimensions every room's internal width/depth
  (bottom + left edges, inset), via one factored `dimString` helper shared with the perimeter dims;
  dim labels seed the de-collision occupancy first so room names/tags place around them. Spot-checked
  exact (Reception 4.00 m, Cabin 2.80 m). Overall perimeter dims retained.
- [x] **RCP + Power/Data services sheets** — `export/services.ts` (deterministic derivation: luminaire
  grid ~2.7 m centres, HVAC/smoke per area, exit lights at doors; power+data per workstation, floor
  boxes per cluster, switches at doors, one DB) + `export/servicesSheets.ts` (RCP + Power & Data A3
  sheets with glyph legends + count schedules), wired into `buildDrawingSetPdf` (ids `rcp`/`power`,
  M6-toggleable). **The drawing set is now a complete 10-sheet architectural set** (cover · contents ·
  demolition · construction · RCP · power · 2× sections · furniture · moodboard). Verified live +
  rasterized both services sheets.
- [x] **Services-plan polish** — glyph/label de-collision (room names painted last with knockout halos,
  colliding glyphs nudged clear) + lighting-circuit runs (nearest switch→luminaire, LC-NN) on the RCP.
- [x] **Room Finish Schedule** — `export/finishSchedule.ts`: per-room floor/base/wall/ceiling/skirting
  finishes + area, India-market vocabulary keyed by room type, paginated, wired as sheet A.08. **The
  drawing set is now 11 sheets.** Verified live (full set 11 pp; finishes include filter 1 pp).
- [ ] Longer tail: RCP lighting-circuit switching diagram detail, cloud plan sync, live deploy.

## Track E — Import & plate
- [x] DWG/DXF parse (LibreDWG `/api/dwg`), plate extraction (furniture-coverage), keepouts (cores),
  entries, interior-wall extraction, editable imported furniture, palette-place new catalog items.
- [x] Area-select / markers+refs / wall-heal — shipped as Track A S2/S3/S4.
- [ ] PDF/image import with scale confirmation (deferred, CAD-only v1).

## Track F — Material bank / Materio
- [x] Live bank (VPS, ~159k products) via `/api/bank`; ₹ pricing; bind products; decision lifecycle;
  selection cards; by-category plan; specified-cost metric.
- [x] **Supplier in the takeoff.** BindingInfo gains supplier/brand (from bank vendor/supplier_domain);
  takeoff Supplier = supplier ?? brand ?? fallback. Also fixed a real bug: the re-imagine panel's binds
  never reached the App bindings map, so generated-plan binds surfaced neither price NOR supplier in the
  takeoff — now mirrored via `onAssign`.

## Track G — AI backbone
- [x] Drivers: Local intent parser · Cerebras LLM · Claude (`/api/claude`); 3-way toggle; preview→approve
  →undo; consequence reasoning; Claude soft-goal candidate evaluator.
- [x] **AI-in-the-loop steering** — `ai/refine.ts` + `refineWithAI`: Claude proposes bounded program
  deltas (`adjust_program` tool) → apply → regenerate → keep only if it improves on a fixed yardstick →
  converge (cap 3). "Refine with AI" button in GenerateCard; clean no-op without a key. Live-verified
  (Claude proposed a corridor/weight tweak, loop scored it below base, reverted, converged).
- [x] **Regenerate variety** — each press slides to a disjoint seed window (was deterministic-identical).
- [ ] Workflow-aware AI: reference rooms by number ("tell me about room 502"), program-from-brief.

## Track H — 3D / visualization
- [x] Three.js 2D↔3D viewer, walkthrough, Enscape-like render tier (sky/GTAO/bloom), glass/PBR,
  click-to-pick, glazing walls translucent.
- [x] **Material differentiation + customizable themes** (user: 3D was an all-white void). Root cause:
  zone floors were at 0.16 opacity (invisible) + single near-white wall + exterior blended into sky.
  Fixed: opaque zone-tinted carpet floors (matched to the 2D legend), wall hierarchy (exterior vs
  generated), grounded exterior + visible grid, and **Studio/Warm/Mono/Blueprint** theme presets
  (`three/theme.ts`, live re-material + localStorage). ViewerToolbar Theme popover.
- [x] 2D grid legibility bump (was 3.5% opacity → read as white).
- [x] **Trackpad navigation fix** (user: couldn't pan/move the plan on a laptop). 2D: two-finger scroll
  pans, pinch/mouse-wheel zoom, Space+drag pans (was pan=middle/right-button-only, wheel=zoom-only). 3D:
  two-finger scroll pans the orbit (capture-phase wheel intercept). `EditorCanvas.ts`, `Viewer3D.ts`.
- [ ] Better real-time furniture models ("good-enough" for walkthrough — chosen over photoreal). Visual
  tuning needs a real GPU (untestable headless).

## Track I — Persistence, library, projects
- [x] `.dsource` save/open, plan library (IndexedDB), scenario compare, version history, multi-floor
  projects (grouping + floor switcher).
- [x] **Cloud plan sync** — `persist/sync.ts` `syncPlans()`: push local `updatedAt>syncedAt`, pull remote
  newer, last-write-wins both directions, idempotent, offline-safe; additive `syncedAt/remoteRev`; dev
  `/api/plans` middleware (mirrors deploy/server.ts). Library sync row + auto-sync on open. Two-device
  E2E verified. (Live once deployed; delete-tombstones deferred.)

## Track J — Deploy / infra
- [x] Production bundle: single Node `dsource-api` (SPA + `/api/agent|claude|dwg|bank|plans`), systemd
  unit, Caddy site, idempotent `deploy.sh`. Verified locally end-to-end.
- [ ] **Actually deploy** — blocked: SSH to VPS denied (1Password agent locked). Unlock → `./deploy/deploy.sh`
  → live at `https://app.46.202.179.28.sslip.io`.
- [ ] Prod reverse-proxy hardening for the API routes (dev-only proxies today).

## Track K — Multiplayer (`docs/design/multiplayer.md`)
- [x] Architecture (op-log + relay sequencing).
- ⏸ **Build parked by user.** Presence milestone was built + tested, then reverted — recover from commits
  `3a923ea` + `706c7cf`. Milestones 2–3 (edit-lease → full co-editing) not started.

---

## Known bugs / debt
- [x] **Cold-reload of `#/p/:pid/f/:planId`** re-opens the saved floor: EditorView takes an `openPlanId`
  prop (from the route) and, once wasm is ready, loads the SavedPlan via the existing library path
  (`getPlan` → `openSavedPlan` → `applyProject`), guarded by a ref latch + `currentPlanId` so the
  in-session pick never double-loads. E2E: generate→pick→edit→hard reload → 126 items / 64 ws live.
- [ ] **Commits unsigned this session** (1Password SSH signing agent locked). Re-sign or unlock when able.
- [ ] `e2e-core-geom.mjs` (scratchpad) asserts interior walls pushed on test-fit — stale after the
  shell-fit default; update when Track A S2–S4 land.
- [ ] Disk on dev machine ~97% full (17GB free) — occasional transient git "failed to write object".
- [ ] `ANTHROPIC_API_KEY` not always in env → Claude-driver E2E assertion is environ(not a regression).

## Immediate next (working order)
1. [x] Real-plate density — verified on the user's DWG (52 ws @ 10 m²/person).
2. [x] Track A S1–S3, S5–S7 — **full guided flow verified end-to-end (10/10) on the real DWG.**
3. [x] S4 wall-heal + cold-reload floor-open — **Track A finished (S0–S7 shipped).**
4. [x] Leaner ratios; supplier column; report branding; cloud sync; 3D themes; smarter A/B/C strategies.
5. [x] **Test-fit engine complete** — room concentration (80+ ws), AI-in-loop steering, circulation
   depth (circ 81), focus-facade, keep-existing mode, trackpad pan. Generator: 94 Rust tests.
6. **Deploy (Track J) + signed commits — both gated on the 1Password unlock (SSH denied).** ← only blocker.
7. Later: 80+ ws on *any* wing shape · workflow-aware AI (room-# refs) · richer 3D furniture · sync tombstones.
7. Upside: 80+ ws (room-concentration rework); keep-existing-partitions mode.
