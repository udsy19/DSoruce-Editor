// Shared 2D polygon clipping utilities, used by the 3D viewer's zone plates
// and (next) the 2D canvas. Lives in util/ rather than import/testfit.ts
// because testfit is import-domain (CAD → generator bridge) while clipping is
// renderer-shared geometry; the ring tracing itself is REUSED from testfit
// (`traceLoops`/`signedArea`), not reimplemented. Pure TS, no npm deps.
// Coordinates in meters, plan convention (X→right, Y→down).

import { traceLoops, signedArea } from '../import/testfit'

export type Pt = [number, number]

/** Shoelace signed area (CCW positive; ring's first vertex not repeated). */
export { signedArea as polygonArea }

/** Clip `poly` against one axis-aligned half-plane (a Sutherland–Hodgman pass). */
function clipHalfPlane(poly: Pt[], axis: 0 | 1, bound: number, keepBelow: boolean): Pt[] {
  const out: Pt[] = []
  const inside = (p: Pt): boolean => (keepBelow ? p[axis] <= bound : p[axis] >= bound)
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const aIn = inside(a)
    if (aIn) out.push(a)
    if (aIn !== inside(b)) {
      const t = (bound - a[axis]) / (b[axis] - a[axis])
      out.push(
        axis === 0
          ? [bound, a[1] + t * (b[1] - a[1])]
          : [a[0] + t * (b[0] - a[0]), bound],
      )
    }
  }
  return out
}

/**
 * Sutherland–Hodgman: clip polygon `poly` (ring, first vertex not repeated,
 * either winding) against the axis-aligned rect spanned by (x0, y0)–(x1, y1).
 * Returns the clipped ring, or `[]` when poly and rect are disjoint.
 */
export function clipPolyToRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  if (poly.length < 3) return []
  const lx = Math.min(x0, x1)
  const hx = Math.max(x0, x1)
  const ly = Math.min(y0, y1)
  const hy = Math.max(y0, y1)
  let out = clipHalfPlane(poly, 0, lx, false)
  out = clipHalfPlane(out, 0, hx, true)
  out = clipHalfPlane(out, 1, ly, false)
  out = clipHalfPlane(out, 1, hy, true)
  return out.length >= 3 ? out : []
}

/**
 * Trace the floor-plate polygon from wall segments: snap endpoints to `tol`
 * (default 0.01 m — hand-drawn/pushed walls meet exactly or near-exactly),
 * trace the closed rings of the wall graph, and return the largest-area one.
 * Returns null when no ring closes (open wall sketches).
 */
export function platePolygonFromWalls(
  walls: { a: { x: number; y: number }; b: { x: number; y: number } }[],
  tol = 0.01,
): Pt[] | null {
  if (walls.length < 3) return null
  const segments: [Pt, Pt][] = walls.map((w) => [
    [w.a.x, w.a.y],
    [w.b.x, w.b.y],
  ])
  const loops = traceLoops(segments, tol)
  let best: Pt[] | null = null
  let bestArea = 0
  for (const ring of loops) {
    const a = Math.abs(signedArea(ring))
    if (a > bestArea) {
      bestArea = a
      best = ring
    }
  }
  return best
}
