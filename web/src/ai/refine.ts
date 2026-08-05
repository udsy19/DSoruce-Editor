// Autonomous REASONING for the test-fit: Claude doesn't just SCORE finished
// candidates (evaluator.ts) — here it SHAPES the next batch. Given the current
// program, the best candidate's sub-scores + room mix, and the user's soft
// goals, it asks Claude for a bounded PROGRAM delta (desks / meetings / corridor
// width / cluster density / adjacency + circulation emphasis) via the
// `adjust_program` tool. The EditorCanvas refine loop applies the delta,
// regenerates, and keeps it only if a FIXED-weight yardstick improves.
//
// The Claude plumbing is reused: the tool schema is single-sourced in
// llmSchema (`ADJUST_PROGRAM_TOOL`), converted to Anthropic format by the same
// `openaiToolsToAnthropic` the driver uses, and tool_use blocks are decoded by
// the driver's `parseClaudeContent`. The parse+clamp is pure + unit-tested with
// fixtures (no live API) — see refine.test.mjs.

import type { LayoutScore, ZoneStat } from '../types/metrics'
import type { Program } from '../types/program'
import { ADJUST_PROGRAM_TOOL, CORRIDOR_M } from './llmSchema'
import { openaiToolsToAnthropic, parseClaudeContent, type ClaudeContentBlock } from './claudeDriver'

/** A validated, clamped program adjustment Claude proposes. Every field is
 *  optional — only what it wants to change survives the clamp. */
export interface ProgramDelta {
  desks?: number
  meeting_rooms?: number
  target_corridor_m?: number
  cluster_cols?: number
  /**
   * Back-to-back paired desk rows. Added from branch 4a's one surviving finding
   * (ADR 0005): a GA tuning `cluster_cols`/`bench_pairs` beat plain re-seeding by
   * +1.73 on a capacity-bound program, and by nothing anywhere else. The gain is
   * real but narrow, so it ships through the machinery that already exists —
   * bounded deltas kept only on a FIXED-weight yardstick improvement — rather
   * than as a search strategy on retainer.
   */
  bench_pairs?: boolean
  /** Adjacency scoring emphasis (0–1). */
  w_adjacency?: number
  /** Circulation / "walking place" scoring emphasis (0–1). */
  w_circulation?: number
  /** One-line reason, surfaced per refine step. */
  rationale?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const asInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN)
const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)

/** The delta fields that actually change a generation (rationale alone is a no-op). */
const ACTIONABLE: (keyof ProgramDelta)[] = [
  'desks',
  'meeting_rooms',
  'target_corridor_m',
  'cluster_cols',
  'bench_pairs',
  'w_adjacency',
  'w_circulation',
]

/**
 * Pure validator: raw `adjust_program` tool arguments → a clamped {@link
 * ProgramDelta}. Numeric fields out of range are CLAMPED to the bound; non-
 * numeric / NaN fields are DROPPED. A delta with no actionable field left (only
 * a rationale, or all-malformed) returns `null` — the loop treats null as "no
 * change / converged". Ranges mirror the DEFAULT_PROGRAM sane bounds.
 */
export function clampProgramDelta(raw: Record<string, unknown> | null | undefined): ProgramDelta | null {
  if (!raw || typeof raw !== 'object') return null
  const out: ProgramDelta = {}
  const desks = asInt(raw.desks)
  if (Number.isFinite(desks)) out.desks = clamp(desks, 0, 400)
  const meetings = asInt(raw.meeting_rooms)
  if (Number.isFinite(meetings)) out.meeting_rooms = clamp(meetings, 0, 40)
  const corridor = asNum(raw.target_corridor_m)
  if (Number.isFinite(corridor)) out.target_corridor_m = clamp(corridor, CORRIDOR_M.min, CORRIDOR_M.max)
  const cols = asInt(raw.cluster_cols)
  if (Number.isFinite(cols)) out.cluster_cols = clamp(cols, 2, 8)
  // Boolean: accepted only when explicitly present, so an omitted field never
  // silently flips desking mode.
  if (typeof raw.bench_pairs === 'boolean') out.bench_pairs = raw.bench_pairs
  const adj = asNum(raw.adjacency_emphasis)
  if (Number.isFinite(adj)) out.w_adjacency = clamp(adj, 0, 1)
  const circ = asNum(raw.circulation_emphasis)
  if (Number.isFinite(circ)) out.w_circulation = clamp(circ, 0, 1)
  const rationale = typeof raw.rationale === 'string' ? raw.rationale.trim() : ''
  if (rationale) out.rationale = rationale.length > 160 ? `${rationale.slice(0, 159)}…` : rationale
  return ACTIONABLE.some((k) => k in out) ? out : null
}

/** Extract the `adjust_program` delta from a Claude response's content blocks.
 *  Malformed / missing tool call → null (handled as a no-op upstream). */
export function parseAdjustProgram(blocks: ClaudeContentBlock[]): ProgramDelta | null {
  const { tool_calls } = parseClaudeContent(blocks)
  const call = tool_calls.find((t) => t.name === 'adjust_program')
  if (!call) return null
  let args: unknown
  try {
    args = JSON.parse(call.arguments)
  } catch {
    return null
  }
  return clampProgramDelta(args as Record<string, unknown>)
}

