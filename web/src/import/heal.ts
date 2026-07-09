// Wall healing — design: docs/design/workflow.md §3.3 (Slice 4).
//
// Bridges near-miss gaps in the wall/glazing linework so enclosed rooms and the
// floor plate actually CLOSE — the vector-level, user-visible companion to the
// raster plate path's morphological gap-closing (gridContour's dilate/erode,
// testfit.ts). Healed linework improves the exact `loop` trace, interior-wall
// closure, and keepout detection all at once, and (unlike the raster close) the
// user can see and trust it.
//
// The heuristic is deliberately CONSERVATIVE — it only bridges genuine
// near-misses and never fuses distinct walls or seals a doorway:
//
//   • Endpoint↔endpoint. Two FREE wall ends (degree-1 nodes) within `gapM` whose
//     incident walls are near-COLLINEAR (a partition split with a hairline break,
//     directions anti-parallel ≈ 180°) OR near-PERPENDICULAR (an L-corner that
//     didn't quite meet, ≈ 90°). Any other relative angle is left alone.
//   • Endpoint→segment (T-junction). A free end within `gapM` of the interior of
//     another wall, meeting it near-perpendicular — a partition that stops just
//     short of the corridor wall. Extend the end to its foot on that wall.
//
//   • DOORWAY GUARD. No gap ≥ 0.8 m (a door leaf) is ever bridged, whatever
//     `gapM` is set to — so real openings stay open.
//   • Endpoints are snapped on the SAME 0.05 m grid the loop tracer uses
//     (testfit.ts SNAP_TOL), so ends already touching are one node (not free)
//     and never spuriously "healed".
//
// Healing is ADDITIVE and non-destructive: existing entities are untouched; each
// bridge is appended as a new zero-history `wall` polyline on a `HEAL` layer.
// Returns the SAME drawing object (referential identity) when nothing is bridged,
// so callers can cheaply skip recompute.

import type { Drawing, DrawEntity } from './types'
import { collectWallSegments, type Pt, type Segment } from './testfit'

export interface HealOptions {
  /** Largest gap to bridge, meters. Clamped below the doorway guard. Default 0.25. */
  gapM?: number
}

// ---- tunables --------------------------------------------------------------
const SNAP = 0.05 // m — endpoint snap grid (matches testfit.ts SNAP_TOL)
const DEFAULT_GAP = 0.25 // m — a hairline partition break; below a door leaf
const DOORWAY_MIN = 0.8 // m — a gap this wide (or wider) is a doorway: never bridge
const ANGLE_TOL_DEG = 15 // ° — collinear (≈180°) / perpendicular (≈90°) tolerance
const MAX_BRIDGES = 800 // sanity cap so a pathological drawing can't fuse everywhere

// ---- vector helpers --------------------------------------------------------
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]]

/** Angle between two vectors, degrees in [0, 180]. */
function angleDeg(u: Pt, v: Pt): number {
  const du = Math.hypot(u[0], u[1])
  const dv = Math.hypot(v[0], v[1])
  if (du < 1e-9 || dv < 1e-9) return 0
  let c = (u[0] * v[0] + u[1] * v[1]) / (du * dv)
  c = Math.max(-1, Math.min(1, c))
  return (Math.acos(c) * 180) / Math.PI
}

/** Foot of the perpendicular from p onto segment AB, only when it lands on the
 *  segment INTERIOR (≥ SNAP from either end — an endpoint hit is the endpoint↔
 *  endpoint case, handled elsewhere). Null otherwise. */
function footOnSegment(p: Pt, a: Pt, b: Pt): Pt | null {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const len2 = abx * abx + aby * aby
  if (len2 < 1e-9) return null
  const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2
  if (t <= 0 || t >= 1) return null
  const q: Pt = [a[0] + t * abx, a[1] + t * aby]
  if (Math.hypot(q[0] - a[0], q[1] - a[1]) < SNAP) return null
  if (Math.hypot(q[0] - b[0], q[1] - b[1]) < SNAP) return null
  return q
}

/**
 * Compute the bridging segments that close near-miss gaps in `segs` (the pure
 * core — operates on wall/glazing segments, returns new segments to add).
 */
