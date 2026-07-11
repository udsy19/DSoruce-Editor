// Statistics breakdown model — pure functions that turn the core's serialized
// document into the detailed Areas / Zones / CO2 / Costs tables the Statistics
// panel renders (Laiout parity). No wasm, no React, no DOM: takes plain
// `DocState` / `ZoneStat[]` in, returns plain data out, so it is trivially
// testable and reusable.
//
// TWO cost/carbon models coexist by design (different responsibility):
//   • The Rust core (`cost.rs`) computes a *coarse, zone-area* total
//     (`Σ area × per-m² rate`) — one number for the headline.
//   • This module computes a *fine, per-element* decomposition — partitions by
//     length, floor + lighting by area, furniture by unit (honouring Materio
//     product bindings). The zone-area model can't produce per-element line
//     items, so we fork intentionally. The panel shows this element model's own
//     grand total everywhere it appears, so every view stays self-consistent
//     (Σ lines = group total = grand total).
//
// Currency is ₹ (India-first, matching the material bank + app convention).

import type { DocState, DocWall, ZoneStat, ZoneType } from './EditorCanvas'
import { searchBank } from '../materialBank/mock'
import { searchOfficeBank } from '../materialBank/office'

// ---- formatting helpers (shared by the panel) ----
export const intFmt = (n: number) => Math.round(n).toLocaleString('en-US')
export const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
/** Compact ₹ for tiles: ₹1.2L / ₹3.4Cr so big fit-out sums stay legible. */
export const inrShort = (n: number) => {
  const v = Math.round(n)
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)}Cr`
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)}L`
  return inr(v)
}

// =========================================================================
// ZONES — grouped by room type, each group split into size classes, with
// Count · Pax · Area · Area% per row and a per-group total.
// =========================================================================

/** Room-type display label + donut/legend fill, keyed by the core ZoneType. */
export const ZONE_META: Record<ZoneType, { label: string; fill: string; line: string }> = {
  Workspace: { label: 'Open Workspace', fill: '#fbf3d6', line: '#b99527' },
  Meeting: { label: 'Meeting Room', fill: '#e9e3f7', line: '#7e63c0' },
  Collaboration: { label: 'Breakout', fill: '#def1e2', line: '#4b9e66' },
  ClosedOffice: { label: 'Closed Office', fill: '#fce6d6', line: '#cb8150' },
  Amenity: { label: 'Amenity', fill: '#d9f0ef', line: '#3f9c95' },
  Circulation: { label: 'Circulation', fill: '#dcebfb', line: '#4a82c4' },
  Core: { label: 'Core / Service', fill: '#eceef1', line: '#8b939e' },
}
export const ZONE_ORDER: ZoneType[] = [
  'Workspace',
  'Meeting',
  'Collaboration',
  'ClosedOffice',
  'Amenity',
  'Circulation',
  'Core',
]

/** Occupancy per zone, defining the panel's **Pax** == the core's **Workstations**
 *  (see `metrics()` "ONE Workstations == Pax"). Pax is one coherent number: the
 *  seated, non-reference desks in Workspace zones (the core's `seated`, which already
 *  excludes imported reference furniture). Σ zonePax == `metrics().workstations` by
 *  construction, so the chip, the Workstations row, the Zones-tab total, and the CSV
 *  all show the identical figure. Enclosed rooms' area-capacity is intentionally NOT
 *  folded in — that would make Pax disagree with Workstations. */
function zonePax(z: ZoneStat): number {
  return z.zone_type === 'Workspace' ? z.seated : 0
}

/** Coarse size class from net area — mirrors Laiout's S/M/L room templates. */
function sizeClass(area: number): { key: string; rank: number } {
  if (area < 10) return { key: 'S', rank: 0 }
  if (area < 20) return { key: 'M', rank: 1 }
  if (area < 40) return { key: 'L', rank: 2 }
  return { key: 'XL', rank: 3 }
}

export interface ZoneRow {
  cls: string // size class label, e.g. "M"
  count: number
  pax: number
  area: number
  areaPct: number
}
export interface ZoneGroup {
  type: ZoneType
  label: string
  fill: string
  line: string
  rows: ZoneRow[]
  count: number
  pax: number
  area: number
  areaPct: number
}
export interface ZonesBreakdown {
  groups: ZoneGroup[]
  totalCount: number
  totalPax: number
  totalArea: number
  segments: { color: string; pct: number }[] // for the Areas donut
}

