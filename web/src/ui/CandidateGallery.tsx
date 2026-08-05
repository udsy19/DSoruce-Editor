import type { Candidate } from '../editor/EditorCanvas'
import { STRATEGY_LABEL } from '../editor/EditorCanvas'
import type { SoftVerdict } from '../ai/evaluator'

/**
 * Laiout-style options strip: every kept test-fit candidate as a small scored
 * plan card. Purely presentational — picking a card is the parent's job
 * (App calls `ec.applyCandidate(c.snap)`). When the Claude soft-goal
 * evaluator has judged a candidate, its card shows an "AI n" badge and
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
    <div className="cand-strip" role="listbox" aria-label="Layout options">
      {candidates.map((c, i) => {
        const active = c.seed === activeSeed
        const ai = verdicts?.[c.seed]
        return (
          // Cards are <button>s, so the save affordance is an absolutely
          // positioned sibling (nested buttons are invalid HTML).
          <div key={c.seed} className="cand-slot">
            <button
              type="button"
              data-testid={`candidate-${i}`}
              onClick={() => onPick(c)}
              aria-selected={active}
              role="option"
              className={`cand-card${active ? ' is-active' : ''}`}
            >
              <img
                src={c.thumb}
                alt={`Option ${LETTER(i)} (${STRATEGY_LABEL[c.strategy]}) plan`}
                className="cand-thumb"
                draggable={false}
              />
              <div className="cand-row">
                <span className={`cand-name${active ? ' is-active' : ''}`}>
                  {LETTER(i)} · {STRATEGY_LABEL[c.strategy]}
                </span>
                <span className="cand-total num">{Math.round(c.score.total)}</span>
              </div>
              <div className="cand-sub-row">
                <span className="cand-sub num">cap {Math.round(c.score.capacity)}</span>
                <span className="cand-sub num">circ {Math.round(c.score.circulation)}</span>
                {ai && (
                  <span className="cand-ai-badge num" data-testid={`ai-badge-${i}`}>
                    AI {Math.round(ai.score)}
                  </span>
                )}
              </div>
              {ai && <div className="cand-ai-verdict">{ai.verdict}</div>}
            </button>
            {onSave && (
              <button
                type="button"
                data-testid={`candidate-save-${i}`}
                title={`Save option ${LETTER(i)} to library`}
                aria-label={`Save option ${LETTER(i)} to library`}
                className="cand-save-btn"
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

const LETTER = (i: number) => String.fromCharCode(65 + (i % 26))

