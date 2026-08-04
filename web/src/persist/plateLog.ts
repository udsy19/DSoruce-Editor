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

export interface PlateLogEntry {
  /** ISO timestamp — the store's key path. */
  at: string
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

/** Record a proposed plate. Never throws: telemetry must not break an import. */
export async function logPlate(entry: PlateLogEntry): Promise<void> {
  try {
    await dbPut('plateLog', entry)
  } catch {
    /* a full or unavailable IndexedDB is not a reason to fail the import */
  }
}

/** Update the outcome of the most recent entry once the user has acted. */
export async function recordPlateOutcome(
  outcome: PlateLogEntry['outcome'],
  acceptedAreaM2?: number,
): Promise<void> {
  try {
    const all = (await dbGetAll('plateLog')) as PlateLogEntry[]
    const last = all[all.length - 1]
    if (!last) return
    await dbPut('plateLog', { ...last, outcome, acceptedAreaM2 })
  } catch {
    /* see logPlate */
  }
}

export async function listPlateLog(): Promise<PlateLogEntry[]> {
  try {
    return (await dbGetAll('plateLog')) as PlateLogEntry[]
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
