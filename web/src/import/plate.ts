// Single source of truth for the floor plate the generator builds in — shared by
// the Space-step readouts and the test-fit so the "usable area" a user sees and
// the area actually fitted can never disagree.
//
//   • Plain import (no area) → the coverage-scored hull tracer (`extractPlate`),
//     which frames the real shell around the drawing's furniture.
//   • Area selection → the lassoed polygon clipped to the floor envelope
//     (`plateFromArea`), so the plate matches what the user picked instead of a
//     tight hull around whichever furniture the lasso happened to catch (which
//     shrank an open-floor selection to a fraction of its size). Falls back to
//     the hull tracer if the clipped region is degenerate.
//
// This module composes testfit + area + heal (none of which import it), so there
// is no import cycle.

import type { Drawing } from './types'
import {
  extractPlate,
  plateFromArea,
  plateSourceBounds,
  tracePlate,
  type PlateOutcome,
  type PlateResult,
  type Pt,
} from './testfit'
import { restrictDrawing } from './area'
import { healWalls } from './heal'

/**
 * As `derivePlate`, but says WHY when it cannot. A bare `null` forced App.tsx to
 * invent a message, and the one it invented ("No wall geometry found in this
 * drawing") was wrong on 4 of the 6 corpus files that hit it — they had wall
 * geometry; it was 1000x too small to clear the area floor. See
 * cad-validation/findings/F3-no-plate-derived.md.
 */
export function derivePlateOutcome(
  drawing: Drawing,
  areaPolygon: Pt[] | null | undefined,
  heal = true,
): PlateOutcome {
  const hasArea = !!areaPolygon && areaPolygon.length >= 3
  const restricted = hasArea ? restrictDrawing(drawing, areaPolygon!) : drawing
  const working = heal ? healWalls(restricted) : restricted
  if (hasArea) {
    const full = extractPlate(heal ? healWalls(drawing) : drawing)
    const bounds = full ? plateSourceBounds(full) : drawing.bounds
    const clipped = plateFromArea(areaPolygon!, bounds)
    if (clipped) return { ok: true, plate: clipped }
  }
  return tracePlate(working)
}

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
