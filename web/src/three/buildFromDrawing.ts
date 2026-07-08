import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildFurniture3D, TEXTURES, woodPhysical } from './furniture3d'
import * as furniture3d from './furniture3d'
import type { Drawing, DrawEntity } from '../import/types'

/**
 * Build a walk-through-able 3D scene from an imported CAD {@link Drawing}.
 *
 * ── Coordinate mapping ────────────────────────────────────────────────────
 * The imported drawing is METERS, Y-UP (DXF/CAD orientation). We map to a
 * right-handed Three.js scene as:
 *     plan X → world X      plan Y → world Z      up → world +Y
 * so a plan point (px, py) becomes (px, y, py). A 2D rotation θ (CCW in the
 * Y-up plan) becomes a rotation about world +Y of −θ: the same handedness flip
 * used by Viewer3D. For a wall segment a→b, direction (dx, dz)=(bx−ax, by−ay)
 * in world space, the box's local +X aligns with the segment when
 * rotation.y = −atan2(dz, dx). Derivation matches Viewer3D.buildWall.
 *
 * ── Efficiency ────────────────────────────────────────────────────────────
 * A real import has ~745 wall polylines (thousands of segments) and ~533
 * furniture items. To stay well under a few hundred ms and keep draw calls low:
 *  - every wall segment is a BoxGeometry baked into world space via a matrix,
 *    then all segments are fused with `mergeGeometries` into ONE mesh sharing
 *    ONE wall material (likewise glazing, doors);
 *  - furniture reuses `buildFurniture3D` (which shares its own materials);
 *  - floor/materials are each created once.
 *
 * ── What we render ─────────────────────────────────────────────────────────
 * Linework categories that read as thin extruded shells (outline × thickness):
 * `wall`, `glazing`, `door` (a thin door leaf at the opening). Closed-polygon
 * categories that read as SOLID low masses (filled footprint, extruded up):
 * `casework` (~0.9 m laminate counters/cabinets), `fixture` (~0.6 m plumbing/
 * appliance masses), and `other` — but only *closed* `other` polylines whose
 * footprint is small (columns / built masses); large closed `other` outlines
 * (rooms, site boundary) and every open `other` line are skipped so stray
 * leaders/room outlines don't become slabs.
 */

const WALL_HEIGHT = 2.7
const WALL_THICKNESS = 0.1
const GLAZING_SILL = 1.2
const GLAZING_HEAD = 2.4
const GLAZING_THICKNESS = 0.06
const DOOR_HEIGHT = 2.1
const DOOR_THICKNESS = 0.06
const CASEWORK_HEIGHT = 0.9 // counter / base-cabinet mass
const FIXTURE_HEIGHT = 0.6 // plumbing fixture / appliance low mass
const OTHER_HEIGHT = 0.4 // conservative low plinth / column mass
/** m²: skip closed `other` polylines larger than this (rooms/site outlines). */
const OTHER_MAX_FOOTPRINT = 4

/**
 * Fallback name → furniture-category mapper, used only until the furniture3d
 * agent exports the real `normalizeFurnitureCategory`. The real export (once it
 * lands) takes priority. Keys mirror furniture3d's HEIGHT table.
 */
function fallbackNormalize(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('desk') || n.includes('workstation')) return 'Desk'
  if (n.includes('chair') || n.includes('seat') || n.includes('stool')) return 'Chair'
  if (n.includes('conference') || n.includes('table')) return 'Table'
  if (n.includes('meeting') || n.includes('room')) return 'MeetingRoom'
  if (n.includes('ceiling')) return 'FallCeiling'
  return 'default'
}

const normalizeFurnitureCategory =
  (furniture3d as unknown as { normalizeFurnitureCategory?: (name: string) => string })
    .normalizeFurnitureCategory ?? fallbackNormalize

/** Iterate the straight segments of a polyline/line entity as [a, b] pairs. */
function* segments(e: DrawEntity): Generator<[[number, number], [number, number]]> {
  const pts = e.pts
  if (!pts || pts.length < 2) return
  for (let i = 0; i < pts.length - 1; i++) yield [pts[i], pts[i + 1]]
  if (e.closed && pts.length > 2) yield [pts[pts.length - 1], pts[0]]
}

/**
 * Bake one wall-like segment into a world-space box geometry (centred at the
 * segment midpoint, its local +X along the segment). Returns null for
 * zero-length segments so they can be skipped.
 */
