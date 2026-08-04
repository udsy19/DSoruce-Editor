// `partition-envelope-wrap` — `partition-envelope` with furniture bbox outlines
// added to the dilation input.
//
// Round 1 established the mechanism this exploits: `gridContour` is a
// morphological closing, so it cannot extend beyond the extent of its INPUT.
// Feeding it furniture as well as walls extends that input to cover the
// furniture field, which is the only reason the orphaned right-hand region of
// the real plan can ever be included — it holds furniture and no walls.
//
// The trade is stated in ADR 0003 and expected, not incidental: the boundary
// then rests on furniture bboxes rather than linework, so phantom fraction gets
// WORSE by construction. This rung buys containment with phantom, exactly as the
// incumbent's coverage hull does.
//
// No new machinery: same `gridContour`, same schedule, same stopping rule. The
// only difference is what goes in.

import { gridContour, collectWallSegments } from '../../../web/src/import/testfit'
import { furnitureContainment, selfIntersections } from '../../metrics'
import type { Drawing } from '../../../web/src/import/types'
import type { PlateExtractor, PlateResult } from './types'

type Pt = [number, number]
type Segment = [Pt, Pt]

const CELL = 0.25
const DILATION_SCHEDULE = [2, 4, 6, 8, 12, 16, 20, 24]
const CONTAINMENT_TARGET = 0.98
const EDITOR_MARGIN = 1

/** Furniture bbox outlines as segments — the added input. */
function furnitureBoxSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const f of drawing.furniture ?? []) {
    const [x0, y0, x1, y1] = f.bbox as [number, number, number, number]
    segs.push(
      [[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]],
      [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]],
    )
  }
  return segs
}

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

export const partitionEnvelopeWrap: PlateExtractor = {
  meta: {
    id: 'partition-envelope-wrap',
    summary:
      'partition-envelope with furniture bbox outlines added to the dilation input, so the closing can reach furniture that no wall encloses.',
    portability: 'A-port',
    license: 'original',
  },
  extract(drawing: Drawing): PlateResult | null {
    const segs = [
      ...(collectWallSegments(drawing) as Segment[]),
      ...furnitureBoxSegments(drawing),
    ]
    if (segs.length === 0) return null

    let fallback: Pt[] | null = null
    for (const dilate of DILATION_SCHEDULE) {
      const ring = gridContour(segs, CELL, dilate) as Pt[] | null
      if (!ring || ring.length < 3) continue
      if (selfIntersections(ring) > 0) continue
      fallback = ring
      if (furnitureContainment(ring, drawing) >= CONTAINMENT_TARGET) {
        return finish(ring, 'hull')
      }
    }
    return fallback ? finish(fallback, 'wrap') : null
  },
}

export default partitionEnvelopeWrap
