// CAD edit/modify layer — P4 of docs/design/cad-components.md.
//
// Selection is shared state (multiple modify tools operate on it), so this module
// exposes a small module-level controller PLUS a tool registry:
//
//   • `selection` — a mutable `{ ids: Set<number> }` the `select` tool maintains and
//     every modify tool reads. This is how selection crosses tool boundaries WITHOUT
//     touching the `model.ts` contract (ToolCtx stays as-is).
//   • Pure geometry helpers (`entityHitTest`, `translate/rotate/scale/mirrorEntity`,
//     `offsetEntity`, `entityGrips`, `applyGrip`) — used by the tools, by grip editing
//     in EditorCanvas, and reusable by render.ts.
//   • `EDIT_TOOLS` — `select | move | copy | rotate | scale | mirror`, each a
//     `() => CadTool` factory; calling the factory (i.e. activating the tool) captures
//     the current `selection.ids`.
//   • `deleteSelected(store)` — for the host to bind to the Delete/Backspace key.
//
// Coordinates are METERS, world space (matching EditorCanvas, no Y-flip). The host
// passes ALREADY-SNAPPED world points into onDown/onMove.
//
// offset support: line, polyline, circle, arc, rect, ellipse have a well-defined
// parallel/concentric offset. text, dimension, door, window, column return null
// (no meaningful parallel curve — they are point-anchored symbols/annotations).
//
// mirror handedness: kinds with an orientation field flip cleanly — angle fields
// reflect as 2·θ−φ (θ = mirror-line angle), arc winding swaps, door hinge side
// swaps, dimension offset sign flips. rect/ellipse/text rotation reflect the same
// way. Point-anchored kinds (circle, column) mirror by position only.

import type {
  CadEntity,
  CadStore,
  CadTool,
  ToolCtx,
  Vec2,
  LineEnt,
  PolylineEnt,
  RectEnt,
  CircleEnt,
  ArcEnt,
  EllipseEnt,
  DimensionEnt,
  TextEnt,
  DoorEnt,
  WindowEnt,
  ColumnEnt,
} from './model'

// ---------------------------------------------------------------------------
// Shared selection state (crosses tool boundaries; the contract stays untouched).
// ---------------------------------------------------------------------------
export const selection = { ids: new Set<number>() }

const ACCENT = '#E8A13C'
const SELECT_TOL_PX = 6
const BOX_THRESH_PX = 4
const GHOST_DASH = [5, 4]

// ---------------------------------------------------------------------------
// small vector math
// ---------------------------------------------------------------------------
const v = (x: number, y: number): Vec2 => ({ x, y })
const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y)
const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y)
const mul = (a: Vec2, s: number): Vec2 => v(a.x * s, a.y * s)
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y
const len = (a: Vec2): number => Math.hypot(a.x, a.y)
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/** rotate point p about center c by rad (CCW in world space). */
function rot(p: Vec2, c: Vec2, rad: number): Vec2 {
  const s = Math.sin(rad)
  const co = Math.cos(rad)
  const d = sub(p, c)
  return v(c.x + d.x * co - d.y * s, c.y + d.x * s + d.y * co)
}

/** scale point p about center c by factor f. */
function scaleP(p: Vec2, c: Vec2, f: number): Vec2 {
  return v(c.x + (p.x - c.x) * f, c.y + (p.y - c.y) * f)
}

/** reflect point p across the infinite line through a and b. */
function reflectPoint(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a)
  const l2 = dot(d, d)
  if (l2 < 1e-12) return v(p.x, p.y) // degenerate line → identity
  const t = dot(sub(p, a), d) / l2
  const proj = add(a, mul(d, t))
  return v(2 * proj.x - p.x, 2 * proj.y - p.y)
}

/** angle of the a→b direction, radians. */
const lineAngle = (a: Vec2, b: Vec2): number => Math.atan2(b.y - a.y, b.x - a.x)

/** left-hand unit normal of the a→b direction. */
function leftNormal(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a)
  const l = len(d)
  if (l < 1e-12) return v(0, 0)
  return v(-d.y / l, d.x / l)
}

/** distance from p to segment a-b. */
function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const d = sub(b, a)
  const l2 = dot(d, d)
  if (l2 < 1e-12) return dist(p, a)
  let t = dot(sub(p, a), d) / l2
  t = Math.max(0, Math.min(1, t))
  return dist(p, add(a, mul(d, t)))
}

/** intersection of two infinite lines (p1+t·d1) and (p2+s·d2); null if parallel. */
function lineLineIntersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const den = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(den) < 1e-9) return null
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den
  return add(p1, mul(d1, t))
}

const cloneEnt = <T extends CadEntity>(e: T): T => JSON.parse(JSON.stringify(e))

/** is world angle inside the CCW arc [start,end]? */
function angleInArc(ang: number, start: number, end: number): boolean {
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a = norm(ang - start)
  let sweep = norm(end - start)
  if (sweep < 1e-9) sweep = 2 * Math.PI // full circle guard
  return a <= sweep + 1e-9
}

