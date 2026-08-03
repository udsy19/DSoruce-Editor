// The state the imported-drawing canvas renders and edits, plus the palette,
// transforms and framing that every part of it shares.
//
// `DrawingCanvas` (the public façade) owns one {@link DrawingScene} and hands it
// to the three collaborator modules:
//   drawingRender.ts — paints the scene
//   drawingEdit.ts   — mutates the drawing's furniture (+ undo)
//   drawingInput.ts  — pointer/keyboard dispatch and the place/area/marker/
//                      anchor/scale tool state machines
//
// This module is the LEAF of that graph: it imports no sibling, so the chain
// scene → render → edit → input stays acyclic.
//
// ── Coordinates ───────────────────────────────────────────────────────────
// The Drawing is in METERS, world-space, Y-UP (DXF/CAD convention). The screen
// flips Y: screenX = wx·scale + ox, screenY = −wy·scale + oy. Arc/text angles
// (radians, CCW in world) become clockwise on screen, so they are negated when
// drawing.

import type { Drawing, DrawEntity, FurnitureItem, Category } from './types'
import { CATEGORY_COLOR } from './types'
import type { Pt, Segment } from './testfit'
import type { RoomMarker, RoomType } from './markers'
import type { Backdrop } from './rasterImport'
import type { PlaceSpec } from '../types/cad'

// ---- palette ----

// Mat behind the plate — matches EditorCanvas C.mat.
export const MAT = '#f2f4f7'
// Furniture linework (gray) + a lighter secondary tone for a symbol's detail
// (monitor, chair, glazing centerline). Mirrors EditorCanvas's stroke/detail pair.
export const FURNITURE_LINE = '#5c6670'
export const FURNITURE_DETAIL = '#9aa2ad'
// Selection = warm amber accent; hover = a lighter amber wash. Kept distinct
// from the blue used for product-bound items so the two never read the same.
export const ACCENT = '#E8A13C'
export const ACCENT_HALO = 'rgba(232,161,60,0.28)'
export const HOVER = 'rgba(232,161,60,0.55)'
// Bound ("specified"/re-imagined) furniture — solid data-blue so a decided item
// reads distinctly from both unbound gray linework and the amber selection.
export const SPECIFIED = '#2d5bd6'
export const SPECIFIED_DETAIL = '#6d8fe0'

// ---- tuning constants ----

export const MIN_SCALE = 2
export const MAX_SCALE = 4000
const FIT_PADDING = 40 // px padding around bounds in fitScene
export const TEXT_MIN_PX = 6.5 // hide text glyphs smaller than this on screen
export const DRAG_THRESHOLD = 4 // px movement below which a mouse-up is a click
export const ROTATE_STEP = Math.PI / 12 // 15° per keypress
export const DUP_OFFSET = 0.3 // meters — nudge for a duplicated item
export const HANDLE_PX = 3 // half-size of selection corner handles, screen px
export const UNDO_CAP = 50 // max snapshots kept
const PLACE_SNAP = 0.05 // meters — placement-ghost grid snap
export const PLACE_FILL = 'rgba(232,161,60,0.10)' // ghost footprint wash
export const SNAP_PX = 12 // screen-px radius for the area tool's adaptive wall snap
export const AREA_MASK = 'rgba(20,24,33,0.42)' // dims everything OUTSIDE the selected area
export const AREA_FILL = 'rgba(232,161,60,0.08)' // faint wash inside the selected area
export const AREA_VERTEX_PX = 4 // half-size of an area-polygon vertex handle, screen px
export const AREA_CLOSE_PX = 10 // click within this of the first vertex closes the ring
export const MARKER_R_PX = 11 // marker pin radius, screen px
export const ANCHOR_COLOR = '#4a8fc7' // anchor pins: cool blue, distinct from amber markers
export const ANCHOR_R_PX = 12 // anchor pin (diamond) half-diagonal, screen px

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
export const FURNITURE_RANK = 5

/** Entities sharing one stroke style, so pan/zoom batches into few stroke() calls. */
export interface StyleBucket {
  color: string
  lw: number
  rank: number
  ents: DrawEntity[]
}

// ---- the observable surface ----

/**
 * The callbacks `DrawingCanvas` exposes as public fields. The scene holds a live
 * reference (never a copy) so a caller reassigning `dc.onSelect` takes effect
 * immediately.
 */
