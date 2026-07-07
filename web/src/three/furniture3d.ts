import * as THREE from 'three'

// Shared 3D-furniture contract. `buildFurniture3D` returns an Object3D sitting on
// the floor (y=0 at its base), sized w (X) × d (Z), for a given category. Used by
// both the generated-plan viewer and the imported-plan 3D builder.
//
// This is a working box-based placeholder; the furniture3d agent upgrades it to
// real parametric models (desk with legs+top+monitor, task chair, table, …)
// WITHOUT changing this signature.

export interface Furniture3DOpts {
  color?: number | string
  /** override height (m); else a per-category default */
  height?: number
}

const HEIGHT: Record<string, number> = {
  Desk: 0.74,
  Table: 0.74,
  Chair: 0.45,
  MeetingRoom: 0.74,
  FallCeiling: 0.05,
  default: 0.75,
}

export function buildFurniture3D(
  category: string,
  w: number,
  d: number,
  opts: Furniture3DOpts = {},
): THREE.Object3D {
  const height = opts.height ?? HEIGHT[category] ?? HEIGHT.default
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.05, w), height, Math.max(0.05, d)),
    new THREE.MeshStandardMaterial({ color: opts.color ?? 0x9db4e0, roughness: 0.75, metalness: 0.02 }),
  )
  mesh.position.y = height / 2
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}
