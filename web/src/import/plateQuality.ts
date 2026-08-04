// How much should we trust a traced plate?
//
// `extractPlate` always returns *something* — it falls through a ladder from a
// traced loop to a grid contour to a convex hull of furniture corners. The last
// rungs are guesses, and today they are indistinguishable from a real trace by
// the time they reach the UI: the app prints "881.5 m²" whether that number came
// from a closed building shell or from a hull fitted to disconnected fragments.
//
// The defect is the silence, not the boundary. This module measures the trace
// against the linework it came from and labels the result, so a low-confidence
// plate can be proposed for confirmation instead of asserted as fact.
//
// Thresholds here are calibrated against bench/fixtures, not chosen by feel —
// see docs/adr/0002-plate-provenance.md for the calibration table.

import type { Drawing } from './types'

export type Pt = [number, number]

/** How the boundary was derived, most trustworthy first. */
export type PlateMethod =
  /** A closed loop traced through actual wall linework. */
  | 'traced-loop'
  /** Occupancy-grid contour of the shell — infers enclosure, doesn't require it. */
  | 'grid-contour'
  /** Envelope of interior partitions (no shell found). */
  | 'partition-envelope'
  /** Envelope of the structural column grid (no shell found). */
  | 'column-grid'
  /** Convex hull of whatever geometry existed. A guess of last resort. */
  | 'hull'
  /** The user drew or confirmed it. Always trusted. */
  | 'user-traced'

export interface PlateProvenance {
  method: PlateMethod
  /**
   * Fraction of the boundary's LENGTH with no supporting wall/glazing linework
   * beneath it. The direct measure of a phantom edge: a hull cutting across open
   * space has nothing under it. 0.463 on the real furniture-plan.dwg.
   */
  phantomFraction: number
  /**
   * Length-weighted fraction of the boundary within 2° of a principal direction.
   * REPORTED, never gated on — a curved facade legitimately scores 0.28 while
   * being a perfectly good plate (see the calibration table).
   */
  orthogonality: number
  /**
   * Length of the implicit closing edge (last vertex → first), metres.
   * DIAGNOSTIC ONLY. Plate rings are implicitly closed, so this is an ordinary
   * edge length, not an error — a clean 30×20 rectangle reports 20.0 here.
   */
  closingEdgeM: number
  /** Boundary self-crossings. Any value > 0 is a hard fail. */
  selfIntersections: number
  /**
   * `high` → auto-accept, current behaviour.
   * `low`  → propose as an editable draft, with `reason` shown to the user.
   */
  confidence: 'high' | 'low'
  /** Plain-language why, for the confirm prompt. Empty when confidence is high. */
  reason: string
}

// ---- calibrated thresholds --------------------------------------------------
// Separation measured across the 14-fixture set: every plate at IoU ≥ 0.979 has
// phantomFraction ≤ 0.130, and every plate at IoU ≤ 0.884 has ≥ 0.359. 0.15 sits
// in that gap, nearer the accurate side on purpose — a false "low" costs one
// confirmation click, a false "high" silently propagates a wrong area into
// circulation, cost and the takeoff.
export const PHANTOM_MAX_FOR_HIGH = 0.15
/** Sampling step along the boundary when testing for supporting linework (m). */
const PHANTOM_STEP_M = 0.25
/** A boundary point this close to real linework counts as supported (m). */
const PHANTOM_TOL_M = 0.35

// ---- geometry ---------------------------------------------------------------

/** Wall/glazing segments — the linework a boundary is allowed to rest on. */
export function supportingSegments(drawing: Drawing): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = []
  for (const e of drawing.entities ?? []) {
    if (e.category !== 'wall' && e.category !== 'glazing') continue
    const pts = (e.pts ?? []) as Pt[]
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]])
    if (e.closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]])
  }
  return segs
}

function distToSegment(p: Pt, s: Pt, e: Pt): number {
  const dx = e[0] - s[0]
  const dy = e[1] - s[1]
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy))
}

/** Fraction of the ring's perimeter with no supporting linework within tolerance. */
export function phantomFraction(ring: Pt[], segs: Array<[Pt, Pt]>): number {
  if (ring.length < 2) return 1
  let total = 0
  let phantom = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    total += len
    const n = Math.max(1, Math.ceil(len / PHANTOM_STEP_M))
    let unsupported = 0
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      let ok = false
      for (const [s, e] of segs) {
        if (distToSegment(p, s, e) <= PHANTOM_TOL_M) { ok = true; break }
      }
      if (!ok) unsupported++
    }
    phantom += (unsupported / n) * len
  }
  return total > 0 ? phantom / total : 1
}

