// The AGENTIC SENIOR DESIGNER (docs/design/agentic-designer.md, phase 1).
//
// Where refine.ts lets Claude nudge 6 numeric levers of an EXISTING fit, this lets
// Claude DESIGN the fit from a brief: it decides the program (headcount, desk +
// meeting counts), the spatial STRATEGY (open / balanced / cellular), the explicit
// support ROOM program (reception, focus, phone booths, pantry, boardroom, …), and
// the objective EMPHASIS — the calls a senior workplace designer makes. The
// deterministic Rust generator then PLACES it all (coordinates, clearances,
// corridors, collisions) — the hybrid boundary: Claude reasons, the solver builds.
// Claude never emits furniture coordinates (LLMs are unreliable at precise
// geometric placement); it works purely in program/strategy/room/emphasis terms.
//
// Reuses the refine.ts plumbing: an OpenAI-shape tool single-converted to Anthropic
// via `openaiToolsToAnthropic`, tool_use decoded by `parseClaudeContent`, and a
// pure validator (`clampDesignSpec`) that is unit-tested without the live API.

import type { Program, RoomReq, SpaceKind, Placement, Strategy } from '../editor/EditorCanvas'
import { openaiToolsToAnthropic, parseClaudeContent, type ClaudeContentBlock } from './claudeDriver'

/** Every room kind the Rust generator understands (mirrors `layout::SpaceKind`). */
const SPACE_KINDS: readonly SpaceKind[] = [
  'Meeting', 'Cabin', 'Meeting4P', 'Meeting6P', 'Boardroom', 'PhoneBooth', 'Focus',
  'Collab', 'Reception', 'Pantry', 'Print', 'ItServer', 'Storage', 'Wellness',
]
const STRATEGIES: readonly Strategy[] = ['Open', 'Balanced', 'Cellular']
const PLACEMENTS: readonly Placement[] = ['Window', 'Core', 'Flexible']

/** A validated design the senior-designer agent produced from a brief. Maps onto
 *  the wasm `generate` Program; deliberately semantic (counts / strategy / rooms /
 *  emphasis), never per-furniture coordinates. */
export interface DesignSpec {
  /** Design headcount N (drives the Rust support-program derivation). */
  headcount?: number
  desks: number
  meeting_rooms: number
  strategy: Strategy
  target_corridor_m?: number
  bench_pairs?: boolean
  /** Explicit support/meeting program — replaces the derived one when non-empty. */
  rooms: RoomReq[]
  /** Objective emphasis, each 0–1 (map to the program's scoring weights). */
  adjacency_emphasis?: number
  circulation_emphasis?: number
  daylight_emphasis?: number
  /** The senior-designer explanation of the design decisions (surfaced to the user). */
  rationale: string
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const asInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN)
const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)

/** Validate + clamp one raw room entry; drops it (null) if the kind is unknown. */
function clampRoom(raw: unknown): RoomReq | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind as SpaceKind
  if (!SPACE_KINDS.includes(kind)) return null
  const count = asInt(r.count)
  const out: RoomReq = { kind, count: Number.isFinite(count) ? clamp(count, 1, 40) : 1 }
  const w = asNum(r.w)
  if (Number.isFinite(w)) out.w = clamp(w, 1, 20)
  const d = asNum(r.d)
  if (Number.isFinite(d)) out.d = clamp(d, 1, 20)
  if (PLACEMENTS.includes(r.placement as Placement)) out.placement = r.placement as Placement
  return out
}

/**
 * Pure validator: raw `design_layout` tool args → a clamped {@link DesignSpec}, or
 * `null` if it lacks the minimum (a desk count). Unknown room kinds / strategies
 * are dropped or defaulted; numbers are clamped to sane bounds. Unit-tested with
 * fixtures — no live API.
 */
