// The Program builder's edit state + its mapping onto the core `Program`
// (workflow.md §3.4 / Slice 5). The builder edits a `ProgramSpec`; a pure
// `programSpecToProgram` resolves it into the `Program` the wasm generator
// consumes (headcount, desk footprint/type, and an explicit `rooms` list).
//
// Two tiers share ONE spec (so the running summary and the generator read the
// same numbers): Concept fills the room counts fast (a template or a
// headcount + enclosed-office % slider); Detailed exposes every count and the
// per-group Window/Core/Flexible placement. The builder's rich vocabulary
// (Executive/Large/Medium/Small office, XL/Large/… conference) collapses onto
// the core `SpaceKind` at different footprints — the size distinction lives on
// the `RoomReq`, not in a combinatorial enum.
//
// Pure module: no DOM, no wasm — unit-testable in Node.

import type { Placement, Program, RoomReq, SpaceKind } from '../editor/EditorCanvas'
import { DEFAULT_PROGRAM } from '../editor/EditorCanvas'
import { headcountForArea } from '../ai/suggestProgram'

export type ProgramMode = 'concept' | 'detailed'
export type DeskType = 'workstation' | 'bench'
/** Desk footprint keys (cm) from the reference screenshots. */
export type DeskSizeKey = '120x60' | '140x70' | '160x70' | '180x70'

/**
 * Desk footprints. `w`/`d` are METRES — the core's unit, and the only value that
 * is real; everything downstream (`deskFootprint` → `Program.desk_w/desk_h` →
 * the generator) reads these.
 *
 * The display string is DERIVED (see {@link deskSizeLabel}), not stored. It used
 * to be a hand-typed `label: '120 × 60'` sitting beside `w: 1.2, d: 0.6` — a
 * second representation of the same fact, in a different unit, maintained by
 * hand and free to drift from the metres nobody would notice. It also carried no
 * unit at all, so a CAD product whose core is metres displayed a bare
 * "140 × 70" that could be read as mm, cm or inches.
 */
export const DESK_SIZES: { key: DeskSizeKey; w: number; d: number }[] = [
  { key: '120x60', w: 1.2, d: 0.6 },
  { key: '140x70', w: 1.4, d: 0.7 },
  { key: '160x70', w: 1.6, d: 0.7 },
  { key: '180x70', w: 1.8, d: 0.7 },
]

/** Render a desk footprint from its METRE dimensions, in the centimetres the
 *  furniture trade quotes. One source of truth, so the label cannot disagree
 *  with the geometry the generator actually places. */
export function deskSizeLabel(s: { w: number; d: number }): string {
  return `${Math.round(s.w * 100)} × ${Math.round(s.d * 100)}`
}

/** UI room identifiers — richer than the core `SpaceKind`. */
export type UiRoomKind =
  | 'office-exec' | 'office-large' | 'office-medium' | 'office-small' | 'office-focus'
  | 'team-2' | 'team-4' | 'team-6' | 'team-8'
  | 'conf-boardroom' | 'conf-xl' | 'conf-large' | 'conf-medium' | 'conf-small'
  | 'collab-huddle' | 'collab-phone' | 'collab-focus'
  | 'amenity-reception' | 'amenity-kitchen' | 'amenity-wellness' | 'amenity-copyprint' | 'amenity-storageit'

/** Builder sections. Placement chips apply only to the first three. */
export type RoomGroup = 'offices' | 'team' | 'conference' | 'collaboration' | 'amenities'
/** Groups where a Window/Core/Flexible placement bias is meaningful. */
export type PlacementGroup = 'offices' | 'team' | 'conference'
export const PLACEMENT_GROUPS: PlacementGroup[] = ['offices', 'team', 'conference']

/** One room type in the builder tree: its core `SpaceKind`, footprint (m), and
 *  a seat capacity used only for the "seats used" summary. */
export interface RoomDef {
  kind: UiRoomKind
  group: RoomGroup
  label: string
  space: SpaceKind
  w: number
  d: number
  seats: number
  /** true for enclosed rooms (counted in the "enclosed rooms" summary). */
  enclosed: boolean
}

