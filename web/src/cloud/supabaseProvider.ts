// SupabaseSyncProvider — the cloud impl of SyncProvider, backed by the Postgres
// `plans` table with per-user Row-Level Security. Design: docs/design/cloud-sync.md.
//
// One row per SavedPlan: the entire record (which embeds the v1 .dsource file)
// lives in the `data` jsonb column; `name`/`updated_at`/`metrics` are
// denormalized so `list()` is cheap and never hydrates a blob.
//
// ISOLATION IS THE DATABASE'S JOB, NOT THIS FILE'S. Note that `list()` and
// `get()` below carry no organisation filter and must not grow one: RLS scopes
// every statement to what the caller may reach — org membership, or a direct
// grant on the plan's project (migration 0002). A client-side `.eq('org_id', …)`
// would be a second, weaker copy of that rule, and the copy is the one that
// drifts. `owner` survives as attribution only; it stopped being the access
// rule when 0002 dropped the owner-only policies.
//
// `sanitizeSavedPlan` (persist/plans.ts) validates every row we read back
// through the SAME contract as an opened .dsource file, so a corrupt/hostile
// row is skipped, never trusted. The device-local sync bookkeeping
// (syncedAt/remoteRev) is stripped before upload — it is per-device, not shared.

import { getClient } from './client'
import { sanitizeSavedPlan, type SavedPlan } from '../persist/plans'
import type { PlanSummary, SyncProvider } from './provider'
import { ensurePersonalOrg, orgOfProject } from './tenancy'

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
  /** Tenancy (migration 0002). Denormalized out of the blob so RLS and any
   *  aggregate can read them without parsing jsonb. */
  org_id: string
  project_id: string | null
  floor_label: string | null
  floor_index: number | null
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

  /** The caller's home organisation, resolved once per session. Only used for
   *  plans that are not filed under a project. */
  private homeOrg: string | null = null

  /** Which organisation this plan belongs in.
   *
   *  A plan filed under a project MUST take that project's organisation: the two
   *  columns are a composite foreign key onto `projects (id, org_id)` (migration
   *  0004), so guessing here would be rejected by the database rather than
   *  producing a row that quietly disagrees with itself. Only an unfiled plan
   *  falls back to the caller's home org. */
  private async orgFor(plan: SavedPlan): Promise<string> {
    if (plan.projectId) {
      const org = await orgOfProject(plan.projectId)
      if (org) return org
      // The project has not been mirrored yet. Say so plainly — the alternative
      // is a foreign-key error from two layers down that reads like a bug in the
      // sync loop rather than an ordering mistake by the caller.
      throw new Error(
        `Plan "${plan.name}" references project ${plan.projectId}, which is not in the cloud yet — push the project first`,
      )
    }
    if (!this.homeOrg) this.homeOrg = await ensurePersonalOrg()
    if (!this.homeOrg) throw new Error('Not signed in')
    return this.homeOrg
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
      org_id: await this.orgFor(clean),
      project_id: clean.projectId ?? null,
      floor_label: clean.floor?.label ?? null,
      floor_index: clean.floor?.index ?? null,
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
