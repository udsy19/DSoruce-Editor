import type { CSSProperties } from 'react'
import type { Candidate } from '../editor/EditorCanvas'
import type { SoftVerdict } from '../ai/evaluator'

/**
 * Laiout-style options strip: every kept test-fit candidate as a small scored
 * plan card. Purely presentational — picking a card is the parent's job
 * (App calls `ec.applyCandidate(c.snap)`). When the Claude soft-goal
 * evaluator has judged a candidate, its card shows an amber "AI n" badge and
 * the one-line verdict (keyed by seed via `verdicts`).
 */
export function CandidateGallery({
  candidates,
  activeSeed,
  onPick,
  verdicts,
}: {
  candidates: Candidate[]
  activeSeed: number | null
  onPick: (c: Candidate) => void
  verdicts?: Record<number, SoftVerdict>
}) {
  if (candidates.length === 0) return null
  return (
    <div style={S.strip} role="listbox" aria-label="Layout options">
      {candidates.map((c, i) => {
        const active = c.seed === activeSeed
        const ai = verdicts?.[c.seed]
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
              {ai && (
                <span style={S.aiBadge} data-testid={`ai-badge-${i}`}>
                  AI {Math.round(ai.score)}
                </span>
              )}
            </div>
            {ai && <div style={S.aiVerdict}>{ai.verdict}</div>}
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
  aiBadge: {
    marginLeft: 'auto',
    fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    fontSize: 9.5,
    fontWeight: 600,
    color: ACCENT,
    background: 'rgba(232, 161, 60, 0.12)',
    borderRadius: 3,
    padding: '0 4px',
  },
  aiVerdict: {
    marginTop: 3,
    fontSize: 10.5,
    lineHeight: 1.3,
    color: '#6b7280',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
}
