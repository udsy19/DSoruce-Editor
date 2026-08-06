import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import type { DocComponent, DocState } from '../types/doc'
import type { CirculationScore } from '../types/metrics'
import type { Pt } from '../util/clip'
import { pointInZoneShape, zoneArea, zoneBBox } from '../util/zoneGeom'
import {
  buildInteriorScene,
  createInteriorLighting,
  interiorEnvironment,
  interiorSkyTexture,
  type InteriorRoom,
  type InteriorScene,
} from '../three/materialTheme'
import { EYE_HEIGHT } from '../three/interiorStill'
import type { WallSpan } from './wallTypes'
// The composition field and its scorer live in `./composition` — the walkthrough
// and the room stills share one answer to "what is worth pointing a camera at",
// and neither owns it.
import {
  bestVista,
  buildClearanceGrid,
  clearanceAt,
  distToPlate,
  frameLook,
  type ClearanceGrid,
} from './composition'

/**
 * DELIVERABLE 3 — the branded walkthrough video.
 *
 * ONE continuous pedestrian take through the SAME `DocState` the quantity
 * workbook is built from, shot in the SAME material theme as the per-room
 * stills (`three/materialTheme.ts`) with the SAME renderer settings
 * (`three/interiorStill.ts` §render tier). The video is therefore filmed in the
 * building the workbook bills and the stills photograph — it cannot tell a
 * client a third story.
 *
 * What this module owns, and nothing else does:
 *
 *  1. **A route over the shared clearance field.** The field itself, and the
 *     "what is worth looking at from here?" scorer over it, live in
 *     `./composition` — the room stills compose with the same two, so the video
 *     and the still pack cannot disagree about which wall is worth filming.
 *     What this module adds is the ROUTE: Dijkstra between semantic stops
 *     (reception → corridor → open space → hero bay) over a cost that *prefers
 *     width*, so the path lands on the corridor centreline, not on doorframes.
 *     The result is simplified, splined (centripetal Catmull-Rom) and pushed
 *     back off obstacles — a spline through circulation-graph waypoints.
 *  2. **A camera that cannot enter geometry.** Two independent guarantees: the
 *     2D clearance field, and an exact world-AABB containment test in 3D. The
 *     AABB test is deliberate — a ray-parity "am I inside a solid?" count is
 *     UNSOUND here, because every material is `FrontSide`, so a ray crossing a
 *     closed box reports one hit and a ray fired from inside it reports none
 *     (`interiorStill.ts` records the same correction).
 *  3. **Branding.** The DSource mark from `export/qtoWorkbook.renderBrandMarkPng`
 *     — the repo's one brand mark — composited onto in-scene wall displays AND
 *     onto a 1.5 s title card that cross-dissolves into the take.
 *
 * ── Usage (app or headless; one code path) ────────────────────────────────
 *   const summary = await renderWalkthrough(state, {
 *     wallSpans, plate, circulation,
 *     onFrame: async (f) => encoder.write(f.canvas),
 *   })
 *
 * Frames come out one at a time so the caller can stream them to an encoder
 * without ever holding a whole video in memory. `scripts/render-walkthrough.mjs`
 * is the headless driver; it pipes them to ffmpeg.
 */

// ── Contract constants ───────────────────────────────────────────────────────

/** Gate G7 / `spec/video-spec.json` target. */
const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FPS = 30
/** G7 accepts 30–45 s. The reference take is 37 s. */
const DURATION_RANGE: [number, number] = [31, 43]
const DEFAULT_DURATION = 36
const DEFAULT_TITLE_S = 1.5
const DEFAULT_FADE_S = 0.5
/** Reference: "a slow forward dolly at roughly 0.6–1.0 m/s". */
const TARGET_SPEED_MPS = 0.95
/** Horizontal FOV. `video-spec.json` target.camera.hfov_deg. */
const DEFAULT_HFOV = 70

/** Camera half-width for the clearance field (m). A doorway is 0.9 m clear, so
 *  the walkable threshold has to sit below 0.45 m or no route enters any room. */
const MIN_CLEARANCE = 0.3
/** Clearance the route cost is happy with; below this it pays quadratically,
 *  which is what pulls the path onto the corridor centreline. */
const PREF_CLEARANCE = 1.15
/** Furthest the camera looks ahead on the path (m). It only ever looks this far
 *  when it can SEE that far — see `visibleLookAhead`. */
const LOOK_AHEAD_M = 7.5
/** Shortest look-ahead; below this the heading gets noisy. */
const LOOK_AHEAD_MIN_M = 1.4
/** Clearance a sight line needs to count as unobstructed (m). Below a doorway's
 *  own 0.45 m half-width, so a threshold does not read as a wall. */
const SIGHT_CLEAR_M = 0.32
/** How far the composition bias may yaw the camera off its travel/look direction
 *  (deg). A pedestrian looks around by this much without it reading as a pan;
 *  beyond it the walk starts to look like it is going sideways. */
const LOOK_BIAS_MAX_DEG = 30
/** Ceiling-luminaire grid (m) — `materialTheme`'s `DOWNLIGHT_SPACING`. Snapping
 *  the follow-light focus to THIS pitch is what makes a moving rig flicker-free:
 *  lamps only ever enter/leave at the reach boundary, where a decay-2 light of
 *  range 9.6 m contributes exactly zero. */
const LAMP_PITCH = 2.4
const LAMP_REACH_M = 11

// ── Public shapes ────────────────────────────────────────────────────────────

/** One authored waypoint on the route. */
export interface WalkStop {
  name: string
  /** Plan-space point the camera passes through. */
  at: Pt
  /** Plan-space point to look at while near this stop. */
  look?: Pt
  /** How strongly `look` overrides the look-ahead direction (0–1). */
  lookWeight?: number
  /** Speed multiplier at the stop (thresholds slow down). */
  slow?: number
  /** Metres of path over which `look` / `slow` blend in and out. */
  span?: number
}

/** The resolved route: its stops plus the rooms they were resolved against, so
 *  the branding rig hangs its screens in the rooms the camera actually visits.
 *  Re-resolving a room independently ("the largest meeting room") picks a
 *  DIFFERENT one on a plan with four identical ones, and the screen then hangs
 *  where nobody looks. */
export interface WalkRoute {
  stops: WalkStop[]
  reception: InteriorRoom | null
  open: InteriorRoom | null
}

export interface WalkPose {
  /** World position (plan X, eye height, plan Y). */
  pos: THREE.Vector3
  /** World look-at, always at eye height — pitch stays locked at 0. */
  look: THREE.Vector3
  /** Arc-length along the route (m). */
  s: number
  /** Clearance to the nearest obstacle at this pose (m). */
  clearance: number
}

export interface WalkthroughFrame {
  index: number
  total: number
  timeS: number
  /** The composited frame. Reused between frames — encode it before yielding. */
  canvas: HTMLCanvasElement
  /** Null while the flat title card is on screen. */
  pose: WalkPose | null
}

export interface WalkthroughOpts {
  width?: number
  height?: number
  fps?: number
  /** Total length INCLUDING the title card (s). Clamped into G7's window. */
  durationS?: number
  titleCardS?: number
  fadeS?: number
  hfovDeg?: number
  eyeHeightM?: number
  /** `classifyWalls(state, editor.wall_types())` — the core's classification. */
  wallSpans?: WallSpan[]
  /** `editor.plate_polygon()`. */
  plate?: Pt[] | null
  /** `Editor.circulation()`; degenerate with 0 walls, so pass null then. */
  circulation?: CirculationScore | null
  title?: string
  subtitle?: string
  /** Renderer settings — defaults match `interiorStill.ts` exactly. */
  exposure?: number
  environmentIntensity?: number
  postprocess?: boolean
  lampIntensity?: number
  ceilingLamps?: number
  /** Turn the in-scene wall displays off (they are on by default). */
  inSceneBranding?: boolean
  /** Called once per encoded frame, in order. */
  onFrame: (f: WalkthroughFrame) => void | Promise<void>
  onProgress?: (done: number, total: number, phase: string) => void
}

export interface WalkthroughSummary {
  width: number
  height: number
  fps: number
  frames: number
  durationS: number
  titleCardS: number
  hfovDeg: number
  eyeHeightM: number
  /** Route length walked (m) and the mean speed that implies. */
  pathLengthM: number
  meanSpeedMps: number
  stops: Array<{ name: string; at: Pt; sM: number }>
  /** Doorways / room thresholds the take passes through. */
  thresholdPasses: number
  /** Worst clearance any frame sat at (m) — the anti-clipping evidence. */
  minClearanceM: number
  /** Yaw rate (deg/s) at full frame rate: reference reads 4–6 deg/s in the
   *  straights, and a right-angle turn at walking pace unavoidably peaks. */
  maxYawRateDegS: number
  meanYawRateDegS: number
  /** Largest yaw the composition bias applied (deg), and the worst fraction of
   *  any frame that is near blank surface before and after it — the evidence
   *  that the camera stopped staring at partitions. */
  maxLookBiasDeg: number
  worstBlankBefore: number
  worstBlankAfter: number
  /** Frames whose eye had to be pushed out of a solid's AABB. Should be 0. */
  containmentFixes: number
  /** Where those frames were, so a non-zero count is diagnosable, not a mystery. */
  containmentAt: Pt[]
  /** In-scene branded displays placed, with the wall each hangs on. */
  displays: number
  displayAt: Pt[]
  /** The camera track, sampled every ~0.5 s — theevidence for the report. */
  track: Array<{ t: number; x: number; y: number; yawDeg: number; clearM: number }>
  /** Doorways opened (leaf hidden) so the take can pass through them. */
  doorsOpened: number
  softwareGL: boolean
}

