import type { CSSProperties } from 'react'
import type { Candidate } from '../editor/EditorCanvas'

/**
 * Laiout-style options strip: every kept test-fit candidate as a small scored
 * plan card. Purely presentational — picking a card is the parent's job
 * (App calls `ec.applyCandidate(c.snap)`).
 */
export function CandidateGallery({
  candidates,
  activeSeed,
  onPick,
}: {
  candidates: Candidate[]
  activeSeed: number | null
  onPick: (c: Candidate) => void
}) {
  if (candidates.length === 0) return null
  return (
    <div style={S.strip} role="listbox" aria-label="Layout options">
      {candidates.map((c, i) => {
        const active = c.seed === activeSeed
        return (
          <button
            key={c.seed}
            type="button"
            data-testid={`candidate-${i}`}
            onClick={() => onPick(c)}
            aria-selected={active}
            role="option"
            style={{
              ...S.card,
              borderColor: active ? ACCENT : 'rgba(23, 26, 30, 0.12)',
              boxShadow: active ? `0 0 0 1px ${ACCENT}` : 'none',
            }}
          >
            <img src={c.thumb} alt={`Option ${LETTER(i)} plan`} style={S.thumb} draggable={false} />
            <div style={S.row}>
              <span style={{ ...S.name, color: active ? ACCENT : '#1a1d21' }}>
                Option {LETTER(i)}
              </span>
              <span style={S.total}>{Math.round(c.score.total)}</span>
            </div>
            <div style={S.subRow}>
              <span style={S.sub}>cap {Math.round(c.score.capacity)}</span>
              <span style={S.sub}>circ {Math.round(c.score.circulation)}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

const ACCENT = 'var(--accent, #E8A13C)'
const LETTER = (i: number) => String.fromCharCode(65 + (i % 26))

const S: Record<string, CSSProperties> = {
  strip: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    padding: '10px 0 2px',
  },
  card: {
    flex: '0 0 auto',
    width: 128,
    padding: 5,
    background: '#ffffff',
    border: '1.5px solid',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    font: 'inherit',
    fontFamily: "var(--font-ui, 'Space Grotesk', system-ui, sans-serif)",
  },
  thumb: {
    display: 'block',
    width: '100%',
    height: 'auto',
    borderRadius: 4,
    background: '#f2f4f7',
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  name: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.02em',
  },
  total: {
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1d21',
  },
  subRow: {
    display: 'flex',
    gap: 8,
    marginTop: 2,
  },
  sub: {
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: 9.5,
    color: '#9aa2ad',
  },
}
