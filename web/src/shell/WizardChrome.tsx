// Guided-workflow step chrome — design: docs/design/workflow.md §1 (Slice 1).
//
// Presentational only. It gives a first-time (naive) user three anchors so they
// always know where they are and what to do next:
//   1. an always-visible LINEAR STEPPER — the four guided steps (Property ·
//      Space · Program · Generate) plus a calm, muted tail of the editor phases
//      that follow (Review → Design → Visualise → Share), Laiout-style. Completed
//      steps are checked and clickable (jump back); the current step is
//      highlighted; upcoming steps are dimmed.
//   2. a one-line "what to do here" GUIDE strip above the step body.
//   3. a Back/Next footer where a disabled Next always SAYS WHY ("Upload a floor
//      plan to continue") instead of silently doing nothing.
// All state (which step is active, whether Next is enabled + why, what the
// buttons do, where a completed step jumps to) is passed in by the shell — this
// component steers nothing itself.

import type { ReactNode } from 'react'
import { Icon } from '../ui/icons'

export type WizardStepId = 'property' | 'space' | 'program' | 'generate'

// The guided wizard is these four steps. Everything after Generate happens
// inside the editor; we still show those phases as a dimmed "next, in the
// editor" tail so a first-time user sees the whole journey at a glance.
const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'property', label: 'Property' },
  { id: 'space', label: 'Space' },
  { id: 'program', label: 'Program' },
  { id: 'generate', label: 'Generate' },
]
const EDITOR_STEPS = ['Review', 'Design', 'Visualise', 'Share']

export function WizardChrome({
  current,
  title,
  subtitle,
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
  subtitle?: string
  /** One-line, imperative "what to do here" shown in the guide strip above the
   *  body. The single unmissable instruction for the step. */
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
          {/* Dimmed tail: the phases that continue once a fit is opened in the
              editor. Non-interactive — just the road ahead. */}
          {EDITOR_STEPS.map((label) => (
            <li key={label} className="wizard-step future" aria-disabled>
              <span className="wizard-rail" aria-hidden />
              <span className="wizard-step-hit">
                <span className="wizard-step-dot" aria-hidden>
                  <span className="wizard-step-pip" />
                </span>
                <span className="wizard-step-label">{label}</span>
              </span>
            </li>
          ))}
        </ol>
      </header>

      <div className="wizard-head">
        <span className="panel-eyebrow">
          Step {idx + 1} of {STEPS.length} · {STEPS[idx]?.label}
        </span>
        <h1 className="wizard-title">{title}</h1>
        {subtitle && <p className="studio-sub">{subtitle}</p>}
      </div>

      {guide && (
        <div className="wizard-guide" data-testid="wizard-guide">
          <span className="wizard-guide-arrow" aria-hidden>
            <Icon name="caret" size={13} />
          </span>
          <span className="wizard-guide-text">{guide}</span>
        </div>
      )}

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