export interface FreePointOpts {
  /** Reward width without a ceiling — for the open-floor stop, where the point
   *  of the shot is that the space IS open. Default caps the reward at
   *  `PREF_CLEARANCE`, which keeps corridor stops on the corridor. */
  preferOpen?: boolean
  /** Extra admissibility test (e.g. "must be inside this zone"). */
  accept?: (x: number, y: number) => boolean
}

/** Highest-clearance point within `radius` of a target, gently preferring the
 *  target itself. This is how every authored stop is snapped into free space
 *  instead of trusting a hand-guessed coordinate. */
export function bestFreePoint(
  g: ClearanceGrid,
  x: number,
  y: number,
  radius = 2.4,
  opts: FreePointOpts = {},
): Pt {
  let best: Pt = [x, y]
  let bestScore = -Infinity
  const r = Math.ceil(radius / g.cell)
  const cx = Math.round((x - g.ox) / g.cell - 0.5)
  const cy = Math.round((y - g.oy) / g.cell - 0.5)
  const pull = opts.preferOpen ? 0.1 : 0.22
  for (let gy = cy - r; gy <= cy + r; gy++) {
    if (gy < 0 || gy >= g.rows) continue
    for (let gx = cx - r; gx <= cx + r; gx++) {
      if (gx < 0 || gx >= g.cols) continue
      const px = g.ox + (gx + 0.5) * g.cell
      const py = g.oy + (gy + 0.5) * g.cell
      const dist = Math.hypot(px - x, py - y)
      if (dist > radius) continue
      const clear = g.dist[gy * g.cols + gx]
      if (clear < MIN_CLEARANCE) continue
      if (opts.accept && !opts.accept(px, py)) continue
      const score = (opts.preferOpen ? clear : Math.min(clear, PREF_CLEARANCE)) - dist * pull
      if (score > bestScore) {
        bestScore = score
        best = [px, py]
      }
    }
  }
  return best
}

// ── 2. Routing over the circulation graph ────────────────────────────────────

/** Per-cell traversal weight: 1 on a generous corridor, rising quadratically as
 *  the passage narrows. Keeps the route on the centreline. */
function cellCost(clear: number): number {
  if (clear < MIN_CLEARANCE) return Infinity
  const t = Math.max(0, (PREF_CLEARANCE - clear) / PREF_CLEARANCE)
  return 1 + 9 * t * t
}

/** 8-connected Dijkstra between two plan points. Returns the cell-centre
 *  polyline, or null when the two points are not connected through free space. */
export function routeBetween(g: ClearanceGrid, from: Pt, to: Pt): Pt[] | null {
  const n = g.cols * g.rows
  const cellOf = (p: Pt): number => {
    const cx = Math.min(g.cols - 1, Math.max(0, Math.round((p[0] - g.ox) / g.cell - 0.5)))
    const cy = Math.min(g.rows - 1, Math.max(0, Math.round((p[1] - g.oy) / g.cell - 0.5)))
    return cy * g.cols + cx
  }
  const start = cellOf(from)
  const goal = cellOf(to)
  if (g.dist[start] < MIN_CLEARANCE || g.dist[goal] < MIN_CLEARANCE) return null

  const cost = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  cost[start] = 0
  // Binary heap of (cost, cell).
  const heapC: number[] = [0]
  const heapI: number[] = [start]
  const push = (c: number, i: number) => {
    heapC.push(c)
    heapI.push(i)
    let k = heapC.length - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heapC[p] <= heapC[k]) break
      ;[heapC[p], heapC[k]] = [heapC[k], heapC[p]]
      ;[heapI[p], heapI[k]] = [heapI[k], heapI[p]]
      k = p
    }
  }
  const pop = (): number => {
    const top = heapI[0]
    const lc = heapC.pop()!
    const li = heapI.pop()!
    if (heapC.length) {
      heapC[0] = lc
      heapI[0] = li
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < heapC.length && heapC[l] < heapC[m]) m = l
        if (r < heapC.length && heapC[r] < heapC[m]) m = r
        if (m === k) break
        ;[heapC[m], heapC[k]] = [heapC[k], heapC[m]]
        ;[heapI[m], heapI[k]] = [heapI[k], heapI[m]]
        k = m
      }
    }
    return top
  }

  const done = new Uint8Array(n)
  const NB = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const

  while (heapI.length) {
    const cur = pop()
    if (done[cur]) continue
    done[cur] = 1
    if (cur === goal) break
    const cx = cur % g.cols
    const cy = (cur - cx) / g.cols
    for (const [dx, dy, w] of NB) {
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue
      const ni = ny * g.cols + nx
      if (done[ni]) continue
      const c = cellCost(g.dist[ni])
      if (!isFinite(c)) continue
      const nc = cost[cur] + w * g.cell * c
      if (nc < cost[ni]) {
        cost[ni] = nc
        prev[ni] = cur
        push(nc, ni)
      }
    }
  }
  if (!isFinite(cost[goal])) return null

  const out: Pt[] = []
  for (let i = goal; i !== -1; i = prev[i]) {
    const cx = i % g.cols
    const cy = (i - cx) / g.cols
    out.push([g.ox + (cx + 0.5) * g.cell, g.oy + (cy + 0.5) * g.cell])
    if (i === start) break
  }
  out.reverse()
  return out
}

/** Ramer–Douglas–Peucker. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice()
  let maxD = -1
  let maxI = 0
  const [ax, ay] = pts[0]
  const [bx, by] = pts[pts.length - 1]
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  for (let i = 1; i < pts.length - 1; i++) {
    const t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2
    const px = ax + dx * Math.max(0, Math.min(1, t))
    const py = ay + dy * Math.max(0, Math.min(1, t))
    const d = Math.hypot(pts[i][0] - px, pts[i][1] - py)
    if (d > maxD) {
      maxD = d
      maxI = i
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, maxI + 1), eps).slice(0, -1), ...simplify(pts.slice(maxI), eps)]
}

/** Push a point uphill on the clearance field until it is at least `want` clear.
 *  The gradient comes from the field itself, so the escape direction is the
 *  shortest way out of whatever it is standing in. */
function pushToClearance(g: ClearanceGrid, p: Pt, want: number, steps = 24): Pt {
  let [x, y] = p
  const h = g.cell
  for (let i = 0; i < steps; i++) {
    const c = clearanceAt(g, x, y)
    if (c >= want) break
    const gx = clearanceAt(g, x + h, y) - clearanceAt(g, x - h, y)
    const gy = clearanceAt(g, x, y + h) - clearanceAt(g, x, y - h)
    const m = Math.hypot(gx, gy)
    if (m < 1e-6) break
    x += (gx / m) * h * 0.8
    y += (gy / m) * h * 0.8
  }
  return [x, y]
}

/**
 * Slide every sample sideways onto the local clearance ridge, bounded.
 *
 * The router already prefers width, but a spline through its output can still
 * pass a partition at half arm's length — and a wall 0.6 m off the eye fills
 * most of a 70° frame however the camera is pointed. This walks the route down
 * the middle of whatever it is passing through instead, WITHOUT changing where
 * it goes: the shift is perpendicular to travel only, capped, smoothed along
 * the path so it cannot wobble, and tapered to zero at both ends so the
 * authored opening and hero poses stay exactly where they were placed.
 */
function centreLaterally(g: ClearanceGrid, path: Pt[], maxOffset = 0.8): Pt[] {
  const n = path.length
  if (n < 5) return path
  const off = new Float64Array(n)
  const steps = Math.max(1, Math.round(maxOffset / g.cell))
  for (let i = 1; i < n - 1; i++) {
    const tx = path[i + 1][0] - path[i - 1][0]
    const ty = path[i + 1][1] - path[i - 1][1]
    const m = Math.hypot(tx, ty) || 1
    const px = -ty / m
    const py = tx / m
    let best = 0
    let bestC = clearanceAt(g, path[i][0], path[i][1])
    for (let k = -steps; k <= steps; k++) {
      if (k === 0) continue
      const t = k * g.cell
      const c = clearanceAt(g, path[i][0] + px * t, path[i][1] + py * t)
      // Strictly better, and cheaper the less it moves: this centres a corridor
      // pass without dragging the route off a doorway it has to thread.
      if (c - Math.abs(t) * 0.12 > bestC) {
        bestC = c - Math.abs(t) * 0.12
        best = t
      }
    }
    off[i] = best
  }
  // Smooth over ~1 m of path, then taper the ends.
  const win = Math.max(1, Math.round(0.5 / Math.max(1e-3, arcLengths(path)[n - 1] / n)))
  const sm = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    let cnt = 0
    for (let k = -win; k <= win; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k))
      acc += off[j]
      cnt++
    }
    sm[i] = acc / cnt
  }
  const cum = arcLengths(path)
  const total = cum[n - 1]
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const taper = Math.min(1, cum[i] / 1.5, (total - cum[i]) / 1.5)
    const tx = path[Math.min(n - 1, i + 1)][0] - path[Math.max(0, i - 1)][0]
    const ty = path[Math.min(n - 1, i + 1)][1] - path[Math.max(0, i - 1)][1]
    const m = Math.hypot(tx, ty) || 1
    const t = sm[i] * Math.max(0, taper)
    const cand: Pt = [path[i][0] + (-ty / m) * t, path[i][1] + (tx / m) * t]
    out.push(clearanceAt(g, cand[0], cand[1]) >= clearanceAt(g, path[i][0], path[i][1]) ? cand : path[i])
  }
  return out
}

