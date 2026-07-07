// The object-snap (OSNAP) engine. `snap(cursor, ctx)` gathers candidate snap
// points from CAD entities, editor walls, placed components and the grid, then
// returns the best one within a pixel-derived tolerance.
//
// Coordinates are METERS in EditorCanvas world space (see cad/model.ts). Angles
// are radians. Higher-priority snap types win when several fall within tolerance;
// among a tie the nearest to the cursor is chosen.

import type {
  Vec2,
  CadEntity,
  SnapType,
  SnapResult,
  SnapContext,
} from './model'

// Higher wins. Mirrors the doc'd order:
// endpoint > intersection > midpoint > center > quadrant > perpendicular >
// nearest > grid > none.
const PRIORITY: Record<SnapType, number> = {
  endpoint: 8,
  intersection: 7,
  midpoint: 6,
  center: 5,
  quadrant: 4,
  perpendicular: 3,
  nearest: 2,
  grid: 1,
  extension: 1, // not produced here; keep it below real osnaps
  none: 0,
}

interface Cand {
  point: Vec2
  type: SnapType
  ref?: number
}

// ---- small vector helpers ------------------------------------------------
const dist2 = (a: Vec2, b: Vec2) => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** Foot of the perpendicular from p onto the infinite line a→b, with its param t. */
function foot(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; t: number; len2: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return { pt: { ...a }, t: 0, len2 }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  return { pt: { x: a.x + t * dx, y: a.y + t * dy }, t, len2 }
}

/** Nearest point on segment a→b to p (t clamped to [0,1]). */
function nearestOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const f = foot(p, a, b)
  const t = Math.max(0, Math.min(1, f.t))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Squared distance from p to segment a→b. */
const distSegSq = (p: Vec2, a: Vec2, b: Vec2) => dist2(p, nearestOnSeg(p, a, b))

/** Intersection of segments p1→p2 and p3→p4, or null (parallel / no overlap). */
export function segSegIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y }
  const s = { x: p4.x - p3.x, y: p4.y - p3.y }
  const denom = r.x * s.y - r.y * s.x
  if (denom === 0) return null // parallel or collinear
  const qp = { x: p3.x - p1.x, y: p3.y - p1.y }
  const t = (qp.x * s.y - qp.y * s.x) / denom
  const u = (qp.x * r.y - qp.y * r.x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: p1.x + t * r.x, y: p1.y + t * r.y }
}

/** Intersection points of segment p1→p2 with circle (c,r); 0..2 points on the segment. */
export function segCircleIntersect(p1: Vec2, p2: Vec2, c: Vec2, r: number): Vec2[] {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const fx = p1.x - c.x
  const fy = p1.y - c.y
  const a = dx * dx + dy * dy
  if (a === 0) return []
  const b = 2 * (fx * dx + fy * dy)
  const cc = fx * fx + fy * fy - r * r
  const disc = b * b - 4 * a * cc
  if (disc < 0) return []
  const sq = Math.sqrt(disc)
  const out: Vec2[] = []
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t >= 0 && t <= 1) out.push({ x: p1.x + t * dx, y: p1.y + t * dy })
  }
  return out
}

/** Is angle θ within the CCW arc start..end? */
function angleInArc(theta: number, start: number, end: number): boolean {
  const TAU = Math.PI * 2
  const norm = (a: number) => ((a % TAU) + TAU) % TAU
  const range = norm(end - start)
  const delta = norm(theta - start)
  // full circle guard
  return range === 0 ? true : delta <= range + 1e-9
}

/** Corners (rotated), edge midpoints and center of an oriented box. */
function boxPoints(
  cx: number,
  cy: number,
  w: number,
  h: number,
  rot: number,
): { corners: Vec2[]; edgeMids: Vec2[]; center: Vec2 } {
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const hw = w / 2
  const hh = h / 2
  const local = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ]
  const corners = local.map((p) => ({
    x: cx + p.x * cos - p.y * sin,
    y: cy + p.x * sin + p.y * cos,
  }))
  const edgeMids = corners.map((p, i) => mid(p, corners[(i + 1) % 4]))
  return { corners, edgeMids, center: { x: cx, y: cy } }
}

