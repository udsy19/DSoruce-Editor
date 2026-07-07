import * as THREE from 'three'
// `three/addons/*` is the modern published alias for `three/examples/jsm/*`.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildFurniture3D } from './furniture3d'
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
 */

const WALL_HEIGHT = 2.7
const WALL_THICKNESS = 0.1
const GLAZING_SILL = 1.2
const GLAZING_HEAD = 2.4
const GLAZING_THICKNESS = 0.06
const DOOR_HEIGHT = 2.1
const DOOR_THICKNESS = 0.06

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
  return mesh
}

export function buildFromDrawing(drawing: Drawing): { root: THREE.Group; bounds: THREE.Box3 } {
  const root = new THREE.Group()
  root.name = 'imported-drawing'

  const [minX, minY, maxX, maxY] = drawing.bounds

  // ── Floor ───────────────────────────────────────────────────────────────
  const floorW = Math.max(maxX - minX, 1)
  const floorD = Math.max(maxY - minY, 1)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorW, floorD),
    new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.95, metalness: 0.0 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.set((minX + maxX) / 2, -0.002, (minY + maxY) / 2)
  floor.receiveShadow = true
  root.add(floor)

  // ── Shared materials ─────────────────────────────────────────────────────
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.9, metalness: 0.0 })
  const glazingMat = new THREE.MeshStandardMaterial({
    color: 0x8fb6e6,
    roughness: 0.15,
    metalness: 0.0,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.8, metalness: 0.0 })

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

  // ── Furniture ─────────────────────────────────────────────────────────────
  for (const item of drawing.furniture) {
    const [bMinX, bMinY, bMaxX, bMaxY] = item.bbox
    const w = Math.max(bMaxX - bMinX, 0.05)
    const d = Math.max(bMaxY - bMinY, 0.05)
    const obj = buildFurniture3D(normalizeFurnitureCategory(item.name), w, d)
    const group = new THREE.Group()
    group.position.set((bMinX + bMaxX) / 2, 0, (bMinY + bMaxY) / 2)
    group.rotation.y = -item.rotation // Y-up plan θ → world −θ about +Y
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
