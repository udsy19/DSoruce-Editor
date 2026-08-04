import * as THREE from 'three'

// Shared 3D-furniture contract. `buildFurniture3D` returns an Object3D sitting on
// the floor (y=0 at its base), centered on X/Z, sized to fit within a w (X) × d (Z)
// footprint, for a given category. Used by the plan viewer (`Viewer3D`) and the
// section renderer (`sectionRender`).
//
// Models are Revit/Laiout-grade parametric procedural geometry — every part is a
// mesh that SHARES a handful of module-level unit geometries + materials, so a
// 500-item plan stays cheap (no per-item geometry/material allocation). Imported
// product names (e.g. "Steelcase Seating SILQ Task Chair") are mapped to a canonical
// kind by `normalizeFurnitureCategory`.

export interface Furniture3DOpts {
  color?: number | string
  /** override height (m); else a per-category default */
  height?: number
}

// ── Canonical furniture kinds ────────────────────────────────────────────────
export type FurnitureKind =
  | 'desk'
  | 'chair'
  | 'table'
  | 'lounge'
  | 'stool'
  | 'bench'
  | 'cabinet'
  | 'planter'
  | 'partition'
  | 'glazed'
  | 'mullion'
  | 'meetingRoom'
  | 'fallCeiling'
  | 'door'
  | 'window'
  | 'column'
  | 'default'

/**
 * Map any category string — a catalog category ('Desk', 'MeetingRoom', …), a
 * canonical kind, or a raw imported product name ("Workstations BENCH Single 5 X 2
 * FT", "Zones Club Chair 5 Star Base", "System Panel Glazed", "Rectangular
 * Mullion") — to a canonical FurnitureKind. Idempotent.
 */
export function normalizeFurnitureCategory(name: string): FurnitureKind {
  const s = (name ?? '').toLowerCase()
  const has = (...k: string[]) => k.some((w) => s.includes(w))

  if (has('planter', 'plant', 'foliage')) return 'planter'
  if (has('door')) return 'door'
  if (has('window')) return 'window'
  if (has('column', 'pillar')) return 'column'
  if (has('mullion')) return 'mullion'
  if (has('glaz', 'glass')) return 'glazed' // "System Panel Glazed" → glazed wins over "panel"
  if (has('partition', 'panel', 'divider', 'screen')) return 'partition'
  if (has('fall ceiling', 'fallceiling', 'ceiling')) return 'fallCeiling'
  // Workstations are desks even when named "…BENCH…" — check before plain bench.
  if (has('workstation', 'worktop', 'desk')) return 'desk'
  if (has('sofa', 'banquette', 'couch', 'settee', 'loveseat', 'club', 'lounge', 'ottoman', 'tub', 'armchair'))
    return 'lounge'
  if (has('stool')) return 'stool'
  if (has('meeting room', 'meetingroom', 'conference room')) return 'meetingRoom'
  if (has('bench')) return 'bench'
  if (has('task', 'silq', 'seating', 'chair')) return 'chair'
  if (has('conference', 'boardroom', 'table', 'credenza table', 'dining')) return 'table'
  if (has('cabinet', 'casework', 'storage', 'credenza', 'shelf', 'shelv', 'bookcase', 'wardrobe', 'locker', 'pedestal', 'drawer'))
    return 'cabinet'
  return 'default'
}

// ── Shared unit geometries (scaled per-part via mesh.scale) ──────────────────
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 20) // r=0.5,h=1 → scale by (diam,height,diam)
const BLOB = new THREE.IcosahedronGeometry(0.5, 1) // organic foliage lump, r=0.5

// ── Procedural texture kit ───────────────────────────────────────────────────
// Small canvas-generated textures created ONCE at module scope and shared by
// every material (and by `Viewer3D` via `TEXTURES`) — no network assets,
// no per-item allocation. Color maps are sRGB; roughness/bump maps stay linear.

const TEX_SIZE = 256

/** Deterministic PRNG so the kit is identical every load (and across derived maps). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeTexture(
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  opts: { srgb?: boolean; repeat?: number } = {},
): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = TEX_SIZE
  const ctx = c.getContext('2d')!
  draw(ctx, TEX_SIZE)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace
  if (opts.repeat) t.repeat.set(opts.repeat, opts.repeat)
  return t
}

/**
 * Two-tone oak grain: horizontal streak bands + a few thin wavy grain lines.
 * Runs with a fixed seed so the color map and the derived roughness map draw
 * the SAME grain — palette maps [base, lightStreak, darkStreak, grainLine].
 */