export interface DrawingEvents {
  /** Fired on click: the furniture item under the cursor, or null on empty space. */
  onSelect: ((item: FurnitureItem | null) => void) | null
  /** Fired when the hovered furniture item changes (optional). */
  onHover: ((item: FurnitureItem | null) => void) | null
  /** Fired after any edit (move/rotate/delete/duplicate/undo) with the mutated drawing. */
  onChange: ((d: Drawing) => void) | null
  /** Fired after every re-render (pan/zoom/resize/refresh/edit) so overlays
   *  anchored in screen space (e.g. the selection card) can re-position. */
  onViewChange: (() => void) | null
  /** Fired when the area polygon is committed (closed), edited, or cleared —
   *  the committed ring (drawing coords) or null. In-progress vertices do NOT
   *  fire this, so React never rewrites a half-drawn polygon. */
  onAreaChange: ((polygon: Pt[] | null) => void) | null
  /** Fired when a marker is dropped, at the click point (drawing coords). The
   *  owner assigns the id/ref and re-arms the tool for the next drop. */
  onMarkerDrop: ((x: number, y: number) => void) | null
  /** Fired when the scale reference line's two points are placed, with its
   *  current world length (m). The owner prompts for the real length, then
   *  calls `DrawingCanvas.applyScale`. */
  onScaleReady: ((worldLengthM: number) => void) | null
  /** Fired after `applyScale` recalibrates the backdrop, with the new
   *  meters-per-pixel (so the owner can persist / display the scale). */
  onScaleChange: ((mpp: number) => void) | null
  /** Fired when an anchor pin is dropped, at the click point (drawing coords).
   *  The owner assigns the id/kind and re-arms the tool for the next drop. */
  onAnchorDrop: ((x: number, y: number) => void) | null
}

/** Everything the render/edit/input modules read and write. */
export interface DrawingScene {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  /** The façade's public callbacks, by reference. */
  readonly ev: DrawingEvents
  dpr: number

  drawing: Drawing | null
  buckets: StyleBucket[]
  texts: DrawEntity[]

  scale: number // px per meter
  offset: { x: number; y: number } // screen px of world origin
  /** True while the view still shows the auto-fit framing (no manual pan/zoom
   *  since the last fit). When set, a container/window resize RE-FITS so the
   *  plan keeps filling the box; once the user pans or zooms we stop re-fitting
   *  and just repaint, preserving their navigation. */
  fitted: boolean

  selected: FurnitureItem | null
  hovered: FurnitureItem | null

  // pan / click / move bookkeeping
  pointerDown: boolean
  didPan: boolean
  movingActive: boolean
  moveCandidate: FurnitureItem | null
  lastScreen: { x: number; y: number }
  downScreen: { x: number; y: number }
  lastWorld: { x: number; y: number }

  // placement mode: the spec being stamped, the snapped ghost position (world
  // meters; null until the cursor enters the canvas) and the ghost rotation.
  placing: PlaceSpec | null
  placeCursor: { x: number; y: number } | null
  placeRotation: number

  /** Snapshots of drawing.furniture taken before each mutation. */
  undoStack: FurnitureItem[][]

  // area-select tool (workflow.md §3.1): a polygon in drawing/source coords.
  // `area` holds either the in-progress vertices or the committed ring; while
  // the tool is armed vertices are editable (drag handles, adaptive wall snap).
  areaTool: boolean
  area: Pt[]
  areaClosed: boolean
  areaDragVertex: number | null
  toolCursor: Pt | null // snapped preview point (area vertex / marker ghost)
  toolSnapped: boolean // did `toolCursor` land on a wall feature
  snapPoints: Pt[] // wall/glazing endpoints — adaptive snap targets
  snapSegs: Segment[] // wall/glazing segments — projection snap targets

  // marker tool (workflow.md §3.2): `markerArm` is the type+ref waiting to be
  // dropped; `markers` are the placed pins (drawing/source coords) to render.
  markerArm: { type: RoomType; ref: string } | null
  markers: RoomMarker[]

  // anchor tool (workflow.md §3.5): `anchorArm` is the room kind waiting to be
  // dropped; `anchors` are the placed pins (drawing/source coords) to render as
  // diamonds — visually distinct from the round §3.2 markers.
  anchorArm: { label: string } | null
  anchors: { x: number; y: number; label: string }[]

  // Raster backdrop + scale calibration (rasterImport.ts). `backdrop` is the
  // image underlay; the scale tool draws a two-point reference line (world m)
  // over a known dimension — completing it fires onScaleReady, and applyScale
  // rescales the backdrop so that line equals the real length the user typed.
  backdrop: Backdrop | null
  scaleTool: boolean
  scaleFirst: Pt | null // first click of the reference line
  scaleLine: [Pt, Pt] | null // completed reference line (world m)
}

