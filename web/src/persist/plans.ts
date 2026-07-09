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
import { dbDel, dbGet, dbGetAll, dbPut } from './db'

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

/** A floor's place within a project (docs/design/multi-floor.md). */
export interface PlanFloor {
  label: string // "L2", "Mezzanine", …
  index: number // sort ordinal within the project
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
  // --- Multi-floor project grouping (docs/design/multi-floor.md) ---
  // ADDITIVE + OPTIONAL: pre-project records have none of these and must keep
  // working everywhere. A project exists iff a plan references it.
  projectId?: string
  /** Denormalized onto every floor record so each stays self-describing. */
  projectName?: string
  floor?: PlanFloor
}

/** One project derived from the library — floors are plain `SavedPlan`s. */
export interface ProjectGroup {
  /** '' for the pseudo-group of ungrouped plans. */
  projectId: string
  projectName: string
  floors: SavedPlan[]
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
    /** Save straight into a project as one of its floors. */
    project?: { projectId: string; projectName: string; floor: PlanFloor }
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
    ...(opts.project
      ? {
          projectId: opts.project.projectId,
          projectName: opts.project.projectName,
          floor: opts.project.floor,
        }
      : {}),
  }
}

/** All saved plans, most recently updated first. */
export async function listPlans(): Promise<SavedPlan[]> {
  const plans = await dbGetAll<SavedPlan>('plans')
  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** One saved plan by id (the cold-reload floor-open path, App.tsx). */
export function getPlan(id: string): Promise<SavedPlan | undefined> {
  return dbGet<SavedPlan>('plans', id)
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

// ---------------------------------------------------------------------------
// Multi-floor projects (docs/design/multi-floor.md) — grouping is DERIVED
// from plan records, never stored. Old records (no project fields) keep
// working everywhere: they fold into a trailing pseudo-group.
// ---------------------------------------------------------------------------

/**
 * Pure fold of plan records into project groups. Groups are ordered by their
 * most recently updated floor (i.e. first appearance in a `listPlans()`-sorted
 * input); floors within a group sort by `floor.index` (missing index → last,
 * input order preserved). Ungrouped plans form a trailing pseudo-group with
 * `projectId: ''`. Exported for the presentational panel + Node tests.
 */
export function groupPlans(plans: SavedPlan[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const p of plans) {
    const id = p.projectId ?? ''
    let g = groups.get(id)
    if (!g) {
      g = { projectId: id, projectName: id ? (p.projectName ?? '') : '', floors: [] }
      groups.set(id, g)
    }
    g.floors.push(p)
  }
  const out = [...groups.values()]
  for (const g of out) {
    if (!g.projectId) continue // ungrouped: keep updatedAt order
    g.floors.sort(
      (a, b) => (a.floor?.index ?? Number.MAX_SAFE_INTEGER) - (b.floor?.index ?? Number.MAX_SAFE_INTEGER),
    )
  }
  // Pseudo-group of ungrouped plans always trails the real projects.
  return out.sort((a, b) => Number(a.projectId === '') - Number(b.projectId === ''))
}

/** All projects in the library, derived from `listPlans()`. */
export async function listProjects(): Promise<ProjectGroup[]> {
  return groupPlans(await listPlans())
}

/**
 * Resolve a user-typed project name to an existing project (case-insensitive,
 * returning its canonical id + name) or mint a fresh `projectId` for it.
 * Host-side companion to the panel's `onAssign(planId, projectName, floorLabel)`.
 */
export async function resolveProject(
  name: string,
): Promise<{ projectId: string; projectName: string }> {
  const wanted = name.trim()
  const needle = wanted.toLowerCase()
  for (const p of await listPlans()) {
    if (p.projectId && p.projectName && p.projectName.toLowerCase() === needle) {
      return { projectId: p.projectId, projectName: p.projectName }
    }
  }
  return { projectId: crypto.randomUUID(), projectName: wanted }
}

/**
 * Attach a saved plan to a project as one of its floors (`putPlan` wrapper;
 * bumps `updatedAt`). When `floor.index` is omitted: keeps the plan's existing
 * index if it is already in this project (re-label), otherwise appends after
 * the project's current highest index.
 */
export async function assignToProject(
  planId: string,
  projectId: string,
  projectName: string,
  floor: { label: string; index?: number },
): Promise<SavedPlan> {
  const p = await dbGet<SavedPlan>('plans', planId)
  if (!p) throw new Error(`No saved plan with id ${planId}`)
  let index = floor.index
  if (index == null) {
    if (p.projectId === projectId && p.floor) {
      index = p.floor.index
    } else {
      const siblings = (await listPlans()).filter(
        (s) => s.projectId === projectId && s.id !== planId,
      )
      index = siblings.reduce((max, s) => Math.max(max, s.floor?.index ?? -1), -1) + 1
    }
  }
  const next: SavedPlan = {
    ...p,
    projectId,
    projectName,
    floor: { label: floor.label, index },
    updatedAt: new Date().toISOString(),
  }
  await putPlan(next)
  return next
}
