// Shape-agnostic zone geometry: center, bbox, outline ring, point-in-shape and
// size ORDERING for a `ZoneShape` (Rect · RectRing · boundary-conforming Poly).
// One source of truth so every consumer (stats, exports, sheets, costing)
// handles `Poly` zones identically instead of re-deriving x/w/h per file.
// Meters, plan convention. Pure TS, no deps.
//
// ── THIS MODULE DOES NOT COMPUTE A ROOM'S AREA (R17) ────────────────────────
//
// A room's area in m² is a CORE-OWNED quantity with exactly one definition,
// `crates/ds-core/src/lib.rs`'s `mod basis`. That definition clips each zone to
// the traced floor plate, de-overlaps Workspace fields against the rooms carved
// out of them, and applies the overflow cap. A shape's raw extent is none of
// those things, and on a real plan the two are not close: on the unedited F1
// fixture, `Open Workspace (2)` measures 35.0 m² raw and 8.0 m² on the basis.
//
// This module used to export `zoneArea(shape)`, and eleven call sites read it.
// Two of them PRINTED it as the room's area: sheet A.09's `AREA m²` column and
// the room label on every plan sheet. The workbook, reading the core, billed the
// same room at 8.0 — a 4.4x disagreement inside one delivered pack, on an
// unedited fixture, under a 49/49 green board, because nothing anywhere read the
// sheet's area column back.
//
// A `grep zoneArea` census of that defect reported seven owners.
// `scripts/gates/area-census.mjs`, which looks for the QUANTITY rather than the
// SYMBOL, found ten on the same tree: three more publishers named nothing at all
// — an inlined shoelace in the 3D viewer's zone readout, and two `?? s.w * s.h`
// fallbacks in the canvas painter, one of which entered as a degeneracy test and
// was then spent as an area.
//
// So the helper no longer exists. web/ RECEIVES areas — `ZoneAreas`, built from
// `Editor.zone_stats_published()` or `Editor.quantities()` (see
// `types/metrics.ts`) — and the only size information derivable from a shape
// here is an ORDERING, which cannot be printed as a quantity because it is not
// one. `scripts/gates/area-census.mjs` holds that line in both languages.

import type { ZoneShape } from '../types/doc'

/**
 * Unclipped geometric extent of a shape. **PRIVATE, and it stays private** —
 * exporting it would put a number in m² back into web/, which is the whole
 * defect. Reachable only through {@link compareZoneExtent}.
 */
function shapeExtent(s: ZoneShape): number {
  if (s.kind === 'Poly') {
    let a = 0
    for (let i = 0; i < s.pts.length; i++) {
      const [x0, y0] = s.pts[i]
      const [x1, y1] = s.pts[(i + 1) % s.pts.length]
      a += x0 * y1 - x1 * y0
    }
    return Math.abs(a) / 2
  }
  if (s.kind === 'RectRing') return Math.max(0, s.w * s.h - s.in_w * s.in_h)
  return Math.max(0, s.w * s.h)
}

/**
 * Order two zone shapes by size: `<0` when `a` is smaller, `>0` when larger.
 * A comparator, not a magnitude — `sort`, `max` and "the smallest zone
 * containing this point" are the legitimate uses, and nothing else is possible.
 *
 * **It is deliberately the RAW extent, and it must stay raw**, because the one
 * ordering that has to agree with the core is `Document::zone_index_at`, which
 * ranks by `z.shape.area()` — raw. `takeoff.zoneAtPoint` mirrors that rule so
 * the workbook's Furniture Elements column and the core's headcount bucketing
 * cannot disagree about which room a desk is in; ordering by clipped areas here
 * would silently break that agreement to "fix" a number nobody prints.
 */
export function compareZoneExtent(a: ZoneShape, b: ZoneShape): number {
  return shapeExtent(a) - shapeExtent(b)
}

/**
 * True when a shape encloses no drawable region — a collapsed polygon, a
 * zero-width rect, a ring whose hole eats it. A PREDICATE, not a measurement:
 * renderers need to know whether there is anything to fill or label, and that
 * question is answerable from geometry alone without producing a quantity.
 *
 * It exists so the shoelace kernel stays in this file. `paint.ts` had its own
 * copy, ostensibly for exactly this test, and the value it computed was then
 * used as a room's area behind a `??` — which is how a degeneracy guard became
 * the tenth definition of a published quantity.
 */
export function isDegenerateZoneShape(s: ZoneShape): boolean {
  return shapeExtent(s) < 1e-6
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
