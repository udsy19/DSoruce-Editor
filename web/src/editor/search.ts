// THE AUTONOMOUS SEARCH LOOP — generate → evaluate → optimize (the product's
// differentiator). Four escalating levels, all on the same {@link SearchHost}:
//
//   autoGenerate  — deterministic seed search across the three STRATEGIES.
//   refineWithAI  — Claude SHAPES the next batch (bounded program deltas),
//                   kept only when a fixed-weight yardstick improves.
//   designWithAI  — Claude DESIGNS the program from a brief.
//   designOptions — one objective-optimised design option per objective.
//
// Split out of `EditorCanvas.ts` (which stays the public façade). Every mutation
// goes through the core (`host.ed.generate/restore/...`) and every read comes
// back from `host.getState()` / `host.getMetrics()` — nothing is cached here.
// Determinism is the contract: `(strategy, seed)` always reproduces the exact
// plan, and `seed` crosses the wasm boundary as a `BigInt`.

import type { Editor } from '../wasm/ds_core'
import type { DocState } from '../types/doc'
import type { LayoutScore, Metrics, ZoneStat } from '../types/metrics'
import type { Candidate, GenResult, Program } from '../types/program'
import { STRATEGIES, STRATEGY_SEED_STRIDE, seedWindowOffset } from './strategy'
import { renderThumb } from './paint'
import { evaluatorAvailable } from '../ai/evaluator'
import { applyDelta, proposeAdjustment, refScore, type ProgramDelta } from '../ai/refine'
import {
  proposeDesign,
  proposeDesignOptions,
  applyDesignSpec,
  DESIGN_OBJECTIVES,
  type DesignSpec,
  type DesignObjective,
} from '../ai/designer'

/** What the search needs from the canvas. `EditorCanvas` supplies a live
 *  getter-backed view of itself, so `ed`/`program` always track the canvas. */
export interface SearchHost {
  readonly ed: Editor
  /** Last program used to generate — the search reads AND updates it. */
  program: Program
  getState(): DocState
  getMetrics(): Metrics
  getZoneStats(): ZoneStat[]
  snapshot(): string
  restore(snap: string): void
  /** Replay the document's cad_json blob into the CAD store after a restore. */
  hydrateCad(): void
  /** Repaint + notify React. */
  commit(): void
  generateOnce(program: Program, seed: number, keepConfirmed?: boolean): LayoutScore
}

/** One objective-optimised design option (Laiout-style) from {@link designOptions}:
 *  Claude's spec + the realised fit + its headline metric, snapshot-backed. */
export interface DesignOptionResult {
  objective: DesignObjective
  spec: DesignSpec
  score: LayoutScore
  /** Placed workstations. */
  pax: number
  /** Indicative fit-out cost (₹). */
  cost: number
  /** Indicative embodied carbon (kgCO₂e). */
  carbon: number
  /** Net internal area (m²). */
  nia: number
  /** Opaque snapshot — pass to `applyCandidate` to make this option live. */
  snapshot: string
  thumb: string
}

/** One reasoning step of the AI refinement loop (surfaced in the UI trace). */
export interface RefineStep {
  iteration: number
  /** Claude's one-line reason for this adjustment. */
  rationale: string
  /** The bounded, clamped program delta it proposed. */
  delta: ProgramDelta
  /** Fixed-weight yardstick score before and after applying + regenerating. */
  scoreBefore: number
  scoreAfter: number
  /** Kept (improved the yardstick) or reverted. */
  accepted: boolean
}

/** Result of {@link refineWithAI}: the (best) generation now live, plus the
 *  reasoning trace so the UI can show before→after + rationale. */
export interface RefineOutcome {
  /** The winning generation — what is live on the canvas. */
  result: GenResult
  /** The (possibly adjusted) program that produced it. */
  program: Program
  steps: RefineStep[]
  /** Fixed-weight yardstick of the initial vs final winner. */
  baseScore: number
  finalScore: number
  improved: boolean
  /** false = clean no-op (no Claude key): `result` is the plain autoGenerate run. */
  ranAI: boolean
}

/** Search knobs shared by {@link autoGenerate} and {@link refineWithAI}. */
export interface SearchOpts {
  maxIter: number
  target: number
  keepConfirmed?: boolean
  seedOffset?: number
}

