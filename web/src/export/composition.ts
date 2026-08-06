import type { DocState } from '../types/doc'
import type { Pt } from '../util/clip'
import { zoneBBox } from '../util/zoneGeom'
import { pointInPolygon } from '../three/materialTheme'

/**
 * SHARED COMPOSITION FIELD — "what is worth pointing a camera at, from here?"
 *
 * One plan-space model of the building's content, and ONE scorer over it, used
 * by both moving and standing cameras:
 *
 *   `export/walkthrough.ts`   per-frame look bias + the closing hero heading
 *   `three/interiorStill.ts`  which candidate eye/heading shoots each room still
 *
 * It lives here rather than in either consumer because it belongs to neither:
 * the walkthrough owns a route, the still renderer owns a camera search, and
 * both were answering the same question. Duplicating the answer is how the two
 * deliverables end up disagreeing about which wall is worth filming — the still
 * pack shipped a conference room bisected by a mullion while the video's own
 * bias machinery would have turned away from it.
 *
 * The model is deliberately 2D. A sight line at eye height is a plan-space
 * question: furniture is see-through at 1.6 m (you look OVER a 0.75 m desk),
 * partitions are not, and glazing is both an obstacle and the thing most worth
 * framing. Ceiling and floor are handled where they belong — by the camera's
 * height, pitch and FOV.
 */

// ── Cell taxonomy ────────────────────────────────────────────────────────────

/** What a cell holds. Free space and furniture are both see-through at eye
 *  height; only the last three stop a sight line. */
export const CELL_FREE = 0
/** Blank interior partition — the surface a camera must not stare at. */
export const CELL_WALL = 1
/** Glazed partition or the (spandrel + glazing) perimeter: worth looking at. */
export const CELL_GLASS = 2
/** The service core. Solid, but it carries the wayfinding display. */
export const CELL_CORE = 3
/** A furniture footprint: content. A sight line passes over it at 1.6 m. */
export const CELL_CONTENT = 4

/** Distance-to-nearest-obstacle field over the plan, in metres. */
export interface ClearanceGrid {
  cols: number
  rows: number
  cell: number
  ox: number
  oy: number
  /** Metres from each cell centre to the nearest blocked cell (0 when blocked). */
  dist: Float32Array
  /** `CELL_*` per cell — what the camera would be looking at there. */
  kind: Uint8Array
}

// ── 1. Building the field ────────────────────────────────────────────────────

/**
 * Rasterise the document's obstacles and distance-transform them.
 *
 * Blocked: wall runs at true thickness, every non-door component footprint
 * (rotated), the service core, and everything outside the floor plate. Door
 * components then RE-CARVE their own opening, because a door is a hole in a
 * wall, not an obstacle — without this no route reaches any room.
 */
