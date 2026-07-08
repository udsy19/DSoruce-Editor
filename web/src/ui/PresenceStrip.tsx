// Presentational presence avatar row for the topbar — pure props, no store or
// network import (mirrors LayersPanel's pattern). The host (App) derives the
// peers array from PresenceClient's onPeersChange map; self renders last with
// a ring so you can always find yourself. Figma-style overlapping circles.
import type { CSSProperties } from 'react'

export interface PresenceUser {
  u: string
  name: string
  color: string
}

export interface PresenceStripProps {
  peers: PresenceUser[]
  self: { name: string; color: string }
}

const S: Record<string, CSSProperties> = {
  strip: {
    display: 'inline-flex',
    alignItems: 'center',
    fontFamily: '"Space Grotesk", sans-serif',
  },
  avatar: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2px solid var(--surface, #ffffff)',
    marginLeft: -6,
    fontSize: 10.5,
    fontWeight: 600,
    color: '#ffffff',
    textTransform: 'uppercase',
    userSelect: 'none',
    flex: 'none',
  },
  count: {
    marginLeft: 6,
    fontFamily: '"IBM Plex Mono", monospace',
    fontSize: 11,
    color: 'var(--muted, #5c6670)',
  },
}

const MAX_SHOWN = 5

function initial(name: string): string {
  const t = name.trim()
  return t ? t[0] : '?'
}

function Avatar({ name, color, ring, z }: { name: string; color: string; ring?: boolean; z: number }) {
  return (
    <span
      title={name}
      style={{
        ...S.avatar,
        background: color,
        zIndex: z,
        boxShadow: ring ? '0 0 0 1.5px var(--accent, #2d5bd6)' : undefined,
      }}
    >
      {initial(name)}
    </span>
  )
}

export function PresenceStrip({ peers, self }: PresenceStripProps) {
  const shown = peers.slice(0, MAX_SHOWN)
  const overflow = peers.length - shown.length
  return (
    <div data-testid="presence-strip" style={S.strip} aria-label={`${peers.length + 1} people here`}>
      {shown.map((p, i) => (
        <Avatar key={p.u} name={p.name || 'Guest'} color={p.color} z={i + 1} />
      ))}
      <Avatar name={`${self.name} (you)`} color={self.color} ring z={shown.length + 1} />
      {overflow > 0 && <span style={S.count}>+{overflow}</span>}
    </div>
  )
}