export function clampDesignSpec(raw: Record<string, unknown> | null | undefined): DesignSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const desks = asInt(raw.desks)
  if (!Number.isFinite(desks)) return null // a design must at least size the workforce
  const strategy = STRATEGIES.includes(raw.strategy as Strategy) ? (raw.strategy as Strategy) : 'Balanced'
  const spec: DesignSpec = {
    desks: clamp(desks, 0, 400),
    meeting_rooms: clamp(Number.isFinite(asInt(raw.meeting_rooms)) ? asInt(raw.meeting_rooms) : 0, 0, 40),
    strategy,
    rooms: Array.isArray(raw.rooms) ? raw.rooms.map(clampRoom).filter((r): r is RoomReq => r !== null) : [],
    rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
  }
  const hc = asInt(raw.headcount)
  if (Number.isFinite(hc)) spec.headcount = clamp(hc, 1, 2000)
  const corridor = asNum(raw.target_corridor_m)
  if (Number.isFinite(corridor)) spec.target_corridor_m = clamp(corridor, 0.9, 3.0)
  if (typeof raw.bench_pairs === 'boolean') spec.bench_pairs = raw.bench_pairs
  const adj = asNum(raw.adjacency_emphasis)
  if (Number.isFinite(adj)) spec.adjacency_emphasis = clamp(adj, 0, 1)
  const circ = asNum(raw.circulation_emphasis)
  if (Number.isFinite(circ)) spec.circulation_emphasis = clamp(circ, 0, 1)
  const day = asNum(raw.daylight_emphasis)
  if (Number.isFinite(day)) spec.daylight_emphasis = clamp(day, 0, 1)
  return spec
}

/** Extract the `design_layout` spec from a Claude response's content blocks. */
export function parseDesignSpec(blocks: ClaudeContentBlock[]): DesignSpec | null {
  const { tool_calls } = parseClaudeContent(blocks)
  const call = tool_calls.find((t) => t.name === 'design_layout')
  if (!call) return null
  let args: unknown
  try {
    args = JSON.parse(call.arguments)
  } catch {
    return null
  }
  return clampDesignSpec(args as Record<string, unknown>)
}

/** Apply a design spec onto a program (returns a NEW program; input untouched). The
 *  generator then realizes it geometrically. */
export function applyDesignSpec(program: Program, spec: DesignSpec): Program {
  const p: Program = { ...program }
  if (spec.headcount !== undefined) p.headcount = spec.headcount
  p.desks = spec.desks
  p.meeting_rooms = spec.meeting_rooms
  p.strategy = spec.strategy
  if (spec.target_corridor_m !== undefined) p.target_corridor_m = spec.target_corridor_m
  if (spec.bench_pairs !== undefined) p.bench_pairs = spec.bench_pairs
  p.rooms = spec.rooms // explicit program (empty → generator derives support rooms)
  if (spec.adjacency_emphasis !== undefined) p.w_adjacency = spec.adjacency_emphasis
  if (spec.circulation_emphasis !== undefined) p.w_circulation = spec.circulation_emphasis
  if (spec.daylight_emphasis !== undefined) p.w_daylight = spec.daylight_emphasis
  return p
}

/** The design tool — single source of the spec vocabulary (OpenAI shape → Anthropic). */
export const DESIGN_TOOL = {
  type: 'function',
  function: {
    name: 'design_layout',
    description:
      'Commit your office design as a structured program. You decide the numbers, strategy, room mix, and emphasis; the deterministic engine then PLACES everything (coordinates, corridors, clearances) — so never describe positions or coordinates, only WHAT to provide and the intent. Call this exactly once.',
    parameters: {
      type: 'object',
      required: ['desks', 'strategy', 'rationale'],
      properties: {
        headcount: { type: 'integer', description: 'design population N the floor must seat' },
        desks: { type: 'integer', description: 'open-plan workstation count (0–400)' },
        meeting_rooms: { type: 'integer', description: 'enclosed meeting-room count (0–40)' },
        strategy: {
          type: 'string',
          enum: ['Open', 'Balanced', 'Cellular'],
          description:
            'spatial strategy: Open (max open-plan/daylight), Balanced (professional mix), Cellular (more enclosed rooms/privacy)',
        },
        target_corridor_m: { type: 'number', description: 'primary circulation width, m (0.9–3.0; ≥1.5 for NBC egress)' },
        bench_pairs: { type: 'boolean', description: 'true = back-to-back bench desking (denser); false = separate workstations' },
        rooms: {
          type: 'array',
          description:
            'explicit support/meeting rooms to place. Leave empty to let the engine derive a standard support program from headcount. Each item: {kind, count, placement?}.',
          items: {
            type: 'object',
            required: ['kind', 'count'],
            properties: {
              kind: {
                type: 'string',
                enum: [...SPACE_KINDS],
                description: 'room type',
              },
              count: { type: 'integer', description: 'how many of this room (1–40)' },
              placement: {
                type: 'string',
                enum: ['Window', 'Core', 'Flexible'],
                description: 'facade preference (SOFT bias): Window (daylight), Core (interior), Flexible',
              },
            },
          },
        },
        adjacency_emphasis: { type: 'number', description: 'weight on good room adjacency, 0–1' },
        circulation_emphasis: { type: 'number', description: 'weight on circulation / walkability, 0–1' },
        daylight_emphasis: { type: 'number', description: 'weight on desks near the facade, 0–1' },
        rationale: {
          type: 'string',
          description:
            'your senior-designer explanation: the zoning logic, why this strategy, and the key adjacency decisions (2–4 sentences)',
        },
      },
    },
  },
} as const