export function buildClearanceGrid(state: DocState, plate: Pt[] | null, cell = 0.15): ClearanceGrid {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  for (const w of state.walls) {
    grow(w.a.x, w.a.y)
    grow(w.b.x, w.b.y)
  }
  if (!isFinite(minX)) throw new Error('composition: the document has no walls to stand inside')

  const pad = 1.0
  const ox = minX - pad
  const oy = minY - pad
  const cols = Math.max(4, Math.ceil((maxX - minX + 2 * pad) / cell))
  const rows = Math.max(4, Math.ceil((maxY - minY + 2 * pad) / cell))
  const blocked = new Uint8Array(cols * rows)
  const kind = new Uint8Array(cols * rows)
  const idx = (cx: number, cy: number) => cy * cols + cx

  const stampRect = (
    cx: number,
    cy: number,
    hw: number,
    hh: number,
    rot: number,
    value: 0 | 1,
    cellKind: number = CELL_WALL,
  ) => {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const r = Math.hypot(hw, hh)
    const gx0 = Math.max(0, Math.floor((cx - r - ox) / cell))
    const gx1 = Math.min(cols - 1, Math.ceil((cx + r - ox) / cell))
    const gy0 = Math.max(0, Math.floor((cy - r - oy) / cell))
    const gy1 = Math.min(rows - 1, Math.ceil((cy + r - oy) / cell))
    for (let gy = gy0; gy <= gy1; gy++) {
      const wy = oy + (gy + 0.5) * cell
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = ox + (gx + 0.5) * cell
        const dx = wx - cx
        const dy = wy - cy
        // Into the rect's own frame.
        const lx = dx * c + dy * s
        const ly = -dx * s + dy * c
        if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) {
          const i = idx(gx, gy)
          blocked[i] = value
          kind[i] = value ? cellKind : CELL_FREE
        }
      }
    }
  }

  // Walls, at true thickness. A run whose whole length sits on the plate edge is
  // the building envelope — which renders as a spandrel with a glazed band above
  // it, so it is daylight, not a blank surface. Glazed partitions read the same.
  for (const w of state.walls) {
    const dx = w.b.x - w.a.x
    const dy = w.b.y - w.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const onPlate =
      distToPlate(plate, w.a.x, w.a.y) < 0.5 && distToPlate(plate, w.b.x, w.b.y) < 0.5
    stampRect(
      (w.a.x + w.b.x) / 2,
      (w.a.y + w.b.y) / 2,
      len / 2,
      Math.max(cell * 0.6, w.thickness / 2),
      Math.atan2(dy, dx),
      1,
      w.glazing || onPlate ? CELL_GLASS : CELL_WALL,
    )
  }

  // Furniture. Doors are handled below; windows and ceiling elements are not
  // things a walker collides with at 1.6 m.
  const SKIP = new Set(['Door', 'Window', 'FallCeiling'])
  for (const c of state.components) {
    if (SKIP.has(c.category)) continue
    stampRect(c.x, c.y, c.w / 2, c.h / 2, -c.rotation, 1, CELL_CONTENT)
  }

  // The service core is solid all the way up.
  for (const z of state.zones ?? []) {
    if (z.zone_type !== 'Core') continue
    const b = zoneBBox(z.shape)
    stampRect((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, 0, 1, CELL_CORE)
  }

  // Outside the plate is not walkable. A sight line that reaches it has gone out
  // through the glazing, so it is looking at daylight.
  if (plate && plate.length >= 3) {
    for (let gy = 0; gy < rows; gy++) {
      const wy = oy + (gy + 0.5) * cell
      for (let gx = 0; gx < cols; gx++) {
        if (!pointInPolygon(plate, ox + (gx + 0.5) * cell, wy)) {
          const i = idx(gx, gy)
          if (!blocked[i]) kind[i] = CELL_GLASS
          blocked[i] = 1
        }
      }
    }
  }

  // A door is an OPENING. Re-carve it, generously enough that the doorway's own
  // centreline clears a camera's half-width, and deep enough to punch the wall
  // through.
  for (const d of state.components) {
    if (d.category !== 'Door') continue
    const halfW = Math.max(0.5, d.w / 2 + 0.06)
    stampRect(d.x, d.y, halfW, halfW, -d.rotation, 0)
  }

  return { cols, rows, cell, ox, oy, kind, dist: distanceTransform(blocked, cols, rows, cell) }
}

/** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in metres. */
function distanceTransform(blocked: Uint8Array, cols: number, rows: number, cell: number): Float32Array {
  const INF = 1e12
  const f = new Float64Array(Math.max(cols, rows))
  const d = new Float64Array(Math.max(cols, rows))
  const v = new Int32Array(Math.max(cols, rows))
  const z = new Float64Array(Math.max(cols, rows) + 1)
  const sq = new Float64Array(cols * rows)

  const edt1d = (n: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
    }
  }

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = blocked[y * cols + x] ? 0 : INF
    edt1d(rows)
    for (let y = 0; y < rows; y++) sq[y * cols + x] = d[y]
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = sq[y * cols + x]
    edt1d(cols)
    for (let x = 0; x < cols; x++) sq[y * cols + x] = d[x]
  }

  const out = new Float32Array(cols * rows)
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(sq[i]) * cell
  return out
}

/** Distance from a plan point to the floor plate's boundary; `Infinity` with no
 *  plate. Used to tell the building envelope from an interior partition. */
