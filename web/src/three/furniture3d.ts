import * as THREE from 'three'

// Shared 3D-furniture contract. `buildFurniture3D` returns an Object3D sitting on
// the floor (y=0 at its base), sized w (X) × d (Z), for a given category. Used by
// both the generated-plan viewer and the imported-plan 3D builder.
//
// Real parametric models: recognizable desks, chairs, tables, sofas, stools,
// cabinets, planters, partitions and meeting-room clusters — each a THREE.Group of
// MeshStandardMaterial parts with per-part tones (wood worktop, fabric seat,
// dark/metal legs). Hundreds of instances are built, so geometry and materials are
// shared at module scope and every returned Group is a fresh, lightweight
// composition of clones (shared geometry + shared material, unique transforms).

export interface Furniture3DOpts {
  color?: number | string
  /** override height (m); else a per-category default */
  height?: number
}

// ---------------------------------------------------------------------------
// Shared geometry — unit primitives scaled per part (geometry is never rebuilt).
// ---------------------------------------------------------------------------
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
/** radius 0.5, height 1, along +Y. Scale (2r, h, 2r) → radius r, height h. */
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14)
/** tapered pot: top radius 0.5, bottom 0.35, height 1. */
const POT_CYL = new THREE.CylinderGeometry(0.5, 0.35, 1, 16)
/** low-poly foliage blob, radius 0.5. */
const BLOB = new THREE.SphereGeometry(0.5, 10, 8)

// ---------------------------------------------------------------------------
// Shared materials — one instance per tone, reused across all pieces.
// ---------------------------------------------------------------------------
const MAT = {
  wood: new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: 0.65, metalness: 0.04 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x7c5c37, roughness: 0.6, metalness: 0.05 }),
  laminate: new THREE.MeshStandardMaterial({ color: 0xdedbcf, roughness: 0.5, metalness: 0.05 }),
  darkLeg: new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.5, metalness: 0.55 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x9fa3a8, roughness: 0.35, metalness: 0.8 }),
  fabricSeat: new THREE.MeshStandardMaterial({ color: 0x5b6b7a, roughness: 0.95, metalness: 0.0 }),
  fabricBody: new THREE.MeshStandardMaterial({ color: 0x45525e, roughness: 0.95, metalness: 0.0 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.3, metalness: 0.2 }),
  cabinet: new THREE.MeshStandardMaterial({ color: 0xaf9b7d, roughness: 0.6, metalness: 0.05 }),
  pot: new THREE.MeshStandardMaterial({ color: 0x9c6b4a, roughness: 0.9, metalness: 0.0 }),
  foliage: new THREE.MeshStandardMaterial({ color: 0x5d7d54, roughness: 1.0, metalness: 0.0, flatShading: true }),
  panel: new THREE.MeshStandardMaterial({ color: 0xd6d3cb, roughness: 0.8, metalness: 0.05 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0xaecad6,
    roughness: 0.1,
    metalness: 0.0,
    transparent: true,
    opacity: 0.28,
  }),
  default: new THREE.MeshStandardMaterial({ color: 0x9db4e0, roughness: 0.75, metalness: 0.02 }),
}

// ---------------------------------------------------------------------------
// Part helpers — each returns a shadow-casting Mesh sharing a unit geometry.
// ---------------------------------------------------------------------------
function box(
  mat: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  ry = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(UNIT_BOX, mat)
  m.scale.set(Math.max(0.001, sx), Math.max(0.001, sy), Math.max(0.001, sz))
  m.position.set(x, y, z)
  if (ry) m.rotation.y = ry
  m.castShadow = true
  m.receiveShadow = true
  return m
}

