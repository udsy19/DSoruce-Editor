// Metrics for the plate-extraction bake-off.
//
// Every metric here is computed from geometry alone — no implementation is ever
// consulted about its own quality. Each returns a raw number; the report shows
// raw numbers, never a single blended "score", because collapsing these into one
// figure hides exactly the trade-off the ADR has to record.

export type Pt = [number, number]

// ---- basic geometry ---------------------------------------------------------

export function signedArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % ring.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

export const area = (ring: Pt[]): number => Math.abs(signedArea(ring))

function onSegment(p: Pt, a: Pt, b: Pt, eps: number): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (Math.abs(cross) > eps) return false
  const dot = (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1])
  return dot <= eps
}

/** Proper segment intersection, excluding shared endpoints of adjacent edges. */
function segmentsCross(a1: Pt, a2: Pt, b1: Pt, b2: Pt, eps = 1e-9): boolean {
  const d = (p: Pt, q: Pt, r: Pt) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = d(b1, b2, a1)
  const d2 = d(b1, b2, a2)
  const d3 = d(a1, a2, b1)
  const d4 = d(a1, a2, b2)
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true
  // Collinear overlap counts as an intersection too (duplicated wall runs).
  if (Math.abs(d1) <= eps && onSegment(a1, b1, b2, eps)) return true
  if (Math.abs(d2) <= eps && onSegment(a2, b1, b2, eps)) return true
  if (Math.abs(d3) <= eps && onSegment(b1, a1, a2, eps)) return true
  if (Math.abs(d4) <= eps && onSegment(b2, a1, a2, eps)) return true
  return false
}

/**
 * THE headline correctness metric: a boundary that crosses itself is the bug in
 * the screenshot. Must be 0. Adjacent edges (sharing a vertex) are skipped;
 * everything else crossing is counted once per pair.
 */
export function selfIntersections(ring: Pt[]): number {
  const n = ring.length
  if (n < 4) return 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const a1 = ring[i]
    const a2 = ring[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue
      // skip adjacent (share a vertex) and the wrap-around pair
      if (j === (i + 1) % n || (j + 1) % n === i) continue
      if (segmentsCross(a1, a2, ring[j], ring[(j + 1) % n])) count++
    }
  }
  return count
}

/** Distance between first and last vertex — a closed ring must be ~0. */
export function closureError(ring: Pt[]): number {
  if (ring.length < 2) return Infinity
  const a = ring[0]
  const b = ring[ring.length - 1]
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * % of boundary LENGTH (not edge count) within `tolDeg` of a principal
 * direction. Length-weighted on purpose: a hundred 2 cm jagged edges must not
 * outvote four 40 m walls, which is exactly how the screenshot's artifact would
 * otherwise hide.
 */
export function orthogonality(ring: Pt[], tolDeg = 2, principalDeg?: number): number {
  const n = ring.length
  if (n < 2) return 0
  const base = principalDeg ?? principalDirection(ring)
  let total = 0
  let aligned = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % n]
    const len = Math.hypot(x2 - x1, y2 - y1)
    if (len < 1e-9) continue
    total += len
    let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI - base
    ang = ((ang % 90) + 90) % 90 // fold into [0,90)
    const off = Math.min(ang, 90 - ang)
    if (off <= tolDeg) aligned += len
  }
  return total > 0 ? aligned / total : 0
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
    const k = Math.round(a * 2) / 2 // 0.5° bins
    bins.set(k, (bins.get(k) ?? 0) + len)
  }
  let best = 0
  let bestLen = -1
  for (const [k, v] of bins) if (v > bestLen) { bestLen = v; best = k }
  return best
}

// ---- comparison against ground truth ---------------------------------------

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > p[1]) !== (yj > p[1]) &&
        p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Intersection-over-Union against the hand-verified truth polygon, by dense
 * rasterization. Deliberately NOT a polygon-clipping library: the whole point is
 * to score candidates that use clipping libraries, and scoring them with the
 * same library they use would launder their own errors into the score.
 * `cell` = 0.05 m gives ~1/400 m² resolution — far finer than any real defect.
 */