/** Length-weighted dominant edge direction, folded to [0,90). */
export function principalDirection(ring: Pt[]): number {
  const bins = new Map<number, number>()
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < 1e-9) continue
    let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
    a = ((a % 90) + 90) % 90
    const k = Math.round(a * 2) / 2
    bins.set(k, (bins.get(k) ?? 0) + len)
  }
  let best = 0
  let bestLen = -1
  for (const [k, v] of bins) if (v > bestLen) { bestLen = v; best = k }
  return best
}

/**
 * Length-weighted fraction of the boundary within `tolDeg` of a principal
 * direction. Length-weighted so a hundred 2 cm jags cannot outvote four 40 m
 * walls — the failure mode an edge-count version would hide.
 */
export function orthogonality(ring: Pt[], tolDeg = 2): number {
  if (ring.length < 2) return 0
  const base = principalDirection(ring)
  let total = 0
  let aligned = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < 1e-9) continue
    total += len
    let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI - base
    ang = ((ang % 90) + 90) % 90
    if (Math.min(ang, 90 - ang) <= tolDeg) aligned += len
  }
  return total > 0 ? aligned / total : 0
}

function onSeg(p: Pt, a: Pt, b: Pt, eps: number): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (Math.abs(cross) > eps) return false
  return (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]) <= eps
}

/** Boundary self-crossings, excluding the shared endpoints of adjacent edges. */
export function selfIntersections(ring: Pt[], eps = 1e-9): number {
  const n = ring.length
  if (n < 4) return 0
  const side = (p: Pt, q: Pt, r: Pt) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  let count = 0
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]
    const a2 = ring[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || (j + 1) % n === i) continue
      const b1 = ring[j]
      const b2 = ring[(j + 1) % n]
      const d1 = side(b1, b2, a1)
      const d2 = side(b1, b2, a2)
      const d3 = side(a1, a2, b1)
      const d4 = side(a1, a2, b2)
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
          ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) { count++; continue }
      if ((Math.abs(d1) <= eps && onSeg(a1, b1, b2, eps)) ||
          (Math.abs(d2) <= eps && onSeg(a2, b1, b2, eps)) ||
          (Math.abs(d3) <= eps && onSeg(b1, a1, a2, eps)) ||
          (Math.abs(d4) <= eps && onSeg(b2, a1, a2, eps))) count++
    }
  }
  return count
}

// ---- the verdict ------------------------------------------------------------

/**
 * Label a traced boundary. `ring` must be in SOURCE coordinates (undo the
 * editor offset first) so it lines up with the drawing's linework.
 *
 * Deliberately NOT gated on: orthogonality (a curved facade scores 0.28 and is
 * still correct) or the closing-edge length (rings are implicitly closed, so it
 * is an ordinary edge). Both are reported for diagnosis.
 */
export function assessPlate(
  ring: Pt[],
  drawing: Drawing | null,
  method: PlateMethod,
): PlateProvenance {
  const selfX = selfIntersections(ring)
  const first = ring[0]
  const last = ring[ring.length - 1]
  const closingEdgeM = first && last ? Math.hypot(first[0] - last[0], first[1] - last[1]) : 0

  // The user drew it; there is nothing to second-guess, and no drawing is needed
  // to say so. (A user-traced plate is the ANSWER to low confidence, not a
  // candidate for it.)
  if (method === 'user-traced') {
    return {
      method, phantomFraction: 0, orthogonality: orthogonality(ring),
      closingEdgeM, selfIntersections: selfX, confidence: 'high', reason: '',
    }
  }

  const segs = drawing ? supportingSegments(drawing) : []
  const phantom = drawing ? phantomFraction(ring, segs) : 1

  const reasons: string[] = []
  if (!drawing) reasons.push('the boundary could not be checked against the source linework')
  if (selfX > 0) reasons.push(`the boundary crosses itself ${selfX}×`)
  if (drawing && phantom >= PHANTOM_MAX_FOR_HIGH) {
    reasons.push(`${Math.round(phantom * 100)}% of this boundary has no wall beneath it`)
  }

  return {
    method,
    phantomFraction: phantom,
    orthogonality: orthogonality(ring),
    closingEdgeM: first && last ? Math.hypot(first[0] - last[0], first[1] - last[1]) : 0,
    selfIntersections: selfX,
    confidence: reasons.length === 0 ? 'high' : 'low',
    reason: reasons.length === 0 ? '' : `No closed building shell was found — ${reasons.join(', and ')}.`,
  }
}
