// Bridge between imported CAD drawings and the autonomous test-fit generator.
//
// `extractPlate` derives the building's outer floor-plate polygon from the
// wall linework of an imported `Drawing`; `pushPlateToEditor` feeds that
// polygon into the Rust `Editor` as walls so `generate`/`autoGenerate` and the
// circulation evaluator run *inside the imported plan*.
//
// The furniture IS the program — a floor plate that doesn't contain the
// drawing's furniture is wrong by definition. Every candidate boundary is
// scored by *furniture coverage* (fraction of furniture bbox centers inside),
// and the candidate ladder (see `PlateResult.method`) runs until one reaches
// `COVERAGE_ACCEPT` with a plausible area; otherwise the max-coverage
// candidate wins:
// - 'loop'  — snap wall-segment endpoints to a tolerance grid, build a planar
//             graph, trace its faces, keep the largest-area closed loop.
// - 'hull'  — rasterize the shell (walls, glazing, doors — door thresholds
//             close the gaps that leak the flood fill — casework, column-ish
//             closed polylines, plus shell-category block inserts) onto a
//             coarse occupancy grid, morphologically close remaining gaps,
//             flood the outside, and trace the outer contour of the solid
//             region (Moore neighbor tracing). Convex hull of shell endpoints
//             ∪ furniture corners is the last resort.
// - 'wrap'  — guaranteed-coverage fallback: rasterize shell ∪ every furniture
//             bbox outline and contour that — the plate necessarily wraps the
//             furniture field while hugging the real footprint far tighter
//             than a convex hull (which would swallow concave notches).
//
// Pure TS, dependency-free. Coordinates in meters throughout.

import type { Drawing, DrawEntity } from './types'
import type { EditorCanvas } from '../editor/EditorCanvas'

export type Pt = [number, number]
export type Segment = [Pt, Pt]

export interface PlateResult {
  /** Ordered closed boundary polygon of the floor plate, meters, translated so min corner ≈ (margin, margin). */
  boundary: Pt[]
  /** The translation applied: editorPoint = sourcePoint - offset. */
  offset: { x: number; y: number }
  /** Diagnostic: how the boundary was derived. */
  method: 'loop' | 'hull' | 'wrap'
  /** Fraction (0–1) of furniture bbox centers inside the boundary; 1 when the drawing has no furniture. */
  coverage: number
  /** Enclosed area of `boundary`, m². */
  areaM2: number
}

// ---- tunables ----------------------------------------------------------
const SNAP_TOL = 0.05 // m — endpoint snap grid for loop tracing (CAD wiggle)
const SIMPLIFY_LOOP = 0.25 // m — Douglas-Peucker tolerance for traced loops
const SIMPLIFY_CONTOUR = 0.3 // m — DP tolerance for the grid contour
const GRID_CELL = 0.25 // m — occupancy-grid resolution for the fallback
const GRID_DILATE = 2 // cells — closing radius (2 * 0.25 m bridges ~1 m door gaps)
const MIN_PLATE_AREA = 1 // m² — below this a "loop" is noise, not a plate
const EDITOR_MARGIN = 1 // m — where the plate's min corner lands in the editor
const DESPIKE_WEDGE_DEG = 25 // ° — wedge at a vertex below this is a spike candidate
const DESPIKE_AREA_FRAC = 0.005 // fraction of |ring area| a single removal may change
const SIMPLIFY_POST = 0.05 // m — light DP pass to collapse collinear runs left by despiking
const COVERAGE_ACCEPT = 0.85 // accept the first candidate covering this fraction of furniture
const COVERAGE_EDGE_TOL = 0.5 // m — a center this close to the boundary counts as inside
// (perimeter windows/doors sit ON the traced wall line — ±1 grid cell)
const COLUMN_MAX_SIDE = 2.5 // m — 'other' closed polylines up to this size rasterize as columns

// ---- public API --------------------------------------------------------

