// Scenario-compare modal (plan-library design §3): full-screen scrim reusing
// the ShortcutsOverlay `.help-scrim` pattern, two 480px plan panes and the
// consequence-card diff table (`cons-*` classes, so valence coloring stays
// identical to the AI card). Esc closes via a window keydown listener — the
// same mechanism App.tsx uses for ShortcutsOverlay, owned locally because
// this component mounts independently.

import { useEffect } from 'react'
import { PlanComparison, PlanSide } from '../plans/compare'
import { Icon } from './icons'

const PANE_W = 480

function Pane({
  side,
  onOpen,
  testid,
}: {
  side: PlanSide
  onOpen: () => void
  testid: string
}) {
  return (
    <div style={{ width: PANE_W, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="help-group-title">{side.name}</div>
      <img
        src={side.thumb}
        alt={`Plan schematic: ${side.name}`}
        style={{
          width: '100%',
          aspectRatio: '480 / 336',
          objectFit: 'contain',
          background: '#ffffff',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-md)',
        }}
      />
      <button className="agent-approve" data-testid={testid} onClick={onOpen}>
        Open this plan
      </button>
    </div>
  )
}

export function CompareView({
  cmp,
  onOpenSide,
  onClose,
}: {
  cmp: PlanComparison
  onOpenSide: (side: 'a' | 'b') => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="help-scrim" onClick={onClose} data-testid="compare-view">
      <div
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Compare plans"
        style={{ width: 'min(1060px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="help-title">
            Compare · {cmp.a.name} vs {cmp.b.name}
          </span>
          <button
            className="icon-btn"
            data-testid="compare-close"
            onClick={onClose}
            aria-label="Close compare"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div style={{ padding: '18px 16px 20px' }}>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Pane side={cmp.a} onOpen={() => onOpenSide('a')} testid="compare-open-a" />
            <Pane side={cmp.b} onOpen={() => onOpenSide('b')} testid="compare-open-b" />
          </div>

          {/* Diff table: B relative to A, same rows/valence as the AI consequence card. */}
          <div className="cons-card" style={{ maxWidth: PANE_W * 2 + 20, margin: '16px auto 0' }}>
            <div className="cons-eyebrow">
              {cmp.b.name} vs {cmp.a.name}
            </div>
            <div className="cons-deltas">
              {cmp.deltas.map((d) => (
                <div className="cons-row" key={d.label}>
                  <span className="cons-label">{d.label}</span>
                  <span className="cons-vals num">
                    <span className="cons-before">{d.before}</span>
                    <span className={`cons-arrow ${d.dir} ${d.valence}`}>
                      {d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : '='}
                    </span>
                    <span className={`cons-after ${d.valence}`}>{d.after}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