// ---------------------------------------------------------------------------
// entityHitTest — per-kind pick test, tolerance in meters.
// ---------------------------------------------------------------------------
export function entityHitTest(e: CadEntity, world: Vec2, tolM: number): boolean {
  switch (e.kind) {
    case 'line':
      return distToSeg(world, e.a, e.b) <= tolM
    case 'polyline': {
      const n = e.pts.length
      for (let i = 0; i + 1 < n; i++) {
        if (distToSeg(world, e.pts[i], e.pts[i + 1]) <= tolM) return true
      }
      if (e.closed && n > 2 && distToSeg(world, e.pts[n - 1], e.pts[0]) <= tolM) return true
      return false
    }
    case 'rect':
    case 'column': {
      const c = e.kind === 'rect' ? v(e.x, e.y) : e.at
      if (e.kind === 'column' && e.shape === 'round') {
        return dist(world, c) <= Math.max(e.w, e.h) / 2 + tolM
      }
      const local = rot(world, c, -e.rotation) // unrotate into box frame
      return (
        Math.abs(local.x - c.x) <= e.w / 2 + tolM && Math.abs(local.y - c.y) <= e.h / 2 + tolM
      )
    }
    case 'circle':
      return Math.abs(dist(world, e.c) - e.r) <= tolM
    case 'arc': {
      if (Math.abs(dist(world, e.c) - e.r) > tolM) return false
      return angleInArc(lineAngle(e.c, world), e.start, e.end)
    }
    case 'ellipse': {
      const local = rot(world, e.c, -e.rotation)
      const f = Math.hypot((local.x - e.c.x) / e.rx, (local.y - e.c.y) / e.ry)
      return Math.abs(f - 1) * Math.min(e.rx, e.ry) <= tolM
    }
    case 'dimension': {
      const n = leftNormal(e.a, e.b)
      const oa = add(e.a, mul(n, e.offset))
      const ob = add(e.b, mul(n, e.offset))
      return distToSeg(world, e.a, e.b) <= tolM || distToSeg(world, oa, ob) <= tolM
    }
    case 'text':
      return dist(world, e.at) <= tolM + e.h
    case 'door':
    case 'window':
      return dist(world, e.at) <= tolM + e.width / 2
  }
}

// ---------------------------------------------------------------------------
// translateEntity / rotateEntity / scaleEntity / mirrorEntity — return NEW deep entities.
// ---------------------------------------------------------------------------
export function translateEntity(e: CadEntity, dx: number, dy: number): CadEntity {
  const d = v(dx, dy)
  switch (e.kind) {
    case 'line':
      return { ...e, a: add(e.a, d), b: add(e.b, d) }
    case 'polyline':
      return { ...e, pts: e.pts.map((p) => add(p, d)) }
    case 'rect':
      return { ...e, x: e.x + dx, y: e.y + dy }
    case 'circle':
      return { ...e, c: add(e.c, d) }
    case 'arc':
      return { ...e, c: add(e.c, d) }
    case 'ellipse':
      return { ...e, c: add(e.c, d) }
    case 'dimension':
      return { ...e, a: add(e.a, d), b: add(e.b, d) }
    case 'text':
      return { ...e, at: add(e.at, d) }
    case 'door':
    case 'window':
    case 'column':
      return { ...e, at: add(e.at, d) }
  }
}

export function rotateEntity(e: CadEntity, center: Vec2, rad: number): CadEntity {
  const r = (p: Vec2) => rot(p, center, rad)
  switch (e.kind) {
    case 'line':
      return { ...e, a: r(e.a), b: r(e.b) }
    case 'polyline':
      return { ...e, pts: e.pts.map(r) }
    case 'rect': {
      const c = r(v(e.x, e.y))
      return { ...e, x: c.x, y: c.y, rotation: e.rotation + rad }
    }
    case 'circle':
      return { ...e, c: r(e.c) }
    case 'arc':
      return { ...e, c: r(e.c), start: e.start + rad, end: e.end + rad }
    case 'ellipse':
      return { ...e, c: r(e.c), rotation: e.rotation + rad }
    case 'dimension':
      return { ...e, a: r(e.a), b: r(e.b) }
    case 'text':
      return { ...e, at: r(e.at), rotation: e.rotation + rad }
    case 'door':
    case 'window': {
      const out = { ...e, at: r(e.at), angle: e.angle + rad }
      return out
    }
    case 'column':
      return { ...e, at: r(e.at), rotation: e.rotation + rad }
  }
}