function drawWoodGrain(ctx: CanvasRenderingContext2D, s: number, palette: [string, string, string, string]) {
  const rnd = mulberry32(0x00d5ea)
  const [base, light, dark, line] = palette
  ctx.fillStyle = base
  ctx.fillRect(0, 0, s, s)
  // broad tonal streak bands (full width → tiles seamlessly in X)
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = rnd() < 0.5 ? light : dark
    ctx.globalAlpha = 0.05 + rnd() * 0.14
    ctx.fillRect(0, rnd() * s, s, 1 + rnd() * 4)
  }
  // thin wavy grain lines
  ctx.globalAlpha = 1
  ctx.strokeStyle = line
  ctx.lineWidth = 0.7
  for (let i = 0; i < 22; i++) {
    const y = rnd() * s
    const amp = 1 + rnd() * 3
    ctx.globalAlpha = 0.18 + rnd() * 0.25
    ctx.beginPath()
    ctx.moveTo(0, y)
    for (let x = 0; x <= s; x += 16) ctx.lineTo(x, y + Math.sin((x / s) * Math.PI * (2 + rnd() * 2)) * amp)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/** Per-pixel fabric weave: fine cross-hatch + noise. Contrast in [-c, +c] around base. */
function drawWeave(ctx: CanvasRenderingContext2D, s: number, base: number, c: number) {
  const rnd = mulberry32(0xfab41c)
  const img = ctx.createImageData(s, s)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const hatch = ((x % 4 < 2 ? 1 : -1) + (y % 4 < 2 ? 1 : -1)) * c * 0.35
      const v = Math.max(0, Math.min(255, base + hatch + (rnd() - 0.5) * c))
      const i = (y * s + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

const TEX = {
  /** Two-tone oak color map (sRGB). Worktops, cabinet caps, doors, casework. */
  wood: makeTexture((ctx, s) => drawWoodGrain(ctx, s, ['#d8c4a2', '#eadbbe', '#b39062', '#8a6a44']), {
    srgb: true,
  }),
  /** Derived wood roughness: grain lines darker → glossier along the grain. */
  woodRough: makeTexture((ctx, s) => drawWoodGrain(ctx, s, ['#f0f0f0', '#fafafa', '#c9c9c9', '#8f8f8f'])),
  /** Near-white weave color map (sRGB) — tinted by each material's color. */
  fabric: makeTexture((ctx, s) => drawWeave(ctx, s, 228, 22), { srgb: true, repeat: 3 }),
  /** Higher-contrast weave used as a tiny-scale bump map. */
  fabricBump: makeTexture((ctx, s) => drawWeave(ctx, s, 128, 90), { repeat: 3 }),
  /** Speckled low-contrast carpet (sRGB), near-white so floor color tints it. */
  carpet: makeTexture((ctx, s) => {
    const rnd = mulberry32(0xca39e7)
    ctx.fillStyle = '#e4e2de'
    ctx.fillRect(0, 0, s, s)
    for (let i = 0; i < 9000; i++) {
      const v = 210 + Math.floor(rnd() * 45)
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 5})`
      ctx.globalAlpha = 0.5 + rnd() * 0.5
      ctx.fillRect(rnd() * s, rnd() * s, 1.5, 1.5)
    }
    ctx.globalAlpha = 1
  }, { srgb: true }),
  /** Soft plaster/concrete blotches — roughness map for walls and planter pots. */
  plasterRough: makeTexture((ctx, s) => {
    const rnd = mulberry32(0x97a57e)
    ctx.fillStyle = '#e2e2e2'
    ctx.fillRect(0, 0, s, s)
    for (let i = 0; i < 70; i++) {
      const x = rnd() * s
      const y = rnd() * s
      const r = 10 + rnd() * 42
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      const v = 165 + Math.floor(rnd() * 55)
      g.addColorStop(0, `rgba(${v},${v},${v},${0.12 + rnd() * 0.2})`)
      g.addColorStop(1, `rgba(${v},${v},${v},0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }),
} as const

/** Shared procedural textures, reused by `Viewer3D` (walls/floor/doors/casework). */
export const TEXTURES: Readonly<Record<keyof typeof TEX, THREE.CanvasTexture>> = TEX

// ── Shared materials (natural furniture tones on cool content colors) ────────
const std = (color: number, roughness: number, metalness: number) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })

/**
 * Clearcoated oak — worktops, cabinet caps, door leaves, imported casework.
 * Color tints the shared grain map. Exported so the plan viewer shares the
 * same PBR recipe (create once per scene-build, not per item).
 */
export const woodPhysical = (color: number) =>
  new THREE.MeshPhysicalMaterial({
    color,
    map: TEX.wood,
    roughness: 0.55,
    roughnessMap: TEX.woodRough,
    metalness: 0.02,
    clearcoat: 0.25,
    clearcoatRoughness: 0.4,
  })

/** Sheened weave upholstery. Color tints the near-white fabric map. */
const fabricPhysical = (color: THREE.ColorRepresentation, roughness: number) =>
  new THREE.MeshPhysicalMaterial({
    color,
    map: TEX.fabric,
    bumpMap: TEX.fabricBump,
    bumpScale: 0.015,
    roughness,
    metalness: 0.0,
    sheen: 0.5,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xffffff),
  })

