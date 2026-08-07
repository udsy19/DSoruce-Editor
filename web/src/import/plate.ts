// Single source of truth for the floor plate the generator builds in — shared by
// the Space-step readouts and the test-fit so the "usable area" a user sees and
// the area actually fitted can never disagree.
//
//   • Plain import (no area) → the coverage-scored hull tracer (`extractPlate`),
//     which frames the real shell around the drawing's furniture.
//   • Area selection → the lassoed polygon clipped to the floor envelope
//     (`plateFromArea`), so the plate matches what the user picked instead of a
//     tight hull around whichever furniture the lasso happened to catch (which
//     shrank an open-floor selection to a fraction of its size).
//
// DEGENERATE SELECTIONS RETURN null, not a fallback plate. The `?? extractPlate`
// below traces the RESTRICTED drawing, and a selection small enough for
// `plateFromArea` to reject (< 4 m², or off the sheet) has usually restricted
// that drawing to nothing — so the tracer has nothing to trace. Measured on the
// sample plan: a 1 m² lasso leaves 0 entities / 0 furniture and the result is
// null (pinned by `areaTool.test.mjs`). This is the safe outcome — the readouts
// show "—" rather than silently promoting a stray gesture to a floor plate — but
// it is NOT the rescue the comment here used to promise. The `??` still earns its
// place for the narrow case where a sub-4 m² lasso does catch real linework.
//
// This module composes testfit + area + heal (none of which import it), so there
// is no import cycle.

import type { Drawing } from './types'
import { extractPlate, plateFromArea, plateSourceBounds, type PlateResult, type Pt } from './testfit'
import { restrictDrawing } from './area'
import { healWalls } from './heal'

export function derivePlate(
  drawing: Drawing,
  areaPolygon: Pt[] | null | undefined,
  heal = true,
): PlateResult | null {
  const hasArea = !!areaPolygon && areaPolygon.length >= 3
  const restricted = hasArea ? restrictDrawing(drawing, areaPolygon!) : drawing
  const working = heal ? healWalls(restricted) : restricted
  if (hasArea) {
    const full = extractPlate(heal ? healWalls(drawing) : drawing)
    const bounds = full ? plateSourceBounds(full) : drawing.bounds
    return plateFromArea(areaPolygon!, bounds) ?? extractPlate(working)
  }
  return extractPlate(working)
}
