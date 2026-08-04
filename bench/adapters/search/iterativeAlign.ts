// `iterative-align` — a CORRECTIVE step instead of a fresh draw.
//
// Mechanism: keep the current best and perturb it LOCALLY, accepting only
// improvements (seeded hill-climb with a shrinking step), rather than re-drawing
// an independent seed each time. The bet is that when a layout is nearly right,
// nudging it beats rolling again.
//
// SCOPE NOTE, because it bounds what this candidate can be: DirectLayout's
// iterative refinement corrects ASSET PLACEMENT. Our solver is a black box that
// takes (program, seed) and emits a whole plan — there is no placement-level
// handle to nudge without regenerating. Correcting via the fine-grained mutators
// (`move_component`) would improve layouts almost free in call-count terms,
// which ADR 0005 pre-registered as the budget loophole; it is deliberately NOT
// done. So this corrects in PROGRAM space, which is the level the search layer
// actually controls. A placement-level version needs solver support and is a
// different candidate.
//
// Reference: DirectLayout (Class C -> A: technique, not code).

import { STRATEGIES } from '../../../web/src/editor/strategy'
import type { Program } from '../../../web/src/types/program'
import type { SearchCandidate, SearchStrategy, Solver } from './types'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** A small, local move — not a re-roll. Step shrinks as the search converges. */
function nudge(p: Program, rand: () => number, step: number): Program {
  const j = (v: number, lo: number, hi: number) => clamp(v + (rand() - 0.5) * 2 * step * (hi - lo), lo, hi)
  // Perturb ONE weight per step: a local move changes one thing, or it is a redraw.
  const knobs = ['w_capacity', 'w_adjacency', 'w_circulation', 'w_density', 'w_daylight', 'w_entry'] as const
  const k = knobs[Math.floor(rand() * knobs.length)]
  const next: Program = { ...p, [k]: j(p[k] as number, 0, 0.6) } as Program
  if (rand() < 0.25) next.cluster_cols = Math.round(clamp(p.cluster_cols + (rand() < 0.5 ? -1 : 1), 2, 8))
  return next
}

export const iterativeAlign: SearchStrategy = {
  meta: {
    id: 'iterative-align',
    summary: 'Seeded hill-climb in program space: keep the best, nudge locally, accept improvements only.',
    portability: 'A-port',
    license: 'original (technique ref: DirectLayout)',
  },
  search(solver: Solver, base: Program): SearchCandidate[] {
    const out: SearchCandidate[] = []
    const rand = () => solver.rand()
    let seedCounter = 1

    // Anchor on one draw per strategy so the climb starts from a real basin
    // rather than an arbitrary point — otherwise a bad start dominates the run.
    let best: SearchCandidate | null = null
    for (const strategy of STRATEGIES) {
      if (solver.remaining() <= 0) break
      const program: Program = { ...base, strategy }
      const seed = seedCounter++
      const score = solver.generate(program, seed)
      if (!score) break
      const c = { program, seed, score }
      out.push(c)
      if (!best || score.total > best.score.total) best = c
    }
    if (!best) return out

    // Climb. The seed is held FIXED while the program is nudged, so an
    // improvement is attributable to the correction and not to a lucky re-roll —
    // which is the whole distinction this candidate is testing.
    const heldSeed = best.seed
    let step = 0.30
    let sinceImprovement = 0
    while (solver.remaining() > 0) {
      const trial = nudge(best.program, rand, step)
      const score = solver.generate(trial, heldSeed)
      if (!score) break
      const c = { program: trial, seed: heldSeed, score }
      out.push(c)
      if (score.total > best.score.total) {
        best = c
        sinceImprovement = 0
      } else if (++sinceImprovement >= 3) {
        // Converged at this scale: halve the step and keep going.
        step = Math.max(0.05, step / 2)
        sinceImprovement = 0
      }
    }
    return out.sort((a, b) => b.score.total - a.score.total)
  },
}
export default iterativeAlign
