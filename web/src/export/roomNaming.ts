// ---------------------------------------------------------------------------
// roomNaming.ts — THE one place a room's PRINTED NAME is decided.
//
// Two jobs, both cross-cutting, both previously done nowhere:
//
//   1. `roomDisplayNames` — disambiguation.  The core generator can hand the
//      drawing layer several zones with the SAME label (the DWG case: zones
//      246 / 247 / 248 are all "Open Workspace", while 154 / 208 / 211 / 214
//      already carry "(1)"…"(4)" from `crates/ds-core/src/layout.rs:4340`).  A
//      drawing that prints one name for three rooms is unreadable and its
//      schedules are unusable, so the drawing layer numbers them — ONCE, here,
//      so the plan, the sheets, the finish schedule and the QTO workbook cannot
//      disagree about what a room is called.
//
//   2. `roomLabelForms` + `ROOM_ABBREVIATIONS` — the fit ladder.  A label that
//      cannot be placed at full size steps down through a fixed, deterministic
//      series of smaller forms.  Every rung either preserves the name exactly or
//      shortens it through the SINGLE shared abbreviation map below — never by
//      ellipsis, never mid-word, never as a fragment.
//
// Everything here is pure and deterministic (no clock, no random, no float
// accumulation): the same document always yields the same names and the same
// ladder, which is what the byte-for-byte determinism gates require.
//
// @example
//   const names = roomDisplayNames(state)          // zone id → printed name
//   const name  = names.get(z.id) ?? z.label
//   for (const form of roomLabelForms(name.toUpperCase(), 7.5, measure)) { … }
// ---------------------------------------------------------------------------

import type { DocState } from '../types/doc'
import { isGroundZone } from '../types/doc'

// ---------------------------------------------------------------------------
// 1. Display names — deterministic ordinals over duplicate room names
// ---------------------------------------------------------------------------

/**
 * The ONE suffix grammar the whole deliverable uses: a trailing ` (n)`.
 *
 * It is the generator's own grammar (`format!("Open Workspace ({})", n)`), which
 * is why stripping it is what makes this helper IDEMPOTENT: a label that already
 * ends in an ordinal is reduced to its base before a new ordinal is assigned, so
 * `display(display(x)) === display(x)` and no room can ever end up
 * "Open Workspace (1) (1)".
 */
const ORDINAL = /\s+\((\d+)\)\s*$/

/** A label with any trailing ` (n)` ordinal removed. `"Open Workspace (2)"` →
 *  `"Open Workspace"`; `"Meeting Room 3"` is unchanged (a bare trailing number
 *  is part of the generator's name, not an ordinal). */
function roomBaseName(label: string): string {
  return label.replace(ORDINAL, '').trim()
}

/**
 * Every scheduled room's PRINTED name, keyed by zone id.
 *
 * The rule, in full:
 *
 *   * rooms are grouped by their BASE name (`roomBaseName`), over every
 *     non-circulation zone in the document — not over one sheet's subset — so
 *     that the plan (which drops `Core` zones), the finish schedule (which keeps
 *     them) and the workbook all derive the identical name for a given room;
 *   * a group of ONE keeps its label exactly as the core state gave it,
 *     ordinal and all.  Nothing is renamed that was not ambiguous;
 *   * a group of MORE THAN ONE is numbered `base (1)`, `base (2)`, … in
 *     ROOM ID ORDER.  Room id is the document's own stable ordering, so the
 *     ordinal is reproducible from the document alone — a gate can predict it
 *     without reading a single drawing.
 *
 * On the DWG pack the seven "Open Workspace" zones (154, 208, 211, 214, 246,
 * 247, 248) become (1)…(7), and because the generator itself numbers in
 * creation order, the four rooms it had already numbered keep the numbers they
 * came with — measured, not assumed.
 *
 * Returned map contains ONLY the rooms whose printed name is decided here (the
 * ambiguous ones); callers keep their own empty-label fallbacks:
 * `displayNames.get(z.id) ?? (z.label || …)`.
 */