// Every shared material carries a stable `name`. It is the ONLY handle a
// consumer has for re-dressing this library into a different look — the render
// pack's `three/materialTheme.ts` walks a built model and swaps by name, so the
// qbiq palette can be applied without forking the geometry builders (and
// without mutating these module-level materials, which the live viewer shares).
const named = <T extends THREE.Material>(name: string, m: T): T => {
  m.name = name
  return m
}

const MAT = {
  laminate: named('laminate', woodPhysical(0xf2ead9)), // light oak worktop
  wood: named('wood', woodPhysical(0xcaa579)), // warmer cabinet-cap / door-leaf oak
  darkMetal: named('darkMetal', std(0x33373d, 0.35, 0.9)), // legs / frames
  alu: named('alu', std(0x9ca2a8, 0.35, 0.9)), // chair base, posts, handles
  shell: named('shell', std(0x25282d, 0.55, 0.15)), // chair back-shell, monitor housing
  fabric: named('fabric', fabricPhysical(0x5c6675, 0.9)), // default upholstery (cool slate)
  screen: named('screen', new THREE.MeshStandardMaterial({
    color: 0x0e1b24,
    roughness: 0.25,
    metalness: 0.0,
    emissive: 0x16303f,
    emissiveIntensity: 0.5,
  })),
  // Real refractive glass. `transparent` stays false — three renders transmission
  // in its own transmissive pass (default depthWrite). Panes are thin boxes, so
  // the default FrontSide is correct and `thickness` supplies the volume.
  glass: named('glass', new THREE.MeshPhysicalMaterial({
    color: 0xdfeef4,
    roughness: 0.05,
    metalness: 0.0,
    transmission: 0.85,
    thickness: 0.02,
    ior: 1.5,
    transparent: false,
  })),
  pot: named('pot', new THREE.MeshStandardMaterial({
    color: 0x8d8577,
    roughness: 0.9,
    roughnessMap: TEX.plasterRough,
    metalness: 0.02,
  })), // stone / concrete planter
  soil: named('soil', std(0x3a322b, 1.0, 0.0)),
  foliage: named('foliage', std(0x4f7a50, 0.85, 0.0)),
  foliageDark: named('foliageDark', std(0x3d6440, 0.95, 0.0)),
} as const

// Category-tint (opts.color) upholstery/body material, cached so identical colors
// share one material across the whole plan.
const accentCache = new Map<string, THREE.MeshPhysicalMaterial>()
function accent(color: number | string | undefined): THREE.MeshPhysicalMaterial {
  if (color === undefined || color === null) return MAT.fabric
  const key = String(color)
  let m = accentCache.get(key)
  if (!m) {
    m = named('accent', fabricPhysical(new THREE.Color(color as any), 0.88))
    accentCache.set(key, m)
  }
  return m
}

// ── Part helpers ─────────────────────────────────────────────────────────────
function part(
  g: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  px: number,
  py: number,
  pz: number,
  ry = 0,
  rx = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.scale.set(sx, sy, sz)
  m.position.set(px, py, pz)
  if (ry) m.rotation.y = ry
  if (rx) m.rotation.x = rx
  m.castShadow = true
  m.receiveShadow = true
  g.add(m)
  return m
}
const box = (
  g: THREE.Object3D,
  mat: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  px: number,
  py: number,
  pz: number,
  ry = 0,
  rx = 0,
) => part(g, UNIT_BOX, mat, sx, sy, sz, px, py, pz, ry, rx)
const cyl = (
  g: THREE.Object3D,
  mat: THREE.Material,
  diam: number,
  height: number,
  px: number,
  py: number,
  pz: number,
) => part(g, UNIT_CYL, mat, diam, height, diam, px, py, pz)