// ---- main ----------------------------------------------------------------
export function snap(cursor: Vec2, ctx: SnapContext): SnapResult {
  const tol = (ctx.tolPx ?? 10) / ctx.pxPerM
  const tol2 = tol * tol
  const on = (t: SnapType) => !ctx.enabled || ctx.enabled.has(t)
  const cands: Cand[] = []
  const push = (point: Vec2, type: SnapType, ref?: number) => {
    if (on(type)) cands.push({ point, type, ref })
  }

  // Segments collected for the perpendicular + intersection passes.
  const segs: { a: Vec2; b: Vec2; ref?: number }[] = []
  const circles: { c: Vec2; r: number; ref?: number }[] = []

  const addSeg = (a: Vec2, b: Vec2, ref?: number) => {
    push(a, 'endpoint', ref)
    push(b, 'endpoint', ref)
    push(mid(a, b), 'midpoint', ref)
    push(nearestOnSeg(cursor, a, b), 'nearest', ref)
    if (ctx.from && on('perpendicular')) {
      const f = foot(ctx.from, a, b)
      if (f.len2 > 0 && f.t >= 0 && f.t <= 1) push(f.pt, 'perpendicular', ref)
    }
    segs.push({ a, b, ref })
  }

  const addCircle = (c: Vec2, r: number, ref?: number, arc?: { s: number; e: number }) => {
    push(c, 'center', ref)
    const quads: [number, number][] = [
      [c.x + r, c.y],
      [c.x, c.y + r],
      [c.x - r, c.y],
      [c.x, c.y - r],
    ]
    const qAng = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
    quads.forEach((q, i) => {
      if (!arc || angleInArc(qAng[i], arc.s, arc.e)) push({ x: q[0], y: q[1] }, 'quadrant', ref)
    })
    // nearest point on the circle to the cursor
    const dx = cursor.x - c.x
    const dy = cursor.y - c.y
    const len = Math.hypot(dx, dy)
    if (len > 1e-9) {
      const near = { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r }
      const ang = Math.atan2(near.y - c.y, near.x - c.x)
      if (!arc || angleInArc(ang, arc.s, arc.e)) push(near, 'nearest', ref)
    }
    if (arc) {
      // arc endpoints are true endpoints
      push({ x: c.x + Math.cos(arc.s) * r, y: c.y + Math.sin(arc.s) * r }, 'endpoint', ref)
      push({ x: c.x + Math.cos(arc.e) * r, y: c.y + Math.sin(arc.e) * r }, 'endpoint', ref)
    }
    circles.push({ c, r, ref })
  }

  // ---- entities ----
  for (const e of ctx.entities) collectEntity(e, addSeg, addCircle, push)

  // ---- walls (thin segments; no ids) ----
  for (const w of ctx.walls) addSeg(w.a, w.b)

  // ---- components (oriented boxes; no ids) ----
  for (const c of ctx.components) {
    const { corners, edgeMids, center } = boxPoints(c.x, c.y, c.w, c.h, c.rotation)
    corners.forEach((p) => push(p, 'endpoint'))
    edgeMids.forEach((p) => push(p, 'midpoint'))
    push(center, 'center')
    // component edges also feed the intersection pass
    corners.forEach((p, i) => segs.push({ a: p, b: corners[(i + 1) % 4] }))
  }

  // ---- intersection pass (capped to segments/circles near the cursor) ----
  if (on('intersection')) {
    const near = tol * 1.5
    const near2 = near * near
    const ns = segs.filter((s) => distSegSq(cursor, s.a, s.b) <= near2)
    const nc = circles.filter((c) => {
      const d = Math.abs(Math.hypot(cursor.x - c.c.x, cursor.y - c.c.y) - c.r)
      return d * d <= near2
    })
    const CAP = 48 // defensive: skip the O(n²) pass if the near set is still huge
    if (ns.length <= CAP) {
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const p = segSegIntersect(ns[i].a, ns[i].b, ns[j].a, ns[j].b)
          if (p) push(p, 'intersection', ns[i].ref ?? ns[j].ref)
        }
        for (const c of nc) {
          for (const p of segCircleIntersect(ns[i].a, ns[i].b, c.c, c.r)) {
            push(p, 'intersection', ns[i].ref ?? c.ref)
          }
        }
      }
    }
  }

  // ---- pick the best in-tolerance candidate by priority, then distance ----
  let best: Cand | null = null
  let bestPr = -1
  let bestD = Infinity
  for (const c of cands) {
    const d = dist2(cursor, c.point)
    if (d > tol2) continue
    const pr = PRIORITY[c.type]
    if (pr > bestPr || (pr === bestPr && d < bestD)) {
      best = c
      bestPr = pr
      bestD = d
    }
  }
  if (best) return { point: best.point, type: best.type, ref: best.ref }

  // ---- grid fallback (always applies when nothing else grabbed) ----
  if (ctx.grid > 0 && on('grid')) {
    return {
      point: {
        x: Math.round(cursor.x / ctx.grid) * ctx.grid,
        y: Math.round(cursor.y / ctx.grid) * ctx.grid,
      },
      type: 'grid',
    }
  }
  return { point: { ...cursor }, type: 'none' }
}

/** Emit candidates for a single entity. */
function collectEntity(
  e: CadEntity,
  addSeg: (a: Vec2, b: Vec2, ref?: number) => void,
  addCircle: (c: Vec2, r: number, ref?: number, arc?: { s: number; e: number }) => void,
  push: (p: Vec2, t: SnapType, ref?: number) => void,
): void {
  switch (e.kind) {
    case 'line':
      addSeg(e.a, e.b, e.id)
      break
    case 'polyline': {
      const n = e.pts.length
      for (let i = 0; i < n - 1; i++) addSeg(e.pts[i], e.pts[i + 1], e.id)
      if (e.closed && n > 2) addSeg(e.pts[n - 1], e.pts[0], e.id)
      break
    }
    case 'rect': {
      const { corners, edgeMids, center } = boxPoints(e.x, e.y, e.w, e.h, e.rotation)
      corners.forEach((p) => push(p, 'endpoint', e.id))
      edgeMids.forEach((p) => push(p, 'midpoint', e.id))
      push(center, 'center', e.id)
      break
    }
    case 'circle':
      addCircle(e.c, e.r, e.id)
      break
    case 'arc':
      addCircle(e.c, e.r, e.id, { s: e.start, e: e.end })
      break
    case 'ellipse':
      // full ellipse osnap is deferred; the center is exact and useful
      push(e.c, 'center', e.id)
      break
    case 'dimension':
      push(e.a, 'endpoint', e.id)
      push(e.b, 'endpoint', e.id)
      break
    case 'text':
      push(e.at, 'endpoint', e.id) // insertion point
      break
    case 'door':
      push(e.at, 'endpoint', e.id) // hinge point
      break
    case 'window':
      push(e.at, 'endpoint', e.id)
      break
    case 'column': {
      const { corners, edgeMids, center } = boxPoints(e.at.x, e.at.y, e.w, e.h, e.rotation)
      corners.forEach((p) => push(p, 'endpoint', e.id))
      edgeMids.forEach((p) => push(p, 'midpoint', e.id))
      push(center, 'center', e.id)
      break
    }
  }
}
