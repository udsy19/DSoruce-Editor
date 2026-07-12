// SupabaseSyncProvider — the cloud impl of SyncProvider, backed by the Postgres
// `plans` table with per-user Row-Level Security. Design: docs/design/cloud-sync.md.
//
// One row per SavedPlan: the entire record (which embeds the v1 .dsource file)
// lives in the `data` jsonb column; `name`/`updated_at`/`metrics` are
// denormalized so `list()` is cheap and never hydrates a blob. RLS keys every
// row to `owner = auth.uid()`, so a client can only ever see/write its own
// rows — the isolation is enforced by the database, not this code.
//
// `sanitizeSavedPlan` (persist/plans.ts) validates every row we read back
// through the SAME contract as an opened .dsource file, so a corrupt/hostile
// row is skipped, never trusted. The device-local sync bookkeeping
// (syncedAt/remoteRev) is stripped before upload — it is per-device, not shared.

import { getClient } from './client'
import { sanitizeSavedPlan, type SavedPlan } from '../persist/plans'
import type { PlanSummary, SyncProvider } from './provider'

const TABLE = 'plans'

/** Row shape written to Postgres. `owner` is omitted so the column default
 *  (auth.uid()) stamps it — which is exactly what the RLS insert check wants. */
interface PlanRow {
  id: string
  name: string
  updated_at: string
  created_at: string
  metrics: SavedPlan['metrics']
  data: SavedPlan
}

/** Strip device-local sync bookkeeping so the stored blob is device-neutral. */
function forCloud(p: SavedPlan): SavedPlan {
  const { syncedAt: _s, remoteRev: _r, ...rest } = p
  void _s
  void _r
  return rest
}

export class SupabaseSyncProvider implements SyncProvider {
  readonly kind = 'supabase'

  async ready(): Promise<boolean> {
    const client = getClient()
    if (!client) return false
    const { data } = await client.auth.getSession()
    return !!data.session
  }

  async list(): Promise<PlanSummary[]> {
    const client = getClient()
    if (!client) return []
    const { data, error } = await client
      .from(TABLE)
      .select('id,name,updated_at')
      .order('updated_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }))
  }

  async get(id: string): Promise<SavedPlan | null> {
    const client = getClient()
    if (!client) return null
    const { data, error } = await client.from(TABLE).select('data').eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) return null
    // Validate the untrusted blob through the same gate as an opened file.
    return sanitizeSavedPlan(data.data)
  }

  async put(plan: SavedPlan): Promise<void> {
    const client = getClient()
    if (!client) throw new Error('Not signed in')
    const clean = forCloud(plan)
    const row: PlanRow = {
      id: clean.id,
      name: clean.name,
      updated_at: clean.updatedAt,
      created_at: clean.createdAt,
      metrics: clean.metrics,
      data: clean,
    }
    const { error } = await client.from(TABLE).upsert(row, { onConflict: 'id' })
    if (error) throw error
  }

  async remove(id: string): Promise<void> {
    const client = getClient()
    if (!client) return
    const { error } = await client.from(TABLE).delete().eq('id', id)
    if (error) throw error
  }
}