export function roomDisplayNames(state: DocState): Map<number, string> {
  const zones = (state.zones ?? [])
    .filter((z) => !isGroundZone(z.zone_type) && !!(z.label && z.label.trim()))
    .sort((a, b) => a.id - b.id)

  const groups = new Map<string, { id: number }[]>()
  for (const z of zones) {
    const base = roomBaseName(z.label)
    if (!base) continue
    const g = groups.get(base)
    if (g) g.push({ id: z.id })
    else groups.set(base, [{ id: z.id }])
  }

  const out = new Map<number, string>()
  for (const [base, members] of groups) {
    if (members.length < 2) continue
    members.forEach((m, i) => out.set(m.id, `${base} (${i + 1})`))
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. The abbreviation map — one vocabulary, every sheet
// ---------------------------------------------------------------------------

/**
 * The ONE abbreviation ladder for room names.  Exported so that every sheet
 * that may have to shorten a name shortens it the SAME way: a room that reads
 * "PH BOOTH 2" on the ceiling plan cannot read "PHB 2" on the power plan.
 *
 * `match` is tested against the room's base phrase (the name with its trailing
 * instance number / ordinal removed), case-insensitively and whole.  `short` is
 * tier 1, `shortest` is tier 2.  Both are whole words — this map never yields a
 * fragment, and nothing here ellipsizes.
 *
 * Ordered longest-phrase-first so "MEETING ROOM" wins over "MEETING".
 */
export const ROOM_ABBREVIATIONS: ReadonlyArray<{ match: string; short: string; shortest: string }> = [
  { match: 'PHONE BOOTH', short: 'PH BOOTH', shortest: 'PB' },
  { match: 'OPEN WORKSPACE', short: 'OPEN WS', shortest: 'OWS' },
  { match: 'MEETING ROOM', short: 'MTG ROOM', shortest: 'MR' },
  { match: 'CONFERENCE ROOM', short: 'CONF ROOM', shortest: 'CR' },
  { match: 'WELLNESS ROOM', short: 'WELLNESS', shortest: 'WR' },
  { match: 'PRINT POINT', short: 'PRINT PT', shortest: 'PP' },
  { match: 'FOCUS ROOM', short: 'FOCUS', shortest: 'FR' },
  { match: 'IT / SERVER', short: 'IT/SVR', shortest: 'IT' },
  { match: 'SERVICE CORE', short: 'CORE', shortest: 'CO' },
  { match: 'COLLABORATION', short: 'COLLAB', shortest: 'CLB' },
  { match: 'RECEPTION', short: 'RECEPTION', shortest: 'RCPN' },
  { match: 'BOARDROOM', short: 'BOARD', shortest: 'BR' },
  { match: 'STORAGE', short: 'STORE', shortest: 'STR' },
  { match: 'WORKSPACE', short: 'WORK', shortest: 'WS' },
  { match: 'PANTRY', short: 'PANTRY', shortest: 'PTY' },
]

/** Split a printed name into its base phrase and whatever instance marker
 *  trails it (` 3`, ` (2)`), so abbreviation never eats the number that tells
 *  two rooms apart. */
function splitInstance(name: string): { phrase: string; tail: string } {
  const m = name.match(/\s+(\(\d+\)|\d+)\s*$/)
  return m ? { phrase: name.slice(0, m.index).trim(), tail: ` ${m[1]}` } : { phrase: name.trim(), tail: '' }
}

/**
 * The room name at abbreviation `tier` (1 = short, 2 = shortest), or the name
 * unchanged when the map has no entry for it — an unknown room type is printed
 * in full rather than mangled by a guess.
 *
 * Case follows the input: an all-caps plan label stays all-caps.
 */
export function abbreviateRoomName(name: string, tier: 1 | 2): string {
  const { phrase, tail } = splitInstance(name)
  const hit = ROOM_ABBREVIATIONS.find((a) => a.match === phrase.toUpperCase())
  if (!hit) return name
  const repl = tier === 1 ? hit.short : hit.shortest
  const cased = name === name.toUpperCase() ? repl : repl.charAt(0) + repl.slice(1).toLowerCase()
  return `${cased}${tail}`
}

// ---------------------------------------------------------------------------
// 3. The fit ladder
// ---------------------------------------------------------------------------

/** One rung: the exact text, laid out, at a size. */
export interface LabelForm {
  /** One or two lines. Never a fragment — a wrap only ever happens at a space. */
  lines: string[]
  /** Type size in pt. */
  size: number
  /** Widest line, in pt, as measured by the caller's own measurer. */
  width: number
  /** True when the text is no longer the room's full name. */
  abbreviated: boolean
}

/** The ladder never shrinks type below this fraction of the sheet's base size —
 *  below ~70% a 7.5 pt plan label stops being readable in print. */
const MIN_LABEL_SCALE = 0.7
const SHRINK_STEPS = [1, 0.85, MIN_LABEL_SCALE] as const

/** Split at the space nearest the middle, so neither line dominates. Returns
 *  `null` for a single-word name — a word is NEVER broken. */
function wrapTwo(text: string): [string, string] | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  let best = 1
  let bestDiff = Infinity
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
}

/**
 * The fit ladder for one room label, widest rung first. The caller walks it and
 * takes the FIRST rung it can actually place (see `tryPlaceNear` in sheetSet.ts)
 * — "applied in order until it fits".
 *
 * ORDER, and why it is this order. The rungs are sorted by how much damage they
 * do to the drawing, least first:
 *
 *   1. the full name at full size — no damage;
 *   2. the full name shrunk, to a floor of 70% — the name is still one intact
 *      glyph run, only smaller;
 *   3. the full name wrapped onto two lines — intact, but no longer a single
 *      run, so a reader (and a text extractor) has to join it back up;
 *   4. the abbreviated name, via the one shared map, full size then shrunk —
 *      a second vocabulary on the drawing, which is the thing the deliverable's
 *      naming doctrine (`roomTypeLabel`) exists to avoid, so it goes last.
 *
 * Displacement is NOT a rung: it is orthogonal and free of damage (a displaced
 * label gets a leader back to its room), so the caller tries every position for
 * a rung before stepping down to the next one. That ordering is deliberate and
 * is what keeps a room's printed name recoverable from the sheet whenever the
 * plate has room for it anywhere.
 */
export function roomLabelForms(
  text: string,
  baseSize: number,
  measure: (t: string, size: number) => number,
): LabelForm[] {
  const forms: LabelForm[] = []
  const push = (lines: string[], size: number, abbreviated: boolean) => {
    const width = Math.max(...lines.map((l) => measure(l, size)))
    const last = forms[forms.length - 1]
    // Skip a rung that is no narrower than the one before it (an abbreviation
    // the map does not know, a single-word wrap): the ladder must strictly
    // descend or it is just repeated work.
    if (last && width >= last.width && lines.length >= last.lines.length) return
    forms.push({ lines, size, width, abbreviated })
  }

  for (const s of SHRINK_STEPS) push([text], baseSize * s, false)
  const wrapped = wrapTwo(text)
  if (wrapped) for (const s of SHRINK_STEPS.slice(0, 2)) push([...wrapped], baseSize * s, false)

  for (const tier of [1, 2] as const) {
    const abbr = abbreviateRoomName(text, tier)
    if (abbr === text) continue
    for (const s of [1, MIN_LABEL_SCALE]) push([abbr], baseSize * s, true)
  }
  return forms
}
