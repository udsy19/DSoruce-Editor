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
import { CORRIDOR_M, CORRIDOR_RANGE_TEXT } from './llmSchema'

/** Every room kind the Rust generator understands — mirrors `layout::SpaceKind`,
 *  and `src/coreParity.test.mjs` proves it still does by parsing the enum out of
 *  `layout.rs`. Unavoidable here: the kinds have to be literals inside the JSON
 *  schema the model reads. A kind missing from this list is silent — the
 *  validator drops it and the room the designer asked for never appears. */
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
  if (Number.isFinite(corridor)) spec.target_corridor_m = clamp(corridor, CORRIDOR_M.min, CORRIDOR_M.max)
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
        target_corridor_m: { type: 'number', description: `primary circulation width, m (${CORRIDOR_RANGE_TEXT}; ≥1.5 for NBC egress)` },
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

/** The senior-designer persona + standards + design intelligence. India-first,
 *  specialised for GCC (Global Capability Centre) workplaces. */
export const DESIGNER_SYSTEM = `You are a SENIOR WORKPLACE INTERIOR DESIGNER (15+ years, principal level) who SPECIALISES in GCC (Global Capability Centre) fit-outs in India, producing a real, code-compliant office test-fit inside DSource. You make the design decisions a principal makes; a deterministic engine then places the geometry. Units are meters. Design like a human designer — NOT a robot that tiles a uniform desk grid.

THE CLIENT — a GCC (Global Capability Centre): the India captive office of a multinational (technology, engineering, product, finance/ops, R&D, analytics). Its DNA drives the design:
- SEAT EFFICIENCY is the headline KPI — cost per seat and seats per floor. Floors are large open BENCHING fields (India benching ~1.4–1.5 m runs, back-to-back). Density is high; some functions HOT-DESK under 24/7 shift operations.
- CROSS-TIMEZONE COLLABORATION is constant (daily calls with HQ in the US/EU). So the plan is HEAVY on enclosed talk space: generous meeting + huddle rooms AND a lot of PHONE BOOTHS + focus rooms (plan ~1 booth per 6–8 seats — far more than a domestic office) so calls don't wreck the open floor acoustically.
- AGILE DELIVERY: project/"war" rooms and team collaboration zones per squad; team neighbourhoods of ~8–12.
- MANAGER CABINS: Indian org hierarchy means more private cabins for leads/managers than a Western open plan — but bias them to the core so they never wall the team off from daylight.
- SHARED HEART & SCALE: a large CAFETERIA/pantry (people eat on-site across shifts), a TOWN-HALL / all-hands assembly zone, and TRAINING rooms (onboarding runs continuously).
- INDIA STATUTORY & CULTURE (must-haves at scale): a wellness / MOTHER'S room, first-aid, a prayer/meditation quiet room, and recreation/breakout; a crèche for large headcounts. Reception with visitor management + security is front-of-house.
- EXPERIENCE DRIVES RETENTION: attrition is the #1 GCC problem, so amenity, daylight for the many, biophilia and breakout are not luxuries — they are business-critical.

Map these onto the available room kinds: use Collab for project/war rooms, breakout and recreation; Wellness for the mother's/first-aid/quiet room; Pantry for the cafeteria/tea-points (scale it up for the headcount); Boardroom/Meeting6P for training + town-hall-scale rooms; Cabin for manager offices; and MANY PhoneBooth + Focus for the call load.

WHAT MAKES A GOOD WORKPLACE (design like this, not a grid):
- Activity-based, not one-size: real offices are a MIX of settings — focus (quiet, enclosed), collaborate (open breakout, project tables), socialise (pantry/café as a heart), and privacy (phone booths, cabins). A wall of identical desks is a bad, dated design. Vary the settings to the work.
- Neighbourhoods, not a barracks: cluster desks into human-scaled teams (~6–12) with breakout and storage nearby, separated by circulation and soft landscape — not one monolithic bench field.
- The journey & front-of-house: reception + client-facing meeting rooms + the best boardroom form a welcoming "front"; heads-down focus, IT, storage, service sit "back". Design the arrival experience.
- Daylight & biophilia: put people on the daylight facade; keep views to the perimeter open; pull enclosed/served rooms to the core so no one is walled off from light.
- Circulation as a social spine, generous and legible — the "walking place" is where culture happens, not wasted floor.
- Acoustic zoning: keep focus/phone booths away from pantry, collab and the entry buzz.
- Generosity where it counts; efficiency where it doesn't. Wall-to-wall use of the plate — empty, undeclared floor is wasted money and bad design.

You DECIDE, at the PROGRAM level only:
- the program: headcount, open-plan desk count, meeting-room count (never per-desk coordinates)
- the spatial STRATEGY (Open / Balanced / Cellular) that fits the brief and culture
- the support room mix (reception, focus, phone booths, collab, pantry, boardroom, cabins, print, IT, storage, wellness) with SOFT placement bias (Window / Core / Flexible)
- the objective emphasis (adjacency / circulation / daylight)

Standards to honour (India-first):
- NBC 2016 egress: primary circulation ≥ 1.5 m; keep clearances generous.
- Density: BCO/RICS ~8–12 m²/person is professional; below ~6 is cramped; above ~15 is generous/premium.
- Scale the room mix to headcount (~1 phone booth / 8–10 desks; focus rooms for concentration; a boardroom only when headcount + client-facing needs warrant it; a real pantry always).

Boundaries (critical):
- NEVER output coordinates or positions. You work only in counts, strategy, room kinds, placement bias, and emphasis. The engine owns geometry and rejects anything illegal.
- If the brief is sparse, use professional defaults sized to the floor area given.

Call design_layout exactly once with your full design and a rationale that reads like a designer explaining the CONCEPT and the neighbourhood/adjacency logic — not a spec dump.`

