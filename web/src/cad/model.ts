// The CAD layer contract — entities, store, snapping, tools, render. All modules
// (snap/geomTools/annoTools/archTools/editTools/store/render) target THIS file.
//
// Conventions: coordinates are METERS in EditorCanvas world space (same space the
// generative editor uses — no Y-flip here). Angles are radians. Ids are unique
// positive integers from the store.

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

/** The implicit layer for entities that don't carry a `layer` field. */
export const DEFAULT_LAYER = '0'

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

/** Category/kind → default CAD color (Rayon/Revit-like light linework). */
export const CAD_COLOR: Record<string, string> = {
  line: '#2e343b',
  polyline: '#2e343b',
  rect: '#2e343b',
  circle: '#2e343b',
  arc: '#2e343b',
  ellipse: '#2e343b',
  dimension: '#2d5bd6',
  text: '#1a1d21',
  door: '#8a5a34',
  window: '#4a82c4',
  column: '#3a4048',
  hatch: '#5a636e',
}
