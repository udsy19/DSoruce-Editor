// Shared, provider-agnostic tool schema + system prompt for the LLM driver.
// OpenAI-compatible function-calling format — works with OpenAI, Groq, OpenRouter,
// Together, or a local Ollama / LM Studio server. Imported by both the client
// driver and the /api/agent proxy so the two never drift.
import type { DriverContext } from './contract'

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
            description: 'perimeter corridor width in meters (0.9–3.0)',
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

export function buildSystem(ctx: DriverContext): string {
  const zones =
    ctx.zones.map((z) => `  - id ${z.id}: "${z.label}" (${z.zone_type})`).join('\n') ||
    '  (none yet — the user must generate a fit first)'
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
- For desk count / meeting-room count / corridor width, call "regenerate" with only the changed fields.
- For merging or reclassifying rooms, use the exact zone ids listed above.
- If the request is ambiguous (e.g. more than two merge candidates), ask ONE short clarifying question in plain text instead of guessing.
- If there is no boundary, tell the user to draw a room first (do not call a tool).
- Every tool result is shown to the user as a reversible preview before it is applied, so it is safe to propose. Keep any text reply to one short sentence.`
}
