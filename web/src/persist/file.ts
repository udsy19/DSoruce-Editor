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

import type { EditorCanvas, Program } from '../editor/EditorCanvas'
import { DEFAULT_PROGRAM } from '../editor/EditorCanvas'
import type { Drawing } from '../import/types'
import { triggerDownload } from '../export/png'

/** Best-effort UI restore hints (which view the plan was saved from). */
export interface DSourceUi {
  mode?: string
  planView?: string
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
  /** Optional view state, restored best-effort. */
  ui?: DSourceUi
}

const DEFAULT_FILENAME = 'dsource-plan.dsource'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Coerce an unknown `program` value into a valid `Program`: every known field
 * is taken from the input when it is a finite number, otherwise filled from
 * `DEFAULT_PROGRAM`. Unknown fields are dropped. Pure; exported for tests.
 */
export function sanitizeProgram(raw: unknown): Program {
  const src = isRecord(raw) ? raw : {}
  const out = { ...DEFAULT_PROGRAM }
  for (const key of Object.keys(DEFAULT_PROGRAM) as (keyof Program)[]) {
    const v = src[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }
  return out
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

  // Normalize to known keys; unknown top-level keys (future `cloud`, `meta`, …)
  // are tolerated on read and simply not carried into the live session.
  return {
    format: 'dsource',
    version: 1,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date(0).toISOString(),
    snapshot: raw.snapshot,
    program: sanitizeProgram(raw.program),
    ...(isDrawingShaped(raw.drawing) ? { drawing: raw.drawing } : {}),
    ...(ui && Object.keys(ui).length > 0 ? { ui } : {}),
  }
}

/** Assemble the current session into a `DSourceFile` and download it. */
export function saveProject(
  opts: { ec: EditorCanvas; drawing?: Drawing | null; ui?: DSourceUi },
  filename: string = DEFAULT_FILENAME,
): void {
  const file: DSourceFile = {
    format: 'dsource',
    version: 1,
    savedAt: new Date().toISOString(),
    snapshot: opts.ec.snapshot(),
    program: { ...opts.ec.program },
    ...(opts.drawing ? { drawing: opts.drawing } : {}),
    ...(opts.ui ? { ui: opts.ui } : {}),
  }
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
