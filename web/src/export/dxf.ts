// Vector export: DocState -> DXF R12 ASCII.
//
// DXF R12 is the most widely-readable ASCII CAD format. Every file we emit has
// three sections: a tiny HEADER declaring $INSUNITS = 6 (meters — the core's
// unit; without it AutoCAD-class readers, and our own importer, assume
// inches), a TABLES section declaring every layer used (strict readers want
// layers declared before ENTITIES), and the ENTITIES section itself.
//
// R12-safe entity set only: LINE, POLYLINE/VERTEX/SEQEND, CIRCLE, ARC, TEXT.
// No LWPOLYLINE (R2000+), no ELLIPSE (tessellated instead).
//
// Units: the core is in meters and DXF is unitless, so 1 drawing unit = 1 m.
// Coordinates are taken straight from DocState and component rectangles are
// rotated with the same matrix EditorCanvas uses (ctx.translate + ctx.rotate),
// keeping the exported geometry consistent with what is drawn on screen.

import type { DocState } from '../editor/EditorCanvas'
import type { CadEntity, Vec2 } from '../cad/model'
import type { Drawing, DrawEntity } from '../import/types'
import { triggerDownload } from './png'

const DEG = 180 / Math.PI

// Format a coordinate with enough precision for millimetre-scale geometry
// without dumping float noise into the file.
function f(n: number): string {
  return n.toFixed(4)
}

// A valid DXF layer name from any source string (category or original CAD
// layer): uppercase, spaces → '_', characters illegal in DXF symbol-table
// names stripped (only letters, digits, '_', '-', '$' and '.' survive).
// Fall back to layer "0".
function layerName(source: string): string {
  const clean = source
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase()
    .replace(/[^A-Z0-9_\-$.]/g, '')
  return clean.length > 0 ? clean : '0'
}

// One LINE entity from (x1,y1) to (x2,y2) on the given layer.
function line(layer: string, x1: number, y1: number, x2: number, y2: number): string {
  return [
    '0',
    'LINE',
    '8',
    layer,
    '10',
    f(x1),
    '20',
    f(y1),
    '30',
    '0.0',
    '11',
    f(x2),
    '21',
    f(y2),
    '31',
    '0.0',
  ].join('\n')
}

// The four world-space corners of a rotated w×h rect centered at (x, y).
// Matches EditorCanvas.drawComponent: local rect [-w/2..w/2, -h/2..h/2]
// transformed by ctx.rotate(rotation) then translated to (x, y). Canvas rotate
// uses the standard matrix [cos,-sin; sin,cos]; it merely reads as clockwise
// because the y-axis points down. We reuse it verbatim.
function rectCorners(x: number, y: number, w: number, h: number, rotation: number): Vec2[] {
  const hw = w / 2
  const hh = h / 2
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
  return local.map(([lx, ly]) => ({ x: x + lx * cos - ly * sin, y: y + lx * sin + ly * cos }))
}

// LINE segments of a Vec2 polyline (+closing edge when `closed`).
function vecLines(layer: string, pts: Vec2[], closed: boolean): string[] {
  if (pts.length < 2) return []
  const out: string[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(line(layer, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y))
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1]
    const b = pts[0]
    out.push(line(layer, a.x, a.y, b.x, b.y))
  }
  return out
}

// A single R12 POLYLINE / VERTEX… / SEQEND chain. Group 66 = 1 ("vertices
// follow", required in R12), group 70 bit 1 = closed. One entity instead of
// N LINEs keeps the round-tripped file editable as the polyline it was.
function polylineEnt(layer: string, pts: Array<[number, number]>, closed: boolean): string {
  const out = [
    '0', 'POLYLINE', '8', layer,
    '66', '1',
    '10', '0.0', '20', '0.0', '30', '0.0',
    '70', closed ? '1' : '0',
  ]
  for (const [x, y] of pts) {
    out.push('0', 'VERTEX', '8', layer, '10', f(x), '20', f(y), '30', '0.0')
  }
  out.push('0', 'SEQEND', '8', layer)
  return out.join('\n')
}

// An ARC entity (R12): center (10/20), radius (40), start/end angles in
// DEGREES (50/51). DXF sweeps CCW from 50 to 51 on the same cos/sin
// parametrization the model uses (radians CCW — see import/types.ts), so
// radians→degrees is exact; the importer converts back with π/180.
function arcEnt(layer: string, cx: number, cy: number, r: number, start: number, end: number): string {
  return [
    '0', 'ARC', '8', layer,
    '10', f(cx), '20', f(cy), '30', '0.0',
    '40', f(r), '50', f(start * DEG), '51', f(end * DEG),
  ].join('\n')
}

