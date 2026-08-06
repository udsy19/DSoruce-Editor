// Statistics breakdown model — pure functions that turn the core's serialized
// document into the detailed Areas / Zones / CO2 / Costs tables the Statistics
// panel renders (Laiout parity). No wasm, no React, no DOM: takes plain
// `DocState` / `ZoneStat[]` in, returns plain data out, so it is trivially
// testable and reusable.
//
// TWO cost/carbon models coexist by design (different responsibility):
//   • The Rust core (`cost.rs`) computes the *headline* fit-out total from the
//     same element factors used here (base shell per m² + partitions per m +
//     doors per leaf + enclosed-room premium per m² + furniture per unit).
//   • This module computes the *fine, per-element* BoQ decomposition the panel
//     renders, honouring Materio product bindings on furniture. It mirrors the
//     core's rates so the sidebar total tracks the headline — **keep the two in
//     lockstep** (rates live in `cost.rs` `BASE_SHELL`/`PARTITION_*`/`DOOR`/
//     `ENCLOSURE_PREMIUM`/`furniture_rate`; change one, change both). The panel
//     shows this element model's own grand total everywhere it appears, so every
//     view stays self-consistent (Σ lines = group total = grand total).
//
// Currency is ₹ (India-first, matching the material bank + app convention).

import type { DocState, DocWall, DocZone, ZoneType } from '../types/doc'
import { GROUND_ZONES } from '../types/doc'
import type { ZoneStat } from '../types/metrics'
import { zoneArea as zoneShapeArea } from '../util/zoneGeom'
import { searchBank } from '../materialBank/mock'
import { searchOfficeBank } from '../materialBank/office'
import { ZONE } from './planStyle'

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
/**
 * Panel vocabulary for each zone kind. LABELS live here because they are the
 * panel's own words; COLOURS come from the plan style table, because a swatch
 * in the panel and the fill on the canvas must be the same colour by
 * construction, not by two lists agreeing.
 *
 * This used to hold its own hex pair per zone. That copy was a second source
 * with real consumers: the 2e palette move would have recoloured the plan while
 * the Zones tab and the legend kept showing the previous palette, and nothing
 * would have failed.
 */
