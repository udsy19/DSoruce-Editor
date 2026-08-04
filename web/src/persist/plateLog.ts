// The plate-provenance calibration log.
//
// The confidence thresholds that decide whether a plate is auto-accepted or
// proposed for confirmation (`PHANTOM_MAX_FOR_HIGH = 0.15`, containment 0.98)
// were fitted to 15 fixtures, 14 of them from one synthetic generator we wrote
// ourselves. That is enough to launch — the sweep band is wide and a CI test
// freezes it — but it is not a real-world calibration set.
//
// This records what the ladder actually produced on every real import, and what
// the user then did about it, so a future recalibration has evidence instead of
// more synthetics. Per ADR 0003: **promotion of any inference rung to high
// confidence comes from this log only** — never from fixtures, because we build
// the fixtures.
//
// TELEMETRY, NOT DOCUMENT STATE. It stays in IndexedDB and is exported by hand.
// It must never ride inside a `.dsource` file: that would leak one user's import
// history into a shared document. Per-document provenance — the plate the user
// accepted — lives in the file instead (`persist/file.ts`).
//
// Possible follow-up, deliberately NOT built: an opt-in POST to the VPS backend
// once that is in the loop.

import { dbPut, dbGetAll, dbDel } from './db'
import type { PlateProvenance } from '../import/plateQuality'

/**
 * Bumped when the log's trustworthiness rules change. Rows written before the
 * real-session gate existed cannot be shown to have come from a human, so they
 * are unverifiable and `listPlateLog` deletes them on sight rather than letting
 * them count as evidence.
 */
export const PLATE_LOG_SCHEMA = 3

export interface PlateLogEntry {
  /** ISO timestamp — the store's key path. */
  at: string
  /** Trust-rule version this row was written under. Absent ⇒ pre-gate ⇒ dropped. */
  schema?: number
  /** How the boundary was derived and how far it could be trusted. */
  provenance: PlateProvenance
  /** Plate area (m²) as proposed. */
  areaM2: number
  /** Furniture items in the drawing, and how many the proposed plate contained. */
  furnitureTotal: number
  furnitureInside: number
  /** Source drawing shape, for grouping the log by drawing kind later. */
  entityCount: number
  layerCount: number
  /**
   * What the user did with a low-confidence draft. `pending` until they act, so
   * an abandoned import is distinguishable from an accepted one.
   *
   * THIS is the field a recalibration reads: a rung whose drafts are accepted
   * unedited at a high rate has earned promotion; one whose drafts are always
   * redrawn has not.
   */
  outcome: 'auto-accepted' | 'pending' | 'confirmed-unedited' | 'confirmed-edited' | 'redrawn'
  /** Area after the user's edit, when they changed it — the size of our error. */
  acceptedAreaM2?: number
}

/**
 * **The calibration log records humans only.** An automated agent driving the
 * wizard is not a user accepting a boundary, and every E2E run of the confirm
 * flow would otherwise append another `confirmed-unedited` — manufacturing
 * exactly the promotion evidence ADR 0003 forbids manufacturing, in the one
 * store that exists to be non-synthetic.
 *
 * DETECTING automation was tried first and failed in practice: `navigator.
 * webdriver` reads `false` under a Playwright session that attaches to an
 * ordinary Chrome over CDP rather than launching with automation flags, and a
 * live run of the confirm flow wrote a row anyway. Detection is an arms race
 * that fails open, which is the wrong direction for evidence.
 *
 * So the gate is inverted: require POSITIVE proof of a human. A trusted input
 * event is one the browser itself generated from real hardware —
 * `Event.isTrusted` cannot be forged from page script, so a synthetic
 * `element.click()` or dispatched event never refreshes this.
 *
 * Residual risk, stated rather than papered over: automation that drives real
 * CDP input (Playwright's own `page.click()`) produces trusted events and would
 * still register. Distinguishing that from a human is not solvable in-page. What
 * this does guarantee is that no script-driven flow — which is how these tests
 * and every `evaluate()` harness work — can contribute evidence.
 */
const TRUSTED_INPUT_WINDOW_MS = 30_000
let lastTrustedInputAt = 0

if (typeof window !== 'undefined') {
  const mark = (e: Event) => {
    if (e.isTrusted) lastTrustedInputAt = Date.now()
  }
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, mark, { capture: true, passive: true })
  }
}

export function isRealSession(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (navigator.webdriver) return false
  try {
    if (import.meta.env?.DEV) return false
  } catch {
    /* no import.meta in this context — fall through */
  }
  // A decision only counts if a real hand was on the machine to make it.
  return Date.now() - lastTrustedInputAt < TRUSTED_INPUT_WINDOW_MS
}

/** Record a proposed plate. Never throws: telemetry must not break an import. */
export async function logPlate(entry: PlateLogEntry): Promise<void> {
  if (!isRealSession()) return
  try {
    await dbPut('plateLog', { ...entry, schema: PLATE_LOG_SCHEMA })
  } catch {
    /* a full or unavailable IndexedDB is not a reason to fail the import */
  }
}

/** Update the outcome of the most recent entry once the user has acted. */
export async function recordPlateOutcome(
  outcome: PlateLogEntry['outcome'],
  acceptedAreaM2?: number,
): Promise<void> {
  if (!isRealSession()) return
  try {
    const all = (await dbGetAll('plateLog')) as PlateLogEntry[]
    const last = all[all.length - 1]
    if (!last) return
    await dbPut('plateLog', { ...last, outcome, acceptedAreaM2 })
  } catch {
    /* see logPlate */
  }
}

/**
 * Every row the log will admit as evidence. Self-healing: rows written before
 * the real-session gate existed are deleted here, because nothing about them can
 * establish a human made the decision — including the entry an automated
 * confirm-flow run left behind when this store first shipped.
 */
export async function listPlateLog(): Promise<PlateLogEntry[]> {
  try {
    const all = (await dbGetAll('plateLog')) as PlateLogEntry[]
    const trusted = all.filter((r) => (r.schema ?? 0) >= PLATE_LOG_SCHEMA)
    if (trusted.length !== all.length) {
      for (const r of all) {
        if ((r.schema ?? 0) < PLATE_LOG_SCHEMA) await dbDel('plateLog', r.at)
      }
    }
    return trusted
  } catch {
    return []
  }
}

/** Manual export — the log is only useful if it can leave the browser. */
export async function exportPlateLog(): Promise<string> {
  const rows = await listPlateLog()
  return JSON.stringify(
    { format: 'dsource-plate-log', version: 1, exportedAt: new Date().toISOString(), rows },
    null,
    2,
  )
}

export async function clearPlateLog(): Promise<void> {
  try {
    for (const row of await listPlateLog()) await dbDel('plateLog', row.at)
  } catch {
    /* see logPlate */
  }
}
