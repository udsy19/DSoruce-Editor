// AI-suggested program from an imported plan's own furniture: the drawing
// already encodes its program — count the actual workstations and meeting
// clusters instead of guessing desks from floor area. Pure, no wasm, no DOM.

import type { Drawing, FurnitureItem } from '../import/types'
import type { Program } from '../editor/EditorCanvas'
import { bankCategoryForItem } from '../materialBank/office'

/** Bank-categories that ARE a workstation (one item = one desk position). */
const DESK_CATEGORIES = new Set(['desk', 'workstation-bench'])
/** Names that mark meeting-room furniture regardless of bank bucket. */
const MEETING_NAME = /\b(conference|meeting|board(?:room)?)\b/i
/** Two meeting items closer than this belong to the same room cluster. */
const MEETING_CLUSTER_LINK_M = 2.5
/** Area fallback when the plan carries no countable furniture (≈ NBC business occupancy). */
const M2_PER_DESK = 12
const M2_PER_MEETING_ROOM = 200

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const center = (f: FurnitureItem): [number, number] => [
  (f.bbox[0] + f.bbox[2]) / 2,
  (f.bbox[1] + f.bbox[3]) / 2,
]

/** Single-linkage cluster count over item centers (union-find, O(n²) — fine at plan scale). */
function clusterCount(items: FurnitureItem[], linkM: number): number {
  const pts = items.map(center)
  const parent = pts.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const link2 = linkM * linkM
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0]
      const dy = pts[i][1] - pts[j][1]
      if (dx * dx + dy * dy <= link2) {
        const a = find(i)
        const b = find(j)
        if (a !== b) parent[a] = b
      }
    }
  }
  const roots = new Set<number>()
  for (let i = 0; i < pts.length; i++) roots.add(find(i))
  return roots.size
}

/**
 * Derive a Program from the drawing's own furniture, on top of `current`:
 * - desks: count of workstation/desk/bench items (each is one desk position);
 *   if the plan draws none, task chairs stand in (one chair = one position);
 *   if neither, fall back to the plate-area heuristic. Clamped to [10, 300].
 * - meeting_rooms: spatial clusters of conference/meeting furniture — a table
 *   plus its chairs fuse into one cluster ≈ one room; separate rooms sit
 *   farther apart than MEETING_CLUSTER_LINK_M. Clamped to [1, 12].
 */
export function suggestProgram(drawing: Drawing, plateAreaM2: number, current: Program): Program {
  const items = drawing.furniture

  // --- desks -------------------------------------------------------------
  const deskItems = items.filter((f) => DESK_CATEGORIES.has(bankCategoryForItem(f)))
  let desks = deskItems.length
  if (desks === 0) {
    // No explicit desks drawn — non-meeting task chairs mark the positions.
    desks = items.filter(
      (f) => bankCategoryForItem(f) === 'task-chair' && !MEETING_NAME.test(f.name),
    ).length
  }
  if (desks === 0) desks = Math.round(plateAreaM2 / M2_PER_DESK)
  desks = clamp(Math.round(desks), 10, 300)

  // --- meeting rooms -------------------------------------------------------
  const meetingItems = items.filter(
    (f) => MEETING_NAME.test(f.name) || bankCategoryForItem(f) === 'meeting-table',
  )
  let meeting_rooms =
    meetingItems.length > 0
      ? clusterCount(meetingItems, MEETING_CLUSTER_LINK_M)
      : Math.round(plateAreaM2 / M2_PER_MEETING_ROOM)
  meeting_rooms = clamp(Math.round(meeting_rooms), 1, 12)

  return { ...current, desks, meeting_rooms }
}

/** One-line human summary of a suggested program, for notices/toasts. */
export function suggestProgramSummary(p: Program): string {
  return `Suggested from the plan: ${p.desks} desks · ${p.meeting_rooms} meeting room${
    p.meeting_rooms === 1 ? '' : 's'
  }`
}