export function distToPlate(plate: Pt[] | null, x: number, y: number): number {
  if (!plate || plate.length < 3) return Infinity
  let best = Infinity
  for (let i = 0, j = plate.length - 1; i < plate.length; j = i++) {
    const [ax, ay] = plate[j]
    const [bx, by] = plate[i]
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2))
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)))
  }
  return best
}

/** Bilinear clearance (m) at a plan point; 0 outside the field. */
export function clearanceAt(g: ClearanceGrid, x: number, y: number): number {
  const fx = (x - g.ox) / g.cell - 0.5
  const fy = (y - g.oy) / g.cell - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= g.cols || y0 + 1 >= g.rows) return 0
  const tx = fx - x0
  const ty = fy - y0
  const a = g.dist[y0 * g.cols + x0]
  const b = g.dist[y0 * g.cols + x0 + 1]
  const c = g.dist[(y0 + 1) * g.cols + x0]
  const e = g.dist[(y0 + 1) * g.cols + x0 + 1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
}

// ── 2. The scorer ────────────────────────────────────────────────────────────

/** Angular resolution of the interest fan (deg). */
export const FAN_STEP_DEG = 1.5
/** How far an interest ray marches before it counts as "open" (m). */
const RAY_MAX_M = 22
/** Interest below which a sight line counts as a blank surface at arm's length —
 *  the "this pixel column is plasterboard" test both consumers report on. */
const BLANK_INTEREST = 0.1

/**
 * Score one sight line: how much is there to see along it?
 *
 * The ray marches the `kind` field. Furniture does NOT stop it — an eye at
 * 1.6 m looks over a 0.75 m desk — so a desk bank is accumulated as *content*
 * and the ray carries on to the surface behind it. Only a partition, the core,
 * the envelope or the edge of the plate ends the line.
 *
 * Three things make a direction worth pointing a camera at, and this is all
 * three: depth (a vanishing point rather than a wall at arm's length), content
 * crossed (desks, pods, tables), and what the line finally lands on (daylight
 * and glazed fronts are worth framing; blank plasterboard is not).
 */
export function rayInterest(g: ClearanceGrid, x: number, y: number, theta: number): number {
  const dx = Math.cos(theta)
  const dy = Math.sin(theta)
  const step = g.cell * 2
  let content = 0
  let hit = -1
  let d = step
  for (; d < RAY_MAX_M; d += step) {
    const gx = Math.floor((x + dx * d - g.ox) / g.cell)
    const gy = Math.floor((y + dy * d - g.oy) / g.cell)
    if (gx < 0 || gy < 0 || gx >= g.cols || gy >= g.rows) break
    const k = g.kind[gy * g.cols + gx]
    if (k === CELL_CONTENT) {
      content += step
      continue
    }
    if (k !== CELL_FREE) {
      hit = k
      break
    }
  }
  const depth = Math.min(d, 16) / 16
  const surf = hit < 0 ? 0.5 : hit === CELL_GLASS ? 0.9 : hit === CELL_CORE ? 0.35 : 0
  return 0.4 * depth + 0.35 * Math.min(1, content / 2.5) + 0.25 * surf
}

/**
 * The heading whose FRAME is worth standing still for: a full-circle scan of
 * `rayInterest`, scored as the sum over the frame the heading would deliver.
 *
 * `frameLook` below solves a different problem — a bounded, per-frame, soft
 * correction on top of a yaw the walk already has — and cannot be reused here:
 * it fans only ±(hfov/2 + maxBias) around a base yaw, and there is no base yaw
 * for a hero shot. This is the unbounded, once-per-shot authoring form, and it
 * shares the scoring function so the two never disagree about what is worth
 * looking at.
 *
 * `within` narrows the scan to a cone — the form a shot that must stay ON its
 * subject needs (the take has to open on the reception, so it may pick the best
 * heading that still frames it, not the best heading in the building).
 */