export function scaleEntity(e: CadEntity, center: Vec2, f: number): CadEntity {
  const s = (p: Vec2) => scaleP(p, center, f)
  const af = Math.abs(f) // sizes/radii stay positive under a mirror-ish factor
  switch (e.kind) {
    case 'line':
      return { ...e, a: s(e.a), b: s(e.b) }
    case 'polyline':
      return { ...e, pts: e.pts.map(s) }
    case 'rect': {
      const c = s(v(e.x, e.y))
      return { ...e, x: c.x, y: c.y, w: e.w * af, h: e.h * af }
    }
    case 'circle':
      return { ...e, c: s(e.c), r: e.r * af }
    case 'arc':
      return { ...e, c: s(e.c), r: e.r * af }
    case 'ellipse':
      return { ...e, c: s(e.c), rx: e.rx * af, ry: e.ry * af }
    case 'dimension':
      return { ...e, a: s(e.a), b: s(e.b), offset: e.offset * f }
    case 'text':
      return { ...e, at: s(e.at), h: e.h * af }
    case 'door':
      return { ...e, at: s(e.at), width: e.width * af }
    case 'window':
      return { ...e, at: s(e.at), width: e.width * af, thickness: e.thickness * af }
    case 'column':
      return { ...e, at: s(e.at), w: e.w * af, h: e.h * af }
  }
}

export function mirrorEntity(e: CadEntity, a: Vec2, b: Vec2): CadEntity {
  const m = (p: Vec2) => reflectPoint(p, a, b)
  const theta = lineAngle(a, b)
  const reflA = (phi: number) => 2 * theta - phi // reflect a direction angle
  switch (e.kind) {
    case 'line':
      return { ...e, a: m(e.a), b: m(e.b) }
    case 'polyline':
      return { ...e, pts: e.pts.map(m) }
    case 'rect': {
      const c = m(v(e.x, e.y))
      return { ...e, x: c.x, y: c.y, rotation: reflA(e.rotation) }
    }
    case 'circle':
      return { ...e, c: m(e.c) }
    case 'arc': {
      const c = m(e.c)
      // reflection reverses winding: swap endpoints and reflect their angles
      return { ...e, c, start: reflA(e.end), end: reflA(e.start) }
    }
    case 'ellipse':
      return { ...e, c: m(e.c), rotation: reflA(e.rotation) }
    case 'dimension':
      return { ...e, a: m(e.a), b: m(e.b), offset: -e.offset }
    case 'text':
      return { ...e, at: m(e.at), rotation: reflA(e.rotation) }
    case 'door':
      // mirroring a door swaps its hinge side
      return {
        ...e,
        at: m(e.at),
        angle: reflA(e.angle),
        hinge: e.hinge === 'left' ? 'right' : 'left',
      }
    case 'window':
      return { ...e, at: m(e.at), angle: reflA(e.angle) }
    case 'column':
      return { ...e, at: m(e.at), rotation: reflA(e.rotation) }
  }
}

// ---------------------------------------------------------------------------
// offsetEntity — parallel/concentric copy. `side` picks the direction.
// Returns null for kinds with no meaningful parallel curve.
// ---------------------------------------------------------------------------
export function offsetEntity(e: CadEntity, distM: number, side: Vec2): CadEntity | null {
  switch (e.kind) {
    case 'line': {
      const nrm = pickNormal(e.a, e.b, side)
      const off = mul(nrm, distM)
      return { ...e, a: add(e.a, off), b: add(e.b, off) }
    }
    case 'polyline':
      return offsetPolyline(e, distM, side)
    case 'circle': {
      const r = offsetRadius(e.r, e.c, distM, side)
      return r == null ? null : { ...e, r }
    }
    case 'arc': {
      const r = offsetRadius(e.r, e.c, distM, side)
      return r == null ? null : { ...e, r }
    }
    case 'rect': {
      // concentric: side inside → shrink, outside → grow
      const sign = pointInBox(side, e) ? -1 : 1
      const w = e.w + 2 * distM * sign
      const h = e.h + 2 * distM * sign
      return w <= 0 || h <= 0 ? null : { ...e, w, h }
    }
    case 'ellipse': {
      const sign = pointInEllipse(side, e) ? -1 : 1
      const rx = e.rx + distM * sign
      const ry = e.ry + distM * sign
      return rx <= 0 || ry <= 0 ? null : { ...e, rx, ry }
    }
    // point-anchored symbols/annotations have no parallel curve:
    case 'text':
    case 'dimension':
    case 'door':
    case 'window':
    case 'column':
      return null
  }
}

/** unit normal of a→b pointing toward `side`. */
function pickNormal(a: Vec2, b: Vec2, side: Vec2): Vec2 {
  const n = leftNormal(a, b)
  const mid = mul(add(a, b), 0.5)
  return dot(sub(side, mid), n) >= 0 ? n : mul(n, -1)
}

/** circle/arc: shrink if `side` is inside, grow if outside; null if it collapses. */
function offsetRadius(r: number, c: Vec2, distM: number, side: Vec2): number | null {
  const nr = dist(side, c) < r ? r - distM : r + distM
  return nr <= 1e-6 ? null : nr
}

