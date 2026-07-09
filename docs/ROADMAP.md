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
- [ ] **S2 — Area selection.** Draw/adjust a polygon to restrict analysis to a sub-area (snap to walls,
  editable handles); geometry outside is dropped downstream.
- [ ] **S3 — Room markers + reference numbers.** Drop typed markers (Office/Meeting/Collab/IT/Pantry/
  Reception/…) with a room ref # (e.g. "502"); refs flow into zone labels → takeoff Room ID + AI context.
- [ ] **S4 — Wall healing.** Bridge near-miss partition gaps so rooms close cleanly (heal / as-drawn toggle).
- [ ] **S5 — Program builder.** Concept/Detailed; templates (Small/Mid/Large) or headcount; room-by-room
  counts (offices/team/conference/collab/amenities) with Window/Core/Flexible placement (**soft bias**,
  decided); desk type (workstation/bench) + size. Extends `Program` with a room spec (serde-additive).
- [ ] **S6 — Anchor pins.** Pick a room type, click the plan to force it onto a spot (+bumps count);
  generator consumes anchors (mirrors `add_entry`).
- [ ] **S7 — Generate step + real export meta.** Alternatives A/B/C with category-winner badges; real
  project name/address/logo/floor flow into the report + takeoff.
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
- [~] **Reach ~80–110 workstations on 882m².** Currently caps at 52 because the full support program
  for 88 people (28 rooms incl. 8 phone booths) legitimately eats ~40% of the floor. A leaner, more
  qbiq-like support ratio in `SpaceProgram::derive` (fewer booths/focus) would lift the field — density
  is already professional (10 m²/person), so this is refinement, not a blocker.
- [ ] **Keep-existing / respect-partitions mode** (workflow-gated) — re-enable pushing imported walls
  when the user wants to work *around* their existing fit-out (via S2/S4 controls).

## Track C — Qbiq-grade deliverables (`docs/reference/qbiq/`)
- [x] **Space-planning report PDF** — cover, 3D-tour page, A/B/C KPI-rail + colored plan + legend,
  summary (comparison table + radar + space-mix). `export/report.ts`.
- [x] **Quantity takeoff Excel** — hand-rolled .xlsx, per-room BOM + wall schedule, ₹. `export/takeoff.ts`.
- [x] DXF · [x] PDF sheet · [x] IFC (BIM) · [x] OBJ+MTL · [x] PNG · [x] CSV.
- ⏸ **Photoreal renders** — deprioritized (needs 3D-asset library + path tracer / cloud render).
- [ ] **RVT** — native Revit is proprietary; we export IFC (imports to Revit). Revit sample = web viewer.
- [ ] **Report polish** — building photo on cover, richer A/B/C differentiation, real client branding.

## Track D — CAD editing (Rayon-grade)
- [x] Draw: line/polyline/rect/circle/arc/ellipse/dimension/text/door/window/column/hatch.
- [x] Modify: move/copy/rotate/mirror/scale/offset, **grip-drag**, trim/extend/fillet, layers panel.
- [x] OSNAP engine, CAD ⌘Z, commit-sketch-to-plan (CAD → document walls).
- [ ] Deferred CAD: array tool (thin), spline, DXF layer-name export for CAD entities.

## Track E — Import & plate
- [x] DWG/DXF parse (LibreDWG `/api/dwg`), plate extraction (furniture-coverage), keepouts (cores),
  entries, interior-wall extraction, editable imported furniture, palette-place new catalog items.
- [ ] Area-select / markers+refs / wall-heal (⇒ Track A S2–S4).
- [ ] PDF/image import with scale confirmation (deferred, CAD-only v1).

## Track F — Material bank / Materio
- [x] Live bank (VPS, ~159k products) via `/api/bank`; ₹ pricing; bind products; decision lifecycle;
  selection cards; by-category plan; specified-cost metric.
- [ ] Per-element material assignment surfaced in the takeoff Supplier column (binding has price, no
  supplier field yet) — add supplier to BindingInfo.

## Track G — AI backbone
- [x] Drivers: Local intent parser · Cerebras LLM · Claude (`/api/claude`); 3-way toggle; preview→approve
  →undo; consequence reasoning; Claude soft-goal candidate evaluator.
- [ ] Workflow-aware AI: reference rooms by number ("tell me about room 502"), program-from-brief,
  in-loop generation steering.

## Track H — 3D / visualization
- [x] Three.js 2D↔3D viewer, walkthrough, Enscape-like render tier (sky/GTAO/bloom), glass/PBR,
  click-to-pick, glazing walls translucent.
- [ ] Better real-time materials/furniture models ("good-enough" for client walkthrough — chosen over
  photoreal). Visual tuning needs a real GPU (untestable headless).

## Track I — Persistence, library, projects
- [x] `.dsource` save/open, plan library (IndexedDB), scenario compare, version history, multi-floor
  projects (grouping + floor switcher).
- [ ] **Cloud plan sync** — `POST /api/plans` exists server-side; client `sync.ts` loop (push/pull,
  last-write-wins) unwritten.

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
- [ ] `e2e-core-geom.mjs` (scratchpad) asserts interior walls pushed on test-fit — stale after the
  shell-fit default; update when Track A S2–S4 land.
- [ ] Disk on dev machine ~97% full (17GB free) — occasional transient git "failed to write object".
- [ ] `ANTHROPIC_API_KEY` not always in env → Claude-driver E2E assertion is environ(not a regression).

## Immediate next (working order)
1. [x] Real-plate density arbitration — verified on the user's DWG (52 ws @ 10 m²/person), merged.
2. Track A S1 (Space step + detected readouts), then S2–S4 (area-select, markers+refs, heal).
3. Track A S5–S6 (program builder + anchor pins) — needs a `Program` room-spec (Rust, serde-additive).
4. Track A S7 (generate step + real export meta) — closes the end-to-end flow.
5. Cloud sync (Track I) + deploy (Track J) when SSH is unblocked.
