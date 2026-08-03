// DIRECT-MANIPULATION EDITING — rooms (select · drag · resize · split ·
// duplicate · rotate · delete) and the selected component's inspector patch.
//
// Split out of `EditorCanvas.ts` (which stays the public façade and owns input
// routing): everything here mutates through the Rust `Editor` on the supplied
// {@link RoomHost} and then re-reads `getState()` — no document state is ever
// cached in this module. Only the in-flight drag/resize GESTURE (screen-space
// bookkeeping, not document truth) lives here, and it stores ids + the starting
// geometry it re-derives from, exactly as the canvas did.

import type { Editor } from '../wasm/ds_core'
import type {
  DocComponent,
  DocState,
  DocZone,
  RoomSelection,
  SelectedPatch,
  ZoneType,
} from '../types/doc'
import { ZONE_LABEL } from '../types/doc'
import { clampN, handlePoints, inScreenBox, wallBbox } from './paint'

interface Pt {
  x: number
  y: number
}

/** 10 cm grid snap — every room/component edit lands on it. */
export const SNAP_M = 0.1
/** A room can't be dragged smaller than 1 m on a side. */
const ROOM_MIN_M = 1.0
/** Grab radius (px) around a resize handle. */
const HANDLE_HIT_PX = 8
/** Cursors for the 8 handles, in `handlePoints` order (TL,T,TR,R,BR,B,BL,L). */
const HANDLE_CURSOR = [
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
]

/** What room editing needs from the canvas. `EditorCanvas` supplies a live
 *  getter-backed view of itself, so `ed` always tracks the current core. */
export interface RoomHost {
  readonly ed: Editor
  getState(): DocState
  /** Repaint + notify React (the canvas's own commit). */
  commit(): void
  toWorld(sx: number, sy: number): Pt
  toScreen(wx: number, wy: number): Pt
  /** The canvas's room selection (kept there because React reads it). */
  selectedZoneId: number | null
  readonly onRoom: ((sel: RoomSelection | null) => void) | null
  setCursor(cursor: string): void
}

const snapM = (v: number) => Math.round(v / SNAP_M) * SNAP_M

/**
 * Apply an edit to the current selection from the object inspector. Maps a
 * partial patch to the matching `Editor` primitive(s) and commits once. Only
 * component geometry/binding is editable today (walls are not select-hit).
 */
export function updateSelectedComponent(host: RoomHost, patch: SelectedPatch) {
  const s = host.getState()
  const id = s.selection
  if (id == null) return
  const c = s.components.find((x) => x.id === id)
  if (!c) return
  if (patch.x !== undefined || patch.y !== undefined) {
    host.ed.move_component(id, patch.x ?? c.x, patch.y ?? c.y)
  }
  if (patch.w !== undefined || patch.h !== undefined) {
    host.ed.set_component_size(id, patch.w ?? c.w, patch.h ?? c.h)
  }
  if (patch.rotation !== undefined) host.ed.set_component_rotation(id, patch.rotation)
  if (patch.category !== undefined) host.ed.set_component_category(id, patch.category)
  if (patch.decision !== undefined) host.ed.set_decision(id, patch.decision)
  if (patch.product_id !== undefined) {
    host.ed.assign_product(id, patch.product_id, patch.product_name ?? c.label, undefined)
  }
  host.commit()
}

/** Room selection, contextual ops, hit-testing, and the drag/resize gestures —
 *  all composed from the core's zone bindings (Laiout-style direct edit). */
export class RoomInteraction {
  private roomDrag: {
    zoneId: number
    start: Pt
    zone0: { x: number; y: number; w: number; h: number }
    comps: { id: number; x0: number; y0: number }[]
    walls: { id: number; ax0: number; ay0: number; bx0: number; by0: number }[]
  } | null = null
  private roomResize: {
    zoneId: number
    handle: number
    zone0: { x: number; y: number; w: number; h: number }
    // members stored as fractions of the room box so they re-flow on resize
    comps: { id: number; fx: number; fy: number }[]
    walls: { id: number; afx: number; afy: number; bfx: number; bfy: number }[]
  } | null = null
  private lastRoomKey: string | null = null

  constructor(private host: RoomHost) {}

  // ---- selection + contextual ops ----
  private zones(): DocZone[] {
    return this.host.getState().zones ?? []
  }
  zoneById(id: number): DocZone | null {
    return this.zones().find((z) => z.id === id) ?? null
  }
  selectedZone(): DocZone | null {
    const id = this.host.selectedZoneId
    return id == null ? null : this.zoneById(id)
  }

