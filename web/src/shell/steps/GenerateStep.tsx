// Generate step — design: docs/design/workflow.md §0/§3 (Slice 7, terminal step).
//
// "Pick a test-fit": on entry it (re-)arms the already-mounted editor with the
// Space/Program working state (area, markers, anchors + the resolved Program)
// and runs the autonomous seed-search through the EditorController, then shows
// an A/B/C alternatives gallery. Each option carries a plan thumbnail, its
// headline metrics (workstations, m²/person, efficiency) and CATEGORY-WINNER
// badges computed across the candidates. The Claude soft-goal verdict annotates
// a card when a key is configured (gracefully skipped otherwise).
//
// No metric logic is duplicated: the per-candidate KPIs reuse the report
// exporter's `buildReportModel` (export/report.ts) — the exact numbers the
// branded PDF prints — and the verdicts reuse `evaluateCandidates` (ai/
// evaluator.ts). Picking an option carries it into the editor via the
// controller's `openCandidate` (applyCandidate + save as a project floor) and
// deep-links #/p/:pid/f/:planId; the chosen seed is remembered on the draft.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorController } from '../../App'
import type { Candidate, GenResult } from '../../editor/EditorCanvas'
import { buildReportModel, type AltKpis } from '../../export/report'
import { evaluateCandidates, type SoftVerdict } from '../../ai/evaluator'
import { getProject, updateDraft, updateProject, type ProjectRecord } from '../../persist/projects'
import { defaultSpec, programSpecToProgram } from '../../program/spec'
import { navigate } from '../route'
import { Icon } from '../../ui/icons'

const LETTER = (i: number) => String.fromCharCode(65 + (i % 26))

/** For each candidate index, the category badges it wins (ties → first wins). */
function computeWinners(kpis: AltKpis[]): Record<number, string[]> {
  const out: Record<number, string[]> = {}
  if (kpis.length < 2) return out // a single option "wins" nothing meaningful
  const add = (i: number, label: string) => (out[i] = [...(out[i] ?? []), label])
  const argmax = (f: (a: AltKpis) => number) => {
    let bi = 0
    kpis.forEach((a, i) => {
      if (f(a) > f(kpis[bi])) bi = i
    })
    return bi
  }
  add(argmax((a) => a.seats), 'Most seats')
  add(argmax((a) => a.daylightPct), 'Best daylight')
  // Densest = most workstations per m² of net internal area.
  add(argmax((a) => (a.niaM2 > 0 ? a.workstations / a.niaM2 : 0)), 'Best density')
  return out
}

type Phase = 'running' | 'done' | 'error'

