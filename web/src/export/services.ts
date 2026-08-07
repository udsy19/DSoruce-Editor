// MEP / services derivation — turns a finished test-fit (DocState, units = m)
// into deterministic Reflected-Ceiling and Power/Data layouts. Pure geometry:
// no DOM, no Math.random / Date.now, so the same plan always yields the same
// fixtures. Consumed by servicesSheets.ts, which draws them onto A3 sheets that
// mirror the rest of the drawing set (docs/design/drawing-set-generator.md §1.3
// c/d + §2 "RCP / lighting layer + electrical symbol library").
//
// The two layouts are the *services* facet of the same room/zone data every
// other sheet reads — walls for the plate, zones for rooms, components for the
// furniture the outlets serve. Nothing here mutates state.

import type { DocState, DocComponent } from '../types/doc'
import { zoneBBox, zoneCenter } from '../util/zoneGeom'

// ---------------------------------------------------------------------------
// Derivation constants (grounded so the schedules read like a real MEP set)
// ---------------------------------------------------------------------------

/** Finished suspended-ceiling height (m) printed on the RCP. */
export const CEILING_HEIGHT = 2.75

/** Recessed-luminaire grid centres (m). ~2.7 m gives ~300 lux over open plan. */
const LUM_SPACING = 2.7
/** HVAC supply/return diffuser grid centres (m) — one per ~20 m². */
const DIFFUSER_SPACING = 4.8
/** Smoke-detector grid centres (m) — NFPA-72 spot spacing well under the 9.1 m
 *  code ceiling, so coverage is one detector per ~45 m². */
const SMOKE_SPACING = 7.0
/** Fixtures/detectors sit at least this far off a room edge (m). */
const CEIL_INSET = 1.0

/** Corridor-run spacing (m) for fixtures walked around a ring circulation zone. */
const RING_LUM_SPACING = 3.0
const RING_DIFFUSER_SPACING = 6.0
const RING_SMOKE_SPACING = 9.0

/** Workstation categories that each earn a power + data outlet. */
const WORKSTATION_CATS = new Set(['Desk', 'Table'])
/** Desks within this distance (m, centre-to-centre) share a floor box. */
const CLUSTER_RADIUS = 2.4

// ---------------------------------------------------------------------------
// Fixture / point types
// ---------------------------------------------------------------------------

/** RCP fixture families (the RCP glyph legend keys off `type`). */
export type CeilingFixtureType = 'luminaire' | 'exit' | 'diffuser' | 'smoke'
export interface CeilingFixture {
  type: CeilingFixtureType
  x: number // world m
  y: number
  /** Long-axis rotation (rad) for the rectangular troffer glyph. */
  rot?: number
}

/** A ceiling-grid line (the reflected module the fixtures sit on), world m. */
export interface CeilingGridLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Power/data point families (the electrical glyph legend keys off `type`). */
export type PowerPointType = 'power' | 'data' | 'floorbox' | 'switch' | 'db'
export interface PowerPoint {
  type: PowerPointType
  x: number // world m
  y: number
}

/** One priced-out schedule row (code · description · count). */
export interface ServiceScheduleRow {
  code: string
  label: string
  count: number
}

export interface CeilingLayout {
  fixtures: CeilingFixture[]
  grid: CeilingGridLine[]
  schedule: ServiceScheduleRow[]
  ceilingHeight: number
}

export interface PowerLayout {
  points: PowerPoint[]
  schedule: ServiceScheduleRow[]
}

// ---------------------------------------------------------------------------
// Room abstraction — zones when present, else the whole plate as one room
// ---------------------------------------------------------------------------

interface Room {
  cx: number
  cy: number
  hw: number // half-width (outer)
  hh: number // half-height (outer)
  ring?: { ihw: number; ihh: number } // RectRing hole half-extents
  label?: string // zone name (for circuit numbering); absent on the plate fallback
}

function plateBounds(state: DocState): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/** Rooms to service: every zone, or a single plate-sized room as a fallback so a
 *  hand-drawn (zone-less) plan still lights + powers. */
function rooms(state: DocState): Room[] {
  const zones = state.zones ?? []
  if (zones.length > 0) {
    return zones.map((z) => {
      const s = z.shape
      // Rooms are modelled as an AABB with an optional ring hole; a boundary-
      // conforming Poly is serviced by its bounding box (lighting/power grid is
      // laid out over the room's extent, exact outline not needed here).
      const bb = zoneBBox(s)
      const c = zoneCenter(s)
      return {
        cx: c.x,
        cy: c.y,
        hw: (bb.maxX - bb.minX) / 2,
        hh: (bb.maxY - bb.minY) / 2,
        ring: s.kind === 'RectRing' ? { ihw: s.in_w / 2, ihh: s.in_h / 2 } : undefined,
        label: z.label || undefined,
      }
    })
  }
  const b = plateBounds(state)
  if (!b) return []
  const hw = (b.maxX - b.minX) / 2
  const hh = (b.maxY - b.minY) / 2
  return [{ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, hw, hh }]
}

