// Autosave ring over the "history" object store — design: docs/design/plan-library.md
// §2/§4. Policy: debounce 5 s after the last mutation, hard cap one entry per
// 30 s, skip when the snapshot string-equals the newest stored entry, ring
// capped at 30 (oldest deleted on insert). Entries deliberately exclude
// `drawing` and thumbs (§2 budget) — the DXF drawing changes only on import,
// and hover thumbs render lazily from the snapshot.

import type { Program } from '../types/program'
import type { EditorCanvas } from '../editor/EditorCanvas'
import { DEFAULT_PROGRAM } from '../types/program'
import { dbDel, dbGetAll, dbPut } from './db'

/** One record in the "history" store (keyPath "at" — naturally time-ordered). */
export interface HistoryEntry {
  at: number // Date.now(), also the key
  snapshot: string // ec.snapshot()
  program: Program
  reason: 'edit' | 'generate' | 'restore' // for list labels
}

const DEBOUNCE_MS = 5_000
const MIN_INTERVAL_MS = 30_000
const RING_MAX = 30

let timer: ReturnType<typeof setTimeout> | null = null
let pendingReason: HistoryEntry['reason'] = 'edit'
/** `at` of the last entry this session wrote — anchors the 30 s hard cap. */
let lastWriteAt = 0

/** Snapshot now, dedupe against the newest entry, insert, evict beyond the ring. */
async function capture(ec: EditorCanvas, reason: HistoryEntry['reason']): Promise<void> {
  const snapshot = ec.snapshot()
  const entries = await dbGetAll<HistoryEntry>('history') // ascending `at`
  const newest = entries[entries.length - 1]
  if (newest && newest.snapshot === snapshot) return // nothing changed — skip
  // Guard the keyPath against same-ms collisions (e.g. restore right after an edit).
  const at = Math.max(Date.now(), (newest?.at ?? 0) + 1)
  await dbPut<HistoryEntry>('history', { at, snapshot, program: { ...ec.program }, reason })
  lastWriteAt = at
  for (const old of entries.slice(0, Math.max(0, entries.length + 1 - RING_MAX))) {
    await dbDel('history', old.at)
  }
}

/**
 * Record a mutation (wire from `ec.onChange`). Debounced 5 s after the last
 * call; the write is additionally pushed out so entries land at most once
 * per 30 s. Quiet by construction: `onChange` fires only on real mutations.
 */
export function noteChange(ec: EditorCanvas, reason: HistoryEntry['reason']): void {
  if (timer !== null) clearTimeout(timer)
  pendingReason = reason
  const delay = Math.max(DEBOUNCE_MS, lastWriteAt + MIN_INTERVAL_MS - Date.now())
  timer = setTimeout(() => {
    timer = null
    void capture(ec, pendingReason)
  }, delay)
}

/** All autosaves, newest first. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const entries = await dbGetAll<HistoryEntry>('history')
  return entries.sort((a, b) => b.at - a.at)
}

/**
 * Rewind to `e` — but FIRST autosave the current state (immediate, bypassing
 * debounce and the 30 s cap) with reason 'restore', so restoring is itself
 * undoable from the history list.
 */
export async function restoreEntry(ec: EditorCanvas, e: HistoryEntry): Promise<void> {
  if (timer !== null) {
    // The pending capture would fire after the rewind and record the wrong doc.
    clearTimeout(timer)
    timer = null
  }
  await capture(ec, 'restore')
  ec.restore(e.snapshot)
  ec.program = { ...DEFAULT_PROGRAM, ...e.program }
}
