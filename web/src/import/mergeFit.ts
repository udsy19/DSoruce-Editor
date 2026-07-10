// Merge a generated test-fit INTO the imported plan (design: the "merge-into-plan"
// deliverable). When a test-fit is generated for a SELECTED sub-area, we keep the
// whole imported floor and only REPLACE the selected region: the region's original
// furniture is dropped and the generated desks/rooms/walls are stamped in, while
// the rest of the floor stays exactly as it was drawn — one editable document.
//
// The live editor document after a region test-fit already holds the generated
// plan in EDITOR coordinates (the region plate was pushed as `source − offset`, so
// the generator packs in that frame; see `PlateResult.offset` in testfit.ts). This
// module produces the imported plan's SURROUNDINGS as editor-coordinate primitives
// to stamp AROUND that generated region:
//
//   • furniture whose bbox center is OUTSIDE the selection polygon → kept (the rest
//     of the floor); furniture INSIDE the selection → dropped (replaced by the fit).
//   • wall/glazing linework whose midpoint is OUTSIDE the selection → kept (the shell
//     + untouched partitions); linework INSIDE → dropped (the old fit-out).
//
// Every survivor is translated `source → editor` (subtract the plate offset) so it
// lands in the SAME frame as the generated region. The result is a set of plain
// `add_wall` / `add_component` primitives; the generated region itself is never
// rebuilt (it stays the native editor doc, so its zones / room labels / glazing /
// generated flags are preserved losslessly).
//
// Pure TS. Coordinates in meters. Reuses `pointInRing` + `collectWallSegments` from
// testfit.ts (the single point-in-polygon + shell-linework collectors) — no fork.

import type { Drawing, Category } from './types'
import { collectWallSegments, pointInRing, type Pt } from './testfit'

/** One imported wall/glazing segment, translated into editor coords — ready for
 *  `Editor.add_wall(ax, ay, bx, by, thickness)`. */
export interface StampWall {
  ax: number
  ay: number
  bx: number
  by: number
  thickness: number
}

/** One imported furniture block, translated into editor coords — ready for
 *  `Editor.add_component(category, x, y, w, h)` (+ `set_component_rotation`). */
export interface StampComp {
  category: string
  /** Footprint center (meters, editor coords). */
  x: number
  y: number
  w: number
  h: number
  rotation: number
  label: string
}

/** The imported plan's surroundings to stamp around a generated region test-fit,
 *  plus the merge tally (for the plate notice + verification). */
export interface BaseStamp {
  walls: StampWall[]
  comps: StampComp[]
  /** Imported furniture dropped because it fell inside the selection (replaced). */
  removedInside: number
  /** Imported furniture kept (outside the selection). */
  keptFurniture: number
}

const IMPORTED_WALL_THICKNESS = 0.15 // m — matches pushPlateToEditor's default

/** Map an imported CAD category to an editor component category so the stamped
 *  surroundings pick up a recognizable top-view symbol where one exists (doors,
 *  windows); everything else renders as a clean outline (the editor's `default`
 *  furniture symbol) rather than being mislabeled as a specific piece. */
function editorCategory(cat: Category): string {
  switch (cat) {
    case 'door':
      return 'Door'
    case 'glazing':
      return 'Window'
    default:
      return 'Furniture'
  }
}

/**
 * Partition an imported drawing by a selection polygon and translate the OUTSIDE
 * survivors into editor coordinates for stamping around a generated region test-fit.
 *
 * @param drawing    the full imported plan (source/drawing coords)
 * @param selection  the selected sub-area ring (source/drawing coords)
 * @param offset     the region plate offset — `editorPoint = sourcePoint − offset`
 *                   (from `PlateResult.offset`)
 */
export function baseStampAround(
  drawing: Drawing,
  selection: Pt[],
  offset: { x: number; y: number },
): BaseStamp {
  const inside = (x: number, y: number) => pointInRing(x, y, selection)

  const comps: StampComp[] = []
  let removedInside = 0
  for (const f of drawing.furniture) {
    const cx = (f.bbox[0] + f.bbox[2]) / 2
    const cy = (f.bbox[1] + f.bbox[3]) / 2
    if (inside(cx, cy)) {
      removedInside++ // inside the region → cleared for the new fit
      continue
    }
    comps.push({
      category: editorCategory(f.category),
      x: cx - offset.x,
      y: cy - offset.y,
      // The bbox is the axis-aligned world extent (rotation already baked in), so
      // stamp it upright — re-applying `f.rotation` would double-rotate.
      w: f.bbox[2] - f.bbox[0],
      h: f.bbox[3] - f.bbox[1],
      rotation: 0,
      label: f.name,
    })
  }

  const walls: StampWall[] = []
  for (const [a, b] of collectWallSegments(drawing)) {
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    if (inside(mx, my)) continue // old fit-out partition inside the region → dropped
    walls.push({
      ax: a[0] - offset.x,
      ay: a[1] - offset.y,
      bx: b[0] - offset.x,
      by: b[1] - offset.y,
      thickness: IMPORTED_WALL_THICKNESS,
    })
  }

  return { walls, comps, removedInside, keptFurniture: comps.length }
}
