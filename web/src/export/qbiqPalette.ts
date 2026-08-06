// The qbiq deliverable-pack colour truth, imported straight from the measured
// spec so there is exactly ONE copy of every hex in the codebase.
//
//   docs/reference/qbiq/spec/palette.json  ──►  this module  ──►  { plan PNG,
//   room thumbnails, workbook Plan-sheet legend chips }
//
// Gate G4 asserts the workbook's legend chip fills equal `palette.json` EXACTLY
// and that the plan PNG's linework uses the same values. Importing the JSON
// (rather than transcribing it) makes that true by construction — never
// hard-code one of these hexes anywhere else.

import palette from '../../../docs/reference/qbiq/spec/palette.json'

/** The seven wall/element classes the qbiq plan legend colour-codes. */
export type WallType =
  | 'drywall'
  | 'half_drywall'
  | 'glass'
  | 'core'
  | 'perimeter_windows'
  | 'perimeter_wall'
  | 'door_swing'

/** Plan colours: background, room fill, the seven wall types, circulation, ink. */
export const PLAN_PALETTE = palette.plan

/** `#RRGGBB` for a wall type — the single lookup the plan/thumb renderers use. */
export const WALL_TYPE_HEX: Record<WallType, string> = {
  drywall: palette.plan.drywall,
  half_drywall: palette.plan.half_drywall,
  glass: palette.plan.glass,
  core: palette.plan.core,
  perimeter_windows: palette.plan.perimeter_windows,
  perimeter_wall: palette.plan.perimeter_wall,
  door_swing: palette.plan.door_swing,
}

/**
 * The circulation wash as the reference actually draws it: pure red at
 * alpha 25/255, which composites to `plan.circulation` (#FFE6E6) over white.
 * Using the source rgba (not the flat hex) keeps overlaps reading correctly.
 */
export const CIRCULATION_RGBA = (() => {
  const [r, g, b, a] = palette.plan.circulation_source.rgba
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(6)})`
})()

/**
 * The Plan-sheet legend, in the reference's own row order. The workbook writer
 * MUST fill these cells with these hexes — same constant, so plan and legend
 * cannot drift (G4 compares them for exact equality).
 */
export const PLAN_LEGEND_CHIPS: { cell: string; label: string; hex: string }[] =
  palette.plan._legendChipOrder

/** Workbook chrome (header bands, body wash, muted text) from the same source. */
export const WORKBOOK_CHROME = palette.plan._workbookChrome

/** As-rendered material colours — floor/ceiling swatches for room thumbnails. */
export const MATERIALS = palette.materials