/** A named optimisation lens — DSource generates a distinct test-fit per objective
 *  (like Laiout's budget / carbon / people options), each a real design tradeoff. */
export interface DesignObjective {
  id: string
  /** Short card label. */
  label: string
  /** What the option optimises, shown under the label. */
  tagline: string
  /** The design brief lens handed to Claude — how to bias the design for this goal. */
  lens: string
}

export const DESIGN_OBJECTIVES: readonly DesignObjective[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    tagline: 'A professional GCC all-rounder',
    lens: 'Optimise for a well-rounded GCC floor: strong seat efficiency with enough enclosed talk-space for cross-timezone calls, a proper cafeteria and amenity, and manager cabins to the core. No single metric dominates.',
  },
  {
    id: 'seats',
    label: 'Max seats',
    tagline: 'Lowest cost per seat',
    lens: 'Optimise for SEAT EFFICIENCY — the GCC KPI. Maximise seats/floor with dense back-to-back benching on every run (assume shift/hot-desk friendly), keep enclosure to the operational minimum (still enough phone booths that calls do not wreck the floor), only code-required circulation. Seats-first, but keep ≥ ~5.5–6 m²/seat so it stays workable.',
  },
  {
    id: 'cost',
    label: 'Cost-optimised',
    tagline: 'Lowest fit-out capex',
    lens: 'Optimise for LOWEST fit-out capex: partitions, doors and enclosed rooms are the expensive line items, so favour an open plan, cut cabins to the essential leads only, prefer standard modular furniture and reuse. Build enclosure only where operations demand it.',
  },
  {
    id: 'collaboration',
    label: 'Collaboration',
    tagline: 'Cross-timezone call & team heavy',
    lens: 'Optimise for a talk-heavy delivery GCC: generous meeting + huddle rooms and a HIGH phone-booth/focus ratio (~1 booth per 5–6 seats) for constant HQ calls, plus project/war rooms (use Collab) per squad and clear team neighbourhoods. Accept slightly fewer seats to protect acoustics and collaboration.',
  },
  {
    id: 'experience',
    label: 'Experience',
    tagline: 'Retention & wellbeing',
    lens: 'Optimise for RETENTION (the #1 GCC problem): generous space per seat (~10–13 m²), daylight and views for the many, a large cafeteria heart, strong amenity — recreation/breakout (Collab), a wellness/mother’s + quiet room (Wellness), biophilia. Fewer, better-served seats that people want to come back to.',
  },
]

