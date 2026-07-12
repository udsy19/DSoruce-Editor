// CloudSyncPanel — the opt-in cloud UI. Self-contained so App.tsx wiring is a
// single conditional render; it owns its own auth + push/pull state and never
// touches the editor. Rendered ONLY when `cloudEnabled()` is true (flag on +
// project configured), so with the flag off it does not exist and the local
// IndexedDB flow is exactly as before. Design: docs/design/cloud-sync.md.

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  getUser,
  onAuthChange,
  signInWithMagicLink,
  signInAnonymously,
  signOut,
  pushAll,
  pullAll,
  type CloudUser,
} from './index'

export interface CloudSyncPanelProps {
  /** Called after a pull writes to the local library, so the host can refresh. */
  onChanged?: () => void
}

export function CloudSyncPanel({ onChanged }: CloudSyncPanelProps) {
  const [user, setUser] = useState<CloudUser | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void getUser().then(setUser)
    return onAuthChange(setUser)
  }, [])

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus(await fn())
    } catch (e) {
      setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const onMagicLink = (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    void run('Sign-in', async () => {
      await signInWithMagicLink(email.trim())
      return `Magic link sent to ${email.trim()} — click it to finish sign-in.`
    })
  }

  return (
    <div className="cloud-sync" style={{ padding: '12px 0', borderTop: '1px solid var(--line, #333)' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Cloud sync (beta)</div>

      {!user ? (
        <>
          <form onSubmit={onMagicLink} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              className="field"
              type="email"
              placeholder="you@studio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <button className="cta-ghost" type="submit" disabled={busy || !email.trim()}>
              Email link
            </button>
          </form>
          <button
            className="cta-ghost"
            disabled={busy}
            onClick={() =>
              void run('Sign-in', async () => {
                await signInAnonymously()
                return 'Signed in anonymously.'
              })
            }
          >
            Continue anonymously
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, marginBottom: 8, opacity: 0.8 }}>
            Signed in{user.email ? ` as ${user.email}` : ' (anonymous)'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className="cta-ghost"
              disabled={busy}
              onClick={() =>
                void run('Push', async () => `Pushed ${await pushAll()} plan(s) to the cloud.`)
              }
            >
              Save all to cloud
            </button>
            <button
              className="cta-ghost"
              disabled={busy}
              onClick={() =>
                void run('Pull', async () => {
                  const n = await pullAll()
                  onChanged?.()
                  return `Loaded ${n} plan(s) from the cloud.`
                })
              }
            >
              Load from cloud
            </button>
            <button className="cta-ghost" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </>
      )}

      {status && (
        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.85 }} role="status">
          {status}
        </div>
      )}
    </div>
  )
}
