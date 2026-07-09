// Area-select filter — design: docs/design/workflow.md §3.1 (Slice 2).
//
// A tenant working on part of a floor draws a polygon around their sub-area on
// the imported plan; `restrictDrawing` produces a NON-DESTRUCTIVE copy of the
// Drawing containing only the geometry inside that polygon. The original stays
// on the draft; the restricted copy feeds (a) the Space-step readouts and (b)
// `extractPlate`/keepouts/entries at test-fit time, so the plate is traced
// within the selected area only.
//
// Pure TS, dependency-free. Coordinates in meters, drawing (source) space.

import type { Drawing, DrawEntity } from './types'
import { pointInRing, type Pt } from './testfit'

/** Representative sample points of an entity for the inside test: every
 *  polyline vertex, an arc/circle center, a text anchor. An entity is kept if
 *  ANY sample is inside — so a wall that straddles the polygon edge is not lost. */
function entitySamples(e: DrawEntity): Pt[] {
  const pts: Pt[] = []
  if (e.pts) for (const p of e.pts) pts.push([p[0], p[1]])
  if (e.cx != null && e.cy != null) pts.push([e.cx, e.cy])
  if (e.tx != null && e.ty != null) pts.push([e.tx, e.ty])
  return pts
}

/** Bounds [minX,minY,maxX,maxY] of the surviving geometry, or the drawing's
 *  own bounds when nothing survives (degenerate, but keeps callers safe). */
function boundsOf(
  entities: DrawEntity[],
  furnitureBoxes: [number, number, number, number][],
  fallback: [number, number, number, number],
): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const ext = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const e of entities) {
    if (e.pts) for (const p of e.pts) ext(p[0], p[1])
    if (e.cx != null && e.cy != null && e.r != null) {
      ext(e.cx - e.r, e.cy - e.r)
      ext(e.cx + e.r, e.cy + e.r)
    }
    if (e.tx != null && e.ty != null) ext(e.tx, e.ty)
  }
  for (const [x0, y0, x1, y1] of furnitureBoxes) {
    ext(x0, y0)
    ext(x1, y1)
  }
  return minX <= maxX && minY <= maxY ? [minX, minY, maxX, maxY] : fallback
}

/**
 * Restrict a drawing to a sub-area polygon (drawing/source coords).
 *
 * - A polygon with fewer than 3 vertices is the identity (returns the input
 *   unchanged) — nothing is selected, so nothing is dropped.
 * - A `FurnitureItem` is kept iff its bbox center is inside the polygon.
 * - A `DrawEntity` is kept iff any of its sample points is inside.
 * - `bounds` is recomputed from the survivors so `extractPlate` frames the
 *   sub-area, not the whole sheet.
 *
 * Non-destructive: a fresh `Drawing` is returned; the input is not mutated.
 */
export function restrictDrawing(drawing: Drawing, polygon: Pt[] | null | undefined): Drawing {
  if (!polygon || polygon.length < 3) return drawing
  const furniture = drawing.furniture.filter((f) => {
    const cx = (f.bbox[0] + f.bbox[2]) / 2
    const cy = (f.bbox[1] + f.bbox[3]) / 2
    return pointInRing(cx, cy, polygon)
  })
  const entities = drawing.entities.filter((e) => {
    const s = entitySamples(e)
    return s.length > 0 && s.some(([x, y]) => pointInRing(x, y, polygon))
  })
  const bounds = boundsOf(
    entities,
    furniture.map((f) => f.bbox),
    drawing.bounds,
  )
  return { ...drawing, entities, furniture, bounds }
}