  /** Select a room by zone id (clears component selection); null to deselect. */
  selectRoom(id: number | null) {
    this.host.selectedZoneId = id
    if (id != null) this.host.ed.clear_selection()
    this.emitRoom(true)
    this.host.commit()
  }

  /** Reclassify a room's type and rename it to that type's default label. */
  setZoneType(id: number, type: ZoneType) {
    this.host.ed.set_zone_type(id, type)
    this.host.ed.rename_zone(id, ZONE_LABEL[type] ?? type)
    this.host.selectedZoneId = id
    this.emitRoom(true)
    this.host.commit()
  }

  /** Delete a room (its zone + the furniture inside it). */
  deleteRoom(id: number) {
    this.host.ed.delete_zone(id)
    this.selectRoom(null)
  }

  /** Split a rectangular room in half along its longer axis. */
  splitRoom(id: number) {
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    if (s.w >= s.h) this.host.ed.split_zone(id, 'Vertical', s.x)
    else this.host.ed.split_zone(id, 'Horizontal', s.y)
    this.emitRoom(true)
    this.host.commit()
  }

  /** Duplicate a rectangular room + its furniture, offset into free space. */
  duplicateRoom(id: number) {
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    const bb = this.wallWorldBBox()
    // Offset by 1 m, clamped so the copy's bbox stays on the plate.
    let off = 1
    if (bb) off = Math.min(off, Math.max(0, bb.maxX - (s.x + s.w / 2)), Math.max(0, bb.maxY - (s.y + s.h / 2)))
    const members = this.host.getState().components.filter((c) => z.component_ids.includes(c.id))
    const newId = Number(this.host.ed.add_zone(z.zone_type, s.x + off, s.y + off, s.w, s.h, `${z.label} copy`))
    for (const c of members) this.host.ed.add_component(c.category, c.x + off, c.y + off, c.w, c.h)
    this.host.selectedZoneId = newId
    this.emitRoom(true)
    this.host.commit()
  }

