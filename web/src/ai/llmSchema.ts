// Shared, provider-agnostic tool schema + system prompt for the LLM driver.
// OpenAI-compatible function-calling format — works with OpenAI, Groq, OpenRouter,
// Together, or a local Ollama / LM Studio server. Imported by both the client
// driver and the /api/agent proxy so the two never drift.
import type { DriverContext } from './contract'

/**
 * The corridor width we let a model ask for, in metres. **One owner, and the
 * prose is generated from it.** The clamp lived in `refine.ts` and `designer.ts`
 * and the range was retyped into three tool descriptions — a model told
 * "0.9–3.0" while a clamp said otherwise gets its answer silently rewritten,
 * which is a lie with no error message. Not a geometry rule the Rust core owns:
 * it is a policy about what an AI is allowed to propose, so it lives here, in
 * the module both drivers already share.
 */
export const CORRIDOR_M = { min: 0.9, max: 3.0 } as const
/** "0.9–3.0" — the ONE way this range is ever written for a model to read. */
export const CORRIDOR_RANGE_TEXT = `${CORRIDOR_M.min}–${CORRIDOR_M.max}`

export const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'regenerate',
      description:
        'Regenerate the office test-fit with updated program parameters. Use for "add N desks", "fit N people", "widen/narrow the corridor", "set N meeting rooms", or a plain "regenerate". Pass ONLY the fields that change.',
      parameters: {
        type: 'object',
        properties: {
          desks: { type: 'integer', description: 'target number of desks / workstations' },
          meeting_rooms: { type: 'integer', description: 'target number of meeting rooms' },
          target_corridor_m: {
            type: 'number',
            description: `perimeter corridor width in meters (${CORRIDOR_RANGE_TEXT})`,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_zones',
      description: 'Merge two rooms/zones into one. Use the two zone ids from the current zone list.',
      parameters: {
        type: 'object',
        properties: {
          zone_a: { type: 'integer' },
          zone_b: { type: 'integer' },
        },
        required: ['zone_a', 'zone_b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_zone_type',
      description:
        'Reclassify a room/zone to a new type (recolors it, updates capacity, cost and carbon). Use a zone id from the current zone list.',
      parameters: {
        type: 'object',
        properties: {
          zone_id: { type: 'integer' },
          zone_type: {
            type: 'string',
            enum: ['Circulation', 'Workspace', 'Meeting', 'Collaboration', 'Core', 'ClosedOffice', 'Amenity'],
          },
        },
        required: ['zone_id', 'zone_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'split_zone',
      description: 'Split one room/zone into two halves through its center. Use a zone id from the list.',
      parameters: {
        type: 'object',
        properties: {
          zone_id: { type: 'integer' },
          axis: {
            type: 'string',
            enum: ['Vertical', 'Horizontal'],
            description: 'Vertical = a left/right split; Horizontal = a top/bottom split',
          },
        },
        required: ['zone_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_selection',
      description:
        'Delete the currently selected component (only call this when an item is selected — see the state).',
      parameters: { type: 'object', properties: {} },
    },
  },
]

/**
 * The autonomous-refinement tool (OpenAI function-calling shape, so it converts
 * to Anthropic with the same {@link openaiToolsToAnthropic} the driver uses —
 * one source of truth for the tool schema). Deliberately NOT part of
 * {@link OPENAI_TOOLS}: it is the private vocabulary of the refine LOOP
 * (refine.ts asks Claude to SHAPE the next candidate batch), not something the
 * conversational assistant should call. Every field is OPTIONAL — Claude returns
 * only what it wants to change; refine.ts clamps each to a sane range and drops
 * anything malformed. `strategy` is intentionally absent: the search runs all
 * three strategies every pass, so the A/B/C trade-off is always surfaced and a
 * strategy "preference" would be a no-op.
 */
export const ADJUST_PROGRAM_TOOL = {
  type: 'function',
  function: {
    name: 'adjust_program',
    description:
      'Propose a bounded adjustment to the test-fit PROGRAM to improve the layout for the user’s soft goals. Return ONLY the fields you want to change; omit the rest. Values out of range are clamped; malformed values are ignored. Always include a short `rationale`.',
    parameters: {
      type: 'object',
      properties: {
        desks: { type: 'integer', description: 'new open-workstation target (0–400)' },
        meeting_rooms: { type: 'integer', description: 'new enclosed meeting-room count (0–40)' },
        target_corridor_m: {
          type: 'number',
          description: `perimeter corridor / walking-place width in meters (${CORRIDOR_RANGE_TEXT})`,
        },
        cluster_cols: {
          type: 'integer',
          description: 'desks per cluster row — higher packs a denser open field (2–8)',
        },
        bench_pairs: {
          type: 'boolean',
          description:
            'back-to-back paired desk rows (bench desking). Pairing packs more seats into a capacity-bound plate; unpairing gives each row its own circulation. Measured to matter mainly when the program is capacity-bound (ADR 0005)',
        },
        adjacency_emphasis: {
          type: 'number',
          description:
            'how strongly to weight good room adjacency when scoring, 0–1 (maps to w_adjacency)',
        },
        circulation_emphasis: {
          type: 'number',
          description:
            'how strongly to weight circulation / "walking place" when scoring, 0–1 (maps to w_circulation)',
        },
        rationale: {
          type: 'string',
          description: 'one sentence (≤160 chars) explaining WHY these tweaks help the soft goals',
        },
      },
    },
  },
} as const

export function buildSystem(ctx: DriverContext): string {
  const zones =
    ctx.zones
      .map((z) => {
        const facets = [
          z.ref ? `room #${z.ref}` : null,
          z.area ? `${z.area.toFixed(0)} m²` : null,
          z.capacity ? `~${z.capacity} pax` : null,
        ]
          .filter(Boolean)
          .join(', ')
        return `  - id ${z.id}: "${z.label}" (${z.zone_type})${facets ? ` — ${facets}` : ''}`
      })
      .join('\n') || '  (none yet — the user must generate a fit first)'
  return `You are the space-planning assistant inside DSource, a browser office floor-plan editor. You reshape the live plan by calling tools. All units are meters.

Current plan state:
- Boundary walls: ${ctx.walls} ${ctx.walls > 0 ? '(a room boundary exists)' : '(NO boundary drawn yet)'}
- Workstations placed: ${ctx.workstations}
- Program: ${ctx.program.desks} desks, ${ctx.program.meeting_rooms} meeting rooms, ${ctx.program.target_corridor_m} m corridor
- Selected component: ${ctx.selection ? `${ctx.selection.category} #${ctx.selection.id}` : 'none'}
- Zones:
${zones}

Guidelines:
- Prefer calling a tool over chatting whenever the intent is clear.
- The user refers to rooms by their label ("the boardroom", "Meeting Room 3"), their room number ("room 502", shown as "room #…" above), or a spoken synonym ("the kitchen" = Amenity, "the open plan" = Workspace). Map any such reference to the matching zone id above.
- If the user only ASKS about a room ("what's in room 502", "how big is the boardroom", "tell me about Meeting Room 3"), answer in plain text from the state above (type, area, pax) — do NOT call a tool.
- For desk count / meeting-room count / corridor width, call "regenerate" with only the changed fields.
- For merging or reclassifying rooms, use the exact zone ids listed above.
- If the request is ambiguous (e.g. more than two merge candidates), ask ONE short clarifying question in plain text instead of guessing.
- If there is no boundary, tell the user to draw a room first (do not call a tool).
- Every tool result is shown to the user as a reversible preview before it is applied, so it is safe to propose. Keep any text reply to one short sentence.`
}