function segmentBox(
  a: [number, number],
  b: [number, number],
  height: number,
  thickness: number,
  yCenter: number,
): THREE.BufferGeometry | null {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1] // plan Y → world Z
  const len = Math.hypot(dx, dz)
  if (len < 1e-4) return null

  const geo = new THREE.BoxGeometry(len, height, thickness)
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((a[0] + b[0]) / 2, yCenter, (a[1] + b[1]) / 2),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.atan2(dz, dx), 0)),
    new THREE.Vector3(1, 1, 1),
  )
  geo.applyMatrix4(m)
  return geo
}

/** Fuse per-category segment boxes into a single shadowed mesh, or null. */
function mergedSegments(
  entities: DrawEntity[],
  category: string,
  height: number,
  thickness: number,
  yCenter: number,
  material: THREE.Material,
): THREE.Mesh | null {
  const geoms: THREE.BufferGeometry[] = []
  for (const e of entities) {
    if (e.category !== category) continue
    if (e.kind !== 'polyline') continue // LINE is a 2-pt polyline; arcs are ignored
    for (const [a, b] of segments(e)) {
      const g = segmentBox(a, b, height, thickness, yCenter)
      if (g) geoms.push(g)
    }
  }
  if (geoms.length === 0) return null
  const merged = mergeGeometries(geoms, false)
  for (const g of geoms) g.dispose() // sources are copied; free CPU arrays
  const mesh = new THREE.Mesh(merged, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  // Building fabric: reported by Viewer3D.onPick but not selectable UI-wise.
  mesh.userData.pick = { kind: 'shell', category }
  return mesh
}

/**
 * Fuse the *closed* polylines of a category into one SOLID low-mass mesh: each
 * footprint is triangulated (THREE.Shape) and extruded upward to `height`,
 * sitting on the floor (base at y=0). Unlike {@link mergedSegments} (a thin
 * outline shell), this fills the footprint — the right read for cabinetry,
 * fixtures and columns. Open polylines and footprints larger than
 * `maxFootprint` (m², bbox proxy) are skipped. Shares ONE material.
 *
 * Extrude → world mapping: THREE builds the shape in XY and extrudes along +Z.
 * `rotateX(+π/2)` maps (x, y, z) → (x, −z, y) so plan Y → world Z and the
 * extrude axis → world −Y; translating up by `height` seats it at [0, height].
 * This is a proper rotation (no reflection), so cap/side normals stay outward.
 */
function mergedSolids(
  entities: DrawEntity[],
  category: string,
  height: number,
  material: THREE.Material,
  maxFootprint = Infinity,
): THREE.Mesh | null {
  const geoms: THREE.BufferGeometry[] = []
  for (const e of entities) {
    if (e.category !== category) continue
    if (e.kind !== 'polyline' || !e.closed) continue
    const pts = e.pts
    if (!pts || pts.length < 3) continue

    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
    for (const [x, y] of pts) {
      if (x < mnx) mnx = x
      if (x > mxx) mxx = x
      if (y < mny) mny = y
      if (y > mxy) mxy = y
    }
    if ((mxx - mnx) * (mxy - mny) > maxFootprint) continue

    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()

    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 })
    geo.rotateX(Math.PI / 2)
    geo.translate(0, height, 0)
    geoms.push(geo)
  }
  if (geoms.length === 0) return null
  const merged = mergeGeometries(geoms, false)
  for (const g of geoms) g.dispose()
  const mesh = new THREE.Mesh(merged, material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  // Building fabric: reported by Viewer3D.onPick but not selectable UI-wise.
  mesh.userData.pick = { kind: 'shell', category }
  return mesh
}

