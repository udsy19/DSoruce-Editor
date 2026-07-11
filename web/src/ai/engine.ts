// The tool-execution + consequence engine. Tool calls run against a wasm Editor;
// consequence previews clone the live editor via `from_snapshot`, apply the calls
// on the clone, read the REAL Rust metrics, and diff — no duplicated metric math,
// no flicker on the live canvas.
import { Editor } from '../wasm/ds_core'
import {
  EditorCanvas,
  Metrics,
  DocState,
  CirculationScore,
} from '../editor/EditorCanvas'
import { ToolCall, PreviewDiff, MetricDelta, Consequence } from './contract'

const MIN_CORRIDOR = 1.5 // m — NBC 2016 Part 4 business-corridor minimum (India-first)
const MIN_AREA_PER_WS = 6.0 // m² — planning norm (see layout.rs)

/** Apply one tool call to a wasm Editor (live or scratch). May throw a ZoneError string. */
function applyCall(ed: Editor, call: ToolCall): void {
  switch (call.name) {
    case 'regenerate':
      ed.generate(call.args.program, BigInt(call.args.seed ?? 1), !!call.args.keepConfirmed)
      break
    case 'merge_zones':
      ed.merge_zones(call.args.zone_a as number, call.args.zone_b as number)
      break
    case 'set_zone_type':
      ed.set_zone_type(call.args.zone_id as number, call.args.zone_type as string)
      break
    case 'split_zone': {
      const zid = call.args.zone_id as number
      const axis = call.args.axis === 'Horizontal' ? 'Horizontal' : 'Vertical'
      const z = ((ed.state() as DocState).zones ?? []).find((zz) => zz.id === zid)
      if (!z) throw new Error('no zone with that id')
      // Cut through the zone's center along the chosen axis. Only axis-aligned
      // Rect zones are splittable (the core rejects RectRing/Poly).
      if (z.shape.kind !== 'Rect') throw new Error('that zone cannot be split')
      const at = axis === 'Vertical' ? z.shape.x : z.shape.y
      ed.split_zone(zid, axis, at)
      break
    }
    case 'remove_selection':
      ed.delete_selected()
      break
  }
}

/** Apply calls to the live document and repaint. Returns an error string or null. */
export function applyLive(ec: EditorCanvas, calls: ToolCall[]): string | null {
  try {
    for (const c of calls) applyCall(ec.ed, c)
    // Keep the shared program in sync if a regenerate changed it.
    const reg = [...calls].reverse().find((c) => c.name === 'regenerate')
    if (reg?.args.program) ec.program = { ...reg.args.program }
    ec.sync()
    return null
  } catch (e) {
    return String(e)
  }
}

interface Snap {
  m: Metrics
  circ: CirculationScore | null
}
function read(ed: Editor): Snap {
  const m = ed.metrics() as Metrics
  const walls = (ed.state() as DocState).walls.length
  const circ = walls > 0 ? (ed.circulation() as CirculationScore) : null
  return { m, circ }
}

/** Dry-run: clone → apply → read → diff. The live editor is never touched. */
export function preview(ec: EditorCanvas, calls: ToolCall[]): PreviewDiff {
  const before = read(ec.ed)
  const scratch = Editor.from_snapshot(ec.ed.snapshot())
  let failed: string | null = null
  try {
    for (const c of calls) applyCall(scratch, c)
  } catch (e) {
    failed = String(e)
  }
  const after = read(scratch)
  scratch.free()
  const diff = buildDiff(before, after)
  if (failed) diff.consequences.unshift({ severity: 'danger', text: failed })
  return diff
}

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function delta(
  label: string,
  b: number,
  a: number,
  fmt: (n: number) => string,
  betterWhen: 'higher' | 'lower' | 'neutral',
): MetricDelta {
  const dir = a > b + 1e-6 ? 'up' : a < b - 1e-6 ? 'down' : 'same'
  let valence: MetricDelta['valence'] = 'neutral'
  if (betterWhen !== 'neutral' && dir !== 'same') {
    const better = betterWhen === 'higher' ? dir === 'up' : dir === 'down'
    valence = better ? 'good' : 'bad'
  }
  return { label, before: fmt(b), after: fmt(a), dir, valence }
}

function buildDiff(before: Snap, after: Snap): PreviewDiff {
  const bm = before.m
  const am = after.m
  const m2 = (n: number) => `${Math.round(n)} m²`
  const one = (n: number) => n.toFixed(1)
  const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
  const kg = (n: number) => `${Math.round(n).toLocaleString('en-US')}`

  const deltas: MetricDelta[] = [
    delta('Workstations', num(bm.workstations), num(am.workstations), (n) => `${Math.round(n)}`, 'higher'),
    delta(
      'Area / workstation',
      num(bm.area_per_workstation),
      num(am.area_per_workstation),
      (n) => `${one(n)} m²`,
      'neutral',
    ),
    delta('Efficiency', num(bm.efficiency_pct), num(am.efficiency_pct), (n) => `${Math.round(n)}%`, 'higher'),
    delta('Net internal area', num(bm.net_internal_area), num(am.net_internal_area), m2, 'neutral'),
    delta('Fit-out cost', num(bm.indicative_cost), num(am.indicative_cost), money, 'lower'),
    delta('Carbon', num(bm.indicative_carbon), num(am.indicative_carbon), (n) => `${kg(n)} kg`, 'lower'),
  ]
  if (before.circ || after.circ) {
    deltas.splice(
      1,
      0,
      delta(
        'Min corridor',
        num(before.circ?.min_corridor_width),
        num(after.circ?.min_corridor_width),
        (n) => `${one(n)} m`,
        'higher',
      ),
    )
  }

  const consequences: Consequence[] = []
  const aCorr = after.circ?.min_corridor_width
  if (typeof aCorr === 'number' && aCorr > 0 && aCorr < MIN_CORRIDOR) {
    consequences.push({
      severity: 'danger',
      text: `Min corridor drops to ${aCorr.toFixed(2)} m — below the ${MIN_CORRIDOR} m corridor minimum (NBC 2016).`,
    })
  }
  const aApw = num(am.area_per_workstation)
  if (aApw > 0 && aApw < MIN_AREA_PER_WS && num(am.workstations) > num(bm.workstations)) {
    consequences.push({
      severity: 'warn',
      text: `Area per workstation falls to ${aApw.toFixed(1)} m² — tighter than the ~${MIN_AREA_PER_WS} m² planning norm.`,
    })
  }
  const aScore = after.circ?.score
  if (typeof aScore === 'number' && aScore < 60 && (before.circ?.score ?? 100) >= aScore) {
    consequences.push({ severity: 'warn', text: `Circulation quality is ${Math.round(aScore)}/100 — consider a wider corridor.` })
  }
  const dws = num(am.workstations) - num(bm.workstations)
  if (dws !== 0) {
    consequences.push({
      severity: 'info',
      text: `${dws > 0 ? 'Adds' : 'Removes'} ${Math.abs(dws)} workstation${Math.abs(dws) === 1 ? '' : 's'} (${num(bm.workstations)} → ${num(am.workstations)}).`,
    })
  }
  if (consequences.length === 0) {
    consequences.push({ severity: 'info', text: 'No hard-constraint issues detected.' })
  }
  return { deltas, consequences }
}
