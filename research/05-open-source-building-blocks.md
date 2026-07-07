# Open-Source Building Blocks

Candidate OSS to fork/extend instead of building from zero. **Licenses and current activity must be
re-verified before adoption** — the notes below are from research, not a license audit.

## 2D floor-plan / CAD editors

### Arcada — React + Pixi.js interior design / floor-plan creator
Repo: <https://github.com/mehanix/arcada>
- **Stack:** React (UI) · **Pixi.js** (WebGL 2D rendering) · **Zustand** (state) · Mantine (components) ·
  Express + MongoDB/Mongoose (backend).
- **Features:** add/edit walls, add/edit furniture, add doors/windows, measure tool, accurate-to-scale,
  multiple floors. Custom floor-plan engine (no external CAD lib).
- **[Inferred] representation:** walls = line segments with editable endpoints; rooms implied by
  connected walls; furniture = draggable objects (rotate/scale); doors/windows = elements on wall
  segments.
- **Why it matters:** the closest architectural match to our 2D editor core, and the Pixi.js choice
  echoes Rayon's "use WebGL for the canvas, keep React off the drawing surface" principle.
- **Risk:** likely a student/portfolio-scale project — good as a **reference/starting point**, probably
  not a production core as-is. Verify scope before committing.

### OpenFPC — 2D CAD on React + Three.js + Immutable
Repo: <https://github.com/socialtables/openfpc>
- Open variant of Social Tables' floor-authoring app; React + Three.js + Immutable, packaged with
  Electron.
- **Why it matters:** a Three.js-based take (vs Pixi), and Immutable hints at an undo/redo-friendly,
  snapshot-based document model.
- **Risk:** age/maintenance unknown — verify.

### LibreCAD — mature desktop 2D CAD
- Full-featured open-source 2D CAD (snap-to-grid, layers, DWG/DXF lineage via LibreDWG).
- **Why it matters:** not web-native, but the **canonical reference** for 2D CAD command sets, DXF/DWG
  handling, and drafting UX. Good source of domain knowledge; not a frontend to fork.

## 3D

### Pascal Editor 3D
Site: <https://pascaleditor3d.com/> — React + Three.js + WebGPU (per search results).
- Reference for the **3D viewing / walkthrough** layer and for a modern WebGPU rendering path.

### Three.js (foundation)
- The default choice for browser 3D. A 2D plan of walls + placed products **extrudes** cleanly into a
  Three.js scene for the 2D↔3D toggle (walls → extruded meshes, furniture → glTF instances).

## Rendering-engine decision (the Rayon lesson)

- **Rayon** built a custom Rust/Wasm/WebGL renderer for CAD-scale performance (`01-rayon.md`).
- **Pragmatic path for us:** start on a mature 2D WebGL lib (**Pixi.js**, as Arcada uses) for the plan
  canvas + **Three.js** for 3D. Only invest in a custom renderer if/when object counts demand it.
- Alternative to evaluate: **tldraw** (MIT, React) as an infinite-canvas/interaction substrate, though
  it's diagram-first, not CAD-precise — verify it can carry metric-accurate geometry.

## Interop / file formats

- **DXF/DWG import-export:** `libredwg` (GNU) / `dxf-parser` (JS) — verify licenses; DWG is the harder
  format. Laiout & qbiq both treat a **"CAD cleaner"** (normalize messy imports) as a distinct step.
- **3D exchange:** glTF/OBJ for assets; IFC (via `web-ifc`, MIT) if BIM interop is needed.

## Collaboration (if multiplayer is in scope)

- **Yjs** (MIT) or **Automerge** — CRDT libraries for real-time multiplayer over a shared document.
  Design the document model to be CRDT-friendly from the start (Rayon's multiplayer is a north star).

## What still needs a decision
- Language/perf ceiling for the geometry core: **TypeScript-first** (fast to build) vs **Rust/Wasm**
  (Rayon-grade scale). See `08-open-questions.md`.
- Buy vs build for the engine (Archilogic SDK exists as a commercial alternative).
