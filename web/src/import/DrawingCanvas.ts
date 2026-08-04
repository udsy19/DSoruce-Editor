import type { Drawing, DrawEntity, FurnitureItem, Category } from './types'
import { CATEGORY_COLOR } from './types'
import { collectWallSegments, type Pt, type Segment } from './testfit'
import type { RoomMarker, RoomType } from './markers'
import type { Backdrop } from './rasterImport'
import { backdropBounds } from './rasterImport'
import { normalizeFurniture } from './normalize'
import { drawSymbol, seatsForSize } from '../editor/symbols'

/**
 * Framework-agnostic CAD renderer for an imported {@link Drawing}. Renders
 * real architectural linework (walls, glazing, doors, casework, annotation) at
 * CAD fidelity plus selectable furniture blocks. Mirrors the light "floor-plate"
 * aesthetic of {@link ../editor/EditorCanvas} (white plate on #f2f4f7 mat, thin
 * dark walls) with pan/zoom/DPR handling.
 *
 * ── Coordinates ───────────────────────────────────────────────────────────
 * The Drawing is in METERS, world-space, Y-UP (DXF/CAD convention). This
 * renderer flips Y for the screen: screenX = wx·scale + ox, screenY = −wy·scale
 * + oy. Arc/text angles (radians, CCW in world) become clockwise on screen, so
 * we negate them when drawing.
 */

// ── The CANVAS palette (docs/design/ui-system.md §4.1.1) ────────────────────
// Canvas colour is semantic DATA, governed by what the object is — never brand.
// The UI accent token must never appear on canvas geometry, and these must never
// be aliased to it: gray = unbound · blue = bound/specified · amber = live.
//
// Mat behind the plate — matches EditorCanvas C.mat.
const MAT = '#f2f4f7'
// Furniture linework (gray = UNBOUND) + a lighter secondary tone for a symbol's
// detail (monitor, chair, glazing centerline). Mirrors EditorCanvas's pair.
const FURNITURE_LINE = '#5c6670'
const FURNITURE_DETAIL = '#9aa2ad'
// Body + seat fills, identical to EditorCanvas's C.furnitureFill/C.furnitureSeat
// so one desk renders identically on both canvases.
const FURNITURE_FILL = 'rgba(255,255,255,0.86)'
const FURNITURE_SEAT = '#e7eaee'
// LIVE selection/hover = warm amber. Its one and only meaning across the app.
const ACCENT = '#E8A13C'
const ACCENT_HALO = 'rgba(232,161,60,0.28)'
const HOVER = 'rgba(232,161,60,0.55)'
// Bound ("specified"/re-imagined) furniture — solid data-blue so a decided item
// reads distinctly from both unbound gray linework and the amber selection.
const SPECIFIED = '#2d5bd6'
const SPECIFIED_DETAIL = '#6d8fe0'

/** A placeable footprint the palette hands to {@link DrawingCanvas.beginPlace}. */
export interface PlaceSpec {
  /** Human-readable product/item name — becomes the FurnitureItem name. */
  name: string
  /** Semantic category. Coerced to a known {@link Category}; else 'furniture'. */
  category: string
  /** Footprint width (X extent) in meters. */
  w: number
  /** Footprint depth (Y extent) in meters. */
  h: number
}

const MIN_SCALE = 2
const MAX_SCALE = 4000
const FIT_PADDING = 40 // px padding around bounds in fitToView
const TEXT_MIN_PX = 6.5 // hide text glyphs smaller than this on screen
const DRAG_THRESHOLD = 4 // px movement below which a mouse-up is a click
const ROTATE_STEP = Math.PI / 12 // 15° per keypress
const DUP_OFFSET = 0.3 // meters — nudge for a duplicated item
const HANDLE_PX = 3 // half-size of selection corner handles, screen px
const UNDO_CAP = 50 // max snapshots kept
const PLACE_SNAP = 0.05 // meters — placement-ghost grid snap
const PLACE_FILL = 'rgba(232,161,60,0.10)' // ghost footprint wash
const SNAP_PX = 12 // screen-px radius for the area tool's adaptive wall snap
const AREA_MASK = 'rgba(20,24,33,0.42)' // dims everything OUTSIDE the selected area
const AREA_FILL = 'rgba(232,161,60,0.08)' // faint wash inside the selected area
const AREA_VERTEX_PX = 4 // half-size of an area-polygon vertex handle, screen px
const AREA_CLOSE_PX = 10 // click within this of the first vertex closes the ring
const MARKER_R_PX = 11 // marker pin radius, screen px
const ANCHOR_COLOR = '#4a8fc7' // anchor pins: cool blue, distinct from amber markers
const ANCHOR_R_PX = 12 // anchor pin (diamond) half-diagonal, screen px

/** Per-category screen lineweight (CSS px), independent of zoom. */
const LINE_WEIGHT: Record<Category, number> = {
  wall: 1.6,
  glazing: 1,
  door: 1,
  furniture: 1,
  casework: 1,
  fixture: 1,
  annotation: 0.75,
  dimension: 0.75,
  other: 1,
}

/** Draw order rank — faint annotation underneath, architecture on top. */
const RANK: Record<Category, number> = {
  dimension: 0,
  annotation: 1,
  other: 2,
  fixture: 3,
  casework: 4,
  door: 6,
  glazing: 7,
  wall: 8,
  furniture: 5, // furniture is drawn in its own pass; kept for completeness
}
const FURNITURE_RANK = 5

interface StyleBucket {
  color: string
  lw: number
  rank: number
  ents: DrawEntity[]
}

