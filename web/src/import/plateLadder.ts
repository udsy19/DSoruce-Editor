// The envelope-inference rungs, adopted from bake-off branch 1b.
//
// `extractPlate` tries these in order after loop tracing fails. Each is guarded,
// each declines cleanly, and the bottom rung always yields something — the
// ladder decides WHICH draft gets proposed, never whether the user gets one.
//
// Every rung below `traced-loop` produces `confidence: 'low'` (ADR 0002), so all
// of these are proposals the user confirms. The ladder improves the draft; it
// does not change what is asserted.
//
// Measured results, rationale and rejected alternatives: docs/adr/0003.
// The two rungs' weaknesses are complementary, which is why both exist:
//
//   |                     | shell fragments exist | no shell            |
//   | partitionContour    | IoU 0.979             | orphans furniture   |
//   | + furniture wrap    | IoU 0.734 (fills      | contains it (0.985) |
//   |                     | concavity)            |                     |

import { gridContour } from './testfit'
import type { Drawing, DrawEntity } from './types'

type Pt = [number, number]
type Segment = [Pt, Pt]

const CELL = 0.25
/** cells → metres of gap closed: 2..24 cells = 0.5 m .. 6.0 m. */
const DILATION_SCHEDULE = [2, 4, 6, 8, 12, 16, 20, 24]
/** An envelope that orphans furniture is wrong however clean its boundary is. */
export const CONTAINMENT_TARGET = 0.98

// ---- shared helpers ---------------------------------------------------------

export function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Fraction of furniture bbox centres inside `ring`. */
export function containment(ring: Pt[], drawing: Drawing): number {
  const items = drawing.furniture ?? []
  if (items.length === 0) return 1
  let inside = 0
  for (const f of items) {
    const [x0, y0, x1, y1] = f.bbox
    if (pointInPolygon([(x0 + x1) / 2, (y0 + y1) / 2], ring)) inside++
  }
  return inside / items.length
}

function furnitureBoxSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const f of drawing.furniture ?? []) {
    const [x0, y0, x1, y1] = f.bbox
    segs.push(
      [[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]],
      [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]],
    )
  }
  return segs
}

// ---- rung: partition contour (with or without a furniture wrap) -------------

/**
 * Occupancy-grid contour with a dilation schedule long enough to bridge real
 * door/window gaps (up to 6.0 m against the incumbent's 2.0 m ceiling), stopped
 * by furniture containment rather than coverage.
 *
 * `gridContour` is a morphological CLOSING: it bridges gaps in a boundary but
 * cannot extend past the extent of its input. That is why `wrapFurniture` exists
 * — adding furniture outlines extends the input to cover an orphaned wing — and
 * equally why wrapping fills re-entrant corners the walls correctly defined. Try
 * without the wrap first.
 *
 * Returns the tightest contour that still holds the furniture, or null.
 */
export function partitionContour(
  wallSegs: Segment[],
  drawing: Drawing,
  wrapFurniture: boolean,
): Pt[] | null {
  const segs = wrapFurniture ? [...wallSegs, ...furnitureBoxSegments(drawing)] : wallSegs
  if (segs.length === 0) return null
  for (const dilate of DILATION_SCHEDULE) {
    const ring = gridContour(segs as never, CELL, dilate) as Pt[] | null
    if (!ring || ring.length < 3) continue
    // Dilation only grows the region, so the first success is the tightest
    // envelope that still holds the furniture — the safe side of the
    // shrink-vs-orphan trade.
    if (containment(ring, drawing) >= CONTAINMENT_TARGET) return ring
  }
  return null
}

// ---- rung: column grid ------------------------------------------------------

const MIN_COLUMNS = 4
const COLUMN_MAX_SIDE = 1.5
const COLUMN_MIN_SIDE = 0.15
const LINE_MERGE_M = 0.8
/** Regularity guard: IQR of line spacings must be within this fraction of the median. */
export const MAX_IQR_FRACTION_OF_MEDIAN = 0.25

function columnCentres(drawing: Drawing): Pt[] {
  const out: Pt[] = []
  for (const e of (drawing.entities ?? []) as DrawEntity[]) {
    if (!/col|struct/i.test(e.layer ?? '')) continue
    const pts = (e.pts ?? []) as Pt[]
    if (pts.length < 3) continue
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const w = Math.max(...xs) - Math.min(...xs)
    const h = Math.max(...ys) - Math.min(...ys)
    if (w > COLUMN_MAX_SIDE || h > COLUMN_MAX_SIDE) continue
    if (w < COLUMN_MIN_SIDE || h < COLUMN_MIN_SIDE) continue
    out.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2])
  }
  return out
}

function gridLines(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const lines: number[] = []
  for (const v of sorted) {
    if (lines.length === 0 || v - lines[lines.length - 1] > LINE_MERGE_M) lines.push(v)
  }
  return lines
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

/**
 * Is this axis a regular grid, and if so what is its bay? Scattered columns and
 * mixed spacings must fail: on the user's real DWG the y-spacings are
 * 1.3/2.9/4.2/6.0/11.2/11.2 m, and half-extending that median produced a
 * 1950 m² envelope for a 1611 m² drawing.
 */
export function assessAxis(lines: number[]): { ok: boolean; bay: number } {
  if (lines.length < 2) return { ok: false, bay: 0 }
  const spacings = lines.slice(1).map((v, i) => v - lines[i]).sort((a, b) => a - b)
  const median = quantile(spacings, 0.5)
  if (median <= 0) return { ok: false, bay: 0 }
  const iqr = quantile(spacings, 0.75) - quantile(spacings, 0.25)
  return { ok: iqr / median <= MAX_IQR_FRACTION_OF_MEDIAN, bay: median }
}

/**
 * Envelope from the structural column grid, extended half a median bay (the slab
 * edge sits outside the perimeter columns). Returns null unless BOTH axes are
 * regular and the result holds the furniture — a column grid can only propose a
 * rectangle, so if it orphans furniture it is the wrong tool for that drawing.
 */
export function columnGridEnvelope(drawing: Drawing): Pt[] | null {
  const cols = columnCentres(drawing)
  if (cols.length < MIN_COLUMNS) return null
  const xLines = gridLines(cols.map((c) => c[0]))
  const yLines = gridLines(cols.map((c) => c[1]))
  const ax = assessAxis(xLines)
  const ay = assessAxis(yLines)
  if (!ax.ok || !ay.ok) return null

  const x0 = Math.min(...xLines) - ax.bay / 2
  const x1 = Math.max(...xLines) + ax.bay / 2
  const y0 = Math.min(...yLines) - ay.bay / 2
  const y1 = Math.max(...yLines) + ay.bay / 2
  const ring: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  return containment(ring, drawing) >= CONTAINMENT_TARGET ? ring : null
}