function healBridges(segs: Segment[], gap: number): Segment[] {
  // Snap endpoints → node ids (first-seen coordinate represents the cell) —
  // identical scheme to traceLoops so "already touching" ends collapse to one
  // node and are never treated as free.
  const nodes: Pt[] = []
  const keyToId = new Map<string, number>()
  const idOf = (p: Pt): number => {
    const k = `${Math.round(p[0] / SNAP)},${Math.round(p[1] / SNAP)}`
    let id = keyToId.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push(p)
      keyToId.set(k, id)
    }
    return id
  }
  // Per node: the far-node ids of its incident segments (length 1 ⇒ free end).
  const incident: number[][] = []
  const ensure = (id: number) => {
    while (incident.length <= id) incident.push([])
  }
  const segNodes: Array<[number, number]> = []
  for (const [a, b] of segs) {
    const u = idOf(a)
    const v = idOf(b)
    if (u === v) continue
    ensure(Math.max(u, v))
    incident[u].push(v)
    incident[v].push(u)
    segNodes.push([u, v])
  }

  const freeEnds: number[] = []
  for (let i = 0; i < incident.length; i++) if (incident[i].length === 1) freeEnds.push(i)

  const bridges: Segment[] = []
  const consumed = new Set<number>()
  // Outward wall direction at a free end = free-node − its one neighbor.
  const outDir = (i: number): Pt => sub(nodes[i], nodes[incident[i][0]])

  // Pass 1 — endpoint↔endpoint. Rank every eligible pair by gap and bridge the
  // closest first so each free end pairs with its true partner (greedy, both
  // ends consumed on use).
  const pairs: Array<{ i: number; j: number; d: number }> = []
  for (let a = 0; a < freeEnds.length; a++) {
    for (let b = a + 1; b < freeEnds.length; b++) {
      const i = freeEnds[a]
      const j = freeEnds[b]
      const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1])
      if (d < SNAP || d > gap) continue
      const ang = angleDeg(outDir(i), outDir(j))
      const collinear = ang > 180 - ANGLE_TOL_DEG // anti-parallel walls = same line
      const corner = Math.abs(ang - 90) < ANGLE_TOL_DEG // near-perpendicular L
      if (!collinear && !corner) continue
      pairs.push({ i, j, d })
    }
  }
  pairs.sort((p, q) => p.d - q.d)
  for (const { i, j } of pairs) {
    if (consumed.has(i) || consumed.has(j)) continue
    bridges.push([nodes[i], nodes[j]])
    consumed.add(i)
    consumed.add(j)
    if (bridges.length >= MAX_BRIDGES) return bridges
  }

  // Pass 2 — endpoint→segment (T-junction) for the free ends still unpaired.
  for (const i of freeEnds) {
    if (consumed.has(i)) continue
    const p = nodes[i]
    const di = outDir(i)
    const far = incident[i][0]
    let best: { q: Pt; d: number } | null = null
    for (const [u, v] of segNodes) {
      if (u === i || v === i) continue // its own segment
      if (u === far || v === far) continue // shares the incident node (an L, not a T)
      const q = footOnSegment(p, nodes[u], nodes[v])
      if (!q) continue
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (d < SNAP || d > gap) continue
      // A partition meets a corridor wall near-perpendicular; anything else is
      // coincidence, not a T to close.
      if (Math.abs(angleDeg(di, sub(nodes[v], nodes[u])) - 90) > ANGLE_TOL_DEG) continue
      if (!best || d < best.d) best = { q, d }
    }
    if (best) {
      bridges.push([p, best.q])
      consumed.add(i)
      if (bridges.length >= MAX_BRIDGES) return bridges
    }
  }

  return bridges
}

/**
 * Heal near-miss gaps in a drawing's wall/glazing linework. Returns a NEW
 * drawing with bridge segments appended (as `HEAL`-layer `wall` polylines), or
 * the SAME drawing (identity) when there is nothing to bridge.
 */
export function healWalls(drawing: Drawing, opts?: HealOptions): Drawing {
  // Clamp below the doorway guard: however wide the caller asks, a door-leaf gap
  // is never bridged.
  const gap = Math.min(opts?.gapM ?? DEFAULT_GAP, DOORWAY_MIN - 1e-6)
  if (gap <= SNAP) return drawing
  const segs = collectWallSegments(drawing)
  if (segs.length === 0) return drawing
  const bridges = healBridges(segs, gap)
  if (bridges.length === 0) return drawing
  const bridgeEntities: DrawEntity[] = bridges.map(([a, b]) => ({
    kind: 'polyline',
    layer: 'HEAL',
    category: 'wall',
    pts: [a, b],
  }))
  return { ...drawing, entities: [...drawing.entities, ...bridgeEntities] }
}