/** Apply a validated delta to a program (returns a new object; inputs untouched). */
export function applyDelta(program: Program, delta: ProgramDelta): Program {
  const p: Program = { ...program }
  if (delta.desks !== undefined) p.desks = delta.desks
  if (delta.meeting_rooms !== undefined) p.meeting_rooms = delta.meeting_rooms
  if (delta.target_corridor_m !== undefined) p.target_corridor_m = delta.target_corridor_m
  if (delta.cluster_cols !== undefined) p.cluster_cols = delta.cluster_cols
  if (delta.bench_pairs !== undefined) p.bench_pairs = delta.bench_pairs
  if (delta.w_adjacency !== undefined) p.w_adjacency = delta.w_adjacency
  if (delta.w_circulation !== undefined) p.w_circulation = delta.w_circulation
  return p
}

const REF_PAIRS: [keyof LayoutScore, keyof Program][] = [
  ['capacity', 'w_capacity'],
  ['adjacency', 'w_adjacency'],
  ['circulation', 'w_circulation'],
  ['density', 'w_density'],
  ['program_fit', 'w_program'],
  ['daylight', 'w_daylight'],
  ['entry_adjacency', 'w_entry'],
]

/**
 * FIXED-weight yardstick: a normalized weighted mean of a candidate's sub-scores
 * under `weights`. The refine loop pins `weights` to the ORIGINAL program so a
 * delta that shifts adjacency/circulation emphasis is still judged on ONE stable
 * rubric — otherwise "did the score improve?" would be circular (the delta could
 * inflate `total` just by re-weighting). Falls back to `total` if weights are 0.
 */
export function refScore(score: LayoutScore, weights: Program): number {
  let num = 0
  let den = 0
  for (const [sk, wk] of REF_PAIRS) {
    const w = weights[wk] as number
    num += w * (score[sk] as number)
    den += w
  }
  return den > 0 ? num / den : score.total
}

const REFINE_SYSTEM = `You are the autonomous space-planning OPTIMIZER inside DSource, a browser office test-fit engine. Each pass the engine searches Open / Balanced / Cellular strategies and keeps the best plan; your job is to SHAPE the next pass by adjusting the PROGRAM so weak sub-scores rise without wrecking strong ones.

You receive: the current program, the current BEST candidate's sub-scores (each 0–100), its room mix, and the user's soft goals. Reason about which lever helps:
- low circulation → widen target_corridor_m or raise circulation_emphasis
- low density / too few desks for the goal → raise desks or cluster_cols (denser open field)
- low adjacency → raise adjacency_emphasis
- too cramped / poor daylight → fewer desks or narrower clusters

Call adjust_program ONCE with only the fields you want to change (bounded values; out-of-range is clamped) and a one-sentence rationale. Change as few fields as possible. If the plan already serves the goals well, still call adjust_program with only a rationale explaining why no change is needed. Units are meters.`

const ANTHROPIC_ADJUST_TOOLS = openaiToolsToAnthropic([ADJUST_PROGRAM_TOOL])

/** Inputs the refine loop hands Claude to reason over. */
export interface RefineInput {
  program: Program
  best: LayoutScore
  zones: ZoneStat[]
  softGoals: string
}

function buildRefinePrompt({ program, best, zones, softGoals }: RefineInput): string {
  const mix =
    zones
      .slice()
      .sort((a, b) => b.area - a.area)
      .slice(0, 8)
      .map((z) => `  - ${z.label} (${z.zone_type}): ${z.area.toFixed(0)} m², ${z.pct_of_nia.toFixed(0)}% NIA`)
      .join('\n') || '  (no zones yet)'
  return [
    `Soft goals: ${softGoals}`,
    '',
    `Current program: ${program.desks} desks, ${program.meeting_rooms} meeting rooms, ${program.cluster_cols} cols/cluster, corridor ${program.target_corridor_m} m, adjacency emphasis ${program.w_adjacency}, circulation emphasis ${program.w_circulation}.`,
    '',
    `Best candidate sub-scores (0–100): capacity ${best.capacity.toFixed(0)}, adjacency ${best.adjacency.toFixed(0)}, circulation ${best.circulation.toFixed(0)}, density ${best.density.toFixed(0)}, program-fit ${best.program_fit.toFixed(0)}, daylight ${best.daylight.toFixed(0)}, entry ${best.entry_adjacency.toFixed(0)}; ${best.placed_desks} desks placed.`,
    '',
    'Room mix (largest first):',
    mix,
  ].join('\n')
}

/**
 * Ask Claude (via the key-holding /api/claude proxy) for a bounded program
 * adjustment. Returns a validated+clamped {@link ProgramDelta}, or `null` on any
 * failure / empty response — the caller treats null as "converged, stop". This
 * is the only impure export; the parse+clamp it wraps is unit-tested directly.
 */
export async function proposeAdjustment(input: RefineInput, signal?: AbortSignal): Promise<ProgramDelta | null> {
  try {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: REFINE_SYSTEM,
        messages: [{ role: 'user', content: buildRefinePrompt(input) }],
        tools: ANTHROPIC_ADJUST_TOOLS,
        max_tokens: 512,
      }),
      signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { content?: ClaudeContentBlock[] }
    return parseAdjustProgram(data.content ?? [])
  } catch {
    return null
  }
}
