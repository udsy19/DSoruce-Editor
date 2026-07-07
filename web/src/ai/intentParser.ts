import { AgentDriver, DriverContext, DriverResult, ToolCall } from './contract'
import { Program, ZoneType } from '../editor/EditorCanvas'

// Keyword → ZoneType. Longest phrase wins so "meeting room" beats "room".
const ZONE_WORDS: [string, ZoneType][] = [
  ['open workspace', 'Workspace'],
  ['workspace', 'Workspace'],
  ['open plan', 'Workspace'],
  ['desk area', 'Workspace'],
  ['meeting room', 'Meeting'],
  ['meeting', 'Meeting'],
  ['collaboration', 'Collaboration'],
  ['collab', 'Collaboration'],
  ['breakout', 'Collaboration'],
  ['lounge', 'Collaboration'],
  ['closed office', 'ClosedOffice'],
  ['private office', 'ClosedOffice'],
  ['office', 'ClosedOffice'],
  ['amenity', 'Amenity'],
  ['kitchen', 'Amenity'],
  ['cafe', 'Amenity'],
  ['core', 'Core'],
  ['circulation', 'Circulation'],
]

/**
 * Deterministic natural-language driver — the no-backend brain. Maps a message to
 * a clarifying question, a tool plan, or chat. Emits the SAME ToolCalls a Claude
 * driver would, so the agent loop and UI are driver-agnostic. Clarify options are
 * complete, re-issuable commands, so no server-side slot state is needed.
 */
export class LocalDriver implements AgentDriver {
  name = 'Local'

  interpret(text: string, ctx: DriverContext): DriverResult {
    const t = text.toLowerCase().trim()
    const numAfter = (re: RegExp) => {
      const m = t.match(re)
      return m ? parseFloat(m[1]) : null
    }

    if (/\bmerge\b/.test(t)) return this.merge(t, ctx)

    if (/\bsplit\b/.test(t)) return this.split(t, ctx)

    if (
      /\b(delete|remove|clear)\b/.test(t) &&
      ctx.selection &&
      /\b(this|it|that|selected|selection)\b/.test(t)
    )
      return {
        kind: 'plan',
        say: `Delete the selected ${ctx.selection.category}.`,
        calls: [{ name: 'remove_selection', args: {}, summary: `delete ${ctx.selection.category}` }],
      }

    if (/\b(make|turn|convert|change|reclassify)\b/.test(t) && lastZoneType(t))
      return this.setType(t, ctx)

    if (/\bcorridor\b|\baisle\b|\bwalkway\b/.test(t)) {
      let w = numAfter(/(\d+(?:\.\d+)?)\s*m/) ?? numAfter(/to\s+(\d+(?:\.\d+)?)/)
      if (w == null && /\b(widen|wider|increase|bigger)\b/.test(t)) w = ctx.program.target_corridor_m + 0.3
      if (w == null && /\b(narrow|reduce|decrease|smaller|tighter)\b/.test(t))
        w = ctx.program.target_corridor_m - 0.3
      if (w == null)
        return {
          kind: 'clarify',
          say: 'What corridor width would you like?',
          options: ['Set corridor to 1.2 m', 'Set corridor to 1.5 m', 'Set corridor to 1.8 m'],
        }
      w = Math.max(0.6, Math.min(3, w))
      return this.regen(
        { ...ctx.program, target_corridor_m: +w.toFixed(2) },
        `Set the perimeter corridor to ${w.toFixed(2)} m and regenerate.`,
        ctx,
      )
    }

    const people =
      numAfter(/(\d+)\s*(?:desks?|people|pax|seats?|workstations?|staff|persons?)/) ??
      (/\b(add|fit|seat|need|house|accommodate)\b/.test(t) ? numAfter(/(\d+)/) : null)
    if (people != null)
      return this.regen(
        { ...ctx.program, desks: Math.max(0, Math.round(people)) },
        `Target ${Math.max(0, Math.round(people))} workstations and regenerate the fit.`,
        ctx,
      )

    const mr = numAfter(/(\d+)\s*meeting/)
    if (mr != null)
      return this.regen(
        { ...ctx.program, meeting_rooms: Math.max(0, Math.round(mr)) },
        `Set ${Math.max(0, Math.round(mr))} meeting rooms and regenerate.`,
        ctx,
      )

    if (/\b(regenerate|re-?generate|generate|re-?fit|new layout|try again|another option)\b/.test(t))
      return this.regen({ ...ctx.program }, 'Regenerate the test-fit.', ctx)

    return {
      kind: 'chat',
      say: 'I can reshape the plan. Try: “add 30 desks”, “widen the corridor to 1.5 m”, “make the open workspace a collaboration zone”, or “merge the meeting rooms”.',
    }
  }

  private regen(program: Program, say: string, ctx: DriverContext): DriverResult {
    if (ctx.walls === 0)
      return { kind: 'chat', say: 'Draw a room boundary first, then I can generate a fit.' }
    const call: ToolCall = {
      name: 'regenerate',
      args: { program, keepConfirmed: false, seed: 1 },
      summary: say,
    }
    return { kind: 'plan', say, calls: [call] }
  }