export function bestVista(
  g: ClearanceGrid,
  x: number,
  y: number,
  hfovRad: number,
  within?: { yaw: number; halfRangeRad: number },
): number {
  const step = (FAN_STEP_DEG * Math.PI) / 180
  const n = Math.max(8, Math.round((2 * Math.PI) / step))
  const v = new Float64Array(n)
  for (let j = 0; j < n; j++) v[j] = rayInterest(g, x, y, (j * 2 * Math.PI) / n)
  const half = Math.max(1, Math.round(hfovRad / 2 / ((2 * Math.PI) / n)))
  let best = 0
  let bs = -Infinity
  for (let c = 0; c < n; c++) {
    if (within) {
      let off = (c * 2 * Math.PI) / n - within.yaw
      while (off > Math.PI) off -= 2 * Math.PI
      while (off < -Math.PI) off += 2 * Math.PI
      if (Math.abs(off) > within.halfRangeRad) continue
    }
    let acc = 0
    for (let k = -half; k <= half; k++) acc += v[(c + k + n) % n]
    if (acc > bs) {
      bs = acc
      best = c
    }
  }
  return (best * 2 * Math.PI) / n
}

/** How the frame at a pose reads, and the yaw offset that would improve it. */
export interface FrameLook {
  /** Radians to add to the yaw so the open/occupied side fills the frame. */
  biasRad: number
  /** Fraction of the UNBIASED frame that is a near blank surface (0–1). */
  blankFraction: number
  /** Mean `rayInterest` across the UNBIASED frame (0–1) — how much there is to
   *  see in the picture this pose actually delivers. */
  interest: number
}

/**
 * The fix for a camera's one real composition defect: a blank partition filling
 * more than half the frame because the camera was aimed square at it.
 *
 * A fan of sight lines is scored across the frame plus the bias range either
 * side, then every admissible yaw offset is scored as the mean over the window
 * it would frame, minus a quadratic penalty on turning at all. The offset is a
 * SOFT argmax (a temperature-weighted mean, not a pick), so it varies
 * continuously along a walk — a hard pick would step and put a kink in the pan
 * that a yaw smoother could not absorb.
 *
 * With `maxBias = 0` it does no turning at all and simply MEASURES the frame,
 * which is how the still renderer scores a candidate camera. Same fan, same
 * scorer, one number the video and the stills both mean the same thing by.
 *
 * This is a framing change, not a dressing change: no geometry moves, no filter
 * is laid over the image. The camera simply stops staring at plasterboard.
 */
export function frameLook(
  g: ClearanceGrid,
  x: number,
  y: number,
  baseYaw: number,
  hfovRad: number,
  maxBias: number,
): FrameLook {
  const step = (FAN_STEP_DEG * Math.PI) / 180
  const half = Math.round(hfovRad / 2 / step)
  const bias = Math.round(maxBias / step)
  const n = 2 * (half + bias) + 1
  const v = new Float64Array(n)
  for (let j = 0; j < n; j++) v[j] = rayInterest(g, x, y, baseYaw + (j - half - bias) * step)

  const mean = (c: number) => {
    let acc = 0
    for (let k = c - half; k <= c + half; k++) acc += v[k]
    return acc / (2 * half + 1)
  }
  const centre = half + bias
  let blank = 0
  for (let k = centre - half; k <= centre + half; k++) if (v[k] < BLANK_INTEREST) blank++

  // Soft argmax over the offsets. TURN_PENALTY is what keeps the camera honest:
  // a small gain never buys a turn, and only a frame that is genuinely dominated
  // by a flat near surface moves it the whole way.
  const TURN_PENALTY = 0.1
  const TAU = 0.06
  let wSum = 0
  let acc = 0
  let bestScore = -Infinity
  const scores = new Float64Array(2 * bias + 1)
  for (let o = -bias; o <= bias; o++) {
    const s = mean(centre + o) - (bias > 0 ? TURN_PENALTY * (o / bias) * (o / bias) : 0)
    scores[o + bias] = s
    if (s > bestScore) bestScore = s
  }
  for (let o = -bias; o <= bias; o++) {
    const w = Math.exp((scores[o + bias] - bestScore) / TAU)
    wSum += w
    acc += w * o * step
  }
  return {
    biasRad: wSum > 0 ? acc / wSum : 0,
    blankFraction: blank / (2 * half + 1),
    interest: mean(centre),
  }
}