export function buildZones(zoneStats: ZoneStat[]): ZonesBreakdown {
  const nia = zoneStats.reduce((s, z) => s + z.area, 0)
  const pct = (a: number) => (nia > 0 ? (a / nia) * 100 : 0)

  const groups: ZoneGroup[] = []
  for (const type of ZONE_ORDER) {
    const zs = zoneStats.filter((z) => z.zone_type === type)
    if (zs.length === 0) continue

    // bucket the group's zones by size class
    const buckets = new Map<string, { rank: number; count: number; pax: number; area: number }>()
    for (const z of zs) {
      const sc = sizeClass(z.area)
      const b = buckets.get(sc.key) ?? { rank: sc.rank, count: 0, pax: 0, area: 0 }
      b.count += 1
      b.pax += zonePax(z)
      b.area += z.area
      buckets.set(sc.key, b)
    }
    const rows: ZoneRow[] = [...buckets.entries()]
      .sort((a, b) => a[1].rank - b[1].rank)
      .map(([cls, b]) => ({ cls, count: b.count, pax: b.pax, area: b.area, areaPct: pct(b.area) }))

    const count = zs.length
    const pax = zs.reduce((s, z) => s + zonePax(z), 0)
    const area = zs.reduce((s, z) => s + z.area, 0)
    const meta = ZONE_META[type]
    groups.push({ type, label: meta.label, fill: meta.fill, line: meta.line, rows, count, pax, area, areaPct: pct(area) })
  }

  return {
    groups,
    totalCount: groups.reduce((s, g) => s + g.count, 0),
    totalPax: groups.reduce((s, g) => s + g.pax, 0),
    totalArea: nia,
    segments: groups.map((g) => ({ color: g.fill, pct: g.areaPct })),
  }
}

// =========================================================================
// ELEMENTS — per-element CO2 + Cost decomposition (Partition Wall / Floor /
// Furniture / Lighting), the source for both the CO2 and Costs tabs.
// =========================================================================
//
// FACTORS (indicative planning figures, tunable in one place):
//  Partition wall  — per LINEAR METRE (assumes a ~2.7 m storey height):
//    Default (stud + board):  40 kgCO2e/m,  ₹1,800/m
//    Glass (framed glazing):  95 kgCO2e/m,  ₹4,500/m
//  Floor finish     — per m² NIA:  45 kgCO2e/m²,  ₹850/m²
//  Lighting (custom)— per m² NIA:  12 kgCO2e/m²,  ₹350/m²
//  Furniture        — per UNIT, by grouped category (cost falls back to these
//    when a component has no Materio product binding; a bound product's real
//    price overrides the default):
//    Seating   45 kgCO2e,  ₹700    Table    90 kgCO2e,  ₹950
//    Storage  110 kgCO2e,  ₹1,000  Privacy 160 kgCO2e,  ₹8,000 (pod/booth)
//    Accessory 15 kgCO2e,  ₹300    Door     35 kgCO2e,  ₹1,200
// Sources: fit-out embodied-carbon order-of-magnitude (partitioning/joinery/
// services ~100–400 kgCO2e/m²; see cost.rs) apportioned to the element that
// carries it. Costs kept in the same magnitude as cost.rs + the material bank.

const WALL = {
  default: { co2PerM: 40, costPerM: 1_800 },
  glass: { co2PerM: 95, costPerM: 4_500 },
}
const FLOOR = { co2PerM2: 45, costPerM2: 850 }
const LIGHTING = { co2PerM2: 12, costPerM2: 350 }

type FurnGroup = 'Seating' | 'Table' | 'Storage' | 'Privacy' | 'Accessory' | 'Door'
const FURN_ORDER: FurnGroup[] = ['Seating', 'Table', 'Storage', 'Privacy', 'Accessory', 'Door']
const FURN: Record<FurnGroup, { co2: number; cost: number }> = {
  Seating: { co2: 45, cost: 700 },
  Table: { co2: 90, cost: 950 },
  Storage: { co2: 110, cost: 1_000 },
  Privacy: { co2: 160, cost: 8_000 },
  Accessory: { co2: 15, cost: 300 },
  Door: { co2: 35, cost: 1_200 },
}

/** Map a component category (native or imported) onto a furniture group. */
function furnGroup(category: string): FurnGroup {
  const c = category.toLowerCase()
  if (/\bdoor\b/.test(c)) return 'Door'
  if (/chair|sofa|lounge|stool|seat|settee|banquette|bench/.test(c)) return 'Seating'
  if (/desk|table|workstation|worktop|credenza/.test(c)) return 'Table'
  if (/storage|cabinet|locker|shelf|file|pedestal/.test(c)) return 'Storage'
  if (/partition|screen|pod|meeting|privacy|booth|phone/.test(c)) return 'Privacy'
  return 'Accessory' // planter, ceiling, art, misc
}

/** id → price across both mock material banks (Materio bindings). */
function buildPriceMap(): Map<string, number> {
  const m = new Map<string, number>()
  for (const cat of ['Desk', 'Chair', 'Table', 'MeetingRoom', 'FallCeiling'])
    for (const p of searchBank(cat, '')) m.set(p.id, p.price)
  for (const cat of ['task-chair', 'desk', 'workstation-bench', 'meeting-table', 'side-table', 'lounge', 'stool', 'storage', 'planter', 'partition'])
    for (const p of searchOfficeBank(cat, '')) m.set(p.id, p.price)
  return m
}

const wallLen = (w: DocWall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)

/** A wall is treated as GLASS when it runs along the edge of an enclosed room
 *  (Meeting / Breakout / Closed Office) — those fronts are glazed. */
