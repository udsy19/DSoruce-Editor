// Room markers + reference numbers — design: docs/design/workflow.md §3.2 (Slice 3).
//
// Where CAD detection lacks context, the user drops a typed marker with a room
// number (e.g. "502") so it can be referenced later ("tell the AI about room
// 502") and surface in the takeoff's Room ID column. A marker is a DRAFT-level
// entity pinned to a point (drawing/source coords) — NOT a FurnitureItem
// extension: markers are about rooms, not blocks, and FurnitureItem has no
// room/ref field.
//
// The point→zone association (a marker's ref becoming the Room ID/label of the
// generated zone it falls inside) is computed at read time in App.tsx via
// `zoneAtPoint` (export/takeoff.ts) — re-run on every regenerate, since zones
// are regenerated wholesale with new ids while markers stay pinned to points.

import type { ZoneType } from '../editor/EditorCanvas'

/** The marker vocabulary shown in the Space-step dropdown. Aligns with the
 *  detected/office room language; each maps onto the closed `ZoneType` enum. */
export type RoomType =
  | 'Office'
  | 'Meeting'
  | 'Collab'
  | 'IT-Storage'
  | 'Pantry'
  | 'Reception'
  | 'Mothers-room'
  | 'Focus'
  | 'Phone'

export interface RoomMarker {
  id: string
  /** User reference/room number, e.g. "502". Free-form string (may be edited). */
  ref: string
  type: RoomType
  /** Drop point in drawing/source coords, meters (Y-up), same space as Drawing. */
  x: number
  y: number
}

/** Dropdown options, in display order. */
export const ROOM_TYPES: { value: RoomType; label: string }[] = [
  { value: 'Office', label: 'Office' },
  { value: 'Meeting', label: 'Meeting room' },
  { value: 'Collab', label: 'Collaboration' },
  { value: 'IT-Storage', label: 'IT / Storage' },
  { value: 'Pantry', label: 'Pantry' },
  { value: 'Reception', label: 'Reception' },
  { value: 'Mothers-room', label: "Mother's room" },
  { value: 'Focus', label: 'Focus room' },
  { value: 'Phone', label: 'Phone booth' },
]

/** Map a marker's room type onto a generated `ZoneType` (workflow.md §3.2). */
export const roomTypeToZone: Record<RoomType, ZoneType> = {
  Office: 'ClosedOffice',
  Meeting: 'Meeting',
  Collab: 'Collaboration',
  'IT-Storage': 'Core',
  Pantry: 'Amenity',
  Reception: 'Amenity',
  'Mothers-room': 'Amenity',
  Focus: 'ClosedOffice',
  Phone: 'Collaboration',
}

/** Next auto-suggested reference number: one past the largest numeric ref, or
 *  501 on an empty floor (office-floor room-numbering convention). */
export function nextRoomRef(markers: RoomMarker[]): string {
  let max = 500
  for (const m of markers) {
    const n = parseInt(m.ref, 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max + 1)
}
