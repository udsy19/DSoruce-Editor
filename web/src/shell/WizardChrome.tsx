// Guided-workflow step chrome — design: docs/design/workflow.md §1 (Slice 1).
//
// Presentational only: the four-step progress header (Property done ✓, then
// Space / Program / Generate), a step-specific title/subtitle, a content slot,
// and the Back/Next footer nav. All state (which step is active, whether Next
// is enabled, what the buttons do) is passed in by the shell — this component
// renders the wizard reference screenshots' "STEP N OF 4 / <title>" frame and
// steers nothing itself.

import type { ReactNode } from 'react'
import { Icon } from '../ui/icons'

export type WizardStepId = 'property' | 'space' | 'program' | 'generate'

const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'property', label: 'Property' },
  { id: 'space', label: 'Space' },
  { id: 'program', label: 'Program' },
  { id: 'generate', label: 'Generate' },
]

export function WizardChrome({
  current,
  title,
  subtitle,
  onBack,
  onNext,
  backLabel = 'Back',
  nextLabel = 'Next',
  nextDisabled = false,
  nextTestId = 'wizard-next',
  children,
}: {
  current: WizardStepId
  title: string
  subtitle?: string
  onBack?: () => void
  onNext?: () => void
  backLabel?: string
  nextLabel?: string
  nextDisabled?: boolean
  /** testid of the Next button — per-step so E2E can target e.g. `program-next`. */
  nextTestId?: string
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
            return (
              <li
                key={s.id}
                className={`wizard-step ${state}`}
                data-testid={`wizard-step-${s.id}`}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                <span className="wizard-step-dot">
                  {state === 'done' ? <Icon name="check" size={12} /> : i + 1}
                </span>
                <span className="wizard-step-label">{s.label}</span>
              </li>
            )
          })}
        </ol>
      </header>

      <div className="wizard-head">
        <span className="panel-eyebrow">
          Step {idx + 1} of {STEPS.length}
        </span>
        <h1 className="wizard-title">{title}</h1>
        {subtitle && <p className="studio-sub">{subtitle}</p>}
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
        <button
          type="button"
          className="empty-btn primary"
          data-testid={nextTestId}
          onClick={onNext}
          disabled={nextDisabled || !onNext}
        >
          {nextLabel} <Icon name="caret" size={13} />
        </button>
      </footer>
    </div>
  )
}