const ANTHROPIC_DESIGN_TOOLS = openaiToolsToAnthropic([DESIGN_TOOL])

/** The senior-designer persona + standards. Kept India-first per the product. */
export const DESIGNER_SYSTEM = `You are a SENIOR WORKPLACE INTERIOR DESIGNER producing a code-compliant office test-fit inside DSource. You make the design decisions a principal designer makes, then a deterministic engine places the geometry. Units are meters.

You DECIDE, at the program level only:
- the program: headcount, open-plan desk count, meeting-room count (never per-desk coordinates)
- the spatial STRATEGY (Open / Balanced / Cellular) that fits the brief and culture
- the support room mix (reception, focus rooms, phone booths, pantry, boardroom, cabins, print, IT, storage, wellness) with SOFT placement bias (Window / Core / Flexible)
- the objective emphasis (adjacency / circulation / daylight)

Standards to honour (India-first):
- NBC 2016 egress: primary circulation ≥ 1.5 m; keep clearances generous.
- Density: BCO/RICS ~8–12 m²/person; do not overpack.
- Zoning method: circulation spine first; support/service to the core; benches on the daylight facade; meeting rooms banded; reception at the entry; keep focus/phone booths acoustically away from pantry, collab and the entry.
- Scale the room mix to headcount (e.g. ~1 phone booth / 8–10 desks, focus rooms for concentration, a boardroom only when headcount warrants it).

Boundaries (critical):
- NEVER output coordinates or positions. You work only in counts, strategy, room kinds, placement bias, and emphasis. The engine owns geometry and rejects anything illegal.
- If the brief is sparse, use professional defaults sized to the floor area given.

Call design_layout exactly once with your full design and a clear rationale explaining the zoning logic.`

/** Context the designer reasons over — the floor it must design for. */
export interface DesignContext {
  /** Usable plate / NIA area if known (m²) — sizes the program. */
  plateAreaM2?: number
  /** The current program (defaults the designer can override). */
  program: Program
  /** Free-text brief from the user (may be empty → design to best professional practice). */
  brief: string
}

function buildDesignerPrompt(ctx: DesignContext): string {
  const area = ctx.plateAreaM2 && ctx.plateAreaM2 > 0 ? `${Math.round(ctx.plateAreaM2)} m² usable floor area` : 'an unmeasured floor'
  const brief = ctx.brief.trim() || '(no specific brief — design a professional general-purpose office for this floor)'
  return [
    `Design an office test-fit for ${area}.`,
    '',
    `Brief: ${brief}`,
    '',
    `Current defaults you may override: ${ctx.program.desks} desks, ${ctx.program.meeting_rooms} meeting rooms, ${ctx.program.target_corridor_m} m corridor.`,
    '',
    'Decide the full program and call design_layout once.',
  ].join('\n')
}

/**
 * Ask Claude (via the key-holding /api/claude proxy) to DESIGN the layout for a
 * brief + floor. Returns a validated {@link DesignSpec}, or `null` on any failure /
 * empty response. The only impure export; the parse+clamp it wraps is unit-tested.
 */
export async function proposeDesign(ctx: DesignContext, signal?: AbortSignal): Promise<DesignSpec | null> {
  try {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: DESIGNER_SYSTEM,
        messages: [{ role: 'user', content: buildDesignerPrompt(ctx) }],
        tools: ANTHROPIC_DESIGN_TOOLS,
        // Generous: the model uses extended THINKING (which draws from this budget)
        // before emitting the design_layout tool call with a full room mix + a
        // multi-sentence rationale. 1024 truncated the tool call → null.
        max_tokens: 3072,
      }),
      signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { content?: ClaudeContentBlock[] }
    return parseDesignSpec(data.content ?? [])
  } catch {
    return null
  }
}
