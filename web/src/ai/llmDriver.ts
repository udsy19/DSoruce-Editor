import { AgentDriver, DriverContext, DriverResult, ToolCall } from './contract'
import type { Program } from '../types/program'
interface ProxyResponse {
  content: string | null
  tool_calls: { name: string; arguments: string | Record<string, unknown> }[]
}

/**
 * Provider-agnostic LLM driver. Posts to the /api/agent proxy (which holds the
 * key server-side and speaks OpenAI-compatible chat/completions to whatever
 * endpoint is configured). Maps the model's tool_calls into our ToolCalls, so
 * the agent loop, preview, approval and undo are identical to the LocalDriver.
 */
export class LlmDriver implements AgentDriver {
  name: string
  private history: { role: 'user' | 'assistant'; content: string }[] = []

  constructor(model = 'AI') {
    this.name = model
  }

  async interpret(text: string, ctx: DriverContext): Promise<DriverResult> {
    const resp = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context: ctx, history: this.history.slice(-8) }),
    })
    if (!resp.ok) throw new Error(`agent proxy ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    const data = (await resp.json()) as ProxyResponse

    this.history.push({ role: 'user', content: text })

    const calls: ToolCall[] = []
    for (const tc of data.tool_calls ?? []) {
      const args = typeof tc.arguments === 'string' ? safeParse(tc.arguments) : tc.arguments
      const call = mapCall(tc.name, args ?? {}, ctx)
      if (call) calls.push(call)
    }

    if (calls.length > 0) {
      const say = data.content?.trim() || summarize(calls)
      this.history.push({ role: 'assistant', content: say })
      return { kind: 'plan', say, calls }
    }
    const say = data.content?.trim() || 'Could you rephrase that?'
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
