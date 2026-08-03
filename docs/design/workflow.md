# Guided Project Workflow — Architecture

Status: **proposed** (design only; no production code in this change). This doc wraps the existing
single-screen editor into a qbiq/Laiout-style guided flow: **Projects → Property → Space → Program →
Generate → Editor → Export**. It decides the app shell/routing, the shared workflow state, the build
specs for every new interaction primitive, an independently-shippable milestone plan, and the
"no-rewrite" guarantees that keep the current editor (and its tests) intact.

Every implementation claim below is anchored to a `file:line`; every product/UX claim is anchored to a
reference in the table below.

### Reference sources

- **In-repo (cited research):** qbiq's Upload → Define → Customize → Receive
  (`research/04-competitive-landscape.md:6`); Laiout's upload → preferences → options → Freeze/Regenerate
  (`research/03-laiout.md`); the product vision (`vision.md`); the multi-floor persistence decision
  (`docs/design/multi-floor.md`).
- **qbiq (primary, help center):** floor creation `help.qbiq.ai/en/articles/10429000-create-a-new-floor`;
  Concept program `.../10414522-concept-program`; Detailed program `.../8255817-detailed-program`;
  analytics `.../10398515-how-space-utilization-analytics-are-calculated`; capabilities
  `qbiq.ai/capabilities/{quantity-takeoff,customized-planning-engine,multi-floor-space-planning}`.
- **laiout (primary, help center):** `help.laiout.co/getting-started/uploading-floor-plans`,
  `.../designing-your-space/{setting-your-preferences,generating-layout-options}`,
  `.../getting-started/plans-and-pricing`; AEC Magazine
  `aecmag.com/cad/laiout-enhances-automated-floor-planning-software/`.

**Code anchors:** app shell + routing `web/src/shell/` (`AppShell.tsx`, `route.ts`,
`WizardChrome.tsx`, `CreateProject.tsx`, `ProjectLibrary.tsx`, `steps/`) · program builder
`web/src/program/spec.ts` (`ProgramSpec`, `TEMPLATES`, `programSpecToProgram`) +
`web/src/program/anchors.ts` · import steps `web/src/import/area.ts` (`restrictDrawing`) and
`web/src/import/heal.ts` (`healWalls`) · generate `EditorCanvas#autoGenerate`
(`web/src/editor/EditorCanvas.ts`) over `layout::generate` (`crates/ds-core/src/layout.rs`) ·
persistence `web/src/persist/file.ts` · export `web/src/export/`.

---

## 0. The flow, mapped to what exists vs what's new

qbiq organizes as **Project → Floor → Space(program) → Visualizations → Deliverables**
(`help.qbiq.ai/.../create-a-new-floor`); laiout is a single real-time session (3 options in <10 s,
`help.laiout.co/.../generating-layout-options`). Our flow blends them: a structured wizard that hands off
to a live editor.

