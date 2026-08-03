import type { Drawing, FurnitureItem } from './types'
import { collectWallSegments, type Pt } from './testfit'
import type { RoomMarker, RoomType } from './markers'
import type { Backdrop } from './rasterImport'
import { backdropBounds } from './rasterImport'
import type { PlaceSpec } from '../types/cad'
import {
  buildBuckets,
  createScene,
  fitScene,
  resetScene,
  resizeBacking,
  toScreen,
  type DrawingEvents,
  type DrawingScene,
} from './drawingScene'
import { renderScene } from './drawingRender'
import { undoEdit } from './drawingEdit'
import {
  cancelPlace as cancelPlaceTool,
  cancelTool as cancelToolState,
  disarmForTool,
  dropSelection,
  handleDblClick,
  handleDown,
  handleKey,
  handleLeave,
  handleMove,
  handleUp,
  handleWheel,
} from './drawingInput'

// PlaceSpec now lives with the rest of the CAD type vocabulary; re-exported here
// so `import type { PlaceSpec } from './DrawingCanvas'` keeps working.
export type { PlaceSpec }

/**
 * Framework-agnostic CAD renderer for an imported {@link Drawing}. Renders
 * real architectural linework (walls, glazing, doors, casework, annotation) at
 * CAD fidelity plus selectable furniture blocks. Mirrors the light "floor-plate"
 * aesthetic of {@link ../editor/EditorCanvas} (white plate on #f2f4f7 mat, thin
 * dark walls) with pan/zoom/DPR handling.
 *
 * This class is the PUBLIC FAÇADE: it owns the canvas element, the DOM listener
 * lifetime and one {@link DrawingScene}, and delegates the work to three focused
 * collaborators — `drawingRender.ts` (paint), `drawingEdit.ts` (furniture
 * mutation + undo) and `drawingInput.ts` (pointer/keyboard + tool state
 * machines). Coordinate conventions live in `drawingScene.ts`.
 */
export class DrawingCanvas implements DrawingEvents {
  // ---- observable surface (assignable public fields; the scene holds a live
  //      reference to `this`, so a reassignment takes effect immediately) ----

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