// A TEXT entity (R12): insertion point (10/20), height (40), value (1),
// rotation in degrees (50). `rot` is radians (model convention).
function textEnt(layer: string, x: number, y: number, h: number, value: string, rot = 0): string {
  return [
    '0', 'TEXT', '8', layer,
    '10', f(x), '20', f(y), '30', '0.0',
    '40', f(h), '1', value, '50', f(rot * DEG),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// File assembly: HEADER + TABLES(LAYER) + ENTITIES + EOF.
// ---------------------------------------------------------------------------

// Every layer referenced by the generated entity strings. Entity strings are
// strictly code/value pairs, so group codes sit at even indices — a value that
// happens to be "8" can never be mistaken for the layer group code.
function usedLayers(entities: string[]): string[] {
  const set = new Set<string>()
  for (const ent of entities) {
    const lines = ent.split('\n')
    for (let i = 0; i < lines.length - 1; i += 2) {
      if (lines[i] === '8') set.add(lines[i + 1])
    }
  }
  if (set.size === 0) set.add('0')
  return [...set].sort()
}

// Wrap finished entity strings into a complete R12 file:
//   HEADER  — $INSUNITS 6 (meters) so units survive the round trip
//   TABLES  — a LAYER table declaring every layer used (color 7, CONTINUOUS)
//   ENTITIES, then EOF.
function assembleDXF(entities: string[]): string {
  const layers = usedLayers(entities)
  const out = [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$INSUNITS', '70', '6',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES',
    '0', 'TABLE', '2', 'LAYER', '70', String(layers.length),
  ]
  for (const name of layers) {
    out.push('0', 'LAYER', '2', name, '70', '0', '62', '7', '6', 'CONTINUOUS')
  }
  out.push('0', 'ENDTAB', '0', 'ENDSEC')
  return [...out, '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join(
    '\n',
  )
}

// ---------------------------------------------------------------------------
// CAD drafting entities (cad/model.ts) → DXF R12. Geometry goes on DRAFTING;
// dimension/text annotation on ANNOTATION. R12 has no ELLIPSE, so ellipses are
// tessellated; dimensions become their extension + dim lines plus a TEXT.
// Legacy door/window/column blobs are skipped — those are doc components now.

const DRAFT_LAYER = 'DRAFTING'
const ANNO_LAYER = 'ANNOTATION'
const DIM_TEXT_H = 0.15 // annotation text height, meters
const ELLIPSE_SEGS = 32

function cadEntityToDXF(e: CadEntity): string[] {
  switch (e.kind) {
    case 'line':
      return [line(DRAFT_LAYER, e.a.x, e.a.y, e.b.x, e.b.y)]
    case 'polyline':
      return vecLines(DRAFT_LAYER, e.pts, e.closed)
    case 'rect':
      return vecLines(DRAFT_LAYER, rectCorners(e.x, e.y, e.w, e.h, e.rotation), true)
    case 'circle':
      return [circle(DRAFT_LAYER, e.c.x, e.c.y, e.r)]
    case 'arc':
      return [arcEnt(DRAFT_LAYER, e.c.x, e.c.y, e.r, e.start, e.end)]
    case 'ellipse': {
      const cos = Math.cos(e.rotation)
      const sin = Math.sin(e.rotation)
      const pts: Vec2[] = []
      for (let i = 0; i < ELLIPSE_SEGS; i++) {
        const t = (i / ELLIPSE_SEGS) * Math.PI * 2
        const lx = Math.cos(t) * e.rx
        const ly = Math.sin(t) * e.ry
        pts.push({ x: e.c.x + lx * cos - ly * sin, y: e.c.y + lx * sin + ly * cos })
      }
      return vecLines(DRAFT_LAYER, pts, true)
    }
    case 'dimension': {
      // Same construction as cad/render.ts drawDimension: dim line offset along
      // the a→b normal, extension lines from the measured points, label = the
      // measured distance unless overridden.
      const dx = e.b.x - e.a.x
      const dy = e.b.y - e.a.y
      const d = Math.hypot(dx, dy) || 1
      const nx = -dy / d
      const ny = dx / d
      const a2 = { x: e.a.x + nx * e.offset, y: e.a.y + ny * e.offset }
      const b2 = { x: e.b.x + nx * e.offset, y: e.b.y + ny * e.offset }
      const label = e.text ?? `${Math.hypot(dx, dy).toFixed(2)} m`
      return [
        line(ANNO_LAYER, e.a.x, e.a.y, a2.x, a2.y),
        line(ANNO_LAYER, e.b.x, e.b.y, b2.x, b2.y),
        line(ANNO_LAYER, a2.x, a2.y, b2.x, b2.y),
        textEnt(ANNO_LAYER, (a2.x + b2.x) / 2, (a2.y + b2.y) / 2, DIM_TEXT_H, label, Math.atan2(dy, dx)),
      ]
    }
    case 'text':
      return [textEnt(ANNO_LAYER, e.at.x, e.at.y, e.h, e.text, e.rotation)]
    default:
      return []
  }
}

/** Build a valid DXF R12 ASCII string from a document state, plus any
 *  CAD drafting entities (see `EditorCanvas.cadEntities()`). */
export function docStateToDXF(state: DocState, cadEntities?: CadEntity[]): string {
  const entities: string[] = []

  for (const w of state.walls) {
    entities.push(line('WALLS', w.a.x, w.a.y, w.b.x, w.b.y))
  }

  for (const c of state.components) {
    // Closed rectangle as 4 LINEs (R12-safe; avoids LWPOLYLINE which is R2000+).
    entities.push(...vecLines(layerName(c.category), rectCorners(c.x, c.y, c.w, c.h, c.rotation), true))
  }

  for (const e of cadEntities ?? []) {
    entities.push(...cadEntityToDXF(e))
  }

  return assembleDXF(entities)
}

/** Build the DXF for a document state (+ CAD drafting) and trigger a download. */
export function downloadDXF(state: DocState, filename: string, cadEntities?: CadEntity[]): void {
  const blob = new Blob([docStateToDXF(state, cadEntities)], { type: 'application/dxf' })
  triggerDownload(blob, filename)
}

// ---------------------------------------------------------------------------
// Imported-plan export: a `Drawing` (see import/types) -> the same DXF R12.
//
// The Drawing is already meters, world-space, Y-up (DXF convention), so no
// transform is needed. Fidelity contract:
//   - every entity exports on its ORIGINAL source layer (sanitized), so a
//     round-tripped file looks native in the source CAD's layer manager;
//   - real geometry, not tessellation: arcs → ARC, circles → CIRCLE,
//     3+-point polylines → one POLYLINE chain (2-point ones stay LINE),
//     text → TEXT with height + rotation;
//   - furniture blocks export as their bounding rectangle on a
//     FURN_<source-layer-or-category> layer with the item name as a small
//     TEXT label alongside, so furniture schedules survive the hand-off.

// A CIRCLE entity (R12) — used for imported circle primitives (e.g. chairs).
function circle(layer: string, cx: number, cy: number, r: number): string {
  return ['0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0.0', '40', f(r)].join('\n')
}

// One imported DrawEntity → its DXF entity string(s) on the given layer.
function drawEntityToDXF(layer: string, e: DrawEntity): string[] {
  switch (e.kind) {
    case 'polyline': {
      const pts = e.pts
      if (!pts || pts.length < 2) return []
      // A plain 2-point open polyline is just a LINE — export it as one.
      if (pts.length === 2 && !e.closed) {
        return [line(layer, pts[0][0], pts[0][1], pts[1][0], pts[1][1])]
      }
      return [polylineEnt(layer, pts, !!e.closed)]
    }
    case 'arc':
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return []
      return [arcEnt(layer, e.cx, e.cy, e.r, e.start ?? 0, e.end ?? Math.PI * 2)]
    case 'circle':
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return []
      return [circle(layer, e.cx, e.cy, e.r)]
    case 'text':
      if (!e.text || e.tx === undefined || e.ty === undefined) return []
      return [textEnt(layer, e.tx, e.ty, e.h ?? DIM_TEXT_H, e.text, e.rot ?? 0)]
    default:
      return []
  }
}

/** Build a valid DXF R12 ASCII string from an imported drawing. */
export function drawingToDXF(drawing: Drawing): string {
  const entities: string[] = []

  for (const e of drawing.entities) {
    entities.push(...drawEntityToDXF(layerName(e.layer || e.category), e))
  }

  const FURN_LABEL_H = 0.15 // meters — small schedule-friendly label
  for (const it of drawing.furniture) {
    // Original source layer when the block geometry carries one; category
    // bucket otherwise (both sanitized).
    const layer = `FURN_${layerName(it.entities[0]?.layer || it.category)}`
    const [x0, y0, x1, y1] = it.bbox
    entities.push(
      polylineEnt(
        layer,
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
        true,
      ),
    )
    if (it.name) entities.push(textEnt(layer, x0, y0, FURN_LABEL_H, it.name))
  }

  return assembleDXF(entities)
}

/** Build the DXF for an imported drawing and trigger a download. */
export function downloadDrawingDXF(drawing: Drawing, filename: string): void {
  const blob = new Blob([drawingToDXF(drawing)], { type: 'application/dxf' })
  triggerDownload(blob, filename)
}
