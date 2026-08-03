// Furniture mutation for the imported-drawing canvas: move, rotate, delete,
// duplicate, stamp-a-new-item, and the snapshot undo stack behind them.
//
// Every entry point follows the same shape as the original in-class methods —
// snapshot for undo, mutate `drawing.furniture` in place, repaint, then notify
// via `onChange`. Geometry helpers (translate/rotate/recomputeBbox) are pure
// over a single {@link FurnitureItem} and are reused by the input layer's drag.

import type { DrawEntity, FurnitureItem, Category } from './types'
import { CATEGORY_COLOR } from './types'
import { renderScene } from './drawingRender'
import { DUP_OFFSET, UNDO_CAP, type DrawingScene } from './drawingScene'

export function emitChange(s: DrawingScene): void {
  if (s.drawing) s.ev.onChange?.(s.drawing)
}

export function pushUndo(s: DrawingScene): void {
  if (!s.drawing) return
  s.undoStack.push(structuredClone(s.drawing.furniture))
  if (s.undoStack.length > UNDO_CAP) s.undoStack.shift()
}

/** Restore the last pre-edit snapshot of the furniture. No-op if nothing to undo. */
export function undoEdit(s: DrawingScene): void {
  const d = s.drawing
  if (!d || s.undoStack.length === 0) return
  d.furniture = s.undoStack.pop() as FurnitureItem[]
  s.selected = null
  s.hovered = null
  s.ev.onSelect?.(null)
  renderScene(s)
  emitChange(s)
}

export function rotateSelected(s: DrawingScene, angle: number): void {
  if (!s.selected) return
  pushUndo(s)
  rotateItem(s.selected, angle)
  renderScene(s)
  emitChange(s)
}

export function deleteSelected(s: DrawingScene): void {
  const d = s.drawing
  if (!d || !s.selected) return
  pushUndo(s)
  const i = d.furniture.indexOf(s.selected)
  if (i >= 0) d.furniture.splice(i, 1)
  s.selected = null
  s.hovered = null
  s.ev.onSelect?.(null)
  renderScene(s)
  emitChange(s)
}

export function duplicateSelected(s: DrawingScene): void {
  const d = s.drawing
  if (!d || !s.selected) return
  pushUndo(s)
  const clone = structuredClone(s.selected)
  clone.id = nextItemId(s)
  translateItem(clone, DUP_OFFSET, -DUP_OFFSET)
  d.furniture.push(clone)
  s.selected = clone
  s.ev.onSelect?.(clone)
  renderScene(s)
  emitChange(s)
}

/** Next free numeric item id (ids are unique; names may repeat for dupes). */
function nextItemId(s: DrawingScene): number {
  return (s.drawing?.furniture ?? []).reduce((m, f) => Math.max(m, f.id), 0) + 1
}

/** `base`, or `base 2`, `base 3`, … — first name not already in the schedule.
 *  Sidebar pick + category rows key items by NAME, so a placed item gets its
 *  own name rather than silently aggregating into an imported row. */
function uniqueItemName(s: DrawingScene, base: string): string {
  const names = new Set((s.drawing?.furniture ?? []).map((f) => f.name))
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** Stamp the armed `PlaceSpec` centered at world (cx, cy) — one undo entry,
 *  select the new item, keep placement mode armed for the next click. */
export function placeAt(s: DrawingScene, cx: number, cy: number): void {
  const d = s.drawing
  const spec = s.placing
  if (!d || !spec) return
  pushUndo(s)
  const category = (spec.category in CATEGORY_COLOR ? spec.category : 'furniture') as Category
  const hw = spec.w / 2
  const hh = spec.h / 2
  // Synthesized footprint linework (no CAD block exists): the closed outline
  // plus an inset front-edge tick so rotation reads at a glance.
  const outline: DrawEntity = {
    kind: 'polyline',
    layer: 'DS-PLACED',
    category,
    closed: true,
    pts: [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ],
  }
  const tickY = cy - hh + Math.min(0.08, spec.h * 0.18)
  const tick: DrawEntity = {
    kind: 'polyline',
    layer: 'DS-PLACED',
    category,
    pts: [
      [cx - hw * 0.6, tickY],
      [cx + hw * 0.6, tickY],
    ],
  }
  const item: FurnitureItem = {
    id: nextItemId(s),
    name: uniqueItemName(s, spec.name),
    raw: spec.name,
    category,
    bbox: [cx - hw, cy - hh, cx + hw, cy + hh],
    origin: [cx, cy],
    rotation: 0,
    entities: [outline, tick],
  }
  if (s.placeRotation !== 0) rotateItem(item, s.placeRotation)
  d.furniture.push(item)
  s.selected = item
  s.ev.onSelect?.(item)
  s.canvas.style.cursor = 'crosshair' // stay armed for the next stamp
  renderScene(s)
  emitChange(s)
}

/** Translate one item (origin, all entity geometry, and bbox) by a world delta. */
export function translateItem(it: FurnitureItem, dx: number, dy: number): void {
  it.origin[0] += dx
  it.origin[1] += dy
  for (const e of it.entities) {
    if (e.pts) for (const p of e.pts) ((p[0] += dx), (p[1] += dy))
    if (e.cx !== undefined) e.cx += dx
    if (e.cy !== undefined) e.cy += dy
    if (e.tx !== undefined) e.tx += dx
    if (e.ty !== undefined) e.ty += dy
  }
  const [minX, minY, maxX, maxY] = it.bbox
  it.bbox = [minX + dx, minY + dy, maxX + dx, maxY + dy]
}

/** Rotate one item about its bbox center by `angle` (radians, CCW world). */
export function rotateItem(it: FurnitureItem, angle: number): void {
  const [minX, minY, maxX, maxY] = it.bbox
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rot = (x: number, y: number): [number, number] => {
    const px = x - cx
    const py = y - cy
    return [cx + px * cos - py * sin, cy + px * sin + py * cos]
  }
  ;[it.origin[0], it.origin[1]] = rot(it.origin[0], it.origin[1])
  for (const e of it.entities) {
    if (e.pts) for (const p of e.pts) [p[0], p[1]] = rot(p[0], p[1])
    if (e.cx !== undefined && e.cy !== undefined) [e.cx, e.cy] = rot(e.cx, e.cy)
    if (e.kind === 'arc') {
      if (e.start !== undefined) e.start += angle
      if (e.end !== undefined) e.end += angle
    }
    if (e.tx !== undefined && e.ty !== undefined) {
      ;[e.tx, e.ty] = rot(e.tx, e.ty)
      e.rot = (e.rot ?? 0) + angle
    }
  }
  it.rotation += angle
  recomputeBbox(it)
}

/** Recompute an item's axis-aligned bbox from its (already-transformed) geometry. */
function recomputeBbox(it: FurnitureItem): void {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const ext = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const e of it.entities) {
    if (e.pts) for (const p of e.pts) ext(p[0], p[1])
    if (e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
      ext(e.cx - e.r, e.cy - e.r)
      ext(e.cx + e.r, e.cy + e.r)
    }
    if (e.tx !== undefined && e.ty !== undefined) ext(e.tx, e.ty)
  }
  if (minX <= maxX && minY <= maxY) it.bbox = [minX, minY, maxX, maxY]
}
