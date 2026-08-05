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
import { applyProject, buildProjectFile, isRecord, parseProject } from './file'
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
  // --- Cloud sync bookkeeping (docs/design/plan-library.md §5) ---
  // ADDITIVE + OPTIONAL + DEVICE-LOCAL: v1 readers ignore them (same rule as
  // the file format), and `persist/sync.ts` STRIPS them before POST so they
  // never travel to the server — each device stamps its own. Pre-sync records
  // (neither field) sync as "never synced".
  /** ISO wall-clock of the last time this record was reconciled with the server. */
  syncedAt?: string
  /** The `updatedAt` value last confirmed on the server — the version identity
   *  used to skip re-pulling a record we already hold (sync idempotence). */
  remoteRev?: string
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

/**
 * Coerce an untrusted record (a plan pulled from the server) into a valid
 * `SavedPlan`, or `null` if it is too malformed to store. The `file` facet is
 * validated by the SAME `parseProject` used for opened `.dsource` files (no
 * bloat — one format contract); metrics are coerced field-wise, and the
 * project-grouping + sync fields are carried through when present. Returns
 * `null` (never throws) so a bad remote record is skipped, not fatal, by the
 * sync loop (persist/sync.ts). Pure — unit-testable in Node.
 */
export function sanitizeSavedPlan(raw: unknown): SavedPlan | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.name !== 'string') return null
  let file: DSourceFile
  try {
    file = parseProject(JSON.stringify(raw.file))
  } catch {
    return null // the document facet is unrecoverable → skip the whole record
  }
  const epoch = new Date(0).toISOString()
  const m = isRecord(raw.metrics) ? raw.metrics : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
  const out: SavedPlan = {
    id: raw.id,
    name: raw.name,
    createdAt: str(raw.createdAt, epoch),
    updatedAt: str(raw.updatedAt, epoch),
    thumb: str(raw.thumb, ''),
    metrics: {
      workstations: num(m.workstations),
      netInternalArea: num(m.netInternalArea),
      efficiencyPct: num(m.efficiencyPct),
      indicativeCost: num(m.indicativeCost),
      circulationScore: numOrNull(m.circulationScore),
      minCorridorM: numOrNull(m.minCorridorM),
    },
    file,
  }
  if (typeof raw.projectId === 'string') out.projectId = raw.projectId
  if (typeof raw.projectName === 'string') out.projectName = raw.projectName
  if (isRecord(raw.floor) && typeof raw.floor.label === 'string' && typeof raw.floor.index === 'number') {
    out.floor = { label: raw.floor.label, index: raw.floor.index }
  }
  if (typeof raw.syncedAt === 'string') out.syncedAt = raw.syncedAt
  if (typeof raw.remoteRev === 'string') out.remoteRev = raw.remoteRev
  return out
}

/** All saved plans, most recently updated first. */
export async function listPlans(): Promise<SavedPlan[]> {
  const plans = await dbGetAll<SavedPlan>('plans')
  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Does this snapshot carry any geometry at all? ONE predicate, shared by the
 * Generate step (which must never save an empty candidate as a floor) and the
 * reopen path below (which must never land a user on one).
 *
 * Reads the document rather than a KPI so it stays true if the metrics summary
 * ever changes shape — the same reason `zone_stats` reads furniture instead of
 * an area estimate.
 */
export function snapshotIsEmpty(snap: string | null | undefined): boolean {
  if (!snap) return true
  try {
    const doc = JSON.parse(snap) as { walls?: unknown[]; components?: unknown[] }
    return (doc.walls?.length ?? 0) === 0 && (doc.components?.length ?? 0) === 0
  } catch {
    return true
  }
}

/**
 * Which floor should reopening this project actually land on?
 *
 * Normally `chosenPlanId` — the pointer the Generate step writes when the user
 * picks a test-fit, and the reason a finished plan is reachable at all
 * (AppShell §2.4). But records written before the empty-plate fix can point at
 * a 108-byte empty plan: reload the Generate step, the search ran on no plate,
 * and opening a candidate saved emptiness AND repointed the project at it. Such
 * a project reopens onto "Start your plan" while its real floor sits
 * unreferenced in the library — indistinguishable, from the user's side, from
 * having lost the work.
 *
 * So the pointer is CHECKED rather than trusted, and a broken one falls through
 * to the most recently updated floor that actually has geometry. Same shape as
 * `Document::backfill_seats`: repair the read path for records written before
 * the fix, instead of asking the user to notice and recover.
 *
 * Returns null when the project has no non-empty floor at all — the caller then
 * sends the user to Space, which is the truthful destination.
 */
export async function resolveOpenFloor(
  projectId: string,
  chosenPlanId?: string,
): Promise<string | null> {
  return pickOpenFloor(await listPlans(), projectId, chosenPlanId)
}

/** The pure selection inside {@link resolveOpenFloor} — `plans` arrives
 *  `listPlans()`-sorted (updatedAt desc). Exported for Node tests. */
export function pickOpenFloor(
  plans: SavedPlan[],
  projectId: string,
  chosenPlanId?: string,
): string | null {
  const mine = plans.filter((p) => p.projectId === projectId)
  const chosen = chosenPlanId ? mine.find((p) => p.id === chosenPlanId) : undefined
  if (chosen && !snapshotIsEmpty(chosen.file?.snapshot)) return chosen.id
  const fallback = mine.find((p) => !snapshotIsEmpty(p.file?.snapshot)) ?? null
  if (chosenPlanId && chosen !== fallback) {
    console.warn(
      `[plans] project ${projectId}: chosenPlanId ${chosenPlanId} resolves to an empty plan; ` +
        (fallback ? `opening ${fallback.id} instead` : 'no non-empty floor exists — starting at Space'),
    )
  }
  return fallback?.id ?? null
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
