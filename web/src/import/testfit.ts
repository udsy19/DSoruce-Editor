// Bridge between imported CAD drawings and the autonomous test-fit generator.
//
// `extractPlate` derives the building's outer floor-plate polygon from the
// wall linework of an imported `Drawing`; `pushPlateToEditor` feeds that
// polygon into the Rust `Editor` as walls so `generate`/`autoGenerate` and the
// circulation evaluator run *inside the imported plan*.
//
// Two derivation strategies (see `PlateResult.method`):
// - 'loop'  — snap wall-segment endpoints to a tolerance grid, build a planar
//             graph, trace its faces, keep the largest-area closed loop.
// - 'hull'  — messy CAD (door gaps etc.) rarely closes a loop; rasterize the
//             walls onto a coarse occupancy grid, morphologically close the
//             gaps, flood the outside, and trace the outer contour of the
//             solid region (Moore neighbor tracing). Convex hull is the
//             last-resort if contour tracing degenerates.
//
// Pure TS, dependency-free. Coordinates in meters throughout.

import type { Drawing } from './types'
import type { EditorCanvas } from '../editor/EditorCanvas'

export type Pt = [number, number]
export type Segment = [Pt, Pt]

export interface PlateResult {
  /** Ordered closed boundary polygon of the floor plate, meters, translated so min corner ≈ (margin, margin). */
  boundary: Pt[]
  /** The translation applied: editorPoint = sourcePoint - offset. */
  offset: { x: number; y: number }
  /** Diagnostic: how the boundary was derived. */
  method: 'loop' | 'hull'
}

// ---- tunables ----------------------------------------------------------
const SNAP_TOL = 0.05 // m — endpoint snap grid for loop tracing (CAD wiggle)
const SIMPLIFY_LOOP = 0.25 // m — Douglas-Peucker tolerance for traced loops
const SIMPLIFY_CONTOUR = 0.3 // m — DP tolerance for the grid contour
const GRID_CELL = 0.25 // m — occupancy-grid resolution for the fallback
const GRID_DILATE = 2 // cells — closing radius (2 * 0.25 m bridges ~1 m door gaps)
const MIN_PLATE_AREA = 1 // m² — below this a "loop" is noise, not a plate
const EDITOR_MARGIN = 1 // m — where the plate's min corner lands in the editor

// ---- public API --------------------------------------------------------

/** Derive the building's outer floor-plate polygon from a drawing's walls. */
export function extractPlate(drawing: Drawing): PlateResult | null {
  const segments = collectWallSegments(drawing)
  if (segments.length === 0) return null

  // Primary: largest closed loop in the snapped wall graph. A loop only counts
  // as the plate if it covers a plausible share of the drawing extent —
  // otherwise it's an interior room (common when the perimeter has gaps) and
  // the grid-contour fallback reconstructs the real shell instead.
  const [bMinX, bMinY, bMaxX, bMaxY] = drawing.bounds
  const bboxArea = Math.max((bMaxX - bMinX) * (bMaxY - bMinY), 1)
  const plausible = Math.max(MIN_PLATE_AREA, bboxArea * 0.2)
  const loops = traceLoops(segments, SNAP_TOL)
  let best: Pt[] | null = null
  let bestArea = 0
  for (const ring of loops) {
    const a = Math.abs(signedArea(ring))
    if (a > bestArea) {
      bestArea = a
      best = ring
    }
  }
  if (best && bestArea >= plausible) {
    const ring = simplify(orientCCW(best), SIMPLIFY_LOOP, true)
    if (ring.length >= 3) return finishPlate(ring, 'loop')
  }

  // Fallback: occupancy-grid outer contour (survives door gaps / open ends).
  // Real perimeters can have entrance gaps well beyond one door width, so the
  // closing radius escalates until the enclosed region reaches a plausible
  // share of the drawing extent (each step doubles the bridgeable gap).
  for (const dilate of [GRID_DILATE, GRID_DILATE * 2, GRID_DILATE * 4]) {
    const contour = gridContour(segments, GRID_CELL, dilate)
    if (contour && contour.length >= 3 && Math.abs(signedArea(contour)) >= plausible) {
      return finishPlate(orientCCW(contour), 'hull')
    }
  }

  // Last resort: convex hull of every wall endpoint.
  const hull = convexHull(segments.flat())
  if (hull.length >= 3) return finishPlate(hull, 'hull')
  return null
}

