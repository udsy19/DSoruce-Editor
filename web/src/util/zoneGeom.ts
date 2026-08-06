// Shape-agnostic zone geometry: center, area, bbox, outline ring, and
// point-in-shape for a `ZoneShape` (Rect · RectRing · boundary-conforming Poly).
// One source of truth so every consumer (stats, exports, sheets, costing)
// handles `Poly` zones identically instead of re-deriving x/w/h per file.
// Meters, plan convention. Pure TS, no deps.

import type { ZoneShape } from '../types/doc'
/** Absolute shoelace area of a polygon ring (first vertex not repeated). */
function polyArea(pts: [number, number][]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/** Net enclosed area (m²); rings exclude the hole; polys use shoelace. */
export function zoneArea(s: ZoneShape): number {
  if (s.kind === 'Poly') return polyArea(s.pts)
  if (s.kind === 'RectRing') return Math.max(0, s.w * s.h - s.in_w * s.in_h)
  return Math.max(0, s.w * s.h)
}

/** Centroid of the shape (rect/ring center; polygon area-weighted centroid). */
export function zoneCenter(s: ZoneShape): { x: number; y: number } {
  if (s.kind !== 'Poly') return { x: s.x, y: s.y }
  let a2 = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < s.pts.length; i++) {
    const [x0, y0] = s.pts[i]
    const [x1, y1] = s.pts[(i + 1) % s.pts.length]
    const cross = x0 * y1 - x1 * y0
    a2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(a2) < 1e-9) {
    // Degenerate: fall back to the vertex average.
    const n = s.pts.length || 1
    return {
      x: s.pts.reduce((t, p) => t + p[0], 0) / n,
      y: s.pts.reduce((t, p) => t + p[1], 0) / n,
    }
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) }
}

/** Axis-aligned bounds `{minX, minY, maxX, maxY}` of the shape. */
export function zoneBBox(s: ZoneShape): { minX: number; minY: number; maxX: number; maxY: number } {
  if (s.kind !== 'Poly') {
    return { minX: s.x - s.w / 2, minY: s.y - s.h / 2, maxX: s.x + s.w / 2, maxY: s.y + s.h / 2 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of s.pts) {
    minX = Math.min(minX, px)
    minY = Math.min(minY, py)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Outline rings of the shape in world meters: `[outer, ...holes]`. A `Rect` and
 * a `Poly` yield one ring; a `RectRing` yields the outer ring plus its hole, so
 * a consumer that extrudes/fills a zone (3D floor plates, hatches) handles the
 * donut correctly instead of flooding the courtyard. First vertex not repeated.
 */
export function zoneRings(s: ZoneShape): [number, number][][] {
  const rect = (x: number, y: number, w: number, h: number): [number, number][] => [
    [x - w / 2, y - h / 2],
    [x + w / 2, y - h / 2],
    [x + w / 2, y + h / 2],
    [x - w / 2, y + h / 2],
  ]
  if (s.kind === 'Poly') return [s.pts.map(([x, y]) => [x, y] as [number, number])]
  if (s.kind === 'RectRing') return [rect(s.x, s.y, s.w, s.h), rect(s.x, s.y, s.in_w, s.in_h)]
  return [rect(s.x, s.y, s.w, s.h)]
}

/** True if world point `(x,y)` is inside the filled shape (ring excludes hole). */
export function pointInZoneShape(s: ZoneShape, x: number, y: number): boolean {
  if (s.kind === 'Poly') {
    let inside = false
    const p = s.pts
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i]
      const [xj, yj] = p[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const inRect = (cx: number, cy: number, w: number, h: number) =>
    x >= cx - w / 2 && x <= cx + w / 2 && y >= cy - h / 2 && y <= cy + h / 2
  if (s.kind === 'RectRing') {
    return inRect(s.x, s.y, s.w, s.h) && !inRect(s.x, s.y, s.in_w, s.in_h)
  }
  return inRect(s.x, s.y, s.w, s.h)
}