export function GenerateStep({
  projectId,
  controller,
  onReadyChange,
}: {
  projectId: string
  controller: React.RefObject<EditorController | null>
  onReadyChange?: (ready: boolean) => void
}) {
  const [phase, setPhase] = useState<Phase>('running')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [kpis, setKpis] = useState<AltKpis[]>([])
  const [verdicts, setVerdicts] = useState<Record<number, SoftVerdict>>({})
  const [activeSeed, setActiveSeed] = useState<number | null>(null)
  const [result, setResult] = useState<GenResult | null>(null)
  const [round, setRound] = useState(0)
  const projectRef = useRef<ProjectRecord | null>(null)
  const readyRef = useRef(onReadyChange)
  readyRef.current = onReadyChange

  const badges = useMemo(() => computeWinners(kpis), [kpis])

  const runSearch = async (searchRound: number) => {
    setPhase('running')
    setVerdicts({})
    readyRef.current?.(false)
    const rec = (await getProject(projectId)) ?? null
    projectRef.current = rec
    const spec = rec?.draft?.spec ?? defaultSpec(rec?.draft?.readouts?.usableAreaM2 ?? null)
    const program = programSpecToProgram(spec)
    // Re-arm the editor authoritatively: rebuild the plate + push area/markers/
    // anchors, then set the resolved program. Idempotent (deterministic per
    // seed), so re-entering / regenerating is safe.
    controller.current?.testFit({
      areaPolygon: rec?.draft?.areaPolygon,
      markers: rec?.draft?.markers,
      anchors: rec?.draft?.anchors,
      silent: true,
    })
    controller.current?.setProgram(program)
    // Let the "generating" state paint before the synchronous wasm search.
    await new Promise((r) => setTimeout(r, 30))
    const res = controller.current?.runGenerate(program, {
      // Regenerate widens the seed search (and lifts the early-stop target) so a
      // second pass surfaces genuinely different families, not the same top-K.
      maxIter: 18 + searchRound * 8,
      target: searchRound === 0 ? 82 : 100,
    })
    if (!res || res.candidates.length === 0) {
      setPhase('error')
      return
    }
    const cands = res.candidates
    // Per-candidate KPIs from the SAME helper the branded report prints.
    const model = buildReportModel(
      cands.map((c, i) => ({ name: `Alternative ${LETTER(i)}`, snapshot: c.snap as string })),
      { project: rec?.name ?? 'Untitled Plan' },
    )
    setResult(res)
    setCandidates(cands)
    setKpis(model.alternatives)
    setActiveSeed(res.seed)
    setPhase('done')
    readyRef.current?.(true)
    // Claude soft-goal evaluation — gated + gracefully null without a key.
    const gate = Math.min(82, Math.floor(res.best.total))
    void evaluateCandidates(cands, program, gate).then((ai) => {
      if (ai) setVerdicts(Object.fromEntries(ai.verdicts.map((v) => [v.seed, v])))
    })
  }

  // Run once on entry. The deferred start means React StrictMode's throwaway
  // first mount cancels its timer before the (expensive) search fires.
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      if (alive) void runSearch(0)
    }, 40)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const regenerate = () => {
    const next = round + 1
    setRound(next)
    void runSearch(next)
  }

  const openCandidate = async (c: Candidate) => {
    const rec = projectRef.current
    const proj = rec ? { id: rec.id, name: rec.name, floor: rec.floor ?? '1' } : undefined
    const planId = (await controller.current?.openCandidate(c, proj)) ?? null
    // Remember the chosen candidate on the draft (reproducible per seed) + the
    // saved floor on the record (workflow.md §2).
    await updateDraft(projectId, { winningSeed: c.seed })
    if (rec && planId) await updateProject(projectId, { chosenPlanId: planId })
    navigate(rec && planId ? { name: 'editor', projectId, planId } : { name: 'editor' })
  }

  if (phase === 'running') {
    return (
      <div className="generate-step" data-testid="generate-step">
        <div className="generate-running" data-testid="generate-running">
          <span className="generate-spinner" aria-hidden />
          <div className="generate-running-copy">
            <div className="generate-running-lead">Searching layouts…</div>
            <p className="generate-running-sub">
              The engine generates and scores alternatives against your program, keeping the
              strongest-scoring fits for your criteria.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="generate-step" data-testid="generate-step">
        <div className="generate-error" role="alert" data-testid="generate-error">
          <Icon name="warn" size={16} />
          <div>
            <div className="generate-error-lead">Couldn't generate a test-fit.</div>
            <p>
              Go <strong>Back</strong> to Space and drop a CAD plate the generator can build inside,
              then set the program again.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="generate-step" data-testid="generate-step">
      <div className="generate-head">
        <div>
          <div className="panel-eyebrow">
            <Icon name="sparkles" size={13} /> {candidates.length} alternative
            {candidates.length === 1 ? '' : 's'} · best {Math.round(result?.best.total ?? 0)}/100
          </div>
          <p className="generate-lead">
            Each option optimises your program differently. Category winners are badged — open one to
            edit it, or regenerate to explore a wider search.
          </p>
        </div>
        <button
          type="button"
          className="cta-ghost generate-regenerate"
          data-testid="generate-regenerate"
          onClick={regenerate}
        >
          <Icon name="generate" size={14} /> Regenerate
        </button>
      </div>

      <div className="generate-gallery">
        {candidates.map((c, i) => {
          const k = kpis[i]
          const ai = verdicts[c.seed]
          const wins = badges[i] ?? []
          const active = c.seed === activeSeed
          return (
            <article
              key={c.seed}
              className={`generate-alt${active ? ' on' : ''}`}
              data-testid="generate-alt"
            >
              <button
                type="button"
                className="generate-alt-thumb"
                onClick={() => setActiveSeed(c.seed)}
                aria-pressed={active}
                aria-label={`Select Alternative ${LETTER(i)}`}
              >
                <img src={c.thumb} alt={`Alternative ${LETTER(i)} floor plan`} draggable={false} />
                <span className="generate-alt-letter">{LETTER(i)}</span>
              </button>
              <div className="generate-alt-body">
                <div className="generate-alt-title">
                  <span className="generate-alt-name">Alternative {LETTER(i)}</span>
                  <span className="generate-alt-score num">
                    {Math.round(c.score.total)}
                    <span className="generate-alt-score-of">/100</span>
                  </span>
                </div>

                {wins.length > 0 && (
                  <div className="generate-badges">
                    {wins.map((w) => (
                      <span key={w} className="generate-badge" data-testid="generate-badge">
                        <Icon name="check" size={10} /> {w}
                      </span>
                    ))}
                  </div>
                )}

                <dl className="generate-alt-metrics">
                  <div>
                    <dt>Workstations</dt>
                    <dd className="num">{k?.workstations ?? c.score.placed_desks}</dd>
                  </div>
                  <div>
                    <dt>m²/person</dt>
                    <dd className="num">{k ? k.densityM2.toFixed(1) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Efficiency</dt>
                    <dd className="num">{k ? `${Math.round(k.efficiencyPct)}%` : '—'}</dd>
                  </div>
                </dl>

                {ai && (
                  <div className="generate-alt-ai" data-testid="generate-alt-ai">
                    <span className="generate-alt-ai-badge num">AI {Math.round(ai.score)}</span>
                    <span className="generate-alt-ai-verdict">{ai.verdict}</span>
                  </div>
                )}

                <button
                  type="button"
                  className="cta generate-alt-open"
                  data-testid="generate-alt-open"
                  onClick={() => void openCandidate(c)}
                >
                  Open in editor <Icon name="caret" size={13} />
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