function pointInBox(p: Vec2, e: RectEnt): boolean {
  const local = rot(p, v(e.x, e.y), -e.rotation)
  return Math.abs(local.x - e.x) <= e.w / 2 && Math.abs(local.y - e.y) <= e.h / 2
}
function pointInEllipse(p: Vec2, e: EllipseEnt): boolean {
  const local = rot(p, e.c, -e.rotation)
  return Math.hypot((local.x - e.c.x) / e.rx, (local.y - e.c.y) / e.ry) <= 1
}

/** offset each polyline segment to the same hand, re-joining at mitred vertices. */
function offsetPolyline(e: PolylineEnt, distM: number, side: Vec2): PolylineEnt | null {
  const pts = e.closed ? [...e.pts, e.pts[0]] : e.pts
  if (pts.length < 2) return null
  // choose hand from the segment nearest `side`, keep it uniform
  let best = 0
  let bestD = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = distToSeg(side, pts[i], pts[i + 1])
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  const handNormal = pickNormal(pts[best], pts[best + 1], side)
  // sign of the left normal for that reference segment defines the hand
  const refLeft = leftNormal(pts[best], pts[best + 1])
  const handSign = dot(handNormal, refLeft) >= 0 ? 1 : -1

  // build offset segments (as point+dir lines)
  const segs = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const n = mul(leftNormal(pts[i], pts[i + 1]), handSign * distM)
    const p0 = add(pts[i], n)
    const p1 = add(pts[i + 1], n)
    segs.push({ p0, p1, dir: sub(p1, p0) })
  }
  const out: Vec2[] = []
  const closed = e.closed
  const nseg = segs.length
  for (let i = 0; i < nseg; i++) {
    const cur = segs[i]
    // start vertex of this segment
    if (i === 0 && !closed) {
      out.push(cur.p0)
    } else {
      const prev = segs[(i - 1 + nseg) % nseg]
      const x = lineLineIntersect(prev.p0, prev.dir, cur.p0, cur.dir)
      out.push(x ?? cur.p0)
    }
  }
  if (!closed) out.push(segs[nseg - 1].p1)
  return { ...e, pts: out }
}

// ---------------------------------------------------------------------------
// entityGrips / applyGrip — control-point handles.
//   line       [a, b]
//   polyline   [...vertices]
//   rect       [c0,c1,c2,c3] corners (resize; opposite corner pinned)
//   circle     [E, N, W, S] radius handles
//   arc        [startPt, endPt] endpoint drag (angle + radius follow cursor)
//   ellipse    [rxHandle, ryHandle] axis handles
//   dimension  [a, b] measured points
//   text/door/window/column  [at] anchor
// ---------------------------------------------------------------------------
export function entityGrips(e: CadEntity): Vec2[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b]
    case 'polyline':
      return e.pts.map((p) => v(p.x, p.y))
    case 'rect':
      return rectCorners(e)
    case 'circle':
      return [
        v(e.c.x + e.r, e.c.y),
        v(e.c.x, e.c.y + e.r),
        v(e.c.x - e.r, e.c.y),
        v(e.c.x, e.c.y - e.r),
      ]
    case 'arc':
      return [
        v(e.c.x + e.r * Math.cos(e.start), e.c.y + e.r * Math.sin(e.start)),
        v(e.c.x + e.r * Math.cos(e.end), e.c.y + e.r * Math.sin(e.end)),
      ]
    case 'ellipse': {
      const u = v(Math.cos(e.rotation), Math.sin(e.rotation))
      const w = v(-Math.sin(e.rotation), Math.cos(e.rotation))
      return [add(e.c, mul(u, e.rx)), add(e.c, mul(w, e.ry))]
    }
    case 'dimension':
      return [e.a, e.b]
    case 'text':
    case 'door':
    case 'window':
    case 'column':
      return [e.at]
  }
}

function rectCorners(e: RectEnt): Vec2[] {
  const c = v(e.x, e.y)
  const hw = e.w / 2
  const hh = e.h / 2
  return [v(-hw, -hh), v(hw, -hh), v(hw, hh), v(-hw, hh)].map((p) =>
    rot(v(c.x + p.x, c.y + p.y), c, e.rotation),
  )
}

