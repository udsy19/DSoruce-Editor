// Scenario compare (plan-library design §3): pure over two stored snapshots.
// Each side is scratch-cloned via `Editor.from_snapshot` (the ai/engine.ts
// preview pattern) — read state/metrics/circulation, render a pane thumb,
// free. The diff reuses `delta()` from ai/engine.ts (no-bloat rule) with the
// exact same rows as its consequence-card `buildDiff`; valence colors B
// relative to A.

import { Editor } from '../wasm/ds_core'
import type { DocState } from '../types/doc'
import type { Metrics, CirculationScore } from '../types/metrics'
import { renderThumb } from '../editor/EditorCanvas'
import { delta } from '../ai/engine'
import { MetricDelta } from '../ai/contract'
import { PlanMetricsSummary } from '../persist/plans'

export interface PlanComparison { a: PlanSide; b: PlanSide; deltas: MetricDelta[] }
export interface PlanSide { name: string; thumb: string; metrics: PlanMetricsSummary }

/** Compare-pane thumbnail size (design §3). */
const THUMB_W = 480
const THUMB_H = 336

/** renderThumb needs a DOM canvas; tests inject a headless stub instead. */
export type ThumbRenderer = (st: DocState, w?: number, h?: number) => string

function fin(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

interface SideRead {
  side: PlanSide
  m: Metrics
  circ: CirculationScore | null
}

function readSide(input: { snapshot: string; name: string }, thumb: ThumbRenderer): SideRead {
  const ed = Editor.from_snapshot(input.snapshot)
  try {
    const st = ed.state() as DocState
    const m = ed.metrics() as Metrics
    // circulation() is degenerate with 0 walls (CLAUDE.md) — only read it
    // when the side actually has walls.
    const circ = m.wall_count > 0 ? (ed.circulation() as CirculationScore) : null
    const metrics: PlanMetricsSummary = {
      workstations: fin(m.workstations),
      netInternalArea: fin(m.net_internal_area),
      efficiencyPct: fin(m.efficiency_pct),
      indicativeCost: fin(m.indicative_cost),
      circulationScore: circ ? circ.score : null,
      minCorridorM: circ ? circ.min_corridor_width : null,
    }
    return {
      side: { name: input.name, thumb: thumb(st, THUMB_W, THUMB_H), metrics },
      m,
      circ,
    }
  } finally {
    ed.free()
  }
}

/** Plan-schematic dataURL for a stored snapshot (hover-lazy history thumbs). */
export function snapshotThumb(snapshot: string, w = 200, h = 140): string {
  const ed = Editor.from_snapshot(snapshot)
  try {
    return renderThumb(ed.state() as DocState, w, h)
  } finally {
    ed.free()
  }
}

/**
 * Pure compare of two plans given their opaque snapshots. Never touches the
 * live editor. `thumb` defaults to the real canvas renderer; injectable so
 * the metric math stays testable in Node (no DOM).
 */
export function comparePlans(
  a: { snapshot: string; name: string },
  b: { snapshot: string; name: string },
  thumb: ThumbRenderer = renderThumb,
): PlanComparison {
  const ra = readSide(a, thumb)
  const rb = readSide(b, thumb)

  // Same rows/formats as ai/engine.ts buildDiff; delta(label, A, B, …) so
  // dir/valence read "B relative to A".
  const m2 = (n: number) => `${Math.round(n)} m²`
  const one = (n: number) => n.toFixed(1)
  const money = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
  const kg = (n: number) => `${Math.round(n).toLocaleString('en-US')}`

  const deltas: MetricDelta[] = [
    delta('Workstations', fin(ra.m.workstations), fin(rb.m.workstations), (n) => `${Math.round(n)}`, 'higher'),
    delta(
      'Area / workstation',
      fin(ra.m.area_per_workstation),
      fin(rb.m.area_per_workstation),
      (n) => `${one(n)} m²`,
      'neutral',
    ),
    delta('Efficiency', fin(ra.m.efficiency_pct), fin(rb.m.efficiency_pct), (n) => `${Math.round(n)}%`, 'higher'),
    delta('Net internal area', fin(ra.m.net_internal_area), fin(rb.m.net_internal_area), m2, 'neutral'),
    delta('Fit-out cost', fin(ra.m.indicative_cost), fin(rb.m.indicative_cost), money, 'lower'),
    delta('Carbon', fin(ra.m.indicative_carbon), fin(rb.m.indicative_carbon), (n) => `${kg(n)} kg`, 'lower'),
  ]
  // Corridor row only when BOTH sides have walls — a 0-wall side has no
  // meaningful circulation to compare against (design §3).
  if (ra.circ && rb.circ) {
    deltas.splice(
      1,
      0,
      delta(
        'Min corridor',
        fin(ra.circ.min_corridor_width),
        fin(rb.circ.min_corridor_width),
        (n) => `${one(n)} m`,
        'higher',
      ),
    )
  }

  return { a: ra.side, b: rb.side, deltas }
}
