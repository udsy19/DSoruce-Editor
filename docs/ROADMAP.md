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
- [~] **Batch 4 — "perfect it here" (user-reported from real use, 2026-07-11).** Root architecture finding
  ([[laiout-parity-north-star]], `docs/design/laiout-deep-research.md`): DSource had TWO parallel truths —
  the raw imported `Drawing` vs the core `Document` — so tabs rendered different floors, metrics disagreed
  (113-vs-1 workstations), plans opened tiny. Laiout has ONE canonical model; every view is a read-only
  projection. Sequenced builder→reviewer, each browser-verified:
  1. **Metrics count only generated objects** — `Component` gains a passive `reference: bool` facet
     (`#[serde(default)]` false); imported furniture stamps in as reference (visible, not counted).
     `workstation_count()` = non-reference Desks seated in a Workspace zone ⇒ **Workstations == Pax**;
     `area_per_workstation` guarded. Cost/CO2/BoQ (`cost.rs`, `stats.ts`, `takeoff.ts`) all skip reference.
     Reviewer caught `specified_cost` still summing re-bound reference prices → `!c.reference` filter.
  2. **Frame to the shell/plate on open, outlier-proof** — `frameContent` anchors to walls+components,
     admits CAD entities only if they overlap the shell, retries until the canvas is measured. Reviewer
     found shell-CROSSING entities (title-block borders, 900 m construction lines) still re-inflated the
     span to the 8 px/m floor → now clips each admitted entity to shell+margin; also un-crippled the
     retry budget (was only reset on success → a prior exhausted sequence stranded the next open).
  3. **Unify views: 2D/3D project the ONE Document** — deleted the divergent raw-drawing 3D
     (`DrawingScene3D` + dead `buildFromDrawing`) and the `planView` 2D/3D sub-toggle end-to-end; the
     "Plan" tab is now staging-only (shows while empty/mid-import, retires once a fit exists). Saved-plan
     restore never reopens a fitted plan into stale `import` mode. Verified live: 2D & 3D render the
     identical floor with byte-identical stats (80 Pax == 80 Workstations, 703 m² NIA), 0 console errors.
  4. **Passive reference drawn lightly** — reference furniture renders muted/plate-less so the generated
     fit is the primary read (`00976ed`).
