// First-class project records — design: docs/design/workflow.md §2.
//
// A project is created BEFORE any plan is generated (make it, then upload),
// unlike the multi-floor model where "a project exists iff a plan references
// it" (docs/design/multi-floor.md). So this store holds a richer, persisted
// `ProjectRecord` whose `id` DOUBLES AS the `SavedPlan.projectId`
// (persist/plans.ts): every floor saved under this project sets
// `projectId = record.id`, so `groupPlans` naturally folds those floors under
// the same project. `plans.ts#listProjects` derives groups from saved floors;
// this module owns the record itself — different responsibility, both needed
// for the landing to show in-progress projects that have zero floors yet.
//
// The create-project fields flow straight into the exporters: `name` →
// ReportMeta.project / TakeoffOptions.project, `address`/`logo` →
// ReportMeta cover, `floor` → TakeoffOptions.floor (workflow.md §2).

import { dbDel, dbGet, dbGetAll, dbPut } from './db'
import type { Drawing } from '../import/types'

/**
 * Pre-generation working state carried across the wizard steps. Reserved for
 * later slices (Space/Program/Generate); persisted so a project resumes where
 * it was left and the Space step stays re-editable after generate (raw inputs
 * live here). Kept minimal in S0.
 */
export interface ProjectDraft {
  /** Parsed upload (same shape as DSourceFile.drawing). */
  drawing?: Drawing
  /** Reproduces the chosen candidate — generate is deterministic per seed. */
  winningSeed?: number
}

/** One record in the "projects" object store (keyPath "id"). */
export interface ProjectRecord {
  id: string
  /** Project name — denormalized onto SavedPlan.projectName for its floors. */
  name: string
  propertyName: string
  address?: string
  /** Client logo as a data: URL → report cover (report.ts). */
  logo?: string
  /** Initial floor label → SavedPlan.floor.label of the first floor. */
  floor?: string
  createdAt: string // ISO
  updatedAt: string // ISO
  draft?: ProjectDraft
  /** The SavedPlan the user carried into the editor. */
  chosenPlanId?: string
}

/** The create-project form's payload (everything else is minted/derived). */
export interface ProjectInput {
  name: string
  propertyName: string
  address?: string
  logo?: string
  floor?: string
}

/** Mint a project record up front (id stable before any floor exists). */
export async function createProject(input: ProjectInput): Promise<ProjectRecord> {
  const now = new Date().toISOString()
  const rec: ProjectRecord = {
    id: crypto.randomUUID(),
    name: input.name,
    propertyName: input.propertyName,
    address: input.address,
    logo: input.logo,
    floor: input.floor,
    createdAt: now,
    updatedAt: now,
  }
  await dbPut('projects', rec)
  return rec
}

/** All projects, most recently updated first. */
export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await dbGetAll<ProjectRecord>('projects')
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getProject(id: string): Promise<ProjectRecord | undefined> {
  return dbGet<ProjectRecord>('projects', id)
}

/** Patch a record (id + createdAt preserved; bumps updatedAt). */
export async function updateProject(
  id: string,
  patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>>,
): Promise<ProjectRecord> {
  const cur = await getProject(id)
  if (!cur) throw new Error(`No project with id ${id}`)
  const next: ProjectRecord = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() }
  await dbPut('projects', next)
  return next
}

export function deleteProject(id: string): Promise<void> {
  return dbDel('projects', id)
}
