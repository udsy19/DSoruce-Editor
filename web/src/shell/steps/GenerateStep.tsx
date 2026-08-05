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
import type { Candidate, GenResult } from '../../types/program'
import { STRATEGY_LABEL, STRATEGY_BLURB } from '../../editor/EditorCanvas'
import { buildReportModel, computeWinners, type AltKpis } from '../../export/report'
import { evaluateCandidates, evaluatorAvailable, type SoftVerdict } from '../../ai/evaluator'
import { getProject, updateDraft, updateProject, type ProjectRecord } from '../../persist/projects'
import { defaultSpec, programSpecToProgram } from '../../program/spec'
import { snapshotIsEmpty } from '../../persist/plans'
import { navigate } from '../route'
import { resumeDrawing } from '../resume'
import { Icon } from '../../ui/icons'

const LETTER = (i: number) => String.fromCharCode(65 + (i % 26))


// Category-winner badges (Most seats / Best daylight / Best density) are
// computed by the shared `computeWinners` in export/report.ts, so this gallery
// and the exported space-planning report always agree.

type Phase = 'running' | 'done' | 'error' | 'noplate'
// The soft-goal (Claude) pass runs across the WHOLE gallery, so every card
// shares one state: 'off' (no key / batch too weak / failed → no AI on any
// card), 'pending' (request in flight → all cards show a loading line), or
// 'ready' (verdicts in → each card shows its own, or an honest "not assessed").
type AiPhase = 'off' | 'pending' | 'ready'

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
  const [aiPhase, setAiPhase] = useState<AiPhase>('off')
  const [activeSeed, setActiveSeed] = useState<number | null>(null)
  const [result, setResult] = useState<GenResult | null>(null)
  const [round, setRound] = useState(0)
  const projectRef = useRef<ProjectRecord | null>(null)
  // Guards the async AI pass against a newer search (regenerate) resolving late.
  const runTokenRef = useRef(0)
  const readyRef = useRef(onReadyChange)
  readyRef.current = onReadyChange

  const badges = useMemo(() => computeWinners(kpis), [kpis])

  const runSearch = async (searchRound: number) => {
    const token = ++runTokenRef.current
    setPhase('running')
    setVerdicts({})
    setAiPhase('off')
    readyRef.current?.(false)
    const rec = (await getProject(projectId)) ?? null
    projectRef.current = rec
    // COLD START: the editor holds the parsed plate in React state, so a reload
    // straight onto this step arrives with none. Re-push it from the draft
    // before arming the editor (shell/resume.ts).
    const hasPlate = resumeDrawing(controller.current, rec)
    const spec = rec?.draft?.spec ?? defaultSpec(rec?.draft?.readouts?.usableAreaM2 ?? null)
    const program = programSpecToProgram(spec)
    // Re-arm the editor authoritatively: rebuild the plate + push area/markers/
    // anchors, then set the resolved program. Idempotent (deterministic per
    // seed), so re-entering / regenerating is safe.
    controller.current?.testFit({
      areaPolygon: rec?.draft?.areaPolygon,
      markers: rec?.draft?.markers,
      anchors: rec?.draft?.anchors,
      heal: rec?.draft?.heal?.on ?? true,
      keepExisting: rec?.draft?.keepExisting ?? false,
      silent: true,
    })
    controller.current?.setProgram(program)
    // REFUSE TO INVENT A RESULT. Whatever the reason the plate is empty — a
    // cold start with no persisted drawing, a project that never got an upload,
    // a future path nobody has thought of yet — the generator will happily run
    // on nothing and return three 0-workstation "alternatives", which the
    // gallery then badges and the user can save as a floor. There is no honest
    // gallery to draw here, so draw none. This is checked AFTER `testFit` (the
    // plate is what testFit builds) and BEFORE the search, so no empty
    // candidate ever reaches state.
    // `hasPlate` is authoritative for "this project has no upload"; the wall
    // count catches "it has one, but it traces to nothing". Reading walls ALONE
    // was wrong: they may still belong to the project you just navigated away
    // from.
    if (!hasPlate || (controller.current?.ec()?.getState().walls.length ?? 0) === 0) {
      setPhase('noplate')
      readyRef.current?.(false)
      return
    }
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
      cands.map((c, i) => ({
        name: `Alternative ${LETTER(i)} — ${STRATEGY_LABEL[c.strategy]}`,
        snapshot: c.snap as string,
      })),
      { project: rec?.name ?? 'Untitled Plan' },
    )
    setResult(res)
    setCandidates(cands)
    setKpis(model.alternatives)
    setActiveSeed(res.seed)
    setPhase('done')
    readyRef.current?.(true)
    // Claude soft-goal evaluation — judges EVERY card in one batch so the
    // gallery is annotated consistently, never just the winner. Gracefully
    // uniform without a key: no card shows an AI line (aiPhase stays 'off').
    const gate = Math.min(82, Math.floor(res.best.total))
    void (async () => {
      // Only flash the per-card loading state if the proxy actually has a key;
      // otherwise leave every card cleanly AI-free (cached, so no extra cost).
      if (!(await evaluatorAvailable())) return
      if (runTokenRef.current !== token) return
      setAiPhase('pending')
      const ai = await evaluateCandidates(cands, program, gate)
      if (runTokenRef.current !== token) return
      if (!ai) {
        // Batch too weak to spend tokens on, or the call failed → uniform off.
        setAiPhase('off')
        return
      }
      setVerdicts(Object.fromEntries(ai.verdicts.map((v) => [v.seed, v])))
      setAiPhase('ready')
    })()
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
    // Belt to the 'noplate' brace: never let an empty document become the
    // project's floor. `chosenPlanId` is how a reopened project finds its way
    // back to the user's work (AppShell §2.4) — pointing it at an empty plan is
    // indistinguishable from having lost the plan.
    if (snapshotIsEmpty(c.snap as string)) return
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

  if (phase === 'noplate') {
    return (
      <div className="generate-step" data-testid="generate-step">
        <div className="generate-error" role="alert" data-testid="generate-noplate">
          <Icon name="warn" size={16} />
          <div>
            <div className="generate-error-lead">There's no floor plate to fit.</div>
            <p>
              This project has no CAD plate loaded, so there is nothing to generate against. Go back
              to <strong>Space</strong> and drop a DWG/DXF — the program you set is kept.
            </p>
            <button
              type="button"
              className="btn-primary"
              data-testid="generate-noplate-back"
              onClick={() => navigate({ name: 'wizard', projectId, step: 'space' })}
            >
              Back to Space
            </button>
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
          const ws = k?.workstations ?? c.score.placed_desks
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
                aria-label={`Select Alternative ${LETTER(i)} — ${STRATEGY_LABEL[c.strategy]}`}
              >
                <img
                  src={c.thumb}
                  alt={`Alternative ${LETTER(i)} (${STRATEGY_LABEL[c.strategy]}) floor plan`}
                  draggable={false}
                />
                <span className="generate-alt-letter">{LETTER(i)}</span>
              </button>
              <div className="generate-alt-body">
                <div className="generate-alt-title">
                  <span className="generate-alt-name">
                    {LETTER(i)} · {STRATEGY_LABEL[c.strategy]}
                  </span>
                  <span className="generate-alt-score num">
                    {Math.round(c.score.total)}
                    <span className="generate-alt-score-of">/100</span>
                  </span>
                </div>
                <p className="generate-alt-blurb">{STRATEGY_BLURB[c.strategy]}</p>

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
                    <dd className="num">{ws}</dd>
                  </div>
                  <div>
                    <dt>m²/person</dt>
                    {/* m²/person is per-seat — meaningless with 0 workstations,
                        so don't imply a density that isn't there. */}
                    <dd className="num">{k && ws > 0 ? k.densityM2.toFixed(1) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Efficiency</dt>
                    <dd className="num">{k ? `${Math.round(k.efficiencyPct)}%` : '—'}</dd>
                  </div>
                </dl>

                {aiPhase === 'pending' && (
                  <div
                    className="generate-alt-ai is-pending"
                    data-testid="generate-alt-ai"
                    aria-busy="true"
                  >
                    <span className="generate-alt-ai-badge">AI</span>
                    <span className="generate-alt-ai-verdict">Assessing soft goals…</span>
                  </div>
                )}
                {aiPhase === 'ready' &&
                  (ai ? (
                    <div className="generate-alt-ai" data-testid="generate-alt-ai">
                      <span className="generate-alt-ai-badge">AI {Math.round(ai.score)}</span>
                      <span className="generate-alt-ai-verdict">{ai.verdict}</span>
                    </div>
                  ) : (
                    <div className="generate-alt-ai is-na" data-testid="generate-alt-ai">
                      <span className="generate-alt-ai-badge">AI</span>
                      <span className="generate-alt-ai-verdict">No assessment returned.</span>
                    </div>
                  ))}

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