  private setType(t: string, ctx: DriverContext): DriverResult {
    const type = lastZoneType(t)!
    let zoneId = ctx.selectionZoneId
    if (zoneId == null) {
      const byLabel = ctx.zones.find((z) => z.label && t.includes(z.label.toLowerCase()))
      if (byLabel) zoneId = byLabel.id
    }
    if (zoneId == null) {
      const opts = ctx.zones.filter((z) => z.zone_type !== 'Circulation')
      if (opts.length === 0) return { kind: 'chat', say: 'There are no rooms yet — generate a fit first.' }
      return {
        kind: 'clarify',
        say: `Which room should become a ${type} zone?`,
        options: opts.map((z) => `Make ${z.label} a ${type} zone`),
      }
    }
    const z = ctx.zones.find((zz) => zz.id === zoneId)!
    return {
      kind: 'plan',
      say: `Reclassify “${z.label}” as a ${type} zone.`,
      calls: [{ name: 'set_zone_type', args: { zone_id: zoneId, zone_type: type }, summary: `${z.label} → ${type}` }],
    }
  }

  private merge(t: string, ctx: DriverContext): DriverResult {
    const nonCirc = ctx.zones.filter((z) => z.zone_type !== 'Circulation')
    // Explicit "A + B" (also how clarify options come back).
    if (t.includes('+')) {
      const parts = t
        .replace(/^.*\bmerge\b/, '')
        .split('+')
        .map((s) => s.trim())
      if (parts.length === 2) {
        const za = ctx.zones.find((z) => parts[0] && z.label.toLowerCase().includes(parts[0]))
        const zb = ctx.zones.find((z) => parts[1] && z.label.toLowerCase().includes(parts[1]))
        if (za && zb && za.id !== zb.id) return this.mergePlan(za, zb)
      }
    }
    const meetings = ctx.zones.filter((z) => z.zone_type === 'Meeting')
    if (/meeting/.test(t) && meetings.length >= 2) return this.mergePlan(meetings[0], meetings[1])
    if (nonCirc.length < 2)
      return { kind: 'chat', say: 'I need at least two rooms to merge — generate a fit first.' }
    if (nonCirc.length === 2) return this.mergePlan(nonCirc[0], nonCirc[1])
    // Ambiguous → offer pairs as full re-issuable commands (cap at 6).
    const pairs: string[] = []
    for (let i = 0; i < nonCirc.length && pairs.length < 6; i++)
      for (let j = i + 1; j < nonCirc.length && pairs.length < 6; j++)
        pairs.push(`Merge ${nonCirc[i].label} + ${nonCirc[j].label}`)
    return { kind: 'clarify', say: 'Which two rooms should I merge?', options: pairs }
  }

  private split(t: string, ctx: DriverContext): DriverResult {
    const axis = /\b(horizontal|top|bottom|across|rows?)\b/.test(t) ? 'Horizontal' : 'Vertical'
    let zoneId = ctx.selectionZoneId
    if (zoneId == null) {
      const byLabel = ctx.zones.find((z) => z.label && t.includes(z.label.toLowerCase()))
      if (byLabel) zoneId = byLabel.id
      else {
        const type = lastZoneType(t)
        const z = type && ctx.zones.find((zz) => zz.zone_type === type && zz.zone_type !== 'Circulation')
        if (z) zoneId = z.id
      }
    }
    if (zoneId == null) {
      const opts = ctx.zones.filter((z) => z.zone_type !== 'Circulation')
      if (opts.length === 0) return { kind: 'chat', say: 'Generate a fit first, then I can split a room.' }
      return { kind: 'clarify', say: 'Which room should I split?', options: opts.map((z) => `Split ${z.label}`) }
    }
    const z = ctx.zones.find((zz) => zz.id === zoneId)!
    return {
      kind: 'plan',
      say: `Split “${z.label}” into two ${axis === 'Vertical' ? '(left / right)' : '(top / bottom)'}.`,
      calls: [{ name: 'split_zone', args: { zone_id: zoneId, axis }, summary: `split ${z.label}` }],
    }
  }

  private mergePlan(a: { id: number; label: string }, b: { id: number; label: string }): DriverResult {
    return {
      kind: 'plan',
      say: `Merge “${a.label}” and “${b.label}” into one room.`,
      calls: [{ name: 'merge_zones', args: { zone_a: a.id, zone_b: b.id }, summary: `merge ${a.label} + ${b.label}` }],
    }
  }
}

/** The zone type of the LAST zone-word mention (target of "make X a <type>"). */
function lastZoneType(t: string): ZoneType | null {
  let bestIdx = -1
  let best: ZoneType | null = null
  for (const [word, type] of ZONE_WORDS) {
    const idx = t.lastIndexOf(word)
    if (idx > bestIdx) {
      bestIdx = idx
      best = type
    }
  }
  return best
}