// ── Per-kind default worktop/body heights (opts.height overrides) ────────────
const KIND_H: Partial<Record<FurnitureKind, number>> = {
  desk: 0.74,
  table: 0.74,
  cabinet: 0.8,
  partition: 1.6,
  glazed: 1.6,
  mullion: 2.6,
  meetingRoom: 2.7,
  fallCeiling: 0.05,
  door: 2.1,
  window: 2.1, // glazing head height; sill fixed at 0.9
  column: 2.6, // full floor-to-slab height
  default: 0.75,
}
// Kinds whose proportions are intrinsic; opts.height scales the whole model in Y.
const INTRINSIC_H: Partial<Record<FurnitureKind, number>> = {
  chair: 1.0,
  stool: 0.66,
  bench: 0.45,
  lounge: 0.78,
  planter: 0.95,
}

/**
 * Elevation height (m) a category extrudes to — the SAME per-kind default
 * {@link buildFurniture3D} uses (KIND_H, then the intrinsic proportion), without
 * building the mesh. Single source of truth for the orthographic section
 * renderer's silhouette heights, so 2D sections and 3D massing never drift.
 */
export function furnitureHeight(category: string): number {
  const kind = normalizeFurnitureCategory(category)
  return KIND_H[kind] ?? INTRINSIC_H[kind] ?? 0.75
}

// ── Builders ─────────────────────────────────────────────────────────────────
function buildDesk(g: THREE.Object3D, w: number, d: number, h: number, acc: THREE.Material) {
  const top = h
  // worktop — thin slab + a slightly inset edge band for a beveled read
  box(g, MAT.laminate, w, 0.035, d, 0, top - 0.0175, 0)
  box(g, MAT.laminate, w - 0.04, 0.02, d - 0.04, 0, top - 0.045, 0)
  // panel-end supports (modern bench-desk leg)
  const legH = top - 0.04
  const ex = w / 2 - 0.05
  box(g, MAT.darkMetal, 0.035, legH, d * 0.82, ex, legH / 2, 0)
  box(g, MAT.darkMetal, 0.035, legH, d * 0.82, -ex, legH / 2, 0)
  // foot rails
  box(g, MAT.darkMetal, 0.045, 0.04, d * 0.9, ex, 0.02, 0)
  box(g, MAT.darkMetal, 0.045, 0.04, d * 0.9, -ex, 0.02, 0)
  // modesty panel (carries the category tint)
  box(g, acc, w * 0.86, 0.3, 0.02, 0, top - 0.2, -(d / 2 - 0.06))
  // monitor on a stand, near the back edge
  const mz = -d * 0.24
  const mon = new THREE.Group()
  box(mon, MAT.shell, 0.2, 0.012, 0.13, 0, 0.006, 0.02) // base
  box(mon, MAT.alu, 0.03, 0.2, 0.025, 0, 0.11, 0) // post
  box(mon, MAT.shell, 0.52, 0.31, 0.03, 0, 0.34, 0, 0, -0.07) // housing (slight tilt)
  box(mon, MAT.screen, 0.48, 0.27, 0.008, 0, 0.34, 0.017, 0, -0.07) // screen face
  mon.position.set(0, top + 0.001, mz)
  g.add(mon)
  // keyboard
  box(g, MAT.shell, Math.min(0.46, w * 0.5), 0.018, 0.15, 0, top + 0.01, d * 0.14)
  // CPU tower under the desk on larger desks
  if (w > 1.1) box(g, MAT.shell, 0.1, 0.36, 0.38, ex - 0.12, 0.18, d * 0.1)
}

