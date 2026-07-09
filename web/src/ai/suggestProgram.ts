// A FRESH test-fit's program is derived from the plate's AREA / HEADCOUNT at the
// professional design density — it is open-plan-dominant and sized to the
// building, NOT inherited from the imported drawing's own furniture. The old
// drawing IS the layout we're replacing, so counting its conference-table
// clusters over-counted meeting rooms (the user's building traced ~11 clusters →
// 11 generic meeting rooms stacked on top of the derived support program, giving
// ~31 rooms but only ~14 open desks — the opposite of a real office). Pure, no
// wasm, no DOM.

import type { Drawing } from '../import/types'
import type { Program } from '../editor/EditorCanvas'
import { bankCategoryForItem } from '../materialBank/office'

/** Bank-categories that ARE a workstation (one item = one desk position). */
const DESK_CATEGORIES = new Set(['desk', 'workstation-bench'])
/** BCO 2023 / NBC 2016 design occupancy for general workspace (m²/person). */
const M2_PER_PERSON = 10
/** Open-plan share of headcount seated at open workstations. 0.90 mirrors the
 *  Rust `OPEN_SHARE` (raised from 0.85 in the lean qbiq-dominant recalibration:
 *  the reference floor runs ~0.95 open) so the desks the panel suggests match
 *  the desk target the generator fills to. */
const OPEN_SHARE = 0.9
/** People per meeting room — the realistic office ratio (~1 per 15–20), NOT the
 * old ~1 per detected furniture cluster which doubled the room count. */
const PEOPLE_PER_MEETING = 17
/** Meeting-room bounds: even a small floor wants a couple; a big one stays modest
 * because the derived support program already adds 4P/6–8P/board rooms. */
const MIN_MEETINGS = 2
const MAX_MEETINGS = 6

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Design headcount the plate holds at the professional density (10 m²/person),
 *  clamped to a sane 4–400. The single source both the Space→Program prefill and
 *  the Concept "generate from headcount" default reuse (workflow.md §3.4). */
export function headcountForArea(plateAreaM2: number): number {
  return clamp(Math.round(plateAreaM2 / M2_PER_PERSON), 4, 400)
}

/**
 * Derive a fresh, open-plan-dominant Program from the plate, on top of `current`:
 * - headcount: the plate filled to the professional design density (10 m²/person)
 *   — set explicitly so the Rust generator derives the SAME support program (spec
 *   §1.1) from this N instead of guessing it.
 * - desks: the open-plan share of the headcount (0.85·N), scaled to fill the
 *   plate. The drawing's own workstations act only as a FLOOR — a genuinely
 *   denser imported plan is honoured, but a sparse old fit-out never under-seats
 *   the new one.
 * - meeting_rooms: ~1 per {@link PEOPLE_PER_MEETING} people, clamped modest — NOT
 *   one per conference cluster detected in the OLD layout.
 */
export function suggestProgram(drawing: Drawing, plateAreaM2: number, current: Program): Program {
  const headcount = headcountForArea(plateAreaM2)

  const drawnDesks = drawing.furniture.filter((f) => DESK_CATEGORIES.has(bankCategoryForItem(f))).length
  const desks = clamp(Math.round(Math.max(headcount * OPEN_SHARE, drawnDesks)), 10, 400)

  const meeting_rooms = clamp(Math.round(headcount / PEOPLE_PER_MEETING), MIN_MEETINGS, MAX_MEETINGS)

  return { ...current, headcount, desks, meeting_rooms }
}

/** One-line human summary of a suggested program, for notices/toasts. */
export function suggestProgramSummary(p: Program): string {
  return `Suggested from the plan: ${p.desks} desks · ${p.meeting_rooms} meeting room${
    p.meeting_rooms === 1 ? '' : 's'
  }`
}