/**
 * Autonomous test-fit search across the three STRATEGIES (M7). Each strategy
 * runs its OWN seed search (early-stopping once `target` total is met) and
 * contributes its single best-scoring plan, so the gallery's A/B/C are
 * strategically DISTINCT — Open (dense open field) · Balanced (professional
 * mix) · Cellular (privacy-forward) — a real trade-off, not seed-noise. The
 * Rust generator is deterministic per (strategy, seed); the live document is
 * restored to the overall best-scoring option at the end.
 *
 * Seeds are kept in disjoint per-strategy ranges (`strategyIndex·STRIDE + s`)
 * so a candidate's `seed` is globally unique — the gallery keys by it — while
 * `(strategy, seed)` still reproduces the exact plan. When `keepConfirmed` is
 * set, Confirmed components are frozen and every candidate packs around them.
 *
 * `seedOffset` slides the searched seed WINDOW within each strategy's stride
 * band: the UI advances it every Regenerate press so consecutive presses
 * explore genuinely different seeds (real variety) while any exact
 * `(strategy, seed)` stays deterministic. It is wrapped inside the stride so a
 * candidate's global seed remains unique per strategy.
 */
export function autoGenerate(host: SearchHost, program: Program, opts: SearchOpts): GenResult {
  const keep = opts.keepConfirmed ?? false
  host.program = { ...program }
  const STRIDE = STRATEGY_SEED_STRIDE
  // Keep the window (offset+1 .. offset+maxIter) inside the strategy's stride
  // band so global seeds never collide across strategies.
  const offset = seedWindowOffset(opts.seedOffset ?? 0, opts.maxIter)
  const candidates: Candidate[] = []
  let iterations = 0
  STRATEGIES.forEach((strategy, si) => {
    const sp: Program = { ...program, strategy }
    let best: LayoutScore | null = null
    let bestSeed = si * STRIDE + offset + 1
    for (let seed = 1; seed <= opts.maxIter; seed++) {
      iterations++
      const actual = si * STRIDE + offset + seed
      const sc = host.ed.generate(sp, BigInt(actual), keep) as LayoutScore
      if (!best || sc.total > best.total) {
        best = sc
        bestSeed = actual
      }
      if (best.total >= opts.target) break
    }
    // Re-generate the strategy's winning seed to capture its snapshot + thumb.
    const finalSc = host.ed.generate(sp, BigInt(bestSeed), keep) as LayoutScore
    candidates.push({
      seed: bestSeed,
      strategy,
      score: finalSc,
      snap: host.ed.snapshot(),
      thumb: renderThumb(host.getState()),
    })
  })
  // The live document reflects the overall best-scoring option (candidates
  // stay in strategy order so A/B/C map to Open/Balanced/Cellular).
  const best = candidates.reduce((a, b) => (b.score.total > a.score.total ? b : a))
  host.ed.restore(best.snap as string)
  host.hydrateCad()
  host.ed.clear_selection()
  host.commit()
  return { best: best.score, iterations, seed: best.seed, candidates }
}

/**
 * Autonomous REASONING loop (the vision's generate→evaluate→optimize): an
 * initial {@link autoGenerate}, then up to `refineIters` rounds where Claude
 * SHAPES the next batch — proposing a bounded program delta (desks / meetings
 * / corridor / cluster density / adjacency + circulation emphasis) via the
 * `adjust_program` tool — which we apply, regenerate, and KEEP only if a
 * FIXED-weight yardstick ({@link refScore} under the ORIGINAL weights) rises.
 * A rejected round is reverted (only the winner stays live); a null delta or a
 * non-improving round ends the loop early (convergence). Each round's rationale
 * is captured in `steps`.
 *
 * WITHOUT a Claude key this is a clean no-op: it returns the plain
 * autoGenerate result with `ranAI: false` — generation is never blocked.
 * Latency is bounded: iterations are capped 1–3 and the search runs on the
 * live doc but every trial is snapshot-guarded so only the accepted plan
 * survives.
 */