function cyl(
  mat: THREE.Material,
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  geo: THREE.BufferGeometry = UNIT_CYL,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.scale.set(Math.max(0.001, 2 * r), Math.max(0.001, h), Math.max(0.001, 2 * r))
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

// ---------------------------------------------------------------------------
// Category normalizer
// ---------------------------------------------------------------------------
export type FurnitureKind =
  | 'desk'
  | 'chair'
  | 'table'
  | 'sofa'
  | 'stool'
  | 'cabinet'
  | 'planter'
  | 'partition'
  | 'meetingroom'
  | 'default'

/**
 * Map a raw category / product name (imported or generated) to a canonical
 * furniture kind. Case-insensitive substring match, most-specific first so that
 * e.g. "Club Chair" → sofa (lounge) beats the generic "chair", and "Meeting
 * Room" → meetingroom beats "table". Also accepts the generated-editor canonical
 * keys ('Desk','Chair','Table','MeetingRoom','FallCeiling').
 */
export function normalizeFurnitureCategory(name: string): FurnitureKind {
  const s = (name ?? '').toLowerCase()
  // Rooms before tables ("meeting room" vs "meeting table").
  if (s.includes('meeting room') || s.includes('meetingroom') || s.includes('conference room')) {
    return 'meetingroom'
  }
  // Lounge seating before the generic "chair" ("club chair", "lounge chair").
  if (
    s.includes('sofa') ||
    s.includes('couch') ||
    s.includes('lounge') ||
    s.includes('banquette') ||
    s.includes('settee') ||
    s.includes('club')
  ) {
    return 'sofa'
  }
  // Stool / barstool before "chair".
  if (s.includes('stool')) return 'stool'
  if (s.includes('chair')) return 'chair'
  // Desk family.
  if (s.includes('desk') || s.includes('workstation') || s.includes('bench')) return 'desk'
  // Storage (no "pedestal" here — "Pedestal Table" must stay a table).
  if (
    s.includes('cabinet') ||
    s.includes('storage') ||
    s.includes('credenza') ||
    s.includes('shelf') ||
    s.includes('shelving') ||
    s.includes('locker')
  ) {
    return 'cabinet'
  }
  if (s.includes('planter') || s.includes('plant') || s.includes('pot ') || s === 'pot') return 'planter'
  if (
    s.includes('partition') ||
    s.includes('panel') ||
    s.includes('mullion') ||
    s.includes('glazed') ||
    s.includes('glazing') ||
    s.includes('screen') ||
    s.includes('divider')
  ) {
    return 'partition'
  }
  // "table" last so "meeting table" / "pedestal table" resolve here.
  if (s.includes('table')) return 'table'
  // Generated-editor canonical keys not caught above (FallCeiling → clean box).
  return 'default'
}

// ---------------------------------------------------------------------------
// Per-kind builders. Footprint w (X) × d (Z), base at y=0, centered at origin.
// ---------------------------------------------------------------------------
function buildDesk(w: number, d: number, top: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const topH = 0.74
  const t = 0.03
  g.add(box(top, w, t, d, 0, topH - t / 2, 0)) // worktop
  // 4 slim legs, inset from the corners.
  const ix = Math.max(0.04, w / 2 - 0.06)
  const iz = Math.max(0.04, d / 2 - 0.06)
  const legH = topH - t
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(cyl(MAT.darkLeg, 0.018, legH, sx * ix, legH / 2, sz * iz))
    }
  }
  // Monitor on a small stand near the back edge (-Z).
  const scrW = Math.min(0.55, Math.max(0.28, w * 0.42))
  const zBack = -d / 2 + Math.min(0.12, d * 0.18)
  g.add(box(MAT.metal, 0.16, 0.015, 0.11, 0, topH + 0.008, zBack)) // stand foot
  g.add(box(MAT.darkLeg, 0.035, 0.14, 0.035, 0, topH + 0.08, zBack)) // stem
  g.add(box(MAT.screen, scrW, 0.32, 0.02, 0, topH + 0.16, zBack - 0.02)) // screen
  return g
}

function buildChair(w: number, d: number, seat: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const seatH = 0.45
  const sw = w * 0.9
  const sd = d * 0.9
  g.add(box(seat, sw, 0.07, sd, 0, seatH, 0)) // seat pad
  g.add(box(MAT.fabricBody, sw, 0.42, 0.05, 0, seatH + 0.24, -sd / 2 + 0.03)) // backrest
  // Central stem + 5-star base.
  g.add(cyl(MAT.darkLeg, 0.028, seatH - 0.05, 0, (seatH - 0.05) / 2, 0))
  const legLen = Math.max(0.18, Math.min(w, d) * 0.5)
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5
    g.add(
      box(
        MAT.darkLeg,
        legLen,
        0.03,
        0.05,
        (Math.cos(a) * legLen) / 2,
        0.03,
        (Math.sin(a) * legLen) / 2,
        -a,
      ),
    )
  }
  return g
}

