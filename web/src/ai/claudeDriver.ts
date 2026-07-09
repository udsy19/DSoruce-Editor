import type { AgentDriver, DriverContext, DriverResult, ToolCall } from './contract'
import type { Program } from '../editor/EditorCanvas'
import { OPENAI_TOOLS, buildSystem } from './llmSchema'
import { evaluatorAvailable } from './evaluator'

/**
 * Claude assistant driver. Speaks the Anthropic Messages API through the
 * key-holding /api/claude dev proxy (the same one the soft-goal evaluator
 * uses) and maps `tool_use` content blocks into our ToolCalls, so the agent
 * loop, preview, approval and undo are identical to the Local/LLM drivers.
 *
 * The tool vocabulary is the SAME schema the OpenAI-compatible driver uses
 * (llmSchema.OPENAI_TOOLS), converted to Anthropic's tool format — one source
 * of truth, two wire formats.
 */

/** Anthropic Messages API tool definition. */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Pure converter: OpenAI function-calling tool format → Anthropic tool format. */
export function openaiToolsToAnthropic(
  tools: readonly { type: string; function: { name: string; description?: string; parameters?: unknown } }[],
): AnthropicTool[] {
  return tools
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    }))
}

const ANTHROPIC_TOOLS = openaiToolsToAnthropic(OPENAI_TOOLS)

/** One block of an Anthropic Messages API response `content` array. */
export interface ClaudeContentBlock {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

/**
 * Pure parser: Anthropic `content` blocks → the LlmDriver-shaped
 * `{content, tool_calls}` pair (`tool_use` → tool_calls, `text` → content).
 */
export function parseClaudeContent(blocks: ClaudeContentBlock[]): {
  content: string | null
  tool_calls: { name: string; arguments: string }[]
} {
  const texts: string[] = []
  const tool_calls: { name: string; arguments: string }[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'tool_use' && typeof b.name === 'string')
      tool_calls.push({ name: b.name, arguments: JSON.stringify(b.input ?? {}) })
  }
  const content = texts.join('\n').trim()
  return { content: content.length > 0 ? content : null, tool_calls }
}

export class ClaudeDriver implements AgentDriver {
  name = 'Claude'
  private history: { role: 'user' | 'assistant'; content: string }[] = []

  /** Whether the /api/claude proxy has a key (shared, cached health check). */
  static available(): Promise<boolean> {
    return evaluatorAvailable()
  }

  async interpret(text: string, ctx: DriverContext): Promise<DriverResult> {
    const resp = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: buildSystem(ctx),
        messages: [...this.history.slice(-8), { role: 'user', content: text }],
        tools: ANTHROPIC_TOOLS,
        max_tokens: 1024,
      }),
    })
    if (!resp.ok) throw new Error(`claude proxy ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = (await resp.json()) as { content?: ClaudeContentBlock[] }
    const parsed = parseClaudeContent(data.content ?? [])

    this.history.push({ role: 'user', content: text })

    const calls: ToolCall[] = []
    for (const tc of parsed.tool_calls) {
      const call = mapCall(tc.name, safeParse(tc.arguments) ?? {}, ctx)
      if (call) calls.push(call)
    }

    if (calls.length > 0) {
      const say = parsed.content?.trim() || summarize(calls)
      this.history.push({ role: 'assistant', content: say })
      return { kind: 'plan', say, calls }
    }
    const say = parsed.content?.trim() || 'Could you rephrase that?'
    this.history.push({ role: 'assistant', content: say })
    return { kind: 'chat', say }
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Mirrors llmDriver.ts's private mapCall/summarize (deliberate fork: that
// mapping is unexported and owned by the OpenAI-proxy path; both are kept in
// lockstep with llmSchema.OPENAI_TOOLS, the single tool-vocabulary source).
function mapCall(name: string, args: Record<string, unknown>, ctx: DriverContext): ToolCall | null {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN)
  if (name === 'regenerate') {
    const program: Program = { ...ctx.program }
    if (Number.isFinite(n(args.desks))) program.desks = Math.max(0, Math.round(n(args.desks)))
    if (Number.isFinite(n(args.meeting_rooms)))
      program.meeting_rooms = Math.max(0, Math.round(n(args.meeting_rooms)))
    if (Number.isFinite(n(args.target_corridor_m)))
      program.target_corridor_m = Math.max(0.6, Math.min(3, n(args.target_corridor_m)))
    return { name: 'regenerate', args: { program, keepConfirmed: false, seed: 1 }, summary: 'regenerate' }
  }
  if (name === 'merge_zones') {
    const a = n(args.zone_a)
    const b = n(args.zone_b)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null
    return { name: 'merge_zones', args: { zone_a: a, zone_b: b }, summary: 'merge rooms' }
  }
  if (name === 'set_zone_type') {
    const id = n(args.zone_id)
    if (!Number.isFinite(id) || typeof args.zone_type !== 'string') return null
    return {
      name: 'set_zone_type',
      args: { zone_id: id, zone_type: args.zone_type as ToolCall['args']['zone_type'] },
      summary: 'reclassify room',
    }
  }
  if (name === 'split_zone') {
    const id = n(args.zone_id)
    if (!Number.isFinite(id)) return null
    const axis = args.axis === 'Horizontal' ? 'Horizontal' : 'Vertical'
    return { name: 'split_zone', args: { zone_id: id, axis }, summary: 'split room' }
  }
  if (name === 'remove_selection') {
    if (ctx.selection == null) return null
    return { name: 'remove_selection', args: {}, summary: `delete ${ctx.selection.category}` }
  }
  return null
}

function summarize(calls: ToolCall[]): string {
  return calls.map((c) => c.name.replace('_', ' ')).join(', ')
}