function buildChair(g: THREE.Object3D, _w: number, _d: number, acc: THREE.Material) {
  // 5-star base on castors
  cyl(g, MAT.alu, 0.09, 0.05, 0, 0.055, 0) // hub
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const cx = Math.cos(a) * 0.15
    const cz = Math.sin(a) * 0.15
    box(g, MAT.alu, 0.3, 0.03, 0.05, cx, 0.03, cz, a) // spoke
    cyl(g, MAT.shell, 0.06, 0.05, Math.cos(a) * 0.28, 0.025, Math.sin(a) * 0.28) // castor
  }
  // gas cylinder post
  cyl(g, MAT.alu, 0.05, 0.4, 0, 0.26, 0)
  // seat pan + cushion
  box(g, MAT.shell, 0.46, 0.05, 0.46, 0, 0.44, 0)
  box(g, acc, 0.44, 0.08, 0.44, 0, 0.5, 0.01)
  // back frame + contoured backrest (reclined) + lumbar band
  box(g, MAT.shell, 0.05, 0.34, 0.05, 0, 0.62, -0.21, 0, 0.1)
  box(g, acc, 0.44, 0.44, 0.06, 0, 0.82, -0.24, 0, 0.12)
  box(g, MAT.shell, 0.46, 0.06, 0.07, 0, 0.66, -0.22, 0, 0.12) // lumbar rib
  // armrests
  for (const sx of [-1, 1]) {
    box(g, MAT.shell, 0.04, 0.16, 0.04, sx * 0.24, 0.58, -0.02) // upright
    box(g, MAT.shell, 0.05, 0.03, 0.22, sx * 0.24, 0.66, 0.02) // pad
  }
}

function buildLounge(g: THREE.Object3D, w: number, d: number, acc: THREE.Material) {
  const seatH = 0.42
  // body / plinth
  box(g, acc, w * 0.9, 0.28, d * 0.82, 0, 0.16, 0)
  // seat cushion(s) — split into two on wide (sofa) footprints
  const seatW = w * 0.82
  const cushions = w > 1.6 ? Math.round(w / 0.7) : 1
  const cw = seatW / cushions
  for (let i = 0; i < cushions; i++) {
    const cx = -seatW / 2 + cw / 2 + i * cw
    box(g, acc, cw - 0.03, 0.16, d * 0.62, cx, seatH, d * 0.05)
  }
  // back cushions
  for (let i = 0; i < cushions; i++) {
    const cx = -seatW / 2 + cw / 2 + i * cw
    box(g, acc, cw - 0.03, 0.4, 0.16, cx, seatH + 0.24, -(d / 2 - 0.14), 0, -0.08)
  }
  // arms
  for (const s of [-1, 1]) box(g, acc, 0.14, 0.4, d * 0.78, s * (w / 2 - 0.07), 0.34, 0)
  // feet
  const fx = w / 2 - 0.1
  const fz = d / 2 - 0.1
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, MAT.darkMetal, 0.05, 0.08, sx * fx, 0.04, sz * fz)
}

function buildTable(g: THREE.Object3D, w: number, d: number, h: number) {
  const top = h
  box(g, MAT.laminate, w, 0.04, d, 0, top - 0.02, 0)
  box(g, MAT.laminate, w - 0.05, 0.02, d - 0.05, 0, top - 0.05, 0)
  const small = Math.min(w, d) < 1.1
  if (small) {
    // pedestal
    cyl(g, MAT.alu, 0.14, top - 0.06, 0, (top - 0.06) / 2 + 0.03, 0)
    cyl(g, MAT.darkMetal, Math.min(w, d) * 0.55, 0.04, 0, 0.02, 0)
  } else {
    const lx = w / 2 - 0.12
    const lz = d / 2 - 0.12
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, MAT.darkMetal, 0.06, top - 0.04, 0.06, sx * lx, (top - 0.04) / 2, sz * lz)
    // stretcher rail down the long axis
    box(g, MAT.darkMetal, w - 0.3, 0.05, 0.05, 0, 0.1, 0)
  }
}

function buildCabinet(g: THREE.Object3D, w: number, d: number, h: number, acc: THREE.Material) {
  const toe = 0.06
  // recessed toe-kick
  box(g, MAT.darkMetal, w * 0.94, toe, d * 0.88, 0, toe / 2, 0)
  // body (category tint)
  box(g, acc, w, h - toe, d, 0, toe + (h - toe) / 2, 0)
  // top cap
  box(g, MAT.wood, w + 0.02, 0.03, d + 0.02, 0, h + 0.005, 0)
  // door split + vertical bar handles
  box(g, MAT.darkMetal, 0.01, h - toe - 0.06, 0.01, 0, toe + (h - toe) / 2, d / 2 + 0.001)
  for (const s of [-1, 1]) box(g, MAT.alu, 0.02, Math.min(0.24, h * 0.32), 0.02, s * 0.06, h * 0.55, d / 2 + 0.015)
}

