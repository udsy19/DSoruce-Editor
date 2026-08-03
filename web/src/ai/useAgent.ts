import { useRef, useState } from 'react'
import type { DocZone } from '../types/doc'
import type { Program } from '../types/program'
import { EditorCanvas } from '../editor/EditorCanvas'
import { AgentDriver, DriverContext, PreviewDiff, ToolCall } from './contract'
import { applyLive, preview } from './engine'

export type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string }
  | { id: number; role: 'clarify'; text: string; options: string[] }
  | {
      id: number
      role: 'preview'
      text: string
      calls: ToolCall[]
      diff: PreviewDiff
      status: 'pending' | 'applied' | 'discarded'
    }

/** Provider of the { zone.id → room number } map, resolved fresh per call
 *  (markers stay pinned to points while zones regenerate). Optional — without
 *  it rooms simply carry no `ref`. */
export type RoomRefs = () => Map<number, string>

function buildContext(ec: EditorCanvas, roomRefs?: RoomRefs): DriverContext {
  const st = ec.getState()
  const refs = roomRefs?.() ?? new Map<number, string>()
  const stats = new Map(ec.getZoneStats().map((s) => [s.id, s]))
  // Furniture inside each zone, grouped by category (for "what's in room 502").
  const byZone = (z: DocZone) => {
    const counts = new Map<string, number>()
    for (const id of z.component_ids) {
      const c = st.components.find((x) => x.id === id)
      if (c) counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
    }
    return [...counts.entries()].map(([category, count]) => ({ category, count }))
  }
  const zones = (st.zones ?? []).map((z) => {
    const s = stats.get(z.id)
    return {
      id: z.id,
      zone_type: z.zone_type,
      label: z.label,
      ref: refs.get(z.id),
      area: s?.area,
      capacity: s?.capacity,
      seated: s?.seated,
      components: byZone(z),
    }
  })
  const m = ec.getMetrics()
  let selectionZoneId: number | null = null
  let selection: { id: number; category: string } | null = null
  if (st.selection != null) {
    const c = st.components.find((x) => x.id === st.selection)
    if (c) {
      selection = { id: c.id, category: c.category }
      const zid = (ec.ed as unknown as { zone_at?: (x: number, y: number) => number | undefined }).zone_at?.(
        c.x,
        c.y,
      )
      selectionZoneId = zid ?? null
    }
  }
  return {
    program: ec.program,
    zones,
    selectionZoneId,
    selection,
    walls: st.walls.length,
    workstations: m.workstations ?? 0,
  }
}

/** The agent loop: interpret → clarify/plan → preview → approve/reject → undo. */
export function useAgent(ec: EditorCanvas, driver: AgentDriver, roomRefs?: RoomRefs) {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 0,
      role: 'assistant',
      text: `Hi — I'm your space assistant. Tell me how to change the plan, e.g. “add 30 desks”, “widen the corridor to 1.5 m”, or “make the open workspace a collaboration zone”.`,
    },
  ])
  const [busy, setBusy] = useState(false)
  const idRef = useRef(1)
  // Undo captures the Rust document snapshot AND the JS-side program (which lives
  // outside the document), so undo fully reverts a regenerate.
  const undoRef = useRef<{ snap: string; program: Program }[]>([])
  const [canUndo, setCanUndo] = useState(false)

  const push = <T extends Omit<Msg, 'id'>>(m: T) => {
    const msg = { ...m, id: idRef.current++ } as Msg
    setMessages((prev) => [...prev, msg])
    return msg.id
  }
  const setStatus = (id: number, status: 'applied' | 'discarded') =>
    setMessages((prev) =>
      prev.map((m) => (m.id === id && m.role === 'preview' ? { ...m, status } : m)),
    )

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    push({ role: 'user', text: trimmed })
    setBusy(true)
    try {
      const res = await Promise.resolve(driver.interpret(trimmed, buildContext(ec, roomRefs)))
      if (res.kind === 'chat') push({ role: 'assistant', text: res.say })
      else if (res.kind === 'clarify') push({ role: 'clarify', text: res.say, options: res.options })
      else {
        const diff = preview(ec, res.calls)
        push({ role: 'preview', text: res.say, calls: res.calls, diff, status: 'pending' })
      }
    } catch (e) {
      push({ role: 'assistant', text: `Sorry — I hit an error: ${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const approve = (id: number, calls: ToolCall[]) => {
    undoRef.current.push({ snap: ec.snapshot(), program: { ...ec.program } })
    const err = applyLive(ec, calls)
    if (err) {
      undoRef.current.pop()
      setStatus(id, 'discarded')
      push({ role: 'assistant', text: `Couldn't apply that: ${err}` })
      return
    }
    setStatus(id, 'applied')
    setCanUndo(true)
    push({ role: 'assistant', text: 'Done — applied to the plan. You can undo it.' })
  }

  const reject = (id: number) => {
    setStatus(id, 'discarded')
    push({ role: 'assistant', text: 'Discarded — nothing changed.' })
  }

  const undo = () => {
    const entry = undoRef.current.pop()
    if (!entry) return
    ec.restore(entry.snap)
    ec.program = { ...entry.program }
    setCanUndo(undoRef.current.length > 0)
    push({ role: 'assistant', text: 'Reverted the last change.' })
  }

  return { messages, busy, canUndo, send, approve, reject, undo }
}
