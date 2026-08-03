// The CAD layer contract — entities, store, snapping, tools, render. All modules
// (snap/geomTools/annoTools/archTools/editTools/store/render) target THIS file.
//
// The type vocabulary itself lives in `../types/cad` (a leaf, import-free module,
// alongside doc/metrics/program); it is re-exported here so `from './model'`
// stays the one address the CAD layer imports from. Only RUNTIME values are
// defined below.
//
// Conventions: coordinates are METERS in EditorCanvas world space (same space the
// generative editor uses — no Y-flip here). Angles are radians. Ids are unique
// positive integers from the store.

export type {
  Vec2,
  Style,
  LineEnt,
  PolylineEnt,
  RectEnt,
  CircleEnt,
  ArcEnt,
  EllipseEnt,
  DimensionEnt,
  TextEnt,
  DoorEnt,
  WindowEnt,
  ColumnEnt,
  HatchEnt,
  CadEntity,
  CadKind,
  CadStore,
  SnapType,
  SnapResult,
  SnapContext,
  ToolCtx,
  CadTool,
  RenderCtx,
} from '../types/cad'

/** The implicit layer for entities that don't carry a `layer` field. */
export const DEFAULT_LAYER = '0'

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
