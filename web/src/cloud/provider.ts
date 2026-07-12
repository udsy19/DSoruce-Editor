// SyncProvider — the storage-backend abstraction behind cloud plan sync.
// Design: docs/design/cloud-sync.md §4.
//
// A SyncProvider is a CRUD interface over `SavedPlan` records. Two impls
// satisfy it:
//   - LocalSyncProvider (this file): a thin wrapper over the existing IndexedDB
//     plan store (persist/plans.ts). It is the DEFAULT and always available.
//   - SupabaseSyncProvider (supabaseProvider.ts): the same interface backed by
//     a Postgres `plans` table with per-user Row-Level Security.
// Because both speak `SavedPlan` — which embeds the entire v1 `.dsource` file
// verbatim — reconciling one against the other (cloud/index.ts) needs no new
// schema. This is a deliberately small surface: the PoC exercises save + load
// of one plan; the same interface scales to a full push/pull reconcile.

import { deletePlan, getPlan, listPlans, putPlan, type SavedPlan } from '../persist/plans'

/** Lightweight per-record header for list views without hydrating the blob. */
export interface PlanSummary {
  id: string
  name: string
  /** ISO — the SavedPlan.updatedAt last-write-wins clock. */
  updatedAt: string
}

export interface SyncProvider {
  /** Stable identifier for diagnostics/UI ('local' | 'supabase'). */
  readonly kind: string
  /** True when the provider can be used now (local: always; cloud: signed in). */
  ready(): Promise<boolean>
  /** All records this provider holds, as lightweight summaries. */
  list(): Promise<PlanSummary[]>
  /** One full record by id, or null if absent. */
  get(id: string): Promise<SavedPlan | null>
  /** Insert or replace a record (keyed by `id`). */
  put(plan: SavedPlan): Promise<void>
  /** Remove a record by id (no-op if absent). */
  remove(id: string): Promise<void>
}

const summarize = (p: SavedPlan): PlanSummary => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })

/**
 * The offline-first default: the browser's IndexedDB plan library, exposed
 * through the SyncProvider interface. Pure delegation to persist/plans.ts — no
 * new storage, so the local flow is unchanged whether or not cloud is enabled.
 */
export class LocalSyncProvider implements SyncProvider {
  readonly kind = 'local'
  async ready(): Promise<boolean> {
    return true
  }
  async list(): Promise<PlanSummary[]> {
    return (await listPlans()).map(summarize)
  }
  async get(id: string): Promise<SavedPlan | null> {
    return (await getPlan(id)) ?? null
  }
  put(plan: SavedPlan): Promise<void> {
    return putPlan(plan)
  }
  remove(id: string): Promise<void> {
    return deletePlan(id)
  }
}