export function applyGrip(e: CadEntity, gripIndex: number, world: Vec2): CadEntity {
  switch (e.kind) {
    case 'line':
      return gripIndex === 0 ? { ...e, a: v(world.x, world.y) } : { ...e, b: v(world.x, world.y) }
    case 'polyline': {
      const pts = e.pts.map((p) => v(p.x, p.y))
      if (gripIndex >= 0 && gripIndex < pts.length) pts[gripIndex] = v(world.x, world.y)
      return { ...e, pts }
    }
    case 'rect': {
      // pin the opposite corner; new box spans it → cursor in the rect's rotated frame
      const corners = rectCorners(e)
      const opp = corners[(gripIndex + 2) % 4]
      const c = mul(add(opp, world), 0.5) // center = midpoint of the two opposite corners
      const u = v(Math.cos(e.rotation), Math.sin(e.rotation))
      const w = v(-Math.sin(e.rotation), Math.cos(e.rotation))
      const d = sub(world, opp)
      return { ...e, x: c.x, y: c.y, w: Math.abs(dot(d, u)), h: Math.abs(dot(d, w)) }
    }
    case 'circle':
      return { ...e, r: Math.max(1e-4, dist(world, e.c)) }
    case 'arc': {
      const r = Math.max(1e-4, dist(world, e.c))
      const ang = lineAngle(e.c, world)
      return gripIndex === 0 ? { ...e, r, start: ang } : { ...e, r, end: ang }
    }
    case 'ellipse': {
      const u = v(Math.cos(e.rotation), Math.sin(e.rotation))
      const w = v(-Math.sin(e.rotation), Math.cos(e.rotation))
      const d = sub(world, e.c)
      return gripIndex === 0
        ? { ...e, rx: Math.max(1e-4, Math.abs(dot(d, u))) }
        : { ...e, ry: Math.max(1e-4, Math.abs(dot(d, w))) }
    }
    case 'dimension':
      return gripIndex === 0 ? { ...e, a: v(world.x, world.y) } : { ...e, b: v(world.x, world.y) }
    case 'text':
    case 'door':
    case 'window':
    case 'column':
      return { ...e, at: v(world.x, world.y) }
  }
}

// ---------------------------------------------------------------------------
// deleteSelected — remove the current selection (single undo).
// ---------------------------------------------------------------------------
export function deleteSelected(store: CadStore): void {
  if (selection.ids.size === 0) return
  store.snapshot()
  store.remove([...selection.ids])
  selection.ids.clear()
  store.onChange?.()
}

// ---------------------------------------------------------------------------
// bounding boxes (for window/crossing box selection)
// ---------------------------------------------------------------------------
interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}
function boundsOf(e: CadEntity): Bounds {
  const pts: Vec2[] = []
  switch (e.kind) {
    case 'line':
      pts.push(e.a, e.b)
      break
    case 'polyline':
      pts.push(...e.pts)
      break
    case 'rect':
      pts.push(...rectCorners(e))
      break
    case 'circle':
    case 'arc':
      pts.push(v(e.c.x - e.r, e.c.y - e.r), v(e.c.x + e.r, e.c.y + e.r))
      break
    case 'ellipse': {
      const rr = Math.max(e.rx, e.ry)
      pts.push(v(e.c.x - rr, e.c.y - rr), v(e.c.x + rr, e.c.y + rr))
      break
    }
    case 'dimension':
      pts.push(e.a, e.b)
      break
    case 'text':
      pts.push(v(e.at.x - e.h, e.at.y - e.h), v(e.at.x + e.h, e.at.y + e.h))
      break
    case 'door':
    case 'window': {
      const r = e.width / 2
      pts.push(v(e.at.x - r, e.at.y - r), v(e.at.x + r, e.at.y + r))
      break
    }
    case 'column': {
      const r = Math.max(e.w, e.h) / 2
      pts.push(v(e.at.x - r, e.at.y - r), v(e.at.x + r, e.at.y + r))
      break
    }
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}
function boundsInside(b: Bounds, box: Bounds): boolean {
  return b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY
}
function boundsIntersect(b: Bounds, box: Bounds): boolean {
  return !(b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY)
}

// ---------------------------------------------------------------------------
// ghost rendering (dashed preview of a pending transform / box select)
// ---------------------------------------------------------------------------
type ToScreen = (w: Vec2) => { x: number; y: number }

/** sample a curve into world points then map to screen (avoids canvas angle-flip). */
function sampleArc(c: Vec2, r: number, start: number, end: number, n = 48): Vec2[] {
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  let sweep = norm(end - start)
  if (sweep < 1e-6) sweep = 2 * Math.PI
  const out: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    const a = start + (sweep * i) / n
    out.push(v(c.x + r * Math.cos(a), c.y + r * Math.sin(a)))
  }
  return out
}

function strokePath(g: CanvasRenderingContext2D, pts: Vec2[], toS: ToScreen, close: boolean) {
  if (pts.length === 0) return
  g.beginPath()
  const s0 = toS(pts[0])
  g.moveTo(s0.x, s0.y)
  for (let i = 1; i < pts.length; i++) {
    const s = toS(pts[i])
    g.lineTo(s.x, s.y)
  }
  if (close) g.closePath()
  g.stroke()
}