// ---------------------------------------------------------------------------
// Grid + ring point generators (deterministic, centred cells)
// ---------------------------------------------------------------------------

/** Centre points of a regular grid filling `[cx±hw, cy±hh]` inset by `inset`,
 *  with cell size ≈ `spacing`. Fixtures sit at cell centres so the pattern is
 *  symmetric about the room centre. Always ≥1 point. */
function gridPoints(cx: number, cy: number, hw: number, hh: number, spacing: number, inset: number): { x: number; y: number }[] {
  const usableW = Math.max(0, hw * 2 - inset * 2)
  const usableH = Math.max(0, hh * 2 - inset * 2)
  const cols = Math.max(1, Math.round(usableW / spacing) || 1)
  const rows = Math.max(1, Math.round(usableH / spacing) || 1)
  const out: { x: number; y: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x: cx - usableW / 2 + (c + 0.5) * (usableW / cols),
        y: cy - usableH / 2 + (r + 0.5) * (usableH / rows),
      })
    }
  }
  return out
}

/** Points evenly spaced around the centre-line of a ring band (corridor). */
function ringPoints(room: Room, spacing: number): { x: number; y: number }[] {
  const ring = room.ring
  if (!ring) return []
  // Centre-line rectangle: midway between outer and inner edges on each side.
  const chw = (room.hw + ring.ihw) / 2
  const chh = (room.hh + ring.ihh) / 2
  const corners = [
    [room.cx - chw, room.cy - chh],
    [room.cx + chw, room.cy - chh],
    [room.cx + chw, room.cy + chh],
    [room.cx - chw, room.cy + chh],
  ]
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % 4]
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.round(len / spacing))
    for (let s = 0; s < n; s++) {
      const t = s / n
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
    }
  }
  return out
}

/** The recessed-luminaire centres for one room — a tiled grid for a normal
 *  room, or a corridor run for a ring zone. Shared by {@link ceilingLayout}
 *  (glyph placement) and {@link lightingCircuits} (switch-leg routing) so the
 *  two views always agree on where the luminaires are. */
function roomLuminaires(room: Room): { x: number; y: number }[] {
  return room.ring
    ? ringPoints(room, RING_LUM_SPACING)
    : gridPoints(room.cx, room.cy, room.hw, room.hh, LUM_SPACING, CEIL_INSET)
}

/** Grid centre-lines through a room's cells — the reflected ceiling module. */
function roomGrid(room: Room, spacing: number): CeilingGridLine[] {
  if (room.ring) return [] // rings read as corridor runs, not a tiled field
  const usableW = Math.max(0, room.hw * 2 - CEIL_INSET * 2)
  const usableH = Math.max(0, room.hh * 2 - CEIL_INSET * 2)
  const cols = Math.max(1, Math.round(usableW / spacing) || 1)
  const rows = Math.max(1, Math.round(usableH / spacing) || 1)
  const x0 = room.cx - usableW / 2
  const y0 = room.cy - usableH / 2
  const y1 = room.cy + usableH / 2
  const x1 = room.cx + usableW / 2
  const out: CeilingGridLine[] = []
  for (let c = 0; c <= cols; c++) {
    const x = x0 + (c * usableW) / cols
    out.push({ x1: x, y1: y0, x2: x, y2: y1 })
  }
  for (let r = 0; r <= rows; r++) {
    const y = y0 + (r * usableH) / rows
    out.push({ x1: x0, y1: y, x2: x1, y2: y })
  }
  return out
}

// ---------------------------------------------------------------------------
// Ceiling / luminaire layout
// ---------------------------------------------------------------------------

/**
 * Derive the reflected-ceiling layout: recessed luminaires on a per-room grid
 * (~2.7 m centres, inset {@link CEIL_INSET} m from walls), HVAC diffusers and
 * smoke detectors on coarser grids sized to room area, plus an exit / emergency
 * luminaire just inside every door. Ring (perimeter-corridor) zones get their
 * fixtures walked around the corridor centre-line instead of a tiled field.
 * Deterministic — a pure function of the geometry.
 */
