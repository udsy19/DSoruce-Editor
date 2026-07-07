// Vector export: DocState -> minimal DXF R12 ASCII.
//
// DXF R12 is the most widely-readable ASCII CAD format. We emit only the
// ENTITIES section (LINEs), which R12 readers accept — layers referenced by
// entities are auto-created, so no TABLES section is required for a valid file.
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

// A DXF layer name: no spaces, non-empty. Fall back to layer "0".
function layerName(category: string): string {
  const clean = category.trim().replace(/\s+/g, '_').toUpperCase()
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

// An ARC entity (R12): center (10/20), radius (40), start/end angles in
// DEGREES (50/51). DXF sweeps from 50 to 51 with increasing angle on the same
// cos/sin parametrization the CAD model uses, so radians→degrees is exact.
function arcEnt(layer: string, cx: number, cy: number, r: number, start: number, end: number): string {
  return [
    '0', 'ARC', '8', layer,
    '10', f(cx), '20', f(cy), '30', '0.0',
    '40', f(r), '50', f(start * DEG), '51', f(end * DEG),
  ].join('\n')
}

// A TEXT entity (R12): insertion point (10/20), height (40), value (1),
// rotation in degrees (50).
function textEnt(layer: string, x: number, y: number, h: number, value: string, rot = 0): string {
  return [
    '0', 'TEXT', '8', layer,
    '10', f(x), '20', f(y), '30', '0.0',
    '40', f(h), '1', value, '50', f(rot * DEG),
  ].join('\n')
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

/** Build a minimal valid DXF R12 ASCII string from a document state, plus any
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

  return ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
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
// transform is needed. Linework entities become LINEs (a LINE is a 2-point
// open polyline in this model); furniture blocks are emitted as their bounding
// rectangle on a FURNITURE layer — matching the "furniture bboxes → rects"
// contract and keeping the file small and universally readable.

// Emit the LINE segments of one polyline entity on the given layer.
function polylineLines(layer: string, e: DrawEntity): string[] {
  const pts = e.pts
  if (!pts || pts.length < 2) return []
  const out: string[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(line(layer, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]))
  }
  if (e.closed && pts.length > 2) {
    const a = pts[pts.length - 1]
    const b = pts[0]
    out.push(line(layer, a[0], a[1], b[0], b[1]))
  }
  return out
}

// A CIRCLE entity (R12) — used for imported circle primitives (e.g. chairs).
function circle(layer: string, cx: number, cy: number, r: number): string {
  return ['0', 'CIRCLE', '8', layer, '10', f(cx), '20', f(cy), '30', '0.0', '40', f(r)].join('\n')
}

// The four LINEs of an axis-aligned bounding rectangle [minX,minY,maxX,maxY].
function bboxLines(layer: string, bbox: [number, number, number, number]): string[] {
  const [x0, y0, x1, y1] = bbox
  return [
    line(layer, x0, y0, x1, y0),
    line(layer, x1, y0, x1, y1),
    line(layer, x1, y1, x0, y1),
    line(layer, x0, y1, x0, y0),
  ]
}

/** Build a minimal valid DXF R12 ASCII string from an imported drawing. */
export function drawingToDXF(drawing: Drawing): string {
  const entities: string[] = []

  for (const e of drawing.entities) {
    const layer = layerName(e.category)
    if (e.kind === 'polyline') {
      entities.push(...polylineLines(layer, e))
    } else if (e.kind === 'circle' && e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
      entities.push(circle(layer, e.cx, e.cy, e.r))
    }
    // arcs/text are skipped: R12 arc angle semantics + text styling add weight
    // without helping a clean CAD hand-off; walls/glazing carry the geometry.
  }

  for (const it of drawing.furniture) {
    entities.push(...bboxLines('FURNITURE', it.bbox))
  }

  return ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
}

/** Build the DXF for an imported drawing and trigger a download. */
export function downloadDrawingDXF(drawing: Drawing, filename: string): void {
  const blob = new Blob([drawingToDXF(drawing)], { type: 'application/dxf' })
  triggerDownload(blob, filename)
}