export const ROOM_DEFS: RoomDef[] = [
  // Offices — one occupant each; Executive → Small are Cabin at descending size.
  { kind: 'office-exec', group: 'offices', label: 'Executive', space: 'Cabin', w: 4.5, d: 4.0, seats: 1, enclosed: true },
  { kind: 'office-large', group: 'offices', label: 'Large', space: 'Cabin', w: 3.6, d: 3.6, seats: 1, enclosed: true },
  { kind: 'office-medium', group: 'offices', label: 'Medium', space: 'Cabin', w: 3.0, d: 3.3, seats: 1, enclosed: true },
  { kind: 'office-small', group: 'offices', label: 'Small', space: 'Cabin', w: 2.7, d: 3.0, seats: 1, enclosed: true },
  { kind: 'office-focus', group: 'offices', label: 'Focus', space: 'Focus', w: 1.8, d: 2.4, seats: 1, enclosed: true },
  // Team rooms — sized by people (2/4/6/8) onto Meeting4P/6P.
  { kind: 'team-2', group: 'team', label: '2 person', space: 'Meeting4P', w: 2.4, d: 2.7, seats: 2, enclosed: true },
  { kind: 'team-4', group: 'team', label: '4 person', space: 'Meeting4P', w: 2.7, d: 3.3, seats: 4, enclosed: true },
  { kind: 'team-6', group: 'team', label: '6 person', space: 'Meeting6P', w: 3.6, d: 4.2, seats: 6, enclosed: true },
  { kind: 'team-8', group: 'team', label: '8 person', space: 'Meeting6P', w: 3.6, d: 4.8, seats: 8, enclosed: true },
  // Conference.
  { kind: 'conf-boardroom', group: 'conference', label: 'Boardroom', space: 'Boardroom', w: 4.5, d: 6.5, seats: 14, enclosed: true },
  { kind: 'conf-xl', group: 'conference', label: 'XL', space: 'Boardroom', w: 4.5, d: 5.5, seats: 12, enclosed: true },
  { kind: 'conf-large', group: 'conference', label: 'Large', space: 'Meeting6P', w: 3.6, d: 4.8, seats: 10, enclosed: true },
  { kind: 'conf-medium', group: 'conference', label: 'Medium', space: 'Meeting', w: 3.0, d: 3.6, seats: 6, enclosed: true },
  { kind: 'conf-small', group: 'conference', label: 'Small', space: 'Meeting4P', w: 2.7, d: 3.3, seats: 4, enclosed: true },
  // Collaboration.
  { kind: 'collab-huddle', group: 'collaboration', label: 'Huddle', space: 'Collab', w: 2.4, d: 2.4, seats: 4, enclosed: false },
  { kind: 'collab-phone', group: 'collaboration', label: 'Phone booth', space: 'PhoneBooth', w: 1.3, d: 1.1, seats: 1, enclosed: true },
  { kind: 'collab-focus', group: 'collaboration', label: 'Focus room', space: 'Focus', w: 1.8, d: 2.4, seats: 1, enclosed: true },
  // Amenities.
  { kind: 'amenity-reception', group: 'amenities', label: 'Reception', space: 'Reception', w: 4.0, d: 3.2, seats: 0, enclosed: true },
  { kind: 'amenity-kitchen', group: 'amenities', label: 'Kitchen / pantry', space: 'Pantry', w: 3.6, d: 3.0, seats: 0, enclosed: true },
  { kind: 'amenity-wellness', group: 'amenities', label: 'Wellness', space: 'Wellness', w: 3.0, d: 2.4, seats: 0, enclosed: true },
  { kind: 'amenity-copyprint', group: 'amenities', label: 'Copy / print', space: 'Print', w: 2.0, d: 1.5, seats: 0, enclosed: false },
  { kind: 'amenity-storageit', group: 'amenities', label: 'Storage / IT', space: 'Storage', w: 3.0, d: 2.0, seats: 0, enclosed: true },
]

export const ROOM_DEF: Record<UiRoomKind, RoomDef> = Object.fromEntries(
  ROOM_DEFS.map((r) => [r.kind, r]),
) as Record<UiRoomKind, RoomDef>

export const GROUP_LABELS: Record<RoomGroup, string> = {
  offices: 'Offices',
  team: 'Team rooms',
  conference: 'Conference',
  collaboration: 'Collaboration',
  amenities: 'Amenities',
}

