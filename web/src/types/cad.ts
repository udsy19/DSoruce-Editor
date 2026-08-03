/**
 * The CAD drafting-layer vocabulary — entities, store, snapping, tools, render.
 *
 * Type-only module: every symbol here is a compile-time shape. The runtime
 * companions (`DEFAULT_LAYER`, `CAD_COLOR`, the store/tool/render implementations)
 * live in `../cad/*`, which re-exports these so existing `from './model'` imports
 * keep working.
 *
 * Conventions: coordinates are METERS in EditorCanvas world space (the same space
 * the generative editor uses — no Y-flip here). Angles are radians. Ids are unique
 * positive integers from the store.
 *
 * Dependency rule: like `doc.ts`/`metrics.ts`/`program.ts` this module imports
 * nothing, so the type layer stays a leaf.
 */

export interface Vec2 {
  x: number
  y: number
}

export interface Style {
  /** layer name; drives default color when color is unset */
  layer?: string
  /** explicit stroke color '#rrggbb'; else derived from layer/kind */
  color?: string
  /** line weight in px (device-independent); default per kind */
  weight?: number
}

interface Base extends Style {
  id: number
}

export interface LineEnt extends Base {
  kind: 'line'
  a: Vec2
  b: Vec2
}
export interface PolylineEnt extends Base {
  kind: 'polyline'
  pts: Vec2[]
  closed: boolean
}
export interface RectEnt extends Base {
  kind: 'rect'
  /** center */
  x: number
  y: number
  w: number
  h: number
  rotation: number
}
export interface CircleEnt extends Base {
  kind: 'circle'
  c: Vec2
  r: number
}
export interface ArcEnt extends Base {
  kind: 'arc'
  c: Vec2
  r: number
  /** radians, CCW; drawn from start to end */
  start: number
  end: number
}
export interface EllipseEnt extends Base {
  kind: 'ellipse'
  c: Vec2
  rx: number
  ry: number
  rotation: number
}
export interface DimensionEnt extends Base {
  kind: 'dimension'
  /** the two measured points */
  a: Vec2
  b: Vec2
  /** perpendicular offset (m) of the dimension line from the a→b baseline */
  offset: number
  /** override text; else the measured distance is shown */
  text?: string
}
export interface TextEnt extends Base {
  kind: 'text'
  at: Vec2
  text: string
  /** text height, meters */
  h: number
  rotation: number
}
export interface DoorEnt extends Base {
  kind: 'door'
  /** hinge point on the wall line */
  at: Vec2
  /** leaf width, meters */
  width: number
  /** wall direction angle, radians */
  angle: number
  /** which side + swing direction */
  hinge: 'left' | 'right'
  flip: boolean
}
export interface WindowEnt extends Base {
  kind: 'window'
  at: Vec2
  width: number
  angle: number
  /** wall thickness the window sits in, meters */
  thickness: number
}
export interface ColumnEnt extends Base {
  kind: 'column'
  at: Vec2
  w: number
  h: number
  shape: 'rect' | 'round'
  rotation: number
}
export interface HatchEnt extends Base {
  kind: 'hatch'
  /** closed boundary polygon (implicitly closed; ≥3 points) */
  pts: Vec2[]
  pattern: 'diag' | 'cross' | 'solid'
  /** pattern line spacing, meters (default 0.25) */
  spacing: number
}

export type CadEntity =
  | LineEnt
  | PolylineEnt
  | RectEnt
  | CircleEnt
  | ArcEnt
  | EllipseEnt
  | DimensionEnt
  | TextEnt
  | DoorEnt
  | WindowEnt
  | ColumnEnt
  | HatchEnt

export type CadKind = CadEntity['kind']

/** Entity store with an undo stack. Implemented in cad/store.ts. */
export interface CadStore {
  readonly entities: CadEntity[]
  /**
   * Layer new entities are stamped with when they don't carry one.
   * Default "0". Mutate via setActiveLayer.
   */
  readonly activeLayer: string
  setActiveLayer(name: string): void
  /** distinct layer names: entities ∪ {"0", activeLayer} ("0" first, then sorted) */
  layers(): string[]
  /** session-only view state — never serialized into cad_json */
  readonly hiddenLayers: Set<string>
  /** flip a layer's visibility */
  toggleLayer(name: string): void
  isVisible(name: string): boolean
  /** add (id assigned, `layer` stamped with activeLayer when absent); pushes undo unless `batch` */
  add(e: Omit<CadEntity, 'id'>, batch?: boolean): CadEntity
  update(id: number, patch: Partial<CadEntity>): void
  remove(ids: number | number[]): void
  get(id: number): CadEntity | undefined
  /** capture current state for undo (call before a multi-step mutation) */
  snapshot(): void
  undo(): void
  canUndo(): boolean
  clear(): void
  /**
   * Replace the whole entity list (document hydrate: snapshot restore / clear).
   * Resets `nextId` to max(id)+1 (1 when empty), drops the undo stack, fires
   * `onChange`.
   */
  load(entities: CadEntity[]): void
  /** notified after any mutation, for re-render */
  onChange: (() => void) | null
}