function buildStool(g: THREE.Object3D, w: number, d: number, acc: THREE.Material) {
  const seatH = 0.64
  const diam = Math.min(w, d, 0.4)
  cyl(g, MAT.alu, diam * 0.85, 0.02, 0, 0.01, 0) // foot disc
  cyl(g, MAT.alu, 0.05, seatH - 0.04, 0, seatH / 2, 0) // post
  cyl(g, acc, diam, 0.07, 0, seatH, 0) // seat pad
}

function buildBench(g: THREE.Object3D, w: number, d: number, acc: THREE.Material) {
  const seatH = 0.44
  box(g, acc, w, 0.06, d, 0, seatH, 0) // upholstered slab
  const lx = w / 2 - 0.08
  const lz = d / 2 - 0.06
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, MAT.darkMetal, 0.05, seatH - 0.03, 0.05, sx * lx, (seatH - 0.03) / 2, sz * lz)
}

function buildPlanter(g: THREE.Object3D, w: number, d: number) {
  const potH = 0.34
  const potD = Math.min(w, d) * 0.82
  cyl(g, MAT.pot, potD * 0.82, potH, 0, potH / 2, 0) // tapered-look body
  cyl(g, MAT.pot, potD, 0.05, 0, potH - 0.02, 0) // rim
  cyl(g, MAT.soil, potD * 0.86, 0.03, 0, potH - 0.005, 0) // soil
  // foliage: a few overlapping lumps
  const base = potH + 0.02
  const spread = potD * 0.5
  const blobs: Array<[number, number, number, number, THREE.Material]> = [
    [0, base + 0.28, 0, 0.5, MAT.foliage],
    [spread * 0.5, base + 0.16, spread * 0.2, 0.36, MAT.foliageDark],
    [-spread * 0.45, base + 0.2, -spread * 0.3, 0.4, MAT.foliage],
    [spread * 0.1, base + 0.46, -spread * 0.1, 0.34, MAT.foliageDark],
    [-spread * 0.2, base + 0.4, spread * 0.35, 0.3, MAT.foliage],
  ]
  for (const [bx, by, bz, s, m] of blobs) part(g, BLOB, m, s, s * 1.15, s, bx, by, bz)
}

function buildPartition(g: THREE.Object3D, w: number, d: number, h: number, glazed: boolean, acc: THREE.Material) {
  const t = Math.min(d, 0.05)
  // frame: two posts + top & bottom rail
  const px = w / 2 - t / 2
  box(g, MAT.darkMetal, t, h, t, px, h / 2, 0)
  box(g, MAT.darkMetal, t, h, t, -px, h / 2, 0)
  box(g, MAT.darkMetal, w, t, t, 0, h - t / 2, 0)
  box(g, MAT.darkMetal, w, t, t, 0, t / 2, 0)
  // infill panel
  const infill = glazed ? MAT.glass : acc
  const pane = box(g, infill, w - t * 2, h - t * 2, t * 0.5, 0, h / 2, 0)
  if (glazed) pane.castShadow = false
}

function buildMullion(g: THREE.Object3D, w: number, d: number, h: number) {
  const t = Math.min(w, d, 0.08)
  box(g, MAT.darkMetal, t, h, t, 0, h / 2, 0)
  // slim glass panes flanking the mullion if there is width to spare
  if (w > t * 2.5) {
    const paneW = (w - t) / 2 - 0.005
    for (const s of [-1, 1]) {
      const pane = box(g, MAT.glass, paneW, h * 0.98, t * 0.35, s * (t / 2 + paneW / 2), h / 2, 0)
      pane.castShadow = false
    }
  }
}

// Door: wood-tone leaf panel inside a thin metal frame (jambs + head) with a
// bar handle. The footprint depth d is the leaf slab in the wall.
function buildDoor(g: THREE.Object3D, w: number, d: number, h: number) {
  const t = Math.min(d, 0.06)
  const jx = w / 2 - 0.02
  box(g, MAT.darkMetal, 0.04, h, t, -jx, h / 2, 0)
  box(g, MAT.darkMetal, 0.04, h, t, jx, h / 2, 0)
  box(g, MAT.darkMetal, w, 0.04, t, 0, h - 0.02, 0)
  box(g, MAT.wood, w - 0.1, h - 0.07, Math.min(t, 0.045), 0, (h - 0.07) / 2 + 0.005, 0)
  box(g, MAT.alu, 0.12, 0.02, 0.02, jx - 0.14, 1.02, t / 2 + 0.012)
}