/** Derive the building's outer floor-plate polygon from a drawing's shell linework. */
export function extractPlate(drawing: Drawing): PlateResult | null {
  const wallSegs = collectWallSegments(drawing)
  const shellSegs = collectShellSegments(drawing)
  if (wallSegs.length === 0 && shellSegs.length === 0) return null

  const [bMinX, bMinY, bMaxX, bMaxY] = drawing.bounds
  const bboxArea = Math.max((bMaxX - bMinX) * (bMaxY - bMinY), 1)
  const plausible = Math.max(MIN_PLATE_AREA, bboxArea * 0.2)
  const centers = furnitureCenters(drawing)

  // Score a finalized candidate ring; the ladder accepts the first one that
  // clears the coverage + plausible-area bar, else the max-coverage candidate.
  type Scored = { ring: Pt[]; method: PlateResult['method']; coverage: number; area: number }
  let best: Scored | null = null
  const accept = (ring: Pt[] | null, method: PlateResult['method']): Scored | null => {
    if (!ring || ring.length < 3) return null
    const area = Math.abs(signedArea(ring))
    if (area < MIN_PLATE_AREA) return null
    const coverage = ringCoverage(ring, centers)
    const scored: Scored = { ring, method, coverage, area }
    if (!best || coverage > best.coverage || (coverage === best.coverage && area > best.area)) {
      best = scored
    }
    return coverage >= COVERAGE_ACCEPT && area >= plausible && area <= bboxArea * 1.05 ? scored : null
  }

  // (a) Largest closed loop in the snapped wall+glazing graph. Without a
  // coverage gate this happily returns an interior room when the perimeter
  // has gaps — the exact failure mode the ladder exists to catch.
  const loops = traceLoops(wallSegs, SNAP_TOL)
  let bigLoop: Pt[] | null = null
  let bigArea = 0
  for (const l of loops) {
    const a = Math.abs(signedArea(l))
    if (a > bigArea) {
      bigArea = a
      bigLoop = l
    }
  }
  if (bigLoop && bigArea >= plausible) {
    // Simplify → despike → light simplify (despiking leaves collinear runs).
    const ring = simplify(despike(simplify(orientCCW(bigLoop), SIMPLIFY_LOOP, true)), SIMPLIFY_POST, true)
    const ok = accept(ring, 'loop')
    if (ok) return finishPlate(ok)
  }

  // (b) Occupancy-grid outer contour of the widened shell set (doors close the
  // flood-fill leaks) with escalating gap-closing dilation.
  for (const dilate of [GRID_DILATE, GRID_DILATE * 2, GRID_DILATE * 4]) {
    const ok = accept(contourRing(shellSegs, dilate), 'hull')
    if (ok) return finishPlate(ok)
  }

  // (c) Guaranteed-coverage wrap: shell ∪ every furniture bbox outline. The
  // solid region then contains the furniture field by construction.
  if (centers.length > 0) {
    const wrapSegs = shellSegs.concat(furnitureBoxSegments(drawing))
    for (const dilate of [GRID_DILATE * 2, GRID_DILATE * 4]) {
      const ok = accept(contourRing(wrapSegs, dilate), 'wrap')
      if (ok) return finishPlate(ok)
    }
  }

  // (d) Last resort: convex hull of shell endpoints ∪ furniture corners.
  const hullPts: Pt[] = shellSegs.flat()
  for (const f of drawing.furniture) {
    const [x0, y0, x1, y1] = f.bbox
    hullPts.push([x0, y0], [x1, y0], [x1, y1], [x0, y1])
  }
  accept(convexHull(hullPts), 'hull')

  return best ? finishPlate(best) : null
}

/** Fraction (0–1) of the drawing's furniture bbox centers inside the plate boundary. */
export function plateCoverage(plate: PlateResult, drawing: Drawing): number {
  const centers = furnitureCenters(drawing).map(
    ([x, y]): Pt => [x - plate.offset.x, y - plate.offset.y],
  )
  return ringCoverage(plate.boundary, centers)
}

/** Grid contour of `segments` → despiked, lightly re-simplified ring (or null). */
function contourRing(segments: Segment[], dilate: number): Pt[] | null {
  const contour = gridContour(segments, GRID_CELL, dilate)
  if (!contour || contour.length < 3) return null
  // gridContour already ran DP; despike the needles the tracer squeezes
  // through wall gaps, then a light simplify for leftover collinear runs.
  const ring = simplify(despike(orientCCW(contour)), SIMPLIFY_POST, true)
  return ring.length >= 3 ? ring : null
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

/** Widened shell set for rasterization: door thresholds and casework runs
 *  close the gaps that a wall-only raster leaks the flood fill through. */
const WIDE_SHELL_CATEGORIES = new Set(['wall', 'glazing', 'door', 'casework'])

/** One entity's segments: polyline pt pairs (+closing pair) and tessellated arcs. */
function pushEntitySegments(e: DrawEntity, segs: Segment[]): void {
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

/** All wall/glazing segments — the clean linework the loop tracer runs on. */
export function collectWallSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const e of drawing.entities) {
    if (SHELL_CATEGORIES.has(e.category)) pushEntitySegments(e, segs)
  }
  return segs
}

/** The widened raster shell: wall/glazing/door/casework linework, column-ish
 *  `other` closed polylines, plus the bbox outlines of shell-category block
 *  inserts — on real plans most windows and doors are INSERTs living in
 *  `drawing.furniture`, not loose entities, and without them the perimeter
 *  raster is full of holes. */
function collectShellSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const e of drawing.entities) {
    if (WIDE_SHELL_CATEGORIES.has(e.category)) {
      pushEntitySegments(e, segs)
    } else if (e.category === 'other' && e.kind === 'polyline' && e.closed && e.pts && e.pts.length >= 3) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of e.pts) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      if (x1 - x0 <= COLUMN_MAX_SIDE && y1 - y0 <= COLUMN_MAX_SIDE) pushEntitySegments(e, segs)
    }
  }
  for (const f of drawing.furniture) {
    if (WIDE_SHELL_CATEGORIES.has(f.category) && f.category !== 'wall') {
      pushBoxSegments(f.bbox, segs)
    }
  }
  return segs
}

/** The four edges of an axis-aligned bbox as segments. */
function pushBoxSegments(bbox: [number, number, number, number], segs: Segment[]): void {
  const [x0, y0, x1, y1] = bbox
  segs.push(
    [
      [x0, y0],
      [x1, y0],
    ],
    [
      [x1, y0],
      [x1, y1],
    ],
    [
      [x1, y1],
      [x0, y1],
    ],
    [
      [x0, y1],
      [x0, y0],
    ],
  )
}

/** Every furniture bbox outline — the wrap fallback rasterizes these so the
 *  traced region contains the furniture field by construction. */
function furnitureBoxSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const f of drawing.furniture) pushBoxSegments(f.bbox, segs)
  return segs
}

// ---- furniture coverage --------------------------------------------------

/** Bbox centers of every placed block instance (all categories — they are all program). */
function furnitureCenters(drawing: Drawing): Pt[] {
  return drawing.furniture.map((f): Pt => [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2])
}

/** Fraction of `centers` inside (or within `COVERAGE_EDGE_TOL` of) `ring`.
 *  Vacuously 1 with no furniture, so furniture-free drawings keep the plain
 *  area-plausibility ladder. */
function ringCoverage(ring: Pt[], centers: Pt[]): number {
  if (centers.length === 0) return 1
  let inside = 0
  for (const [x, y] of centers) if (coveredByRing(x, y, ring)) inside++
  return inside / centers.length
}

/** Ray-cast point-in-polygon, with centers within `COVERAGE_EDGE_TOL` of an
 *  edge counting as covered — perimeter windows/doors sit ON the wall line the
 *  boundary traces through, so exact containment would flap on them. */
function coveredByRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  if (inside) return true
  const tol2 = COVERAGE_EDGE_TOL * COVERAGE_EDGE_TOL
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    const ex = x - (ax + t * dx)
    const ey = y - (ay + t * dy)
    if (ex * ex + ey * ey <= tol2) return true
  }
  return false
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

/**
 * Remove needle spikes from a closed ring (first vertex not repeated).
 *
 * A vertex is a spike candidate when the wedge between its two edges is below
 * `wedgeDeg` (the edges nearly double back — |turn| > 180° − wedgeDeg). It is
 * only removed when doing so changes the ring's |area| by at most `areaFrac`
 * of the total — that guard is what separates a contour-tracer needle from a
 * genuine narrow wing of the building. Iterates until a full pass removes
 * nothing; never drops below 3 vertices; preserves vertex order/orientation.
 */
export function despike(
  ring: Pt[],
  opts: { wedgeDeg?: number; areaFrac?: number } = {},
): Pt[] {
  const wedgeDeg = opts.wedgeDeg ?? DESPIKE_WEDGE_DEG
  const areaFrac = opts.areaFrac ?? DESPIKE_AREA_FRAC
  const cosMin = Math.cos((wedgeDeg * Math.PI) / 180) // wedge < wedgeDeg ⇔ cos(wedge) > cosMin
  const out = [...ring]
  const totalArea = Math.abs(signedArea(out))
  const maxAreaDelta = totalArea * areaFrac

  let removed = true
  while (removed && out.length > 3) {
    removed = false
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const p = out[(i - 1 + out.length) % out.length]
      const v = out[i]
      const n = out[(i + 1) % out.length]
      const ax = p[0] - v[0]
      const ay = p[1] - v[1]
      const bx = n[0] - v[0]
      const by = n[1] - v[1]
      const la = Math.hypot(ax, ay)
      const lb = Math.hypot(bx, by)
      // Degenerate (duplicate neighbor) counts as a zero-area spike.
      const isSpike = la < 1e-9 || lb < 1e-9 || (ax * bx + ay * by) / (la * lb) > cosMin
      if (!isSpike) continue
      // Removing v changes the area by the triangle (p, v, n).
      const triArea = Math.abs(ax * by - ay * bx) / 2
      if (triArea > maxAreaDelta) continue
      out.splice(i, 1)
      i--
      removed = true
    }
  }
  return out
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
function finishPlate(c: {
  ring: Pt[]
  method: PlateResult['method']
  coverage: number
  area: number
}): PlateResult {
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of c.ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  const offset = { x: minX - EDITOR_MARGIN, y: minY - EDITOR_MARGIN }
  return {
    boundary: c.ring.map(([x, y]) => [x - offset.x, y - offset.y]),
    offset,
    method: c.method,
    coverage: c.coverage,
    areaM2: c.area,
  }
}
