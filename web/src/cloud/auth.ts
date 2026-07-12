// Auth for cloud plan sync — a thin wrapper over Supabase Auth (GoTrue).
// Design: docs/design/cloud-sync.md §3.
//
// Two passwordless entry points, both appropriate for a browser-only tool:
//   - Magic link (email OTP): the durable identity a user re-opens on any
//     device. supabase-js persists + auto-refreshes the session, so a signed-in
//     user stays signed in across reloads.
//   - Anonymous: a zero-friction "just let me sync this tab" identity, later
//     upgradable to email without losing rows (the user id is preserved).
// Everything here no-ops safely when cloud is disabled (getClient() === null),
// so importing this module never forces the flag on.

import { getClient } from './client'

/** The signed-in identity, normalized for the UI. */
export interface CloudUser {
  id: string
  email: string | null
  isAnonymous: boolean
}

/** Current user, or null when signed out / cloud disabled. Reads the persisted
 *  session from localStorage (no network) — fine for gating UI; the server
 *  re-verifies every request under RLS regardless. */
export async function getUser(): Promise<CloudUser | null> {
  const client = getClient()
  if (!client) return null
  const { data } = await client.auth.getSession()
  const u = data.session?.user
  if (!u) return null
  return { id: u.id, email: u.email ?? null, isAnonymous: u.is_anonymous ?? false }
}

/** Email a one-time magic link. The user finishes sign-in by clicking it;
 *  `detectSessionInUrl` (client.ts) then completes the session on return. */
export async function signInWithMagicLink(email: string): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Cloud sync is disabled')
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  })
  if (error) throw error
}

/** Create a throwaway anonymous session (requires anonymous sign-ins enabled in
 *  the project's Auth settings — see the design doc's setup steps). */
export async function signInAnonymously(): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Cloud sync is disabled')
  const { error } = await client.auth.signInAnonymously()
  if (error) throw error
}

export async function signOut(): Promise<void> {
  const client = getClient()
  if (!client) return
  await client.auth.signOut()
}

/** Subscribe to sign-in/out transitions. Returns an unsubscribe fn (no-op when
 *  cloud is disabled) so React effects can clean up. */
export function onAuthChange(cb: (user: CloudUser | null) => void): () => void {
  const client = getClient()
  if (!client) return () => {}
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    const u = session?.user
    cb(u ? { id: u.id, email: u.email ?? null, isAnonymous: u.is_anonymous ?? false } : null)
  })
  return () => data.subscription.unsubscribe()
}