/** Push a plate's boundary into the editor as walls (one per polygon edge). */
export function pushPlateToEditor(ec: EditorCanvas, plate: PlateResult, thickness = 0.15): void {
  const b = plate.boundary
  for (let i = 0; i < b.length; i++) {
    const [ax, ay] = b[i]
    const [bx, by] = b[(i + 1) % b.length]
    ec.ed.add_wall(ax, ay, bx, by, thickness)
  }
  ec.refresh()
}

// ---- wall-segment collection -------------------------------------------

/** Categories that form the building shell. Glazing is included because real
 *  plans routinely draw the perimeter as curtain wall — wall-only collection
 *  finds an interior room as the "largest loop" on such drawings. */
const SHELL_CATEGORIES = new Set(['wall', 'glazing'])

/** All shell-category segments: polyline pt pairs (+closing pair) and tessellated arcs. */
export function collectWallSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const e of drawing.entities) {
    if (!SHELL_CATEGORIES.has(e.category)) continue
    if (e.kind === 'polyline' && e.pts && e.pts.length >= 2) {
      for (let i = 0; i + 1 < e.pts.length; i++) segs.push([e.pts[i], e.pts[i + 1]])
      if (e.closed && e.pts.length >= 3) segs.push([e.pts[e.pts.length - 1], e.pts[0]])
    } else if ((e.kind === 'arc' || e.kind === 'circle') && e.cx != null && e.cy != null && e.r != null) {
      // Tessellate so curved walls participate in loop tracing / rasterizing.
      const a0 = e.kind === 'circle' ? 0 : (e.start ?? 0)
      let a1 = e.kind === 'circle' ? Math.PI * 2 : (e.end ?? Math.PI * 2)
      while (a1 <= a0) a1 += Math.PI * 2
      const sweep = a1 - a0
      const n = Math.max(8, Math.ceil((sweep * e.r) / 0.2))
      let prev: Pt = [e.cx + e.r * Math.cos(a0), e.cy + e.r * Math.sin(a0)]
      for (let i = 1; i <= n; i++) {
        const a = a0 + (sweep * i) / n
        const p: Pt = [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]
        segs.push([prev, p])
        prev = p
      }
    }
  }
  return segs
}

// ---- loop tracing (planar-graph face traversal) --------------------------

/**
 * Snap segment endpoints to a `tol` grid, build the wall graph, prune dangling
 * chains, then trace the faces of the planar subdivision. Returns every face
 * ring (first vertex not repeated). The floor plate is the largest-|area| one.
 */
