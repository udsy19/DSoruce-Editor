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
//     of the floor), each NORMALIZED to a canonical component (see normalize.ts) so
//     the surroundings share the generator's furniture symbology; furniture INSIDE
//     the selection → dropped (replaced by the fit).
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

import type { Drawing } from './types'
import { collectWallSegments, pointInRing, type Pt } from './testfit'
import { normalizeFurniture } from './normalize'

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
  /** Door hinge hand (mirror across the long axis), carried through the merge. */
  mirror: boolean
  label: string
  /** Preserved material-bank binding (re-imagine) carried from the imported block. */
  productId?: string
  productName?: string
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
    // Normalize to a canonical component so the imported surroundings render with
    // the SAME symbology + size class as the generated region (a task chair and a
    // generated chair become the identical glyph) instead of raw bbox outlines.
    const norm = normalizeFurniture(f)
    // Un-swap the aspect-baked footprint back to NATURAL (pre-rotation) so the
    // component stores a natural w/h + a real rotation facet — the exact split the
    // editor's symbol renderer expects (it draws w/h then `ctx.rotate(rotation)`),
    // mirroring DrawingCanvas.drawItemSymbol. Stamping upright (rotation 0) with the
    // aspect-baked w/h collapses the 90°/180° distinction, so ~35% of desks faced
    // the wrong way. `rotation`'s 90°-parity agrees with the aspect, so `odd` (an
    // odd number of quarter-turns ⟺ portrait) recovers the natural footprint.
    const odd = Math.round(norm.rotation / (Math.PI / 2)) % 2 !== 0
    // normalize's `rotation` is world-CCW (Y-up). The editor renders in a Y-DOWN
    // document frame (the plate push is offset-only, so imported Y-up coords land
    // vertically flipped). For a left-right SYMMETRIC symbol that vertical flip is
    // just a +π turn of the facet, so desks/chairs/tables carry `rotation + π`,
    // `mirror` false. A DOOR is NOT symmetric (it has a hand), so the flip is a
    // genuine reflection: the editor pose is `rotation` (no +π) with the hand
    // INVERTED (`!mirror`). Both make the merged piece read exactly as the (now
    // correct) import view — see the derivation in furniture.ts/drawDoor.
    const isDoor = norm.category === 'Door'
    comps.push({
      category: norm.category,
      x: cx - offset.x,
      y: cy - offset.y,
      w: odd ? norm.h : norm.w,
      h: odd ? norm.w : norm.h,
      rotation: isDoor ? norm.rotation : norm.rotation + Math.PI,
      mirror: isDoor ? !norm.mirror : false,
      label: norm.label,
      productId: norm.productId,
      productName: norm.productName,
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
