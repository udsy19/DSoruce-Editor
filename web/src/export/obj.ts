// Mesh export: DocState -> Wavefront OBJ + MTL (hand-written, like our DXF /
// PDF / IFC exporters — no three.js OBJExporter, no npm deps).
//
// Geometry mirrors the IFC exporter's simplification: walls are boxes
// (length × thickness × WALL_HEIGHT, centered on the a→b midpoint, rotated to
// the a→b direction) and components are boxes (w × h footprint with a
// category-heuristic height). No floor plate — a plan without one still opens
// fine and stays lightweight.
//
// ── Coordinate mapping (plan → OBJ, documented reasoning) ───────────────────
// The editor plan is meters, X→right, Y→DOWN (screen convention). OBJ has no
// mandated axes, but the de-facto convention every viewer (Blender importer,
// MeshLab, macOS Quick Look, three.js OBJLoader) assumes is right-handed Y-UP.
// We therefore use the SAME mapping as three/Viewer3D.ts, which already
// renders this document Y-up and proves it visually correct:
//
//     OBJ (x, y, z) = (plan.x, elevation, plan.y)   —   plan Y → world Z,
//     plan rotation θ → yaw −θ about +Y.
//
// Why no mirror (unlike ifc.ts, which flips Y): mapping the plan onto the XZ
// ground plane is itself an orientation-preserving change of basis — the
// matrix for canvas-rotate(θ) on the Y-down plan and the matrix for
// rotate-about-+Y(−θ) restricted to the XZ plane are literally identical
// (see the ifc.ts header, which contrasts the two cases). A viewer's top-down
// view (looking along −Y, X right, +Z toward the bottom of the screen) then
// matches the editor canvas exactly: right-side-up, un-mirrored. IFC needed a
// mirror only because it puts the plan in the XY plane with +Y = north.
//
// ── File shape ──────────────────────────────────────────────────────────────
// One `o <name>` object per wall/component (name = label), `usemtl` per
// category, triangle faces only (maximal compatibility — some loaders still
// mis-fan concave or >4-gon faces), `v`/`vn` with GLOBAL 1-based indices,
// `f v//vn` (no texture coordinates). The .obj references `mtllib
// <basename>.mtl`; the MTL carries a small category palette.

import type { DocState } from '../editor/EditorCanvas'
import { triggerDownload } from './png'

// Same height heuristics as ifc.ts (duplicated because ifc.ts keeps them
// module-private and this change is scoped to this file; keep in sync).
/** Wall extrusion height (m). */
const WALL_HEIGHT = 2.7
/** Default wall thickness when the doc has a degenerate 0 (m). */
const WALL_THICKNESS_FALLBACK = 0.15
/** Box height per component category (m); others get DEFAULT_HEIGHT. */
const HEIGHTS: Record<string, number> = {
  Desk: 0.75,
  Chair: 0.9,
  Table: 0.75,
  MeetingRoom: 2.6, // simplified full-height translucent box
  FallCeiling: 0.1, // thin slab hung below the ceiling (BASE_Y lifts it)
}
/** Base elevation per category (m); FallCeiling hangs just below the ceiling. */
const BASE_Y: Record<string, number> = { FallCeiling: 2.4 }
const DEFAULT_HEIGHT = 0.75

// ---------------------------------------------------------------------------
// Materials — small palette keyed by category, `furnishing` as the fallback.
// ---------------------------------------------------------------------------

const CATEGORY_MTL: Record<string, string> = {
  Desk: 'desk',
  Table: 'desk',
  MeetingRoom: 'meeting',
}
const WALL_MTL = 'wall'
const DEFAULT_MTL = 'furnishing'

// newmtl blocks. Kd = diffuse, d = dissolve (1 opaque), illum 1 = diffuse
// shading without raytraced extras — the safest value across viewers.
const MTL_BLOCKS: Array<{ name: string; kd: [number, number, number]; d: number }> = [
  { name: WALL_MTL, kd: [0.62, 0.62, 0.64], d: 1 }, // neutral gray
  { name: 'desk', kd: [0.72, 0.53, 0.35], d: 1 }, // wood-ish
  { name: 'meeting', kd: [0.55, 0.68, 0.72], d: 0.4 }, // translucent room volume
  { name: DEFAULT_MTL, kd: [0.75, 0.73, 0.7], d: 1 }, // warm neutral fallback
]

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

// Coordinate with sub-millimetre precision, no float noise, never NaN/-0.
function f(n: number): string {
  if (!Number.isFinite(n) || Object.is(n, -0)) n = 0
  return n.toFixed(4)
}

// A safe `o`/`usemtl` token: OBJ names end at whitespace, so collapse it to
// '_' and drop non-printable/non-ASCII bytes.
function objName(source: string): string {
  const clean = source
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\x21-\x7e]/g, '')
  return clean.length > 0 ? clean : 'Object'
}

// ---------------------------------------------------------------------------
// Box mesh emission
// ---------------------------------------------------------------------------

// Local footprint corner order (plan space, before rotation): the same
// [-hw,-hh] → [hw,-hh] → [hw,hh] → [-hw,hh] loop dxf.ts's rectCorners uses.
const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