  /**
   * Rotate a rectangular room 90° clockwise about its center. The zone Rect
   * swaps w/h (center fixed); every furniture member and interior wall is
   * rotated about that center — positions turn AND each component gains 90° of
   * `rotation` so the piece itself (chair/monitor) turns with the room. If the
   * swapped box would leave the plate it's translated back on (everything with
   * it, so members stay aligned). Rings aren't Rect → skipped, like resize.
   * Four calls return to the original orientation (4×90° = identity).
   */
  rotateRoom(id: number, deg = 90) {
    const ed = this.host.ed
    const z = this.zoneById(id)
    if (!z || z.shape.kind !== 'Rect') return // rings aren't rotatable (non-Rect)
    const s = z.shape
    const cx = s.x
    const cy = s.y
    // Number of clockwise quarter-turns (only 90° multiples keep an axis-aligned Rect).
    const turns = ((Math.round(deg / 90) % 4) + 4) % 4
    if (turns === 0) return
    const quarter = (Math.PI / 2) * turns
    // Clockwise quarter-turn about center in the Y-down plan: (dx,dy) → (-dy,dx).
    const rot = (px: number, py: number) => {
      let dx = px - cx
      let dy = py - cy
      for (let i = 0; i < turns; i++) {
        const ndx = -dy
        const ndy = dx
        dx = ndx
        dy = ndy
      }
      return { x: cx + dx, y: cy + dy }
    }
    // Odd turns swap w/h; even turns keep them.
    const newW = turns % 2 === 1 ? s.h : s.w
    const newH = turns % 2 === 1 ? s.w : s.h
    // Clamp the swapped box back onto the plate; translate the whole room by the
    // same (grid-snapped) delta so members stay aligned inside it.
    let sdx = 0
    let sdy = 0
    const bb = this.wallWorldBBox()
    if (bb) {
      // If the swapped box can't fit the plate in an axis, no translation can
      // bring it fully on-plate — clamping one edge would shove furniture off the
      // opposite side (a wide room rotated onto a plate too short to hold its
      // length). Refuse the rotation (no-op) rather than let furniture escape.
      const eps = 1e-6
      if (newW > bb.maxX - bb.minX + eps || newH > bb.maxY - bb.minY + eps) return
      const left = cx - newW / 2
      const right = cx + newW / 2
      const top = cy - newH / 2
      const bottom = cy + newH / 2
      if (left < bb.minX) sdx = bb.minX - left
      else if (right > bb.maxX) sdx = bb.maxX - right
      if (top < bb.minY) sdy = bb.minY - top
      else if (bottom > bb.maxY) sdy = bb.maxY - bottom
    }
    sdx = snapM(sdx)
    sdy = snapM(sdy)
    const members = this.host.getState().components.filter((c) => z.component_ids.includes(c.id))
    for (const c of members) {
      const p = rot(c.x, c.y)
      ed.move_component(c.id, snapM(p.x + sdx), snapM(p.y + sdy))
      // Normalize into [0, 2π) so 4 turns land exactly back on the original value.
      const nr = (((c.rotation + quarter) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      ed.set_component_rotation(c.id, nr)
    }
    for (const wl of this.interiorWalls(this.zoneWorldBBox(z))) {
      const a = rot(wl.a.x, wl.a.y)
      const b = rot(wl.b.x, wl.b.y)
      ed.set_wall(wl.id, snapM(a.x + sdx), snapM(a.y + sdy), snapM(b.x + sdx), snapM(b.y + sdy))
    }
    ed.resize_zone(id, snapM(cx + sdx), snapM(cy + sdy), newW, newH)
    // Permanent invariant (DEV): after a rotation every member must still sit on
    // the plate. The fit-guard + shared translate guarantee this; a fire here
    // means a regression in either. (snap can nudge a member ≤½ a grid cell past
    // a wall, so allow SNAP_M/2 slack.)
    if (import.meta.env.DEV && bb) {
      const slack = SNAP_M / 2 + 1e-6
      for (const c of this.host.getState().components.filter((m) => z.component_ids.includes(m.id))) {
        if (c.x < bb.minX - slack || c.x > bb.maxX + slack || c.y < bb.minY - slack || c.y > bb.maxY + slack)
          console.error(`rotateRoom: member ${c.id} escaped the plate at (${c.x}, ${c.y})`, bb)
      }
    }
    this.host.selectedZoneId = id
    this.emitRoom(true)
    this.host.commit()
  }

  // ---- room geometry / hit-testing helpers ----
  wallWorldBBox() {
    const bb = wallBbox(this.host.getState().walls)
    return bb ? { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY } : null
  }
  zoneWorldBBox(z: DocZone) {
    const s = z.shape
    if (s.kind === 'Poly') {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [px, py] of s.pts) {
        minX = Math.min(minX, px)
        minY = Math.min(minY, py)
        maxX = Math.max(maxX, px)
        maxY = Math.max(maxY, py)
      }
      return { minX, minY, maxX, maxY }
    }
    return { minX: s.x - s.w / 2, minY: s.y - s.h / 2, maxX: s.x + s.w / 2, maxY: s.y + s.h / 2 }
  }
  /** Selected room box in screen px (top-left origin). */
  screenBox(z: DocZone) {
    const bb = this.zoneWorldBBox(z)
    const p0 = this.host.toScreen(bb.minX, bb.minY)
    const p1 = this.host.toScreen(bb.maxX, bb.maxY)
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y }
  }
  /** Topmost non-MeetingRoom component whose footprint covers world point w. */
  topFurnitureAt(w: Pt): DocComponent | null {
    const comps = this.host.getState().components
    for (let i = comps.length - 1; i >= 0; i--) {
      const c = comps[i]
      if (c.category === 'MeetingRoom') continue
      if (Math.abs(c.x - w.x) <= c.w / 2 && Math.abs(c.y - w.y) <= c.h / 2) return c
    }
    return null
  }
  /** Index of the selected room's resize handle under screen point s, or null. */
  handleAt(s: Pt): number | null {
    const z = this.selectedZone()
    if (!z || z.shape.kind !== 'Rect') return null
    const pts = handlePoints(this.screenBox(z))
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - s.x) <= HANDLE_HIT_PX && Math.abs(pts[i].y - s.y) <= HANDLE_HIT_PX) return i
    }
    return null
  }

  /** Walls that belong to a room and travel with it on drag/resize. Test is
   *  boundary-INCLUSIVE (bbox expanded by `eps`): a room's own enclosing/partition
   *  walls sit ON its bbox edges (endpoints at x≈minX/maxX or y≈minY/maxY), so a
   *  strict interior test dropped them and they stayed behind on drag. The
   *  expanded box still excludes a neighbour room's far wall (it lies beyond the
   *  room's own perimeter by more than `eps`). */
  private interiorWalls(bb: { minX: number; minY: number; maxX: number; maxY: number }) {
    const eps = 0.15
    const inside = (p: Pt) =>
      p.x >= bb.minX - eps && p.x <= bb.maxX + eps && p.y >= bb.minY - eps && p.y <= bb.maxY + eps
    return this.host.getState().walls.filter((wl) => inside(wl.a) && inside(wl.b))
  }

  // ---- drag / resize gestures (driven by the canvas pointer handlers) ----

  /** Advance whatever gesture is in flight to `screen` — resize wins over drag,
   *  exactly as the canvas pointer handler ordered it. False when none is live
   *  (the caller then falls through to component drag / hover). */
  updateGesture(screen: Pt): boolean {
    if (this.roomResize) {
      this.updateResize(screen)
      return true
    }
    if (this.roomDrag) {
      this.updateDrag(screen)
      return true
    }
    return false
  }

  /** End any in-flight gesture (pointer up); true when one was live. */
  endGesture(): boolean {
    if (this.roomDrag == null && this.roomResize == null) return false
    this.roomDrag = null
    this.roomResize = null
    return true
  }

  beginDrag(zoneId: number, w: Pt) {
    const z = this.zoneById(zoneId)
    // Rect and Poly rooms drag; a RectRing (perimeter circulation) doesn't.
    // A Poly is dragged via its bounding box — the core exposes no Poly-preserving
    // move (`resize_zone`/`add_zone` build only `Rect`), so the first grid-step of
    // movement re-homes it as its rectangular footprint (honest limit; see
    // updateDrag). Seeding zone0 from the bbox makes both paths identical.
    if (!z || (z.shape.kind !== 'Rect' && z.shape.kind !== 'Poly')) return
    const bb = this.zoneWorldBBox(z)
    const zone0 = {
      x: (bb.minX + bb.maxX) / 2,
      y: (bb.minY + bb.maxY) / 2,
      w: bb.maxX - bb.minX,
      h: bb.maxY - bb.minY,
    }
    const comps = this.host
      .getState()
      .components.filter((c) => z.component_ids.includes(c.id))
      .map((c) => ({ id: c.id, x0: c.x, y0: c.y }))
    const walls = this.interiorWalls(bb).map((wl) => ({
      id: wl.id,
      ax0: wl.a.x,
      ay0: wl.a.y,
      bx0: wl.b.x,
      by0: wl.b.y,
    }))
    this.roomDrag = { zoneId, start: w, zone0, comps, walls }
  }

  /** Advance the in-flight room drag to `screen`; no-op when none is live. */
  private updateDrag(screen: Pt) {
    const rd = this.roomDrag
    if (!rd) return
    const ed = this.host.ed
    const w = this.host.toWorld(screen.x, screen.y)
    let dx = w.x - rd.start.x
    let dy = w.y - rd.start.y
    const bb = this.wallWorldBBox()
    if (bb) {
      dx = clampN(dx, bb.minX - (rd.zone0.x - rd.zone0.w / 2), bb.maxX - (rd.zone0.x + rd.zone0.w / 2))
      dy = clampN(dy, bb.minY - (rd.zone0.y - rd.zone0.h / 2), bb.maxY - (rd.zone0.y + rd.zone0.h / 2))
    }
    dx = snapM(dx)
    dy = snapM(dy)
    // No net movement → don't touch the document. Keeps a plain select-click on a
    // Poly non-destructive (a jittered sub-grid drag never re-homes it to a Rect).
    if (dx === 0 && dy === 0) return
    for (const c of rd.comps) ed.move_component(c.id, c.x0 + dx, c.y0 + dy)
    for (const wl of rd.walls) ed.set_wall(wl.id, wl.ax0 + dx, wl.ay0 + dy, wl.bx0 + dx, wl.by0 + dy)
    ed.resize_zone(rd.zoneId, rd.zone0.x + dx, rd.zone0.y + dy, rd.zone0.w, rd.zone0.h)
    this.emitRoom(true)
    this.host.commit()
  }

  beginResize(handle: number, zoneId: number) {
    const z = this.zoneById(zoneId)
    if (!z || z.shape.kind !== 'Rect') return
    const s = z.shape
    const frac = (v: number, o: number, size: number) => (v - o) / size
    const comps = this.host
      .getState()
      .components.filter((c) => z.component_ids.includes(c.id))
      .map((c) => ({ id: c.id, fx: frac(c.x, s.x, s.w), fy: frac(c.y, s.y, s.h) }))
    const walls = this.interiorWalls(this.zoneWorldBBox(z)).map((wl) => ({
      id: wl.id,
      afx: frac(wl.a.x, s.x, s.w),
      afy: frac(wl.a.y, s.y, s.h),
      bfx: frac(wl.b.x, s.x, s.w),
      bfy: frac(wl.b.y, s.y, s.h),
    }))
    this.roomResize = { zoneId, handle, zone0: { x: s.x, y: s.y, w: s.w, h: s.h }, comps, walls }
  }

  /** Advance the in-flight room resize to `screen`; no-op when none is live. */
  private updateResize(screen: Pt) {
    const rr = this.roomResize
    if (!rr) return
    const ed = this.host.ed
    const w = this.host.toWorld(screen.x, screen.y)
    const z0 = rr.zone0
    let left = z0.x - z0.w / 2
    let right = z0.x + z0.w / 2
    let top = z0.y - z0.h / 2
    let bottom = z0.y + z0.h / 2
    const h = rr.handle
    if (h === 0 || h === 6 || h === 7) left = snapM(w.x) // left-edge handles
    if (h === 2 || h === 3 || h === 4) right = snapM(w.x) // right-edge handles
    if (h === 0 || h === 1 || h === 2) top = snapM(w.y) // top-edge handles
    if (h === 4 || h === 5 || h === 6) bottom = snapM(w.y) // bottom-edge handles
    // enforce a minimum size (push the moving edge back if it crosses)
    if (right - left < ROOM_MIN_M) {
      if (h === 0 || h === 6 || h === 7) left = right - ROOM_MIN_M
      else right = left + ROOM_MIN_M
    }
    if (bottom - top < ROOM_MIN_M) {
      if (h === 0 || h === 1 || h === 2) top = bottom - ROOM_MIN_M
      else bottom = top + ROOM_MIN_M
    }
    // clamp to the plate
    const bb = this.wallWorldBBox()
    if (bb) {
      left = Math.max(left, bb.minX)
      top = Math.max(top, bb.minY)
      right = Math.min(right, bb.maxX)
      bottom = Math.min(bottom, bb.maxY)
    }
    const nx = (left + right) / 2
    const ny = (top + bottom) / 2
    const nw = right - left
    const nh = bottom - top
    for (const c of rr.comps) ed.move_component(c.id, nx + c.fx * nw, ny + c.fy * nh)
    for (const wl of rr.walls) {
      ed.set_wall(wl.id, nx + wl.afx * nw, ny + wl.afy * nh, nx + wl.bfx * nw, ny + wl.bfy * nh)
    }
    ed.resize_zone(rr.zoneId, nx, ny, nw, nh)
    this.emitRoom(true)
    this.host.commit()
  }

  /** Push the current room selection + its screen box to the floating toolbar. */
  emitRoom(force = false) {
    const onRoom = this.host.onRoom
    if (!onRoom) return
    if (this.host.selectedZoneId == null) {
      if (this.lastRoomKey !== null || force) onRoom(null)
      this.lastRoomKey = null
      return
    }
    const z = this.zoneById(this.host.selectedZoneId)
    if (!z) {
      onRoom(null)
      this.lastRoomKey = null
      return
    }
    const b = this.screenBox(z)
    const box = { left: b.x, top: b.y, width: b.w, height: b.h }
    const key = `${z.id}:${z.zone_type}:${z.label}:${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.w)}:${Math.round(b.h)}`
    if (!force && key === this.lastRoomKey) return
    this.lastRoomKey = key
    onRoom({ zone: z, box })
  }

  /** Set the canvas cursor for a hover at screen point s (select tool). */
  updateHoverCursor(s: Pt) {
    let cur = ''
    const z = this.selectedZone()
    if (z && z.shape.kind === 'Rect') {
      const hi = this.handleAt(s)
      if (hi != null) cur = HANDLE_CURSOR[hi]
      else if (inScreenBox(this.screenBox(z), s)) cur = 'move'
    }
    if (!cur) {
      const w = this.host.toWorld(s.x, s.y)
      if (this.topFurnitureAt(w)) cur = 'pointer'
      else if (this.host.ed.zone_at(w.x, w.y) != null) cur = 'move'
      else cur = 'default'
    }
    this.host.setCursor(cur)
  }
}
