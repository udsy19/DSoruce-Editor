// Plan library records over IndexedDB — design: docs/design/plan-library.md §2/§6.
// A `SavedPlan` embeds THE ENTIRE v1 `.dsource` format verbatim (built by the
// shared `buildProjectFile`, so library saves and ⌘S can never drift):
// `parseProject` validates library records exactly as it validates opened
// files, "export plan to .dsource" is a field copy, and cloud sync (§5)
// posts the same JSON. Metrics are denormalized for list/compare without wasm.

import { Editor } from '../wasm/ds_core'
import type { EditorCanvas, Metrics, CirculationScore } from '../editor/EditorCanvas'
import type { Drawing } from '../import/types'
import type { BindingInfo, DSourceFile, DSourceUi } from './file'
import { applyProject, buildProjectFile } from './file'
import { dbDel, dbGetAll, dbPut } from './db'

/** Headline numbers shown on library cards + compare rows, no wasm needed. */
export interface PlanMetricsSummary {
  workstations: number
  netInternalArea: number
  efficiencyPct: number
  indicativeCost: number
  /** null when the plan has no walls — circulation is degenerate at 0 walls. */
  circulationScore: number | null
  minCorridorM: number | null
}

/** One record in the "plans" object store (keyPath "id"). */
export interface SavedPlan {
  id: string
  name: string
  createdAt: string // ISO
  updatedAt: string // ISO
  /** dataURL plan schematic; '' until the UI side renders one. */
  thumb: string
  metrics: PlanMetricsSummary
  /** The entire v1 on-disk `.dsource` format, verbatim. */
  file: DSourceFile
}

/**
 * Snapshot the live session into a library record. `opts.snapshot` parks a
 * non-live document (e.g. a gallery candidate) in place of `ec.snapshot()`;
 * `opts.thumb` is owned by the UI side (thumbnail rendering lives there).
 */
export function buildSavedPlan(
  ec: EditorCanvas,
  name: string,
  opts: {
    drawing?: Drawing | null
    ui?: DSourceUi
    snapshot?: string
    thumb?: string
    bindings?: Map<string, BindingInfo> | null
  } = {},
): SavedPlan {
  const file = buildProjectFile({ ec, drawing: opts.drawing, bindings: opts.bindings, ui: opts.ui })
  if (opts.snapshot) file.snapshot = opts.snapshot
  // Metrics must describe the PARKED document: when a non-live snapshot is
  // given (gallery candidate), read them from a scratch clone, not the live doc.
  // Degenerate-at-0-walls gotcha (CLAUDE.md): only score circulation inside a plate.
  let m: Metrics
  let circ: CirculationScore | null
  if (opts.snapshot) {
    const ed = Editor.from_snapshot(opts.snapshot)
    try {
      m = ed.metrics() as Metrics
      circ = m.wall_count > 0 ? (ed.circulation() as CirculationScore) : null
    } finally {
      ed.free()
    }
  } else {
    m = ec.getMetrics()
    circ = m.wall_count > 0 ? ec.circulation() : null
  }
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    thumb: opts.thumb ?? '',
    metrics: {
      workstations: m.workstations ?? 0,
      netInternalArea: m.net_internal_area ?? 0,
      efficiencyPct: m.efficiency_pct ?? 0,
      indicativeCost: m.indicative_cost ?? 0,
      circulationScore: circ ? circ.score : null,
      minCorridorM: circ ? circ.min_corridor_width : null,
    },
    file,
  }
}

/** All saved plans, most recently updated first. */
export async function listPlans(): Promise<SavedPlan[]> {
  const plans = await dbGetAll<SavedPlan>('plans')
  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function putPlan(p: SavedPlan): Promise<void> {
  return dbPut('plans', p)
}

export function deletePlan(id: string): Promise<void> {
  return dbDel('plans', id)
}

/** Make a saved plan live — same code path as opening its `.dsource` file. */
export function loadPlan(ec: EditorCanvas, p: SavedPlan): void {
  applyProject(ec, p.file)
}
