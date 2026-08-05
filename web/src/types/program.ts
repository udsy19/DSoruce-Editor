/**
 * The test-fit program (input to the generator) and the search results it
 * produces.
 *
 * `Program` serializes 1:1 to the wasm `Editor.generate(program, BigInt(seed))`
 * call — field names and shapes mirror Rust `layout::Program`, so changing one
 * side without the other silently breaks deserialization. `Candidate.snap` is an
 * opaque `Editor.snapshot()` blob: TS passes it back to `applyCandidate`/
 * `restore` and never inspects it.
 */

import type { SpaceKind, Placement } from './doc'
import type { LayoutScore } from './metrics'
import type { Strategy } from '../editor/strategy'

/** One explicit room request from the Detailed program builder (mirrors Rust
 *  `layout::RoomReq`). Serializes 1:1 to the wasm `generate` program. */
export interface RoomReq {
  kind: SpaceKind
  count: number
  /** Corridor-run width (m); omitted → the kind's default footprint. */
  w?: number
  /** Depth (m); omitted → the kind's default. */
  d?: number
  placement?: Placement
  /** Briefed occupancy — the user's intent, travelling with the request so the
   *  furniture honours it. 0 / absent = derive from the table. */
  seats?: number
}

/** Test-fit program + objective weights (mirrors Rust `layout::Program`). */
export interface Program {
  desks: number
  meeting_rooms: number
  desk_w: number
  desk_h: number
  meeting_w: number
  meeting_h: number
  cluster_cols: number
  target_corridor_m: number
  desk_clearance_m: number
  /** Back-to-back paired desk rows (real-world bench desking). */
  bench_pairs: boolean
  /** Derive + place the full professional support program (cabins, phone booths,
   * focus, pantry, reception, print, IT, storage, wellness — spec §1.1) alongside
   * the desks/meetings. Default true. */
  support_spaces: boolean
  /** Design headcount N. When set, drives `SpaceProgram::derive`; when omitted it
   * is inferred from the desk target (desks ≈ 0.85·N). Absent → Rust `None`. */
  headcount?: number
  /** Explicit room program from the Detailed builder (workflow.md §3.4). Empty →
   * the derived support program + `meeting_rooms` override (today's behaviour);
   * non-empty → these rooms replace it, counts + placement bias honored. */
  rooms?: RoomReq[]
  /** Space-planning strategy (M7). Absent → Rust `Balanced` (today's behaviour).
   *  `autoGenerate` injects one per alternative so the gallery's A/B/C are
   *  strategically distinct; an explicit `rooms` program pins the counts so a
   *  strategy then only varies layout/scoring, never the counts. */
  strategy?: Strategy
  w_capacity: number
  w_adjacency: number
  w_circulation: number
  w_density: number
  /** Weight of `program_fit` (delivered vs derived room program). */
  w_program: number
  /** Weight of `daylight` (% desks near the facade — M5). */
  w_daylight: number
  /** Weight of `entry_adjacency` (reception near entry, pantry far — M5). */
  w_entry: number
}

/** One retained test-fit option from the autonomous search (Laiout-style gallery). */
export interface Candidate {
  seed: number
  /** Which strategy produced this option — the gallery labels A/B/C by it, and
   *  reproducing the exact plan needs the (strategy, seed) pair. */
  strategy: Strategy
  score: LayoutScore
  /** Opaque document snapshot — pass to `applyCandidate` to make it live. */
  snap: unknown
  /** Small plan-schematic dataURL for the gallery card. */
  thumb: string
}
export interface GenResult {
  best: LayoutScore
  iterations: number
  seed: number
  /** Top-K distinct candidates, best first. */
  candidates: Candidate[]
  /**
   * What the search ACTUALLY spent, as opposed to what `maxIter` allows.
   *
   * These differ enormously and silently: measured on the real plate, the
   * production default (`maxIter 18`, `target 82`) spends **6** generate calls,
   * not 57, because every strategy clears the target on its first draw (ADR
   * 0005). Reporting the spend is the SENSOR for that ADR's trigger — a plate
   * where seed 1 does NOT clear the target turns a 129 ms search into a 1.9 s
   * one, and nothing would otherwise notice.
   */
  spend: {
    /** `generate()` calls made, including the per-strategy snapshot re-draw. */
    calls: number
    /** Strategies that stopped early because the target was already met. */
    earlyExitStrategies: string[]
    maxIter: number
    target: number
  }
}

/** Default program — the single source used by the generate card and the AI. */

export const DEFAULT_PROGRAM: Program = {
  desks: 20,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  support_spaces: true,
  rooms: [],
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
  w_program: 0.1,
  w_daylight: 0.05,
  w_entry: 0.05,
}