export function buildFromDrawing(drawing: Drawing): { root: THREE.Group; bounds: THREE.Box3 } {
  const root = new THREE.Group()
  root.name = 'imported-drawing'

  const [minX, minY, maxX, maxY] = drawing.bounds

  // ── Floor ───────────────────────────────────────────────────────────────
  const floorW = Math.max(maxX - minX, 1)
  const floorD = Math.max(maxY - minY, 1)
  // Office-neutral carpet. The plane's UVs span 0..1, so the shared speckle map
  // is cloned once per import with a repeat of ~1 tile/m (clone shares the same
  // canvas; only the transform differs).
  const carpetTex = TEXTURES.carpet.clone()
  carpetTex.repeat.set(Math.max(1, Math.round(floorW)), Math.max(1, Math.round(floorD)))
  carpetTex.needsUpdate = true
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorW, floorD),
    new THREE.MeshStandardMaterial({ color: 0xe8e6e1, map: carpetTex, roughness: 0.95, metalness: 0.0 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set((minX + maxX) / 2, -0.002, (minY + maxY) / 2)
  floor.receiveShadow = true
  root.add(floor)

  // ── Shared materials ─────────────────────────────────────────────────────
  // Near-white plaster: the blotches live in the roughness response, not the color.
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xe2e5e9,
    roughness: 0.95,
    roughnessMap: TEXTURES.plasterRough,
    metalness: 0.0,
  })
  // Imported shells can carry hundreds of glazed segments; transmission glass is
  // reserved for furniture3d (pods/partitions/windows) and the shell keeps the
  // cheap transparent material so the transmissive pass stays small.
  const glazingMat = new THREE.MeshStandardMaterial({
    color: 0x8fb6e6,
    roughness: 0.15,
    metalness: 0.0,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const doorMat = woodPhysical(0x9c6b46) // door-leaf oak
  const caseworkMat = woodPhysical(0xc9b48f) // laminate/wood counters
  const fixtureMat = new THREE.MeshStandardMaterial({ color: 0xd3d7da, roughness: 0.35, metalness: 0.0 }) // porcelain/appliance
  const otherMat = new THREE.MeshStandardMaterial({ color: 0xbfc3c7, roughness: 0.85, metalness: 0.0 }) // neutral built mass

  // ── Walls / glazing / doors (each fused to one mesh) ─────────────────────
  const wall = mergedSegments(drawing.entities, 'wall', WALL_HEIGHT, WALL_THICKNESS, WALL_HEIGHT / 2, wallMat)
  if (wall) root.add(wall)

  const glazingH = GLAZING_HEAD - GLAZING_SILL
  const glazing = mergedSegments(
    drawing.entities,
    'glazing',
    glazingH,
    GLAZING_THICKNESS,
    GLAZING_SILL + glazingH / 2,
    glazingMat,
  )
  if (glazing) root.add(glazing)

  const door = mergedSegments(drawing.entities, 'door', DOOR_HEIGHT, DOOR_THICKNESS, DOOR_HEIGHT / 2, doorMat)
  if (door) root.add(door)

  // ── Solid low masses: casework / fixture / (small closed) other ──────────
  const casework = mergedSolids(drawing.entities, 'casework', CASEWORK_HEIGHT, caseworkMat)
  if (casework) root.add(casework)

  const fixture = mergedSolids(drawing.entities, 'fixture', FIXTURE_HEIGHT, fixtureMat)
  if (fixture) root.add(fixture)

  const other = mergedSolids(drawing.entities, 'other', OTHER_HEIGHT, otherMat, OTHER_MAX_FOOTPRINT)
  if (other) root.add(other)

  // ── Furniture ─────────────────────────────────────────────────────────────
  for (let index = 0; index < drawing.furniture.length; index++) {
    const item = drawing.furniture[index]
    const [bMinX, bMinY, bMaxX, bMaxY] = item.bbox
    const w = Math.max(bMaxX - bMinX, 0.05)
    const d = Math.max(bMaxY - bMinY, 0.05)
    const obj = buildFurniture3D(normalizeFurnitureCategory(item.name), w, d)
    const group = new THREE.Group()
    group.position.set((bMinX + bMaxX) / 2, 0, (bMinY + bMaxY) / 2)
    group.rotation.y = -item.rotation // Y-up plan θ → world −θ about +Y
    // Click-select metadata (Viewer3D.onPick): `index` into drawing.furniture.
    group.userData.pick = { kind: 'furniture', index, name: item.name, category: item.category }
    group.add(obj)
    root.add(group)
  }

  // ── Bounds from the actually-built geometry ──────────────────────────────
  const bounds = new THREE.Box3().setFromObject(root)
  if (bounds.isEmpty()) {
    // Degenerate drawing (no geometry): fall back to the declared plan extent.
    bounds.set(
      new THREE.Vector3(minX, 0, minY),
      new THREE.Vector3(maxX, WALL_HEIGHT, maxY),
    )
  }

  return { root, bounds }
}
