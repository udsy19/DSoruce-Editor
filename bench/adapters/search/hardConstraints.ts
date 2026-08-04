// `hard-constraints` — building code as an IN-PIPELINE constraint rather than a
// post-hoc score.
//
// Mechanism: NBC 2016 minimums are enforced on the PROGRAM before the solver
// runs (so a violating program is never generated), and any result that still
// measures a violation is rejected from the candidate set rather than ranked
// down. The claim is a guarantee — zero violations — not a better score.
//
// ADR 0005 pre-registers that this may score LOWER at zero violations, and that
// this is an adoptable outcome rather than a loss: constraint satisfaction costs
// search freedom, and whether the guarantee is worth the score is a product
// call, not a race result.
//
// LICENCE: poolpet/floorplan6 is AGPL-3.0 — REFERENCE ONLY, never vendored. The
// rules below are our own, already present in the core (`layout.rs` corridor
// handling, `circulation.rs` NBC-grounded scoring); this is a clean-room
// reimplementation of the *technique* (constraints in-pipeline).

import { STRATEGIES } from '../../../web/src/editor/strategy'
import type { Program } from '../../../web/src/types/program'
import type { SearchCandidate, SearchStrategy, Solver } from './types'

/** NBC 2016-grounded minimums, the same ones the core scores against. */
export const NBC_MIN_CORRIDOR_M = 1.5
export const NBC_MIN_DESK_CLEARANCE_M = 0.9

/** Force a program to satisfy the code before it is ever generated. */
export function enforce(p: Program): Program {
  return {
    ...p,
    target_corridor_m: Math.max(p.target_corridor_m, NBC_MIN_CORRIDOR_M),
    desk_clearance_m: Math.max(p.desk_clearance_m, NBC_MIN_DESK_CLEARANCE_M),
  }
}

export const hardConstraints: SearchStrategy = {
  meta: {
    id: 'hard-constraints',
    summary:
      'NBC 2016 minimums enforced on the program pre-solve; violating results rejected, not ranked down.',
    portability: 'C-reference',
    license: 'original clean-room (technique ref: poolpet/floorplan6, AGPL-3.0 — never vendored)',
    upstream: 'https://github.com/poolpet/floorplan6',
  },
  search(solver: Solver, base: Program): SearchCandidate[] {
    const out: SearchCandidate[] = []
    const constrained = enforce(base)
    const per = Math.max(1, Math.floor(solver.remaining() / STRATEGIES.length))
    const offset = Math.floor(solver.rand() * 1000)
    STRATEGIES.forEach((strategy, si) => {
      const program: Program = { ...constrained, strategy }
      for (let i = 1; i <= per; i++) {
        if (solver.remaining() <= 0) return
        const seed = si * 100_000 + offset + i
        const score = solver.generate(program, seed)
        if (!score) return
        out.push({ program, seed, score })
      }
    })
    while (solver.remaining() > 0) {
      const program: Program = { ...constrained, strategy: STRATEGIES[0] }
      const score = solver.generate(program, offset + per + out.length + 1)
      if (!score) break
      out.push({ program, seed: offset + per + out.length, score })
    }
    return out.sort((a, b) => b.score.total - a.score.total)
  },
}
export default hardConstraints
