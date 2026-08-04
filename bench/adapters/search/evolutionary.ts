// `evolutionary` — multi-objective GA over PROGRAM/STRATEGY parameters.
//
// Mechanism: a population of programs, each evaluated by the unmodified solver;
// tournament selection, uniform crossover, bounded mutation on the weight vector
// and the layout knobs. Information carries between generations, which is the
// one thing plain re-seeding cannot do.
//
// The solver is untouched — this searches the PROGRAM space, not geometry.
// Randomness comes only from `solver.rand()`, seeded from the search seed, so
// the whole run is reproducible (determinism is a hard gate).
//
// Pattern reference: renatogcruz/generative_design (GA over parametric design).
// Class A: reimplemented here, nothing vendored.

import { STRATEGIES } from '../../../web/src/editor/strategy'
import type { Program } from '../../../web/src/types/program'
import type { SearchCandidate, SearchStrategy, Solver } from './types'

/** Genes: the knobs a program exposes that do not change what was ASKED for. */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function mutate(p: Program, rand: () => number, strength: number): Program {
  const jitter = (v: number, lo: number, hi: number) =>
    clamp(v + (rand() - 0.5) * 2 * strength * (hi - lo), lo, hi)
  return {
    ...p,
    // Objective weights — what the search is really optimising over.
    w_capacity: jitter(p.w_capacity, 0.05, 0.6),
    w_adjacency: jitter(p.w_adjacency, 0.05, 0.5),
    w_circulation: jitter(p.w_circulation, 0.05, 0.5),
    w_density: jitter(p.w_density, 0.05, 0.5),
    w_program: jitter(p.w_program, 0.0, 0.4),
    w_daylight: jitter(p.w_daylight, 0.0, 0.3),
    w_entry: jitter(p.w_entry, 0.0, 0.3),
    // Layout knobs.
    cluster_cols: Math.round(jitter(p.cluster_cols, 2, 8)),
    bench_pairs: rand() < 0.15 ? !p.bench_pairs : p.bench_pairs,
    strategy: rand() < 0.2 ? STRATEGIES[Math.floor(rand() * STRATEGIES.length)] : p.strategy,
  }
}

function cross(a: Program, b: Program, rand: () => number): Program {
  const pick = <K extends keyof Program>(k: K): Program[K] => (rand() < 0.5 ? a[k] : b[k])
  return {
    ...a,
    w_capacity: pick('w_capacity'), w_adjacency: pick('w_adjacency'),
    w_circulation: pick('w_circulation'), w_density: pick('w_density'),
    w_program: pick('w_program'), w_daylight: pick('w_daylight'),
    w_entry: pick('w_entry'), cluster_cols: pick('cluster_cols'),
    bench_pairs: pick('bench_pairs'), strategy: pick('strategy'),
  }
}

const POP = 6

export const evolutionary: SearchStrategy = {
  meta: {
    id: 'evolutionary',
    summary: 'GA over program/strategy parameters: tournament selection, uniform crossover, bounded mutation.',
    portability: 'A-port',
    license: 'original (pattern ref: renatogcruz/generative_design)',
  },
  search(solver: Solver, base: Program): SearchCandidate[] {
    const out: SearchCandidate[] = []
    const rand = () => solver.rand()
    // Seed the population from the three strategies so generation 0 is at least
    // as diverse as one round of the incumbent.
    let pop: Program[] = []
    for (let i = 0; i < POP; i++) {
      const strategy = STRATEGIES[i % STRATEGIES.length]
      pop.push(i < STRATEGIES.length ? { ...base, strategy } : mutate({ ...base, strategy }, rand, 0.35))
    }
    let seedCounter = 1
    let scored: SearchCandidate[] = []
    while (solver.remaining() > 0) {
      scored = []
      for (const program of pop) {
        if (solver.remaining() <= 0) break
        const seed = seedCounter++
        const score = solver.generate(program, seed)
        if (!score) break
        const c = { program, seed, score }
        scored.push(c)
        out.push(c)
      }
      if (solver.remaining() <= 0 || scored.length < 2) break
      // Tournament selection + crossover + decaying mutation.
      scored.sort((a, b) => b.score.total - a.score.total)
      const elite = scored.slice(0, Math.max(2, Math.floor(scored.length / 2)))
      const next: Program[] = [elite[0].program] // elitism: never lose the best
      while (next.length < POP) {
        const a = elite[Math.floor(rand() * elite.length)].program
        const b = elite[Math.floor(rand() * elite.length)].program
        next.push(mutate(cross(a, b, rand), rand, 0.2))
      }
      pop = next
    }
    return out.sort((a, b) => b.score.total - a.score.total)
  },
}
export default evolutionary
