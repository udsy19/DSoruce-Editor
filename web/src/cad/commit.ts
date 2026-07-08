// Commit hand-drafted CAD linework into the generative document.
//
// The CAD layer is display-only sketch space; the Rust core is the source of
// truth the generator/circulation evaluator read. `commitCadToPlan` promotes
// the store's wall-like entities — `line`, `polyline` (each segment), `rect`
// (its four edges, rotation honored) — into document walls via
// `Editor.add_wall`, then removes the committed entities from the CAD store
// under ONE undo snapshot (⌘Z restores the sketch; the added walls live in the
// core doc and are covered by the doc's own snapshot/restore undo).
//
// Curved/annotation kinds (circle, arc, ellipse, dimension, text, door,
// window, column, hatch) are skipped and counted — walls are straight
// segments in the core model.

import type { EditorCanvas } from '../editor/EditorCanvas'
import type { CadEntity, Vec2 } from './model'

/** Thickness (m) of walls committed from single-line CAD sketches. */
const COMMIT_WALL_THICKNESS = 0.1

type Seg = [Vec2, Vec2]

/** The wall segments a CAD entity commits to, or null when the kind is skipped. */
function entitySegments(e: CadEntity): Seg[] | null {
  switch (e.kind) {
    case 'line':
      return [[e.a, e.b]]
    case 'polyline': {
      const segs: Seg[] = []
      for (let i = 0; i + 1 < e.pts.length; i++) segs.push([e.pts[i], e.pts[i + 1]])
      if (e.closed && e.pts.length >= 3) segs.push([e.pts[e.pts.length - 1], e.pts[0]])
      return segs
    }
    case 'rect': {
      const cos = Math.cos(e.rotation)
      const sin = Math.sin(e.rotation)
      const corner = (dx: number, dy: number): Vec2 => ({
        x: e.x + dx * cos - dy * sin,
        y: e.y + dx * sin + dy * cos,
      })
      const c = [
        corner(-e.w / 2, -e.h / 2),
        corner(e.w / 2, -e.h / 2),
        corner(e.w / 2, e.h / 2),
        corner(-e.w / 2, e.h / 2),
      ]
      return [
        [c[0], c[1]],
        [c[1], c[2]],
        [c[2], c[3]],
        [c[3], c[0]],
      ]
    }
    default:
      return null
  }
}

/**
 * Commit the CAD sketch to the plan: every `line` / `polyline` / `rect` entity
 * becomes document walls (one `add_wall` per segment, `COMMIT_WALL_THICKNESS`
 * thick); the committed entities are then removed from the CAD store under a
 * single undo snapshot. Other kinds are left in place and counted as
 * `skipped`. Ends with `ec.sync()` so React/metrics re-derive.
 *
 * Returns `{ walls, skipped }`: wall segments added, entities skipped.
 */
export function commitCadToPlan(ec: EditorCanvas): { walls: number; skipped: number } {
  const store = ec.cad.store
  const segs: Seg[] = []
  const committed: number[] = []
  let skipped = 0
  for (const e of store.entities) {
    const s = entitySegments(e)
    if (s === null) {
      skipped++
      continue
    }
    const real = s.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-6)
    if (real.length === 0) {
      skipped++ // degenerate (zero-length) sketch entity — nothing to commit
      continue
    }
    segs.push(...real)
    committed.push(e.id)
  }
  if (committed.length === 0) return { walls: 0, skipped }

  for (const [a, b] of segs) ec.ed.add_wall(a.x, a.y, b.x, b.y, COMMIT_WALL_THICKNESS)

  // One snapshot for the whole removal → a single ⌘Z restores the sketch.
  store.snapshot()
  store.remove(committed)

  ec.sync()
  return { walls: segs.length, skipped }
}