- [x] **Batch 4b — reproduced the user's EXACT path (2026-07-11).** The "opens tiny" + "can't drag rooms"
  bugs only reproduce via the **candidate gallery → "Open in editor"** flow (not the shortcut editor path
  I'd tested). Both root-caused + fixed + browser-verified on that path:
  1. **Framing (`723f1d1`).** Opening a candidate mounts the editor before its container lays out;
     `resize()` bails on the 0-size container leaving the `<canvas>` at its **300×150 intrinsic default**,
     and the retry guard checked the CANVAS (300×150 ≥ 40px floor) so it never retried → framed the plan
     into an 8 px/m corner. Now framing gates on the real **container** (`viewportReady()`), and a
     **ResizeObserver** finishes a pending frame the instant the container reaches a real size (robust on
     any route, no rAF budget to expire). Verified: candidate opens at 35.5 px/m, centered (was 8, cornered).
  2. **Room drag-drop (`696c131`).** Dragging worked, but furniture-first hit-testing meant a click in a
     furnished room grabbed a desk, never the room. Now **room-first (Laiout/Canva)**: click a room →
     select+drag the whole room even over furniture; second click drills into a desk (Materio preserved).
     Verified: click on a desk selects its ROOM; second click drills to the desk; room drags.
- [~] **Batch 4c (user-reported 2026-07-11) — 4 parallel worktree agents, merged as they land:**
  - [x] **Space utilization / wall-to-wall** (`layout.rs`, `60f016c`) — was a ~11.8 m central column stranding
    ~33% of the plate. Now a whole-plate lattice fill sweeps every empty in-plate slot (module/clearance
    respected, density-capped 8.2–10.5 m²/seat), and residual pockets become explicit **Circulation** zones
    (no silent empty floor). Untyped floor 33%→11%, desk span 11.8→23.9 m, +9 desks. 116 Rust tests. Deferred:
    exact `ZoneShape::Poly` angled-wall-hugging rooms (residual gaps are Circulation for now). Pre-existing
    0.30 m min-corridor spots flagged to clean up.
  - [x] **Cost/carbon fidelity** (`cost.rs`+`stats.ts`, `af65b3d`) — was Σ(area×rate) → options within ~4%.
    Now an ELEMENT model (base shell + partitions solid/glazed per-m + doors/leaf + enclosed-room premium +
    furniture/unit; only GENERATED walls charged). Spread now +23% cost / +53% carbon, monotonic with
    enclosure — Budget/Max-seats materially cheaper+greener than Experience/Collaboration. 120 Rust tests.
  - [x] **Agentic designer + Design-with-AI UI** (`ai/designer.ts`, `ui/DesignWithAI.tsx`, several commits) —
    Claude designs program/strategy/room-mix/emphasis (GCC-curated), solver places; multi-objective option
    cards (Max seats/Cost/Collaboration/Experience/Balanced) with pax·₹·CO₂ headline + click-to-apply. See
    [[gcc-niche-and-agentic-designer]].
  - [x] **Reader premium visual pass** (`cce2120`) — filled desks/monitors/chairs (not hollow pills), soft
    rounded label pills, crisp exterior→interior→generated wall hierarchy, calmer grid, per
    `laiout-visual-system.md`. (Core/service poché hatch is a small remaining nicety — agent in flight.)
  - [x] **Boundary-conforming polygon zones — rooms too** (`ZoneShape::Poly`, `e9f0827`+`4fa0da2`) — added a real polygon zone shape
    (removed `Copy`), an exact `clip_rect_to_polygon` (Sutherland–Hodgman, no staircase on the wall edge), and
    a `conform_zones_to_plate` pass that grows CIRCULATION zones to the wall + clips to the plate → 19 polygons
    hugging the stepped/diagonal walls on the real plate; ~91 m² of near-wall wedges closed (verified at the
    user's exact top-right corner). Fixed a pre-existing NIA double-count the fill exposed. 125 Rust tests; 2D
    (+ pdf/thumb via new `util/zoneGeom.ts`) + 3D render polys. **LIMIT:** only Circulation conforms — Workspace
    tiles + enclosed rooms stay Rect (conforming Workspace overflowed NIA>GEA on tilted plates). So a ROOM
    directly on an angled wall still gaps; on this plate rooms sit off the diagonal so it's mostly circulation
    that needed it. Room-conforming (with the area invariant preserved) is the remaining follow-up.
  - Feasibility answered (research): an **agentic senior-designer** layer (Claude decides program/strategy/
    adjacency/critique; the deterministic solver does geometry) is viable as a hybrid — build after the
    core is perfected. Pure-LLM geometric placement is unreliable (misalignment/overlaps, even GPT-5).

- [x] **⚠ WRONG BUILDING UNDER THE WRONG NAME — a project's generate ran on another project's
  plate.** Found while fixing the Generate-reload bug; the most serious defect of the overhaul.
  Open project A, then open project B **without a reload**: the editor is a singleton that survives
  navigation by design, so it still held A's drawing. `GenerateStep` asked "does the editor have a
  drawing?" — the answer was yes, and it was the wrong one. B's Generate step produced three
  test-fits **of A's floor plate, scored, badged, and labelled B**, savable as B's floor.
  **THIRD INSTANCE OF ONE ROOT CAUSE: the always-mounted singleton editor.** The others:
  1. Duplicate `data-testid="category-plan"` — one component live in two trees at once (slice 3).
  2. A hidden `EditorView` still listening — `Delete` removing components off-screen (`2725490`).
  3. This one: the editor's *document* belonging to a project you have navigated away from.
  Each was found by chasing the general form of the previous. **The family is not closed** — the
  question to ask of any shared singleton is not "does it have X" but "does it have *this
  screen's* X". Fixed in `shell/resume.ts`: `resumeDrawing` tracks WHOSE drawing is loaded and
  clears on a project switch; `GenerateStep` treats "no drawing for this project" as no plate
  rather than reading a wall count that may belong to the last project.
- [x] **Reloading the Generate step fabricated three test-fits** (found while starting the component
  migration; browser repro on the real project). **Repro:** be on `#/p/:id/generate` → press reload →
  wait. **Was:** three candidate cards, "3 ALTERNATIVES · BEST 64/100", A badged *"Most seats · Best
  daylight · Best density"* — with `0` workstations, `—` density, `0%` on every card. Opening one
  saved a **108-byte empty plan** as a project floor and repointed `chosenPlanId` at it, so the
  project reopened onto "Start your plan" while the real floor sat unreferenced in the library.
  Nothing was deleted; it reads as data loss, which is the same thing to whoever it happens to.
  Four parts, each proven in the browser:
  1. **Root cause — a ref that updates a render too late.** `loadDrawing` called `setDrawing` (which
     schedules) while `testFit` reads `drawingRef.current` (which the render-time mirror had not yet
     updated) **in the same tick**. So the resume path pushed the plate and the test-fit built from
     `null` a microsecond later. `loadDrawing` now writes the ref synchronously.
  2. **The step never resumed at all.** `SpaceStep` re-pushed the persisted drawing on mount;
     `GenerateStep` did not. Now shared: `shell/resume.ts` `resumeDrawing()`, used by both.
  3. **Refuse to invent a result.** No cards and no header when there is no plate — a named
     `noplate` state with a working *Back to Space* button — and `openCandidate` will not save an
     empty snapshot as a floor. Written to hold *whatever* emptied the plate, not just this cause.
  4. **`computeWinners` never awards a superlative over an all-zero field.** Fixed at the shared
     layer (gallery **and** branded report inherit it), pinned by 3 assertions in `report.test.mjs`.
  **Plus a second defect the fix surfaced:** the editor is a singleton that survives navigation, so
  "does the editor have a drawing" was the wrong question — opening project B without a reload found
  **project A's plate still loaded and generated three test-fits on it, labelled B.** `resumeDrawing`
  now tracks *whose* drawing is loaded and clears on a project switch.
  **Tolerance for records already written** (the `backfill_seats` precedent): `pickOpenFloor` checks
  the `chosenPlanId` pointer instead of trusting it and falls back to the newest floor with real
  geometry, warning to console. Note one live record had `snapLen 108` with `metrics.workstations:
  90` — the metrics summary lied, the snapshot did not, which is why the predicate reads the
  document. 5 assertions in `plans.test.mjs`.
  **Verified:** reload now yields walls 114 / 90 desks and the same three real candidates
  (90 / 7.4, 87 / 7.6, 80 / 8.2; A "Most seats"+"Best density", C "Best daylight") — **identical to
  the slice-6b measurement, so no parity number moved.** Opening saves a 51,446-byte floor. The
  refusal state was seen firing (screenshot: `ux-audit/after/generate-noplate.png`) on a genuinely
  plate-less project — no test bypass shipped.
- [ ] **Say when the brief wasn't met — briefed seats vs placed seats in `program_fit`.**
  Surfaced by slice 6b's own measurement: brief a 14-seat boardroom, the room's table physically
  seats 12, the plan reports 12, and **nothing tells the user the brief wasn't met.** The clamp's
  direction is right (never seat more than fits), but silent under-delivery is the same genus as
  every bug this overhaul killed — the app knowing something the user doesn't. `program_fit` already
  exists to surface shortfalls (rooms requested vs placed); a briefed-seats vs placed-seats line
  belongs in it, and in the Generate step's fit readout. Workflow item, not a symbology one.

## Track A′ — UI/UX overhaul (`docs/design/ux-audit.md`, `docs/design/ui-system.md`)
Audit + design system from a full naive-user walkthrough on the real DWG. Shipping in slices.

- [x] **Slice 1 — the layout law.** `#root` is the only viewport owner; exactly one pane per screen
  scrolls; the canvas pans. Root cause of the "double scroll": `.space-preview` was
  `height: clamp(460px,74vh,880px)` inside `.wizard-body`, which is `100vh − 359px` — a viewport-unit
  box inside a non-viewport box always overflows, so the plan could never be seen whole. Wizard chrome
  359px→172px; work area 541→728px @1440×900; plan fully visible at 1440×900 and 1200×688.
  **`chosenPlanId` wired** (written since S7, never read) so a finished project reopens in the editor
  instead of restarting at "Drop the floor plate". Program leads with its builder (was ~475px below
  the fold behind anchor pins). Deleted: the fictional Review→Design→Visualise→Share stepper tail, and
  `.rail`'s superseded `overflow` — which was the only reason ToolDock needed a `position:fixed`
  re-anchoring flyout (~35 lines + 2 window listeners went with it).
- [x] **Slice 2 — canvas symbology.** 15 screen-pixel decisions in `furniture.ts` made a symbol's
  CONTENT a function of zoom; one 1.2×0.6 m table drew 0/6/8/10 chairs at 20/45/70/110 px/m under a
  tag reading "9 pax". Now: `Component.seats` (additive) resolved once by `model::seats_for` where a
  component is created; `editor/symbols.ts` (replaces `furniture.ts`) renders that value in WORLD
  units, shared by EditorCanvas + DrawingCanvas + export/pdf; DPR-snapped pen set; walls as filled
  poché at true thickness; continuous-fade LOD; tag visibility by world area. 134 Rust tests,
  `symbols.test.mjs` 46 assertions (seat count constant across 8–300 px/m, device-grid pens at DPR
  1/1.5/2/3), `mergeOrient.test.mjs` ported and green.
- [x] **⚠ DELIBERATE OUTPUT CHANGE — `zone_stats().capacity` now prefers furniture over the area
  rule.** `Zone::capacity()` (floor area ÷ m²-per-seat) is an estimate for an EMPTY room; once a room
  is furnished, Σ `Component::seats` is the real answer and is the same owner the glyph draws from, so
  the room tag and the chairs under it now agree by construction. An unfurnished zone keeps the
  estimate. `Chair` is excluded from the sum — a chair is seating *for* a table that already reports
  its seats (counting both made an 18 m² cabin report 3 pax for a 2-seat table + its chair).
  **Report/gallery KPIs moved** (measured, candidate A, real 882 m² DWG):
  | | before | after |
  |---|---|---|
  | Meeting seats (Σ Meeting+Collab capacity) | 18 | **26** |
  | Seats (= workstations + meeting seats) | 108 | **116** |
  | Density | 7.82 m²/person · 84.2 sf | **7.28 m²/person · 78.4 sf** |
  | Workstations · NIA · GEA · efficiency | 90 · 845 m² · 882 m² · 57% | unchanged |
  **Winner badges did NOT flip** — A "Most seats" + "Best density", C "Best daylight", B none, identical
  to the pre-change gallery (`docs/design/ux-audit/generate-gallery.png`). "Best density" is
  workstations/NIA and "Best daylight" is geometric, so neither reads capacity at all; only "Most
  seats" does, and the ordering held. **Takeoff is unaffected** — it never reads capacity (verified by
  grep: no `capacity`/`pax` reference in `export/takeoff.ts`). `report.test.mjs` stays 43/43 because it
  asserts the INVARIANT `seats == workstations + meetingSeats`, not golden values — it is not a
  byte-identical guard, and this change is why that distinction matters.
- [x] **`.dsource` / IndexedDB forward-compat for `seats`.** `#[serde(default)]` alone would have left
  every existing saved plan on the old area rule while new plans used furniture seats — the same
  building reading two ways depending on when it was saved. `Document::backfill_seats()` now runs on
  `restore` and `from_snapshot`, resolving absent seats through the same `seats_for`; idempotent and
  0 for things nobody sits at. Existing libraries reopen with correct pax, not 0. Rust test
  `backfill_resolves_seats_on_an_old_document`.
- [x] **Two chronic test failures fixed, not reported.** Dropped the 150 ms *wall-clock* assertion from
  `real_building_plate_spreads_the_program` — it passed in isolation and failed at 151–215 ms under
  parallel load, training everyone to read red as noise; correctness assertions kept, timing belongs in
  a benchmark. `dxf.test.mjs` pointed at `samples/furniture-plan.dxf`, which `.gitignore:35` excludes —
  so it had never run on any fresh clone; it now derives the fixture from the committed DWG via
  `dwg2dxf` (the same LibreDWG converter `/api/dwg` uses) and fails loudly with install instructions if
  the converter is missing. **Rust 134/134, JS 22/22 — the suite is fully green for the first time in
  this work.**
- [~] **Slice 3 — navigation hierarchy.** The editor had NO route back: the brand and project name
  were plain `<span>`s, so once a user opened a fit the browser Back button was the only exit. Now a
  **breadcrumb** (`DSOURCE / <project> / <floor>`) where every segment is a real link, verified live.
  **Property joined the stepper** — `CreateProject` rendered its own full-screen chrome, so step 1
  showed as permanently pre-ticked for a screen the user was never shown as a step; it is now a step
  body under `WizardChrome`, whose Next submits the form through the HTML form-owner attribute (no
  state lifted), disabled with the reason "Enter a property name to continue" and the one required
  field marked as such. **Deleted the four inert Canvas rows** (Units/Grid/Axis/Background — read-outs
  of hard-coded constants) **and the shipped apology** under them ("…the rest are display-only until
  per-canvas settings land"); the card keeps Presentation, which works. Inspector 2119px→1907px.
  **Duplicate `data-testid="category-plan"` fixed** — one literal on a shared component rendered in
  two live places at once (Space step + the hidden-but-mounted editor), which broke strict
  `getByTestId`; now a per-mount `testId` prop. Rust 134/134, JS 22/22, `make build` clean.
  **PARTIAL — the 3D half is implemented but NOT visually verified.** Panels/rail/status bar follow
  the mode (in 3D: 2D-only cards hidden behind a pointer to the on-canvas toolbar, tool dock disabled
  with "Switch to 2D to draw", 2D cursor/scale read-outs hidden). WebGL is unavailable in this
  headless browser — instantiating `Scene3D` throws and unmounts the app — so only the 2D side is
  browser-proven. Consistent with the existing Track H note that 3D needs a real GPU. Verify on a
  real display before treating this as done.
- [x] **A hidden EditorView must not listen — data loss on the primary flow.** Chasing the general
  form of the duplicate-testid bug (one component live in two trees) found the load-bearing version:
  EditorView is deliberately never unmounted, so during EVERY wizard step it is alive behind the step
  with `display:none` — and its window-level listeners kept firing on a document nobody could see.
  Reproduced live on the Space step:
  | Key | Before | After |
  |---|---|---|
  | `Delete` / `Backspace` | **deleted a component, 133 → 132**, no click, no feedback | 222 → 222 |
  | `⌘S` | **wrote a .dsource file** from the upload screen | not bound |
  | `p` | toggled Presentation on the hidden canvas | false → false |
  | `Escape` | cleared the hidden selection | 447 → 447 |
  | `⌘K` | opened the editor's command palette over the wizard | does not open |
  | `window.__dc` | resolved to the hidden 300×150 editor canvas | the visible 728px one |
  The `Delete` case is the serious one: the persisted record still read 133, so the loss surfaced
  later on the next save or export. **The fix is structural, not a guard per handler** — a guard
  leaves the next handler someone adds broken by default. `EditorView` takes `active` (AppShell's
  existing `editorVisible`) and the listeners are NOT BOUND when hidden; `EditorCanvas.setActive()`
  unbinds its own. Transient overlays (command palette, help) close on deactivate — they were React
  state on a never-unmounting component, so an open palette survived navigation and was still open on
  return. `window.__dc` is now a getter resolving to the VISIBLE DrawingCanvas of however many are
  mounted, replacing three ad-hoc names (`__dc`/`__spacedc`/`__programdc` — the previous answer to
  the collision was to add more names). Control verified: every shortcut still works in the editor.
  Rust 134/134, JS 22/22.
- [x] **Slice 4 — workflow repairs.**
  - [x] **⚠ DATA LOSS, not a naming problem — edits to an open floor were never saved.** This was
    filed as "Save/Open ambiguity against IndexedDB autosave". It was not an ambiguity. **No code
    path wrote an edit back to the floor record.** Topbar "Save" was `triggerDownload()` (a .dsource
    file); autosave (`noteChange`) wrote only to the capped `history` undo ring; the `plans` record
    was written solely by openCandidate / Library "Save current" / rename / assign. Measured on the
    real DWG: **133 components → delete one → 132 → press "Save" → a file downloads → reload → 133.**
    The app silently discarded the user's work while showing a button that implied it hadn't. That is
    the defect that ends the product with a real user, and the label was the disguise, not the bug.
    Fixed: a floor opened from a project saves like a document (debounced write-back of the snapshot
    to its own record, keyed on the open id, skipped if the record was deleted underneath); the
    history ring is untouched so undo/version-restore still capture every step. Verified
    133 → 132 → reload → **132**. Autosave is deliberately the default — no explicit Save button, per
    the decision that a Save button in a browser CAD tool teaches users their work is only
    conditionally safe. The two file buttons became **Download** / **Open file…** so they describe
    what they do. **If you are skimming this line, do not read it as a copy tweak.**
  - [x] **⚠ PARITY NUMBERS MOVE — a briefed room now seats what it was briefed to seat.**
    Fourth instance of one structural bug: **a brief disagreeing with its own output.** (The others:
    the room tag's pax vs the chairs drawn; `DESK_SIZES` metres vs a hand-typed cm label; the Program
    summary promising 75 desks while the generator laid 80.) This is the one the user reads first.
    The Program builder offers "2 / 4 / 6 / 8 person" team rooms, but `furnish_room` sized the table
    to the ROOM, so its perimeter seated more: **team-2 → 4, team-6 → 8, team-8 → 10.** Three of ten
    room types. Over-delivering is still a plan that does not match its brief — the headcount maths,
    the meeting-seat total and the density all ran on the briefed number.
    Fixed by collapsing three representations into one: `RoomReq.seats` (additive, serde default 0)
    carries the INTENT to the generator; `furnish_room` clamps the table's occupancy to it (never
    above what physically fits); and the team-room label is **derived** from `seats` — `'6 person'`
    was a hand-typed restatement of the field beside it. Rust test
    `briefed_room_seats_match_the_brief` pins it (135 tests).
    **MEASURED as a matched A/B on the real DWG plate** (`real_plate_doc()`, the 843 m² multi-wing
    trace of the user's file) with the exact program the app sends: identical geometry, identical
    seeds, the only difference being whether the brief's `seats` reaches the generator — `seats: 0`
    reproduces pre-fix behaviour exactly, so the pair is controlled rather than observed. 3
    strategies × 3 seeds, all 9 cells agree: the briefed 8-person team room's table **10 → 8**;
    every other placed table unchanged, including the boardroom (brief 14, table seats 12 — the
    clamp lowers, never raises). `meetingSeats` **26 → 24**, `seats` A 111→109 / B 109→107 /
    C 106→104, workstations unchanged. **"Most seats" argmax stays A in both arms — no badge
    shifts**, and it can't: "Best density" is workstations/NIA and "Best daylight" is geometric, so
    neither reads capacity. On the live 882 m² DWG the shipped gallery reads A 90 ws / 7.4 m²·seat
    (NIA 848, meetingSeats 24); the same brief pre-fix computes 7.31 — density up ~1.8%.
    Occupancy render census (all paths checked, per the "find all three" requirement): canvas room
    tag and report `meetingSeats`→seats→density→"Most seats" both read `zone_stats().capacity` (one
    owner); Program summary reads `ROOM_DEFS.seats` (the brief); takeoff and 3D render no occupancy.
    `stats.ts` `zonePax` is a **deliberately different metric** — Pax == Workstations, enclosed-room
    capacity intentionally excluded so Pax can't disagree with Workstations — and is left alone.
  - [x] **Slice 6c — the mirrors that weren't mirrors.** From the values-not-names sweep:
    - **`MIN_AREA_PER_WS = 6.0 // planning norm (see layout.rs)` was a false citation.** No such
      constant has ever existed in `layout.rs`, and it was the wrong quantity besides: the scorer
      judges m² per **seat** (desks + meeting capacity) on a 4.5/8/12/20 ramp, not m² per desk. So the
      AI consequence preview warned users off layouts the engine liked, **in the engine's name**.
      Fixed at the ownership level, not the comment level: `layout::density_of` now carries the whole
      verdict (extracted from `score`, so the scorer and every consumer read one opinion), exported as
      `Editor::density_score()`, and `ai/engine.ts` reports the core's rating instead of holding a
      second threshold.
    - **Corridor range `0.9–3.0` stated five times** — two executable clamps (`refine.ts`,
      `designer.ts`) and three prose copies in the schemas a model reads. A model told one range while
      a clamp enforces another gets silently rewritten: a lie with no error message. Not core-owned
      (it's AI-input policy, not geometry) → one `CORRIDOR_M` in `llmSchema.ts`, both clamps import
      it, all three descriptions interpolate `CORRIDOR_RANGE_TEXT`.
    - **`DOOR_D` / `DOOR_W` exposed** (`door_depth()`, `door_width()`); `archTools.ts`'s own
      `LEAF_DEPTH = 0.15` / `DOOR_DEFAULT = 0.9` deleted. A hand-drawn door and a generated door are
      one object; they had two authored sets of dimensions.
    - **`web/src/coreParity.test.mjs`** — the drift guard for mirrors that are genuinely unavoidable
      (a canvas frame can't await wasm per glyph; a tool schema must be literal). Parses `SEAT_PITCH_M`
      / `HEAD_SEAT_MIN_M` out of `model.rs` and the `SpaceKind` enum out of `layout.rs`, and fails on
      divergence. Proven in both directions (perturbed the Rust value → red; restored → green).
    - Rule written into `ui-system.md` §3.6.2: **a provenance comment is a claim to verify, not
      documentation.** Name-grep finds honest copies, value-grep finds anonymous ones, only reading
      finds a false citation.
  - [x] **All five remaining slice-4 items shipped in `e2374fc`** — this line was stale bookkeeping,
    caught by auditing the tracker against the tree at closeout rather than by ticking it. Verified
    in the code, not from the commit message: project delete confirms and states the floors' fate
    (`ProjectLibrary.tsx`); the wizard-owned plate replaces silently while a user-driven import into
    a hand-built document asks first (`App.tsx`, with the distinction written down); unit drift fixed
    at its source (`util/units.ts`, one `SF_PER_M2`); `disabledReason` wired at all three wizard
    gates ("Enter a property name to continue" / "Upload a floor plan to continue" / "Loading your
    program…"); the raster-import line matches `import/rasterImport.ts`.
- [x] **Slice 7 — the six-component style migration.** `SelectionCard` · `CategoryPlan` ·
  `LibraryPanel` · `LayersPanel` · `PlacePalette` · `CandidateGallery`, one commit each, ordered by
  RISK (state-encoding first) rather than size. **71 inline style objects and 140 hard-coded hexes
  removed.** Every conditional style path was enumerated from the source and rendered in a
  before/after state matrix (`ux-audit/tokens-{before,after}/<component>/`) through the app's own
  module graph; state variants became class modifiers (`.is-active`, `.is-selected`, `.is-below`,
  `.is-collapsed`, `.is-indented`, `.is-num`), never merged style dictionaries at the call site.
  **Measured, not eyeballed** — `scripts/pixdiff.py` (new) reports differing pixels, the worst
  per-channel delta and where. **Four real defects the pass surfaced:**
  1. **11 dead `var(--accent, #E8A13C)` fallbacks** in `LibraryPanel` — amber from before the accent
     went blue. Never rendered; had `--accent` ever failed to resolve, half the panel would have gone
     amber. Same species as slice 5's 40 never-loaded Plex Mono references.
  2. **The AI badge really was amber** (`rgba(232,161,60,0.12)` — a literal, not a fallback), so it
     rendered **blue text on an amber ground**: the text followed the variable when the accent moved
     and the background, being a literal, stayed behind. The one intentional colour change here.
  3. **`CategoryPlan`'s bound-dot used `var(--accent)`** for a CANVAS legend. Zero pixels (same hex
     today) — the point is a rebrand must not recolour a data legend (§4.1.1, marker-pin precedent).
  4. **A 5px→6px radius my own shared rule introduced** on the history Restore button, caught by the
     diff as a symmetric border transition, not by eye.
  **Three unapproved colour drifts of my own were caught and reverted before commit**
  (`#1e2329`→`--text`, `#eef0f3`→`--hairline`, `#6b7280`→`--muted`): 4–15/255 each, invisible in
  isolation, thousands of pixels in the diff. Snapping off-ramp inks to the ramp is a real
  improvement and a SEPARATE decision — a refactor does not get to make it quietly.
- [x] **Final verification pass** (`make build` clean · `cargo test -p ds-core` 135/135 · JS 24/24 ·
  `coreParity` green). Browser-verified on the real 882 m² DWG, pre-flight before every check:
  - **Zoom sweep** 8 / 20 / 45 / 80 / 140 px/m (`ux-audit/after/zoom-final/`). Symbol CONTENT is
    constant: the same TEAM ROOM tags "15 m² · 6 pax" and draws exactly 6 chairs at 45 and at 140;
    its neighbour reads 10 pax and draws 10. Wall poché at true thickness, door swings, no pop.
  - **DPR 1 and 2** — DPR forced at the seam the canvas reads (`window.devicePixelRatio` →
    `resize()`), witnessed at both; hairlines crisp, symbol content identical.
  - **Scroll ownership**, per route: `#/` 0 panes · `#/new` 0 · space 1 (`.space-detail`) ·
    program 1 (`.program-step`) · editor 1 (`.inspector`). `document.scrollingElement` never
    scrolls on any route — the page itself is not a scroll owner anywhere.
  - **Reload on every route** (new to the checklist, because the Generate finding proved reload is a
    mainline action): none fabricates, blanks, or loses state.
  - **Deliverables agree**: report `meetingSeats` 22 == Σ `zone_stats().capacity` 22 == the canvas
    tags; takeoff desk quantity 92 == report workstations 92; the takeoff still renders no occupancy.
- [ ] **PROPOSED (deliberate, not a side effect): snap the off-ramp inks to the ramp.** The six
  component migrations preserved every colour byte-for-byte, including values that sit a few units
  off the ink ramp. Measured with `scripts/pixdiff.py`, each is invisible in isolation and thousands
  of pixels wide: `#1e2329` → `--text` (#1a1d21, Δ4–8/255, 8,956 px in `.selcard` alone),
  `#eef0f3` → `--hairline` (#e6e8ec, Δ8), `#6b7280` → `--muted` (#5c6670, Δ15 — the largest, on the
  AI verdict line). Doing this is a real improvement; doing it inside a refactor would have been a
  design change smuggled in as cleanup. Take it as its own change, with before/after captures.
  **RESOLVED and shipped, the one piece that had a ruling:** `#7a828c` — *secondary text is
  `--muted`, no new ramp step*. `.selcard-sub` → `--muted` (**10,037 px**, the subtitle darkens by
  30/255 — a deliberate, ruled change, not a drift). Its twin in `CategoryPlan` turned out to be an
  **eyebrow**, not secondary text, and the app already has `--eyebrow` for exactly that role — every
  other eyebrow in the stylesheet uses it — so it took `--eyebrow` (**4,581 px**). No `#7a828c`
  remains anywhere in `web/src`. The other three inks above stay proposed.
- [ ] **Expose `keepConfirmed` — "regenerate, but keep this."** The core has supported freezing
  Confirmed components across a regeneration since S6 (`autoGenerate(..., { keepConfirmed })`), and
  **no UI anywhere reaches it.** The whole loop is generate → evaluate → regenerate, while an
  architect's actual response to a test-fit is "move the boardroom to the corner, keep the rest".
  The closest we offer is anchor pins *before* generation and hand-editing *after*. Named in the
  tone check (`docs/design/manual-session.md` §3) as the second of the three defects that would
  embarrass us in a client demo — and unlike the other two it is a workflow gap, not a generator
  one, so it belongs here rather than in Track B.
- [~] **Awaiting the user's display** (`docs/design/manual-session.md`): 3D panel states and the
  naive-user walkthrough. Everything else in Track A′ is verified.
- [x] **Slice 5 — typography + tokens.** Shipped: the numeric face on quantitative data (`.num`,
  tabular figures, −0.02em), amber resolved out of UI chrome, the never-loaded-font guard
  (`ui/fonts.test.mjs`) — extended in the final pass to check WEIGHTS, which immediately caught
  `.sheets-title` asking `--font-display` for a 600 the face does not ship.

### Method note — trace the value, don't rename at the render site
Two of the three worst defects in this overhaul were filed as cosmetic and turned out to be
correctness bugs, both found the same way: **follow where the value actually comes from before
touching how it is displayed.** The room tag's "9 pax" led to a genuine dual-source (area rule vs.
furniture seats, §Track A′ slice 2); "Save/Open ambiguity" led to silent data loss (above). Apply it
to anything that looks like a labelling ticket — a unitless "140 × 70" in a product whose core is
metres is a question about where the unit was dropped, not about appending "cm" in the JSX.

## Track B — Test-fit generator quality (`docs/design/testfit-pro-quality.md`)
Make generated plans read like a senior architect's work, not a diagram.

> **Two of the three defects named in the overhaul's tone check
> (`docs/design/manual-session.md` §3) land here, with measurements, and both are the
> generator-search bake-off's (ADR 0005) to resolve — not UI work:**
> 1. **Three strategies that differ by under 5%.** On the real 843 m² plate the Open / Balanced /
>    Cellular candidates scored **111 / 109 / 106 seats** (matched A/B, 3 seeds each). Options that
>    close are one option with noise, and the gallery's premise is that they are genuinely different
>    ways to solve the brief. Whatever the bake-off picks has to produce *divergent* plans, not just
>    better-scoring ones.
> 2. **Irregular and small plates are handled by added cases.** The zero-desk rescue (rotated lattice
>    for angled plates) and `SMALL_PLATE_FIELD_AREA` were each added after a real failure. The
>    failure mode is not a crash — it is a plan that is quietly worse on a plate that does not suit
>    the packer, which in front of a client with their own floor is a coin toss.

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
- [x] **Quantity takeoff Excel** — superseded by the 12-sheet parity workbook below;
  `export/takeoff.ts`'s own 4-sheet xlsx layer and wall classification are deleted.
- [x] DXF · [x] PDF sheet · [x] IFC (BIM) · [x] OBJ+MTL · [x] PNG · [x] CSV.
- [x] **Photoreal renders** — shipped (was deprioritized as "needs a path tracer"; delivered instead
  with an offscreen tier: Neutral tone mapping → GTAO → SMAA, VSM soft shadows). `export/roomRenders.ts`.
- [ ] **RVT** — native Revit is proprietary; we export IFC (imports to Revit). Superseded in practice by
  the self-hosted `/share/<id>` GLB viewer below, which is what the Revit sample was actually for.

### Qbiq output parity — the deliverable pack (10/10 acceptance gates green)
Reference decomposed to machine-checkable specs in `docs/reference/qbiq/spec/`; gates in
`scripts/gates/` (`run-all.sh` is the only trusted signal). One `Editor` state feeds every artifact,
so the workbook, plan, renders, video and viewer cannot disagree.
- [x] **12-sheet formula-wired QTO workbook** — `export/qtoWorkbook.ts`. qbiq's exact sheet order;
  `General` is the only place a number is stated, everything else reaches it by reference/VLOOKUP/SUMIF
  at **100% formula density** (300/300 body cells). Verified live: +1000 on a unit price moved the total
  by exactly 1000 × 2.60 m × 158.70 m via LibreOffice recalc. Embeds the plan + per-room thumbnails.
- [x] **General SpreadsheetML writer** — `export/workbook.ts` (`buildXlsx`). Formulas, drawing layer
  (two/oneCellAnchor + EMU), gridline control, col/row sizing, merges, data validations, ARGB fills.
  Hand-rolled, so the export stays client-side; `takeoff.ts` migrated onto it, zero duplicate paths.
- [x] **Core quantity truth** — `crates/ds-core/src/quantity.rs`. Geometric `WallType` classification
  (NOT the `generated` flag — an imported DWG has every wall `!generated`), per-type lengths, door
  counts, room areas, wall heights. Half Drywall reports an honest 0.00 m.
- [x] **Highlighted plan + room thumbnails** — `export/planGraphic.ts` / `roomThumbs.ts`, deterministic
  (byte-identical re-render), colours imported from `spec/palette.json` so legend and linework can't drift.
- [x] **Per-room renders** — four 3840×2160 stills on a shared material theme (`three/materialTheme.ts`),
  floor materials resolved through `FINISH_SPEC` so renders and workbook agree.
- [x] **Walkthrough video** — `export/walkthrough.ts`, 43 s H.264 1080p60 (CRF 15), circulation-graph route,
  branded title card + in-scene screens.
- [x] **Shareable web 3D viewer** — `/share/<id>` serving a GLB into `web/viewer.html`. No Autodesk,
  no token, no CDN. `deploy/shareStore.ts` is one implementation shared by dev middleware and prod.
- [x] **One-action pack** — `export/deliverablePack.ts`: one click → xlsx + ground truth + plan + 4
  renders + mp4 + share link. Two sinks (server → `out/`, zip → download); in-browser H.264 via
  WebCodecs with a hand-written MP4 muxer (`export/mp4.ts`) when no GPU host is available.
- [x] **Facade glazing + meeting-room seating** (`reports/K-1.md`, defects D4/D5/D8).
  `layout::glaze_facade` models the facade as pier · glazed band · pier, so **Perimeter windows** bills
  **123.20 m** (was 0.00; reference 125.47) and the plan draws the same run it bills.
  `layout::seat_around_table` seats every meeting/team/board/collab table with REAL `Chair` components
  and `editor/furniture.ts` drew its last implied seat, so meeting rooms report **headcount 8**, not 0.
  `Document::zone_index_at` buckets by smallest containing zone, so identical rooms report identical
  headcount (whole-plan 67 → 112).
- [x] **Adversarial QA — three Judge rounds** (`reports/defects-{1,2,3}.md`). Rounds 1 and 2 each found
  BLOCKERS against a 10/10 board, both times in a **gate**, both proven by falsification. The recurring
  root cause was a gate trusting metadata supplied by the thing it tests: the producer chose first
  *whether* its floor was checked, then *where*. G6 now segments the image itself and reads no producer
  metadata (moving every `floorRect` onto a wall and deleting the field give byte-identical output).
  Round 3 declared the pack **shippable, no blocker** — the first round where a fix survived
  falsification instead of relocating.
- Follow-ups (tracked in `reports/ORCHESTRATOR_LOG.md`, defect IDs in `reports/defects-*.md`):
  - **Renders remain the weakest deliverable (D3/E6)** — ~2.0× the reference's flatness and 0.43× its
    edge density; the video has a 40.4%-blown frame at t=22.2 that G7 structurally cannot see.
    **ROUTED, not to be fixed ad hoc:** closing this needs a richer 3D asset library, not better
    framing, which makes it a candidate-evaluation problem — which asset source or rendering approach
    ports cleanly, under what licence, scored against fixtures defined *before* the candidates run.
    Bolting assets on now would short-circuit that evaluation and manufacture a post-hoc metric.
    It belongs in the materials/rendering bake-off track (downstream of the IFC pre-work); that track
    is not in this repo, so the fixture targets are pre-registered here to survive the handoff:
    **flatness 2.0× → ≤1.2× the reference; edge density 0.43× → ≥0.75×; colour count 734 → ≥1500**
    (reference: flat 22.0, edge 34.6, colours 2439; ours at close: 44.8 / 14.8 / 734).
  - **`Conference_room` is a program-fit problem, not a rendering one.** A 2.9 m table and 8 chairs in
    a 5×4 m room leaves no camera solution at 1.6 m eye height, and it is why only 3 of 4 renders can
    evidence their floor. Score it against the generator's **furnishing rules** (oversized furniture
    selected for the room), not the render pipeline.
  - **Only 3 of 4 renders evidence their floor, with zero headroom**, and the camera that fixed
    `Conference_room`'s composition is what cost the fourth (7.01% on the prior camera).
  - [x] **E7 closed** — the plan billed furniture it didn't show. Root cause was NOT a symbol-coverage
    gap (`drawFurnitureSymbol` already has a footprint `default:`); labels drew last and `placeNear`
    de-collided them against other labels only, painting over 12 px chairs. New **G11** asserts both
    emission (multiset re-derived from core state) and **visibility in the delivered pixels** — an
    emission-only gate would have passed while the defect persisted. It found 8 occluded rooms where
    the defect report found 4.
  - Gate coverage hardened (G4 14→18, G6 43→53 checks): G6 gained a ground-coverage assertion and
    pairwise dHash room distinctness; G4 now reads the model and asserts billed ⇔ drawn.
    **Residual limits ACCEPTED — do not invest further** (`reports/P-1.md` has the numbers): a
    ≤21%-of-frame mid-band repaint survives G6, and G4 tolerates *erasing* ~50% of window pixels.
    The threat model is regression and drift in our own code, not a producer forging outputs;
    perceptual gates that catch a plan collapsing to a 19×3 px smudge are doing their job. The
    producer-metadata class was different — the gate was measuring nothing — and is now closed by
    `.claude/rules/gate-independence.md`.
  - Headless-vs-in-app divergence: `render-rooms.mjs` passes `--lamp 2`, `deliverablePack.ts` none.
  - [x] **Drawing-set defect closure — CLOSED.** All four originally-reported defects plus four more
    the gates found (see `reports/sheets-defects-{1,2}.md`, `reports/SHEETS-FINAL.md`). The drawing
    set now has standing cover it never had: a deterministic 36-sheet harness (`scripts/sheets/`)
    and gates SG1–SG6 (`scripts/gates/sheets/`), written **before** their fixes and watched to fail.
  - **Drawing-set defects still OPEN — all PRE-EXISTING, proven by measurement at three commits, not
    introduced by the closure work.** Routed here rather than quiet-fixed (mission law):
    - **D-P (major): 107 room-name / area / dimension strings print across drawn wall and door-swing
      ink** on the 12 plan sheets. Measured **103 at `1a2b8d5` → 106 after S2/S3 → 107 now**, with
      **106 of 107 identical coordinate-for-coordinate** across the change. Root cause is precise and
      already known: **`sheetSet.ts:1021` starts the plan's occupancy EMPTY and never seeds it with
      the base raster's ink**, whereas `planGraphic.ts:300-304` does — the sheets never received E7's
      landing fix. That asymmetry is the whole defect; closing it is a contained change plus a gate.
    - **D-Q (major): 14 room names/areas print OUTSIDE the building footprint** (up to 33 pt),
      interleaved with the overall dimension string on testfit A.02; four `14.0 m²` struck through by
      the shell wall on testfit A.01.
    - dwg **A.01** is the worst sheet (labels over demolition hatch); dwg **A.03**'s ceiling grid and
      fixtures are not clipped to the irregular building polygon; **A.08** is ~95% blank; **A.07**'s
      cards carry placeholder `CHA`/`DES`/`TAB` thumbnails.
    - **The drawing set is therefore not yet shippable as a CONSTRUCTION set** — it is shippable as
      the client-facing deliverable this program targets. Treat D-P/D-Q as the entry cost for the
      former.
  - Tier-2 3D room thumbnails; round-1 minors D6, D10, D12–D17.
- [x] **Report cover branding + A/B/C differentiation** — client logo focal on the cover, project/address/
  floor laid out qbiq-style; per-alt accent chips + winner ribbons (shared `computeWinners` w/ the S7
  gallery); summary highlights each metric's leading alternative. (Building *photo* still N/A — no source.)

### Branch reconciliation — `export` ↔ `main` (proposed resolution recorded BEFORE the merge)

`export` is 20 commits ahead; **`main` is 59 ahead**; 19 files changed on both sides, `sheetSet.ts` and
`servicesSheets.ts` above all (this mission rewrote them heavily), plus the wasm binaries. **Do not
resolve this with `git merge`.** Two of the conflicts decide *what the plan fundamentally is*, and a
merge would settle them as a side effect of conflict resolution, by whoever happened to be driving.
The law file is already safe on `main` (`869d652`), so there is no urgency forcing a bad merge.

**Proposed resolution — mode separation, not adjudication.** These are two rendering *intents*, not two
opinions about one plan, and neither branch is wrong:
- **Circulation.** `main` `19a7837` "corridors become ground, not figure" is correct for the
  **architectural drawing set** — in construction drawings circulation is residual space and filling it
  is bad drafting. `export`'s pink wash is correct for the **QTO deliverable plan**, a client-facing
  graphic where circulation is a *billed, highlighted quantity keyed to a legend*.
  → One renderer, two named presentation modes (`architectural` / `deliverable`), **each with its own
  gate scope**. G4's ">2% pink pixels" is a requirement *on the deliverable mode* and must be scoped to
  it. G4 firing on the architectural plan would be the category error the pre-registration law
  prohibits: **a metric is only readable for the class it was defined over.**
- **Style gate.** `main`'s `bench/style-gate.mjs` bans hex/rgba outside `planStyle.ts`; `export`'s
  `qbiqPalette.ts` reads `palette.json`. Both encode the *same* value — single source of styling truth —
  and disagree only about where that source lives. But `palette.json` is **spec**, extracted from the
  reference artifact, which under the external-anchor law is exactly the kind of source a gate should
  trust. → Make the qbiq palette a **sanctioned token source**: registered alongside `planStyle.ts` as a
  second permitted origin, or folded in as a named theme. The sensor's intent survives intact; its
  allowlist grows by one spec-backed entry.
  → Restates the problem as *"one branch's sensor hadn't been told about the other's sanctioned
  anchor"* — a much smaller mission than "two branches contradict by design".

Still real work: the 19 dual-touched files need careful merging, `sheetSet.ts` most of all, and both
gate suites plus `main`'s sensors must pass afterwards.

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
- [x] **Image import with scale calibration — SHIPPED** (this line said "deferred, CAD-only v1" long
  after it landed). `import/rasterImport.ts` decodes a PNG/JPG/WebP to a backdrop; the Space step's
  **Set scale** tool draws a reference line over a known dimension, takes its real length, and the
  whole image snaps to metres, after which area-select and plate tracing work over it exactly as they
  do over CAD linework. The upload input accepts `.png/.jpg/.jpeg/.webp` and the drop zone says so.
- [ ] **PDF** import specifically — still deferred. `rasterImport.ts` documents the route (pdf.js
  renders a page to a canvas that feeds straight into `makeBackdrop`, bundling under Vite via the
  worker-URL pattern, so no runtime CDN); it needs the `pdfjs-dist` dependency added.

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
- [~] Workflow-aware AI: reference rooms by number ("tell me about room 502"), program-from-brief. Agent in flight.
- [x] **Agentic senior designer — SHIPPED** (`ai/designer.ts`, `ui/DesignWithAI.tsx`; `docs/design/agentic-designer.md`).
  Claude designs the program/strategy/room-mix/emphasis (GCC-curated, NBC 2016/BCO/RICS), the Rust solver
  places geometry (hybrid — no LLM coordinates). Multi-objective option cards (Max seats / Cost / Collaboration
  / Experience / Balanced) with pax·₹·CO₂ + rationale + click-to-apply; forced tool call (no truncation),
  bounded-concurrency + retry. Verified live vs real Claude on the real plate. See
  [[gcc-niche-and-agentic-designer]]. Follow-up (Agent A, in flight): generator honoring the explicit room
  mix so options differentiate more.

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

## Known non-guards (tests that pass for weaker reasons than they appear to)
Recording these so nobody rests a parity gate on something that isn't holding it.

- **`report.test.mjs` (43/43) is an INVARIANT suite, not a golden-value guard.** It asserts
  relationships — `seats == workstations + meetingSeats`, `seats > 0`, radar axes normalise — not
  absolute numbers. It stayed green through the slice-2 capacity change that moved meeting seats
  18→26 and density 7.82→7.28 m²/person, and would stay green through almost any capacity change.
  Treating "report 43/43" as proof the deliverables are unchanged is treating it as something it has
  never been. A real regression gate needs golden KPI values (or a checked-in reference PDF hash).
- **`dxf.test.mjs` depends on LibreDWG (`dwg2dxf`) being installed.** It derives its 15 MB fixture
  from the committed DWG rather than committing the derivative (`.gitignore:35`). This is the same
  dependency that degrades to a 503 on Vercel (`deploy/VERCEL.md`). It is designed to fail with an
  explicit "install libredwg" message rather than an obscure ENOENT — if this ever shows up in CI,
  that message is the answer, not a mystery.

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
1. [x] Real-plate density — **RE-MEASURED 2026-08-04**; awaiting first human confirmation.
   The old figure divided by 881.5 m², a boundary the app inferred and asserted without saying so
   (~half its perimeter rested on no linework). With the ADR 0003 ladder the same DWG proposes
   **930.1 m²** via `partition-envelope`, containing 525/533 furniture items.
   **Provenance of that acceptance: produced by the ladder and confirmed through the wizard path in
   an AUTOMATED session — no human has confirmed it yet.** When one does, update this entry and let
   that be the calibration log's first genuine row (the log records humans only — ADR 0003).
   Measured on that plate, best of 6 seeds, NIA 903.6 m², with the program each figure assumes:
   • **92 ws @ 9.84 m²/person** under the STANDARD program (professional 8–12 band).
   • **140 ws @ 6.45 m²/person** ceiling under a DENSE program (desks=200 requested).
   The old "52 ws" was program-limited, not plate-limited — it recorded what one program asked for,
   not what the plate supports. Both figures carry their program precisely so this entry does not
   repeat that error.
2. [x] Track A S1–S3, S5–S7 — **full guided flow verified end-to-end (10/10) on the real DWG.**
3. [x] S4 wall-heal + cold-reload floor-open — **Track A finished (S0–S7 shipped).**
4. [x] Leaner ratios; supplier column; report branding; cloud sync; 3D themes; smarter A/B/C strategies.
5. [x] **Test-fit engine complete** — room concentration (80+ ws), AI-in-loop steering, circulation
   depth (circ 81), focus-facade, keep-existing mode, trackpad pan. Generator: 94 Rust tests.
6. **Deploy (Track J) + signed commits — both gated on the 1Password unlock (SSH denied).** ← only blocker.
7. Later: 80+ ws on *any* wing shape · workflow-aware AI (room-# refs) · richer 3D furniture · sync tombstones.
7. Upside: 80+ ws (room-concentration rework); keep-existing-partitions mode.

## Post-merge — three semantics on one perceptual channel

`--accent-amber` (#E8A13C) and `--review` (#e0952b) are **dE76 5.2** apart —
just above the indistinguishability threshold, against 47.8 to `--danger` and
131.6 to `--accent`. Measured and captured side by side in
`bench/style-progress/r5-caution-adjacency.png`: the boundary between them is
barely perceptible, and the restricted-area note reads as the same hue as a
selected element beside it.

After R5 the product spends **three semantics on one narrow amber band**:
caution (`--review`), live selection and AI verdict (both `--accent-amber`).
Every sensor in the system is VALUE-keyed, so nothing will ever object — a
neighbouring hue carries the semantic confusion without tripping anything. That
is Face 15's lesson at the perceptual layer: matching a value certifies the
value, not the perception.

Not a merge blocker and not `.area-restricted-note`'s problem — using the
system's declared caution token was the right call for that site. The open
question is the caution token's HUE, and whether selection and AI-verdict should
share a channel at all. A Laiout/qbiq-benchmark polish item.

## Track M — Circulation semantics + figure/ground

Making negative space read as floor, not as "Circulation" (`docs/audits/circulation-figure-ground-audit.md`).

- [x] **Phase 0 — audit.** Live-build verification on the real DXF, render-path inventory, core
  inventory with the measured network/residual split (125.23 vs 170.66 m²), `circulation.rs` reuse
  assessment, pre-registered predictions. Falsified three brief premises (thumbnails flood grey not
  blue; the PDF path is already correct; `report.ts` already implements the qbiq metrics card) and
  found two unlisted hazard sites (`zone_index_at`, ~35 tsc-invisible `'Circulation'` compares).
- [x] **Phase 1 — core semantics.** `ZoneType::Unassigned` + `Zone.origin{Drawn,Residual}` (replacing
  the user-editable `label == "Circulation"` seam); `circulation::walkable_grid` reusing ONE
  rasteriser; the classifier (≥50% of a pocket on ≥1.2 m clear cells AND 4-connected to the drawn
  network); wasted-floor score penalty; `zone_stats_published` as the single fold boundary. 165 Rust
  tests. On the DXF plate: Circulation 295.89 → 231.43 m², Unassigned 64.47 m², workstations 101
  unchanged, published totals byte-exact.
  *Note: `efficiency_pct` did NOT move — circulation was already excluded from usable, so efficiency
  never measured waste. Flagged in the audit, not fixed here.*
- [x] **Phase 1.5 — `isGroundZone`/`isProgramZone` predicate + ~30-site sweep.** `!== 'Circulation'`
  meant "is a real room" in ~30 tsc-invisible string compares; all routed through the predicate
  (intentParser 5, qtoWorkbook 3, planGraphic 3, finishSchedule 2, sheetSet 2, report,
  servicesSheets, roomThumbs, roomNaming, takeoff, walkthrough, stats). Plus `unassigned_pct` as
  waste's own name — `efficiency_pct` stays the untouched BCO/RICS/JLL ratio so the qbiq parity
  benchmark survives.
- [x] **Phase 1b — the shape conjunct.** A corridor is path-shaped: isoperimetric quotient below
  τ = 3π/16 ≈ 0.589 (derived from a 3:1 minimum corridor aspect, NOT fitted to the observed
  pockets), measured on the RDP-simplified boundary so the test describes shape and not tracing
  resolution. 847 stays Circulation (a 0.085-compactness ribbon, not the void we both called it);
  848 and 851 flip. Split 106.20/64.47 → 87.93/82.74. 169 Rust tests.
- 🔄 **Phase 2 — renderer figure/ground sweep** (2.1–2.8; 2.6 partially landed early, see audit).
  - [x] **2.1 ground hatch + dashed outline**, editor-only, through the existing `FillStyle` hatch
    kind. Uncovered that `fillWith`'s LOD ramp had been silently killing every ZONE texture
    (`referencePx = 0` → `smoothstep(5,13,0)` = 0), so the Core poché had **never rendered**. Ramp
    fixed; hatch ink re-registered as a relation (half of program's 33/255 → band 14–18, measured
    16 at α 0.10); Core poché is editor-only per spec `wall_poche` ("NO poche anywhere in the
    reference"). New `fillRenders.test.mjs` smoke: a declared fill must be able to draw.
  - [x] **2.2 ground carries no name.** 24 tags → 7 at rest, ground 17 → 0. Selection exception
    threaded through the existing highlight set. Thin corridors still show no tag — pre-existing
    text-fit rule, an 11 px-wide strip never had a legible label.
  - [ ] 2.3 thumbnails · 2.4 3D floors · 2.5 printPlan roomLabels · 2.6 remainder · 2.7 verify ·
    2.8 style-gate extension
- [ ] **Phase 3 — sheet furniture + metrics card.** Promotion of what `export/report.ts` already has.
- [ ] **Phase 4 — gates C1–C10** as their own board folded into `run-all.sh` as G13, with its own
  lying gate (the `GSELF` pattern).

## Track L — Three-branch integration (`main` × `ui-fixes` × `export`)

One green tree from three divergent branches. Full account:
`docs/design/merge-audit.md` (Phase 0) → `phase1-exit.md` → `phase2-exit.md` →
`merge-final-report.md`.

- [x] **Phase 0 — forensic audit + prediction register.** Six predictions (P1–P6)
  written BEFORE the merge, scored after. P3 was **wrong in the informative
  direction**: style-gate stayed green while `accent-univalence` — value-keyed,
  added after P3 was written — caught five raw amber literals git auto-merged
  into `DrawingCanvas.ts` with no conflict marker.
- [x] **Phase 1 — merge `ui-fixes`.** 23 conflicts + one delete/modify. The
  governing pattern: ui-fixes edited PRE-SPLIT files main had decomposed, so ~12
  re-sitings rather than takes-or-drops. `furniture.ts` → `symbols.ts` (R2) was an
  API change, not a rename. **138 Rust tests by name.**
- [x] **Phase 2 — merge `export`.** 17 conflicts; a 214-line seating block
  hand-ported; `glaze_facade` + 13 layout hunks. **157 Rust tests by name.**
  - [x] SG2 — false positives, not escaped tags: a tag must sit on its own
        knockout (195 real tags 0.593–0.751, both false positives **0.000**).
  - [x] E7 occupancy seeding, plus the two corrections the gates forced —
        soft-weighted furniture, and a ladder ordered by what survives.
  - [x] `pdf.ts` split under R1 → `pdfDoc` / `printPlan` / `pdf`, with both gate
        anchors moved in the same commit and the move proven load-bearing.
  - [x] `quantity.rs` on the DWG plate: 21 glazed bands imply 42 piers = 25.20 m
        of the 38.35 m solid perimeter; the 13 remaining runs average **1.01 m**,
        all under `MIN_GLAZED_RUN` = 1.7 m.
  - [x] Seats/QTO cross-check — found the canvas double-draw no gate could see.
  - [x] Fonts guard asked every family for weight 400; Schibsted ships 500/700.
- [x] **Phase 3 (Parts C/D) — close out.** Adversarial round, LibreOffice recalc,
  the pixdiff debt, four new faces (17–20), landing on main.
  - [x] **LibreOffice recalc** (G2, live not skipped): bumping a unit price moved
        the total by exactly the expected **412,620.00**; formula density 100 %.
  - [x] **pixdiff vs `export`** on the deliverable plan: 4.38 % of pixels, and the
        diff image shows **every changed pixel on furniture glyphs and door
        swings** — walls, zone fills, labels and core untouched. Classified
        intended-(ruled R2).
  - [x] **Amber, measured exactly rather than approximately.** Amber-valued sites
        by VALUE in all three encodings: main 15 · ui-fixes 22 · export 38 ·
        **integration 10**, and all 10 are 3 declarations + 7 comments. **Zero use
        sites.** See `merge-final-report.md` for why this replaced a cross-branch
        UI pixdiff rather than supplementing it.
  - [x] **Adversarial round**: three stale `furniture.ts` comments **in code**
        re-pointed (the design docs were NOT covered by that pass — a second audit
        found them and they now carry a historical banner instead); one
        over-exposed export un-exported; both touched gates proven to still
        discriminate in separated arms (the first attempt confounded them).
- [ ] **The 13-step manual walkthrough** (`docs/design/manual-session.md`) — a
      HUMAN task on main after landing. No agent substitution is valid; see
      `.claude/rules/gate-independence.md`, "an agent must never perform or
      simulate a trusted-human event".

- [x] **Audit round — two independent agents against an already-green board.**
      Validation found nothing broken (production build succeeds; `GATE_SELFTEST=1`
      still catches the deliberate liar) and one caveat worth keeping: **`pnpm build`
      does not build the wasm**, so only `make build` exercises the Rust→wasm chain.
      Checking found four real problems in work already reported done — a miscounted
      `implySeats` call site (five, not four), `--accent-amber-rgb` as a second
      unpinned source for the amber value, a stale docblock, and design docs citing
      a deleted module. All fixed; `style-gate` gains `DERIVED_RGB`.
- [ ] **Manual session** (`docs/design/manual-session.md`) — 3D panel states, the
      naive-user walkthrough, and the tone check. **Needs a human at the screen**
      by the document's own reasoning: headless driving crashed the WebGL context
      twice and a crashed context answers queries while rendering nothing. Its port
      guidance has been corrected (it named :5199, which is now a foreign worktree).

### Track L — known gaps, declared

- **No sensor watches the editor canvas for unbilled seating.** G11 grades the
  delivered pack; the canvas is not in the pack. The double-draw was found by a
  hand-written cross-check, which is the honest way to say "found by luck".
  Recorded OPEN in ADR 0005's trigger/sensor table.
- **G11's attribution weakness survives its own falsification.** Implied seating
  measurably inflates ink ratios (p25 +0.24) but no billed instance depended on
  it (worst 1.52 vs a 0.70 floor). Nothing attributes ink to the glyph that drew
  it, so a future overlapping glyph reintroduces it.
- **dwg A.02 carries four 0.15 m windows** — imported/conformed geometry, not
  `glaze_facade` output (its minimum band is 0.5 m). Pre-existing, not
  merge-introduced.
