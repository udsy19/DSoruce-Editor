// Workflow-aware room resolution — the assistant's room vocabulary.
//
// A user talks about rooms the way they see them on the plan: by label
// ("the boardroom", "Meeting Room 3"), by the room number they dropped as a
// marker ("room 502", "502"), or by a spoken synonym ("the kitchen", "the open
// plan"). This module turns that spoken reference into the concrete zone it
// means, and can describe a room in plain language (type · area · pax · what's
// inside). Both the deterministic LocalDriver and the LLM system prompt speak
// through it, so the vocabulary is defined once.

import type { ZoneType } from '../editor/EditorCanvas'

/** A zone enriched with everything the assistant needs to talk about it: the
 *  user's room number (from a dropped marker), its measured area/pax, and the
 *  furniture inside it. All facets past id/type/label are optional so a caller
 *  that only has the base zone list still type-checks. */
export interface RoomInfo {
  id: number
  zone_type: ZoneType
  label: string
  /** User reference / room number from a marker (e.g. "502"), if one sits inside. */
  ref?: string
  /** Usable area, m². */
  area?: number
  /** Seating/pax capacity. */
  capacity?: number
  /** People currently seated (placed workstations/chairs). */
  seated?: number
  /** Furniture inside the room, grouped by category with counts. */
  components?: { category: string; count: number }[]
}

/** Plain-language name for a zone type — how a person would say it. */
export const ZONE_TYPE_NAME: Record<ZoneType, string> = {
  Circulation: 'circulation / walking space',
  Workspace: 'open workspace',
  Meeting: 'meeting room',
  Collaboration: 'collaboration space',
  Core: 'service core',
  ClosedOffice: 'private office',
  Amenity: 'amenity space',
}

/** Spoken synonyms → the zone type they most likely mean. Longest phrase first
 *  so "board room" beats "room". Only consulted after label/number matching. */
const SYNONYMS: [string, ZoneType][] = [
  ['boardroom', 'Meeting'],
  ['board room', 'Meeting'],
  ['conference room', 'Meeting'],
  ['conference', 'Meeting'],
  ['meeting room', 'Meeting'],
  ['meeting', 'Meeting'],
  ['open workspace', 'Workspace'],
  ['open plan', 'Workspace'],
  ['open office', 'Workspace'],
  ['workspace', 'Workspace'],
  ['bullpen', 'Workspace'],
  ['desk area', 'Workspace'],
  ['collaboration', 'Collaboration'],
  ['collab', 'Collaboration'],
  ['breakout', 'Collaboration'],
  ['lounge', 'Collaboration'],
  ['phone booth', 'Collaboration'],
  ['private office', 'ClosedOffice'],
  ['closed office', 'ClosedOffice'],
  ['cabin', 'ClosedOffice'],
  ['office', 'ClosedOffice'],
  ['kitchen', 'Amenity'],
  ['pantry', 'Amenity'],
  ['cafe', 'Amenity'],
  ['canteen', 'Amenity'],
  ['reception', 'Amenity'],
  ['amenity', 'Amenity'],
  ['server room', 'Core'],
  ['it room', 'Core'],
  ['core', 'Core'],
]

/**
 * Resolve a spoken room reference to the room it means, or null if nothing
 * matches. Resolution order (most specific first):
 *   1. room number  — a marker ref appearing as a word ("502", "room 502")
 *   2. label        — the zone's own label as a substring ("meeting room 3")
 *   3. synonym      — a spoken type word mapping to the best room of that type
 * `excludeType` skips synonym matches to that type — used by "make X a <type>"
 * so the target type ("…a Collaboration zone") never steals the subject room.
 */
export function resolveRoomRef(
  text: string,
  rooms: RoomInfo[],
  opts?: { excludeType?: ZoneType },
): RoomInfo | null {
  const t = text.toLowerCase()

  // 1. Room number (marker ref). Match as a whole word so "5" ≠ "502".
  for (const r of rooms) {
    if (!r.ref) continue
    const ref = r.ref.toLowerCase()
    if (new RegExp(`\\b${escapeRe(ref)}\\b`).test(t)) return r
  }

  // 2. Label substring — longest label first so "Meeting Room 3" beats "Meeting".
  const byLen = [...rooms].sort((a, b) => b.label.length - a.label.length)
  for (const r of byLen) {
    if (r.label && t.includes(r.label.toLowerCase())) return r
  }

  // 3. Synonym → best (largest) room of that type. Latest-mention wins so
  //    "the kitchen" resolves the amenity even if an earlier word matched.
  let bestType: ZoneType | null = null
  let bestIdx = -1
  for (const [word, type] of SYNONYMS) {
    if (opts?.excludeType && type === opts.excludeType) continue
    const idx = t.lastIndexOf(word)
    if (idx > bestIdx) {
      bestIdx = idx
      bestType = type
    }
  }
  if (bestType) {
    const ofType = rooms.filter((r) => r.zone_type === bestType)
    if (ofType.length > 0) {
      // Prefer the biggest of that type (the "boardroom" is the largest meeting room).
      return ofType.reduce((a, b) => ((b.area ?? 0) > (a.area ?? 0) ? b : a))
    }
  }
  return null
}

/** One-line, human-readable answer describing a room: type · number · area ·
 *  pax · what's inside. Used for "tell me about the boardroom". */
export function describeRoom(r: RoomInfo): string {
  const name = r.ref ? `“${r.label}” (Room ${r.ref})` : `“${r.label}”`
  const typeName = ZONE_TYPE_NAME[r.zone_type]
  const bits: string[] = [`${name} is ${article(typeName)} ${typeName}.`]
  if (r.area != null && r.area > 0) bits.push(`Area about ${r.area.toFixed(0)} m².`)
  if (r.capacity != null && r.capacity > 0) {
    bits.push(
      r.seated != null && r.seated > 0
        ? `Capacity ~${r.capacity} (${r.seated} seated now).`
        : `Capacity ~${r.capacity}.`,
    )
  }
  const inside = (r.components ?? []).filter((c) => c.count > 0)
  if (inside.length > 0) {
    const list = inside
      .slice(0, 5)
      .map((c) => `${c.count}× ${c.category}`)
      .join(', ')
    bits.push(`Inside: ${list}.`)
  } else {
    bits.push('Nothing placed inside it yet.')
  }
  return bits.join(' ')
}

function article(word: string): 'a' | 'an' {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