export class DrawingCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = Math.max(1, window.devicePixelRatio || 1)

  private drawing: Drawing | null = null
  private buckets: StyleBucket[] = []
  private texts: DrawEntity[] = []

  private scale = 40 // px per meter
  private offset = { x: 0, y: 0 } // screen px of world origin
  // True while the view still shows the auto-fit framing (no manual pan/zoom
  // since the last fitToView). When set, a container/window resize RE-FITS so
  // the plan keeps filling the box; once the user pans or zooms we stop
  // re-fitting and just repaint, preserving their navigation.
  private fitted = false

  private selected: FurnitureItem | null = null
  private hovered: FurnitureItem | null = null

  // pan / click / move bookkeeping
  private pointerDown = false
  private didPan = false
  private movingActive = false
  private moveCandidate: FurnitureItem | null = null
  private lastScreen = { x: 0, y: 0 }
  private downScreen = { x: 0, y: 0 }
  private lastWorld = { x: 0, y: 0 }

  // placement mode: the spec being stamped, the snapped ghost position (world
  // meters; null until the cursor enters the canvas) and the ghost rotation.
  private placing: PlaceSpec | null = null
  private placeCursor: { x: number; y: number } | null = null
  private placeRotation = 0

  // undo: snapshots of drawing.furniture taken before each mutation.
  private undoStack: FurnitureItem[][] = []

  // area-select tool (workflow.md §3.1): a polygon in drawing/source coords.
  // `area` holds either the in-progress vertices or the committed ring; while
  // the tool is armed vertices are editable (drag handles, adaptive wall snap).
  private areaTool = false
  private area: Pt[] = []
  private areaClosed = false
  private areaDragVertex: number | null = null
  private toolCursor: Pt | null = null // snapped preview point (area vertex / marker ghost)
  private toolSnapped = false // did `toolCursor` land on a wall feature
  private snapPoints: Pt[] = [] // wall/glazing endpoints — adaptive snap targets
  private snapSegs: Segment[] = [] // wall/glazing segments — projection snap targets

  // marker tool (workflow.md §3.2): `markerArm` is the type+ref waiting to be
  // dropped; `markers` are the placed pins (drawing/source coords) to render.
  private markerArm: { type: RoomType; ref: string } | null = null
  private markers: RoomMarker[] = []

  // anchor tool (workflow.md §3.5): `anchorArm` is the room kind waiting to be
  // dropped; `anchors` are the placed pins (drawing/source coords) to render as
  // diamonds — visually distinct from the round §3.2 markers.
  private anchorArm: { label: string } | null = null
  private anchors: { x: number; y: number; label: string }[] = []

  // Raster backdrop + scale calibration (rasterImport.ts). `backdrop` is the
  // image underlay; the scale tool draws a two-point reference line (world m)
  // over a known dimension — completing it fires onScaleReady, and applyScale
  // rescales the backdrop so that line equals the real length the user typed.
  private backdrop: Backdrop | null = null
  private scaleTool = false
  private scaleFirst: Pt | null = null // first click of the reference line
  private scaleLine: [Pt, Pt] | null = null // completed reference line (world m)

  private ro: ResizeObserver | null = null

  /** Fired on click: the furniture item under the cursor, or null on empty space. */
  onSelect: ((item: FurnitureItem | null) => void) | null = null
  /** Fired when the hovered furniture item changes (optional). */
  onHover: ((item: FurnitureItem | null) => void) | null = null
  /** Fired after any edit (move/rotate/delete/duplicate/undo) with the mutated drawing. */
  onChange: ((d: Drawing) => void) | null = null
  /** Fired after every re-render (pan/zoom/resize/refresh/edit) so overlays
   *  anchored in screen space (e.g. the selection card) can re-position. */
  onViewChange: (() => void) | null = null
  /** Fired when the area polygon is committed (closed), edited, or cleared —
   *  the committed ring (drawing coords) or null. In-progress vertices do NOT
   *  fire this, so React never rewrites a half-drawn polygon. */
  onAreaChange: ((polygon: Pt[] | null) => void) | null = null
  /** Fired when a marker is dropped, at the click point (drawing coords). The
   *  owner assigns the id/ref and re-arms the tool for the next drop. */
  onMarkerDrop: ((x: number, y: number) => void) | null = null
  /** Fired when the scale reference line's two points are placed, with its
   *  current world length (m). The owner prompts for the real length, then
   *  calls {@link applyScale}. */
  onScaleReady: ((worldLengthM: number) => void) | null = null
  /** Fired after {@link applyScale} recalibrates the backdrop, with the new
   *  meters-per-pixel (so the owner can persist / display the scale). */
  onScaleChange: ((mpp: number) => void) | null = null
  /** Fired when an anchor pin is dropped, at the click point (drawing coords).
   *  The owner assigns the id/kind and re-arms the tool for the next drop. */
  onAnchorDrop: ((x: number, y: number) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.attach()
    this.resize()
    this.render()
  }

  // ---- public API ----

  /** Store a drawing, precompute style buckets, frame it, and render. */
  setDrawing(d: Drawing): void {
    this.drawing = d
    this.selected = null
    this.hovered = null
    this.undoStack = []
    this.placing = null
    this.placeCursor = null
    // A fresh drawing clears any prior area/markers; the owner re-applies the
    // persisted ones via setArea/setMarkers after this returns.
    this.areaTool = false
    this.area = []
    this.areaClosed = false
    this.areaDragVertex = null
    this.markerArm = null
    this.markers = []
    this.anchorArm = null
    this.anchors = []
    this.scaleTool = false
    this.scaleFirst = null
    this.scaleLine = null
    this.backdrop = null
    this.toolCursor = null
    // Precompute adaptive-snap targets: wall/glazing endpoints and segments.
    this.snapSegs = collectWallSegments(d)
    this.snapPoints = []
    for (const [a, b] of this.snapSegs) this.snapPoints.push(a, b)
    this.buildBuckets(d)
    this.fitToView() // also renders
  }

  /** Force a re-render without touching pan/zoom — used after an external edit
   *  (e.g. the inspector binds a product to the selected item). */
  refresh(): void {
    this.render()
  }

  /**
   * Screen anchor for an item: the CSS-pixel position (relative to the canvas
   * element) of its bbox TOP-CENTER — where a selection popover should point.
   * Null when no drawing is loaded or the item is no longer part of it.
   */
  anchorFor(item: FurnitureItem): { x: number; y: number } | null {
    const d = this.drawing
    if (!d || !d.furniture.includes(item)) return null
    const [minX, , maxX, maxY] = item.bbox
    return this.toScreen((minX + maxX) / 2, maxY) // world Y-up: maxY is the top
  }

  /** Programmatically select an item (sidebar pick, tests) — keeps the
   *  canvas's internal selection in sync with React so highlight, anchor and
   *  clearSelection behave exactly as a canvas click would. */
  select(item: FurnitureItem): void {
    if (!this.drawing?.furniture.includes(item)) return
    this.cancelPlace() // a sidebar pick disarms a pending placement
    this.selected = item
    this.onSelect?.(item)
    this.render()
  }

  /** Clear the current selection (e.g. the selection card's close button).
   *  Always notifies — React may hold a selection the canvas never saw. */
  clearSelection(): void {
    this.selected = null
    this.onSelect?.(null)
    this.render()
  }

  /**
   * Enter placement mode for `spec`: a ghost footprint follows the cursor
   * (snapped to 0.05 m), R rotates it (Shift+R reverses — same convention as a
   * selected item), a click stamps a new {@link FurnitureItem} (one undo entry,
   * onChange, immediately selected). The mode STAYS armed for the same spec so
   * repeated clicks stamp multiples; Escape (or {@link cancelPlace}) exits.
   */
  beginPlace(spec: PlaceSpec): void {
    if (!this.drawing || !(spec.w > 0) || !(spec.h > 0)) return
    // Disarm the area/marker/anchor/scale tools (committed polygon + pins are kept).
    this.areaTool = false
    this.markerArm = null
    this.anchorArm = null
    this.scaleTool = false
    this.scaleFirst = null
    this.areaDragVertex = null
    this.placing = spec
    this.placeCursor = null
    this.placeRotation = 0
    this.hovered = null
    if (this.selected) {
      this.selected = null
      this.onSelect?.(null)
    }
    this.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Exit placement mode without placing (Escape does the same). */
  cancelPlace(): void {
    if (!this.placing) return
    this.placing = null
    this.placeCursor = null
    this.canvas.style.cursor = 'default'
    this.render()
  }

  isPlacing(): boolean {
    return this.placing !== null
  }

  // ---- area-select tool (workflow.md §3.1) ----

  /** Arm the area tool. If a committed polygon exists it becomes editable
   *  (drag vertices); otherwise a fresh ring is started. Click to add vertices,
   *  click the first vertex (or double-click / Enter) to close, Backspace drops
   *  the last, Esc cancels. Disarms placement + marker modes. */
  beginArea(): void {
    this.cancelPlace()
    this.markerArm = null
    this.anchorArm = null
    this.scaleTool = false
    this.scaleFirst = null
    this.areaTool = true
    if (!this.areaClosed) this.area = []
    this.areaDragVertex = null
    this.toolCursor = null
    if (this.selected) {
      this.selected = null
      this.onSelect?.(null)
    }
    this.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Clear the committed/in-progress polygon and notify (restores full plan). */
  clearArea(): void {
    this.area = []
    this.areaClosed = false
    this.areaDragVertex = null
    this.toolCursor = null
    this.render()
    this.onAreaChange?.(null)
  }

  /** Load a persisted polygon (committed) without firing onAreaChange. */
  setArea(polygon: Pt[] | null): void {
    if (polygon && polygon.length >= 3) {
      this.area = polygon.map((p): Pt => [p[0], p[1]])
      this.areaClosed = true
    } else {
      this.area = []
      this.areaClosed = false
    }
    this.areaDragVertex = null
    this.render()
  }

  isAreaTool(): boolean {
    return this.areaTool
  }

  // ---- room-marker tool (workflow.md §3.2) ----

  /** Arm the marker tool: the next click drops a pin of `type`/`ref`. Stays
   *  disarmed after — the owner re-arms with the next ref in onMarkerDrop. */
  beginMarkerPlace(type: RoomType, ref: string): void {
    this.cancelPlace()
    this.areaTool = false
    this.areaDragVertex = null
    this.anchorArm = null
    this.scaleTool = false
    this.scaleFirst = null
    this.markerArm = { type, ref }
    this.toolCursor = null
    if (this.selected) {
      this.selected = null
      this.onSelect?.(null)
    }
    this.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Load the persisted markers to render as pins. */
  setMarkers(markers: RoomMarker[]): void {
    this.markers = markers.map((m) => ({ ...m }))
    this.render()
  }

  // ---- anchor-pin tool (workflow.md §3.5) ----

  /** Arm the anchor tool: the next click drops a pin forcing a room of `label`'s
   *  kind onto the plan. Stays disarmed after — the owner re-arms in onAnchorDrop
   *  (same one-shot pattern as the marker tool). */
  beginAnchorPlace(label: string): void {
    this.cancelPlace()
    this.areaTool = false
    this.areaDragVertex = null
    this.markerArm = null
    this.scaleTool = false
    this.scaleFirst = null
    this.anchorArm = { label }
    this.toolCursor = null
    if (this.selected) {
      this.selected = null
      this.onSelect?.(null)
    }
    this.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Load the persisted anchor pins to render as diamonds. */
  setAnchors(anchors: { x: number; y: number; label: string }[]): void {
    this.anchors = anchors.map((a) => ({ ...a }))
    this.render()
  }

  /** Disarm the area, marker and anchor tools (keeps committed pins/polygon). */
  // ---- raster backdrop + scale calibration (rasterImport.ts) ----

  /** Attach (or clear) a raster underlay. The drawing bounds are kept in sync
   *  with the backdrop's world rect so fit/plate tracing frame it correctly. */
  setBackdrop(b: Backdrop | null): void {
    this.backdrop = b
    this.scaleLine = null
    this.scaleFirst = null
    if (b && this.drawing) this.drawing.bounds = backdropBounds(b)
    this.fitToView()
  }

  hasBackdrop(): boolean {
    return this.backdrop !== null
  }

  /** Arm the scale tool: click two points over a known dimension to lay a
   *  reference line; completing it fires onScaleReady with its world length. */
  beginScale(): void {
    this.cancelPlace()
    this.areaTool = false
    this.markerArm = null
    this.anchorArm = null
    this.areaDragVertex = null
    this.scaleTool = true
    this.scaleFirst = null
    this.toolCursor = null
    if (this.selected) {
      this.selected = null
      this.onSelect?.(null)
    }
    this.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Recalibrate the backdrop so the pending reference line equals `realMeters`.
   *  Rescales meters-per-pixel, reframes, clears the line, and disarms the tool. */
  applyScale(realMeters: number): void {
    const b = this.backdrop
    const line = this.scaleLine
    if (!b || !line || !(realMeters > 0)) return
    const worldLen = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1])
    if (!(worldLen > 1e-6)) return
    b.mpp *= realMeters / worldLen
    if (this.drawing) {
      this.drawing.bounds = backdropBounds(b)
    }
    this.scaleTool = false
    this.scaleFirst = null
    this.scaleLine = null
    this.canvas.style.cursor = 'default'
    this.fitToView()
    this.onScaleChange?.(b.mpp)
  }

  cancelTool(): void {
    this.areaTool = false
    this.markerArm = null
    this.anchorArm = null
    this.areaDragVertex = null
    this.scaleTool = false
    this.scaleFirst = null
    this.toolCursor = null
    this.canvas.style.cursor = 'default'
    this.render()
  }

  /** Restore the last pre-edit snapshot of the furniture. No-op if nothing to undo. */
  undo(): void {
    const d = this.drawing
    if (!d || this.undoStack.length === 0) return
    d.furniture = this.undoStack.pop() as FurnitureItem[]
    this.selected = null
    this.hovered = null
    this.onSelect?.(null)
    this.render()
    this.emitChange()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /** Frame `drawing.bounds` in the viewport with padding. */
  fitToView(): void {
    const d = this.drawing
    const { w, h } = this.cssSize()
    if (!d || w === 0 || h === 0) {
      this.render()
      return
    }
    const [minX, minY, maxX, maxY] = d.bounds
    const worldW = Math.max(1e-3, maxX - minX)
    const worldH = Math.max(1e-3, maxY - minY)
    const sx = (w - 2 * FIT_PADDING) / worldW
    const sy = (h - 2 * FIT_PADDING) / worldH
    this.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    // Center the world bbox center at the viewport center (Y flipped).
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    this.offset.x = w / 2 - cx * this.scale
    this.offset.y = h / 2 + cy * this.scale
    this.fitted = true
    this.render()
  }

  dispose(): void {
    this.ro?.disconnect()
    this.ro = null
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('dblclick', this.onDblClick)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
  }

  // ---- transforms ----
  private toScreen(wx: number, wy: number) {
    return { x: wx * this.scale + this.offset.x, y: -wy * this.scale + this.offset.y }
  }
  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.offset.x) / this.scale, y: -(sy - this.offset.y) / this.scale }
  }

  private cssSize() {
    return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr }
  }

  // ---- area tool geometry helpers ----

  /** Snap a screen point to the nearest wall endpoint (priority) or wall-line
   *  projection within `SNAP_PX`, giving the area tool its "adaptive" feel.
   *  Returns the world point + whether it snapped to a feature. */
  private snapWorld(sx: number, sy: number): { p: Pt; snapped: boolean } {
    const w = this.toWorld(sx, sy)
    const tol = SNAP_PX / this.scale // px → world meters
    let best: Pt | null = null
    let bestD = tol
    for (const [ex, ey] of this.snapPoints) {
      const d = Math.hypot(ex - w.x, ey - w.y)
      if (d < bestD) {
        bestD = d
        best = [ex, ey]
      }
    }
    if (best) return { p: best, snapped: true }
    // Fall back to the closest point on any wall segment.
    let projD = tol
    let proj: Pt | null = null
    for (const [a, b] of this.snapSegs) {
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / len2))
      const px = a[0] + t * dx
      const py = a[1] + t * dy
      const d = Math.hypot(px - w.x, py - w.y)
      if (d < projD) {
        projD = d
        proj = [px, py]
      }
    }
    if (proj) return { p: proj, snapped: true }
    return { p: [w.x, w.y], snapped: false }
  }

  /** Index of the area vertex whose handle is under (sx,sy), or null. */
  private hitAreaVertex(sx: number, sy: number): number | null {
    for (let i = 0; i < this.area.length; i++) {
      const p = this.toScreen(this.area[i][0], this.area[i][1])
      if (Math.hypot(p.x - sx, p.y - sy) <= AREA_VERTEX_PX + 4) return i
    }
    return null
  }

  /** True when (sx,sy) is within closing distance of the first vertex. */
  private nearFirstVertex(sx: number, sy: number): boolean {
    if (this.area.length < 3) return false
    const p = this.toScreen(this.area[0][0], this.area[0][1])
    return Math.hypot(p.x - sx, p.y - sy) <= AREA_CLOSE_PX
  }

  /** Notify the owner of the committed ring (or null while not yet closed). */
  private emitArea(): void {
    const closed = this.areaClosed && this.area.length >= 3
    this.onAreaChange?.(closed ? this.area.map((p): Pt => [p[0], p[1]]) : null)
  }

  /** Close the in-progress ring: commit it, disarm the tool (so the committed
   *  polygon renders without edit handles), and notify. Re-editing is a fresh
   *  beginArea() away — it keeps the committed ring and re-arms the handles. */
  private closeArea(): void {
    this.areaClosed = true
    this.areaTool = false
    this.areaDragVertex = null
    this.toolCursor = null
    this.canvas.style.cursor = 'default'
    this.render()
    this.emitArea()
  }

  /** Esc while the area tool is armed: cancel an in-progress ring (clear +
   *  disarm), or just disarm when a ring is already committed. */
  private escapeArea(): void {
    if (!this.areaClosed) this.area = []
    this.areaTool = false
    this.areaDragVertex = null
    this.toolCursor = null
    this.canvas.style.cursor = 'default'
    this.render()
  }

  // ---- setup: precompute style buckets so pan/zoom stay cheap ----
  private buildBuckets(d: Drawing) {
    const byKey = new Map<string, StyleBucket>()
    this.texts = []
    for (const e of d.entities) {
      if (e.kind === 'text') {
        this.texts.push(e)
        continue
      }
      const color = e.color ?? CATEGORY_COLOR[e.category] ?? CATEGORY_COLOR.other
      const lw = LINE_WEIGHT[e.category] ?? 1
      const key = `${color}|${lw}`
      let b = byKey.get(key)
      if (!b) {
        b = { color, lw, rank: RANK[e.category] ?? 2, ents: [] }
        byKey.set(key, b)
      }
      b.ents.push(e)
    }
    this.buckets = [...byKey.values()].sort((a, b) => a.rank - b.rank)
  }

  // ---- events ----
  private attach() {
    this.canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    this.canvas.addEventListener('dblclick', this.onDblClick)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('mouseleave', this.onLeave)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKey)
    // DPR-aware container resize.
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.ro = new ResizeObserver(this.onResize)
      this.ro.observe(this.canvas.parentElement)
    }
  }

  private screenFromEvent(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onDown = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.pointerDown = true
    this.didPan = false
    this.movingActive = false
    this.lastScreen = s
    this.downScreen = s
    // Placement mode: never arm a move — a drag pans, a plain click stamps
    // (handled in onUp so panning still works while placing).
    if (this.placing) {
      this.moveCandidate = null
      return
    }
    // Area tool: grabbing a vertex handle arms a drag; empty space stays a pan
    // (a plain click adds a vertex in onUp).
    if (this.areaTool) {
      this.areaDragVertex = this.hitAreaVertex(s.x, s.y)
      this.moveCandidate = null
      return
    }
    // Marker/anchor tool: a plain click drops a pin (in onUp so panning works).
    if (this.markerArm || this.anchorArm) {
      this.moveCandidate = null
      return
    }
    // Scale tool: clicks place the reference-line endpoints (in onUp so a drag
    // still pans the backdrop while positioning).
    if (this.scaleTool) {
      this.moveCandidate = null
      return
    }
    // Hitting a furniture item selects it and arms a MOVE (started once we drag
    // past the threshold). Empty space stays a pan.
    const hit = this.pickFurniture(s.x, s.y)
    this.moveCandidate = hit
    if (hit) {
      if (this.selected !== hit) {
        this.selected = hit
        this.onSelect?.(hit)
      }
      this.lastWorld = this.toWorld(s.x, s.y)
      this.render()
    }
  }

  private onMove = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    if (this.pointerDown) {
      // Area vertex drag: snap-follow the cursor, live-update the ring.
      if (this.areaTool && this.areaDragVertex != null) {
        const { p } = this.snapWorld(s.x, s.y)
        this.area[this.areaDragVertex] = p
        this.lastScreen = s
        this.render()
        if (this.areaClosed) this.emitArea()
        return
      }
      if (
        !this.didPan &&
        !this.movingActive &&
        Math.hypot(s.x - this.downScreen.x, s.y - this.downScreen.y) > DRAG_THRESHOLD
      ) {
        if (this.moveCandidate) {
          this.movingActive = true
          this.pushUndo()
          this.canvas.style.cursor = 'grabbing'
        } else {
          this.didPan = true
        }
      }
      if (this.movingActive && this.moveCandidate) {
        const w = this.toWorld(s.x, s.y)
        this.translateItem(this.moveCandidate, w.x - this.lastWorld.x, w.y - this.lastWorld.y)
        this.lastWorld = w
        this.render()
      } else if (this.didPan) {
        this.offset.x += s.x - this.lastScreen.x
        this.offset.y += s.y - this.lastScreen.y
        this.fitted = false // user took manual control — stop auto-fit on resize
        this.render()
      }
      this.lastScreen = s
      return
    }
    // Placement mode: the ghost tracks the (snapped) cursor; no hover picking.
    if (this.placing) {
      const within = s.x >= 0 && s.y >= 0 && s.x <= this.cssSize().w && s.y <= this.cssSize().h
      const w = this.toWorld(s.x, s.y)
      this.placeCursor = within ? { x: snap(w.x), y: snap(w.y) } : null
      this.canvas.style.cursor = 'crosshair'
      this.render()
      return
    }
    const withinCanvas = s.x >= 0 && s.y >= 0 && s.x <= this.cssSize().w && s.y <= this.cssSize().h
    // Area tool: the next-vertex preview snaps to wall features; hovering a
    // vertex handle shows a grab cursor.
    if (this.areaTool) {
      if (withinCanvas) {
        const { p, snapped } = this.snapWorld(s.x, s.y)
        this.toolCursor = p
        this.toolSnapped = snapped
      } else {
        this.toolCursor = null
      }
      this.canvas.style.cursor = this.hitAreaVertex(s.x, s.y) != null ? 'grab' : 'crosshair'
      this.render()
      return
    }
    // Marker/anchor tool: a pin ghost tracks the cursor (not wall-snapped).
    if (this.markerArm || this.anchorArm) {
      const w = this.toWorld(s.x, s.y)
      this.toolCursor = withinCanvas ? [w.x, w.y] : null
      this.canvas.style.cursor = 'crosshair'
      this.render()
      return
    }
    // Scale tool: the reference line rubber-bands from its first point.
    if (this.scaleTool) {
      const w = this.toWorld(s.x, s.y)
      this.toolCursor = withinCanvas ? [w.x, w.y] : null
      this.canvas.style.cursor = 'crosshair'
      this.render()
      return
    }
    // Hover hit-test only when not dragging.
    const within = s.x >= 0 && s.y >= 0 && s.x <= this.cssSize().w && s.y <= this.cssSize().h
    const hit = within ? this.pickFurniture(s.x, s.y) : null
    this.canvas.style.cursor = hit ? 'move' : 'default'
    if (hit !== this.hovered) {
      this.hovered = hit
      this.onHover?.(hit)
      this.render()
    }
  }

  private onUp = (e: MouseEvent) => {
    if (!this.pointerDown) return
    this.pointerDown = false
    const wasPan = this.didPan
    const wasMoving = this.movingActive
    this.movingActive = false
    this.moveCandidate = null
    this.canvas.style.cursor = 'default'
    if (wasMoving) {
      this.emitChange() // a drag-move committed
      return
    }
    // Area vertex drag committed (a click on a handle that didn't pan).
    if (this.areaTool && this.areaDragVertex != null) {
      this.areaDragVertex = null
      if (this.areaClosed) this.emitArea()
      this.render()
      return
    }
    if (wasPan) return // was a pan, not a click
    // Area tool: add a vertex, or close the ring by clicking the first vertex.
    if (this.areaTool) {
      const s = this.screenFromEvent(e)
      if (!this.areaClosed && this.nearFirstVertex(s.x, s.y)) {
        this.closeArea()
        return
      }
      if (!this.areaClosed) {
        const { p } = this.snapWorld(s.x, s.y)
        this.area.push(p)
        this.render()
      }
      return
    }
    // Marker tool: drop a pin at the click point; the owner assigns id/ref.
    if (this.markerArm) {
      const s = this.screenFromEvent(e)
      const w = this.toWorld(s.x, s.y)
      this.onMarkerDrop?.(w.x, w.y)
      return
    }
    // Anchor tool: drop a pin at the click point; the owner assigns id/kind.
    if (this.anchorArm) {
      const s = this.screenFromEvent(e)
      const w = this.toWorld(s.x, s.y)
      this.onAnchorDrop?.(w.x, w.y)
      return
    }
    // Scale tool: first click sets the reference line's start, second click
    // completes it — measure its world length + let the owner enter the real one.
    if (this.scaleTool) {
      const s = this.screenFromEvent(e)
      const w = this.toWorld(s.x, s.y)
      if (!this.scaleFirst) {
        this.scaleFirst = [w.x, w.y]
        this.scaleLine = null
        this.render()
      } else {
        this.scaleLine = [this.scaleFirst, [w.x, w.y]]
        this.scaleFirst = null
        this.scaleTool = false // line is placed; owner now asks for its length
        this.canvas.style.cursor = 'default'
        this.render()
        const len = Math.hypot(
          this.scaleLine[1][0] - this.scaleLine[0][0],
          this.scaleLine[1][1] - this.scaleLine[0][1],
        )
        this.onScaleReady?.(len)
      }
      return
    }
    // Placement mode: a plain click stamps the armed spec at the snapped point.
    if (this.placing) {
      const s = this.screenFromEvent(e)
      const w = this.toWorld(s.x, s.y)
      this.placeAt(snap(w.x), snap(w.y))
      return
    }
    // Plain click: (de)select the item under the cursor.
    const s = this.screenFromEvent(e)
    const hit = this.pickFurniture(s.x, s.y)
    if (hit !== this.selected) {
      this.selected = hit
      this.onSelect?.(hit)
    }
    this.render()
  }

  private onLeave = () => {
    if (this.placing && this.placeCursor) {
      this.placeCursor = null
      this.render()
    }
    if ((this.areaTool || this.markerArm || this.scaleTool) && this.toolCursor) {
      this.toolCursor = null
      this.render()
    }
    if (this.hovered) {
      this.hovered = null
      this.onHover?.(null)
      this.render()
    }
  }

  /** Double-click closes the in-progress area ring (dropping the redundant
   *  vertex the two constituent clicks added). */
  private onDblClick = (e: MouseEvent) => {
    if (!this.areaTool || this.areaClosed) return
    e.preventDefault()
    if (this.area.length > 3) this.area.pop() // the dblclick's second click
    if (this.area.length >= 3) this.closeArea()
    else this.render()
  }

  // ---- keyboard: rotate / delete / duplicate / undo ----
  private onKey = (e: KeyboardEvent) => {
    if (!this.drawing) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    // Area tool: Enter/Escape close/cancel the ring, Backspace drops the last
    // vertex. Handled before the furniture shortcuts so they don't clash.
    if (this.areaTool && !mod) {
      if (key === 'escape') {
        e.preventDefault()
        this.escapeArea()
        return
      }
      if (key === 'enter') {
        e.preventDefault()
        if (!this.areaClosed && this.area.length >= 3) this.closeArea()
        return
      }
      if ((key === 'backspace' || key === 'delete') && !this.areaClosed && this.area.length > 0) {
        e.preventDefault()
        this.area.pop()
        this.render()
        return
      }
    }
    if ((this.markerArm || this.anchorArm) && !mod && key === 'escape') {
      e.preventDefault()
      this.cancelTool()
      return
    }
    // Scale tool: Escape cancels the reference line (drops any first point).
    if (this.scaleTool && !mod && key === 'escape') {
      e.preventDefault()
      this.cancelTool()
      return
    }
    // Placement mode: Escape exits, R spins the ghost (Shift+R reverses —
    // the same convention as rotating a selected item). ⌘Z etc. fall through.
    if (this.placing && !mod) {
      if (key === 'escape') {
        e.preventDefault()
        this.cancelPlace()
        return
      }
      if (key === 'r') {
        e.preventDefault()
        this.placeRotation += e.shiftKey ? -ROTATE_STEP : ROTATE_STEP
        this.render()
        return
      }
    }
    if (mod && key === 'z') {
      e.preventDefault()
      this.undo()
      return
    }
    if (mod && key === 'd') {
      e.preventDefault()
      this.duplicateSelected()
      return
    }
    if (mod) return // leave other browser shortcuts alone
    if (!this.selected) return
    if (key === 'r') {
      e.preventDefault()
      this.rotateSelected(e.shiftKey ? -ROTATE_STEP : ROTATE_STEP)
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault()
      this.deleteSelected()
    }
  }

  // ---- edit operations (each snapshots for undo, mutates, re-renders, onChange) ----
  private rotateSelected(angle: number) {
    if (!this.selected) return
    this.pushUndo()
    this.rotateItem(this.selected, angle)
    this.render()
    this.emitChange()
  }

  private deleteSelected() {
    const d = this.drawing
    if (!d || !this.selected) return
    this.pushUndo()
    const i = d.furniture.indexOf(this.selected)
    if (i >= 0) d.furniture.splice(i, 1)
    this.selected = null
    this.hovered = null
    this.onSelect?.(null)
    this.render()
    this.emitChange()
  }

  private duplicateSelected() {
    const d = this.drawing
    if (!d || !this.selected) return
    this.pushUndo()
    const clone = structuredClone(this.selected)
    clone.id = this.nextItemId()
    this.translateItem(clone, DUP_OFFSET, -DUP_OFFSET)
    d.furniture.push(clone)
    this.selected = clone
    this.onSelect?.(clone)
    this.render()
    this.emitChange()
  }

  /** Next free numeric item id (ids are unique; names may repeat for dupes). */
  private nextItemId(): number {
    return (this.drawing?.furniture ?? []).reduce((m, f) => Math.max(m, f.id), 0) + 1
  }

  /** `base`, or `base 2`, `base 3`, … — first name not already in the schedule.
   *  Sidebar pick + category rows key items by NAME, so a placed item gets its
   *  own name rather than silently aggregating into an imported row. */
  private uniqueItemName(base: string): string {
    const names = new Set((this.drawing?.furniture ?? []).map((f) => f.name))
    if (!names.has(base)) return base
    let n = 2
    while (names.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  /** Stamp the armed {@link PlaceSpec} centered at world (cx, cy) — one undo
   *  entry, select the new item, keep placement mode armed for the next click. */
  private placeAt(cx: number, cy: number) {
    const d = this.drawing
    const spec = this.placing
    if (!d || !spec) return
    this.pushUndo()
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
      id: this.nextItemId(),
      name: this.uniqueItemName(spec.name),
      raw: spec.name,
      category,
      bbox: [cx - hw, cy - hh, cx + hw, cy + hh],
      origin: [cx, cy],
      rotation: 0,
      entities: [outline, tick],
    }
    if (this.placeRotation !== 0) this.rotateItem(item, this.placeRotation)
    d.furniture.push(item)
    this.selected = item
    this.onSelect?.(item)
    this.canvas.style.cursor = 'crosshair' // stay armed for the next stamp
    this.render()
    this.emitChange()
  }

  /** Translate one item (origin, all entity geometry, and bbox) by a world delta. */
  private translateItem(it: FurnitureItem, dx: number, dy: number) {
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
  private rotateItem(it: FurnitureItem, angle: number) {
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
    this.recomputeBbox(it)
  }

  /** Recompute an item's axis-aligned bbox from its (already-transformed) geometry. */
  private recomputeBbox(it: FurnitureItem) {
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

  private pushUndo() {
    if (!this.drawing) return
    this.undoStack.push(structuredClone(this.drawing.furniture))
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift()
  }

  private emitChange() {
    if (this.drawing) this.onChange?.(this.drawing)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const s = this.screenFromEvent(e)
    const before = this.toWorld(s.x, s.y)
    const factor = Math.exp(-e.deltaY * 0.0015)
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE)
    // Keep the world point under the cursor fixed (Y flipped).
    this.offset.x = s.x - before.x * this.scale
    this.offset.y = s.y + before.y * this.scale
    this.fitted = false // user zoomed — stop auto-fit on resize
    this.render()
  }

  // Container/window resize: re-measure the backing store, then RE-FIT (so the
  // plan keeps filling the box) while still at the fitted framing, else repaint
  // preserving the user's pan/zoom. Shared by the window listener + the
  // ResizeObserver on the container (the RO catches box changes the window
  // event misses — e.g. a vh-sized preview or a layout reflow).
  private onResize = () => {
    if (!this.resize()) return
    if (this.fitted) this.fitToView()
    else this.render()
  }

  /** Size the backing store to the container × DPR. Returns true iff the pixel
   *  dimensions actually changed (so callers can skip redundant refits). */
  private resize(): boolean {
    const parent = this.canvas.parentElement
    if (!parent) return false
    const rect = parent.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false // hidden
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    const w = Math.floor(rect.width * this.dpr)
    const h = Math.floor(rect.height * this.dpr)
    if (w === this.canvas.width && h === this.canvas.height) return false
    this.canvas.width = w
    this.canvas.height = h
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    return true
  }

  // ---- furniture hit-test (topmost by draw order) ----
  private pickFurniture(sx: number, sy: number): FurnitureItem | null {
    const d = this.drawing
    if (!d) return null
    const w = this.toWorld(sx, sy)
    for (let i = d.furniture.length - 1; i >= 0; i--) {
      const it = d.furniture[i]
      const [minX, minY, maxX, maxY] = it.bbox
      if (w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY) return it
    }
    return null
  }

  // ---- rendering ----
  private render() {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const { w, h } = this.cssSize()
    if (w === 0 || h === 0) return

    ctx.fillStyle = MAT
    ctx.fillRect(0, 0, w, h)

    const d = this.drawing
    if (!d) return

    // White floor plate over the drawing bounds (Rayon/Revit look).
    const [minX, minY, maxX, maxY] = d.bounds
    const p0 = this.toScreen(minX, maxY) // top-left on screen (maxY = top)
    const p1 = this.toScreen(maxX, minY) // bottom-right
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)

    // Raster backdrop under the linework: draw the image across its world rect
    // (image top → world top; no flip since we map top-to-top). Slightly faded
    // so drawn overlays (area ring, reference line) read clearly over it.
    if (this.backdrop) {
      const [bx0, by0, bx1, by1] = backdropBounds(this.backdrop)
      const tl = this.toScreen(bx0, by1)
      const br = this.toScreen(bx1, by0)
      ctx.save()
      ctx.globalAlpha = 0.92
      ctx.imageSmoothingEnabled = true
      try {
        ctx.drawImage(this.backdrop.image, tl.x, tl.y, br.x - tl.x, br.y - tl.y)
      } catch {
        /* image not yet decodable — skip this frame */
      }
      ctx.restore()
    }

    // Style-batched linework: architecture buckets, with furniture woven in at
    // its rank so walls/glazing/doors sit on top.
    let furnitureDrawn = false
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const b of this.buckets) {
      if (!furnitureDrawn && b.rank >= FURNITURE_RANK) {
        this.drawFurniture(d)
        furnitureDrawn = true
      }
      ctx.strokeStyle = b.color
      ctx.lineWidth = b.lw
      ctx.beginPath()
      for (const e of b.ents) this.appendEntity(e)
      ctx.stroke()
    }
    if (!furnitureDrawn) this.drawFurniture(d)

    this.drawTexts(d)
    this.drawHighlights()
    this.drawPlaceGhost()
    this.drawArea()
    this.drawMarkers()
    this.drawAnchors()
    this.drawScaleLine()
    this.onViewChange?.()
  }

  /** Scale reference line: the placed line (solid amber, endpoint ticks + a
   *  live length label), or the in-progress rubber-band from the first click to
   *  the cursor (dashed). Drawn on top so it reads over the backdrop. */
  private drawScaleLine(): void {
    const ctx = this.ctx
    let a: Pt | null = null
    let b: Pt | null = null
    if (this.scaleLine) {
      a = this.scaleLine[0]
      b = this.scaleLine[1]
    } else if (this.scaleTool && this.scaleFirst && this.toolCursor) {
      a = this.scaleFirst
      b = this.toolCursor
    } else if (this.scaleTool && this.scaleFirst) {
      const p = this.toScreen(this.scaleFirst[0], this.scaleFirst[1])
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    if (!a || !b) return
    const pa = this.toScreen(a[0], a[1])
    const pb = this.toScreen(b[0], b[1])
    ctx.save()
    ctx.strokeStyle = ACCENT
    ctx.fillStyle = ACCENT
    ctx.lineWidth = 2
    ctx.setLineDash(this.scaleLine ? [] : [6, 4])
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
    ctx.setLineDash([])
    // Perpendicular end ticks.
    const dx = pb.x - pa.x
    const dy = pb.y - pa.y
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * 6
    const ny = (dx / len) * 6
    ctx.beginPath()
    ctx.moveTo(pa.x - nx, pa.y - ny)
    ctx.lineTo(pa.x + nx, pa.y + ny)
    ctx.moveTo(pb.x - nx, pb.y - ny)
    ctx.lineTo(pb.x + nx, pb.y + ny)
    ctx.stroke()
    // Length label at the midpoint.
    const lenM = Math.hypot(b[0] - a[0], b[1] - a[1])
    const text = `${lenM.toFixed(2)} m`
    ctx.font = '11px ui-monospace, monospace'
    const tw = ctx.measureText(text).width
    const mx = (pa.x + pb.x) / 2
    const my = (pa.y + pb.y) / 2
    ctx.fillStyle = 'rgba(20,24,33,0.85)'
    ctx.fillRect(mx - tw / 2 - 4, my - 9, tw + 8, 16)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, mx, my)
    ctx.restore()
  }

  /** Area-select overlay: a committed ring dims everything outside it (even-odd
   *  mask) and draws its outline + editable vertex handles; an in-progress ring
   *  draws the dashed partial polyline with a live preview segment to the
   *  snapped cursor. */
  private drawArea() {
    const ctx = this.ctx
    const pts = this.area
    if (pts.length === 0 && !(this.areaTool && this.toolCursor)) return
    const scr = pts.map((p) => this.toScreen(p[0], p[1]))

    if (this.areaClosed && scr.length >= 3) {
      const { w, h } = this.cssSize()
      // Dim OUTSIDE the ring: full-canvas rect with the polygon as an even-odd hole.
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, w, h)
      ctx.moveTo(scr[0].x, scr[0].y)
      for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
      ctx.closePath()
      ctx.fillStyle = AREA_MASK
      ctx.fill('evenodd')
      ctx.restore()
      // Ring outline + faint inside wash.
      ctx.beginPath()
      ctx.moveTo(scr[0].x, scr[0].y)
      for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
      ctx.closePath()
      ctx.fillStyle = AREA_FILL
      ctx.fill()
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.6
      ctx.stroke()
      if (this.areaTool) this.drawAreaHandles(scr)
      return
    }

    if (this.areaTool && scr.length > 0) {
      ctx.beginPath()
      ctx.moveTo(scr[0].x, scr[0].y)
      for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
      if (this.toolCursor) {
        const c = this.toScreen(this.toolCursor[0], this.toolCursor[1])
        ctx.lineTo(c.x, c.y)
      }
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.6
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      this.drawAreaHandles(scr)
    } else if (this.areaTool && this.toolCursor) {
      // No vertices yet — just show the snapped crosshair dot.
      const c = this.toScreen(this.toolCursor[0], this.toolCursor[1])
      ctx.fillStyle = this.toolSnapped ? ACCENT : HOVER
      ctx.beginPath()
      ctx.arc(c.x, c.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  /** Draw the area vertex handles; the first vertex gets a ring (close target). */
  private drawAreaHandles(scr: { x: number; y: number }[]) {
    const ctx = this.ctx
    ctx.fillStyle = ACCENT
    for (let i = 0; i < scr.length; i++) {
      ctx.fillRect(
        Math.round(scr[i].x) - AREA_VERTEX_PX,
        Math.round(scr[i].y) - AREA_VERTEX_PX,
        AREA_VERTEX_PX * 2,
        AREA_VERTEX_PX * 2,
      )
    }
    if (!this.areaClosed && scr.length >= 3) {
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.arc(scr[0].x, scr[0].y, AREA_CLOSE_PX, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  /** Room markers: a numbered pin per marker, plus a ghost pin for the armed
   *  (not-yet-dropped) marker under the cursor. */
  private drawMarkers() {
    if (this.markerArm && this.toolCursor) {
      this.drawPin(this.toScreen(this.toolCursor[0], this.toolCursor[1]), this.markerArm.ref, true)
    }
    for (const m of this.markers) {
      this.drawPin(this.toScreen(m.x, m.y), m.ref, false)
    }
  }

  /** Anchor pins: a blue diamond per pin, plus a ghost diamond under the cursor
   *  while the tool is armed — visually distinct from the round §3.2 markers. */
  private drawAnchors() {
    if (this.anchorArm && this.toolCursor) {
      this.drawAnchorPin(this.toScreen(this.toolCursor[0], this.toolCursor[1]), this.anchorArm.label, true)
    }
    for (const a of this.anchors) {
      this.drawAnchorPin(this.toScreen(a.x, a.y), a.label, false)
    }
  }

  /** One anchor pin: a blue diamond + a short room-kind label to its right. */
  private drawAnchorPin(p: { x: number; y: number }, label: string, ghost: boolean) {
    const ctx = this.ctx
    const r = ANCHOR_R_PX
    ctx.save()
    ctx.globalAlpha = ghost ? 0.55 : 1
    ctx.beginPath()
    ctx.moveTo(p.x, p.y - r)
    ctx.lineTo(p.x + r, p.y)
    ctx.lineTo(p.x, p.y + r)
    ctx.lineTo(p.x - r, p.y)
    ctx.closePath()
    ctx.fillStyle = ANCHOR_COLOR
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    // A short label beside the pin so the plan reads which room is forced where.
    ctx.fillStyle = '#e8edf2'
    ctx.font = '600 10px "Space Grotesk", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, p.x + r + 3, p.y)
    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  /** One pin: an amber disc with the ref number, optionally translucent (ghost). */
  private drawPin(p: { x: number; y: number }, ref: string, ghost: boolean) {
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = ghost ? 0.55 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, MARKER_R_PX, 0, Math.PI * 2)
    ctx.fillStyle = ACCENT
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#1a1d21'
    ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(ref.slice(0, 4), p.x, p.y + 0.5)
    ctx.restore()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  /** Placement ghost: dashed amber footprint (rotated), soft wash, center
   *  cross, and a mono dims label — follows the snapped cursor. */
  private drawPlaceGhost() {
    const spec = this.placing
    const c = this.placeCursor
    if (!spec || !c) return
    const ctx = this.ctx
    const hw = spec.w / 2
    const hh = spec.h / 2
    const cos = Math.cos(this.placeRotation)
    const sin = Math.sin(this.placeRotation)
    const corner = (dx: number, dy: number) =>
      this.toScreen(c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos)
    const pts = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)]
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.fillStyle = PLACE_FILL
    ctx.fill()
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.4
    ctx.setLineDash([5, 4])
    ctx.stroke()
    ctx.setLineDash([])
    // center cross
    const p = this.toScreen(c.x, c.y)
    ctx.beginPath()
    ctx.moveTo(p.x - 5, p.y)
    ctx.lineTo(p.x + 5, p.y)
    ctx.moveTo(p.x, p.y - 5)
    ctx.lineTo(p.x, p.y + 5)
    ctx.lineWidth = 1
    ctx.stroke()
    // dims label under the footprint
    const bottom = Math.max(...pts.map((q) => q.y))
    ctx.fillStyle = ACCENT
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(`${spec.w.toFixed(2)} × ${spec.h.toFixed(2)} m`, p.x, bottom + 6)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  /** Imported furniture, rendered as CANONICAL top-view symbols (the same
   *  `drawFurnitureSymbol` vocabulary the generator emits) instead of raw DWG
   *  linework — so a freshly imported plan reads identically to a generated or
   *  merged fit: clean Desk/Chair/Table/Door/Window glyphs, no vendor-block
   *  clutter. Unbound pieces are gray; bound ("specified") pieces are data-blue
   *  so a re-imagined item still reads distinctly. */
  private drawFurniture(d: Drawing) {
    for (const it of d.furniture) {
      if (it.productId) this.drawItemSymbol(it, SPECIFIED, SPECIFIED_DETAIL, false)
      else this.drawItemSymbol(it, FURNITURE_LINE, FURNITURE_DETAIL, false)
    }
  }

  /** Draw one imported furniture item as its canonical symbol. Reuses the exact
   *  `normalizeFurniture` mapping the merge path uses (mergeFit.ts) so the imported
   *  view and the merged result share one vocabulary: the piece is stamped at its
   *  bbox center. A DIRECTIONAL symbol (a Desk's monitor/chair, a Chair's backrest)
   *  must FACE the way the source block did — but normalize's axis-aligned `w/h`
   *  only carries landscape-vs-portrait, not the flip/turn, so drawing every symbol
   *  upright pointed ~35% of the sample's desks the wrong way. We fix that with
   *  `norm.rotation` (cardinal, world-CCW): un-swap `w/h` back to the block's NATURAL
   *  (pre-rotation) footprint — `odd ? [h,w] : [w,h]` — then rotate by −rotation
   *  (world CCW → screen CW under the Y-flip). This reproduces the same on-screen
   *  extent as the bbox while facing correctly, and it does NOT double-rotate: the
   *  un-swap removes the aspect the rotation re-applies. An unknown category falls
   *  to `drawSymbol`'s neutral rounded outline, never raw linework.
   *
   *  Uses the SAME symbol module + the same `fill`/`seat` inks as the editor
   *  canvas, so one desk looks like itself on both surfaces. It previously
   *  passed neither fill, which is why imported furniture rendered as hollow
   *  outlines here and as filled objects in the editor — crossing the Space →
   *  editor boundary looked like crossing into a different application. */
  private drawItemSymbol(it: FurnitureItem, stroke: string, detail: string, selected: boolean) {
    const norm = normalizeFurniture(it)
    // Skip degenerate/NaN footprints so we never emit NaN paths or 0-size garbage.
    if (!(norm.w > 0) || !(norm.h > 0)) return
    const c = this.toScreen((it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2)
    // Un-swap the aspect-baked footprint back to natural, then let the rotation
    // orient both footprint and symbol together (see normalize's rotation contract).
    const odd = Math.round(norm.rotation / (Math.PI / 2)) % 2 !== 0
    const nw = odd ? norm.h : norm.w
    const nh = odd ? norm.w : norm.h
    drawSymbol(
      this.ctx,
      {
        category: norm.category,
        cx: c.x,
        cy: c.y,
        w: nw, // METRES — the symbol module owns the world→screen conversion
        h: nh,
        rotation: -norm.rotation, // world CCW → screen CW (Y-flip)
        mirror: norm.mirror, // door hinge hand (recovered from the swing arc)
        // Seat count from the object's world size (the same rule the core uses),
        // never from its size on screen.
        seats: seatsForSize(norm.category, nw, nh),
        selected,
      },
      { stroke, detail, fill: FURNITURE_FILL, seat: FURNITURE_SEAT, accent: ACCENT },
      { pxPerM: this.scale, dpr: this.dpr },
    )
  }

  private drawTexts(d: Drawing) {
    const ctx = this.ctx
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    for (const e of this.texts) {
      if (!e.text || e.tx === undefined || e.ty === undefined) continue
      const px = (e.h ?? 0.2) * this.scale
      if (px < TEXT_MIN_PX) continue // too small to be legible; skip for clarity + perf
      const p = this.toScreen(e.tx, e.ty)
      ctx.save()
      ctx.translate(p.x, p.y)
      if (e.rot) ctx.rotate(-e.rot) // world CCW → screen CW
      ctx.fillStyle = e.color ?? CATEGORY_COLOR[e.category] ?? '#9aa2ad'
      ctx.font = `${px.toFixed(1)}px "IBM Plex Mono", ui-monospace, monospace`
      ctx.fillText(e.text, 0, 0)
      ctx.restore()
    }
    void d
  }

  /** Hovered (soft amber wash) + selected (amber halo + crisp outline + bbox). */
  private drawHighlights() {
    const ctx = this.ctx
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (this.hovered && this.hovered !== this.selected) {
      // soft amber wash over the canonical symbol so a hovered item reads as
      // "pickable" (redrawn as its symbol, not raw linework — the body is a
      // clean glyph now).
      this.drawItemSymbol(this.hovered, HOVER, HOVER, false)
    }
    if (this.selected) {
      const [minX, minY, maxX, maxY] = this.selected.bbox
      const a = this.toScreen(minX, maxY) // top-left (maxY = top)
      const b = this.toScreen(maxX, minY) // bottom-right
      // 1) translucent halo over the footprint — makes the selection glow over
      //    dense plans (the raw bbox extent, so it hugs the true footprint).
      ctx.strokeStyle = ACCENT_HALO
      ctx.lineWidth = 4
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
      // 2) the canonical symbol redrawn in crisp amber
      this.drawItemSymbol(this.selected, ACCENT, ACCENT, true)
      // 3) dashed bbox + solid corner handles
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1)
      ctx.setLineDash([])
      ctx.fillStyle = ACCENT
      for (const [hx, hy] of [
        [a.x, a.y],
        [b.x, a.y],
        [a.x, b.y],
        [b.x, b.y],
      ]) {
        ctx.fillRect(
          Math.round(hx) - HANDLE_PX,
          Math.round(hy) - HANDLE_PX,
          HANDLE_PX * 2,
          HANDLE_PX * 2,
        )
      }
    }
  }

  /**
   * Append one entity's geometry to the CURRENT path (caller sets style +
   * begins/strokes the path). Each subpath is self-contained (moveTo first) so
   * many entities batch into a single stroke().
   */
  private appendEntity(e: DrawEntity) {
    const ctx = this.ctx
    if (e.kind === 'polyline') {
      const pts = e.pts
      if (!pts || pts.length === 0) return
      const first = this.toScreen(pts[0][0], pts[0][1])
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < pts.length; i++) {
        const p = this.toScreen(pts[i][0], pts[i][1])
        ctx.lineTo(p.x, p.y)
      }
      if (e.closed) ctx.lineTo(first.x, first.y)
    } else if (e.kind === 'circle') {
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
      const c = this.toScreen(e.cx, e.cy)
      const rPx = e.r * this.scale
      ctx.moveTo(c.x + rPx, c.y)
      ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2)
    } else if (e.kind === 'arc') {
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
      const c = this.toScreen(e.cx, e.cy)
      const rPx = e.r * this.scale
      const a0 = -(e.start ?? 0) // world CCW → screen (Y flipped)
      const a1 = -(e.end ?? Math.PI * 2)
      ctx.moveTo(c.x + rPx * Math.cos(a0), c.y + rPx * Math.sin(a0))
      ctx.arc(c.x, c.y, rPx, a0, a1, true)
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Snap a world coordinate to the placement grid (0.05 m). */
function snap(v: number): number {
  return Math.round(v / PLACE_SNAP) * PLACE_SNAP
}
