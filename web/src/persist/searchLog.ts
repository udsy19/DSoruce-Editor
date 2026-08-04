// What the test-fit search actually SPENT — the sensor for ADR 0005's trigger.
//
// A TRIGGER WITHOUT A SENSOR IS A WISH. ADR 0005 filed two product decisions
// behind triggers ("revisit when a plate is found where seed 1 does not clear the
// target", "revisit when candidate diversity becomes a priority") and neither
// could ever fire, because nobody was watching. This watches.
//
// The thing worth watching, measured: on the real plate the production default
// (`maxIter 18`, `target 82`) spends SIX generate calls, not the 57 the config
// implies, because every strategy clears the target on its first draw. A plate
// where that stops being true silently turns a 129 ms search into a 1.9 s one.
// `earlyExitStrategies.length < 3` is exactly that alarm.
//
// It also counts Regenerate presses, which is the demand signal the diversity
// decision needs — ADR 0005 measured that Regenerate re-serves the same three
// plans, so how often users reach for it is the other half of that trade.

import { dbPut, dbGetAll, dbDel } from './db'
import { isRealSession } from './plateLog'

export const SEARCH_LOG_SCHEMA = 1

export interface SearchLogEntry {
  at: string
  schema?: number
  /** `generate()` calls actually made. */
  calls: number
  /** Strategies that stopped early. Fewer than 3 ⇒ a real search ran. */
  earlyExitStrategies: string[]
  /** The allowance, for comparison against `calls` — config is not conduct. */
  maxIter: number
  target: number
  /** Best score reached, so a slow search can be judged against what it bought. */
  bestTotal: number
  /** 0 = first generate; ≥1 = a Regenerate press, the diversity demand signal. */
  regenerateRound: number
  plateAreaM2?: number
  ms?: number
}

/** Never throws, and never records automated sessions (see `isRealSession`). */
export async function logSearch(entry: SearchLogEntry): Promise<void> {
  if (!isRealSession()) return
  try {
    await dbPut('searchLog', { ...entry, schema: SEARCH_LOG_SCHEMA })
  } catch {
    /* telemetry must not break a generate */
  }
}

export async function listSearchLog(): Promise<SearchLogEntry[]> {
  try {
    const all = (await dbGetAll('searchLog')) as SearchLogEntry[]
    const trusted = all.filter((r) => (r.schema ?? 0) >= SEARCH_LOG_SCHEMA)
    if (trusted.length !== all.length) {
      for (const r of all) if ((r.schema ?? 0) < SEARCH_LOG_SCHEMA) await dbDel('searchLog', r.at)
    }
    return trusted
  } catch {
    return []
  }
}

/** Has either ADR 0005 trigger fired? Read this, don't re-derive it. */
export async function searchTriggers(): Promise<{
  realSearchRan: boolean
  slowestMs: number
  regeneratePresses: number
  runs: number
}> {
  const rows = await listSearchLog()
  return {
    // A plate where seed 1 did NOT clear the target — the silent-latency case.
    realSearchRan: rows.some((r) => r.earlyExitStrategies.length < 3),
    slowestMs: rows.reduce((m, r) => Math.max(m, r.ms ?? 0), 0),
    regeneratePresses: rows.filter((r) => r.regenerateRound > 0).length,
    runs: rows.length,
  }
}

export async function exportSearchLog(): Promise<string> {
  const rows = await listSearchLog()
  return JSON.stringify(
    { format: 'dsource-search-log', version: SEARCH_LOG_SCHEMA, exportedAt: new Date().toISOString(), rows },
    null,
    2,
  )
}