/**
 * Route through every stop, simplify, spline, and re-seat the spline in free
 * space. Splining is what turns a staircase of grid cells into a camera move;
 * re-seating is what stops a Catmull-Rom's overshoot on a tight corner from
 * bulging into a partition.
 */
export function splineThroughStops(g: ClearanceGrid, stops: WalkStop[]): { path: Pt[]; stopS: number[] } {
  const legs: Pt[] = []
  for (let i = 0; i + 1 < stops.length; i++) {
    const leg = routeBetween(g, stops[i].at, stops[i + 1].at)
    if (!leg) throw new Error(`walkthrough: no walkable route from "${stops[i].name}" to "${stops[i + 1].name}"`)
    legs.push(...(i === 0 ? leg : leg.slice(1)))
  }
  const control = simplify(legs, 0.16)

  const curve = new THREE.CatmullRomCurve3(
    control.map(([x, y]) => new THREE.Vector3(x, 0, y)),
    false,
    'centripetal',
    0.5,
  )
  const samples = Math.max(64, Math.ceil(curve.getLength() / 0.05))
  let path: Pt[] = curve.getSpacedPoints(samples).map((v) => [v.x, v.z] as Pt)

  // Re-seat, then lightly relax. The relaxation is clearance-guarded, so it can
  // only ever round a corner the plan actually has room for.
  path = path.map((p) => pushToClearance(g, p, MIN_CLEARANCE + 0.06))
  for (let it = 0; it < 12; it++) {
    for (let i = 1; i < path.length - 1; i++) {
      const nx = (path[i - 1][0] + path[i + 1][0]) / 2
      const ny = (path[i - 1][1] + path[i + 1][1]) / 2
      const mx = path[i][0] + (nx - path[i][0]) * 0.35
      const my = path[i][1] + (ny - path[i][1]) * 0.35
      if (clearanceAt(g, mx, my) >= Math.min(clearanceAt(g, path[i][0], path[i][1]), MIN_CLEARANCE + 0.1)) {
        path[i] = [mx, my]
      }
    }
  }

  path = centreLaterally(g, path)

  // Where each stop ended up along the finished path — the anchor for its look
  // target and its threshold slowdown.
  const cum = arcLengths(path)
  const stopS = stops.map((st) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < path.length; i++) {
      const d = Math.hypot(path[i][0] - st.at[0], path[i][1] - st.at[1])
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return cum[bi]
  })
  // Monotonic: a stop can never sit before its predecessor.
  for (let i = 1; i < stopS.length; i++) stopS[i] = Math.max(stopS[i], stopS[i - 1] + 0.2)
  return { path, stopS }
}

function arcLengths(path: Pt[]): Float64Array {
  const cum = new Float64Array(path.length)
  for (let i = 1; i < path.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
  }
  return cum
}

function sampleAt(path: Pt[], cum: Float64Array, s: number): Pt {
  const total = cum[cum.length - 1]
  if (s <= 0) return path[0]
  if (s >= total) return path[path.length - 1]
  let lo = 0
  let hi = cum.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= s) lo = mid
    else hi = mid
  }
  const seg = cum[hi] - cum[lo] || 1
  const t = (s - cum[lo]) / seg
  return [path[lo][0] + (path[hi][0] - path[lo][0]) * t, path[lo][1] + (path[hi][1] - path[lo][1]) * t]
}

// ── 3. The authored route ────────────────────────────────────────────────────

/**
 * Doors that belong to a room: a door centre sitting ON one of its edges, within
 * that edge's own span. The looser "inside the padded bbox" test is wrong on a
 * plan whose rooms are 0.1 m apart — it hands Meeting Room 4 the door of Meeting
 * Room 3, and the route then walks into the wrong room.
 */
function roomDoors(state: DocState, room: InteriorRoom): DocComponent[] {
  const b = room.bbox
  const t = 0.45
  return state.components.filter((c) => {
    if (c.category !== 'Door') return false
    const onX = c.x >= b.minX - t && c.x <= b.maxX + t
    const onY = c.y >= b.minY - t && c.y <= b.maxY + t
    if (!onX || !onY) return false
    const edgeY = Math.min(Math.abs(c.y - b.minY), Math.abs(c.y - b.maxY)) <= t && c.x >= b.minX && c.x <= b.maxX
    const edgeX = Math.min(Math.abs(c.x - b.minX), Math.abs(c.x - b.maxX)) <= t && c.y >= b.minY && c.y <= b.maxY
    return edgeX || edgeY
  })
}

/** Step `back` metres from a door, away from (negative) or into (positive) the room. */
function offDoor(room: InteriorRoom, door: DocComponent, back: number): Pt {
  const vx = room.center.x - door.x
  const vy = room.center.y - door.y
  const len = Math.hypot(vx, vy) || 1
  return [door.x + (vx / len) * back, door.y + (vy / len) * back]
}

/**
 * The wall a camera entering at `from` ends up facing — the room's own identity
 * surface, and where its branded display hangs.
 *
 * INTERIOR walls win over the building perimeter even when the perimeter is
 * further away. The perimeter renders as a spandrel with glazing above it, so a
 * screen mounted there floats in a window, and the hero shot would be aimed at
 * a blown-out exterior instead of at the room.
 */
function facingWall(
  room: InteriorRoom,
  from: Pt,
  plate: Pt[] | null,
): { at: Pt; nx: number; ny: number } {
  const b = room.bbox
  const cands: Array<{ at: Pt; nx: number; ny: number }> = [
    { at: [(b.minX + b.maxX) / 2, b.minY], nx: 0, ny: 1 },
    { at: [(b.minX + b.maxX) / 2, b.maxY], nx: 0, ny: -1 },
    { at: [b.minX, (b.minY + b.maxY) / 2], nx: 1, ny: 0 },
    { at: [b.maxX, (b.minY + b.maxY) / 2], nx: -1, ny: 0 },
  ]
  let best = cands[0]
  let bs = -Infinity
  for (const c of cands) {
    const d = Math.hypot(c.at[0] - from[0], c.at[1] - from[1])
    const interior = distToPlate(plate, c.at[0], c.at[1]) > 0.8 ? 1 : 0
    const score = d + interior * 4
    if (score > bs) {
      bs = score
      best = c
    }
  }
  return best
}

function byAreaDesc(rooms: InteriorRoom[]): InteriorRoom[] {
  return rooms.slice().sort((a, b) => zoneArea(b.zone.shape) - zoneArea(a.zone.shape))
}

/**
 * The route, resolved against whatever the document actually contains:
 * **outside reception → past its front → the main corridor → out into the open
 * floor → a run through the desk field → a hero wide in the deepest open-plan
 * bay, facing the perimeter glazing.**
 *
 * Every stop is snapped to the best free point near its ideal position, and the
 * connections between them are left to the router — so the route survives a
 * plan whose support rooms leave only a 0.9 m slot between the corridor and the
 * desks. Missing space types are skipped, never faked.
 *
 * Two deliberate departures, both forced by measured geometry:
 *
 * 1. The camera does **not** drive inside the reception. On a real test-fit the
 *    reception is a 4 × 3 m glazed box with a table in it — measured free
 *    clearance there is 0.3–0.6 m, so an eye at 1.6 m inside it films the
 *    underside of a wall. It is glass fronted, so the take opens on it from the
 *    circulation side.
 * 2. The take does **not** end inside a meeting room. It used to, and that shot
 *    was the weakest frame in the film: from inside a 5 × 4 m white box at
 *    1.6 m with a 70° frame, three wall planes and the ceiling fill it whatever
 *    the camera does — measured 0.815 mean luminance and 68 % of the frame flat
 *    for the closing ten seconds. The reference closes exactly where this now
 *    does — its last sampled frame is *"final open-plan bay, facing the opposite
 *    window wall"* (`video-spec.json`) — because the open floor is the only
 *    space on a test-fit plate deep enough to carry a wide: desk banks receding
 *    to full-height glazing, with content the whole way to the vanishing point.
 */
