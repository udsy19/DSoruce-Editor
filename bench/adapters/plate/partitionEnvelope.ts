// `partition-envelope` — the same occupancy-grid contour the incumbent already
// uses, with a dilation schedule long enough to bridge the gaps that actually
// occur, and a containment-driven stopping rule instead of a coverage-driven one.
//
// Pre-registration (ADR 0003) established this is a TUNING candidate, not a new
// algorithm: `collectShellSegments` already feeds interior partitions into
// `gridContour`, because WIDE_SHELL_CATEGORIES includes `wall`. The incumbent's
// schedule tops out at GRID_DILATE*4 = 8 cells = 2.0 m of closing, against gaps
// of 3.2–3.6 m in the fixtures and a shell that is absent entirely on the real
// plan. That ceiling is why it falls through to a hull.
//
// So this reuses `gridContour` verbatim (no second rasterizer — that is how this
// codebase would grow a second document model) and changes only:
//   1. how far the dilation escalates, and
//   2. what "good enough" means at each step.
//
// Stopping rule: the FIRST dilation whose contour contains ≥ 98% of furniture
// and does not self-intersect wins. Dilation only ever grows the region, so
// stopping at the first success takes the tightest envelope that still holds the
// furniture — which is exactly the shrink-vs-orphan trade-off the bench gates
// score, approached from the safe side.

import { gridContour, collectWallSegments } from '../../../web/src/import/testfit'
import { furnitureContainment, selfIntersections } from '../../metrics'
import type { Drawing } from '../../../web/src/import/types'
import type { PlateExtractor, PlateResult } from './types'

type Pt = [number, number]

const CELL = 0.25
/** cells → metres of gap closed. 2..24 cells = 0.5 m .. 6.0 m. */
const DILATION_SCHEDULE = [2, 4, 6, 8, 12, 16, 20, 24]
const CONTAINMENT_TARGET = 0.98
const EDITOR_MARGIN = 1

function ringArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a / 2)
}

function finish(ring: Pt[], method: PlateResult['method']): PlateResult {
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  const offset = { x: minX - EDITOR_MARGIN, y: minY - EDITOR_MARGIN }
  return {
    boundary: ring.map(([x, y]) => [x - offset.x, y - offset.y] as Pt),
    offset,
    method,
    coverage: 1,
    areaM2: ringArea(ring),
  }
}

export const partitionEnvelope: PlateExtractor = {
  meta: {
    id: 'partition-envelope',
    summary:
      'gridContour with an escalating dilation schedule (0.5–6.0 m) stopped by furniture containment, not coverage. Reuses the incumbent rasterizer.',
    portability: 'A-port',
    license: 'original',
  },
  extract(drawing: Drawing): PlateResult | null {
    // Wall-category linework only. Partitions ARE walls, so this is the
    // partition set on a shell-less drawing and the shell+partition set
    // otherwise — deliberately not the widened door/casework/furniture set,
    // which is what pulls the incumbent's contour outward toward a hull.
    const segs = collectWallSegments(drawing)
    if (segs.length === 0) return null

    let fallback: Pt[] | null = null
    for (const dilate of DILATION_SCHEDULE) {
      const ring = gridContour(segs, CELL, dilate) as Pt[] | null
      if (!ring || ring.length < 3) continue
      if (selfIntersections(ring) > 0) continue
      // Remember the widest valid ring in case nothing reaches the target.
      fallback = ring
      if (furnitureContainment(ring, drawing) >= CONTAINMENT_TARGET) {
        return finish(ring, 'hull')
      }
    }
    // Nothing contained the furniture: return the most-dilated valid contour
    // rather than null, so the bench records WHY it fell short (the gate will
    // fail it) instead of silently reporting "no plate".
    return fallback ? finish(fallback, 'wrap') : null
  },
}

export default partitionEnvelope