function ghostEntity(g: CanvasRenderingContext2D, e: CadEntity, toS: ToScreen) {
  switch (e.kind) {
    case 'line':
      strokePath(g, [e.a, e.b], toS, false)
      return
    case 'polyline':
      strokePath(g, e.pts, toS, e.closed)
      return
    case 'rect':
      strokePath(g, rectCorners(e), toS, true)
      return
    case 'circle':
      strokePath(g, sampleArc(e.c, e.r, 0, 2 * Math.PI), toS, true)
      return
    case 'arc':
      strokePath(g, sampleArc(e.c, e.r, e.start, e.end), toS, false)
      return
    case 'ellipse': {
      const co = Math.cos(e.rotation)
      const si = Math.sin(e.rotation)
      const pts: Vec2[] = []
      for (let i = 0; i <= 48; i++) {
        const t = (2 * Math.PI * i) / 48
        const px = e.rx * Math.cos(t)
        const py = e.ry * Math.sin(t)
        pts.push(v(e.c.x + px * co - py * si, e.c.y + px * si + py * co))
      }
      strokePath(g, pts, toS, true)
      return
    }
    case 'dimension': {
      const n = leftNormal(e.a, e.b)
      const oa = add(e.a, mul(n, e.offset))
      const ob = add(e.b, mul(n, e.offset))
      strokePath(g, [e.a, oa], toS, false)
      strokePath(g, [e.b, ob], toS, false)
      strokePath(g, [oa, ob], toS, false)
      return
    }
    case 'text': {
      const w = Math.max(0.5, e.text.length * e.h * 0.6)
      const box = [v(0, 0), v(w, 0), v(w, e.h), v(0, e.h)].map((p) =>
        add(e.at, v(
          p.x * Math.cos(e.rotation) - p.y * Math.sin(e.rotation),
          p.x * Math.sin(e.rotation) + p.y * Math.cos(e.rotation),
        )),
      )
      strokePath(g, box, toS, true)
      return
    }
    case 'door': {
      const dir = v(Math.cos(e.angle), Math.sin(e.angle))
      const leafEnd = add(e.at, mul(dir, e.width))
      strokePath(g, [e.at, leafEnd], toS, false)
      const swingSign = (e.hinge === 'left' ? 1 : -1) * (e.flip ? -1 : 1)
      strokePath(g, sampleArc(e.at, e.width, e.angle, e.angle + (swingSign * Math.PI) / 2, 16), toS, false)
      return
    }
    case 'window': {
      const dir = v(Math.cos(e.angle), Math.sin(e.angle))
      const nrm = v(-Math.sin(e.angle), Math.cos(e.angle))
      const hw = e.width / 2
      const ht = e.thickness / 2
      const box = [
        add(add(e.at, mul(dir, -hw)), mul(nrm, -ht)),
        add(add(e.at, mul(dir, hw)), mul(nrm, -ht)),
        add(add(e.at, mul(dir, hw)), mul(nrm, ht)),
        add(add(e.at, mul(dir, -hw)), mul(nrm, ht)),
      ]
      strokePath(g, box, toS, true)
      return
    }
    case 'column': {
      if (e.shape === 'round') {
        strokePath(g, sampleArc(e.at, Math.max(e.w, e.h) / 2, 0, 2 * Math.PI), toS, true)
      } else {
        strokePath(g, rectCorners({ ...e, kind: 'rect', x: e.at.x, y: e.at.y } as RectEnt), toS, true)
      }
      return
    }
  }
}

function ghostList(g: CanvasRenderingContext2D, ents: CadEntity[], toS: ToScreen) {
  g.save()
  g.setLineDash(GHOST_DASH)
  g.strokeStyle = ACCENT
  g.lineWidth = 1.25
  for (const e of ents) ghostEntity(g, e, toS)
  g.restore()
}

// ---------------------------------------------------------------------------
// tool hint formatting
// ---------------------------------------------------------------------------
const fmtLen = (m: number) => `${m.toFixed(2)} m`
const fmtDeg = (rad: number) => `${(((rad * 180) / Math.PI) % 360).toFixed(1)}°`

// ---------------------------------------------------------------------------
// selection resolution for modify tools
// ---------------------------------------------------------------------------
type Orig = { id: number; ent: CadEntity }
function captureOriginals(store: CadStore, ids: number[]): Orig[] {
  const out: Orig[] = []
  for (const id of ids) {
    const e = store.get(id)
    if (e) out.push({ id, ent: cloneEnt(e) })
  }
  return out
}

