// Shared model for imported CAD drawings (DWG → DXF → Drawing).
//
// Conventions (agreed contract — importer and renderer both target this):
// - All coordinates are METERS, world-space, in DXF/CAD orientation (Y-up).
//   The renderer flips Y for the screen. Source units (inches/mm) are converted
//   to meters on import.
// - Angles are radians, counter-clockwise (DXF convention).
// - Curves (ARC/CIRCLE/ELLIPSE) may be tessellated into polylines by the
//   importer, or kept as arc primitives; both are valid — the renderer supports
//   `arc`/`circle` and `polyline`.

export type EntityKind = 'polyline' | 'arc' | 'circle' | 'text'

/** Semantic bucket derived from the AIA-style layer name + block name. */
export type Category =
  | 'wall'
  | 'glazing'
  | 'door'
  | 'furniture'
  | 'casework'
  | 'fixture'
  | 'annotation'
  | 'dimension'
  | 'other'

export interface DrawEntity {
  kind: EntityKind
  layer: string
  category: Category
  /** Optional resolved color '#rrggbb'; if absent the renderer colors by category. */
  color?: string
  // --- polyline (a LINE is a 2-point open polyline) ---
  pts?: [number, number][]
  closed?: boolean
  // --- arc / circle (angles radians, CCW) ---
  cx?: number
  cy?: number
  r?: number
  start?: number
  end?: number
  // --- text ---
  text?: string
  tx?: number
  ty?: number
  h?: number
  rot?: number
}

/** One placed block instance (INSERT) — a real, selectable furniture object. */
export interface FurnitureItem {
  id: number
  /** Cleaned, human-readable name, e.g. "Steelcase SILQ Task Chair". */
  name: string
  /** Original DXF block name. */
  raw: string
  category: Category
  /** [minX, minY, maxX, maxY] meters, world-space. */
  bbox: [number, number, number, number]
  /** Insert origin [x, y] meters. */
  origin: [number, number]
  /** Rotation radians. */
  rotation: number
  /** Fully-resolved world-space geometry (block flattened + transformed). */
  entities: DrawEntity[]
  /** Bound material-bank product (re-imagine), if any. */
  productId?: string
  productName?: string
}

export interface Drawing {
  /** Source units label, e.g. 'in' | 'mm' | 'm'. */
  units: string
  /**
   * How `units` was decided. `$INSUNITS` is metadata the file asserts about
   * itself and is often wrong, so the importer confirms it against the geometry
   * (door-swing radii, then overall extent) and records which anchor settled it.
   *
   * `'header-unverified'` means the drawing offered no physical anchor and the
   * header was taken on trust — the one value that must never be presented to
   * the user as a certainty, since every area, cost and m²/person figure
   * downstream is denominated in it. Optional so a hand-built `Drawing` (tests,
   * raster import) need not supply it.
   */
  unitsSource?: 'header' | 'door-anchor' | 'wall-anchor' | 'extent-anchor' | 'header-unverified'
  /** [minX, minY, maxX, maxY] meters, from the actual geometry (not the sheet). */
  bounds: [number, number, number, number]
  layers: string[]
  /** Non-furniture geometry: walls, glazing, doors, casework, annotation, dims. */
  entities: DrawEntity[]
  /** Placed furniture/block instances (selectable). */
  furniture: FurnitureItem[]
}

/** Category → CAD line color (light-theme, Rayon/Revit-like linework). */
export const CATEGORY_COLOR: Record<Category, string> = {
  wall: '#1e2329',
  glazing: '#4a82c4',
  door: '#8a5a34',
  furniture: '#5c6670',
  casework: '#7a6a55',
  fixture: '#3f9c95',
  annotation: '#9aa2ad',
  dimension: '#b0663b',
  other: '#9aa2ad',
}