function isGlassWall(w: DocWall, state: DocState): boolean {
  const mx = (w.a.x + w.b.x) / 2
  const my = (w.a.y + w.b.y) / 2
  const tol = 0.2
  for (const z of state.zones ?? []) {
    if (z.zone_type !== 'Meeting' && z.zone_type !== 'Collaboration' && z.zone_type !== 'ClosedOffice') continue
    if (z.shape.kind !== 'Rect') continue
    const { x, y, w: zw, h: zh } = z.shape
    const l = x - zw / 2, r = x + zw / 2, t = y - zh / 2, b = y + zh / 2
    const onV = (Math.abs(mx - l) < tol || Math.abs(mx - r) < tol) && my > t - tol && my < b + tol
    const onH = (Math.abs(my - t) < tol || Math.abs(my - b) < tol) && mx > l - tol && mx < r + tol
    if (onV || onH) return true
  }
  return false
}

export interface ElementLine {
  label: string
  qty: number
  unit: 'm' | 'm²' | 'units'
  co2: number
  cost: number
}
export interface ElementGroup {
  label: string
  color: string
  lines: ElementLine[]
  co2: number
  cost: number
}
export interface ElementBreakdown {
  groups: ElementGroup[]
  totalCo2: number
  totalCost: number
  co2Segments: { color: string; pct: number }[]
  costSegments: { color: string; pct: number }[]
}

const ELEMENT_COLOR = {
  partition: '#7e63c0', // lavender — walls
  floor: '#4a82c4', // blue — floor plate
  furniture: '#4b9e66', // green — furniture
  lighting: '#e0952b', // amber — lighting
}

export function buildElements(state: DocState, nia: number): ElementBreakdown {
  const groups: ElementGroup[] = []

  // 1. Partition Wall — Default / Glass, by linear metre
  const walls = state.walls ?? []
  if (walls.length > 0) {
    let defLen = 0, glassLen = 0
    for (const w of walls) (isGlassWall(w, state) ? (glassLen += wallLen(w)) : (defLen += wallLen(w)))
    const lines: ElementLine[] = []
    if (defLen > 0)
      lines.push({ label: 'Default', qty: defLen, unit: 'm', co2: defLen * WALL.default.co2PerM, cost: defLen * WALL.default.costPerM })
    if (glassLen > 0)
      lines.push({ label: 'Glass', qty: glassLen, unit: 'm', co2: glassLen * WALL.glass.co2PerM, cost: glassLen * WALL.glass.costPerM })
    if (lines.length) groups.push(makeGroup('Partition Wall', ELEMENT_COLOR.partition, lines))
  }

  // 2. Floor — by area (NIA)
  if (nia > 0)
    groups.push(
      makeGroup('Floor', ELEMENT_COLOR.floor, [
        { label: 'Floor finish', qty: nia, unit: 'm²', co2: nia * FLOOR.co2PerM2, cost: nia * FLOOR.costPerM2 },
      ]),
    )

  // 3. Furniture — by grouped category, per unit (bound price overrides default)
  const priceMap = buildPriceMap()
  const fb = new Map<FurnGroup, { count: number; co2: number; cost: number }>()
  for (const c of state.components ?? []) {
    if (c.reference) continue // imported/legacy furniture isn't in the fit-out you'd buy (BoQ = generated only)
    const g = furnGroup(c.category)
    const acc = fb.get(g) ?? { count: 0, co2: 0, cost: 0 }
    acc.count += 1
    acc.co2 += FURN[g].co2
    acc.cost += (c.product_id && priceMap.get(c.product_id)) || FURN[g].cost
    fb.set(g, acc)
  }
  const furnLines: ElementLine[] = FURN_ORDER.filter((g) => fb.has(g)).map((g) => {
    const acc = fb.get(g)!
    return { label: g, qty: acc.count, unit: 'units', co2: acc.co2, cost: acc.cost }
  })
  if (furnLines.length) groups.push(makeGroup('Furniture', ELEMENT_COLOR.furniture, furnLines))

  // 4. Lighting (custom) — by area (NIA)
  if (nia > 0)
    groups.push(
      makeGroup('Lighting', ELEMENT_COLOR.lighting, [
        { label: 'Ambient + task', qty: nia, unit: 'm²', co2: nia * LIGHTING.co2PerM2, cost: nia * LIGHTING.costPerM2 },
      ]),
    )

  const totalCo2 = groups.reduce((s, g) => s + g.co2, 0)
  const totalCost = groups.reduce((s, g) => s + g.cost, 0)
  return {
    groups,
    totalCo2,
    totalCost,
    co2Segments: groups.map((g) => ({ color: g.color, pct: totalCo2 > 0 ? (g.co2 / totalCo2) * 100 : 0 })),
    costSegments: groups.map((g) => ({ color: g.color, pct: totalCost > 0 ? (g.cost / totalCost) * 100 : 0 })),
  }
}

function makeGroup(label: string, color: string, lines: ElementLine[]): ElementGroup {
  return {
    label,
    color,
    lines,
    co2: lines.reduce((s, l) => s + l.co2, 0),
    cost: lines.reduce((s, l) => s + l.cost, 0),
  }
}
