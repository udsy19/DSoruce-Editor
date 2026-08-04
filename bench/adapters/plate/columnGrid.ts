// `column-grid` — infer the tenancy envelope from the structural column grid.
//
// When no shell is drawn, the columns often still are, and a slab edge sits
// roughly half a structural bay outside the perimeter columns (the columns are
// inside the floor plate, not on its edge). So: find the columns, prove they
// actually form a grid, take their extent, and extend half a bay.
//
// The plausibility guard is the whole rung. Pre-registered in ADR 0003 with two
// negative cases it MUST reject, both measured before this was written:
//   - rect-no-shell-only-partitions: 12 columns at 11 distinct x positions —
//     random scatter, no bay to infer.
//   - the real furniture-plan.dwg: 8 column-like shapes on 4 plausible x lines
//     (10.2/11.6/12.3 m) but 7 y lines spaced 1.3/2.9/4.2/6.0/11.2/11.2 m. Taking
//     the median y-spacing and extending half a bay yields a 45.6 × 42.8 m =
//     1950 m² envelope — LARGER than the entire 1611 m² drawing. Shipping that
//     would be worse than the hull it replaces.
//
// Guard: per axis, the interquartile spread of the line spacings must be ≤ 25%
// of their median. Regular bays pass trivially; scatter and mixed spacing do not.

import { furnitureContainment } from '../../metrics'
import type { Drawing, DrawEntity } from '../../../web/src/import/types'
import type { PlateExtractor, PlateResult } from './types'

type Pt = [number, number]

const MIN_COLUMNS = 4
/** A column is a small closed shape; anything bigger is a room, not a column. */
const COLUMN_MAX_SIDE = 1.5
const COLUMN_MIN_SIDE = 0.15
/** Column centres closer than this on an axis belong to the same grid line. */
const LINE_MERGE_M = 0.8
/** Guard: IQR of spacings must be within this fraction of the median. */
export const MAX_IQR_FRACTION_OF_MEDIAN = 0.25
const EDITOR_MARGIN = 1

function columnCentres(drawing: Drawing): Pt[] {
  const out: Pt[] = []
  for (const e of (drawing.entities ?? []) as DrawEntity[]) {
    const pts = (e.pts ?? []) as Pt[]
    if (pts.length < 3) continue
    // Columns are drawn as small closed polylines. Layer name is a hint, not a
    // requirement — real drawings put them on COL, S-COLS, STRUCT, …
    const looksStructural = /col|struct/i.test(e.layer ?? '')
    if (!e.closed && !looksStructural) continue
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const w = Math.max(...xs) - Math.min(...xs)
    const h = Math.max(...ys) - Math.min(...ys)
    if (w > COLUMN_MAX_SIDE || h > COLUMN_MAX_SIDE) continue
    if (w < COLUMN_MIN_SIDE || h < COLUMN_MIN_SIDE) continue
    if (!looksStructural) continue
    out.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2])
  }
  return out
}

/** Collapse near-equal coordinates into grid lines. */
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

export interface BayVerdict {
  ok: boolean
  bay: number
  median: number
  iqr: number
  reason: string
}

/** Is this axis a regular grid, and if so what is its bay? */
export function assessAxis(lines: number[]): BayVerdict {
  if (lines.length < 2) {
    return { ok: false, bay: 0, median: 0, iqr: 0, reason: 'fewer than 2 grid lines' }
  }
  const spacings = lines.slice(1).map((v, i) => v - lines[i]).sort((a, b) => a - b)
  const median = quantile(spacings, 0.5)
  const iqr = quantile(spacings, 0.75) - quantile(spacings, 0.25)
  if (median <= 0) return { ok: false, bay: 0, median, iqr, reason: 'degenerate spacing' }
  const frac = iqr / median
  return {
    ok: frac <= MAX_IQR_FRACTION_OF_MEDIAN,
    bay: median,
    median,
    iqr,
    reason: frac <= MAX_IQR_FRACTION_OF_MEDIAN
      ? ''
      : `spacings irregular: IQR ${iqr.toFixed(2)} m is ${Math.round(frac * 100)}% of the ${median.toFixed(2)} m median (max ${Math.round(MAX_IQR_FRACTION_OF_MEDIAN * 100)}%)`,
  }
}

export const columnGrid: PlateExtractor = {
  meta: {
    id: 'column-grid',
    summary:
      'Envelope from the structural column grid, extended half a median bay. Rejects unless BOTH axes pass an IQR ≤ 25%-of-median regularity guard.',
    portability: 'A-port',
    license: 'original',
  },
  extract(drawing: Drawing): PlateResult | null {
    const cols = columnCentres(drawing)
    if (cols.length < MIN_COLUMNS) return null

    const xLines = gridLines(cols.map((c) => c[0]))
    const yLines = gridLines(cols.map((c) => c[1]))
    const ax = assessAxis(xLines)
    const ay = assessAxis(yLines)
    // Both axes must be regular. A grid regular in x and scattered in y is not a
    // grid, and half-extending the scattered axis is how the real DWG produced a
    // 1950 m² envelope for a 1611 m² drawing.
    if (!ax.ok || !ay.ok) return null

    const x0 = Math.min(...xLines) - ax.bay / 2
    const x1 = Math.max(...xLines) + ax.bay / 2
    const y0 = Math.min(...yLines) - ay.bay / 2
    const y1 = Math.max(...yLines) + ay.bay / 2
    const ring: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

    // A column grid can only ever propose a rectangle, so if it orphans
    // furniture it is simply the wrong tool for this drawing — say so by
    // returning null rather than shipping a plate the gate will fail.
    if (furnitureContainment(ring, drawing) < 0.98) return null

    const offset = { x: x0 - EDITOR_MARGIN, y: y0 - EDITOR_MARGIN }
    return {
      boundary: ring.map(([x, y]) => [x - offset.x, y - offset.y] as Pt),
      offset,
      method: 'hull',
      coverage: 1,
      areaM2: (x1 - x0) * (y1 - y0),
    }
  },
}

export default columnGrid
