// Shared KPI computation — the ONE derivation of a plan's headline numbers.
//
// Extracted from `report.ts` unchanged. The report and the on-screen metrics
// card must not compute density, daylight, privacy or efficiency separately:
// two derivations of one number drift, and the reader has no way to tell which
// one is lying. This module is that single source; `report.ts` re-exports its
// public types so existing consumers are untouched.
//
// NOTHING HERE WAS REDEFINED. This is a move, and the acceptance test is that
// the report model is byte-identical across it (`docs/audits/LOOP-LEDGER.md`,
// C1) — the same differencing instrument R2 used for classifier verdicts,
// pointed at a different artifact.

import { Editor } from '../wasm/ds_core'
import type { DocState, DocZone, ZoneType } from '../types/doc'
import { GROUND_ZONES } from '../types/doc'
import type { Metrics, ZoneStat } from '../types/metrics'
import { pointInZoneShape } from '../util/zoneGeom'
import { SF_PER_M2 } from '../util/units'
import { distToPoly } from '../editor/paint'

export interface ReportMeta {
  client?: string
  project: string
  style?: string
  address?: string
  floor?: string
  /** Client logo as a data: URL (any raster the browser can decode). */
  logo?: string
}
export interface AlternativeInput {
  name: string
  snapshot: string
}

/** Zone-area shares for the summary's space-mix bar, m². */
export interface SpaceMix {
  work: number
  sharedSpace: number
  amenities: number
  shared: number
}

/** Every KPI for one alternative, computed from its snapshot's state(). */
export interface AltKpis {
  name: string
  designId: string
  usfSf: number
  niaM2: number
  geaM2: number
  seats: number
  workstations: number
  openSpaceSeats: number
  meetingSeats: number
  offices: number
  confRooms: number
  densitySqf: number
  densityM2: number
  daylightPct: number
  privacyPct: number
  efficiencyPct: number
  spaceMix: SpaceMix
  /** Distinct zone types present, in fixed legend order. */
  zoneTypes: ZoneType[]
  hasWalls: boolean
  /** Retained so the render layer can draw the plan without re-cloning. */
  snapshot: string
}

export interface ReportModel {
  meta: ReportMeta
  alternatives: AltKpis[]
}

/** Daylit = a workstation within this distance of the exterior (facade). */
export const DAYLIGHT_RADIUS_M = 5

// Zones that DON'T count as enclosed rooms for the privacy metric (open plan):
// GROUND plus the open desk field. DERIVED from `GROUND_ZONES`, so the fold owns
// which types are ground and this file owns only the `Workspace` part.
const OPEN_ZONE_TYPES: ReadonlySet<ZoneType> = new Set<ZoneType>([...GROUND_ZONES, 'Workspace'])

/**
 * Fixed legend order — PROGRAM ZONES ONLY.
 *
 * `'Circulation'` was last in this list, with a comment reading "qbiq lists
 * rooms first, circulation last". The measurement says otherwise: the reference
 * legend identifies FACILITIES, and circulation is the paper they sit on — it
 * carries no swatch because it carries no fill. A ground swatch keyed to white
 * explains nothing, and it told the reader the plan contains a thing it does not
 * draw.
 *
 * `'Unassigned'` is absent for a second, independent reason: it never reaches a
 * published surface at all (the core's `published_zone_type` folds it into
 * Circulation). If it ever appears here, the fold was bypassed.
 *
 * Three legends exist — this one, the app panel's `legendEntries`, and `pdf.ts`'s
 * ZONE KEY — and `legendParity.test.mjs` asserts they list the SAME set. Three
 * surfaces disagreeing about what a plan contains is worse than any one of them
 * being wrong.
 */
export const LEGEND_ORDER: ZoneType[] = [
  'Workspace',
  'ClosedOffice',
  'Meeting',
  'Collaboration',
  'Amenity',
  'Core',
]

/** qbiq-aligned display name for each app ZoneType (used in the plan legend). */
export const ZONE_LABEL: Record<ZoneType, string> = {
  Workspace: 'Open Space',
  ClosedOffice: 'Office',
  Meeting: 'Conf Room',
  Collaboration: 'Collaboration',
  Amenity: 'Amenities',
  Core: 'Core / IT',
  Circulation: 'Circulation',
  // Published artifacts fold Unassigned into Circulation before they get here
  // (core `zone_stats_published`). Present only so the map stays total; seeing
  // this string in a delivered report means the fold was bypassed.
  Unassigned: 'Circulation',
}

/** Is point p inside this zone shape? Rings exclude the hole; polys ray-cast. */
const pointInZone = pointInZoneShape

/** Deterministic 6-digit "Design #" from the snapshot (stands in for qbiq's). */
function designId(snapshot: string): string {
  let h = 0
  for (let i = 0; i < snapshot.length; i++) h = (h * 31 + snapshot.charCodeAt(i)) >>> 0
  return String(100000 + (h % 900000))
}

