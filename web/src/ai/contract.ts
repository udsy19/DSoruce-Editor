import type { Program, ZoneType } from '../editor/EditorCanvas'

// The tool vocabulary the agent (local parser now, Claude later) speaks. Each
// ToolCall maps to a wasm Editor mutation. ZoneType strings byte-match the Rust
// serde tags (redesign plan Conflict §1).
export type ToolName =
  | 'regenerate'
  | 'merge_zones'
  | 'set_zone_type'
  | 'split_zone'
  | 'remove_selection'

export interface ToolCall {
  name: ToolName
  args: {
    program?: Program
    keepConfirmed?: boolean
    seed?: number
    zone_a?: number
    zone_b?: number
    zone_id?: number
    zone_type?: ZoneType
    axis?: 'Vertical' | 'Horizontal'
  }
  /** One-line human description of this call, for the plan/preview. */
  summary: string
}

/** One before→after row in the consequence card. */
export interface MetricDelta {
  label: string
  before: string
  after: string
  dir: 'up' | 'down' | 'same'
  valence: 'good' | 'bad' | 'neutral'
}

export interface Consequence {
  severity: 'info' | 'warn' | 'danger'
  text: string
}

export interface PreviewDiff {
  deltas: MetricDelta[]
  consequences: Consequence[]
}

/** What the driver returns for a user message: ask, plan, or just talk. */
export type DriverResult =
  | { kind: 'clarify'; say: string; options: string[] }
  | { kind: 'plan'; say: string; calls: ToolCall[] }
  | { kind: 'chat'; say: string }

/** Context the driver reads to interpret a message ("the two meeting rooms"). */
export interface DriverContext {
  program: Program
  zones: { id: number; zone_type: ZoneType; label: string }[]
  selectionZoneId: number | null
  selection: { id: number; category: string } | null
  walls: number
  workstations: number
}

/** Pluggable brain: LocalDriver now, ClaudeDriver later — same interface. */
export interface AgentDriver {
  name: string
  interpret(text: string, ctx: DriverContext): DriverResult | Promise<DriverResult>
}