| Step | User goal | Exists today | New work |
|------|-----------|--------------|----------|
| **1. Projects / Landing** | "DSOURCE STUDIO", list saved projects, Start a project | Plan library + project grouping (`persist/plans.ts:155` `groupPlans`, `:178` `listProjects`, `:187` `resolveProject`, `:206` `assignToProject`); `LibraryPanel` inside the inspector (`App.tsx:695`) | Full-screen landing/library view; **create-project form** (property/address/logo/name/floor); a persisted **project record** |
| **2. Upload / Space** | Drop a CAD, restrict to a sub-area, mark rooms, heal walls, read detected program | DXF/DWG import (`App.tsx:146` `onImportFile`); parse→plate pipeline (`import/testfit.ts:89` `extractPlate`, `:473` `extractKeepouts`, `:340` `extractInteriorWalls`, `:243` `extractEntries`); imported-plan canvas (`import/DrawingCanvas.ts:89`, `import/DrawingView.tsx`); readouts (`App.tsx:1395` `ImportPanel`, `:1351` `buildCategoryGroups`) | **Area-select polygon** (= qbiq's Floor-Area pencil tool), **room markers + refs**, **wall-heal toggle**; PDF/image + scale confirm (gap, see §7) |
| **3. Program** | Concept/Detailed, templates or headcount, room-by-room builder, desk type/size, anchor pins | `Program` + weights (`layout.rs:36`, TS mirror `EditorCanvas.ts:93`); `SpaceProgram::derive(headcount, area)` (`layout.rs:263`); `GenerateCard` numeric form (`App.tsx:1210`) | **Program builder UI** (= qbiq Concept/Detailed) + a **`ProgramSpec`** (per-room overrides) mapping onto `Program`; **anchor pins** (= qbiq "Place on Plan"), a new core placement hint |
| **4. Generate** | Autonomous test-fit → A/B/C alternatives | `Editor.generate(program, seed, keep)` (`lib.rs:342`); seed-search loop `autoGenerate` (`EditorCanvas.ts:389`); gallery (`ui/CandidateGallery`, `App.tsx:1326`) | Present the gallery as a wizard step; category-winner badges; keep the winning seed on the draft |
| **5. Editor** | Pick an alternative, edit, bind products | The whole current `App` (2D/3D/import modes, inspector, re-imagine, material bank) | Reached as one route; unchanged internals |
| **6. Export** | Report PDF + takeoff Excel + DXF/PDF/IFC/OBJ | `ExportMenu` (`App.tsx:850`); report (`export/report.ts:262`, meta at `:55`), takeoff (`export/takeoff.ts:172`, options `:37`) | Wire real project meta (name/address/logo/floor) into `ReportMeta`/`TakeoffOptions` instead of `'Untitled Plan'` (`App.tsx:924,950,956`) |

**Key leverage already in place:** the report exporter already accepts `project`, `address`, `logo`,
`style` (`export/report.ts:55` `ReportMeta`, cover renders logo at `:492`) and the takeoff already emits
per-room `roomId`/`roomType` columns (`export/takeoff.ts:49` `TakeoffFurnitureRow`, room id at `:191`,
`ROOM_TYPE` map at `:95`). The create-project fields and room refs therefore have **downstream homes on
day one** — the workflow's job is to feed them. Likewise, the near-duplicate filter in the search loop
(`EditorCanvas.ts:407`, "same workstation count and ~equal total means the same layout family") already
approximates laiout's "3 options that differ by ≥10%" rule (`help.laiout.co/.../generating-layout-options`).

---

## 1. Decision: app shell / routing

### The constraint that decides it

The editor is **one big, expensive, stateful mounted component**. `App` (`App.tsx:91`) asynchronously
creates the wasm `Editor` and binds the canvas exactly once (`App.tsx:170-194` `EditorCanvas.create`),
installs the `window.__ec` dev/E2E seam (inside `EditorCanvas.create`), and owns a pile of live React
state — `drawing`, `bindings`, `candidates`, `currentPlanId`, `plans`, `mode` (`App.tsx:99-131`) — plus
an imperative `EditorCanvas` instance holding the canvas transform, CAD layer, and selection. **Unmounting
it tears all of that down.** Any router that swaps route components in and out on navigation would remount
the editor on every step transition, losing the wasm document, the parsed drawing, and the `__ec` handle
that tests depend on.

### Options weighed

- **(A) `react-router-dom` (hash router).** Adds a dependency to a repo whose runtime deps are today just
  `react`, `react-dom`, `three` (`web/package.json`). Routers are built to mount/unmount route elements;
  keeping the editor alive across routes means parking it *outside* the routed subtree anyway — so the
  router buys URL parsing we can write in ~20 lines, at the cost of a dep and a fight with its lifecycle.
  Rejected on the no-bloat rule (`.claude/rules/no-bloat.md`) + the lifecycle mismatch.
- **(B) A top-level `AppShell` view-state machine, editor kept mounted.** A new `AppShell` owns a `Route`
  value and renders exactly one "screen" at a time; the current `App` becomes **`EditorView`**, kept
  **mounted once entered** (hidden with `display:none` when another screen is active, never unmounted), so
  its wasm/canvas/drawing state and `__ec` survive every step. Deep-linking is a thin `location.hash`
  sync (`popstate` + `history.pushState`). No new dependency.

### Decision: **(B)** — `AppShell` state machine + hash sync, no router dependency.

### Route / state model

```ts
// web/src/shell/route.ts  (NEW)
export type WizardStep = 'space' | 'program' | 'generate'
export type Route =
  | { name: 'projects' }                                   // #/                       landing + library
  | { name: 'create' }                                     // #/new                    create-project form
  | { name: 'wizard'; projectId: string; step: WizardStep }// #/p/:pid/space|program|generate
  | { name: 'editor'; projectId?: string; planId?: string }// #/p/:pid/f/:planId  |  #/editor (dev)
export function parseHash(hash: string): Route            // '' → { name:'projects' }
export function toHash(r: Route): string
```

- `AppShell` holds `route` in state, initialises it from `parseHash(location.hash)`, subscribes to
  `popstate`, and calls `history.pushState` on `navigate(r)`. Static-host-safe (hash, no server routes).
- **Property (create-project)** is the `create` route; **Space/Program/Generate** are the three
  `wizard` steps under a project id; **Editor** is its own route; **Export** stays a menu/modal inside
  EditorView (`ExportMenu`, `App.tsx:850`) — it is not a route, matching how it works today (and qbiq's
  model, where deliverables are outputs of the floor, not a separate stage).
- `AppShell` renders:
  - `route.name === 'projects'` → `<ProjectLibrary>` (full screen). EditorView not required.
  - `route.name === 'create'` → `<CreateProject>` (full screen form).
  - `route.name === 'wizard'` → `<EditorView>` **visible** + a `<WizardChrome>` overlay (step bar +
    per-step side panel). The wizard does **not** replace the editor for Space/Generate — it *steers* it
    (see below), because those steps use the editor's already-mounted `DrawingCanvas`/`EditorCanvas`.
  - `route.name === 'editor'` → `<EditorView>` visible, no chrome.
- **EditorView is mounted lazily on first entry into any `wizard`/`editor` route, then kept mounted.**
  The landing/library render without paying the wasm boot cost.

### How the wizard steers the editor without owning it (the crux of "no rewrite")

`EditorView` (today's `App`) already contains every mechanism the Space and Generate steps need — it just
exposes them through a **controller ref** (`useImperativeHandle`) instead of only wiring them to its own
buttons. These are lifts of existing closures, not new logic:

```ts
export interface EditorController {
  importFile(f: File): Promise<void>     // exists: App.tsx:146 onImportFile
  loadDrawing(d: Drawing | null): void   // exists: setDrawing + applyOpenedFile path
  testFit(): void                        // exists: App.tsx:349 testFitPlan (extract→push→setMode('2d'))
  setMode(m: '2d'|'3d'|'import'): void    // exists: App.tsx:99
  runGenerate(p: Program, o): GenResult  // exists via ec.autoGenerate (EditorCanvas.ts:389)
  applyCandidate(snap: unknown): void    // exists: EditorCanvas.ts:436
  saveToLibrary(name, opts): Promise<SavedPlan> // exists: App.tsx:252 saveCurrentToLibrary
  ec(): EditorCanvas | null
  drawingCanvas(): DrawingCanvas | null  // exists: App.tsx:587 onCanvas → drawCanvasRef
}
```

`WizardChrome` calls these; it renders step panels into a slot EditorView already has (the inspector
`<aside className="inspector">`, `App.tsx:654`). EditorView's own render tree, modes, testids, and the
`__ec`/`__dc` seams are untouched — the shell adds a header bar and swaps which panel fills the inspector.

### Deep-linking & direct-to-editor

- `#/p/<projectId>/space` re-opens a project's draft at the Space step; `#/p/<pid>/f/<planId>` opens a
  saved floor straight in the editor via the existing `openSavedPlan` path (`App.tsx:286`).
- **Dev/debug escape hatch:** `#/editor` mounts `EditorView` with an empty draft — behaviourally identical
  to how the app boots today (straight into the editor). This is what keeps existing E2E entrypoints and
  the `window.__ec` seam working (see §5).

---

## 2. Decision: shared workflow state (the "project draft")

### What a project holds

A **project** is created *before* any plan is generated (you make it, then upload) — matching qbiq, where a
Floor is set up (number, area, height, facade) *before* the space is planned
(`help.qbiq.ai/.../create-a-new-floor`). So unlike the multi-floor model where "a project exists iff a plan
references it" (`docs/design/multi-floor.md`), we now need a **first-class persisted project record**, plus
a **draft** capturing pre-generation working state.

```ts
// web/src/persist/projects.ts  (NEW)
export interface ProjectRecord {
  id: string
  createdAt: string; updatedAt: string          // ISO
  // --- create-project form (flows straight into ReportMeta / TakeoffOptions) ---
  propertyName: string
  address?: string
  clientLogo?: string                            // data: URL → report.ts:492 cover logo
  projectName: string                            // == SavedPlan.projectName (denormalized)
  floorLabel: string                             // initial floor → SavedPlan.floor.label
  // --- pre-generation working state; regenerated plans consume it ---
  draft?: ProjectDraft
  chosenPlanId?: string                          // the SavedPlan the user carried into the editor
}

export interface ProjectDraft {
  drawing?: Drawing                              // parsed upload (same shape as DSourceFile.drawing)
  scale?: { confirmed: boolean; pxPerM?: number }// PDF/image scale confirm (§7 gap)
  areaPolygon?: Pt[]                             // §3.1  drawing coords
  markers?: RoomMarker[]                         // §3.2
  heal?: { on: boolean; gapM: number }           // §3.3  default { on:true, gapM:0.3 }
  spec?: ProgramSpec                             // §3.4  room-by-room builder state
  anchors?: AnchorPin[]                          // §3.5
  winningSeed?: number                           // reproduces the chosen candidate (generate is
                                                 //   deterministic per seed — EditorCanvas.ts:400)
}
```

### Where it persists

Extend the existing IndexedDB (`persist/db.ts`): DB `"dsource"`, today v1 with two stores `plans`,
`history` (`db.ts:14-16`). Add a **third store `projects`** (keyPath `id`) and bump `DB_VERSION` 1→2.
`onupgradeneeded` already creates only the missing stores (`db.ts:28-33`), so the migration is additive —
existing `plans`/`history` records are untouched. The Node in-memory fallback map must gain `'projects'`
(`db.ts:19-20`). `StoreName` and `KEY_PATHS` (`db.ts:12,16`) get the new entry; `dbGet/dbPut/dbDel/dbGetAll`
are already store-generic.

### Additive-contract guarantees

- **`SavedPlan` is unchanged.** Its `projectId?`/`projectName?`/`floor?` (`plans.ts:43-49`) already link a
  generated floor to a project; the workflow just sets them via the existing `buildSavedPlan({…, project})`
  (`plans.ts:65,75`) and `assignToProject` (`plans.ts:206`).
- **`.dsource` format is unchanged** (honours `multi-floor.md`'s "no format change"): a file stays one
  floor. The project link lives only on `SavedPlan.projectId`, not in the file.
- **`listProjects` reconciles** the derived groups (`groupPlans`, `plans.ts:155`) with the new `projects`
  store so an in-progress project with **zero floors** still shows on the landing. `resolveProject`
  (`plans.ts:187`) stays the case-insensitive name→id resolver; when the wizard mints a project it writes
  a `ProjectRecord` up front (so the id is stable before any floor exists).
- Property meta → export: at Export, `ReportMeta` (`report.ts:55`) is built from the `ProjectRecord`
  (`project=projectName`, `address`, `logo=clientLogo`) and `TakeoffOptions` (`takeoff.ts:37`) from
  `{ project: projectName, floor: floorLabel }` — replacing the hard-coded `'Untitled Plan'` / `'1'`
  (`App.tsx:924,950,956`).

### Draft lifecycle

- The Space/Program steps read/write `ProjectRecord.draft` (debounced, like the autosave ring in
  `persist/history.ts`, `App.tsx:182`).
- **Candidates are not persisted**; only `winningSeed` + the chosen `SavedPlan` are. Generation is a pure
  function of `(program, seed)` (`layout.rs:12,946`; the loop re-runs the winning seed at
  `EditorCanvas.ts:426`), so a candidate is losslessly reproducible from `program + seed` — persisting the
  4–5 MB drawing once (on the draft) and a seed integer beats persisting N document snapshots. (laiout caps
  uploads at 25 MB / furniture 85 MB, `help.laiout.co/.../uploading-floor-plans` — a reminder that the
  drawing is the heavy payload and should be stored once, not multiplied.)
- Carrying a candidate into the editor = today's `saveCandidateToLibrary` (`App.tsx:270`) with
  `{ project }` set, then `navigate({name:'editor', planId})`.

---

## 3. New primitives — build specs

Each is written to be implementable by one agent. All coordinates are meters unless noted; the
imported-plan canvas works in drawing (source) coordinates (`import/types.ts` header).

### 3.1 Area-select polygon  *(= qbiq's Floor-Area pencil tool, `help.qbiq.ai/.../create-a-new-floor`)*

**Purpose:** restrict analysis to a sub-area (a tenant on part of a floor); everything outside is dropped.

- **Interaction.** A new tool `'area'` on the imported-plan canvas (`DrawingCanvas`, `import/DrawingCanvas.ts:89`).
  Click to drop vertices; double-click / Enter closes the ring; drag a vertex handle to move; drag an edge
  midpoint to insert a vertex; Backspace deletes the last. Reuse the existing selection-handle drawing
  (`HANDLE_PX`, `DrawingCanvas.ts`) and the placement-ghost snap grid (`PLACE_SNAP = 0.05`,
  `DrawingCanvas.ts`). Model it as a sibling of the existing "placing" mode (`beginPlace`,
  `DrawingCanvas.ts:202`, private `placing` state `:115`): add `beginArea()` / `area: Pt[]` state and paint
  it in `render()`.
- **Snap to walls.** On vertex drop/drag, snap to the nearest wall-segment endpoint or projection within a
  tolerance. The geometry already exists in `testfit.ts`: `distToRing` (`:310`) and the endpoint-graph
  builder in `traceLoops` (`:907`). **Extract** the shared point/segment helpers into a new
  `import/geom.ts` and import from both (no-bloat: don't fork point-in-polygon).
- **"Drop outside" filter.** A pure `restrictDrawing(drawing, polygon): Drawing` in a new `import/area.ts`:
  keep a `FurnitureItem` iff its bbox center is inside the polygon (reuse `pointInRing`/`coveredByRing`,
  currently private at `testfit.ts:777,790` — move to `import/geom.ts` and export); keep a `DrawEntity` iff
  any sample point is inside. **Non-destructive:** the original `Drawing` stays on the draft; the polygon is
  stored, and `restrictDrawing` is applied (a) to compute the Space-step readouts and (b) as the input to
  `extractPlate` in `testFit()` (`App.tsx:349`), so the plate, keepouts, interior walls and entries are all
  derived within the sub-area.
- **Data:** `ProjectDraft.areaPolygon: Pt[]`.

### 3.2 Room markers + reference numbers

**Purpose:** where detection lacks context, the user drops a typed marker + a room number (e.g. "502") so it
can be referenced later ("tell the AI about room 502") and appears in the takeoff's Room ID column.

- **Vocabulary.** A `RoomType` union (Office / Meeting / Collab / IT-Storage / Pantry / Reception /
  Mothers-room / Focus / Phone / …) with two maps in `import/markers.ts`:
  - `roomTypeToZone: Record<RoomType, ZoneType>` onto the closed `ZoneType` enum
    (`EditorCanvas.ts:30`: Circulation/Workspace/Meeting/Collaboration/Core/ClosedOffice/Amenity), e.g.
    Office→ClosedOffice, Meeting→Meeting, Collab→Collaboration, Pantry/Reception/Mothers-room→Amenity,
    IT-Storage→Core.
  - it aligns with the takeoff room-type strings (`ROOM_TYPE`, `takeoff.ts:95`).
- **Data model:** `RoomMarker { id: string; type: RoomType; ref: string; point: Pt }`. This is a
  **draft-level** entity, *not* a `FurnitureItem` extension — `FurnitureItem` (`import/types.ts:49`) has no
  room/ref field and markers are about rooms, not blocks.
- **Interaction.** A `'marker'` tool on the imported-plan canvas: click a spot → a small popover picks
  `type` and takes a `ref` string; renders as a pin + `502 · Office` label. Same "placing"-mode pattern as
  §3.1 / `beginPlace`.
- **Where refs flow (the plumbing):**
  1. **Into zones / Room ID.** After a test-fit generates zones, associate each marker with the zone whose
     rect contains its point (the reverse of takeoff's `zoneFor`, `takeoff.ts:146`) and set that zone's
     `label` to the ref (`DocZone.label`, `EditorCanvas.ts:41-47`). Extend `buildTakeoffModel`
     (`takeoff.ts:172`) so the Room ID column prefers a human `zone.label` when present, falling back to
     today's `zone.id` (`takeoff.ts:191`). **Re-association must re-run on every regenerate** (zone ids and
     positions change) — markers are pinned to points, not zone ids.
  2. **Into AI context.** Serialize `markers` into the draft and expose `ref → { type, area, point }` to the
     `AgentPanel`/evaluator (`ai/`, mounted at `App.tsx:787`) so "tell the AI about room 502" resolves.
- **Data:** `ProjectDraft.markers: RoomMarker[]`.

### 3.3 Wall healing

**Purpose:** bridge near-miss partition gaps so rooms/plate close cleanly; a toggle chooses heal vs
as-drawn. (laiout ships a "CAD File Cleaner" that "auto-converts messy drawings into planning-ready
layouts", `laiout.co` / `aecmag.com/.../laiout-...` — wall-heal is the targeted, user-visible slice of that.)

- **Algorithm sketch.** `healWalls(segments: Segment[], gapM: number): Segment[]` in a new `import/heal.ts`:
  1. Build the endpoint graph exactly as `traceLoops` does (snap endpoints to a tolerance grid → node ids →
     adjacency, `testfit.ts:907-933`); collect **degree-1 nodes** (free wall ends).
  2. For each pair of free ends within `gapM` (default 0.3 m ≈ a door leaf) whose incident segment
     directions are near-collinear (angle < ~12°) **or** that form a clear T/L near-junction, emit a
     bridging `Segment` closing the gap.
  3. Cap the number of bridges and skip pairs already connected, to avoid fusing distinct rooms.
- **Where it runs.** Applied to `collectWallSegments`/`collectShellSegments` output (`testfit.ts:688,701`)
  **before** `extractPlate` and `extractInteriorWalls`, so healed linework improves loop tracing
  (`method:'loop'`, `testfit.ts:135`), interior-wall closure (`:340`) and keepout detection (`:473`). When
  the toggle is off, linework passes through unchanged ("as-drawn").
- **Relationship to existing behaviour.** The raster plate path already bridges gaps morphologically via
  `gridContour`'s dilate/erode closing (`testfit.ts:1003,1026-1054`); wall-heal is the explicit,
  *vector-level, user-visible* version that also helps the exact `loop` trace and the interior/keepout
  passes, and that the user can see on the plan.
- **Data:** `ProjectDraft.heal = { on: boolean; gapM: number }`.

### 3.4 Program builder UI → `ProgramSpec`  *(= qbiq Concept vs Detailed program)*

**Purpose:** two-tier program authoring matching the screenshots and qbiq's model, mapping onto the core
`Program`. qbiq splits this into **Concept** (fast, slider-driven) and **Detailed** (granular per-room),
with an irreversible Concept→Detailed upgrade (`help.qbiq.ai/.../concept-program`, `.../detailed-program`).

- **Component tree** (in `web/src/shell/steps/ProgramStep.tsx`):
  - **Concept** (mirrors qbiq's Floor-Plan Profile): **Planning Style** Traditional/Modern/Co-Work;
    **Desk Type** Workstations/Benchings → `Program.bench_pairs` (`layout.rs:53`, TS `EditorCanvas.ts:104`);
    **Desk Size** 180×70 / 160×70 / 140×70 / 120×60 → `Program.desk_w`/`desk_h`; a **Seat Distribution
    slider** (closed-office share) → drives the enclosed-office %. Templates Small ~15 / Mid ~40 /
    Large ~90 seats and generate-from-headcount both set `headcount` (`Program.headcount`, `layout.rs:65`).
  - **Detailed** (mirrors qbiq's room tabs, `.../detailed-program`): sections Offices (Executive / Large /
    Medium / Small / Focus — counts via +/- + placement Window/Core/Flexible); Team rooms (2/4/6/8);
    Conference (Boardroom / XL / Large / Medium / Small — sized by #people); Collaboration (Huddle /
    Phone booth / Focus); Amenities (Reception / Kitchen / Wellness / Copy-print / Storage-IT).
  - A **Program Summary** panel with a live occupied-area **progress bar** (qbiq shows exactly this,
    `.../detailed-program`) — reuse the live metrics the core already returns (`StatsPanel`, `lib.rs`
    `Metrics`).
- **Maps to `Program` + a proposed `ProgramSpec`.** The core already derives a full professional program
  from headcount — `SpaceProgram::derive(headcount, plate_area)` (`layout.rs:263`) emits Cabin / Meeting4P /
  Meeting6P / Boardroom / PhoneBooth / Focus / Collab / Reception / Pantry / Print / ItServer / Storage /
  Wellness (`SpaceKind`, `layout.rs:184`). The Detailed builder is the user **overriding** derive()'s counts
  and sizes per room type. The builder vocabulary maps onto `SpaceKind` (Executive/Large/Medium office →
  Cabin sizes; Team rooms → Meeting4P/6P; Conference → Boardroom/Meeting; Collaboration →
  Collab/PhoneBooth/Focus; Kitchen→Pantry, Copy-print→Print, Storage-IT→Storage/ItServer).
- **Proposed core extension (additive, serde-safe).** Add to `Program` (`layout.rs:36`):
  ```rust
  #[serde(default)]
  pub rooms: Vec<RoomOverride>,        // empty → today's derive() behaviour unchanged
  ```
  where `RoomOverride { kind: SpaceKind, count: u32, w: Option<f64>, d: Option<f64>, placement: Placement }`
  and `Placement { Window, Core, Flexible }` (new — qbiq's exact per-room preference,
  `.../detailed-program`). `generate()` (`layout.rs:946`) uses an override's count/size where present, else
  `SpaceProgram::derive`. **Placement bias** (Window vs Core) is a *new* generator capability — rooms
  currently band along edges and slide (`BAND_STEP`, `layout.rs:475`); v1 can bias which region/edge a room
  job targets, with full placement-solving deferred (§7 open question).
- **TS side:** `ProgramSpec` (in `web/src/program/spec.ts`) is what the builder edits; a pure
  `programSpecToProgram(spec): Program` sets `headcount`, `desks`, `meeting_rooms`, `desk_w/h`,
  `bench_pairs`, and `rooms`.
- **⚠ Serialization trap (must fix in the same slice):** `sanitizeProgram` (`persist/file.ts:69-79`) copies
  only fields whose default is a `number` or `boolean` — it would **silently drop** a `rooms` array on every
  save/open. Extend it to carry `rooms` (validate each entry), or `ProgramSpec` round-trips would lose the
  detailed program. (`DEFAULT_PROGRAM`, `EditorCanvas.ts:161`, and the Rust `Program::default`,
  `layout.rs:84`, both need the field too.)
- **Data:** `ProjectDraft.spec: ProgramSpec`; the resolved `Program` is what `runGenerate` receives and what
  the saved `DSourceFile.program` stores (`file.ts:44,182`).

### 3.5 Anchor pins  *(= qbiq's "Place on Plan", `help.qbiq.ai/.../detailed-program`)*

**Purpose:** pick a room type, click the plan to force that room onto a spot — and bump its count. This is
qbiq's exact "Place on Plan" interaction (pin a room, then "Done"); laiout has no per-room pinning, leaning
on occupancy caps + keep-and-regenerate instead, so this is a differentiating control worth getting right.

- **Data model:** `AnchorPin { id: string; kind: SpaceKind; point: Pt }` (draft-level), placed with a
  `'anchor'` tool on the plan (same placing pattern).
- **How the generator consumes it — reuse the existing doc-level placement-hint pattern.** The core already
  has two such hints: **entries** anchor the circulation spine (`doc.entries`, `add_entry` at `lib.rs:136`,
  read at `layout.rs:1098`) and **keepouts** are hard obstacles (`doc.keepouts`, `add_keepout` at
  `lib.rs:122`, holes at `layout.rs:973`). Add a **third**, mirroring them exactly:
  - `doc.anchors: Vec<Anchor>` where `Anchor { kind: SpaceKind, x, y }`, plus `add_anchor(kind,x,y)` /
    `clear_anchors()` wasm bindings (mirror `add_entry`/`clear_entries`, `lib.rs:136,141`), and serialize
    with the doc (rides `state()`/`snapshot()`, like entries).
  - In `generate()`, before the sliding band placement (`allocate_rooms`, `layout.rs:1138`), turn each
    anchor into a **position-pinned `RoomJob`** placed **first**: instead of sliding from the band start,
    the slot scan starts at the anchor point and takes the nearest valid slot; the placed room is added to
    `obstacles` so the rest packs around it.
  - **"Bumps its count":** the anchored rooms are *additional* — for each `kind`, the effective count is
    `max(requested_or_derived, anchored_count)`, so anchoring three offices adds three, not reallocating
    from the derived set.
- **TS push:** at `testFit()`/`runGenerate` time, `ec.ed.clear_anchors()` then `add_anchor` per pin (offset
  into editor coords with the plate offset, exactly as `pushEntriesToEditor` does, `testfit.ts:282`).
- **Data:** `ProjectDraft.anchors: AnchorPin[]`.

---

## 4. Milestone plan (independently-shippable slices)

Ordered by value; each slice is independently shippable and names the files it adds/touches + an acceptance
check. Slices 2–6 are largely independent of each other (Space-step vs Program-step), so they can be
reordered or parallelised after Slice 0/1 land.

### Slice 0 — App shell + project library + create-project *(skeleton; does not touch editor internals)*
- **Add:** `web/src/shell/route.ts`, `shell/AppShell.tsx`, `shell/ProjectLibrary.tsx`, `shell/CreateProject.tsx`,
  `web/src/persist/projects.ts` (ProjectRecord CRUD).
- **Touch:** `persist/db.ts` (DB_VERSION 1→2, `'projects'` store + `StoreName`/`KEY_PATHS`/memory map);
  `main.tsx` renders `<AppShell/>`; `App.tsx` gains a `useImperativeHandle` `EditorController` and is
  exported as `EditorView` (no internal logic changed).
- **Accept:** land on `#/`; create a project (property/address/logo/name/floor) → persists → shows in
  library (including projects with zero floors); "Open in editor" (`#/editor`) mounts EditorView with all
  existing behaviour; existing testids + `window.__ec` still resolve; `#/` and `#/editor` deep-link.

### Slice 1 — Upload / Space step chrome *(wraps existing import)*
- **Add:** `shell/steps/SpaceStep.tsx`, `shell/WizardChrome.tsx` (step bar).
- **Touch:** none in EditorView beyond the controller (`importFile`, `testFit`). Reuse `ImportPanel`
  readouts (`App.tsx:1395`) rendered into the inspector slot.
- **Accept:** from a project, upload a DXF → parsed plan renders with seats/open/enclosed/usable-sf +
  detected program + bill-of-components + labelled-rooms readouts; "Next" writes `drawing` to the draft;
  reload resumes.

### Slice 2 — Area-select polygon
- **Add:** `import/geom.ts` (shared point-in-poly, extracted from `testfit.ts:777,790`), `import/area.ts`
  (`restrictDrawing`).
- **Touch:** `DrawingCanvas.ts` (area tool + handles), `testfit.ts` (import shared geom; apply
  `restrictDrawing` at the `extractPlate` entry), `SpaceStep.tsx` (control + live readouts).
- **Accept:** draw a polygon; furniture/entities outside are dropped from readouts and from the downstream
  test-fit; handles edit the ring; polygon persists on the draft; toggling it off restores the full plan.

### Slice 3 — Room markers + refs
- **Add:** `import/markers.ts` (RoomMarker + `roomTypeToZone`).
- **Touch:** `DrawingCanvas.ts` (marker tool + label render), `SpaceStep.tsx` (marker list),
  `export/takeoff.ts` (Room ID prefers `zone.label`), marker→zone association at test-fit time.
- **Accept:** drop "502 · Office"; it persists; the generated zone under the pin carries the ref; the
  takeoff Room ID column shows 502; the AI panel resolves "room 502".

### Slice 4 — Wall healing
- **Add:** `import/heal.ts` (`healWalls`).
- **Touch:** `testfit.ts` (heal before extract), `SpaceStep.tsx` (heal/as-drawn toggle + gap slider).
- **Accept:** a plan with near-miss partition gaps closes into a clean plate with heal on; identical to
  as-drawn with heal off; setting persists.

### Slice 5 — Program builder (Concept + Detailed) → `ProgramSpec`
- **Add:** `shell/steps/ProgramStep.tsx`, `web/src/program/spec.ts` (`ProgramSpec` + `programSpecToProgram`).
- **Touch:** `crates/ds-core/src/layout.rs` (`Program.rooms` + `Placement`; `generate()` honours overrides)
  → **`make wasm`**; `persist/file.ts` (`sanitizeProgram` carries `rooms`); `EditorCanvas.ts`
  (`Program`/`DEFAULT_PROGRAM` gain `rooms`).
- **Accept:** templates + headcount set counts; detailed builder edits per-room counts/sizes; generate
  respects them; `Program` round-trips through save/open with `rooms` intact (regression on the
  `sanitizeProgram` trap).

### Slice 6 — Anchor pins
- **Touch:** `crates/ds-core/src/layout.rs` (`doc.anchors`, honour in `generate()`), `crates/ds-core/src/lib.rs`
  (`add_anchor`/`clear_anchors`), the `Document` model (`document.rs`/`model.rs`), `import/testfit.ts`
  (push anchors like entries) → **`make wasm`**; `ProgramStep.tsx` (anchor tool on the plan).
- **Accept:** anchor an office on a spot → the generated plan places that room at/near the pin and its count
  is bumped by the anchored ones; determinism per seed preserved.

### Slice 7 — Generate step + Export meta wiring
- **Add:** `shell/steps/GenerateStep.tsx` (host the A/B/C gallery, `ui/CandidateGallery`) with
  **category-winner badges** (Lowest Cost / Lowest Carbon / Max Workstations / Highest Area-per-seat — the
  laiout pattern, `help.laiout.co/.../generating-layout-options`) computed from the `LayoutScore`/`Metrics`
  each candidate already carries (`EditorCanvas.ts:144,119`).
- **Touch:** `App.tsx` export calls (`:924,950,956`) to build `ReportMeta`/`TakeoffOptions` from the
  `ProjectRecord` (real name/address/logo/floor) instead of `'Untitled Plan'`/`'1'`.
- **Accept:** the Generate step shows alternatives with badges and carries the chosen one into the editor;
  exported report cover + takeoff header show the real project name, address, logo, and floor.

---

## 5. Risk / "no-rewrite" guarantees

### How the editor (`App.tsx`) stays intact
- `App` becomes `EditorView` with **only an added `useImperativeHandle`** — no change to its modes
  (`2d/3d/import`, `App.tsx:99`), its `EditorCanvas.create` effect (`:170`), its inspector tree (`:654`), or
  its export/AI/library wiring. The wizard renders *around* it and calls the controller; it never reaches
  into EditorView's state.
- EditorView is **kept mounted** once entered (hidden with `display:none`, never unmounted), so the wasm
  `Editor`, canvas transform, parsed `drawing`, `bindings`, and CAD layer survive every step transition.

### How existing tests / E2E keep working
- The `window.__ec` seam is set inside `EditorCanvas.create` (unchanged) and `window.__dc` in
  `DrawingView.onCanvas` (`App.tsx:587-589`, unchanged) — both still fire because EditorView still mounts the
  same components.
- All existing `data-testid`s (mode toggle `App.tsx:419`, `import-btn` `:498`, `generate` `:1301`,
  `export-*` `:977+`, `tab-plan`/`tab-library` `:680,687`, …) render unchanged when EditorView is active.
- **Risk:** an E2E that assumes the editor is present *on load* breaks if the app now lands on
  `ProjectLibrary`. **Mitigation:** the `#/editor` dev route mounts EditorView with an empty draft —
  behaviourally identical to today's boot — so those specs point at `#/editor` (or the harness sets the
  hash). New shell components get their own new testids.
- Rust: 70 tests pass today (`layout` + `circulation`); Slices 5/6 add fields with `#[serde(default)]` and
  empty defaults, so existing generate/score tests are unaffected until overrides/anchors are supplied. Run
  `cargo test -p ds-core` after each core slice.

### How a user still lands directly in the editor
`#/editor` (empty draft) and `#/p/<pid>/f/<planId>` (a saved floor) both mount EditorView directly — the
former for dev/debug, the latter for "open this plan".

### The three riskiest pieces
1. **Editor mount lifecycle under the shell.** Keeping a big async-initialised wasm/canvas component alive
   across navigation is the whole ballgame — get it wrong and you drop the document, the drawing, or the
   `__ec` handle tests depend on. Mitigated by the controller-ref + always-mounted-when-active pattern and
   the `#/editor` escape hatch.
2. **Core changes for Program overrides + anchors, and the `sanitizeProgram` data-loss trap.** Slices 5/6
   touch Rust (`layout.rs`/`lib.rs` + `make wasm`) *and* `sanitizeProgram` (`file.ts:69-79`) silently drops
   any non-scalar `Program` field — so `rooms` vanishes on save/open unless that function is extended in the
   same slice. Subtle, silent, and only caught by a round-trip test.
3. **Room-ref → zone → takeoff/AI plumbing across regenerates.** Refs are user strings on point-pinned
   markers; zones (their carrier, `DocZone.label`) are regenerated wholesale each `generate()` with new ids
   and positions (`layout.rs:1011-1013`). The marker→zone association must re-run on every regenerate, and
   the takeoff must be taught to surface `zone.label` (today Room ID = `zone.id`, `takeoff.ts:191`).

---

## 6. Cross-checks against the references

- **qbiq's structure** Project → Floor → Space → Visualizations → Deliverables
  (`help.qbiq.ai/.../create-a-new-floor`) maps to Projects → (create) → Space → Program → Generate →
  Editor/Export. Its four public steps Upload → Define → Customize → Receive
  (`research/04-competitive-landscape.md:6`) map the same way; "Customize" (themes/finishes) is covered by
  the per-element **re-imagine** binding (`ReimaginePanel`, `App.tsx:1466`) rather than a global theme step.
- **qbiq's Concept vs Detailed program** (slider-driven quick brief → irreversible upgrade to per-room
  granular control, `.../concept-program`, `.../detailed-program`) is adopted wholesale in §3.4, including
  Desk Type/Size, the Seat-Distribution slider, room tabs, Window/Core/Flexible placement, and the
  live Program-Summary progress bar.
- **qbiq's "Place on Plan"** room pinning (`.../detailed-program`) is the direct model for anchor pins (§3.5).
- **Laiout's** upload → preferences → **3 options ≥10% apart** → keep-and-regenerate
  (`help.laiout.co/.../{setting-your-preferences,generating-layout-options}`; `aecmag.com/.../laiout-...`)
  maps to Space/Program → Generate (A/B/C via `autoGenerate`, whose near-dup filter `EditorCanvas.ts:407`
  approximates the ≥10% rule) → the editor's existing **keep-confirmed regenerate** (`App.tsx:1305`
  "Regenerate · keep N frozen", core `keep_confirmed` at `layout.rs:946`).
- **Category-winner badges** (Lowest Cost / Lowest Carbon / Max Workstations / Highest Area-per-seat,
  `help.laiout.co/.../generating-layout-options`) are adopted in the Generate step (Slice 7), computed from
  the metrics candidates already carry.
- **Table-stakes** we already meet: 2D↔3D toggle (`App.tsx:419`), live metrics (`StatsPanel`, `lib.rs`
  `Metrics`), report/takeoff/DWG/IFC/OBJ exports (`ExportMenu`, `App.tsx:850`), and branded exports (logo,
  `report.ts:492`). **Differentiating** and to be surfaced by the flow: circulation as a first-class
  objective (`vision.md`; `circulation()` at `lib.rs`) — note qbiq itself computes circulation zones and
  *excludes* them from room area (`.../how-space-utilization-analytics-are-calculated`), so our circulation
  score is a credible, comparable metric — plus the autonomous seed-search loop (`EditorCanvas.ts:389`) and
  per-element product binding.

---

## 7. Open questions to flag

1. **PDF / image upload + scale confirmation.** The current importer is DXF/DWG only (`App.tsx:146`, via
   `/api/dwg` then `parseDrawing`). Both references accept raster/PDF (qbiq: CAD/PDF/JPEG,
   `.../create-a-new-floor`; laiout: DWG/DXF/PDF, `.../uploading-floor-plans`), but PDF/image → geometry +
   a scale-confirm interaction is **net-new parsing not covered by the existing `testfit` pipeline**. Scope
   it as its own dependency (the `ProjectDraft.scale` field is reserved for it) or restrict v1 uploads to
   DXF/DWG. Note neither vendor clearly documents auto scale calibration, so a manual scale-confirm is a
   defensible v1.
2. **Room placement (Window / Core / Flexible).** qbiq exposes this per room (`.../detailed-program`), but
   full placement-solving is a real generator change (rooms currently band-and-slide, `layout.rs:1138,475`).
   Ship a placement *bias* in Slice 5, or defer placement entirely to a later slice? Recommend bias-only for
   v1.
3. **Area-select destructiveness.** Confirmed non-destructive here (keep original, store polygon, filter at
   read) — good to double-check this matches the intended UX (can the tenant later widen the area back out?).
   Note qbiq warns "Floors cannot be edited once they are set up" (`.../create-a-new-floor`); we should
   decide whether the Space step is similarly locked after generate, or freely re-editable (recommend the
   latter, since our draft persists the raw inputs).
4. **Project meta editing after creation** (rename, swap logo). Follows the multi-floor `projectName`
   denormalization pattern (`multi-floor.md`: rename = rewrite of floor records). Confirm this is acceptable
   or whether we normalise project name onto the `ProjectRecord` only.
5. **DB rollback.** Bumping IndexedDB to v2 means an older app build hitting a v2 DB gets a `VersionError`
   (forward-only). Acceptable for a single-user local app? (It is for cloud-synced records, which ride the
   additive keys per `multi-floor.md`.)
6. **Departments.** qbiq's Detailed program has a Departments tab (named groups with their own room sets,
   `.../detailed-program`). Out of scope for v1, but the `ProgramSpec` room list should carry an optional
   `department?: string` tag so it isn't a breaking change to add later.
</content>