export function planWalkRoute(
  scene: InteriorScene,
  state: DocState,
  g: ClearanceGrid,
  hfovDeg = DEFAULT_HFOV,
): WalkRoute {
  const rooms = scene.rooms
  const pick = (...keys: InteriorRoom['finishKey'][]) => {
    for (const k of keys) {
      const hit = byAreaDesc(rooms.filter((r) => r.finishKey === k))[0]
      if (hit) return hit
    }
    return null
  }
  const reception = pick('reception', 'collab')
  const open = pick('workspace', 'collab')
  const snap = (p: Pt, r = 1.6): Pt => bestFreePoint(g, p[0], p[1], r)

  // ── The circulation spine: the axis every stop is laid out along.
  const circulation = (state.zones ?? [])
    .filter((z) => z.zone_type === 'Circulation')
    .sort((a, b) => zoneArea(b.shape) - zoneArea(a.shape))[0]
  const cb = circulation ? zoneBBox(circulation.shape) : null
  const horiz = cb ? cb.maxX - cb.minX >= cb.maxY - cb.minY : true
  /** Pull a point onto the spine's centre line. */
  const onSpine = (p: Pt): Pt =>
    !cb ? p : horiz ? [p[0], (cb.minY + cb.maxY) / 2] : [(cb.minX + cb.maxX) / 2, p[1]]
  const axis: Pt = horiz ? [1, 0] : [0, 1]
  const along = (p: Pt) => (horiz ? p[0] : p[1])

  const start0: Pt = reception ? [reception.center.x, reception.center.y] : onSpine([cb?.minX ?? 0, cb?.minY ?? 0])

  // ── The hero bay: the deepest, furthest corner of the open floor. Everything
  //    else on the route is laid out along the spine BETWEEN the reception and
  //    the point on the spine below it, so resolving it first is what makes the
  //    whole take aim at one shot instead of arriving at one.
  const perp: Pt = horiz ? [0, 1] : [1, 0]
  const spineAt: Pt = onSpine(start0)
  const inOpen = open ? (x: number, y: number) => pointInZoneShape(open.zone.shape, x, y) : () => true
  let heroAt: Pt
  if (open) {
    const ob = zoneBBox(open.zone.shape)
    const lo: Pt = [ob.minX, ob.minY]
    const hi: Pt = [ob.maxX, ob.maxY]
    // The far end ALONG the spine (whichever end is further from the reception),
    // held a fifth of the floor's length off the end wall so the shot looks
    // down the length of the plan rather than into its end.
    const farAlong =
      Math.abs(along(hi) - along(start0)) >= Math.abs(along(lo) - along(start0)) ? along(hi) : along(lo)
    const alongPos = farAlong + Math.sign(along(start0) - farAlong) * Math.abs(along(hi) - along(lo)) * 0.22
    // ...and deep enough OFF the spine to be inside the desk field rather than
    // on its edge; the perpendicular half-depth of the floor, capped.
    const side =
      Math.sign((open.center.x - start0[0]) * perp[0] + (open.center.y - start0[1]) * perp[1]) || 1
    const depth = Math.min(9, Math.abs((horiz ? hi[1] - lo[1] : hi[0] - lo[0])) * 0.45)
    const seed: Pt = horiz
      ? [alongPos, spineAt[1] + side * depth]
      : [spineAt[0] + side * depth, alongPos]
    heroAt = bestFreePoint(g, seed[0], seed[1], 3.5, { preferOpen: true, accept: inOpen })
  } else {
    heroAt = snap([cb?.maxX ?? 0, cb?.maxY ?? 0], 2.2)
  }
  /** The spine point below the hero — the far end of the axis every other stop
   *  is interpolated along. */
  const finish: Pt = onSpine(heroAt)

  const stops: WalkStop[] = []

  // ── 0. Outside the reception, on the circulation side, looking at its front.
  let head: Pt
  if (reception) {
    const rd = roomDoors(state, reception)[0]
    const base = onSpine(rd ? offDoor(reception, rd, -1.1) : [reception.center.x, reception.bbox.maxY + 1.2])
    const dir = along(finish) >= along(base) ? -1 : 1
    head = snap([base[0] + axis[0] * dir * 2.6, base[1] + axis[1] * dir * 2.6], 1.0)
    // The opening beat is chosen the same way the closing one is: `bestVista`
    // over the shared scorer, but inside a cone around the reception so the take
    // still OPENS on the reception rather than on whatever is richest in the
    // building. Aiming dead at the room's centroid — which is what this did —
    // pointed a 70 deg frame at a 4 x 3 m glazed box from 2.7 m, and the right
    // third of it was the blank flank of the room next door: t = 2.2 s measured
    // 77.5 % blank at eye level, the worst frame in the film once the tail was
    // fixed. The cone is wide enough (±55 deg) to trade that flank for the
    // corridor's depth and narrow enough that the reception stays the subject.
    const inward = Math.atan2(reception.center.y - head[1], reception.center.x - head[0])
    const openYaw = bestVista(g, head[0], head[1], (hfovDeg * Math.PI) / 180, {
      yaw: inward,
      halfRangeRad: (55 * Math.PI) / 180,
    })
    stops.push({
      name: 'outside-reception',
      at: head,
      look: [head[0] + Math.cos(openYaw) * 12, head[1] + Math.sin(openYaw) * 12],
      // Was 0.9, which left the per-frame composition bias a tenth of the yaw —
      // i.e. authored the opening and then forbade the machinery that fixed the
      // rest of the film from touching it. Half the yaw is authored; the bias
      // trims the other half.
      lookWeight: 0.55,
      span: 5.0,
    })
  } else {
    head = snap(onSpine([cb?.minX ?? 0, cb?.minY ?? 0]), 1.6)
    stops.push({ name: 'spine-head', at: head, span: 4 })
  }
  const travel = along(finish) >= along(head) ? 1 : -1

  // ── 1. The main corridor.
  const lerpSpine = (t: number): Pt =>
    onSpine([head[0] + (finish[0] - head[0]) * t, head[1] + (finish[1] - head[1]) * t])
  // Held looking DOWN the spine, not on pure look-ahead: without it the camera
  // starts swinging toward the open floor while it is still between two
  // partitions, and spends two seconds filming the side of a support room.
  stops.push({
    name: 'corridor',
    at: snap(lerpSpine(0.34), 1.2),
    look: lerpSpine(0.8),
    lookWeight: 0.7,
    span: 5,
  })

  // ── 2. Out of the corridor and into the open floor. The seed is a lateral
  //      step off the spine; the widest point near it wins, which is how the
  //      camera lands in a real aisle instead of a 0.6 m slot between two
  //      support rooms.
  if (open) {
    const side = Math.sign(
      (open.center.x - head[0]) * perp[0] + (open.center.y - head[1]) * perp[1],
    ) || 1
    /** Step off the spine and take the widest point near the landing. Seeding a
     *  lateral offset and letting width decide is what lands the camera in a
     *  real desk aisle rather than in a 0.6 m slot between two support rooms. */
    const dip = (t: number, depth: number, radius: number): Pt => {
      const seed = lerpSpine(t)
      return bestFreePoint(g, seed[0] + perp[0] * side * depth, seed[1] + perp[1] * side * depth, radius, {
        preferOpen: true,
        accept: inOpen,
      })
    }
    // TWO stops, not one: with a single stop the router dips a metre off the
    // corridor and comes straight back, and the open floor is only ever seen
    // side-on down a corridor. With two, the leg BETWEEN them is a run through
    // the desk field, which is the shot the deliverable is actually for.
    const a = dip(0.44, 6.0, 4.6)
    // `b` stops SHORT of the hero bay (which sits at t≈1 by construction), so
    // the leg a→b is the long run through the desk field and b→hero is a clean
    // final approach. Pushed any further along the spine it lands on top of the
    // hero and the take finishes by walking a metre BACKWARDS into its own last
    // shot — measured at t = 0.92.
    const b = dip(0.78, 6.0, 4.6)
    // Look on down the floor's long axis, deeper in — the desk banks then
    // recede toward the vanishing point instead of sitting side-on.
    const look = bestFreePoint(
      g,
      a[0] + axis[0] * travel * 12 + perp[0] * side * 3.5,
      a[1] + axis[1] * travel * 12 + perp[1] * side * 3.5,
      5.0,
      { preferOpen: true, accept: inOpen },
    )
    stops.push({ name: 'open-space', at: a, look, lookWeight: 0.85, span: 6, slow: 0.92 })
    stops.push({ name: 'open-space-far', at: b, span: 5, slow: 0.95 })
  }

  // ── 3. The hero wide, deep in the open floor.
  //
  //      The direction is NOT authored by hand. `bestVista` scores every heading
  //      on the same clearance/kind field the per-frame composition bias uses,
  //      so the closing frame is the richest one available from that standing
  //      point — depth, content crossed, and daylight at the end of the line —
  //      rather than whichever wall a hand-picked look target happened to face.
  //      It is a full-circle scan, so the camera can close looking back down the
  //      floor if that is genuinely the better shot.
  const heroYaw = bestVista(g, heroAt[0], heroAt[1], (hfovDeg * Math.PI) / 180)
  stops.push({
    name: 'open-hero',
    at: heroAt,
    look: [heroAt[0] + Math.cos(heroYaw) * 14, heroAt[1] + Math.sin(heroYaw) * 14],
    // Not 1: the last second is a settle, and leaving the composition bias a
    // tenth of the yaw lets it hold the frame off a desk return that the
    // standing-point scan could not see from the exact stop centre.
    lookWeight: 0.9,
    span: 5.5,
    slow: 0.6,
  })

  if (stops.length < 2) throw new Error('walkthrough: the document has no reception/corridor/open space to walk')
  return { stops, reception, open }
}

// ── 3b. Sight lines ──────────────────────────────────────────────────────────

/** Is the straight sight line from a to b unobstructed at eye height? */
function sightClear(g: ClearanceGrid, ax: number, ay: number, bx: number, by: number): boolean {
  const d = Math.hypot(bx - ax, by - ay)
  const n = Math.max(1, Math.ceil(d / (g.cell * 1.5)))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    if (clearanceAt(g, ax + (bx - ax) * t, ay + (by - ay) * t) < SIGHT_CLEAR_M) return false
  }
  return true
}

/**
 * The furthest point on the path within `LOOK_AHEAD_M` that the eye can
 * actually SEE from here.
 *
 * This is the fix for the take's worst framing defect. A FIXED look-ahead makes
 * the camera start turning a corner 7.5 m before it reaches it, and on a
 * test-fit plate a corner is a partition — so for the two seconds before every
 * turn the camera was aimed squarely into the blank flank of the room it was
 * about to walk past, with the corridor it was actually in pushed out to the
 * frame edge. Measured on the demo plate, that is exactly what produced the two
 * >50 %-blank moments (the turn off the corridor and the climb back out).
 *
 * Looking at the furthest VISIBLE point holds the frame down the corridor until
 * the corner opens up, then turns through it — which is also what a person
 * walking the building does with their head.
 */