// ===========================================================================
// select — click pick (topmost, Shift adds) + window/crossing box select
// ===========================================================================
function makeSelect(): CadTool {
  let down: Vec2 | null = null
  let downScreen: { x: number; y: number } | null = null
  let cur: Vec2 | null = null
  let boxing = false
  let shift = false

  const reset = () => {
    down = null
    downScreen = null
    cur = null
    boxing = false
  }

  return {
    id: 'select',
    onDown(world, _snap, ctx, ev) {
      down = v(world.x, world.y)
      cur = v(world.x, world.y)
      downScreen = ctx.toScreen(world)
      boxing = false
      shift = ev.shiftKey
    },
    onMove(world, _snap, ctx) {
      if (!down || !downScreen) return
      cur = v(world.x, world.y)
      const s = ctx.toScreen(world)
      if (Math.hypot(s.x - downScreen.x, s.y - downScreen.y) > BOX_THRESH_PX) boxing = true
      ctx.requestRender()
    },
    onUp(world, _snap, ctx) {
      if (!down) return
      if (boxing && cur) {
        const box: Bounds = {
          minX: Math.min(down.x, cur.x),
          maxX: Math.max(down.x, cur.x),
          minY: Math.min(down.y, cur.y),
          maxY: Math.max(down.y, cur.y),
        }
        const crossing = cur.x < down.x // right→left = crossing (touch), else window (enclose)
        if (!shift) selection.ids.clear()
        for (const e of ctx.store.entities) {
          const b = boundsOf(e)
          if (crossing ? boundsIntersect(b, box) : boundsInside(b, box)) selection.ids.add(e.id)
        }
      } else {
        // click pick: topmost entity under the cursor
        const tol = SELECT_TOL_PX / ctx.pxPerM
        let hitId: number | null = null
        for (let i = ctx.store.entities.length - 1; i >= 0; i--) {
          const e = ctx.store.entities[i]
          if (entityHitTest(e, world, tol)) {
            hitId = e.id
            break
          }
        }
        if (hitId != null) {
          if (shift) {
            if (selection.ids.has(hitId)) selection.ids.delete(hitId)
            else selection.ids.add(hitId)
          } else {
            selection.ids.clear()
            selection.ids.add(hitId)
          }
        } else if (!shift) {
          selection.ids.clear()
        }
      }
      reset()
      ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        selection.ids.clear()
        reset()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!boxing || !down || !cur) return
      const a = ctx.toScreen(down)
      const b = ctx.toScreen(cur)
      const crossing = cur.x < down.x
      g.save()
      g.strokeStyle = ACCENT
      g.lineWidth = 1
      g.setLineDash(crossing ? GHOST_DASH : [])
      g.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      g.restore()
    },
    hint() {
      if (boxing && down && cur) return cur.x < down.x ? 'crossing select' : 'window select'
      return selection.ids.size ? `${selection.ids.size} selected` : 'select'
    },
    cancel() {
      reset()
    },
  }
}

// ===========================================================================
// shared modify-tool scaffolding
// ===========================================================================
type Phase = 0 | 1 | 2

/**
 * Two-point transform tools (move/copy/rotate/mirror): pick a base, then a second
 * point that defines the transform. `apply` mutates the store; `ghost` builds the
 * preview entity from an original + the live cursor.
 */
function makeTwoPoint(
  id: string,
  opts: {
    ghost: (orig: CadEntity, base: Vec2, cur: Vec2) => CadEntity | null
    apply: (store: CadStore, orig: CadEntity, base: Vec2, dest: Vec2) => void
    /** copy-style tools keep `base` after applying (place many); else reset. */
    repeat?: boolean
    hint: (base: Vec2 | null, cur: Vec2 | null) => string
  },
): CadTool {
  const ids = [...selection.ids] // captured on activation
  let base: Vec2 | null = null
  let cur: Vec2 | null = null
  let origs: Orig[] = []

  const reset = () => {
    base = null
    cur = null
    origs = []
  }

  return {
    id,
    onDown(world, _snap, ctx) {
      if (ids.length === 0) return
      if (!base) {
        base = v(world.x, world.y)
        cur = v(world.x, world.y)
        origs = captureOriginals(ctx.store, ids)
        return
      }
      const dest = v(world.x, world.y)
      ctx.store.snapshot()
      for (const o of origs) opts.apply(ctx.store, o.ent, base, dest)
      if (opts.repeat) {
        // keep base; refresh nothing (copy leaves originals in place)
        cur = v(world.x, world.y)
      } else {
        reset()
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      if (!base) return
      cur = v(world.x, world.y)
      ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        reset()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!base || !cur) return
      const ghosts: CadEntity[] = []
      for (const o of origs) {
        const gg = opts.ghost(o.ent, base, cur)
        if (gg) ghosts.push(gg)
      }
      ghostList(g, ghosts, ctx.toScreen)
    },
    hint() {
      return opts.hint(base, cur)
    },
    cancel() {
      reset()
    },
  }
}

function applyUpdate(store: CadStore, e: CadEntity): void {
  store.update(e.id, e)
}
function applyAddClone(store: CadStore, e: CadEntity): void {
  const { id: _drop, ...rest } = e
  store.add(rest as Omit<CadEntity, 'id'>, true)
}

// ---- move --------------------------------------------------------------
function makeMove(): CadTool {
  return makeTwoPoint('move', {
    ghost: (o, base, cur) => translateEntity(o, cur.x - base.x, cur.y - base.y),
    apply: (store, o, base, dest) =>
      applyUpdate(store, translateEntity(o, dest.x - base.x, dest.y - base.y)),
    hint: (base, cur) => {
      if (!base || !cur) return 'move: pick base point'
      const d = sub(cur, base)
      return `${fmtLen(len(d))}  ${fmtDeg(Math.atan2(d.y, d.x))}`
    },
  })
}