export function iou(a: Pt[], b: Pt[], cell = 0.05): number {
  if (!a.length || !b.length) return 0
  const xs = [...a, ...b].map((p) => p[0])
  const ys = [...a, ...b].map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  let inter = 0
  let union = 0
  for (let y = minY + cell / 2; y <= maxY; y += cell) {
    for (let x = minX + cell / 2; x <= maxX; x += cell) {
      const p: Pt = [x, y]
      const ina = pointInRing(p, a)
      const inb = pointInRing(p, b)
      if (ina && inb) inter++
      if (ina || inb) union++
    }
  }
  return union > 0 ? inter / union : 0
}

/** Symmetric Hausdorff-ish boundary deviation: worst vertex-to-edge distance. */
export function boundaryDeviation(a: Pt[], b: Pt[]): number {
  const distToRing = (p: Pt, ring: Pt[]): number => {
    let best = Infinity
    for (let i = 0; i < ring.length; i++) {
      const s = ring[i]
      const e = ring[(i + 1) % ring.length]
      const dx = e[0] - s[0]
      const dy = e[1] - s[1]
      const L2 = dx * dx + dy * dy
      let t = L2 > 0 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      best = Math.min(best, Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy)))
    }
    return best
  }
  let worst = 0
  for (const p of a) worst = Math.max(worst, distToRing(p, b))
  for (const p of b) worst = Math.max(worst, distToRing(p, a))
  return worst
}

// ---- containment gates ------------------------------------------------------
// Phantom fraction alone can be minimized by SHRINKING: an envelope that hugs
// interior partitions tightly scores a low phantom while orphaning real floor
// area. On synthetic fixtures IoU catches that; on the real plan, whose truth is
// undecided, nothing does. These two gates close it, and are registered before
// any candidate has produced a number.

/**
 * Fraction of furniture bbox centers inside the envelope. GATED at ≥ 0.98.
 *
 * The plate exists to generate a fit around the real furniture, so an envelope
 * that excludes desks is wrong however clean its boundary is. This restates as
 * an explicit gate what `extractPlate`'s coverage ladder held implicitly.
 */
export function furnitureContainment(ring: Pt[], drawing: { furniture?: Array<{ bbox: number[] }> }): number {
  const items = drawing.furniture ?? []
  if (items.length === 0) return 1
  let inside = 0
  for (const f of items) {
    const [x0, y0, x1, y1] = f.bbox as [number, number, number, number]
    if (pointInRing([(x0 + x1) / 2, (y0 + y1) / 2], ring)) inside++
  }
  return inside / items.length
}

/**
 * Fraction of wall-category linework LENGTH inside the envelope. DIAGNOSTIC
 * ONLY — never gated: keep-outs, service runs and off-plate linework legitimately
 * sit outside a correct plate, so a hard gate here would reject good envelopes.
 */
export function lineworkCoverage(ring: Pt[], segs: Array<[Pt, Pt]>): number {
  let total = 0
  let covered = 0
  for (const [a, b] of segs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    total += len
    // Sample the segment rather than testing endpoints, so a wall crossing the
    // boundary contributes only the part that is actually inside.
    const n = Math.max(1, Math.ceil(len / 0.5))
    let hit = 0
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      if (pointInRing([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ring)) hit++
    }
    covered += (hit / n) * len
  }
  return total > 0 ? covered / total : 1
}

/**
 * Phantom edges: boundary length with NO supporting source linework within
 * `tol`. This is the direct measure of the screenshot bug — the diagonals cut
 * across open space, so they have no wall under them. Reported as a LENGTH (m)
 * because one long phantom diagonal matters more than several short ones.
 *
 * Minimizable by shrinking — always read alongside `furnitureContainment`.
 */
export function phantomEdgeLength(ring: Pt[], segs: Array<[Pt, Pt]>, tol = 0.35): number {
  const STEP = 0.25 // m — sample the boundary this finely
  const near = (p: Pt): boolean => {
    for (const [s, e] of segs) {
      const dx = e[0] - s[0]
      const dy = e[1] - s[1]
      const L2 = dx * dx + dy * dy
      let t = L2 > 0 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      if (Math.hypot(p[0] - (s[0] + t * dx), p[1] - (s[1] + t * dy)) <= tol) return true
    }
    return false
  }
  let phantom = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 1e-9) continue
    const n = Math.max(1, Math.ceil(len / STEP))
    let unsupported = 0
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      if (!near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) unsupported++
    }
    phantom += (unsupported / n) * len
  }
  return phantom
}
