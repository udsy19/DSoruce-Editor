# CAD components — taxonomy + incorporation plan

Goal: turn DSource's 2D editor into a real CAD drafting tool (Rayon/Revit-grade),
not just a generative + import viewer. Grounded in the standard AutoCAD/DXF model.

**Code anchors:** `web/src/cad/` — entity model `model.ts` (+ `web/src/types/cad.ts`), OSNAP engine
`snap.ts`, tool registry / input loop `controller.ts`, draw tools `geomTools.ts`, modify tools
`editTools.ts`, architectural tools `archTools.ts`, annotation + dimension tools `annoTools.ts`,
dimension editing `dimEdit.ts`, dynamic input `dynamicInput.ts`, rendering `render.ts`, document
store `store.ts`, core commit `commit.ts` (persisted via `Editor::set_cad_json` /
`Editor::get_cad_json`, `crates/ds-core/src/lib.rs`).

## The standard CAD taxonomy (researched)

**Draw entities (DXF ENTITIES):** LINE, LWPOLYLINE/POLYLINE, ARC, CIRCLE, ELLIPSE,
SPLINE, HATCH, TEXT, MTEXT, DIMENSION, LEADER/MLEADER, POINT, BLOCK+INSERT, SOLID.
(Autodesk DXF ENTITIES reference; ezdxf entity docs.)

**Object snaps (OSNAP)** — the feature that makes CAD *precise*: endpoint,
midpoint, center, intersection, quadrant, perpendicular, tangent, node/point,
nearest, extension, insertion, parallel — plus grid snap and polar/ortho.
(AutoCAD OSNAP guides.)

**Modify/edit commands:** move, copy, rotate, scale, mirror, offset, array,
trim, extend, fillet, chamfer, stretch, explode, and **grips** (direct
endpoint/vertex drag). (AutoCAD Modify reference.)

**Architectural / BIM elements:** wall (with thickness + auto-join), door,
window (wall-hosted parametric), column, beam, grid, level, dimension,
room/space. (These map onto our walls + zones + a hosted-object model.)

## What we already have

- `EditorCanvas.ts` (generative 2D): walls (thin segments via Rust `add_wall`),
  furniture components (real symbols now), zones, pan/zoom/rulers, a simple
  tool model (`select | wall | place:*`).
- `import/DrawingCanvas.ts`: renders + edits imported DXF entities (polyline/
  arc/circle/text) + furniture blocks.
- Rust document = walls/components/zones (the *generative* source of truth).

The gap: no precise **snapping**, no general **draw entities**, no **edit ops**
(move/rotate/copy/mirror/offset/grips), no **architectural objects** (doors/
windows/columns). This doc adds a **CAD layer** (`web/src/cad/`) that supplies
all of these, integrated into `EditorCanvas`.

## Architecture — a TS CAD layer (`web/src/cad/`)

Rendering + input are already TS-side (ADR 0001), so the CAD layer is TS. It is a
set of modules around one shared contract (`cad/model.ts`), so the pieces build
in parallel and `EditorCanvas` wires them via a thin `CadController`:

- **`cad/model.ts`** (CONTRACT, authoritative) — `CadEntity` union (line,
  polyline, rect, circle, arc, ellipse, dimension, text, door, window, column),
  `CadStore` (entities + add/update/remove/undo), `SnapType`/`SnapResult`/
  `SnapContext`, `CadTool`/`ToolCtx`, render signatures. Meters, world coords
  matching EditorCanvas (no Y-flip).
- **`cad/snap.ts`** — the osnap engine: `snap(cursor, ctx) -> SnapResult`
  (endpoint/midpoint/center/intersection/perpendicular/nearest/grid + extension),
  against entities + walls + components + grid, within a pixel tolerance.
- **`cad/geomTools.ts`** — draw tools: line, polyline, rectangle, circle, arc,
  ellipse. Snap-aware, live length/angle readout, ghost preview.
- **`cad/annoTools.ts`** — dimension (linear/aligned) + text + leader.
- **`cad/archTools.ts`** — door (swing symbol, wall-hosted), window (in-wall
  break), column. Parametric symbols.
- **`cad/editTools.ts`** — select (click + window/crossing box), move, copy,
  rotate, scale, mirror, offset, delete, and **grips** (drag entity vertices).
- **`cad/store.ts`** — `CadStore` impl with an undo stack.
- **`cad/render.ts`** — draw all entities + previews + snap indicator + grips.

`EditorCanvas` gains a `CadController` (holds store + active tool), routes
pointer/keyboard/render to it, and a CAD toolbar (rail) selects tools. Existing
wall/place/zone behavior stays; the wall tool becomes snap-aware.

## Incorporation phases (parallel-agent friendly)

- **P1 Snapping** (`snap.ts`) — the multiplier; everything draws better with it.
- **P2 Geometry draw tools + store + render** (`geomTools.ts`, `store.ts`,
  `render.ts`) — line/polyline/rect/circle/arc/ellipse with snapping + live dims.
- **P3 Annotation + architectural** (`annoTools.ts`, `archTools.ts`) —
  dimension, text; door/window/column symbols.
- **P4 Edit/modify + grips** (`editTools.ts`) — move/copy/rotate/scale/mirror/
  offset/delete + grip drag.
- **Integration** (owner: main) — `CadController` in EditorCanvas + toolbar +
  input routing + render; then E2E test each tool.

## Deferred / later
- SPLINE, HATCH fill patterns, MLEADER, ARRAY (polar/rect), TRIM/EXTEND/FILLET
  (geometry-solver heavy), layers panel, polar tracking/ortho toggle UI,
  committing CAD entities into the Rust document, DWG/IFC export of drawn CAD.
- **Material bank work is intentionally last** (already functional for imports).
