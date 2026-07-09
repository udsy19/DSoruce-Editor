// Cloud plan sync — the client loop that mirrors the local IndexedDB plan
// library to the server's /api/plans store, so a user's saved plans follow
// them across devices. Design contract: docs/design/plan-library.md §5.
//
// Shape of the loop (single-user, last-write-wins on `updatedAt`):
//   1. GET the remote plan list (id/name/updatedAt/metrics summaries) FIRST, so
//      push decisions can honour LWW instead of blindly clobbering a newer
//      remote with a stale local record.
//   2. PUSH every local plan that changed since its last sync
//      (`updatedAt > syncedAt`) AND is not older than its remote counterpart,
//      via `POST /api/plans` with the SavedPlan record VERBATIM (minus the
//      device-local `syncedAt`/`remoteRev` bookkeeping, which is stripped so it
//      never travels — each device stamps its own).
//   3. PULL every remote plan that is newer than (or missing from) the local
//      store: GET the full record, sanitize it, and overwrite last-write-wins.
//   Reconciled records get `syncedAt` (wall-clock) + `remoteRev` (the server
//   version identity) stamped, WITHOUT bumping `updatedAt`, so a re-run is a
//   no-op — the loop is idempotent.
//
// Delete propagation is intentionally v1-simple: a plan deleted locally is NOT
// removed from the server (no tombstones), so it can reappear on a later pull.
// Tombstones wait for the multiplayer story; the server already exposes DELETE.
//
// Network-resilient: any offline / non-200 aborts cleanly and returns a result
// with `error` set — local data is only ever touched by an `updatedAt`-safe
// stamp on records that successfully round-tripped, so a failed sync never
// corrupts the library. The `history` store never syncs (device-local scratch).

import { listPlans, putPlan, sanitizeSavedPlan, type SavedPlan } from './plans'

/** Outcome of one `syncPlans()` run. `at` is the ISO wall-clock of the run. */
export interface SyncResult {
  /** Local records uploaded to the server this run. */
  pushed: number
  /** Remote records downloaded + written into the local store this run. */
  pulled: number
  /** Pulls where a local record existed and lost to a newer remote (LWW). */
  conflicts: number
  /** ISO timestamp of the sync run. */
  at: string
  /** Set when the sync could not complete fully (offline / non-200 / bad JSON).
   *  When present, treat the counts as partial; local data stays intact. */
  error?: string
}

export interface SyncOptions {
  /** Injectable `fetch` (unit tests); defaults to the global. */
  fetch?: typeof fetch
  /** Base path of the plans API; defaults to same-origin `/api/plans`
   *  (served by the dev middleware in dev, by deploy/server.ts in prod). */
  base?: string
}

/** The subset of a SavedPlan the server's list endpoint returns per record. */
interface RemoteSummary {
  id: string
  updatedAt?: string
}

/** ISO → epoch ms; missing/invalid → 0 ("never"). */
const ms = (iso?: string): number => (iso ? Date.parse(iso) || 0 : 0)

/**
 * Push local changes and pull remote ones, reconciling last-write-wins on
 * `updatedAt`. Safe to call repeatedly: a run with nothing new is a no-op.
 */
export async function syncPlans(opts: SyncOptions = {}): Promise<SyncResult> {
  const doFetch = opts.fetch ?? fetch
  const base = opts.base ?? '/api/plans'
  const at = new Date().toISOString()
  let pushed = 0
  let pulled = 0
  let conflicts = 0

  try {
    // (1) Remote list first — needed to make push decisions LWW-correct.
    const listResp = await doFetch(base)
    if (!listResp.ok) throw new Error(`Plan list failed (HTTP ${listResp.status})`)
    const remoteList = (await listResp.json()) as RemoteSummary[]
    if (!Array.isArray(remoteList)) throw new Error('Plan list was not an array')
    const remoteById = new Map<string, RemoteSummary>()
    for (const r of remoteList) if (r && typeof r.id === 'string') remoteById.set(r.id, r)

    // (2) Push: locally-changed records that the server does not have newer.
    for (const p of await listPlans()) {
      // Unchanged since last sync (§5), AND not already the exact version we
      // last confirmed on the server. The `remoteRev` clause makes the loop
      // robustly idempotent even under clock skew (a record whose `updatedAt`
      // sits ahead of this device's wall-clock still won't re-push once held).
      if (ms(p.updatedAt) <= ms(p.syncedAt) || p.updatedAt === p.remoteRev) continue
      const remote = remoteById.get(p.id)
      if (remote && ms(remote.updatedAt) > ms(p.updatedAt)) continue // remote newer → pull handles it
      // Strip device-local sync bookkeeping so it never travels to the server.
      const { syncedAt: _s, remoteRev: _r, ...body } = p
      void _s
      void _r
      const resp = await doFetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(`Push failed for ${p.id} (HTTP ${resp.status})`)
      await putPlan({ ...p, syncedAt: at, remoteRev: p.updatedAt })
      pushed++
    }

    // (3) Pull: remote records newer than (or missing from) the local store.
    //     Re-read locally so just-pushed stamps are visible → idempotent skips.
    const localById = new Map<string, SavedPlan>((await listPlans()).map((p) => [p.id, p]))
    for (const remote of remoteList) {
      if (!remote || typeof remote.id !== 'string') continue
      const localP = localById.get(remote.id)
      if (localP?.remoteRev === remote.updatedAt) continue // already hold this exact version
      if (localP && ms(localP.updatedAt) >= ms(remote.updatedAt)) continue // local same-or-newer
      const recResp = await doFetch(`${base}/${encodeURIComponent(remote.id)}`)
      if (!recResp.ok) continue // transient / vanished → skip, not fatal
      let parsed: unknown
      try {
        parsed = await recResp.json()
      } catch {
        continue // unreadable body → skip
      }
      const clean = sanitizeSavedPlan(parsed)
      if (!clean) continue // malformed remote record → skip, not fatal
      await putPlan({ ...clean, syncedAt: at, remoteRev: clean.updatedAt })
      pulled++
      if (localP) conflicts++ // both sides had it; remote won (LWW)
    }

    return { pushed, pulled, conflicts, at }
  } catch (e) {
    return { pushed, pulled, conflicts, at, error: e instanceof Error ? e.message : String(e) }
  }
}
