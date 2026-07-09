// Local project persistence: save/open `.dsource` files so a plan survives the
// browser tab. Local files now, designed so cloud sync can bolt on later
// WITHOUT a format change:
//
//   - Top-level keys are stable and ADDITIVE-ONLY. A future `cloud` / `meta`
//     key must not break old readers, so readers ignore unknown keys.
//   - Readers tolerate missing optionals (`drawing`, `ui`) and unknown keys.
//   - `version` gates future migrations: v1 readers refuse files from a newer
//     writer with a clear message instead of silently misreading them.
//   - `snapshot` is the core's opaque lossless document blob (walls,
//     components, zones, selection, id counter, CAD drafting layer) and is
//     forward-carried verbatim — this module never looks inside it.
//
// Parsing/validation (`parseProject`) is pure — no DOM, no wasm — so it is
// unit-testable in Node; only `saveProject` (download) and `applyProject`
// (Editor mutation) touch the environment.

import type { EditorCanvas, Placement, Program, RoomReq, SpaceKind } from '../editor/EditorCanvas'
import { DEFAULT_PROGRAM } from '../editor/EditorCanvas'
import type { Drawing } from '../import/types'
import { triggerDownload } from '../export/png'

/** Best-effort UI restore hints (which view the plan was saved from). */
export interface DSourceUi {
  mode?: string
  planView?: string
}

/** Price/thumbnail of a bound bank product — keyed by productId in `bindings`. */
export interface BindingInfo {
  price: number | null
  image: string | null
}

/** The on-disk `.dsource` format (v1). See header comment for evolution rules. */
export interface DSourceFile {
  format: 'dsource'
  version: 1
  /** ISO timestamp — the ONLY metadata; no user identity yet. */
  savedAt: string
  /** `Editor.snapshot()` — opaque, forward-carried, never inspected here. */
  snapshot: string
  /** Test-fit program (NOT inside the snapshot; saved separately). */
  program: Program
  /** Imported CAD drawing (entities + furniture + bounds), when an import session exists. */
  drawing?: Drawing
  /**
   * Product-binding details (price ₹, thumbnail) keyed by productId. The
   * drawing's furniture items only carry productId/Name — this map completes
   * them, so a saved import session keeps its prices on reopen. Additive v1
   * key: old readers ignore it by design.
   */
  bindings?: Record<string, BindingInfo>
  /** Optional view state, restored best-effort. */
  ui?: DSourceUi
}

const DEFAULT_FILENAME = 'dsource-plan.dsource'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const SPACE_KINDS = new Set<SpaceKind>([
  'Meeting', 'Cabin', 'Meeting4P', 'Meeting6P', 'Boardroom', 'PhoneBooth', 'Focus',
  'Collab', 'Reception', 'Pantry', 'Print', 'ItServer', 'Storage', 'Wellness',
])
const PLACEMENTS = new Set<Placement>(['Window', 'Core', 'Flexible'])

/**
 * Validate the `Program.rooms` array (the Detailed builder's explicit program).
 * ⚠ THE DATA-LOSS TRAP (workflow.md §3.4): `sanitizeProgram`'s scalar loop would
 * silently DROP this non-scalar field, so a saved detailed program would vanish
 * on reopen. Each entry is coerced field-wise; malformed entries are dropped
 * rather than failing the whole open (rooms are recoverable working state, not
 * document geometry). Optional `w`/`d` are carried only when finite.
 */
function sanitizeRooms(raw: unknown): RoomReq[] {
  if (!Array.isArray(raw)) return []
  const out: RoomReq[] = []
  for (const v of raw) {
    if (!isRecord(v)) continue
    if (typeof v.kind !== 'string' || !SPACE_KINDS.has(v.kind as SpaceKind)) continue
    if (typeof v.count !== 'number' || !Number.isFinite(v.count) || v.count < 0) continue
    const req: RoomReq = { kind: v.kind as SpaceKind, count: Math.round(v.count) }
    if (typeof v.w === 'number' && Number.isFinite(v.w)) req.w = v.w
    if (typeof v.d === 'number' && Number.isFinite(v.d)) req.d = v.d
    if (typeof v.placement === 'string' && PLACEMENTS.has(v.placement as Placement)) {
      req.placement = v.placement as Placement
    }
    out.push(req)
  }
  return out
}

/**
 * Coerce an unknown `program` value into a valid `Program`: every scalar field
 * is taken from the input when it is a finite number/boolean, otherwise filled
 * from `DEFAULT_PROGRAM`. The non-scalar `rooms` array (validated) and the
 * optional `headcount` are carried through explicitly — the scalar loop alone
 * would drop both. Unknown fields are dropped. Pure; exported for tests.
 */