function visibleLookAhead(
  g: ClearanceGrid,
  path: Pt[],
  cum: Float64Array,
  s: number,
  total: number,
  x: number,
  y: number,
): Pt {
  let best = sampleAt(path, cum, Math.min(total, s + LOOK_AHEAD_MIN_M))
  for (let L = LOOK_AHEAD_MIN_M + 0.4; L <= LOOK_AHEAD_M; L += 0.4) {
    const q = sampleAt(path, cum, Math.min(total, s + L))
    if (!sightClear(g, x, y, q[0], q[1])) break
    best = q
  }
  return best
}

// ── 4. Poses ─────────────────────────────────────────────────────────────────

/** Smooth compact bump on [-1, 1]. */
function bump(u: number): number {
  const a = Math.min(1, Math.abs(u))
  const t = 1 - a * a
  return t * t
}

interface PoseTrack {
  poses: WalkPose[]
  pathLengthM: number
  minClearanceM: number
  thresholdPasses: number
  /** Peak yaw rate at FULL frame rate — the "is it a pan or a whip?" number. */
  maxYawRateDegS: number
  meanYawRateDegS: number
  /** Largest composition bias applied (deg) — how hard the camera was turned
   *  off pure look-ahead to keep a blank partition out of the frame. */
  maxLookBiasDeg: number
  /** Worst fraction of any frame that would have been near blank surface
   *  BEFORE the bias, and the same figure after it. */
  worstBlankBefore: number
  worstBlankAfter: number
}

/**
 * Turn the route into one pose per frame.
 *
 * Speed is integrated forward at 1/fps with a per-arc-length multiplier (door
 * thresholds and authored stops slow down) and an ease-in / ease-out envelope;
 * the base speed is bisected so the last frame lands exactly at the end of the
 * path. Yaw is a weighted blend of look-ahead and the authored look targets,
 * unwrapped and Gaussian-smoothed over ~0.5 s — which is what removes the kink
 * a spline corner would otherwise put in the frame. Pitch stays at 0.
 */
function buildPoses(
  g: ClearanceGrid,
  state: DocState,
  path: Pt[],
  stops: WalkStop[],
  stopS: number[],
  frames: number,
  fps: number,
  eyeY: number,
  hfovDeg: number,
): PoseTrack {
  const cum = arcLengths(path)
  const total = cum[cum.length - 1]
  const doors = state.components.filter((c) => c.category === 'Door')

  // Speed multiplier as a function of arc length: sampled once, read by lerp.
  const MULT_STEP = 0.1
  const multN = Math.max(2, Math.ceil(total / MULT_STEP) + 1)
  const mult = new Float64Array(multN)
  let thresholdPasses = 0
  let inThreshold = false
  for (let i = 0; i < multN; i++) {
    const s = Math.min(total, i * MULT_STEP)
    const [x, y] = sampleAt(path, cum, s)
    let m = 1
    // Doorways: slow to a stroll and let the frame breathe.
    let near = false
    for (const d of doors) {
      const dist = Math.hypot(d.x - x, d.y - y)
      if (dist < 1.5) {
        m = Math.min(m, 0.5 + 0.5 * (dist / 1.5))
        near = true
      }
    }
    if (near && !inThreshold) thresholdPasses++
    inThreshold = near
    // Authored slowdowns.
    for (let k = 0; k < stops.length; k++) {
      const st = stops[k]
      if (st.slow === undefined) continue
      const w = bump((s - stopS[k]) / (st.span ?? 2.5))
      if (w > 0) m = Math.min(m, 1 - (1 - st.slow) * w)
    }
    mult[i] = m
  }
  const multAt = (s: number): number => {
    const f = Math.max(0, Math.min(multN - 1.001, s / MULT_STEP))
    const i = Math.floor(f)
    return mult[i] + (mult[i + 1] - mult[i]) * (f - i)
  }

  // Ease-in / ease-out envelope over the take.
  const dt = 1 / fps
  const dur = frames * dt
  const env = (t: number): number => {
    const inS = Math.min(2.0, dur * 0.1)
    const outS = Math.min(2.6, dur * 0.12)
    let e = 1
    if (t < inS) e = 0.22 + 0.78 * (1 - Math.pow(1 - t / inS, 2))
    if (t > dur - outS) e = Math.min(e, 0.18 + 0.82 * Math.pow(Math.max(0, (dur - t) / outS), 1.4))
    return e
  }

  // The take SETTLES on its hero: the last second is spent already parked at the
  // end of the path. Without it the yaw smoother — which averages over ±0.5 s —
  // is still half-way through the final turn when the video ends, and the shot
  // the whole route was built to arrive at is delivered off-centre.
  const settle = Math.min(frames - 2, Math.round(fps * 1.0))
  const arriveAt = frames - 1 - settle
  const walk = (v0: number): Float64Array => {
    const s = new Float64Array(frames)
    let cur = 0
    for (let i = 0; i < frames; i++) {
      s[i] = Math.min(cur, total)
      cur += v0 * multAt(cur) * env(i * dt) * dt
    }
    return s
  }
  let lo = 0.05
  let hi = 6
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2
    const s = walk(mid)
    if (s[arriveAt] < total) lo = mid
    else hi = mid
  }
  const sTrack = walk((lo + hi) / 2)

  // Desired yaw per frame.
  const hfov = (hfovDeg * Math.PI) / 180
  const maxBias = (LOOK_BIAS_MAX_DEG * Math.PI) / 180
  const yaw = new Float64Array(frames)
  /** How free each frame's yaw is: 0 where the shot is authored, 1 on pure
   *  look-ahead. The composition bias inherits it. */
  const freedom = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    const s = sTrack[i]
    const [x, y] = sampleAt(path, cum, s)
    const [ax, ay] = visibleLookAhead(g, path, cum, s, total, x, y)
    let vx = ax - x
    let vy = ay - y
    const m0 = Math.hypot(vx, vy)
    if (m0 < 1e-4) {
      // At the very end the look-ahead degenerates; hold the previous heading.
      vx = Math.cos(yaw[Math.max(0, i - 1)])
      vy = Math.sin(yaw[Math.max(0, i - 1)])
    } else {
      vx /= m0
      vy /= m0
    }
    let wSum = 0
    let bx = 0
    let by = 0
    for (let k = 0; k < stops.length; k++) {
      const st = stops[k]
      if (!st.look) continue
      const w = bump((s - stopS[k]) / (st.span ?? 3)) * (st.lookWeight ?? 0.8)
      if (w <= 0) continue
      const dx = st.look[0] - x
      const dy = st.look[1] - y
      const m = Math.hypot(dx, dy)
      if (m < 0.2) continue
      bx += (dx / m) * w
      by += (dy / m) * w
      wSum += w
    }
    const W = Math.min(1, wSum)
    const fx = vx * (1 - W) + bx * (wSum ? W / wSum : 0)
    const fy = vy * (1 - W) + by * (wSum ? W / wSum : 0)
    yaw[i] = Math.atan2(fy, fx)
    // An authored shot is a composition someone chose, so the composition bias
    // must not drag it off its subject: it inherits only the share of the yaw
    // that is NOT authored. (A floor under this was tried and measured — it
    // changed nothing, because where the authored shots still carry a blank
    // flank the bias already reports no better yaw exists.)
    freedom[i] = 1 - W
  }
  // Unwrap, then Gaussian-smooth: no kinks, no 2π snaps.
  for (let i = 1; i < frames; i++) {
    let d = yaw[i] - yaw[i - 1]
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    yaw[i] = yaw[i - 1] + d
  }
  const gauss = (src: Float64Array, seconds: number): Float64Array => {
    const sigma = Math.max(2, Math.round(fps * seconds))
    const kernel: number[] = []
    for (let k = -3 * sigma; k <= 3 * sigma; k++) kernel.push(Math.exp((-k * k) / (2 * sigma * sigma)))
    const kSum = kernel.reduce((a, b) => a + b, 0)
    const out = new Float64Array(frames)
    for (let i = 0; i < frames; i++) {
      let acc = 0
      for (let k = 0; k < kernel.length; k++) {
        acc += src[Math.min(frames - 1, Math.max(0, i + k - 3 * sigma))] * kernel[k]
      }
      out[i] = acc / kSum
    }
    return out
  }
  const smooth = gauss(yaw, 0.75)

  // ── Composition bias, applied to the SMOOTHED yaw.
  //
  // It has to run here, not before the smoother: the smoother averages over
  // ±0.75 s, so a bias folded into the raw yaw is diluted by its neighbours and
  // the frame that actually ships is still the one aimed at the partition. Here
  // the bias measures the delivered frame and corrects it, and it is smoothed on
  // its own shorter kernel — enough to guarantee no kink, short enough that the
  // correction still lands where it was needed.
  const rawBias = new Float64Array(frames)
  let worstBlankBefore = 0
  for (let i = 0; i < frames; i++) {
    const [x, y] = sampleAt(path, cum, sTrack[i])
    const fl = frameLook(g, x, y, smooth[i], hfov, maxBias)
    if (fl.blankFraction > worstBlankBefore) worstBlankBefore = fl.blankFraction
    rawBias[i] = fl.biasRad * freedom[i]
  }
  const bias = gauss(rawBias, 0.4)
  let maxBiasApplied = 0
  let worstBlankAfter = 0
  for (let i = 0; i < frames; i++) {
    smooth[i] += bias[i]
    maxBiasApplied = Math.max(maxBiasApplied, Math.abs(bias[i]))
    const [x, y] = sampleAt(path, cum, sTrack[i])
    const after = frameLook(g, x, y, smooth[i], hfov, 0)
    if (after.blankFraction > worstBlankAfter) worstBlankAfter = after.blankFraction
  }

  let minClear = Infinity
  const poses: WalkPose[] = []
  for (let i = 0; i < frames; i++) {
    // The sampled point is re-seated one last time: interpolating between
    // path samples can shave a corner the path itself cleared.
    const [px, py] = pushToClearance(g, sampleAt(path, cum, sTrack[i]), MIN_CLEARANCE + 0.05)
    const clear = clearanceAt(g, px, py)
    if (clear < minClear) minClear = clear
    poses.push({
      pos: new THREE.Vector3(px, eyeY, py),
      look: new THREE.Vector3(px + Math.cos(smooth[i]) * 10, eyeY, py + Math.sin(smooth[i]) * 10),
      s: sTrack[i],
      clearance: clear,
    })
  }
  let maxRate = 0
  let sumRate = 0
  for (let i = 1; i < frames; i++) {
    const r = Math.abs(smooth[i] - smooth[i - 1]) * fps * (180 / Math.PI)
    maxRate = Math.max(maxRate, r)
    sumRate += r
  }
  return {
    poses,
    pathLengthM: total,
    minClearanceM: minClear,
    thresholdPasses,
    maxYawRateDegS: Number(maxRate.toFixed(1)),
    meanYawRateDegS: Number((sumRate / Math.max(1, frames - 1)).toFixed(1)),
    maxLookBiasDeg: Number(((maxBiasApplied * 180) / Math.PI).toFixed(1)),
    worstBlankBefore: Number(worstBlankBefore.toFixed(3)),
    worstBlankAfter: Number(worstBlankAfter.toFixed(3)),
  }
}

