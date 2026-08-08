// Supabase client + feature-flag config for cloud plan sync.
// Design: docs/design/cloud-sync.md.
//
// Cloud sync is ADDITIVE and OPT-IN. It is inert unless BOTH are true:
//   1. VITE_CLOUD_SYNC === '1'  (the feature flag)
//   2. VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set (from .env.local)
// With the flag off (the default), `cloudEnabled()` is false, `getClient()`
// returns null, and the app behaves exactly as before — plans live only in
// IndexedDB. Nothing here imports or is imported by the local persist layer,
// so a misconfigured/absent cloud never touches the offline-first path.
//
// The anon/publishable key is designed to ship to browsers — it is NOT a
// secret; every request it makes is still gated by Row-Level Security on the
// server (see the migration in the design doc). We still load it from env so
// each deployment points at its own project and the repo carries no keys.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// `import.meta.env` is a Vite-ism. This module is now reachable from the AI
// call sites (they attach a bearer token to /api/claude), and those are bundled
// for NODE by the `.test.mjs` harness and by scripts/ — where `import.meta.env`
// is undefined and reading through it threw at module-eval time, taking the
// whole bundle down before a single assertion ran. Defaulting to an empty bag
// keeps this module INERT off-Vite, which is exactly the contract stated above,
// instead of exploding. Fixes the class, not just the one call site.
const env: Record<string, string | undefined> =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}

const url = env.VITE_SUPABASE_URL
const anonKey = env.VITE_SUPABASE_ANON_KEY

/** True when the operator opted into cloud sync AND supplied a project. */
export function cloudEnabled(): boolean {
  return env.VITE_CLOUD_SYNC === '1' && !!url && !!anonKey
}

// One shared client per tab. supabase-js persists the auth session in
// localStorage and auto-refreshes the token, so a signed-in user stays signed
// in across reloads without any work on our side.
let client: SupabaseClient | null = null

/** The shared Supabase client, or null when cloud sync is disabled/unconfigured. */
export function getClient(): SupabaseClient | null {
  if (!cloudEnabled()) return null
  if (!client) {
    client = createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return client
}