export function ceilingLayout(state: DocState): CeilingLayout {
  const fixtures: CeilingFixture[] = []
  const grid: CeilingGridLine[] = []
  const rs = rooms(state)

  for (const room of rs) {
    grid.push(...roomGrid(room, LUM_SPACING))
    for (const p of roomLuminaires(room)) fixtures.push({ type: 'luminaire', x: p.x, y: p.y, rot: 0 })
    if (room.ring) {
      for (const p of ringPoints(room, RING_DIFFUSER_SPACING)) fixtures.push({ type: 'diffuser', x: p.x, y: p.y })
      for (const p of ringPoints(room, RING_SMOKE_SPACING)) fixtures.push({ type: 'smoke', x: p.x, y: p.y })
    } else {
      for (const p of gridPoints(room.cx, room.cy, room.hw, room.hh, DIFFUSER_SPACING, CEIL_INSET + 0.4))
        fixtures.push({ type: 'diffuser', x: p.x, y: p.y })
      for (const p of gridPoints(room.cx, room.cy, room.hw, room.hh, SMOKE_SPACING, CEIL_INSET + 0.6))
        fixtures.push({ type: 'smoke', x: p.x, y: p.y })
    }
  }

  // Exit / emergency luminaire just inside every door, pointing into the plate.
  const b = plateBounds(state)
  const cx = b ? (b.minX + b.maxX) / 2 : 0
  const cy = b ? (b.minY + b.maxY) / 2 : 0
  for (const d of doors(state)) {
    const dx = cx - d.x
    const dy = cy - d.y
    const len = Math.hypot(dx, dy) || 1
    fixtures.push({ type: 'exit', x: d.x + (dx / len) * 0.6, y: d.y + (dy / len) * 0.6 })
  }

  const count = (t: CeilingFixtureType) => fixtures.filter((f) => f.type === t).length
  const schedule: ServiceScheduleRow[] = [
    { code: 'L1', label: 'Recessed LED luminaire 600×600', count: count('luminaire') },
    { code: 'E1', label: 'Exit / emergency luminaire', count: count('exit') },
    { code: 'HV', label: 'HVAC supply / return diffuser', count: count('diffuser') },
    { code: 'SD', label: 'Smoke detector', count: count('smoke') },
  ]
  return { fixtures, grid, schedule, ceilingHeight: CEILING_HEIGHT }
}

// ---------------------------------------------------------------------------
// Power & data layout
// ---------------------------------------------------------------------------

function doors(state: DocState): DocComponent[] {
  return (state.components as DocComponent[])
    .filter((c) => c.category === 'Door')
    .sort((a, b) => a.y - b.y || a.x - b.x)
}

function workstations(state: DocState): DocComponent[] {
  return (state.components as DocComponent[])
    .filter((c) => WORKSTATION_CATS.has(c.category))
    .sort((a, b) => a.y - b.y || a.x - b.x)
}

/** Union-find cluster of desk components within {@link CLUSTER_RADIUS}. */
function deskClusters(desks: DocComponent[]): { x: number; y: number }[] {
  const parent = desks.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < desks.length; i++) {
    for (let j = i + 1; j < desks.length; j++) {
      if (Math.hypot(desks[i].x - desks[j].x, desks[i].y - desks[j].y) <= CLUSTER_RADIUS) {
        parent[find(i)] = find(j)
      }
    }
  }
  const groups = new Map<number, DocComponent[]>()
  desks.forEach((d, i) => {
    const r = find(i)
    const g = groups.get(r) ?? []
    g.push(d)
    groups.set(r, g)
  })
  return [...groups.values()].map((g) => ({
    x: g.reduce((s, d) => s + d.x, 0) / g.length,
    y: g.reduce((s, d) => s + d.y, 0) / g.length,
  }))
}

/**
 * Derive the power & data layout: a power + a data outlet per workstation
 * (Desk / Table), a floor box at the centroid of every desk cluster, a lighting
 * switch beside each door, and one distribution board near the entry (the most
 * peripheral door). Deterministic — a pure function of the components + plate.
 */
