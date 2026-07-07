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

export type CadKind = CadEntity['kind']

/** Entity store with an undo stack. Implemented in cad/store.ts. */
export interface CadStore {
  readonly entities: CadEntity[]
  /** add (id assigned); pushes undo unless `batch` */
  add(e: Omit<CadEntity, 'id'>, batch?: boolean): CadEntity
  update(id: number, patch: Partial<CadEntity>): void
  remove(ids: number | number[]): void
  get(id: number): CadEntity | undefined
  /** capture current state for undo (call before a multi-step mutation) */
  snapshot(): void
  undo(): void
  canUndo(): boolean
  clear(): void
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
}