// ── 4b. Doorways have to be open ────────────────────────────────────────────

/**
 * Open every doorway by hiding its leaf slab.
 *
 * `furniture3d.buildDoor` models a CLOSED door — a solid slab filling the
 * opening — which is right for a plan and for a still shot taken from a
 * threshold, and fatal for a walkthrough: the camera would pass straight
 * through a shut door. The wall spans already have the opening cut out of them
 * (`materialTheme.solidRuns`), so the leaf is the only thing in the way.
 *
 * The leaf is hidden rather than swung. A swung leaf is not free: at 90° it
 * stands 0.9 m into a space the router has already committed to, and folded
 * flat it lines the wall the camera turns toward — which, measured on this
 * plate, put a full-frame slab of oak in the hero shot and in two corridor
 * passes. Hiding it leaves the dark-metal jambs and head standing, so a
 * threshold still reads as a doorway, and nothing can be walked through.
 * Doors remain in the document, the plan and the takeoff; this is a camera
 * convention, not a change of quantity.
 */
function openDoorways(scene: InteriorScene, state: DocState): number {
  const key = (x: number, z: number) => `${x.toFixed(4)}|${z.toFixed(4)}`
  const doors = new Map<string, DocComponent>()
  for (const d of state.components) if (d.category === 'Door') doors.set(key(d.x, d.y), d)
  let n = 0
  const size = new THREE.Vector3()
  for (const child of scene.root.children) {
    const d = doors.get(key(child.position.x, child.position.z))
    if (!d) continue
    let hid = false
    child.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      new THREE.Box3().setFromObject(m).getSize(size)
      // The leaf is the only part of the assembly that is both full-height and
      // full-width; the jambs are 40 mm wide and the head is 40 mm tall.
      if (size.y > 1.2 && Math.max(size.x, size.z) > d.w * 0.45) {
        m.visible = false
        hid = true
      }
    })
    if (hid) n++
  }
  return n
}

// ── 5. Anti-clipping: exact AABB containment ─────────────────────────────────

const SOLID_SKIP = /glass|mullion|emissive/i

function isSolid(o: THREE.Object3D): boolean {
  const m = o as THREE.Mesh
  if (!m.isMesh) return false
  const mat = m.material as THREE.Material | THREE.Material[]
  const one = Array.isArray(mat) ? mat[0] : mat
  if (!one) return false
  if ((one as THREE.MeshPhysicalMaterial).transmission) return false
  if (one.transparent) return false
  return !SOLID_SKIP.test(one.type + (one.name ?? ''))
}

/**
 * World AABBs of every upright solid. This is the second, independent guarantee
 * that the camera is never inside geometry — and it is a containment test, NOT
 * a ray-parity count. Every material in the theme is `FrontSide`, so three culls
 * back faces: a ray crossing a closed box reports ONE hit (parity says
 * "inside"), and a ray fired from inside reports NONE (parity says "outside") —
 * exactly backwards on the case that matters.
 */
function solidBoxes(scene: InteriorScene): THREE.Box3[] {
  const out: THREE.Box3[] = []
  scene.root.traverse((o) => {
    if (!o.visible) return // a hidden door leaf is not an obstacle
    if (!isSolid(o)) return
    if (o.userData?.surface) return // floor / ceiling slabs are not obstacles
    out.push(new THREE.Box3().setFromObject(o).expandByScalar(0.02))
  })
  return out
}

/** Nudge an eye out of any box it is inside, along that box's shortest escape. */
function escapeSolids(boxes: THREE.Box3[], p: THREE.Vector3): boolean {
  let fixed = false
  for (let pass = 0; pass < 4; pass++) {
    let hit: THREE.Box3 | null = null
    for (const b of boxes) {
      if (b.containsPoint(p)) {
        hit = b
        break
      }
    }
    if (!hit) break
    fixed = true
    const dx0 = p.x - hit.min.x
    const dx1 = hit.max.x - p.x
    const dz0 = p.z - hit.min.z
    const dz1 = hit.max.z - p.z
    const m = Math.min(dx0, dx1, dz0, dz1)
    const eps = 0.06
    if (m === dx0) p.x = hit.min.x - eps
    else if (m === dx1) p.x = hit.max.x + eps
    else if (m === dz0) p.z = hit.min.z - eps
    else p.z = hit.max.z + eps
  }
  return fixed
}

// ── 6. Branding ──────────────────────────────────────────────────────────────

/** The repo's ONE brand mark, decoded for texturing. `qtoWorkbook` draws it for
 *  the workbook's 11 data sheets; the video reuses those exact pixels rather
 *  than authoring a third logo. */
async function brandMarkBitmap(): Promise<ImageBitmap> {
  const { renderBrandMarkPng } = await import('./qtoWorkbook')
  const png = await renderBrandMarkPng()
  return createImageBitmap(new Blob([png as unknown as BlobPart], { type: 'image/png' }))
}

/** A wall-mounted display carrying the mark — the reference's in-scene branding. */
function displayTexture(mark: ImageBitmap, w = 1024, h = 576): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#F7F5F1'
  ctx.fillRect(0, 0, w, h)
  const mw = w * 0.66
  const mh = (mw * mark.height) / mark.width
  ctx.drawImage(mark, (w - mw) / 2, (h - mh) / 2 - h * 0.04, mw, mh)
  ctx.fillStyle = '#E8A13C'
  ctx.fillRect((w - mw) / 2, (h + mh) / 2 + h * 0.03, mw, Math.max(4, h * 0.018))
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

interface DisplayRig {
  group: THREE.Group
  count: number
  /** Where each screen hangs (plan m) — so the report can show the camera saw them. */
  at: Pt[]
  dispose(): void
}

/**
 * Mount branded displays on the walls the camera will face: the reception's far
 * wall, and the service core's flank in the open floor. Screens are unlit
 * (`MeshBasicMaterial`), which is what a powered display looks like next to
 * tone-mapped plasterboard.
 */