export const ZONE_META: Record<ZoneType, { label: string; fill: string; line: string }> = {
  Workspace: { label: 'Open Workspace', ...ZONE.Workspace },
  Meeting: { label: 'Meeting Room', ...ZONE.Meeting },
  Collaboration: { label: 'Breakout', ...ZONE.Collaboration },
  ClosedOffice: { label: 'Closed Office', ...ZONE.ClosedOffice },
  Amenity: { label: 'Amenity', ...ZONE.Amenity },
  Circulation: { label: 'Circulation', ...ZONE.Circulation },
  Core: { label: 'Core / Service', ...ZONE.Core },
  // Internal/editor surfaces only. Published paths read the core's folded rows
  // (`zone_stats_published`), where this type never appears.
  Unassigned: { label: 'Unassigned', ...ZONE.Unassigned },
}
export const ZONE_ORDER: ZoneType[] = [
  'Workspace',
  'Meeting',
  'Collaboration',
  'ClosedOffice',
  'Amenity',
  'Circulation',
  'Unassigned',
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

// Zone types that are NOT usable/occupiable — the "loss" against NIA. Usable =
// every other type. Mirrors the core's `usable_area` (lib.rs): efficiency =
// usable / NIA, the standard workplace space-efficiency ratio (BCO 2023 / RICS
// IPMS / JLL), where the loss is circulation aisles + core/service.
const CIRCULATION_TYPES: ZoneType[] = [...GROUND_ZONES]
const CORE_TYPES: ZoneType[] = ['Core']

export interface AreaSplit {
  usable: number
  circulation: number
  core: number
  nia: number
  usablePct: number
  circulationPct: number
  corePct: number
}

/** Honest usable-vs-circulation-vs-core rollup of NIA (Laiout-style), derived
 *  from the already-grouped zones so it never disagrees with the donut. Its
 *  `usablePct` IS `metrics.efficiency_pct` by construction (same numerator). */
export function buildAreaSplit(zones: ZonesBreakdown): AreaSplit {
  const nia = zones.totalArea
  const sum = (types: ZoneType[]) =>
    zones.groups.filter((g) => types.includes(g.type)).reduce((s, g) => s + g.area, 0)
  const circulation = sum(CIRCULATION_TYPES)
  const core = sum(CORE_TYPES)
  const usable = Math.max(0, nia - circulation - core)
  const pct = (a: number) => (nia > 0 ? (a / nia) * 100 : 0)
  return {
    usable,
    circulation,
    core,
    nia,
    usablePct: pct(usable),
    circulationPct: pct(circulation),
    corePct: pct(core),
  }
}

// =========================================================================
// ELEMENTS — per-element CO2 + Cost decomposition (Partition Wall / Floor /
// Furniture / Lighting), the source for both the CO2 and Costs tabs.
// =========================================================================
//
// FACTORS — **in lockstep with `cost.rs`** (India metro CAT-B fit-out, ₹ INR,
// 2024–25; embodied carbon anchored to the ~190 kgCO2e/m² CAT-B benchmark,
// SpecFinish / UK NZC Buildings Standard 2024). Change here ⇒ change there.
//  Base shell (Floor + Lighting) — per m² NIA, the area-driven CAT-B scope
//    (carpet-tile flooring, grid ceiling, lighting, HVAC dist, power/data, fire,
//    BMS); Holzbox 2024 component rates × 10.764 sqft/m²:
//    Floor    90 kgCO2e/m²,  ₹11,000/m²   Lighting  20 kgCO2e/m²,  ₹3,000/m²
//    (Σ = cost.rs BASE_SHELL 110 kgCO2e/m², ₹14,000/m²)
//  Partition wall — per LINEAR METRE (~2.7 m storey), GENERATED walls only
//    (the fit-out enclosure; the architectural envelope is base-build):
//    Default (boarded drywall, ₹120–200/sqft): 35 kgCO2e/m,  ₹4,600/m
//    Glass (framed aluminium, ₹350–1,000/sqft): 140 kgCO2e/m,  ₹15,000/m
//  Enclosed-room premium — per m² of enclosed floor (Meeting / Closed Office):
//    acoustic ceiling, dedicated HVAC, AV:  40 kgCO2e/m²,  ₹6,000/m²
//  Furniture — per UNIT, by grouped category (cost falls back to these when a
//    component has no Materio binding; a bound product's real price overrides):
//    Seating   55 kgCO2e,  ₹12,000    Table   110 kgCO2e,  ₹20,000 (desk/table)
//    Storage  120 kgCO2e,  ₹12,000    Privacy 300 kgCO2e,  ₹120,000 (pod/booth)
//    Accessory 15 kgCO2e,  ₹2,500     Door     80 kgCO2e,  ₹25,000 (leaf+frame)

const WALL = {
  default: { co2PerM: 35, costPerM: 4_600 },
  glass: { co2PerM: 140, costPerM: 15_000 },
}
const FLOOR = { co2PerM2: 90, costPerM2: 11_000 }
const LIGHTING = { co2PerM2: 20, costPerM2: 3_000 }
const ENCLOSURE = { co2PerM2: 40, costPerM2: 6_000 }

type FurnGroup = 'Seating' | 'Table' | 'Storage' | 'Privacy' | 'Accessory' | 'Door'
const FURN_ORDER: FurnGroup[] = ['Seating', 'Table', 'Storage', 'Privacy', 'Accessory', 'Door']
const FURN: Record<FurnGroup, { co2: number; cost: number }> = {
  Seating: { co2: 55, cost: 12_000 },
  Table: { co2: 110, cost: 20_000 },
  Storage: { co2: 120, cost: 12_000 },
  Privacy: { co2: 300, cost: 120_000 },
  Accessory: { co2: 15, cost: 2_500 },
  Door: { co2: 80, cost: 25_000 },
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

/** Net area of a zone from its shape, m². Enclosed rooms are `Rect` and lie
 *  fully inside the plate, so unclipped shape area == the core's plate-clipped
 *  area — the two enclosure premiums agree. */
function zoneArea(z: DocZone): number {
  return zoneShapeArea(z.shape)
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

  // 1. Partition Wall — GENERATED interior partitions only (the fit-out
  //    enclosure; the architectural envelope is base-build). Solid vs glazed by
  //    the `glazing` flag the generator sets on corridor glass fronts.
  const walls = (state.walls ?? []).filter((w) => w.generated)
  if (walls.length > 0) {
    let defLen = 0, glassLen = 0
    for (const w of walls) (w.glazing ? (glassLen += wallLen(w)) : (defLen += wallLen(w)))
    const lines: ElementLine[] = []
    if (defLen > 0)
      lines.push({ label: 'Default', qty: defLen, unit: 'm', co2: defLen * WALL.default.co2PerM, cost: defLen * WALL.default.costPerM })
    if (glassLen > 0)
      lines.push({ label: 'Glass', qty: glassLen, unit: 'm', co2: glassLen * WALL.glass.co2PerM, cost: glassLen * WALL.glass.costPerM })
    if (lines.length) groups.push(makeGroup('Partition Wall', ELEMENT_COLOR.partition, lines))
  }

  // 2. Floor + base shell — by area (NIA)
  if (nia > 0)
    groups.push(
      makeGroup('Floor', ELEMENT_COLOR.floor, [
        { label: 'Floor finish', qty: nia, unit: 'm²', co2: nia * FLOOR.co2PerM2, cost: nia * FLOOR.costPerM2 },
      ]),
    )

  // 3. Enclosed-room premium — acoustic ceiling / dedicated HVAC / AV, per m² of
  //    enclosed floor (Meeting / Closed Office). Open plan never incurs it.
  const enclosedArea = (state.zones ?? [])
    .filter((z) => z.zone_type === 'Meeting' || z.zone_type === 'ClosedOffice')
    .reduce((s, z) => s + zoneArea(z), 0)
  if (enclosedArea > 0)
    groups.push(
      makeGroup('Room Fit-out', ELEMENT_COLOR.partition, [
        { label: 'Ceiling + HVAC + AV', qty: enclosedArea, unit: 'm²', co2: enclosedArea * ENCLOSURE.co2PerM2, cost: enclosedArea * ENCLOSURE.costPerM2 },
      ]),
    )

  // 4. Furniture — by grouped category, per unit (bound price overrides default)
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