// ---- copy (repeatable) -------------------------------------------------
function makeCopy(): CadTool {
  return makeTwoPoint('copy', {
    repeat: true,
    ghost: (o, base, cur) => translateEntity(o, cur.x - base.x, cur.y - base.y),
    apply: (store, o, base, dest) =>
      applyAddClone(store, translateEntity(o, dest.x - base.x, dest.y - base.y)),
    hint: (base, cur) => {
      if (!base || !cur) return 'copy: pick base point'
      const d = sub(cur, base)
      return `${fmtLen(len(d))}  ${fmtDeg(Math.atan2(d.y, d.x))}`
    },
  })
}

// ---- rotate (base → angle; angle measured from +X) ---------------------
function makeRotate(): CadTool {
  return makeTwoPoint('rotate', {
    ghost: (o, base, cur) => rotateEntity(o, base, lineAngle(base, cur)),
    apply: (store, o, base, dest) => applyUpdate(store, rotateEntity(o, base, lineAngle(base, dest))),
    hint: (base, cur) => {
      if (!base) return 'rotate: pick base point'
      if (!cur) return 'rotate: pick angle'
      return fmtDeg(lineAngle(base, cur))
    },
  })
}

// ---- mirror (two points define the line; keeps originals, adds mirrored) --
function makeMirror(): CadTool {
  return makeTwoPoint('mirror', {
    ghost: (o, a, b) => mirrorEntity(o, a, b),
    apply: (store, o, a, b) => applyAddClone(store, mirrorEntity(o, a, b)),
    hint: (base, cur) => {
      if (!base) return 'mirror: first point of line'
      if (!cur) return 'mirror: second point of line'
      return `axis ${fmtDeg(lineAngle(base, cur))}`
    },
  })
}

// ===========================================================================
// scale — three points: base, reference length, new length → factor = ratio
// ===========================================================================
function makeScale(): CadTool {
  const ids = [...selection.ids]
  let phase: Phase = 0
  let base: Vec2 | null = null
  let ref: Vec2 | null = null
  let refDist = 0
  let cur: Vec2 | null = null
  let origs: Orig[] = []

  const reset = () => {
    phase = 0
    base = null
    ref = null
    refDist = 0
    cur = null
    origs = []
  }
  const factor = () => (cur && base && refDist > 1e-6 ? dist(cur, base) / refDist : 1)

  return {
    id: 'scale',
    onDown(world, _snap, ctx) {
      if (ids.length === 0) return
      if (phase === 0) {
        base = v(world.x, world.y)
        cur = v(world.x, world.y)
        origs = captureOriginals(ctx.store, ids)
        phase = 1
        return
      }
      if (phase === 1) {
        const d = dist(world, base!)
        if (d < 1e-6) return // need a non-zero reference length
        ref = v(world.x, world.y)
        refDist = d
        phase = 2
        return
      }
      const f = dist(world, base!) / refDist
      ctx.store.snapshot()
      for (const o of origs) applyUpdate(ctx.store, scaleEntity(o.ent, base!, f))
      reset()
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      if (phase === 0) return
      cur = v(world.x, world.y)
      ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        reset()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (phase === 1 && base && cur) {
        // rubber-band the reference length
        g.save()
        g.strokeStyle = ACCENT
        g.setLineDash(GHOST_DASH)
        const a = ctx.toScreen(base)
        const b = ctx.toScreen(cur)
        g.beginPath()
        g.moveTo(a.x, a.y)
        g.lineTo(b.x, b.y)
        g.stroke()
        g.restore()
        return
      }
      if (phase === 2 && base) {
        const f = factor()
        ghostList(
          g,
          origs.map((o) => scaleEntity(o.ent, base!, f)),
          ctx.toScreen,
        )
      }
    },
    hint() {
      if (phase === 0) return 'scale: pick base point'
      if (phase === 1) return 'scale: pick reference length'
      return `×${factor().toFixed(3)}`
    },
    cancel() {
      reset()
    },
  }
}

// ===========================================================================
// tool registry
// ===========================================================================
export const EDIT_TOOLS: Record<string, () => CadTool> = {
  select: makeSelect,
  move: makeMove,
  copy: makeCopy,
  rotate: makeRotate,
  scale: makeScale,
  mirror: makeMirror,
}

// Re-export the entity kinds these helpers narrow over, so callers importing from
// editTools don't need a second import for the common ones.
export type {
  LineEnt,
  PolylineEnt,
  RectEnt,
  CircleEnt,
  ArcEnt,
  EllipseEnt,
  DimensionEnt,
  TextEnt,
  DoorEnt,
  WindowEnt,
  ColumnEnt,
}