  private readonly s: DrawingScene
  private ro: ResizeObserver | null = null

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.s = createScene(canvas, ctx, this)
    this.attach()
    this.resize()
    this.render()
  }

  // ---- public API ----

  /** Store a drawing, precompute style buckets, frame it, and render. */
  setDrawing(d: Drawing): void {
    this.s.drawing = d
    // A fresh drawing clears selection/undo and any prior area/markers/backdrop;
    // the owner re-applies the persisted ones via setArea/setMarkers after this.
    resetScene(this.s)
    // Precompute adaptive-snap targets: wall/glazing endpoints and segments.
    this.s.snapSegs = collectWallSegments(d)
    this.s.snapPoints = []
    for (const [a, b] of this.s.snapSegs) this.s.snapPoints.push(a, b)
    buildBuckets(this.s, d)
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
    const d = this.s.drawing
    if (!d || !d.furniture.includes(item)) return null
    const [minX, , maxX, maxY] = item.bbox
    return toScreen(this.s, (minX + maxX) / 2, maxY) // world Y-up: maxY is the top
  }

  /** Programmatically select an item (sidebar pick, tests) — keeps the
   *  canvas's internal selection in sync with React so highlight, anchor and
   *  clearSelection behave exactly as a canvas click would. */
  select(item: FurnitureItem): void {
    if (!this.s.drawing?.furniture.includes(item)) return
    this.cancelPlace() // a sidebar pick disarms a pending placement
    this.s.selected = item
    this.onSelect?.(item)
    this.render()
  }

  /** Clear the current selection (e.g. the selection card's close button).
   *  Always notifies — React may hold a selection the canvas never saw. */
  clearSelection(): void {
    this.s.selected = null
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
    if (!this.s.drawing || !(spec.w > 0) || !(spec.h > 0)) return
    // Disarm the area/marker/anchor/scale tools (committed polygon + pins are kept).
    this.s.areaTool = false
    this.s.markerArm = null
    this.s.anchorArm = null
    this.s.scaleTool = false
    this.s.scaleFirst = null
    this.s.areaDragVertex = null
    this.s.placing = spec
    this.s.placeCursor = null
    this.s.placeRotation = 0
    this.s.hovered = null
    dropSelection(this.s)
    this.s.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Exit placement mode without placing (Escape does the same). */
  cancelPlace(): void {
    cancelPlaceTool(this.s)
  }

  isPlacing(): boolean {
    return this.s.placing !== null
  }

  // ---- area-select tool (workflow.md §3.1) ----

  /** Arm the area tool. If a committed polygon exists it becomes editable
   *  (drag vertices); otherwise a fresh ring is started. Click to add vertices,
   *  click the first vertex (or double-click / Enter) to close, Backspace drops
   *  the last, Esc cancels. Disarms placement + marker modes. */
  beginArea(): void {
    disarmForTool(this.s)
    this.s.areaTool = true
    if (!this.s.areaClosed) this.s.area = []
    dropSelection(this.s)
    this.s.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Clear the committed/in-progress polygon and notify (restores full plan). */
  clearArea(): void {
    this.s.area = []
    this.s.areaClosed = false
    this.s.areaDragVertex = null
    this.s.toolCursor = null
    this.render()
    this.onAreaChange?.(null)
  }

  /** Load a persisted polygon (committed) without firing onAreaChange. */
  setArea(polygon: Pt[] | null): void {
    if (polygon && polygon.length >= 3) {
      this.s.area = polygon.map((p): Pt => [p[0], p[1]])
      this.s.areaClosed = true
    } else {
      this.s.area = []
      this.s.areaClosed = false
    }
    this.s.areaDragVertex = null
    this.render()
  }

  isAreaTool(): boolean {
    return this.s.areaTool
  }

  // ---- room-marker tool (workflow.md §3.2) ----

  /** Arm the marker tool: the next click drops a pin of `type`/`ref`. Stays
   *  disarmed after — the owner re-arms with the next ref in onMarkerDrop. */
  beginMarkerPlace(type: RoomType, ref: string): void {
    disarmForTool(this.s)
    this.s.markerArm = { type, ref }
    dropSelection(this.s)
    this.s.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Load the persisted markers to render as pins. */
  setMarkers(markers: RoomMarker[]): void {
    this.s.markers = markers.map((m) => ({ ...m }))
    this.render()
  }

  // ---- anchor-pin tool (workflow.md §3.5) ----

  /** Arm the anchor tool: the next click drops a pin forcing a room of `label`'s
   *  kind onto the plan. Stays disarmed after — the owner re-arms in onAnchorDrop
   *  (same one-shot pattern as the marker tool). */
  beginAnchorPlace(label: string): void {
    disarmForTool(this.s)
    this.s.anchorArm = { label }
    dropSelection(this.s)
    this.s.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Load the persisted anchor pins to render as diamonds. */
  setAnchors(anchors: { x: number; y: number; label: string }[]): void {
    this.s.anchors = anchors.map((a) => ({ ...a }))
    this.render()
  }

  // ---- raster backdrop + scale calibration (rasterImport.ts) ----

  /** Attach (or clear) a raster underlay. The drawing bounds are kept in sync
   *  with the backdrop's world rect so fit/plate tracing frame it correctly. */
  setBackdrop(b: Backdrop | null): void {
    this.s.backdrop = b
    this.s.scaleLine = null
    this.s.scaleFirst = null
    if (b && this.s.drawing) this.s.drawing.bounds = backdropBounds(b)
    this.fitToView()
  }

  hasBackdrop(): boolean {
    return this.s.backdrop !== null
  }

  /** Arm the scale tool: click two points over a known dimension to lay a
   *  reference line; completing it fires onScaleReady with its world length. */
  beginScale(): void {
    disarmForTool(this.s)
    this.s.scaleTool = true
    dropSelection(this.s)
    this.s.canvas.style.cursor = 'crosshair'
    this.render()
  }

  /** Recalibrate the backdrop so the pending reference line equals `realMeters`.
   *  Rescales meters-per-pixel, reframes, clears the line, and disarms the tool. */
  applyScale(realMeters: number): void {
    const b = this.s.backdrop
    const line = this.s.scaleLine
    if (!b || !line || !(realMeters > 0)) return
    const worldLen = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1])
    if (!(worldLen > 1e-6)) return
    b.mpp *= realMeters / worldLen
    if (this.s.drawing) {
      this.s.drawing.bounds = backdropBounds(b)
    }
    this.s.scaleTool = false
    this.s.scaleFirst = null
    this.s.scaleLine = null
    this.s.canvas.style.cursor = 'default'
    this.fitToView()
    this.onScaleChange?.(b.mpp)
  }

  /** Disarm the area, marker, anchor and scale tools (keeps committed pins/polygon). */
  cancelTool(): void {
    cancelToolState(this.s)
  }

  /** Restore the last pre-edit snapshot of the furniture. No-op if nothing to undo. */
  undo(): void {
    undoEdit(this.s)
  }

  canUndo(): boolean {
    return this.s.undoStack.length > 0
  }

  /** Frame `drawing.bounds` in the viewport with padding. */
  fitToView(): void {
    fitScene(this.s)
    this.render()
  }

  dispose(): void {
    this.ro?.disconnect()
    this.ro = null
    const canvas = this.s.canvas
    canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    canvas.removeEventListener('dblclick', this.onDblClick)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('mouseleave', this.onLeave)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
  }

  // ---- DOM plumbing ----

  private attach() {
    const canvas = this.s.canvas
    canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    canvas.addEventListener('dblclick', this.onDblClick)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('mouseleave', this.onLeave)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKey)
    // DPR-aware container resize.
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this.ro = new ResizeObserver(this.onResize)
      this.ro.observe(canvas.parentElement)
    }
  }

  private onDown = (e: MouseEvent) => handleDown(this.s, e)
  private onMove = (e: MouseEvent) => handleMove(this.s, e)
  private onUp = (e: MouseEvent) => handleUp(this.s, e)
  private onLeave = () => handleLeave(this.s)
  private onDblClick = (e: MouseEvent) => handleDblClick(this.s, e)
  private onKey = (e: KeyboardEvent) => handleKey(this.s, e)
  private onWheel = (e: WheelEvent) => handleWheel(this.s, e)

  // Container/window resize: re-measure the backing store, then RE-FIT (so the
  // plan keeps filling the box) while still at the fitted framing, else repaint
  // preserving the user's pan/zoom. Shared by the window listener + the
  // ResizeObserver on the container (the RO catches box changes the window
  // event misses — e.g. a vh-sized preview or a layout reflow).
  private onResize = () => {
    if (!this.resize()) return
    if (this.s.fitted) this.fitToView()
    else this.render()
  }

  private resize(): boolean {
    return resizeBacking(this.s)
  }

  private render(): void {
    renderScene(this.s)
  }
}