export function sanitizeProgram(raw: unknown): Program {
  const src = isRecord(raw) ? raw : {}
  const out: Record<string, unknown> = { ...DEFAULT_PROGRAM }
  for (const key of Object.keys(DEFAULT_PROGRAM) as (keyof Program)[]) {
    const v = src[key]
    const want = typeof DEFAULT_PROGRAM[key] // field-wise: number OR boolean (arrays handled below)
    if (want === 'number' && typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (want === 'boolean' && typeof v === 'boolean') out[key] = v
  }
  out.rooms = sanitizeRooms(src.rooms)
  // headcount is optional (absent from DEFAULT_PROGRAM) → carry it when present,
  // drop it otherwise so it maps to Rust `None`.
  if (typeof src.headcount === 'number' && Number.isFinite(src.headcount)) {
    out.headcount = Math.round(src.headcount)
  } else {
    delete out.headcount
  }
  return out as unknown as Program
}

/** Light structural check of an embedded `Drawing` (present ⇒ must be sane). */
function isDrawingShaped(v: unknown): v is Drawing {
  return (
    isRecord(v) &&
    Array.isArray(v.entities) &&
    Array.isArray(v.furniture) &&
    Array.isArray(v.bounds) &&
    v.bounds.length === 4 &&
    (v.bounds as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/**
 * Loose validation of the `bindings` map: a record of records. Each entry's
 * price/image are coerced field-wise (bad values → null); malformed entries —
 * or a malformed map — are dropped rather than failing the whole open, since
 * bindings are decoration over the drawing, not document state.
 */
function sanitizeBindings(raw: unknown): Record<string, BindingInfo> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, BindingInfo> = {}
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue
    out[id] = {
      price: typeof v.price === 'number' && Number.isFinite(v.price) ? v.price : null,
      image: typeof v.image === 'string' ? v.image : null,
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Parse + validate `.dsource` text into a normalized `DSourceFile`.
 * Pure (no DOM/wasm) so the format contract is unit-testable in Node.
 * Throws an `Error` with a human-readable message on any failure.
 */
export function parseProject(text: string): DSourceFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not a .dsource project: the file is not valid JSON.')
  }
  if (!isRecord(raw) || raw.format !== 'dsource') {
    throw new Error('Not a .dsource project (missing "format": "dsource").')
  }
  if (raw.version !== 1) {
    throw new Error(
      typeof raw.version === 'number' && raw.version > 1
        ? `This project was saved by a newer DSource Editor (format v${raw.version}); this build reads v1. Please update the app.`
        : 'Unsupported .dsource version: expected version 1.',
    )
  }
  if (typeof raw.snapshot !== 'string' || raw.snapshot.length === 0) {
    throw new Error('Corrupted .dsource project: the document snapshot is missing.')
  }
  if ('drawing' in raw && raw.drawing != null && !isDrawingShaped(raw.drawing)) {
    throw new Error('Corrupted .dsource project: the embedded import drawing is malformed.')
  }
  const ui = isRecord(raw.ui)
    ? {
        ...(typeof raw.ui.mode === 'string' ? { mode: raw.ui.mode } : {}),
        ...(typeof raw.ui.planView === 'string' ? { planView: raw.ui.planView } : {}),
      }
    : undefined

  const bindings = sanitizeBindings(raw.bindings)

  // Normalize to known keys; unknown top-level keys (future `cloud`, `meta`, …)
  // are tolerated on read and simply not carried into the live session.
  return {
    format: 'dsource',
    version: 1,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString(),
    snapshot: raw.snapshot,
    program: sanitizeProgram(raw.program),
    ...(isDrawingShaped(raw.drawing) ? { drawing: raw.drawing } : {}),
    ...(bindings ? { bindings } : {}),
    ...(ui && Object.keys(ui).length > 0 ? { ui } : {}),
  }
}

/** Everything a v1 `DSourceFile` is assembled from (live editor + session extras). */
interface ProjectParts {
  ec: EditorCanvas
  drawing?: Drawing | null
  bindings?: Map<string, BindingInfo> | null
  ui?: DSourceUi
}

/**
 * Assemble the current session into a v1 `DSourceFile`. The single builder
 * shared by ⌘S (`saveProject`) and the plan library (`persist/plans.ts`), so
 * the two write paths can never drift.
 */
export function buildProjectFile(opts: ProjectParts): DSourceFile {
  return {
    format: 'dsource',
    version: 1,
    savedAt: new Date().toISOString(),
    snapshot: opts.ec.snapshot(),
    program: { ...opts.ec.program },
    ...(opts.drawing ? { drawing: opts.drawing } : {}),
    ...(opts.bindings && opts.bindings.size > 0
      ? { bindings: Object.fromEntries(opts.bindings) }
      : {}),
    ...(opts.ui ? { ui: opts.ui } : {}),
  }
}

/** Assemble the current session into a `DSourceFile` and download it. */
export function saveProject(opts: ProjectParts, filename: string = DEFAULT_FILENAME): void {
  const file = buildProjectFile(opts)
  triggerDownload(new Blob([JSON.stringify(file)], { type: 'application/json' }), filename)
}

/** Read + parse + validate a user-picked `.dsource` File. Throws on failure. */
export async function openProject(file: File): Promise<DSourceFile> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error(`Could not read "${file.name}".`)
  }
  return parseProject(text)
}

/**
 * Apply an opened project to the editor: restore the document snapshot
 * (rehydrates the CAD layer, repaints, notifies React) and the test-fit
 * program. The caller owns `drawing`/`ui` — they live in React state.
 */
export function applyProject(ec: EditorCanvas, f: DSourceFile): void {
  ec.restore(f.snapshot)
  ec.program = { ...DEFAULT_PROGRAM, ...f.program }
}
