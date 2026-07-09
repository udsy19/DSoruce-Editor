import type { CSSProperties } from 'react'
import type { Candidate } from '../editor/EditorCanvas'
import { STRATEGY_LABEL } from '../editor/EditorCanvas'
import type { SoftVerdict } from '../ai/evaluator'

/**
 * Laiout-style options strip: every kept test-fit candidate as a small scored
 * plan card. Purely presentational — picking a card is the parent's job
 * (App calls `ec.applyCandidate(c.snap)`). When the Claude soft-goal
 * evaluator has judged a candidate, its card shows an amber "AI n" badge and
 * the one-line verdict (keyed by seed via `verdicts`). When `onSave` is
 * given, each card grows a small bookmark affordance to park the candidate
 * in the plan library (docs/design/plan-library.md §6, touch point 6).
 */
export function CandidateGallery({
  candidates,
  activeSeed,
  onPick,
  verdicts,
  onSave,
}: {
  candidates: Candidate[]
  activeSeed: number | null
  onPick: (c: Candidate) => void
  verdicts?: Record<number, SoftVerdict>
  onSave?: (c: Candidate) => void
}) {
  if (candidates.length === 0) return null
  return (
    <div style={S.strip} role="listbox" aria-label="Layout options">
      {candidates.map((c, i) => {
        const active = c.seed === activeSeed
        const ai = verdicts?.[c.seed]
        return (
          // Cards are <button>s, so the save affordance is an absolutely
          // positioned sibling (nested buttons are invalid HTML).
          <div key={c.seed} style={S.slot}>
            <button
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
              <img
                src={c.thumb}
                alt={`Option ${LETTER(i)} (${STRATEGY_LABEL[c.strategy]}) plan`}
                style={S.thumb}
                draggable={false}
              />
              <div style={S.row}>
                <span style={{ ...S.name, color: active ? ACCENT : '#1a1d21' }}>
                  {LETTER(i)} · {STRATEGY_LABEL[c.strategy]}
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
            {onSave && (
              <button
                type="button"
                data-testid={`candidate-save-${i}`}
                title={`Save option ${LETTER(i)} to library`}
                aria-label={`Save option ${LETTER(i)} to library`}
                style={S.saveBtn}
                onClick={() => onSave(c)}
              >
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4.2L6 21V4Z" />
                </svg>
              </button>
            )}
          </div>
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
  slot: {
    flex: '0 0 auto',
    position: 'relative',
  },
  card: {
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
  saveBtn: {
    position: 'absolute',
    top: 9,
    right: 9,
    display: 'inline-grid',
    placeItems: 'center',
    width: 20,
    height: 20,
    padding: 0,
    border: '1px solid rgba(23, 26, 30, 0.12)',
    borderRadius: 5,
    background: 'rgba(255, 255, 255, 0.92)',
    color: '#5c6670',
    cursor: 'pointer',
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