/** Context the designer reasons over — the floor it must design for. */
export interface DesignContext {
  /** Usable plate / NIA area if known (m²) — sizes the program. */
  plateAreaM2?: number
  /** The current program (defaults the designer can override). */
  program: Program
  /** Free-text brief from the user (may be empty → design to best professional practice). */
  brief: string
  /** Optional optimisation lens — biases the whole design toward one goal. */
  objective?: DesignObjective
}

function buildDesignerPrompt(ctx: DesignContext): string {
  const area = ctx.plateAreaM2 && ctx.plateAreaM2 > 0 ? `${Math.round(ctx.plateAreaM2)} m² usable floor area` : 'an unmeasured floor'
  const brief = ctx.brief.trim() || '(no specific brief — design a professional GCC delivery floor for this plate, sized to the area)'
  const lens = ctx.objective
    ? ['', `OPTIMISATION LENS — "${ctx.objective.label}": ${ctx.objective.lens}`, 'Let this lens genuinely shape the design so it differs from other options; explain the tradeoff you are making in the rationale.']
    : []
  return [
    `Design an office test-fit for ${area}.`,
    '',
    `Brief: ${brief}`,
    ...lens,
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
  const body = JSON.stringify({
    system: DESIGNER_SYSTEM,
    messages: [{ role: 'user', content: buildDesignerPrompt(ctx) }],
    tools: ANTHROPIC_DESIGN_TOOLS,
    // FORCE the tool. This also disables extended thinking, so the entire budget
    // goes to a COMPLETE design_layout call — no truncated `rooms` array (which was
    // collapsing options to a default program under concurrent load), and faster.
    tool_choice: { type: 'tool', name: 'design_layout' },
    max_tokens: 2048,
  })
  // Retry with exponential backoff. Parallel option-generation trips the proxy's
  // upstream rate/token-per-minute limit two ways: a non-ok status (429/5xx), AND a
  // 200 whose tool call came back truncated/incomplete under token pressure (parses
  // to null). Retry BOTH — a design must not silently drop just because it was one
  // of several fired together.
  const MAX_ATTEMPTS = 4
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      })
      if (resp.ok) {
        const data = (await resp.json()) as { content?: ClaudeContentBlock[] }
        const spec = parseDesignSpec(data.content ?? [])
        if (spec) return spec // otherwise fall through to a retry (truncated tool call)
      } else if (resp.status !== 429 && resp.status < 500) {
        return null // a real client error (400/401/403) won't recover
      }
    } catch {
      if (signal?.aborted) return null
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.round(200 * attempt))) // ~0.8s,1.8s,3.6s
    }
  }
  return null
}

/** One objective-optimised design option. */
export interface DesignOption {
  objective: DesignObjective
  spec: DesignSpec
}

/**
 * Generate a distinct design per objective (Laiout-style budget / carbon / people /
 * wellbeing options), each a real tradeoff Claude reasons about. Runs the lenses
 * concurrently; drops any that fail so a partial set still returns. `objectives`
 * defaults to the full {@link DESIGN_OBJECTIVES} set. Returns [] without a key.
 */
export async function proposeDesignOptions(
  ctx: Omit<DesignContext, 'objective'>,
  objectives: readonly DesignObjective[] = DESIGN_OBJECTIVES,
  signal?: AbortSignal,
): Promise<DesignOption[]> {
  // Bounded concurrency: firing every objective at once trips the proxy's upstream
  // rate/concurrency limit (all return 500). Two in flight keeps it fast but safe.
  const CONCURRENCY = 2
  const out: (DesignOption | null)[] = new Array(objectives.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < objectives.length) {
      const i = next++
      const objective = objectives[i]
      const spec = await proposeDesign({ ...ctx, objective }, signal)
      out[i] = spec ? { objective, spec } : null
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objectives.length) }, worker))
  return out.filter((o): o is DesignOption => o !== null)
}