export function traceLoops(segments: Segment[], tol = SNAP_TOL): Pt[][] {
  // Snap endpoints → node ids (first-seen coordinate represents the cell).
  const nodes: Pt[] = []
  const keyToId = new Map<string, number>()
  const idOf = (p: Pt): number => {
    const k = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`
    let id = keyToId.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push(p)
      keyToId.set(k, id)
    }
    return id
  }

  const adj: Set<number>[] = []
  const ensure = (id: number) => {
    while (adj.length <= id) adj.push(new Set())
  }
  for (const [a, b] of segments) {
    const u = idOf(a)
    const v = idOf(b)
    if (u === v) continue
    ensure(Math.max(u, v))
    adj[u].add(v)
    adj[v].add(u)
  }

  // Prune degree ≤ 1 nodes iteratively (dangling stubs break clean faces).
  const queue: number[] = []
  for (let i = 0; i < adj.length; i++) if (adj[i].size <= 1) queue.push(i)
  while (queue.length > 0) {
    const u = queue.pop()!
    if (adj[u].size > 1) continue
    for (const v of adj[u]) {
      adj[v].delete(u)
      if (adj[v].size <= 1) queue.push(v)
    }
    adj[u].clear()
  }

  // Angular order of neighbors per node (CCW), for face traversal.
  const sorted: number[][] = adj.map((nbrs, u) =>
    [...nbrs].sort(
      (p, q) =>
        Math.atan2(nodes[p][1] - nodes[u][1], nodes[p][0] - nodes[u][0]) -
        Math.atan2(nodes[q][1] - nodes[u][1], nodes[q][0] - nodes[u][0]),
    ),
  )

  // Trace each face once: from half-edge u→v, at v continue with the neighbor
  // clockwise-previous to the reverse edge v→u.
  const used = new Set<number>()
  const N = nodes.length
  const loops: Pt[][] = []
  for (let u0 = 0; u0 < adj.length; u0++) {
    for (const v0 of sorted[u0]) {
      if (used.has(u0 * N + v0)) continue
      const ring: Pt[] = []
      let u = u0
      let v = v0
      let guard = segments.length * 4 + 16
      while (!used.has(u * N + v) && guard-- > 0) {
        used.add(u * N + v)
        ring.push(nodes[u])
        const list = sorted[v]
        const i = list.indexOf(u)
        const w = list[(i - 1 + list.length) % list.length]
        u = v
        v = w
      }
      if (ring.length >= 3) loops.push(ring)
    }
  }
  return loops
}

// ---- occupancy-grid fallback ---------------------------------------------

/**
 * Rasterize wall segments onto a `cell`-meter grid, close gaps by dilating
 * `dilate` cells, flood-fill the outside, erode back, keep the largest solid
 * component and Moore-trace its outer contour. Returns a simplified polygon
 * or null when the region degenerates.
 */
export function gridContour(segments: Segment[], cell = GRID_CELL, dilate = GRID_DILATE): Pt[] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [a, b] of segments) {
    minX = Math.min(minX, a[0], b[0])
    minY = Math.min(minY, a[1], b[1])
    maxX = Math.max(maxX, a[0], b[0])
    maxY = Math.max(maxY, a[1], b[1])
  }
  if (!isFinite(minX)) return null
  const pad = (dilate + 2) * cell
  const ox = minX - pad
  const oy = minY - pad
  const W = Math.max(4, Math.ceil((maxX - minX + 2 * pad) / cell))
  const H = Math.max(4, Math.ceil((maxY - minY + 2 * pad) / cell))
  if (W * H > 4_000_000) return null // pathological extent — let hull handle it

  const idx = (x: number, y: number) => y * W + x
  const wall = new Uint8Array(W * H)
  for (const [a, b] of segments) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const gx = Math.floor((a[0] + (b[0] - a[0]) * t - ox) / cell)
      const gy = Math.floor((a[1] + (b[1] - a[1]) * t - oy) / cell)
      if (gx >= 0 && gx < W && gy >= 0 && gy < H) wall[idx(gx, gy)] = 1
    }
  }

  // Close: dilate walls by `dilate` cells (Chebyshev box).
  const dil = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!wall[idx(x, y)]) continue
      for (let dy = -dilate; dy <= dilate; dy++)
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) dil[idx(nx, ny)] = 1
        }
    }

  // Flood the outside across non-wall cells from the grid border.
  const outside = new Uint8Array(W * H)
  const stack: number[] = []
  const pushOut = (x: number, y: number) => {
    const i = idx(x, y)
    if (!outside[i] && !dil[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < W; x++) {
    pushOut(x, 0)
    pushOut(x, H - 1)
  }
  for (let y = 0; y < H; y++) {
    pushOut(0, y)
    pushOut(W - 1, y)
  }
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % W
    const y = (i - x) / W
    if (x > 0) pushOut(x - 1, y)
    if (x < W - 1) pushOut(x + 1, y)
    if (y > 0) pushOut(x, y - 1)
    if (y < H - 1) pushOut(x, y + 1)
  }

  // Solid = everything not reachable from outside; erode to undo the dilation.
  const er = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    outer: for (let x = 0; x < W; x++) {
      for (let dy = -dilate; dy <= dilate; dy++)
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || outside[idx(nx, ny)]) continue outer
        }
      er[idx(x, y)] = 1
    }

  // Largest 4-connected solid component.
  const comp = new Int32Array(W * H).fill(-1)
  let bestComp = -1
  let bestCount = 0
  let nComp = 0
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!er[i0] || comp[i0] !== -1) continue
    const id = nComp++
    let count = 0
    const st = [i0]
    comp[i0] = id
    while (st.length > 0) {
      const i = st.pop()!
      count++
      const x = i % W
      const y = (i - x) / W
      const nb = [i - 1, i + 1, i - W, i + W]
      const ok = [x > 0, x < W - 1, y > 0, y < H - 1]
      for (let k = 0; k < 4; k++) {
        if (ok[k] && er[nb[k]] && comp[nb[k]] === -1) {
          comp[nb[k]] = id
          st.push(nb[k])
        }
      }
    }
    if (count > bestCount) {
      bestCount = count
      bestComp = id
    }
  }
  if (bestComp < 0 || bestCount < 4) return null
  const solid = (x: number, y: number) =>
    x >= 0 && x < W && y >= 0 && y < H && comp[idx(x, y)] === bestComp

  // Moore neighbor tracing (clockwise) of the component's outer contour.
  let sx = -1
  let sy = -1
  outerScan: for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (solid(x, y)) {
        sx = x
        sy = y
        break outerScan
      }
  const dirs: Pt[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ]
  const dirIndex = (dx: number, dy: number) => dirs.findIndex((d) => d[0] === dx && d[1] === dy)
  const contourCells: Pt[] = [[sx, sy]]
  let cx = sx
  let cy = sy
  let bx = sx - 1 // backtrack starts west of start (non-solid by scan order)
  let by = sy
  let guard = 4 * W * H
  do {
    const from = dirIndex(bx - cx, by - cy)
    let advanced = false
    for (let k = 1; k <= 8; k++) {
      const d = dirs[(from + k) % 8]
      const nx = cx + d[0]
      const ny = cy + d[1]
      if (solid(nx, ny)) {
        const pd = dirs[(from + k - 1) % 8]
        bx = cx + pd[0]
        by = cy + pd[1]
        cx = nx
        cy = ny
        contourCells.push([cx, cy])
        advanced = true
        break
      }
    }
    if (!advanced) break // isolated cell
  } while ((cx !== sx || cy !== sy) && guard-- > 0)
  if (contourCells.length < 3) return null
  // Drop the repeated start cell if the trace closed on it.
  const last = contourCells[contourCells.length - 1]
  if (last[0] === sx && last[1] === sy) contourCells.pop()

  const poly: Pt[] = contourCells.map(([gx, gy]) => [ox + (gx + 0.5) * cell, oy + (gy + 0.5) * cell])
  const simplified = simplify(poly, SIMPLIFY_CONTOUR, true)
  return simplified.length >= 3 ? simplified : null
}

// ---- polygon utilities ----------------------------------------------------

/** Shoelace signed area (CCW positive). Ring: first vertex not repeated. */
export function signedArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function orientCCW(ring: Pt[]): Pt[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring
}

/** Douglas-Peucker simplification. `closed` treats pts as a ring. */
export function simplify(pts: Pt[], tol: number, closed = false): Pt[] {
  // Collapse consecutive duplicates first.
  const src: Pt[] = []
  for (const p of pts) {
    const q = src[src.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) src.push(p)
  }
  if (src.length <= 2) return src
  const chain = closed ? [...src, src[0]] : src
  const keep = new Uint8Array(chain.length)
  keep[0] = keep[chain.length - 1] = 1
  const stack: [number, number][] = [[0, chain.length - 1]]
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!
    if (i1 - i0 < 2) continue
    const [ax, ay] = chain[i0]
    const [bx, by] = chain[i1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1
    let maxI = -1
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = chain[i]
      let d: number
      if (len2 < 1e-12) {
        d = Math.hypot(px - ax, py - ay)
      } else {
        d = Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(len2)
      }
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > tol) {
      keep[maxI] = 1
      stack.push([i0, maxI], [maxI, i1])
    }
  }
  const out: Pt[] = []
  for (let i = 0; i < chain.length - (closed ? 1 : 0); i++) if (keep[i]) out.push(chain[i])
  return out
}

/** Andrew's monotone-chain convex hull (CCW, no repeated first vertex). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const dedup: Pt[] = []
  for (const p of pts) {
    const q = dedup[dedup.length - 1]
    if (!q || q[0] !== p[0] || q[1] !== p[1]) dedup.push(p)
  }
  if (dedup.length < 3) return dedup
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of dedup) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = dedup.length - 1; i >= 0; i--) {
    const p = dedup[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

// ---- finalization -----------------------------------------------------

/** Translate the ring so its min corner sits at (EDITOR_MARGIN, EDITOR_MARGIN). */
function finishPlate(ring: Pt[], method: PlateResult['method']): PlateResult {
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  const offset = { x: minX - EDITOR_MARGIN, y: minY - EDITOR_MARGIN }
  return {
    boundary: ring.map(([x, y]) => [x - offset.x, y - offset.y]),
    offset,
    method,
  }
}
