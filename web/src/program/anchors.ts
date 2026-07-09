// Anchor pins — design: docs/design/workflow.md §3.5 (Slice 6). qbiq's "Place
// on Plan": pick a room type, click the plan to FORCE that room onto the spot —
// and bump its count. An anchor is a DRAFT-level entity pinned to a point
// (drawing/source coords), distinct from a §3.2 room marker: a marker only
// LABELS a detected room (a ref number, Space step); an anchor DRIVES the
// generator (a core `SpaceKind`, Program step) and is pushed into the document.
//
// The generator consumes anchors as position-pinned rooms placed FIRST: an
// anchor of kind K consumes one of K's requested count, or adds one if the
// program didn't ask for K (Rust `layout::generate` / `Editor.add_anchor`).

import type { SpaceKind } from '../editor/EditorCanvas'

export interface AnchorPin {
  id: string
  /** Core room type forced onto the plan (mirrors Rust `SpaceKind`). */
  kind: SpaceKind
  /** Drop point in drawing/source coords, meters (Y-up), same space as Drawing. */
  x: number
  y: number
}

/** The anchor vocabulary shown in the Program-step dropdown, in display order.
 *  A curated subset of `SpaceKind` (1:1) so a pin maps to exactly one room. */
export const ANCHOR_KINDS: { value: SpaceKind; label: string }[] = [
  { value: 'Reception', label: 'Reception' },
  { value: 'Cabin', label: 'Private office' },
  { value: 'Meeting', label: 'Meeting room' },
  { value: 'Boardroom', label: 'Boardroom' },
  { value: 'Focus', label: 'Focus room' },
  { value: 'PhoneBooth', label: 'Phone booth' },
  { value: 'Collab', label: 'Collaboration' },
  { value: 'Pantry', label: 'Kitchen / pantry' },
  { value: 'Wellness', label: 'Wellness' },
  { value: 'Storage', label: 'Storage / IT' },
]

/** Display label for a `SpaceKind` anchor (falls back to the raw kind). */
export function anchorKindLabel(kind: SpaceKind): string {
  return ANCHOR_KINDS.find((k) => k.value === kind)?.label ?? kind
}