export async function refineWithAI(
  host: SearchHost,
  program: Program,
  opts: SearchOpts & { refineIters?: number; softGoals?: string },
): Promise<RefineOutcome> {
  const gen: SearchOpts = {
    maxIter: opts.maxIter,
    target: opts.target,
    keepConfirmed: opts.keepConfirmed,
    seedOffset: opts.seedOffset,
  }
  // Fixed rubric: the ORIGINAL weights, so re-weighting deltas are judged fairly.
  const refWeights: Program = { ...program }
  const base = autoGenerate(host, program, gen)
  const baseScore = refScore(base.best, refWeights)

  let curProgram: Program = { ...program }
  let curResult = base
  let curScore = baseScore
  const steps: RefineStep[] = []

  if (!(await evaluatorAvailable())) {
    return { result: base, program: curProgram, steps, baseScore, finalScore: baseScore, improved: false, ranAI: false }
  }

  let liveSnap = host.snapshot() // the last ACCEPTED plan (currently `base`)
  const rounds = Math.max(1, Math.min(3, opts.refineIters ?? 3))
  const softGoals =
    opts.softGoals?.trim() ||
    'Balance a dense open-desk field with legible circulation and coherent room adjacencies.'

  for (let i = 0; i < rounds; i++) {
    const delta: ProgramDelta | null = await proposeAdjustment({
      program: curProgram,
      best: curResult.best,
      zones: host.getZoneStats(),
      softGoals,
    })
    if (!delta) break // converged / declined / errored

    const nextProgram = applyDelta(curProgram, delta)
    if (programLeversEqual(nextProgram, curProgram)) {
      // Clamped down to no change — record the rationale, then stop.
      steps.push({ iteration: i + 1, rationale: delta.rationale ?? '', delta, scoreBefore: curScore, scoreAfter: curScore, accepted: false })
      break
    }

    const trial = autoGenerate(host, nextProgram, gen)
    const trialScore = refScore(trial.best, refWeights)
    const accepted = trialScore > curScore + 1e-6
    steps.push({ iteration: i + 1, rationale: delta.rationale ?? '', delta, scoreBefore: curScore, scoreAfter: trialScore, accepted })

    if (accepted) {
      curProgram = nextProgram
      curResult = trial
      curScore = trialScore
      liveSnap = host.snapshot() // this trial is the new winner (already live)
    } else {
      host.restore(liveSnap) // revert: keep the last accepted plan live
      break
    }
  }

  host.program = { ...curProgram }
  return { result: curResult, program: curProgram, steps, baseScore, finalScore: curScore, improved: curScore > baseScore + 1e-6, ranAI: true }
}

/**
 * AGENTIC SENIOR DESIGNER (docs/design/agentic-designer.md, phase 1). Claude
 * DESIGNS the program from a brief — deciding headcount, desk + meeting counts,
 * the spatial strategy, the support-room mix with placement bias, and objective
 * emphasis — and APPLIES it to `host.program`. The caller then generates (the UI
 * runs the normal seed-search so Claude's design gets the A/B/C gallery + gates;
 * a script can `generateOnce`). Geometry stays entirely with the solver — Claude
 * never emits coordinates. A plate must exist (walls); the design is sized to the
 * net internal area. Returns the spec (incl. Claude's rationale), or `null`
 * without a Claude key / on failure (design is never blocking — fall back to
 * Generate).
 */
export async function designWithAI(
  host: SearchHost,
  brief: string,
  signal?: AbortSignal,
): Promise<DesignSpec | null> {
  const m = host.getMetrics()
  if (m.wall_count === 0) return null // no plate to design for
  const plateAreaM2 = m.net_internal_area ?? m.floor_area
  const spec = await proposeDesign({ plateAreaM2, program: host.program, brief }, signal)
  if (!spec) return null
  host.program = applyDesignSpec(host.program, spec)
  return spec
}

/**
 * MULTI-OBJECTIVE designer (docs/design/agentic-designer.md; Laiout-style option
 * set). Claude designs a DISTINCT fit per objective — Max people / Budget / Low
 * carbon / Wellbeing / Balanced — and the solver realizes each; every option
 * carries its headline metric (pax · ₹ fit-out · kgCO₂e) for the option cards.
 * Snapshots are captured so the UI can make any option live. Leaves the program
 * unchanged. Returns [] without a Claude key / plate.
 */
export async function designOptions(
  host: SearchHost,
  brief: string,
  seed = 1,
  signal?: AbortSignal,
): Promise<DesignOptionResult[]> {
  const m0 = host.getMetrics()
  if (m0.wall_count === 0) return []
  const plateAreaM2 = m0.net_internal_area ?? m0.floor_area
  const opts = await proposeDesignOptions({ plateAreaM2, program: host.program, brief }, DESIGN_OBJECTIVES, signal)
  const base = { ...host.program }
  const out: DesignOptionResult[] = []
  for (const o of opts) {
    host.program = applyDesignSpec(base, o.spec)
    const score = host.generateOnce(host.program, seed)
    const m = host.getMetrics()
    out.push({
      objective: o.objective,
      spec: o.spec,
      score,
      pax: m.workstations ?? 0,
      cost: m.indicative_cost ?? 0,
      carbon: m.indicative_carbon ?? 0,
      nia: m.net_internal_area ?? 0,
      snapshot: host.ed.snapshot() as string,
      thumb: renderThumb(host.getState()),
    })
  }
  host.program = base
  return out
}

/** True when two programs match on every lever the AI delta can touch. */
function programLeversEqual(a: Program, b: Program): boolean {
  return (
    a.desks === b.desks &&
    a.meeting_rooms === b.meeting_rooms &&
    a.target_corridor_m === b.target_corridor_m &&
    a.cluster_cols === b.cluster_cols &&
    a.w_adjacency === b.w_adjacency &&
    a.w_circulation === b.w_circulation
  )
}
