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

import type { DocState, DocComponent } from '../editor/EditorCanvas'
import { triggerDownload } from './png'

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

// The four world-space corners of a component's rotated w×h footprint.
// Matches EditorCanvas.drawComponent: local rect [-w/2..w/2, -h/2..h/2]
// transformed by ctx.rotate(rotation) then translated to (x, y).
function componentCorners(c: DocComponent): Array<[number, number]> {
  const hw = c.w / 2
  const hh = c.h / 2
  const cos = Math.cos(c.rotation)
  const sin = Math.sin(c.rotation)
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]
  // Canvas rotate uses the standard matrix [cos,-sin; sin,cos]; it merely reads
  // as clockwise because the y-axis points down. We reuse it verbatim.
  return local.map(([lx, ly]) => [c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos])
}

/** Build a minimal valid DXF R12 ASCII string from a document state. */
export function docStateToDXF(state: DocState): string {
  const entities: string[] = []

  for (const w of state.walls) {
    entities.push(line('WALLS', w.a.x, w.a.y, w.b.x, w.b.y))
  }

  for (const c of state.components) {
    const layer = layerName(c.category)
    const p = componentCorners(c)
    // Closed rectangle as 4 LINEs (R12-safe; avoids LWPOLYLINE which is R2000+).
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = p[i]
      const [bx, by] = p[(i + 1) % 4]
      entities.push(line(layer, ax, ay, bx, by))
    }
  }

  return ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
}

/** Build the DXF for a document state and trigger a download. */
export function downloadDXF(state: DocState, filename: string): void {
  const blob = new Blob([docStateToDXF(state)], { type: 'application/dxf' })
  triggerDownload(blob, filename)
}