function buildTable(w: number, d: number, top: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const topH = 0.74
  const t = 0.04
  const aspect = w / Math.max(0.001, d)
  const round = aspect > 0.8 && aspect < 1.25
  if (round) {
    const r = Math.min(w, d) / 2
    g.add(cyl(top, r, t, 0, topH - t / 2, 0))
    // 4 legs inset on a circle.
    const rl = r * 0.72
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2
      g.add(cyl(MAT.darkLeg, 0.03, topH - t, Math.cos(a) * rl, (topH - t) / 2, Math.sin(a) * rl))
    }
  } else {
    g.add(box(top, w, t, d, 0, topH - t / 2, 0))
    const ix = Math.max(0.05, w / 2 - 0.08)
    const iz = Math.max(0.05, d / 2 - 0.08)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        g.add(cyl(MAT.darkLeg, 0.028, topH - t, sx * ix, (topH - t) / 2, sz * iz))
      }
    }
  }
  return g
}

function buildSofa(w: number, d: number, body: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  const armW = Math.min(0.16, w * 0.14)
  g.add(box(body, w, 0.34, d, 0, 0.17, 0)) // base body block
  // Seat cushion, nudged forward off the back.
  g.add(box(MAT.fabricSeat, w - 2 * armW - 0.04, 0.12, d - 0.22, 0, 0.4, 0.06))
  // Backrest.
  g.add(box(body, w, 0.42, 0.18, 0, 0.55, -d / 2 + 0.09))
  // Arms.
  g.add(box(body, armW, 0.44, d, -w / 2 + armW / 2, 0.22, 0))
  g.add(box(body, armW, 0.44, d, w / 2 - armW / 2, 0.22, 0))
  return g
}

function buildStool(w: number, d: number, seat: THREE.Material, seatH: number): THREE.Group {
  const g = new THREE.Group()
  const r = Math.min(w, d) / 2
  g.add(cyl(seat, r, 0.05, 0, seatH - 0.025, 0)) // round seat
  g.add(cyl(MAT.darkLeg, 0.026, seatH - 0.06, 0, (seatH - 0.06) / 2, 0)) // stem
  g.add(cyl(MAT.metal, r * 0.85, 0.03, 0, 0.015, 0)) // foot disc
  return g
}

function buildCabinet(w: number, d: number, body: THREE.Material, H: number): THREE.Group {
  const g = new THREE.Group()
  const kick = 0.08
  const topT = 0.03
  const bodyH = Math.max(0.1, H - kick - topT)
  g.add(box(MAT.darkLeg, w - 0.1, kick, d - 0.06, 0, kick / 2, 0)) // recessed toe kick
  g.add(box(body, w, bodyH, d, 0, kick + bodyH / 2, 0)) // carcass
  g.add(box(MAT.woodDark, w + 0.03, topT, d + 0.03, 0, H - topT / 2, 0)) // subtle top overhang
  // Two door handles.
  g.add(box(MAT.metal, 0.02, 0.12, 0.02, -w * 0.12, kick + bodyH * 0.6, d / 2 + 0.01))
  g.add(box(MAT.metal, 0.02, 0.12, 0.02, w * 0.12, kick + bodyH * 0.6, d / 2 + 0.01))
  return g
}

function buildPlanter(w: number, d: number): THREE.Group {
  const g = new THREE.Group()
  const r = Math.min(w, d) / 2
  const potH = Math.min(0.45, Math.max(0.2, r * 1.6))
  g.add(cyl(MAT.pot, r, potH, 0, potH / 2, 0, POT_CYL))
  // Low-poly foliage blob(s) above the pot.
  const fr = r * 0.95
  const foliage = new THREE.Mesh(BLOB, MAT.foliage)
  foliage.scale.set(fr * 2, fr * 1.8, fr * 2)
  foliage.position.set(0, potH + fr * 1.0, 0)
  foliage.castShadow = true
  foliage.receiveShadow = true
  g.add(foliage)
  // A smaller offset blob for an organic silhouette.
  g.add(cyl(MAT.foliage, fr * 0.55, fr * 1.1, r * 0.35, potH + fr * 0.7, -r * 0.2, BLOB))
  return g
}