/**
 * Compute all KPIs for one snapshot via a scratch-clone (the compare.ts /
 * engine.ts pattern): from_snapshot → read state/metrics/zone_stats/plate,
 * derive, free.
 *
 * KPI formulas (report-grade approximations — documented for the reader):
 *   USF          = net internal area × 10.7639 (m²→sf), kept in sf per qbiq.
 *   Workstations = Desk component count (Rust metrics.workstations).
 *   Meeting seats= Σ area-rule capacity() of Meeting + Collaboration zones.
 *   Seats        = Workstations + Meeting seats.
 *   Open Space   = Workstations NOT inside an enclosed room (open-plan desks).
 *   Offices      = count of ClosedOffice zones.
 *   Conf Rooms   = count of Meeting zones.
 *   Density      = USF / Seats (sqf/person) and NIA / Seats (m²/person).
 *   Daylight %   = % of workstations within 5 m of the floor-plate boundary
 *                  (facade). Needs a closed plate; 0 when the plate can't trace.
 *   Privacy %    = % of workstations whose center lies inside a non-open zone
 *                  (Meeting/Collaboration/ClosedOffice/Amenity/Core).
 *   Efficiency % = Rust metrics.efficiency_pct (programmed / NIA), else NIA/GEA.
 *   Space mix    = zone-area m² grouped Work(Workspace+ClosedOffice) /
 *                  Shared Space(Meeting+Collaboration) / Amenities / Shared
 *                  (Circulation+Core).
 */
export function computeAltKpis(input: AlternativeInput): AltKpis {
  const ed = Editor.from_snapshot(input.snapshot)
  try {
    const st = ed.state() as DocState
    const m = ed.metrics() as Metrics
    const zs = (typeof (ed as unknown as { zone_stats?: () => unknown }).zone_stats === 'function'
      ? ((ed as unknown as { zone_stats: () => unknown }).zone_stats() as ZoneStat[])
      : []) ?? []
    const plate = (ed.plate() as [number, number][] | null | undefined) ?? null

    const niaM2 = m.net_internal_area ?? 0
    const geaM2 = m.gross_external_area ?? m.floor_area ?? 0
    const workstations = m.workstations ?? st.components.filter((c) => c.category === 'Desk').length

    const meetingSeats = zs
      .filter((z) => z.zone_type === 'Meeting' || z.zone_type === 'Collaboration')
      .reduce((s, z) => s + z.capacity, 0)
    const seats = workstations + meetingSeats
    const offices = zs.filter((z) => z.zone_type === 'ClosedOffice').length
    const confRooms = zs.filter((z) => z.zone_type === 'Meeting').length

    // Geometric daylight + privacy over Desk centers (robust to whether the
    // generator populated zone.component_ids).
    const enclosed = (st.zones ?? []).filter((z) => !OPEN_ZONE_TYPES.has(z.zone_type))
    let daylit = 0
    let enclosedDesks = 0
    const desks = st.components.filter((c) => c.category === 'Desk')
    for (const d of desks) {
      if (plate && plate.length >= 3 && distToPoly(plate, { x: d.x, y: d.y }) <= DAYLIGHT_RADIUS_M) {
        daylit++
      }
      if (enclosed.some((z) => pointInZone(z.shape, d.x, d.y))) enclosedDesks++
    }
    const daylightPct = desks.length > 0 ? (daylit / desks.length) * 100 : 0
    const privacyPct = desks.length > 0 ? (enclosedDesks / desks.length) * 100 : 0
    const openSpaceSeats = Math.max(0, workstations - enclosedDesks)

    const efficiencyPct =
      m.efficiency_pct ?? (geaM2 > 0 ? (niaM2 / geaM2) * 100 : 0)

    const usfSf = niaM2 * SF_PER_M2
    const densitySqf = seats > 0 ? usfSf / seats : 0
    const densityM2 = seats > 0 ? niaM2 / seats : 0

    const areaOf = (types: ZoneType[]) =>
      zs.filter((z) => types.includes(z.zone_type)).reduce((s, z) => s + z.area, 0)
    const spaceMix: SpaceMix = {
      work: areaOf(['Workspace', 'ClosedOffice']),
      sharedSpace: areaOf(['Meeting', 'Collaboration']),
      amenities: areaOf(['Amenity']),
      shared: areaOf([...GROUND_ZONES, 'Core']),
    }

    const present = new Set((st.zones ?? []).map((z: DocZone) => z.zone_type))
    const zoneTypes = LEGEND_ORDER.filter((t) => present.has(t))

    return {
      name: input.name,
      designId: designId(input.snapshot),
      usfSf,
      niaM2,
      geaM2,
      seats,
      workstations,
      openSpaceSeats,
      meetingSeats,
      offices,
      confRooms,
      densitySqf,
      densityM2,
      daylightPct,
      privacyPct,
      efficiencyPct,
      spaceMix,
      zoneTypes,
      hasWalls: m.wall_count > 0,
      snapshot: input.snapshot,
    }
  } finally {
    ed.free()
  }
}
