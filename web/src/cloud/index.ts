// Cloud plan sync — public entry point. Design: docs/design/cloud-sync.md.
//
// Wiring rule for callers (App.tsx): gate ALL cloud UI on `cloudEnabled()`.
// With the flag off this module still imports cleanly but every path is inert,
// so the default (local IndexedDB) behavior is untouched.
//
// The PoC reconcile is deliberately one-directional-per-call and last-write-
// wins on `updatedAt` — enough to demonstrate save + load of a plan across
// devices. The full bidirectional loop (mirroring persist/sync.ts's LWW +
// idempotence) is the next phase; both sit on the same SyncProvider surface.

import { LocalSyncProvider, type SyncProvider } from './provider'
import { SupabaseSyncProvider } from './supabaseProvider'
import { putPlan } from '../persist/plans'

export { cloudEnabled } from './client'
export type { CloudUser } from './auth'
export { getUser, signInWithMagicLink, signInAnonymously, signOut, onAuthChange } from './auth'
export type { PlanSummary, SyncProvider } from './provider'

/** The local (IndexedDB) provider — the offline-first source of truth. */
export const local: SyncProvider = new LocalSyncProvider()

/** The cloud (Supabase) provider — usable only when signed in. */
export const cloud: SupabaseSyncProvider = new SupabaseSyncProvider()

/**
 * Upload one local plan to the cloud (cloud save). Reads it from IndexedDB and
 * upserts the row; the server stamps ownership. Returns true if a plan existed.
 */
export async function pushPlan(id: string): Promise<boolean> {
  const plan = await local.get(id)
  if (!plan) return false
  await cloud.put(plan)
  return true
}

/**
 * Download one cloud plan into the local library (cloud load), then it opens
 * exactly like any other saved plan. Returns true if the row existed. LWW is
 * the caller's call for now; the PoC pull simply overwrites the local copy.
 */
export async function pullPlan(id: string): Promise<boolean> {
  const plan = await cloud.get(id)
  if (!plan) return false
  await putPlan(plan)
  return true
}

/** Push every local plan to the cloud (bulk cloud save). Returns the count. */
export async function pushAll(): Promise<number> {
  const summaries = await local.list()
  let n = 0
  for (const s of summaries) if (await pushPlan(s.id)) n++
  return n
}

/** Pull every cloud plan into the local library (bulk cloud load). Count out. */
export async function pullAll(): Promise<number> {
  const summaries = await cloud.list()
  let n = 0
  for (const s of summaries) if (await pullPlan(s.id)) n++
  return n
}
