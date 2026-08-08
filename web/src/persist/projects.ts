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
import type { Pt } from '../import/testfit'
import type { RoomMarker } from '../import/markers'
import type { AnchorPin } from '../program/anchors'
import type { ProgramSpec } from '../program/spec'

/**
 * Pre-generation working state carried across the wizard steps. Reserved for
 * later slices (Space/Program/Generate); persisted so a project resumes where
 * it was left and the Space step stays re-editable after generate (raw inputs
 * live here). Kept minimal in S0.
 */
/**
 * Compact numeric snapshot of the Space step's detected readouts. Numbers are
 * EXACT (furniture tallies, plate area); the plate boundary itself is
 * best-effort (traced from linework that may not fully close) — hence
 * `plateMethod`/`plateCoverage` are carried so a reader can judge confidence.
 * The full bill-of-components rows are recomputed from `drawing` on demand
 * (buildCategoryGroups, App.tsx) rather than duplicated here.
 */
export interface SpaceReadoutsSummary {
  usableAreaM2: number | null
  usableAreaSf: number | null
  plateMethod?: 'loop' | 'hull' | 'wrap'
  plateCoverage?: number
  /** Distinct furniture blocks in the drawing (bill-of-components grand total). */
  componentCount: number
  /** Labelled rooms detected (enclosed service cores + the plate). Best-effort. */
  roomCount: number
  /** Best-effort program buckets derived from furniture categories. */
  program: { offices: number; conference: number; collab: number; amenities: number }
  computedAt: string // ISO
}

export interface ProjectDraft {
  /** Parsed upload (same shape as DSourceFile.drawing). */
  drawing?: Drawing
  /** Space-step detected readouts (numbers exact, boundaries best-effort). */
  readouts?: SpaceReadoutsSummary
  /** §3.1 area-select polygon (drawing/source coords). When set, the readouts
   *  and the test-fit plate are restricted to this sub-area. */
  areaPolygon?: Pt[]
  /** §3.2 room markers + reference numbers (drawing/source coords). */
  markers?: RoomMarker[]
  /** §3.3 wall-heal toggle. When on, near-miss partition gaps are bridged
   *  before the plate/keepout extraction and the detected-rooms readout, and
   *  again at test-fit (the plate traces the healed drawing). Default on. */
  heal?: { on: boolean; gapM: number }
  /** Layout mode. When true, the test-fit KEEPS the imported interior
   *  partitions (generate fits new furniture/rooms AROUND the existing walls);
   *  when false/absent it clears them and lays out the base shell (the default,
   *  and the deliberate inverse of keep-existing). See App.tsx#testFitPlan. */
  keepExisting?: boolean
  /** §3.4 Program-builder state (Concept/Detailed) → the resolved `Program`. */
  spec?: ProgramSpec
  /** §3.5 anchor pins (drawing/source coords) — forced room placements pushed
   *  into the document at test-fit. Cleared when a new plate is uploaded. */
  anchors?: AnchorPin[]
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

/**
 * The read-modify-write itself, **unchained**. Private, and the only body that
 * touches the store, so `enqueue` below is the single place serialisation is
 * decided. Callers that are already inside the chain use this; everything
 * outside goes through `updateProject`.
 */
async function applyPatch(
  id: string,
  patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>>,
): Promise<ProjectRecord> {
  const cur = await getProject(id)
  if (!cur) throw new Error(`No project with id ${id}`)
  const next: ProjectRecord = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() }
  await dbPut('projects', next)
  return next
}

/** Patch a record (id + createdAt preserved; bumps updatedAt). Serialised per
 *  id against every other write to the same project — see `enqueue`. */
export function updateProject(
  id: string,
  patch: Partial<Omit<ProjectRecord, 'id' | 'createdAt'>>,
): Promise<ProjectRecord> {
  return enqueue(id, () => applyPatch(id, patch))
}

export function deleteProject(id: string): Promise<void> {
  return dbDel('projects', id)
}

/** Merge a patch into a project's draft (shallow), preserving the rest of the
 *  record. The wizard steps write their working state through this. */
/**
 * Serialises the read-modify-write below, per project id.
 *
 * `updateDraft` reads the record, merges a patch, and writes it back — with an
 * `await` between the read and the write. Two calls that overlap in that window
 * interleave classically: B reads the pre-A draft, A writes, then B writes its
 * stale snapshot over A. Last write wins, and last write did not see the first.
 *
 * **This is not theoretical — it silently discarded uploaded floor plates.** The
 * Space step writes `{drawing}` on upload and a separate persist effect writes
 * `{areaPolygon, markers, heal, keepExisting}` on any state change. Confirming
 * the inferred boundary re-renders and fires the second while the first is still
 * in flight; the drawing is dropped from the record, and the Generate step —
 * correctly refusing to invent a result — reports "There's no floor plate to
 * fit." The user's upload is gone with no error anywhere.
 *
 * There was already a local mitigation at one call site (preserving `[]`/`null`
 * identity so the effect would not fire during the awaited write). That fixed
 * the instance and left the class: ANY two overlapping draft writes lose data.
 * Chaining per id fixes the class, and costs one map.
 *
 * **The first chaining fix was ITSELF a local mitigation, and the class stayed
 * live for eight weeks behind it.** It queued `updateDraft` only. `updateProject`
 * performs the same read-modify-write, with the same `await` between read and
 * write, on the same record — and was not on the queue. `GenerateStep` calls it
 * (`{chosenPlanId}`) while the Space and Program steps have fire-and-forget
 * `void updateDraft(...)` calls in flight, and `...cur` copies `draft`
 * transitively, so an `updateProject` that never mentions the draft still writes
 * a stale one over it. Reproduced by sweeping the interleavings: **2 of 14 lose
 * data — at one gap the uploaded floor plate is discarded, at another
 * `chosenPlanId`.** A single ordering passing is why one harness reported green.
 *
 * That is this repo's own documented tell: *a comment explaining why a hazard
 * cannot bite HERE is evidence the hazard is live somewhere else.* The comment
 * above named the class correctly and the fix reached one function.
 *
 * So the queue is now keyed on the RECORD, not on the writer: `enqueue` is the
 * one serialisation point and `applyPatch` the one store write. A future writer
 * is on the chain by construction unless it deliberately calls `applyPatch`.
 */
const recordWrites = new Map<string, Promise<unknown>>()

/**
 * Run `job` after every write already queued for `id`, so its read always sees
 * the previous write. `.catch` keeps one rejected write from poisoning the
 * queue — each caller still receives its own rejection.
 */
function enqueue<T>(id: string, job: () => Promise<T>): Promise<T> {
  const prev = recordWrites.get(id) ?? Promise.resolve()
  const next = prev.then(job, job)
  recordWrites.set(
    id,
    next.catch(() => undefined),
  )
  return next
}

export function updateDraft(id: string, patch: Partial<ProjectDraft>): Promise<ProjectRecord> {
  return enqueue(id, async () => {
    const cur = await getProject(id)
    if (!cur) throw new Error(`No project with id ${id}`)
    // `applyPatch`, NOT `updateProject`: we are already inside the chain, and
    // re-entering it here would wait on ourselves and never resolve.
    return applyPatch(id, { draft: { ...cur.draft, ...patch } })
  })
}