// ---- snapping ----
export type SnapType =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'quadrant'
  | 'perpendicular'
  | 'nearest'
  | 'grid'
  | 'extension'
  | 'none'

export interface SnapResult {
  point: Vec2
  type: SnapType
  /** entity id the snap came from, if any */
  ref?: number
}

export interface SnapContext {
  entities: CadEntity[]
  /** editor walls (thin segments) participate in snapping */
  walls: { a: Vec2; b: Vec2 }[]
  /** placed components (centers/corners) participate */
  components: { x: number; y: number; w: number; h: number; rotation: number }[]
  /** grid size, meters (0 disables grid snap) */
  grid: number
  /** pixels per meter, so tolerance can be a pixel radius */
  pxPerM: number
  /** pixel tolerance for a snap hit (default ~10) */
  tolPx?: number
  /** enabled snap modes; if absent, all are on */
  enabled?: Set<SnapType>
  /** reference point for perpendicular/extension (the tool's last point) */
  from?: Vec2
}

// ---- tools ----
export interface ToolCtx {
  store: CadStore
  snap(cursor: Vec2): SnapResult
  toScreen(w: Vec2): { x: number; y: number }
  toWorld(sx: number, sy: number): Vec2
  pxPerM: number
  requestRender(): void
  /** the active default layer for new entities */
  layer: string
  /**
   * Create a REAL document component (Rust core), not a CAD entity — used by
   * the arch tools so doors/windows/columns get metrics/3D/export/binding.
   * (x,y) is the footprint center in meters; `rotation` is radians, clockwise
   * in the Y-down plan (the doc convention).
   */
  addComponent(category: string, x: number, y: number, w: number, h: number, rotation: number): void
}

/** A drafting tool. EditorCanvas routes pointer/keyboard here while active. */
export interface CadTool {
  id: string
  /** pointer down at world point (already snapped) */
  onDown(world: Vec2, snap: SnapResult, ctx: ToolCtx, ev: MouseEvent): void
  onMove(world: Vec2, snap: SnapResult, ctx: ToolCtx): void
  onUp?(world: Vec2, snap: SnapResult, ctx: ToolCtx): void
  onKey?(key: string, ctx: ToolCtx): void
  /** draw the in-progress ghost (screen space; use ctx.toScreen) */
  drawPreview?(g: CanvasRenderingContext2D, ctx: ToolCtx): void
  /** live status text, e.g. "1.42 m  30°" */
  hint?(): string
  /**
   * The point new segments extend from (line/polyline = last committed vertex),
   * or null before the first click. Lets the dynamic-input layer compute the
   * candidate point without the tool knowing about the UI. Absent = no dynamic
   * input for this tool.
   */
  anchor?(): Vec2 | null
  /** reset in-progress state (Esc / tool switch) */
  cancel(): void
}

// ---- render ----
export interface RenderCtx {
  toScreen(w: Vec2): { x: number; y: number }
  pxPerM: number
  selected: Set<number>
  /** light-theme colors from EditorCanvas */
  colors: { wall: string; ink: string; accent: string; dim: string; faint: string }
  /** layers to skip while rendering (wire to CadStore.hiddenLayers); absent = all visible */
  hiddenLayers?: Set<string>
}

// ---- imported-drawing placement (import/DrawingCanvas.ts) ----

/** A placeable footprint the palette hands to `DrawingCanvas.beginPlace`. */
export interface PlaceSpec {
  /** Human-readable product/item name — becomes the FurnitureItem name. */
  name: string
  /** Semantic category. Coerced to a known import `Category`; else 'furniture'. */
  category: string
  /** Footprint width (X extent) in meters. */
  w: number
  /** Footprint depth (Y extent) in meters. */
  h: number
}