function buildPartition(w: number, d: number, H: number, glazed: boolean): THREE.Group {
  const g = new THREE.Group()
  const th = Math.min(Math.max(0.03, d), 0.06)
  if (glazed) {
    // Glazed panel with dark side mullions + a base rail (semi-transparent glass).
    const post = 0.04
    g.add(box(MAT.darkLeg, post, H, th, -w / 2 + post / 2, H / 2, 0))
    g.add(box(MAT.darkLeg, post, H, th, w / 2 - post / 2, H / 2, 0))
    g.add(box(MAT.darkLeg, w, 0.06, th, 0, 0.03, 0)) // base rail
    const glass = box(MAT.glass, w - 2 * post, H - 0.06, th * 0.6, 0, H / 2 + 0.03, 0)
    glass.castShadow = false
    glass.receiveShadow = false
    g.add(glass)
  } else {
    g.add(box(MAT.panel, w, H, th, 0, H / 2, 0)) // solid tall panel
  }
  return g
}

function buildMeetingRoom(w: number, d: number): THREE.Group {
  const g = new THREE.Group()
  const tw = Math.max(0.8, w * 0.55)
  const td = Math.max(0.6, d * 0.42)
  g.add(buildTable(tw, td, MAT.laminate)) // central conference table
  // A ring of chairs facing the table (backs pointing outward).
  const cs = 0.5
  const zOff = td / 2 + 0.36
  const xOff = tw / 2 + 0.36
  const place = (x: number, z: number, ry: number) => {
    const c = buildChair(cs, cs, MAT.fabricSeat)
    c.position.set(x, 0, z)
    c.rotation.y = ry
    g.add(c)
  }
  place(-tw * 0.25, -zOff, 0) // back row (backrest already at -Z)
  place(tw * 0.25, -zOff, 0)
  place(-tw * 0.25, zOff, Math.PI) // front row
  place(tw * 0.25, zOff, Math.PI)
  if (xOff < w / 2) {
    place(-xOff, 0, Math.PI / 2) // left end
    place(xOff, 0, -Math.PI / 2) // right end
  }
  return g
}

function buildDefault(w: number, d: number, H: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group()
  g.add(box(mat, w, H, d, 0, H / 2, 0))
  return g
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------
const DEFAULT_HEIGHT: Record<FurnitureKind, number> = {
  desk: 0.74,
  chair: 0.45,
  table: 0.74,
  sofa: 0.8,
  stool: 0.66,
  cabinet: 0.8,
  planter: 0.6,
  partition: 1.6,
  meetingroom: 0.74,
  default: 0.75,
}

/**
 * Build recognizable parametric furniture for `category` (a raw imported/product
 * name OR a generated-editor canonical key). Returns a fresh THREE.Group whose
 * base sits on y=0 with footprint w (X) × d (Z). Geometry and materials are
 * shared across every instance for cheap 500+-piece scenes.
 *
 * Signature is fixed by the shared 3D-furniture contract — do not change it.
 */
export function buildFurniture3D(
  category: string,
  w: number,
  d: number,
  opts: Furniture3DOpts = {},
): THREE.Object3D {
  const W = Math.max(0.05, w)
  const D = Math.max(0.05, d)
  const kind = normalizeFurnitureCategory(category)
  const H = opts.height ?? DEFAULT_HEIGHT[kind]

  // opts.color tints the primary tone for that piece; otherwise use the shared
  // per-kind material (keeps the shared-material fast path for bulk scenes).
  const tint = opts.color != null
    ? new THREE.MeshStandardMaterial({ color: opts.color, roughness: 0.7, metalness: 0.05 })
    : null

  switch (kind) {
    case 'desk':
      return buildDesk(W, D, tint ?? MAT.wood)
    case 'chair':
      return buildChair(W, D, tint ?? MAT.fabricSeat)
    case 'table':
      return buildTable(W, D, tint ?? MAT.laminate)
    case 'sofa':
      return buildSofa(W, D, tint ?? MAT.fabricBody)
    case 'stool':
      return buildStool(W, D, tint ?? MAT.fabricSeat, H)
    case 'cabinet':
      return buildCabinet(W, D, tint ?? MAT.cabinet, H)
    case 'planter':
      return buildPlanter(W, D)
    case 'partition':
      return buildPartition(W, D, H, /glaz|glass/.test(category.toLowerCase()))
    case 'meetingroom':
      return buildMeetingRoom(W, D)
    default:
      return buildDefault(W, D, H, tint ?? MAT.default)
  }
}