function addBrandedDisplays(
  scene: InteriorScene,
  state: DocState,
  mark: ImageBitmap,
  route: WalkRoute,
): DisplayRig {
  const group = new THREE.Group()
  group.name = 'branding'
  const tex = displayTexture(mark)
  const screenMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true })
  const bezelMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.2 })
  const owned: THREE.BufferGeometry[] = []
  const at: Pt[] = []
  let count = 0

  // A zone edge is the wall's CENTRELINE, and a partition is 0.2 m thick, so a
  // screen set 50 mm proud of the edge is buried inside its own wall. Stand it
  // off far enough to clear the leaf and its own bezel.
  const STANDOFF = 0.15
  const mount = (at0: Pt, nx: number, ny: number, width: number, sill: number) => {
    const height = (width * 9) / 16
    const yaw = Math.atan2(nx, ny)
    const g = new THREE.Group()
    g.position.set(at0[0] + nx * STANDOFF, sill + height / 2, at0[1] + ny * STANDOFF)
    g.rotation.y = yaw
    const bezelGeo = new THREE.BoxGeometry(width + 0.07, height + 0.07, 0.05)
    const screenGeo = new THREE.PlaneGeometry(width, height)
    owned.push(bezelGeo, screenGeo)
    const bezel = new THREE.Mesh(bezelGeo, bezelMat)
    bezel.castShadow = false
    bezel.receiveShadow = true
    g.add(bezel)
    const screen = new THREE.Mesh(screenGeo, screenMat)
    screen.position.z = 0.031
    g.add(screen)
    group.add(g)
    at.push([Number(at0[0].toFixed(2)), Number(at0[1].toFixed(2))])
    count++
  }

  // The rooms the ROUTE resolved — a screen the camera never sees is not
  // branding, which is why this hangs nothing in the meeting rooms: the take no
  // longer enters one, and their doors sit at the far corner of the corridor
  // wall, so a display on the identity wall inside is not on any sight line a
  // camera walking past the opening has. Two screens on the route, not three in
  // the model.
  const named = new Map(route.stops.map((s) => [s.name, s] as const))
  if (route.reception) {
    const room = route.reception
    const doors = roomDoors(state, room)
    // `from` is where the CAMERA reads the room from, not the room's own door.
    // The two are different walls on a plan whose doors sit in a corner: shot
    // from the reception's stop the identity wall is the one dead ahead, while
    // shot from the door it is the flank 40° off frame — measured, and it is
    // why the mark used to sit half outside the opening frame.
    const stop = named.get('outside-reception')
    const from: Pt = stop
      ? stop.at
      : doors[0]
        ? [doors[0].x, doors[0].y]
        : [room.center.x, room.bbox.maxY]
    const wall = facingWall(room, from, scene.plate)
    const span = wall.nx !== 0 ? room.bbox.maxY - room.bbox.minY : room.bbox.maxX - room.bbox.minX
    mount(wall.at, wall.nx, wall.ny, Math.min(1.7, Math.max(0.9, span * 0.45)), 1.05)
  }

  // The core's flank, facing the open floor — where a real fit-out hangs its
  // wayfinding screen. Aimed at the open-space stop so the camera passes it.
  const core = (state.zones ?? []).find((z) => z.zone_type === 'Core')
  const openRoom = route.open
  if (core && openRoom) {
    const b = zoneBBox(core.shape)
    const openStop = named.get('open-space')
    const toward: Pt = openStop ? openStop.at : [openRoom.center.x, openRoom.center.y]
    const faces: Array<{ at: Pt; nx: number; ny: number }> = [
      { at: [(b.minX + b.maxX) / 2, b.minY], nx: 0, ny: -1 },
      { at: [(b.minX + b.maxX) / 2, b.maxY], nx: 0, ny: 1 },
      { at: [b.minX, (b.minY + b.maxY) / 2], nx: -1, ny: 0 },
      { at: [b.maxX, (b.minY + b.maxY) / 2], nx: 1, ny: 0 },
    ]
    let best = faces[0]
    let bd = Infinity
    for (const f of faces) {
      const d = Math.hypot(f.at[0] + f.nx - toward[0], f.at[1] + f.ny - toward[1])
      if (d < bd) {
        bd = d
        best = f
      }
    }
    // 1.3 m, not 1.7: the route brushes this flank at 1.7 m, and a 1.7 m screen
    // there subtends 53° of a 70° frame — measured 0.821 mean luminance at the
    // closest frame, i.e. a white billboard, not a building. At 1.3 m it still
    // reads from the aisle 3 m back and the pass stays a near-field anchor.
    mount(best.at, best.nx, best.ny, 1.3, 1.15)
  }

  scene.root.add(group)
  return {
    group,
    count,
    at,
    dispose() {
      scene.root.remove(group)
      for (const g of owned) g.dispose()
      tex.dispose()
      screenMat.dispose()
      bezelMat.dispose()
    },
  }
}

/**
 * The 1.5 s branded title card.
 *
 * A DELIBERATE divergence from the reference (qbiq brands in-scene only), ruled
 * in by the orchestrator because §4 and gate G7 both require it. Tuned to G7's
 * assertions: a flat card (stdDev ≤ 0.22) that is still not a blank field
 * (≥ 0.06), mean luminance inside [0.25, 0.85], and a clearly detectable band of
 * the `#E8A13C` accent.
 */
export async function renderTitleCard(
  width: number,
  height: number,
  title: string,
  subtitle: string,
  mark?: ImageBitmap,
): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')!
  // A slate ramp, not a flat fill: it puts the card's luminance mid-band and
  // gives it the stdDev floor the gate wants without any texture.
  const grd = ctx.createLinearGradient(0, 0, width * 0.35, height)
  grd.addColorStop(0, '#3B434C')
  grd.addColorStop(1, '#8B95A0')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, width, height)

  const bmp = mark ?? (await brandMarkBitmap())
  const mw = width * 0.34
  const mh = (mw * bmp.height) / bmp.width
  const px = (width - mw) / 2
  const py = height * 0.32
  // The mark ships on its own white field — set it as a plaque rather than
  // fighting it.
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(px - mw * 0.06, py - mh * 0.14, mw * 1.12, mh * 1.28)
  ctx.drawImage(bmp, px, py, mw, mh)

  // The accent rule: the pixels G7 looks for, and the card's spine.
  ctx.fillStyle = '#E8A13C'
  ctx.fillRect(px - mw * 0.06, py + mh * 1.14 + height * 0.035, mw * 1.12, Math.round(height * 0.017))

  ctx.textAlign = 'center'
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `600 ${Math.round(height * 0.05)}px "Space Grotesk", Helvetica, Arial, sans-serif`
  ctx.fillText(title, width / 2, height * 0.74)
  ctx.fillStyle = '#DCE3EA'
  ctx.font = `400 ${Math.round(height * 0.026)}px "IBM Plex Mono", Menlo, monospace`
  ctx.fillText(subtitle, width / 2, height * 0.805)
  return c
}

// ── 7. The renderer ──────────────────────────────────────────────────────────

function detectSoftwareGL(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const s = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    return /swiftshader|llvmpipe|software|basic render/i.test(s)
  } catch {
    return false
  }
}

/**
 * A PERSISTENT interior renderer. `interiorStill.renderInteriorStill` builds a
 * renderer, an environment map and a light rig per call — right for four stills,
 * catastrophic for a thousand frames — so the video keeps one of each alive and
 * only moves the camera and the follow-lights.
 */
class WalkRenderer {
  readonly softwareGL: boolean
  private renderer: THREE.WebGLRenderer
  private world: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private composer: EffectComposer
  private passes: { render: RenderPass; gtao: GTAOPass; output: OutputPass; smaa: SMAAPass }
  private usePost: boolean
  private sky: THREE.CanvasTexture
  private envRT: THREE.WebGLRenderTarget
  private base: THREE.Group
  private lamps: THREE.Group | null = null
  private lampFocus = { x: NaN, z: NaN }
  private lampOpts: { ceilingLamps: number; lampIntensity: number }
  readonly out: HTMLCanvasElement
  private outCtx: CanvasRenderingContext2D

