// The incumbent: disjoint-seed-window re-seeding across the three STRATEGIES.
//
// Wrapped unchanged in mechanism — three strategies, N independent seeds each,
// no information carried between draws — with the `target` early-exit removed
// per ADR 0005, because a partial spend cannot be compared to a full one.
//
// It is already seedable: `seedWindowOffset` IS its search seed, so the
// seedability requirement needed no special case for it.

import { STRATEGIES, STRATEGY_SEED_STRIDE, seedWindowOffset } from '../../../web/src/editor/strategy'
import type { Program } from '../../../web/src/types/program'
import type { SearchCandidate, SearchStrategy, Solver } from './types'

export const baseline: SearchStrategy = {
  meta: {
    id: 'baseline',
    summary: 'Disjoint-seed-window re-seeding across three strategies; no information carries between draws.',
    portability: 'A-port',
    license: 'original',
  },
  search(solver: Solver, base: Program): SearchCandidate[] {
    const out: SearchCandidate[] = []
    // Split the budget evenly across strategies, as autoGenerate does.
    const per = Math.max(1, Math.floor(solver.remaining() / STRATEGIES.length))
    const offset = seedWindowOffset(Math.floor(solver.rand() * 1000), per)
    STRATEGIES.forEach((strategy, si) => {
      const program: Program = { ...base, strategy }
      for (let i = 1; i <= per; i++) {
        const seed = si * STRATEGY_SEED_STRIDE + offset + i
        const score = solver.generate(program, seed)
        if (!score) return
        out.push({ program, seed, score })
      }
    })
    // Spend any remainder on the first strategy rather than leaving it unused.
    let extra = 0
    while (solver.remaining() > 0) {
      const program: Program = { ...base, strategy: STRATEGIES[0] }
      const seed = offset + per + (++extra)
      const score = solver.generate(program, seed)
      if (!score) break
      out.push({ program, seed, score })
    }
    return out.sort((a, b) => b.score.total - a.score.total)
  },
}
export default baseline
