// Resuming a project into the live editor.
//
// The wizard's working state lives in `ProjectRecord.draft` (IndexedDB), but the
// *editor* holds the parsed Drawing in React state, which a cold start never
// populates. Every wizard step that needs the plate must therefore re-push the
// persisted drawing before it uses the editor — `SpaceStep` always did this on
// mount, and `GenerateStep` did not.
//
// The cost of that asymmetry: reload the Generate step and the search ran on an
// EMPTY plate, producing three 0-workstation candidates that the gallery still
// badged "Most seats / Best daylight / Best density" at 64/100. Opening one
// saved a 108-byte empty plan as the project's floor and repointed
// `chosenPlanId` at it — so the project reopened onto "Start your plan" while
// the real floor sat unreferenced in the library. Nothing was deleted; it read
// exactly like data loss, which is the same thing to whoever it happens to.
//
// One function, so a step that needs the plate cannot forget how to get it.

import type { EditorController } from '../App'
import type { ProjectRecord } from '../persist/projects'

/**
 * Ensure the editor holds this project's persisted plate.
 *
 * No-op when the editor already has a drawing (the in-session path — the user
 * walked here from Space and nothing needs re-pushing) or when the draft has
 * none (a project that never got an upload). Returns whether the editor has a
 * drawing afterwards, so a caller can branch on "there is no plate at all"
 * rather than inferring it from an empty result.
 */
export function resumeDrawing(
  controller: EditorController | null | undefined,
  rec: ProjectRecord | null | undefined,
): boolean {
  if (!controller) return false
  const d = rec?.draft?.drawing ?? null
  const id = rec?.id ?? null
  // SWITCHED PROJECTS: "does the editor have a drawing" is the wrong question —
  // it has the LAST project's drawing. The editor is a singleton that survives
  // navigation by design, so opening project B without a reload found project
  // A's plate still loaded and generated three test-fits on it, labelled B.
  // The question is whether the editor holds THIS project's drawing.
  if (id !== loadedProjectId) {
    controller.loadDrawing(d) // null clears — a project with no upload has no plate
    loadedProjectId = id
    return !!d
  }
  if (controller.hasDrawing()) return true
  if (!d) return false
  controller.loadDrawing(d)
  return true
}

/** Which project's drawing the editor currently holds. Module-scoped because
 *  the editor itself is a singleton that outlives every step's component. */
let loadedProjectId: string | null = null