// Window: translucent glazed pane between sill (~0.9) and head (h ≈ 2.1) in a
// slim aluminium frame. Reuses the shared glass material.
function buildWindow(g: THREE.Object3D, w: number, d: number, h: number) {
  const t = Math.min(d, 0.05)
  const sill = Math.min(0.9, h - 0.3)
  const glassH = h - sill
  box(g, MAT.alu, w, 0.05, t, 0, sill, 0)
  box(g, MAT.alu, w, 0.05, t, 0, h, 0)
  for (const s of [-1, 1]) box(g, MAT.alu, 0.04, glassH, t, s * (w / 2 - 0.02), sill + glassH / 2, 0)
  const pane = box(g, MAT.glass, w - 0.08, glassH - 0.05, t * 0.4, 0, sill + glassH / 2, 0)
  pane.castShadow = false
}

function buildMeetingRoom(g: THREE.Object3D, w: number, d: number, h: number) {
  const t = 0.06
  // glass enclosure — four translucent panes + a slim frame footprint
  const addPane = (pw: number, px: number, pz: number, ry: number) => {
    const pane = box(g, MAT.glass, pw, h, t, px, h / 2, pz, ry)
    pane.castShadow = false
  }
  addPane(w, 0, d / 2 - t / 2, 0)
  addPane(w, 0, -(d / 2 - t / 2), 0)
  addPane(d, w / 2 - t / 2, 0, Math.PI / 2)
  addPane(d, -(w / 2 - t / 2), 0, Math.PI / 2)
  // corner mullions + base/head frame
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, MAT.darkMetal, t, h, t, sx * (w / 2 - t / 2), h / 2, sz * (d / 2 - t / 2))
  box(g, MAT.darkMetal, w, t, d, 0, t / 2, 0)
}

function buildDefault(g: THREE.Object3D, w: number, d: number, h: number, acc: THREE.Material) {
  box(g, acc, w, h, d, 0, h / 2, 0)
}

// ── Public builder ───────────────────────────────────────────────────────────
export function buildFurniture3D(
  category: string,
  w: number,
  d: number,
  opts: Furniture3DOpts = {},
): THREE.Object3D {
  const kind = normalizeFurnitureCategory(category)
  const W = Math.max(0.05, w)
  const D = Math.max(0.05, d)
  const acc = accent(opts.color)
  const g = new THREE.Group()

  const h = opts.height ?? KIND_H[kind] ?? 0.75

  switch (kind) {
    case 'desk':
      buildDesk(g, W, D, opts.height ?? KIND_H.desk!, acc)
      break
    case 'chair':
      buildChair(g, W, D, acc)
      break
    case 'table':
      buildTable(g, W, D, opts.height ?? KIND_H.table!)
      break
    case 'lounge':
      buildLounge(g, W, D, acc)
      break
    case 'stool':
      buildStool(g, W, D, acc)
      break
    case 'bench':
      buildBench(g, W, D, acc)
      break
    case 'cabinet':
      buildCabinet(g, W, D, opts.height ?? KIND_H.cabinet!, acc)
      break
    case 'planter':
      buildPlanter(g, W, D)
      break
    case 'partition':
      buildPartition(g, W, D, h, false, acc)
      break
    case 'glazed':
      buildPartition(g, W, D, h, true, acc)
      break
    case 'mullion':
      buildMullion(g, W, D, h)
      break
    case 'meetingRoom':
      buildMeetingRoom(g, W, D, h)
      break
    case 'door':
      buildDoor(g, W, D, h)
      break
    case 'window':
      buildWindow(g, W, D, h)
      break
    case 'column':
      // full-height structural column — MAT.pot is the shared stone/concrete tone
      box(g, MAT.pot, W, h, D, 0, h / 2, 0)
      break
    case 'fallCeiling':
      box(g, accent(opts.color ?? 0xeef0f3), W, h, D, 0, h / 2, 0)
      break
    default:
      buildDefault(g, W, D, h, acc)
  }

  // Intrinsic-height kinds keep their built proportions; scale to opts.height if given.
  const intrinsic = INTRINSIC_H[kind]
  if (intrinsic && opts.height) g.scale.y = opts.height / intrinsic

  return g
}