/** The builder's whole edit state (persisted on `ProjectDraft.spec`). */
export interface ProgramSpec {
  mode: ProgramMode
  /** Concept design headcount + the closed-office share slider. */
  headcount: number
  enclosedPct: number
  deskType: DeskType
  deskSize: DeskSizeKey
  /** Per-room-type counts (absent = 0). */
  counts: Partial<Record<UiRoomKind, number>>
  /** Per-group facade placement bias (Detailed). */
  placements: Record<PlacementGroup, Placement>
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const ceilDiv = (n: number, d: number) => Math.ceil(n / d)

/** Templates from the reference (Small ~15 / Mid ~40 / Large ~90 seats). */
export const TEMPLATES: { key: string; label: string; headcount: number; enclosedPct: number }[] = [
  { key: 'small', label: 'Small', headcount: 15, enclosedPct: 20 },
  { key: 'mid', label: 'Mid', headcount: 40, enclosedPct: 25 },
  { key: 'large', label: 'Large', headcount: 90, enclosedPct: 30 },
]

/**
 * Derive a sane room-count set from a headcount + enclosed-office share — the
 * shared engine behind BOTH the templates and Concept's "generate from
 * headcount". Mirrors the core `SpaceProgram::derive` ratios (layout.rs) so the
 * Concept starting point matches what the generator would derive, while letting
 * Detailed edit every number afterwards.
 */
export function deriveCounts(headcount: number, enclosedPct: number): Partial<Record<UiRoomKind, number>> {
  const n = clamp(Math.round(headcount), 1, 400)
  const enclosed = Math.round((n * clamp(enclosedPct, 0, 100)) / 100)
  const exec = n >= 60 ? 1 : 0
  const large = clamp(Math.round(enclosed * 0.15), 0, 6)
  const medium = clamp(Math.round(enclosed * 0.45), 0, 20)
  const small = Math.max(0, enclosed - exec - large - medium)
  return {
    'office-exec': exec,
    'office-large': large,
    'office-medium': medium,
    'office-small': small,
    'office-focus': ceilDiv(n, 30),
    'team-4': ceilDiv(n, 24),
    'team-6': ceilDiv(n, 40),
    'conf-medium': clamp(Math.round(n / 40), 1, 4),
    'conf-large': n >= 40 ? 1 : 0,
    'conf-boardroom': n >= 60 ? 1 : 0,
    'collab-huddle': ceilDiv(n, 30),
    'collab-phone': ceilDiv(n, 12),
    'amenity-reception': n >= 20 ? 1 : 0,
    'amenity-kitchen': 1,
    'amenity-wellness': n >= 50 ? 1 : 0,
    'amenity-copyprint': ceilDiv(n, 50),
    'amenity-storageit': 1,
  }
}

/** A fresh spec derived from a headcount (Concept template / generate-from-N). */
export function specFromHeadcount(
  headcount: number,
  enclosedPct = 25,
  base?: Partial<ProgramSpec>,
): ProgramSpec {
  return {
    mode: base?.mode ?? 'concept',
    headcount: clamp(Math.round(headcount), 1, 400),
    enclosedPct: clamp(enclosedPct, 0, 100),
    deskType: base?.deskType ?? 'bench',
    deskSize: base?.deskSize ?? '140x70',
    counts: deriveCounts(headcount, enclosedPct),
    placements: base?.placements ?? { offices: 'Window', team: 'Flexible', conference: 'Core' },
  }
}

/** The starting spec for a project: prefill from the Space step's detected area,
 *  else a mid template. */
export function defaultSpec(plateAreaM2?: number | null): ProgramSpec {
  const headcount = plateAreaM2 && plateAreaM2 > 0 ? headcountForArea(plateAreaM2) : 40
  return specFromHeadcount(headcount, 25)
}

/** Total enclosed rooms + seats provided by the spec (summary readouts). */
export function specTotals(spec: ProgramSpec): { enclosedRooms: number; seats: number; roomArea: number } {
  let enclosedRooms = 0
  let seats = 0
  let roomArea = 0
  for (const def of ROOM_DEFS) {
    const c = spec.counts[def.kind] ?? 0
    if (c <= 0) continue
    if (def.enclosed) enclosedRooms += c
    seats += c * def.seats
    roomArea += c * def.w * def.d
  }
  return { enclosedRooms, seats, roomArea }
}

/** The desk footprint the spec's size key resolves to. */
export function deskFootprint(size: DeskSizeKey): { w: number; d: number } {
  const found = DESK_SIZES.find((s) => s.key === size) ?? DESK_SIZES[2]
  return { w: found.w, d: found.d }
}

/** Open-plan share of the headcount seated at open workstations (desks ≈ 0.85·N). */
const OPEN_SHARE = 0.85

/**
 * Resolve a `ProgramSpec` into the core `Program` the generator consumes.
 * Non-empty `rooms` make the generator honour the explicit counts (+ placement
 * bias) instead of deriving; `desks` still scale to the headcount so the open
 * field fills the plate. Desk type → `bench_pairs`, desk size → `desk_w/h`.
 */
export function programSpecToProgram(spec: ProgramSpec, base: Program = DEFAULT_PROGRAM): Program {
  const rooms: RoomReq[] = []
  for (const def of ROOM_DEFS) {
    const count = spec.counts[def.kind] ?? 0
    if (count <= 0) continue
    const placement: Placement | undefined =
      def.group === 'offices' || def.group === 'team' || def.group === 'conference'
        ? spec.placements[def.group]
        : undefined
    rooms.push({ kind: def.space, count, w: def.w, d: def.d, ...(placement ? { placement } : {}) })
  }
  const desk = deskFootprint(spec.deskSize)
  return {
    ...base,
    headcount: spec.headcount,
    desks: Math.max(1, Math.round(spec.headcount * OPEN_SHARE)),
    // Explicit rooms carry the whole room program (meetings included), so the
    // derived support program + meeting override are switched off.
    support_spaces: false,
    meeting_rooms: 0,
    bench_pairs: spec.deskType === 'bench',
    desk_w: desk.w,
    desk_h: desk.d,
    rooms,
  }
}

/** One-line summary of a spec, for notices. */
export function specSummary(spec: ProgramSpec): string {
  const t = specTotals(spec)
  return `${t.enclosedRooms} enclosed room${t.enclosedRooms === 1 ? '' : 's'} · ${
    Math.round(spec.headcount * OPEN_SHARE)
  } desks · ${spec.headcount} people`
}