  constructor(
    private scene: InteriorScene,
    private W: number,
    private H: number,
    opts: WalkthroughOpts,
  ) {
    const gl = document.createElement('canvas')
    this.renderer = new THREE.WebGLRenderer({
      canvas: gl,
      antialias: false, // SMAA runs at the end of the composer instead
      preserveDrawingBuffer: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.softwareGL = detectSoftwareGL(this.renderer.getContext())
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(W, H, false)
    this.renderer.shadowMap.enabled = true
    // Verbatim from `interiorStill.ts` — D-1 §2. Diverge and the video stops
    // looking like it was shot in the same building as the stills.
    this.renderer.shadowMap.type = THREE.VSMShadowMap
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = opts.exposure ?? 1.15
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.world = new THREE.Scene()
    this.sky = interiorSkyTexture()
    this.world.background = this.sky
    this.envRT = interiorEnvironment(this.renderer)
    this.world.environment = this.envRT.texture
    this.world.environmentIntensity = opts.environmentIntensity ?? 0.42
    this.world.add(scene.root)

    // The sun / hemi / overhead fill are STATIC and fitted to the whole plate,
    // so the shadow map's texel grid never moves under the camera. Only the
    // point luminaires follow.
    const b = scene.bounds
    const cx = (b.min.x + b.max.x) / 2
    const cz = (b.min.z + b.max.z) / 2
    const radius = Math.max(10, Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 2)
    this.base = createInteriorLighting({
      focus: { x: cx, y: cz, radius },
      ceilingLamps: 0,
      shadowMapSize: 4096,
    })
    this.world.add(this.base)
    this.lampOpts = { ceilingLamps: opts.ceilingLamps ?? 28, lampIntensity: opts.lampIntensity ?? 2 }

    const aspect = W / H
    const fovX = ((opts.hfovDeg ?? DEFAULT_HFOV) * Math.PI) / 180
    const fovY = 2 * Math.atan(Math.tan(fovX / 2) / aspect)
    this.cam = new THREE.PerspectiveCamera((fovY * 180) / Math.PI, aspect, 0.1, 400)

    this.usePost = opts.postprocess !== false && !this.softwareGL
    this.composer = new EffectComposer(this.renderer)
    this.passes = {
      render: new RenderPass(this.world, this.cam),
      gtao: new GTAOPass(this.world, this.cam, W, H),
      output: new OutputPass(),
      smaa: new SMAAPass(),
    }
    if (this.usePost) {
      this.passes.gtao.output = GTAOPass.OUTPUT.Default
      this.passes.gtao.blendIntensity = 0.95
      this.passes.gtao.updateGtaoMaterial({
        radius: 0.4,
        distanceExponent: 1.0,
        thickness: 1.0,
        distanceFallOff: 1.0,
        scale: 1.0,
        samples: 16,
        screenSpaceRadius: false,
      })
      this.composer.setPixelRatio(1)
      this.composer.setSize(W, H)
      this.composer.addPass(this.passes.render)
      this.composer.addPass(this.passes.gtao)
      this.composer.addPass(this.passes.output)
      this.composer.addPass(this.passes.smaa)
    }

    this.out = document.createElement('canvas')
    this.out.width = W
    this.out.height = H
    this.outCtx = this.out.getContext('2d')!
  }

  /**
   * Move the ceiling luminaires with the camera, SNAPPED to the 2.4 m downlight
   * pitch. Snapping is the whole trick: the lamp positions are then identical
   * from one rebuild to the next, and lamps only ever enter or leave at the
   * 11 m reach boundary — beyond a decay-2 light's 9.6 m range, so they arrive
   * contributing exactly zero. No pop, and no shader recompile (the count is
   * fixed).
   */
  private followLights(x: number, z: number): void {
    const fx = Math.round(x / LAMP_PITCH) * LAMP_PITCH
    const fz = Math.round(z / LAMP_PITCH) * LAMP_PITCH
    if (fx === this.lampFocus.x && fz === this.lampFocus.z) return
    this.lampFocus = { x: fx, z: fz }
    if (this.lamps) this.world.remove(this.lamps)
    const g = createInteriorLighting({
      focus: { x: fx, y: fz, radius: 8 },
      ceilingLamps: this.lampOpts.ceilingLamps,
      lampIntensity: this.lampOpts.lampIntensity,
      lampReachM: LAMP_REACH_M,
      shadowMapSize: 1,
    })
    // Only the point luminaires; the base rig already owns sun/hemi/fill.
    g.traverse((o) => {
      const l = o as THREE.Light
      if (l.isLight && !(l as THREE.PointLight).isPointLight) {
        l.visible = false
        l.castShadow = false
      }
    })
    this.lamps = g
    this.world.add(g)
  }

  render(pose: WalkPose): HTMLCanvasElement {
    this.cam.position.copy(pose.pos)
    this.cam.up.set(0, 1, 0)
    this.cam.lookAt(pose.look)
    this.cam.updateMatrixWorld()
    this.followLights(pose.pos.x, pose.pos.z)
    if (this.usePost) this.composer.render()
    else this.renderer.render(this.world, this.cam)
    this.outCtx.drawImage(this.renderer.domElement, 0, 0)
    return this.out
  }

  dispose(): void {
    this.world.remove(this.scene.root)
    if (this.lamps) this.world.remove(this.lamps)
    this.sky.dispose()
    this.envRT.dispose()
    this.passes.render.dispose()
    this.passes.gtao.dispose()
    this.passes.output.dispose()
    this.passes.smaa.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }
}

// ── 8. The deliverable ───────────────────────────────────────────────────────

/**
 * Render the whole walkthrough, one frame at a time, through `opts.onFrame`.
 *
 * Timeline: a flat branded card, a cross-dissolve into the moving take (the
 * dissolve runs OVER live footage, so the camera is already walking when the
 * card clears), then one unbroken pedestrian shot — no cuts, no pitch, no shake.
 */
export async function renderWalkthrough(
  state: DocState,
  opts: WalkthroughOpts,
): Promise<WalkthroughSummary> {
  const W = opts.width ?? DEFAULT_WIDTH
  const H = opts.height ?? DEFAULT_HEIGHT
  const fps = opts.fps ?? DEFAULT_FPS
  const eyeY = opts.eyeHeightM ?? EYE_HEIGHT
  const hfovDeg = opts.hfovDeg ?? DEFAULT_HFOV
  const titleS = Math.max(0, opts.titleCardS ?? DEFAULT_TITLE_S)
  const fadeS = Math.min(titleS, opts.fadeS ?? DEFAULT_FADE_S)
  const progress = opts.onProgress ?? (() => {})

  if (!state.walls.length) throw new Error('walkthrough: the document has no walls')

  progress(0, 1, 'grid')
  // The core's circulation evaluator uses this cell size; matching it keeps the
  // camera's idea of a corridor and the scored one the same.
  const cell = opts.circulation?.cell_size && opts.circulation.cell_size > 0 ? opts.circulation.cell_size : 0.15
  const grid = buildClearanceGrid(state, opts.plate ?? null, cell)

  progress(0, 1, 'scene')
  const scene = buildInteriorScene(state, { wallSpans: opts.wallSpans, plate: opts.plate })
  let displays: DisplayRig | null = null
  let renderer: WalkRenderer | null = null
  try {
    const doorsOpened = openDoorways(scene, state)
    const mark = await brandMarkBitmap()

    progress(0, 1, 'route')
    const route = planWalkRoute(scene, state, grid, hfovDeg)
    const stops = route.stops
    const { path, stopS } = splineThroughStops(grid, stops)
    // Displays go up AFTER the route is known, so every screen is on a wall the
    // camera looks at (and they are then part of the solid set the containment
    // test runs against).
    if (opts.inSceneBranding !== false) displays = addBrandedDisplays(scene, state, mark, route)
    const pathLength = arcLengths(path)[path.length - 1]

    // Duration follows the plan: a 40 m route at a pedestrian pace is longer
    // than a 20 m one, and both have to land inside G7's 30–45 s window.
    const wanted = opts.durationS ?? Math.max(DURATION_RANGE[0], Math.min(DURATION_RANGE[1], pathLength / TARGET_SPEED_MPS + titleS))
    const totalS = Math.max(DURATION_RANGE[0], Math.min(DURATION_RANGE[1], wanted))
    const total = Math.round(totalS * fps)
    const cardFrames = Math.round((titleS - fadeS) * fps)
    const walkFrames = total - cardFrames

    const track = buildPoses(grid, state, path, stops, stopS, walkFrames, fps, eyeY, hfovDeg)

    progress(0, total, 'render')
    renderer = new WalkRenderer(scene, W, H, opts)
    const boxes = solidBoxes(scene)
    let containmentFixes = 0
    const containmentAt: Pt[] = []
    for (const p of track.poses) {
      const before: Pt = [p.pos.x, p.pos.z]
      if (escapeSolids(boxes, p.pos)) {
        containmentFixes++
        if (containmentAt.length < 12) {
          containmentAt.push([Number(before[0].toFixed(2)), Number(before[1].toFixed(2))])
        }
      }
    }

    const card = await renderTitleCard(
      W,
      H,
      opts.title ?? 'DSource Test-Fit Walkthrough',
      opts.subtitle ?? new Date().toISOString().slice(0, 10),
      mark,
    )
    const composite = document.createElement('canvas')
    composite.width = W
    composite.height = H
    const cctx = composite.getContext('2d')!

    for (let i = 0; i < total; i++) {
      const timeS = i / fps
      let canvas: HTMLCanvasElement
      let pose: WalkPose | null = null
      if (i < cardFrames) {
        canvas = card
      } else {
        pose = track.poses[Math.min(track.poses.length - 1, i - cardFrames)]
        const frame = renderer.render(pose)
        const alpha = fadeS > 0 ? Math.max(0, Math.min(1, (titleS - timeS) / fadeS)) : 0
        if (alpha > 0.001) {
          cctx.drawImage(frame, 0, 0)
          cctx.globalAlpha = alpha
          cctx.drawImage(card, 0, 0)
          cctx.globalAlpha = 1
          canvas = composite
        } else {
          canvas = frame
        }
      }
      await opts.onFrame({ index: i, total, timeS, canvas, pose })
      if (i % 15 === 0 || i === total - 1) progress(i + 1, total, 'render')
    }

    return {
      width: W,
      height: H,
      fps,
      frames: total,
      durationS: total / fps,
      titleCardS: titleS,
      hfovDeg,
      eyeHeightM: eyeY,
      pathLengthM: Number(track.pathLengthM.toFixed(2)),
      meanSpeedMps: Number((track.pathLengthM / (walkFrames / fps)).toFixed(3)),
      stops: stops.map((s, i) => ({
        name: s.name,
        at: [Number(s.at[0].toFixed(2)), Number(s.at[1].toFixed(2))],
        sM: Number(stopS[i].toFixed(2)),
      })),
      thresholdPasses: track.thresholdPasses,
      maxYawRateDegS: track.maxYawRateDegS,
      meanYawRateDegS: track.meanYawRateDegS,
      maxLookBiasDeg: track.maxLookBiasDeg,
      worstBlankBefore: track.worstBlankBefore,
      worstBlankAfter: track.worstBlankAfter,
      minClearanceM: Number(track.minClearanceM.toFixed(3)),
      containmentFixes,
      containmentAt,
      displays: displays?.count ?? 0,
      displayAt: displays?.at ?? [],
      track: track.poses
        .filter((_, i) => i % Math.max(1, Math.round(fps / 2)) === 0)
        .map((p, k) => ({
          t: Number(((k * Math.max(1, Math.round(fps / 2)) + cardFrames) / fps).toFixed(2)),
          x: Number(p.pos.x.toFixed(2)),
          y: Number(p.pos.z.toFixed(2)),
          yawDeg: Number(((Math.atan2(p.look.z - p.pos.z, p.look.x - p.pos.x) * 180) / Math.PI).toFixed(1)),
          clearM: Number(p.clearance.toFixed(2)),
        })),
      doorsOpened,
      softwareGL: renderer.softwareGL,
    }
  } finally {
    renderer?.dispose()
    displays?.dispose()
    scene.dispose()
  }
}
