// Guided-workflow step chrome — design: docs/design/ui-system.md §1.1, §2.3.
//
// Presentational only. Three fixed chrome bands around one work area:
//   1. an always-visible LINEAR STEPPER — the four guided steps (Property ·
//      Space · Program · Generate). Completed steps are checked and clickable
//      (jump back); the current step is highlighted; upcoming steps are dimmed.
//   2. a compact CONTEXT band — "2 · SPACE", the step title, and the single
//      imperative for the step, on two tight lines.
//   3. a Back/Next footer where a disabled Next always SAYS WHY ("Upload a floor
//      plan to continue") instead of silently doing nothing.
// The work area between them is `1fr; min-height:0` and does NOT scroll — the
// step inside it declares its own single scroll owner (layout law rule 5).
// All state (which step is active, whether Next is enabled + why, what the
// buttons do, where a completed step jumps to) is passed in by the shell — this
// component steers nothing itself.

import type { ReactNode } from 'react'
import { Icon } from '../ui/icons'

export type WizardStepId = 'property' | 'space' | 'program' | 'generate'

// The guided wizard is these four steps, and only these four. A dimmed tail of
// "editor phases" (Review → Design → Visualise → Share) used to follow them —
// deleted, because no such phases exist in the editor. The stepper only ever
// advertises steps the product actually has.
const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'property', label: 'Property' },
  { id: 'space', label: 'Space' },
  { id: 'program', label: 'Program' },
  { id: 'generate', label: 'Generate' },
]

export function WizardChrome({
  current,
  title,
  guide,
  onBack,
  onNext,
  onStep,
  backLabel = 'Back',
  nextLabel = 'Next',
  nextDisabled = false,
  disabledReason,
  nextTestId = 'wizard-next',
  hideNext = false,
  children,
}: {
  current: WizardStepId
  title: string
  /** One-line, imperative "what to do here" shown under the title. The single
   *  unmissable instruction for the step. */
  guide?: ReactNode
  onBack?: () => void
  onNext?: () => void
  /** Jump straight to an already-completed step by clicking it in the stepper. */
  onStep?: (id: WizardStepId) => void
  backLabel?: string
  nextLabel?: string
  nextDisabled?: boolean
  /** Why Next is disabled — shown beside the greyed button so the user knows what
   *  to do to unlock it. Only surfaced when `nextDisabled` is true. */
  disabledReason?: string
  /** testid of the Next button — per-step so E2E can target e.g. `program-next`. */
  nextTestId?: string
  /** The terminal step (Generate) exits by picking a candidate, not by a Next
   *  button — hide it so no dead "Next" dangles at the end of the wizard. */
  hideNext?: boolean
  children: ReactNode
}) {
  const idx = STEPS.findIndex((s) => s.id === current)

  return (
    <div className="studio wizard" data-testid="wizard-chrome">
      <header className="studio-top">
        <div className="studio-brand">
          <span className="brand-mark" aria-hidden />
          <span className="studio-wordmark">DSOURCE STUDIO</span>
        </div>
        <ol className="wizard-steps" aria-label="Project steps">
          {STEPS.map((s, i) => {
            const state = i < idx ? 'done' : i === idx ? 'active' : 'todo'
            const clickable = state === 'done' && !!onStep
            const inner = (
              <>
                <span className="wizard-step-dot">
                  {state === 'done' ? <Icon name="check" size={12} /> : i + 1}
                </span>
                <span className="wizard-step-label">{s.label}</span>
              </>
            )
            return (
              <li
                key={s.id}
                className={`wizard-step ${state}${clickable ? ' clickable' : ''}`}
                data-testid={`wizard-step-${s.id}`}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                {i > 0 && <span className="wizard-rail" aria-hidden />}
                {clickable ? (
                  <button
                    type="button"
                    className="wizard-step-hit"
                    onClick={() => onStep?.(s.id)}
                    aria-label={`Go back to ${s.label}`}
                  >
                    {inner}
                  </button>
                ) : (
                  <span className="wizard-step-hit">{inner}</span>
                )}
              </li>
            )
          })}
        </ol>
      </header>

      <div className="wizard-head">
        <span className="panel-eyebrow">
          {idx + 1} of {STEPS.length} · {STEPS[idx]?.label}
        </span>
        <h1 className="wizard-title">{title}</h1>
        {guide && (
          <p className="wizard-guide" data-testid="wizard-guide">
            <span className="wizard-guide-arrow" aria-hidden>
              <Icon name="caret" size={12} />
            </span>
            <span className="wizard-guide-text">{guide}</span>
          </p>
        )}
      </div>

      <div className="wizard-body">{children}</div>

      <footer className="wizard-nav">
        <button
          type="button"
          className="empty-btn wizard-back"
          data-testid="wizard-back"
          onClick={onBack}
          disabled={!onBack}
        >
          <Icon name="caret" size={13} /> {backLabel}
        </button>
        {!hideNext && (
          <div className="wizard-next-group">
            {nextDisabled && disabledReason && (
              <span className="wizard-next-reason" data-testid="wizard-next-reason" role="status">
                <Icon name="help" size={13} /> {disabledReason}
              </span>
            )}
            <button
              type="button"
              className="empty-btn primary wizard-next"
              data-testid={nextTestId}
              onClick={onNext}
              disabled={nextDisabled || !onNext}
            >
              {nextLabel} <Icon name="caret" size={13} />
            </button>
          </div>
        )}
      </footer>
    </div>
  )
}
