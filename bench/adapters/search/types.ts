// The SearchStrategy contract for branch 4a (ADR 0005).
//
// The SOLVER is out of scope: `layout::generate(program, seed)` stays exactly as
// it is, deterministic per seed. Only the search OVER seeds and programs is
// swappable, and no candidate may make an LLM emit geometry.

import type { Program } from '../../../web/src/types/program'
import type { LayoutScore } from '../../../web/src/types/metrics'
import type { PortabilityClass } from '../plate/types'

export type { PortabilityClass }

/** One evaluated point in the search. */
export interface SearchCandidate {
  program: Program
  seed: number
  score: LayoutScore
}

/**
 * The solver, metered. `generate` is the ONLY way to spend budget, and the
 * harness refuses calls past it — so a strategy cannot overspend, and a
 * strategy that underspends is measured on what it actually used.
 */
export interface Solver {
  /** Returns null when the budget is exhausted. */
  generate(program: Program, seed: number): LayoutScore | null
  /** Calls remaining. */
  remaining(): number
  /** Deterministic PRNG seeded from the SEARCH seed — the only randomness a
   *  strategy may use. `Math.random` is banned; determinism is a hard gate. */
  rand(): number
}

export interface SearchStrategyMeta {
  id: string
  summary: string
  portability: PortabilityClass
  license: string
  upstream?: string
}

export interface SearchStrategy {
  meta: SearchStrategyMeta
  /**
   * Explore within `solver`'s budget and return every candidate evaluated, best
   * first. Determinism is a gate: same (program, plate, budget, search seed) must
   * produce an identical list.
   */
  search(solver: Solver, base: Program): SearchCandidate[]
}
