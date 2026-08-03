import { useRef, useState } from 'react'
import type { EditorCanvas } from '../editor/EditorCanvas'
import type { DesignOptionResult } from '../editor/search'
import { formatINR } from '../materialBank/client'
import { Icon } from './icons'

/**
 * "Design with AI" — the agentic senior-designer experience. The user describes
 * their office in one brief; Claude designs a DISTINCT test-fit per objective
 * (Balanced / Max seats / Cost-optimised / Collaboration / Experience), the
 * solver realises each, and every option lands as a scored card. Picking a card
 * makes that design the live document (docs/design/agentic-designer.md).
 *
 * Backend lives on the EditorCanvas instance (`designOptions` / `applyCandidate`);
 * this is a thin presentational + orchestration shell, matching the
 * CandidateGallery visual language. Gated by the parent on a plate + a Claude key.
 */
export function DesignWithAI({ ec, aiReady, hasPlate }: { ec: EditorCanvas; aiReady: boolean; hasPlate: boolean }) {
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [options, setOptions] = useState<DesignOptionResult[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const disabled = busy || !aiReady || !hasPlate
  const title = !hasPlate
    ? 'Open a plan or generate a plate first'
    : !aiReady
      ? 'Needs an ANTHROPIC_API_KEY on the dev proxy'
      : 'Let Claude design five office fits from your brief'

  const run = async () => {
    if (!hasPlate) {
      setNote('Open a plan or generate a plate first, then design.')
      return
    }
    setNote(null)
    setOptions(null)
    setActiveId(null)
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const opts = await ec.designOptions(brief, 1, ctrl.signal)
      if (opts.length === 0) {
        setNote('Claude could not design options right now. Check the API key on the dev proxy, then try again.')
        return
      }
      setOptions(opts)
    } catch {
      if (!ctrl.signal.aborted) setNote('Design run failed. Please try again.')
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const pick = (o: DesignOptionResult) => {
    ec.applyCandidate(o.snapshot)
    ec.frameContent()
    setActiveId(o.objective.id)
  }

  return (
    <div className="design-ai">
      <div className="panel-eyebrow">
        <Icon name="sparkles" size={13} /> Design with AI
      </div>
      <p className="panel-lead">
        Describe your office. Claude designs five distinct fits — one per objective — and you pick the winner.
      </p>

      <textarea
        className="design-brief"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        disabled={busy}
        rows={3}
        aria-label="Office brief"
        placeholder="e.g. 300-seat GCC delivery floor, heavy US-shift calls, training + cafeteria"
      />

      <button
        className="cta-refine"
        onClick={() => void run()}
        disabled={disabled}
        data-testid="design-ai"
        title={title}
      >
        <Icon name="sparkles" size={13} />
        {busy ? 'Claude is designing 5 options…' : 'Design with AI'}
      </button>

      {busy && (
        <div className="design-loading" role="status" aria-live="polite">
          <span className="design-spinner" aria-hidden />
          <span>Reasoning over the plate and drafting five test-fits — this takes about a minute.</span>
        </div>
      )}

      {note && <div className="inline-note" role="status">{note}</div>}

      {options && (
        <div className="design-grid" role="listbox" aria-label="AI design options">
          {options.map((o) => {
            const active = o.objective.id === activeId
            const perSeat = o.pax > 0 ? o.nia / o.pax : 0
            return (
              <button
                key={o.objective.id}
                type="button"
                data-testid="design-option"
                className={`design-card${active ? ' is-active' : ''}`}
                role="option"
                aria-selected={active}
                onClick={() => pick(o)}
                title={`Apply the ${o.objective.label} design`}
              >
                <img
                  className="design-card-thumb"
                  src={o.thumb}
                  alt={`${o.objective.label} plan schematic`}
                  draggable={false}
                />
                <div className="design-card-head">
                  <span className="design-card-label">{o.objective.label}</span>
                  {active && <span className="design-card-live">Live</span>}
                </div>
                <div className="design-card-tagline">{o.objective.tagline}</div>
                <div className="design-metrics">
                  <Metric icon="people" value={String(o.pax)} label="seats" />
                  <Metric value={perSeat ? perSeat.toFixed(1) : '—'} label="m²/seat" />
                  <Metric value={formatINR(o.cost)} label="fit-out" />
                  <Metric icon="leaf" value={Math.round(o.carbon).toLocaleString('en-IN')} label="kgCO₂e" />
                </div>
                {o.spec.rationale && <p className="design-card-why">{o.spec.rationale}</p>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Metric({ icon, value, label }: { icon?: 'people' | 'leaf'; value: string; label: string }) {
  return (
    <div className="design-metric">
      <span className="design-metric-value num">
        {icon && <Icon name={icon} size={11} />}
        {value}
      </span>
      <span className="design-metric-label">{label}</span>
    </div>
  )
}