export function createScene(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  ev: DrawingEvents,
): DrawingScene {
  return {
    canvas,
    ctx,
    ev,
    dpr: Math.max(1, window.devicePixelRatio || 1),
    drawing: null,
    buckets: [],
    texts: [],
    scale: 40,
    offset: { x: 0, y: 0 },
    fitted: false,
    selected: null,
    hovered: null,
    pointerDown: false,
    didPan: false,
    movingActive: false,
    moveCandidate: null,
    lastScreen: { x: 0, y: 0 },
    downScreen: { x: 0, y: 0 },
    lastWorld: { x: 0, y: 0 },
    placing: null,
    placeCursor: null,
    placeRotation: 0,
    undoStack: [],
    areaTool: false,
    area: [],
    areaClosed: false,
    areaDragVertex: null,
    toolCursor: null,
    toolSnapped: false,
    snapPoints: [],
    snapSegs: [],
    markerArm: null,
    markers: [],
    anchorArm: null,
    anchors: [],
    backdrop: null,
    scaleTool: false,
    scaleFirst: null,
    scaleLine: null,
  }
}

/** Drop every per-drawing bit of state (selection, undo, tools, backdrop). The
 *  owner re-applies persisted area/markers/anchors afterwards. */
export function resetScene(s: DrawingScene): void {
  s.selected = null
  s.hovered = null
  s.undoStack = []
  s.placing = null
  s.placeCursor = null
  s.areaTool = false
  s.area = []
  s.areaClosed = false
  s.areaDragVertex = null
  s.markerArm = null
  s.markers = []
  s.anchorArm = null
  s.anchors = []
  s.scaleTool = false
  s.scaleFirst = null
  s.scaleLine = null
  s.backdrop = null
  s.toolCursor = null
}

// ---- transforms ----

export function toScreen(s: DrawingScene, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * s.scale + s.offset.x, y: -wy * s.scale + s.offset.y }
}

export function toWorld(s: DrawingScene, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - s.offset.x) / s.scale, y: -(sy - s.offset.y) / s.scale }
}

export function cssSize(s: DrawingScene): { w: number; h: number } {
  return { w: s.canvas.width / s.dpr, h: s.canvas.height / s.dpr }
}

/** Is a canvas-relative screen point inside the viewport? */
export function withinCanvas(s: DrawingScene, sx: number, sy: number): boolean {
  const { w, h } = cssSize(s)
  return sx >= 0 && sy >= 0 && sx <= w && sy <= h
}

/** Canvas-relative CSS pixels for a mouse/wheel event. */
export function screenFromEvent(s: DrawingScene, e: MouseEvent): { x: number; y: number } {
  const r = s.canvas.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Snap a world coordinate to the placement grid (0.05 m). */
export function snapPlace(v: number): number {
  return Math.round(v / PLACE_SNAP) * PLACE_SNAP
}

// ---- framing + backing store ----

/** Frame `drawing.bounds` in the viewport with padding. Caller repaints. */
export function fitScene(s: DrawingScene): void {
  const d = s.drawing
  const { w, h } = cssSize(s)
  if (!d || w === 0 || h === 0) return
  const [minX, minY, maxX, maxY] = d.bounds
  const worldW = Math.max(1e-3, maxX - minX)
  const worldH = Math.max(1e-3, maxY - minY)
  const sx = (w - 2 * FIT_PADDING) / worldW
  const sy = (h - 2 * FIT_PADDING) / worldH
  s.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
  // Center the world bbox center at the viewport center (Y flipped).
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  s.offset.x = w / 2 - cx * s.scale
  s.offset.y = h / 2 + cy * s.scale
  s.fitted = true
}

/** Size the backing store to the container × DPR. Returns true iff the pixel
 *  dimensions actually changed (so callers can skip redundant refits). */
export function resizeBacking(s: DrawingScene): boolean {
  const parent = s.canvas.parentElement
  if (!parent) return false
  const rect = parent.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false // hidden
  s.dpr = Math.max(1, window.devicePixelRatio || 1)
  const w = Math.floor(rect.width * s.dpr)
  const h = Math.floor(rect.height * s.dpr)
  if (w === s.canvas.width && h === s.canvas.height) return false
  s.canvas.width = w
  s.canvas.height = h
  s.canvas.style.width = `${rect.width}px`
  s.canvas.style.height = `${rect.height}px`
  return true
}

// ---- style batching ----

/** Precompute style buckets (and pull texts aside) so pan/zoom stay cheap. */
export function buildBuckets(s: DrawingScene, d: Drawing): void {
  const byKey = new Map<string, StyleBucket>()
  s.texts = []
  for (const e of d.entities) {
    if (e.kind === 'text') {
      s.texts.push(e)
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
  s.buckets = [...byKey.values()].sort((a, b) => a.rank - b.rank)
}