// Quad faces of the box as [local vertex indices (0-3 bottom, 4-7 top),
// local normal index]. Winding is CCW seen from OUTSIDE (verified by signed
// volume in the node test), which is the OBJ front-face convention.
// Normal order: 0 bottom(−Y), 1 top(+Y), then the side whose outward normal
// is local −Z, +X, +Z, −X (plan −y, +x, +y, −x before rotation).
const QUADS: Array<[[number, number, number, number], number]> = [
  [[0, 1, 2, 3], 0], // bottom, −Y
  [[7, 6, 5, 4], 1], // top, +Y
  [[1, 0, 4, 5], 2], // side −Z
  [[2, 1, 5, 6], 3], // side +X
  [[3, 2, 6, 7], 4], // side +Z
  [[0, 3, 7, 4], 5], // side −X
]
// Local (nx, nz) of the four side normals, same order as above.
const SIDE_NORMALS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

class ObjWriter {
  private lines: string[] = []
  private vCount = 0
  private vnCount = 0

  constructor(mtllib: string) {
    this.lines.push(
      '# DSource Editor OBJ export — meters, Y-up (plan X→x, plan Y→z)',
      `mtllib ${mtllib}`,
    )
  }

  /** Emit one axis-aligned-then-yawed box: footprint w×d (plan meters)
   *  centered at plan (cx, cyPlan), base elevation y0, height, plan rotation
   *  θ (canvas clockwise). 8 v + 6 vn + 12 triangular f. */
  box(
    name: string,
    mtl: string,
    cx: number,
    cyPlan: number,
    y0: number,
    w: number,
    d: number,
    height: number,
    theta: number,
  ): void {
    const hw = w / 2
    const hd = d / 2
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)

    this.lines.push(`o ${objName(name)}`, `usemtl ${mtl}`)

    // 8 vertices: 4 bottom then 4 top, corners rotated with the canvas matrix
    // (identical to rotate-about-+Y(−θ) on the XZ plane — see header).
    for (const y of [y0, y0 + height]) {
      for (const [sx, sz] of CORNERS) {
        const lx = sx * hw
        const lz = sz * hd
        this.lines.push(
          `v ${f(cx + lx * cos - lz * sin)} ${f(y)} ${f(cyPlan + lx * sin + lz * cos)}`,
        )
      }
    }

    // 6 normals: ±Y plus the four yawed side normals.
    this.lines.push('vn 0.0000 -1.0000 0.0000', 'vn 0.0000 1.0000 0.0000')
    for (const [nx, nz] of SIDE_NORMALS) {
      this.lines.push(`vn ${f(nx * cos - nz * sin)} 0.0000 ${f(nx * sin + nz * cos)}`)
    }

    // 12 triangles (each quad split a,b,c + a,c,d), global 1-based indices.
    const vBase = this.vCount + 1
    const nBase = this.vnCount + 1
    for (const [[a, b, c, d2], n] of QUADS) {
      const vn = nBase + n
      this.lines.push(
        `f ${vBase + a}//${vn} ${vBase + b}//${vn} ${vBase + c}//${vn}`,
        `f ${vBase + a}//${vn} ${vBase + c}//${vn} ${vBase + d2}//${vn}`,
      )
    }

    this.vCount += 8
    this.vnCount += 6
  }

  body(): string {
    return this.lines.join('\n') + '\n'
  }
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

/** Build OBJ + MTL text from a document state. The .obj references
 *  `mtllib <basename>.mtl`, so save the MTL next to it under that name. */
export function docStateToOBJ(
  state: DocState,
  basename = 'dsource-plan',
): { obj: string; mtl: string } {
  const w = new ObjWriter(`${basename}.mtl`)

  // Walls: length×thickness footprint centered on the a→b midpoint, yawed to
  // the a→b direction (plan-space angle; the writer handles the Y-up map).
  state.walls.forEach((wall, i) => {
    const dx = wall.b.x - wall.a.x
    const dy = wall.b.y - wall.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return // zero-length wall: no valid box
    w.box(
      `Wall_${i + 1}`,
      WALL_MTL,
      (wall.a.x + wall.b.x) / 2,
      (wall.a.y + wall.b.y) / 2,
      0,
      len,
      wall.thickness > 0 ? wall.thickness : WALL_THICKNESS_FALLBACK,
      WALL_HEIGHT,
      Math.atan2(dy, dx),
    )
  })

  // Components: w×h footprint, category-heuristic height and material.
  for (const c of state.components) {
    if (!(c.w > 0) || !(c.h > 0)) continue // degenerate footprint: skip
    w.box(
      c.label || c.category,
      CATEGORY_MTL[c.category] ?? DEFAULT_MTL,
      c.x,
      c.y,
      BASE_Y[c.category] ?? 0,
      c.w,
      c.h,
      HEIGHTS[c.category] ?? DEFAULT_HEIGHT,
      c.rotation,
    )
  }

  const mtl = [
    '# DSource Editor material palette',
    ...MTL_BLOCKS.map(
      (m) =>
        `newmtl ${m.name}\nKa ${m.kd.map(f).join(' ')}\nKd ${m.kd.map(f).join(' ')}\nd ${f(m.d)}\nillum 1`,
    ),
    '',
  ].join('\n')

  return { obj: w.body(), mtl }
}

/** Build OBJ + MTL for a document state and trigger both downloads. */
export function downloadOBJ(state: DocState, basename = 'dsource-plan'): void {
  const { obj, mtl } = docStateToOBJ(state, basename)
  triggerDownload(new Blob([obj], { type: 'model/obj' }), `${basename}.obj`)
  triggerDownload(new Blob([mtl], { type: 'model/mtl' }), `${basename}.mtl`)
}