export function powerLayout(state: DocState): PowerLayout {
  const points: PowerPoint[] = []
  const ws = workstations(state)

  // Power + data at each workstation, offset to opposite sides of its depth.
  for (const c of ws) {
    const cos = Math.cos(c.rotation)
    const sin = Math.sin(c.rotation)
    const off = Math.max(0.18, Math.min(c.w, c.h) / 2 - 0.05)
    // Local +y (depth) direction in world space.
    const nx = -sin
    const ny = cos
    points.push({ type: 'power', x: c.x - nx * off, y: c.y - ny * off })
    points.push({ type: 'data', x: c.x + nx * off, y: c.y + ny * off })
  }

  // Floor box per desk cluster.
  for (const fb of deskClusters(ws.filter((c) => c.category === 'Desk')))
    points.push({ type: 'floorbox', x: fb.x, y: fb.y })

  // Switch beside every door.
  const ds = doors(state)
  for (const d of ds) {
    const cos = Math.cos(d.rotation)
    const sin = Math.sin(d.rotation)
    const half = Math.max(d.w, d.h) / 2 + 0.25
    points.push({ type: 'switch', x: d.x + cos * half, y: d.y + sin * half })
  }

  // Distribution board near the entry — the door furthest from the plate centre.
  const b = plateBounds(state)
  if (ds.length > 0 && b) {
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    const entry = ds.reduce((best, d) =>
      Math.hypot(d.x - cx, d.y - cy) > Math.hypot(best.x - cx, best.y - cy) ? d : best,
    )
    const dx = cx - entry.x
    const dy = cy - entry.y
    const len = Math.hypot(dx, dy) || 1
    points.push({ type: 'db', x: entry.x + (dx / len) * 0.9, y: entry.y + (dy / len) * 0.9 })
  }

  const count = (t: PowerPointType) => points.filter((p) => p.type === t).length
  const schedule: ServiceScheduleRow[] = [
    { code: 'P', label: 'Power outlet — twin 13A switched', count: count('power') },
    { code: 'D', label: 'Data outlet — 2× RJ-45', count: count('data') },
    { code: 'FB', label: 'Floor box — power + data', count: count('floorbox') },
    { code: 'SW', label: 'Lighting switch', count: count('switch') },
    { code: 'DB', label: 'Distribution board', count: count('db') },
  ]
  return { points, schedule }
}

// ---------------------------------------------------------------------------
// Lighting circuits — which switch controls which luminaires (RCP switch legs)
// ---------------------------------------------------------------------------

/** One switching circuit: a switch and the luminaires it controls, as an
 *  already-ordered run (switch → nearest luminaire → next, greedy) so the RCP
 *  can draw one clean polyline per room instead of a fan of crossings. */
export interface LightingCircuit {
  /** 1-based circuit number within the plan. */
  no: number
  /** Circuit tag, e.g. `LC-01` (numbered per room; matches `no`). */
  label: string
  /** The controlling switch (a `switch` point reused from {@link powerLayout}). */
  sw: { x: number; y: number }
  /** Luminaires on this circuit, ordered as a nearest-neighbour run. */
  luminaires: { x: number; y: number }[]
}

/** Greedy nearest-neighbour ordering of `pts` starting from `start` — turns a
 *  bag of luminaires into a single non-crossing run so the switch leg reads as
 *  one loop rather than a star. */
function orderChain(start: { x: number; y: number }, pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const remaining = pts.slice()
  const out: { x: number; y: number }[] = []
  let cur = start
  while (remaining.length > 0) {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = Math.hypot(remaining[i].x - cur.x, remaining[i].y - cur.y)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    cur = remaining[bi]
    out.push(cur)
    remaining.splice(bi, 1)
  }
  return out
}

/**
 * Derive the lighting-control circuits: for every room that has luminaires,
 * bind the nearest lighting switch (each sits beside a door in
 * {@link powerLayout}) to that room's luminaires, ordered into a single run.
 * A switch too far from the room to plausibly serve it (open-plan areas with no
 * adjacent door) is left unbound rather than dragged across the plan, keeping
 * the RCP readable. Deterministic — a pure function of the geometry. Returns
 * `[]` when the plan has no switches or no luminaires.
 */
export function lightingCircuits(state: DocState): LightingCircuit[] {
  const switches = powerLayout(state).points.filter((p) => p.type === 'switch')
  if (switches.length === 0) return []
  const out: LightingCircuit[] = []
  let n = 0
  for (const room of rooms(state)) {
    const lums = roomLuminaires(room)
    if (lums.length === 0) continue
    const sw = switches.reduce((best, s) =>
      Math.hypot(s.x - room.cx, s.y - room.cy) < Math.hypot(best.x - room.cx, best.y - room.cy) ? s : best,
    )
    // Only bind a switch that actually flanks this room — beyond the room's own
    // reach it belongs to a neighbour, so leave the luminaires un-run.
    const reach = Math.hypot(room.hw, room.hh) + 2.5
    if (Math.hypot(sw.x - room.cx, sw.y - room.cy) > reach) continue
    n++
    out.push({
      no: n,
      label: `LC-${String(n).padStart(2, '0')}`,
      sw: { x: sw.x, y: sw.y },
      luminaires: orderChain({ x: sw.x, y: sw.y }, lums),
    })
  }
  return out
}
