// DXF → Drawing importer.
//
// Pipeline (see docs/design/dwg-import.md):
//   dxf-parser → raw entities + block table
//   → recursively flatten every INSERT into world-space geometry
//     (translate by insert position, rotate by `rotation`° → rad, scale by
//      xScale/yScale, subtract the block base point; compose matrices for
//      nested INSERTs; depth-cap + cycle guard)
//   → tessellate ARC / CIRCLE / ELLIPSE / SPLINE and LWPOLYLINE arc-bulges
//     into polylines
//   → convert source units ($INSUNITS) to METERS
//   → categorize by AIA layer + block name
//   → Drawing (web/src/import/types.ts)
//
// Contract: all coordinates METERS, world-space, Y-up (DXF orientation);
// angles radians CCW. Matches web/src/import/types.ts exactly.

import DxfParser from 'dxf-parser'
import type { Category, DrawEntity, Drawing, FurnitureItem } from './types'

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/** Candidate source units, meters-per-unit. */
const UNIT_SCALE: Record<string, number> = {
  in: 0.0254,
  ft: 0.3048,
  mm: 0.001,
  cm: 0.01,
  dm: 0.1,
  m: 1,
}

/** $INSUNITS code → meters-per-unit. Defaults to inches (AutoCAD arch default). */
function metersPerUnit(insunits: unknown): { scale: number; label: string } {
  switch (Number(insunits)) {
    case 1:
      return { scale: 0.0254, label: 'in' } // inches
    case 2:
      return { scale: 0.3048, label: 'ft' } // feet
    case 4:
      return { scale: 0.001, label: 'mm' } // millimeters
    case 5:
      return { scale: 0.01, label: 'cm' } // centimeters
    case 6:
      return { scale: 1, label: 'm' } // meters
    case 14:
      return { scale: 0.1, label: 'dm' } // decimeters
    default:
      return { scale: 0.0254, label: 'in' }
  }
}

/**
 * How the drawing's scale was decided. `header` means $INSUNITS was confirmed
 * against the geometry; `header-unverified` means the drawing offered no
 * physical anchor and we took the header on trust — the one state that must
 * never be reported to the user as a certainty.
 */
export type UnitsSource = 'header' | 'door-anchor' | 'extent-anchor' | 'header-unverified'

/**
 * A door swing arc's radius IS the door leaf width, and that is 0.75–1.10 m in
 * every building code on earth (IBC 1010.1.1, NBC 2016 Part 4, DIN 18101).
 * Widened to 0.65–1.30 m for cupboard leaves and drafting slop.
 */
const DOOR_LEAF_MIN_M = 0.65
const DOOR_LEAF_MAX_M = 1.3

/**
 * A building's long side, used only when there are no doors to measure. The
 * band is deliberately generous: this anchor exists to catch a drawing that is
 * off by a factor of 25–1000, not to fine-tune a plausible one.
 */
const BUILDING_MIN_M = 3
const BUILDING_MAX_M = 1000

/**
 * Modal value within a ±5 % relative bin — the most-repeated radius, which on a
 * floor plan is the typical door, not an outlier hinge detail.
 */
function modalWithin(values: number[], rel = 0.05): number | null {
  if (values.length === 0) return null
  let best: number | null = null
  let bestN = 0
  for (const v of values) {
    let n = 0
    for (const x of values) if (Math.abs(x - v) <= v * rel) n++
    if (n > bestN) {
      bestN = n
      best = v
    }
  }
  return best
}

/**
 * Decide the drawing's real unit.
 *
 * $INSUNITS is metadata written by whoever last saved the DWG, and across the
 * validation corpus in `cad-validation/` it is frequently wrong: files declaring
 * millimetres whose doors are 0.855 units wide (i.e. metres — a 1 mm door as
 * read), and files declaring inches whose doors are 1.125 units wide (again
 * metres — a 29 mm door). Those drawings imported 25×–1000× too small, which
 * put every plate candidate under the 1 m² floor (no plate at all) or produced
 * a 2–7 m² "office" the generator could not place a single desk in.
 *
 * So the header is a CANDIDATE, and the geometry is the judge. We prefer an
 * anchor that is true by construction over one the file asserts about itself:
 *
 *   1. the modal door-swing arc radius must land in the legal leaf-width band;
 *   2. failing that, the drawing's long side must be a building.
 *
 * If the header's unit satisfies the anchor we keep it — a correct header is
 * the common case and must not be second-guessed. Only when it fails do we take
 * the unit that passes. With no anchor at all we keep the header and say so,
 * via `header-unverified`.
 */
function decideUnits(
  insunits: unknown,
  doorRadii: number[],
  extentSourceUnits: number,
): { scale: number; label: string; source: UnitsSource } {
  const header = metersPerUnit(insunits)

  const inBand = (v: number, s: number, lo: number, hi: number) => v * s >= lo && v * s <= hi
  // Prefer the header's own unit on ties, then larger units, so a drawing that
  // satisfies several candidates resolves the same way every run.
  const order = [header.label, ...Object.keys(UNIT_SCALE).filter((u) => u !== header.label)]

  const door = modalWithin(doorRadii)
  if (door != null && door > 0) {
    const fits = order.filter((u) => inBand(door, UNIT_SCALE[u], DOOR_LEAF_MIN_M, DOOR_LEAF_MAX_M))
    if (fits.length > 0) {
      const label = fits[0]
      return {
        scale: UNIT_SCALE[label],
        label,
        source: label === header.label ? 'header' : 'door-anchor',
      }
    }
    // Doors exist but match no unit — they are hinge/hardware detail arcs, not
    // leaves. Fall through rather than trust them.
  }

  if (extentSourceUnits > 0) {
    const fits = order.filter((u) =>
      inBand(extentSourceUnits, UNIT_SCALE[u], BUILDING_MIN_M, BUILDING_MAX_M),
    )
    if (fits.length > 0) {
      const label = fits[0]
      return {
        scale: UNIT_SCALE[label],
        label,
        source: label === header.label ? 'header' : 'extent-anchor',
      }
    }
  }

  return { ...header, source: 'header-unverified' }
}

/**
 * Door-swing radii and the raw extent, in SOURCE units, gathered before any
 * scale is chosen. Reads top-level entities and block definitions alike, since
 * on most real plans the door swing lives inside a block.
 */
function scaleEvidence(
  rawEntities: RawEntity[],
  blocks: Record<string, RawBlock>,
): { doorRadii: number[]; extent: number } {
  const doorRadii: number[] = []
  const xs: number[] = []
  const ys: number[] = []

  const note = (e: RawEntity) => {
    if (e.type === 'ARC' && typeof e.radius === 'number' && e.radius > 0) {
      if (categoryFor(e.layer ?? '') === 'door') doorRadii.push(e.radius)
    }
    for (const v of e.vertices ?? []) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue
      xs.push(v.x)
      ys.push(v.y)
    }
  }

  for (const e of rawEntities) note(e)
  for (const b of Object.values(blocks)) for (const e of b.entities ?? []) note(e)

  // Robust extent: the 2nd–98th percentile span, NOT min→max. Real exports
  // routinely carry a stray xref copy or a stranded vertex kilometres from the
  // plan — one corpus file spans 323 km on min→max and 17 m on its actual
  // drawing. A min→max extent hands this anchor an outlier and it then argues
  // for a unit 1000× off, which is exactly the failure it exists to prevent.
  const span = (vals: number[]): number => {
    if (vals.length === 0) return 0
    const s = [...vals].sort((a, b) => a - b)
    const lo = s[Math.floor(s.length * 0.02)]
    const hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.98))]
    return hi - lo
  }

  return { doorRadii, extent: Math.max(span(xs), span(ys)) }
}

// ---------------------------------------------------------------------------
// 2×3 affine matrix  [a, b, c, d, e, f]
//   maps (x, y) → (a·x + c·y + e,  b·x + d·y + f)
// ---------------------------------------------------------------------------

type Mat = [number, number, number, number, number, number]

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** A ∘ B — apply B first, then A. */
function mul(A: Mat, B: Mat): Mat {
  const [a, b, c, d, e, f] = A
  const [a2, b2, c2, d2, e2, f2] = B
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ]
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Effective linear scale (for radii, text heights). */
function scaleOf(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
}

/** Local transform of an INSERT: T(pos) ∘ R(rot) ∘ S(sx,sy) ∘ T(-base). */
function insertMatrix(insert: RawEntity, block: RawBlock | undefined): Mat {
  const px = insert.position?.x ?? 0
  const py = insert.position?.y ?? 0
  const rot = ((insert.rotation ?? 0) * Math.PI) / 180 // DXF group 50 is degrees
  const sx = insert.xScale ?? 1
  const sy = insert.yScale ?? 1
  const bx = block?.position?.x ?? 0
  const by = block?.position?.y ?? 0
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const T: Mat = [1, 0, 0, 1, px, py]
  const R: Mat = [cos, sin, -sin, cos, 0, 0]
  const S: Mat = [sx, 0, 0, sy, 0, 0]
  const Tb: Mat = [1, 0, 0, 1, -bx, -by]
  return mul(mul(mul(T, R), S), Tb)
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

/** Map an AIA-style layer name + block name to a semantic Category. */
/**
 * Layer-name vocabulary, multilingual.
 *
 * Real-world CAD is not authored to AIA/NCS in English. Across a 24-file
 * validation corpus (`cad-validation/`) the wall layers that actually appeared
 * were `MURO`, `MUROS`, `Muro1`, `MURO-PROY`, `MURO-ACTUALES` (es), `PARED`
 * (es), `MUR` (fr), `WAND` (de) — none of which the English-only patterns
 * matched, so 13 of 21 parsed files classified ≥ 70 % of their linework as
 * `other` and the plate tracer was handed no walls at all.
 *
 * Each entry is `[pattern, category]`, tested in order against the UPPERCASED
 * layer name. Order matters: dimensions and decoration come first because
 * their names often also contain a building-fabric word (`A-WALL-PATT` is
 * hatch, not wall; `MURO000F` on a HATCH layer is fill, not fabric).
 */
const LAYER_VOCAB: [RegExp, Category][] = [
  // --- Dimensions (their layers also contain ANNO) ---
  [/DIM|ACOT|COTA|BEMA/, 'dimension'],

  // --- Decoration and drafting furniture that is NOT building fabric ---
  // Trees, planting, hatch/fill patterns, cut lines, title blocks, area tags.
  // These are the "random elements" that wreck wall tracing: one corpus file
  // carries 5 761 entities on `TREE J 1 100` alone, and hatch layers put dense
  // parallel linework exactly where a wall detector looks for wall faces.
  [/^TREE|[-_ ]TREE|VEGET|JARD|PLANT|ARBOL|LANDSCAP/, 'annotation'],
  [/HATCH|^HAT$|[-_ ]PATT|RELLENO|TRAMA/, 'annotation'],
  [/^CUT |[-_ ]CUT[-_ ]|^CUT$|SEGMENTED/, 'annotation'],
  [/ANNO|TTLB|TEXT|TEXTO|AREA-IDEN|AREA\d|SCHD|NPLT|DEFPOINTS|LEYENDA|LEGEND/, 'annotation'],

  // --- Glazing / windows ---
  [/GLAZ|GLAZING|CURT|CWMG|MULLION|G-WINDOW|VENTAN|FINESTR|FENSTER|FENETRE|JANELA/, 'glazing'],

  // --- Doors ---
  [/(^|[-_ ])DOOR|PUERTA|PRTA|PORTA|TUER|PORTE|DOOR\d/, 'door'],

  // --- Walls, columns, stairs — the building fabric the plate is traced from ---
  [/WALL|MURO|MUROS|PARED|PARETE|^MUR[-_ 0-9]?|WAND|CASCO|SHELL/, 'wall'],
  [/COL(U|UMN)?[-_ 0-9]|^COL$|PILAR|PILLAR|SAULE/, 'wall'],
  [/RAILING|STAIR|ESCALERA|SCALA|TREPPE|BARANDA/, 'wall'],

  // --- Casework ---
  // The AIA discipline prefixes (`Q-`, `P-`, `E-`) are anchored to the start of
  // the name: unanchored they match anywhere, so any layer merely *containing*
  // "Q-" was silently classified casework (e.g. `ZZQQ-NOTHING`).
  [/CASE|CASEWORK|CUPBD|SPCQ|^Q-/, 'casework'],

  // --- Fixtures ---
  [/PLUMB|SANR|SAN-FIX|SAN_FIX|^P-|BANO|BAÑO|ASEO|WC\d/, 'fixture'],
  [/LITE|EQPM|^E-|LIGHT|ELEC|LUMIN/, 'fixture'],

  // --- Furniture ---
  [/FURN|MUEBLE|MUEBLES|MUEB|MOBILIARIO|^MOB[-_ 0-9]|^MOB$|MEBEL|ARREDI|MOBILIER|MOBEL/, 'furniture'],
]

/** Block-name patterns, applied when the layer name says nothing useful. */
const BLOCK_VOCAB: [RegExp, Category][] = [
  [/MULLION|GLAZED|CURTAIN|WINDOW|VENTANA/, 'glazing'],
  [/\bDOOR\b|PUERTA|PORTA/, 'door'],
  [/CUPBD|CASEWORK|COUNTERTOP|BOOKCASE/, 'casework'],
  [/SINK|FAUCET|TOILET|FRIDGE|DISHWASHER|OVEN|MICROWAVE|ESPRESSO|INODORO|LAVABO/, 'fixture'],
  [/SCONCE|TV|SCREEN|LOCKER/, 'fixture'],
  [/DESK|CHAIR|TABLE|SOFA|SILLA|MESA|ESCRITORIO/, 'furniture'],
]

function categoryFor(layer: string, blockName = ''): Category {
  const L = (layer || '').toUpperCase()
  const B = (blockName || '').toUpperCase()

  for (const [re, cat] of LAYER_VOCAB) if (re.test(L)) return cat
  for (const [re, cat] of BLOCK_VOCAB) if (re.test(B)) return cat

  return 'other'
}

// ---------------------------------------------------------------------------
// Name cleaning
// ---------------------------------------------------------------------------

/**
 * Turn a raw AutoCAD/Revit block name into a readable label.
 *   "Steelcase - Seating - SILQ - Task Chair - Task Chair-648411-Level 06 - Furniture"
 *     → "Steelcase Seating SILQ Task Chair"
 *   "System Panel - Glazed-935260-Level 06 - Furniture" → "System Panel Glazed"
 *   "WORKSTATIONS_BENCH- SINGLE - 5 X 2 FT FT - …-648372-Level 06 - Furniture"
 *     → "Workstations Bench Single 5 X 2 FT"
 */
function cleanName(raw: string): string {
  let s = raw || ''
  // Strip trailing "-<id>-Level 06 - Furniture" / "-V57-Level …" / "-<id>-FURNITURE PLAN".
  s = s.replace(/-(?:\d{3,}|V\d+)-(?:Level\b.*|FURNITURE\s+PLAN.*)$/i, '')
  s = s.replace(/-Level\s*\d+.*$/i, '')
  s = s.replace(/-\d{3,}$/i, '')

  // Collapse a doubled name "P - P" → "P".
  const parts = s.split(' - ').map((p) => p.trim())
  let seg = parts
  for (let i = 1; i < parts.length; i++) {
    if (parts.slice(0, i).join(' - ') === parts.slice(i).join(' - ')) {
      seg = parts.slice(0, i)
      break
    }
  }
  // Drop consecutive duplicate segments ("Task Chair - Task Chair").
  const dedup: string[] = []
  for (const p of seg) if (dedup[dedup.length - 1] !== p) dedup.push(p)
  s = dedup.join(' ')

  // Tidy punctuation/whitespace.
  s = s
    .replace(/[_]+/g, ' ')
    .replace(/\bFT\s+FT\b/gi, 'FT')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Title-case, but keep short all-caps acronyms (SILQ, TV, GE, FT) and
  // any token containing a digit as-is.
  s = s
    .split(' ')
    .map((w) => {
      if (!w) return w
      if (/\d/.test(w)) return w
      if (/^[A-Z]{2,5}$/.test(w)) return w // acronym
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    })
    .join(' ')

  return s || raw
}

// ---------------------------------------------------------------------------
// Tessellation
// ---------------------------------------------------------------------------

const ARC_STEP = Math.PI / 30 // ~6°

/** Sample a circular arc in local coords, then transform each point. */
function arcWorldPts(
  m: Mat,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): [number, number][] {
  let sweep = a1 - a0
  while (sweep <= 0) sweep += Math.PI * 2
  const n = Math.max(2, Math.ceil(sweep / ARC_STEP))
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n
    pts.push(apply(m, cx + r * Math.cos(t), cy + r * Math.sin(t)))
  }
  return pts
}

/** Tessellate an LWPOLYLINE/POLYLINE (with optional per-vertex bulges). */
function polylineWorldPts(
  m: Mat,
  verts: { x: number; y: number; bulge?: number }[],
  closed: boolean,
): [number, number][] {
  const pts: [number, number][] = []
  const n = verts.length
  if (n === 0) return pts
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const v0 = verts[i]
    const v1 = verts[(i + 1) % n]
    const bulge = v0.bulge || 0
    if (i === 0) pts.push(apply(m, v0.x, v0.y))
    if (Math.abs(bulge) > 1e-9) {
      // Bulge arc: center from the standard AutoCAD cotangent formula.
      const cot = (1 / bulge - bulge) / 2
      const cx = (v0.x + v1.x) / 2 - (cot * (v1.y - v0.y)) / 2
      const cy = (v0.y + v1.y) / 2 + (cot * (v1.x - v0.x)) / 2
      const r = Math.hypot(v0.x - cx, v0.y - cy)
      const a0 = Math.atan2(v0.y - cy, v0.x - cx)
      const sweep = 4 * Math.atan(bulge)
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP))
      for (let s = 1; s <= steps; s++) {
        const t = a0 + (sweep * s) / steps
        pts.push(apply(m, cx + r * Math.cos(t), cy + r * Math.sin(t)))
      }
    } else {
      pts.push(apply(m, v1.x, v1.y))
    }
  }
  return pts
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

interface RawVec {
  x: number
  y: number
  z?: number
}
interface RawEntity {
  type: string
  layer?: string
  name?: string
  position?: RawVec
  /** TEXT stores its insertion point here (MTEXT uses `position`). */
  startPoint?: RawVec
  rotation?: number
  xScale?: number
  yScale?: number
  vertices?: { x: number; y: number; bulge?: number }[]
  center?: RawVec
  radius?: number
  startAngle?: number
  endAngle?: number
  majorAxisEndPoint?: RawVec
  axisRatio?: number
  shape?: boolean
  closed?: boolean
  text?: string
  height?: number
  controlPoints?: RawVec[]
  fitPoints?: RawVec[]
  [k: string]: unknown
}
interface RawBlock {
  name?: string
  position?: RawVec
  entities?: RawEntity[]
}

const MAX_DEPTH = 16

/**
 * Some Revit→DWG exports bake a block's geometry at absolute world
 * coordinates (its own base point stays 0,0) yet *also* give the INSERT a
 * stray rotation/position. Applying that transform pivots the already-placed
 * geometry about the origin and flings it thousands of meters away. Detect
 * such "world-baked" blocks — a physically small object whose geometry sits
 * far from the origin — and place them by identity, ignoring the spurious
 * insert transform. (A large object like the building-shell xref is *not*
 * world-baked: its geometry is local and genuinely needs the insert transform.)
 */
const bboxCache = new Map<string, { d: number; diag: number } | null>()
function blockPlacement(name: string, block: RawBlock): { d: number; diag: number } | null {
  let cached = bboxCache.get(name)
  if (cached !== undefined) return cached
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const e of block.entities ?? []) {
    if (e.type === 'INSERT') continue
    if (e.vertices) for (const v of e.vertices) acc(v.x, v.y)
    if (e.center) acc(e.center.x, e.center.y)
    if (e.position && e.type !== 'INSERT') acc(e.position.x, e.position.y)
  }
  cached = Number.isFinite(minX)
    ? {
        d: Math.hypot((minX + maxX) / 2, (minY + maxY) / 2),
        diag: Math.hypot(maxX - minX, maxY - minY),
      }
    : null
  bboxCache.set(name, cached)
  return cached
}
function isWorldBaked(name: string, block: RawBlock): boolean {
  const p = blockPlacement(name, block)
  // Far from origin (in source units) but physically small (< ~50 m ≈ 2000 in).
  return !!p && p.d > 5000 && p.diag < 2000
}

/**
 * Flatten one entity (recursing into INSERTs) into world-space DrawEntities.
 * `m` already carries the unit→meters scale and all ancestor transforms.
 */
function flatten(
  e: RawEntity,
  m: Mat,
  root: Mat,
  blocks: Record<string, RawBlock>,
  out: DrawEntity[],
  depth: number,
  seen: Set<string>,
): void {
  try {
    const layer = e.layer ?? '0'
    switch (e.type) {
      case 'INSERT': {
        if (depth >= MAX_DEPTH || !e.name || seen.has(e.name)) return
        const block = blocks[e.name]
        if (!block?.entities) return
        // World-baked geometry is already in absolute world coords, so it takes
        // ONLY the unit→meters root scale — never the accumulated ancestor
        // transform (which would double-place it).
        const childM = isWorldBaked(e.name, block) ? root : mul(m, insertMatrix(e, block))
        const nextSeen = new Set(seen)
        nextSeen.add(e.name)
        for (const child of block.entities) {
          flatten(child, childM, root, blocks, out, depth + 1, nextSeen)
        }
        return
      }
      case 'LINE': {
        const v = e.vertices ?? []
        if (v.length < 2) return
        out.push({
          kind: 'polyline',
          layer,
          category: categoryFor(layer),
          pts: [apply(m, v[0].x, v[0].y), apply(m, v[1].x, v[1].y)],
        })
        return
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const verts = (e.vertices ?? []).filter((v) => v && Number.isFinite(v.x))
        if (verts.length < 2) return
        const closed = !!(e.closed || e.shape)
        const pts = polylineWorldPts(m, verts, closed)
        if (pts.length >= 2)
          out.push({ kind: 'polyline', layer, category: categoryFor(layer), pts, closed })
        return
      }
      case 'ARC': {
        if (!e.center || e.radius == null) return
        const pts = arcWorldPts(
          m,
          e.center.x,
          e.center.y,
          e.radius,
          e.startAngle ?? 0,
          e.endAngle ?? Math.PI * 2,
        )
        out.push({ kind: 'polyline', layer, category: categoryFor(layer), pts })
        return
      }
      case 'CIRCLE': {
        if (!e.center || e.radius == null) return
        const pts = arcWorldPts(m, e.center.x, e.center.y, e.radius, 0, Math.PI * 2)
        out.push({ kind: 'polyline', layer, category: categoryFor(layer), pts, closed: true })
        return
      }
      case 'ELLIPSE': {
        if (!e.center || !e.majorAxisEndPoint) return
        const mx = e.majorAxisEndPoint.x
        const my = e.majorAxisEndPoint.y
        const major = Math.hypot(mx, my)
        const ratio = e.axisRatio ?? 1
        const phi = Math.atan2(my, mx)
        const a0 = e.startAngle ?? 0
        let a1 = e.endAngle ?? Math.PI * 2
        if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + Math.PI * 2
        let sweep = a1 - a0
        while (sweep <= 0) sweep += Math.PI * 2
        const n = Math.max(8, Math.ceil(sweep / ARC_STEP))
        const cosP = Math.cos(phi)
        const sinP = Math.sin(phi)
        const pts: [number, number][] = []
        for (let i = 0; i <= n; i++) {
          const t = a0 + (sweep * i) / n
          const lx = major * Math.cos(t)
          const ly = major * ratio * Math.sin(t)
          pts.push(apply(m, e.center.x + lx * cosP - ly * sinP, e.center.y + lx * sinP + ly * cosP))
        }
        out.push({ kind: 'polyline', layer, category: categoryFor(layer), pts })
        return
      }
      case 'SPLINE': {
        const cp = e.fitPoints?.length ? e.fitPoints : e.controlPoints
        if (!cp || cp.length < 2) return
        const pts = cp.map((p) => apply(m, p.x, p.y))
        out.push({ kind: 'polyline', layer, category: categoryFor(layer), pts })
        return
      }
      case 'TEXT':
      case 'MTEXT': {
        // dxf-parser puts TEXT's insertion point in `startPoint`; MTEXT in
        // `position`. Reading only `position` silently dropped every TEXT.
        const at = e.position ?? e.startPoint
        if (!at) return
        const [tx, ty] = apply(m, at.x, at.y)
        out.push({
          kind: 'text',
          layer,
          category: categoryFor(layer),
          text: typeof e.text === 'string' ? e.text : '',
          tx,
          ty,
          h: (e.height ?? 1) * scaleOf(m),
        })
        return
      }
      // DIMENSION, SOLID, HATCH, VIEWPORT, … → skipped as sheet noise.
      default:
        return
    }
  } catch {
    // Resilient: one bad entity never breaks the import.
  }
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function accumulateBounds(entities: DrawEntity[], b: [number, number, number, number]): void {
  for (const e of entities) {
    if (e.pts) {
      for (const [x, y] of e.pts) {
        if (x < b[0]) b[0] = x
        if (y < b[1]) b[1] = y
        if (x > b[2]) b[2] = x
        if (y > b[3]) b[3] = y
      }
    } else if (e.kind === 'text' && e.tx != null && e.ty != null) {
      if (e.tx < b[0]) b[0] = e.tx
      if (e.ty < b[1]) b[1] = e.ty
      if (e.tx > b[2]) b[2] = e.tx
      if (e.ty > b[3]) b[3] = e.ty
    }
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function entityCenter(e: DrawEntity): [number, number] | null {
  if (e.pts && e.pts.length) {
    let x = 0
    let y = 0
    for (const [px, py] of e.pts) {
      x += px
      y += py
    }
    return [x / e.pts.length, y / e.pts.length]
  }
  if (e.tx != null && e.ty != null) return [e.tx, e.ty]
  return null
}

/**
 * Real-world CAD exports sometimes carry a mirrored/xref duplicate of the plan
 * thousands of meters away (this sample has ~100 mirror-copied furniture blocks
 * plus stray plumbing at negative-X). Keep only the dominant spatial cluster so
 * one artifact copy can't blow up the bounds or the fit-to-view. The threshold
 * is relative (median distance × factor), so it never clips a genuinely large
 * but contiguous drawing.
 */
function keepDominantCluster(
  entities: DrawEntity[],
  furniture: FurnitureItem[],
): { entities: DrawEntity[]; furniture: FurnitureItem[] } {
  const centers: [number, number][] = []
  const eCenter = entities.map((e) => entityCenter(e))
  for (const c of eCenter) if (c) centers.push(c)
  const fCenter = furniture.map(
    (f): [number, number] => [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2],
  )
  for (const c of fCenter) centers.push(c)
  if (centers.length < 20) return { entities, furniture }

  const medX = median(centers.map((c) => c[0]))
  const medY = median(centers.map((c) => c[1]))
  const dist = (c: [number, number]) => Math.hypot(c[0] - medX, c[1] - medY)
  const md = median(centers.map(dist))
  const threshold = Math.max(60, md * 20) // meters

  return {
    entities: entities.filter((_, i) => {
      const c = eCenter[i]
      return !c || dist(c) <= threshold
    }),
    furniture: furniture.filter((_, i) => dist(fCenter[i]) <= threshold),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Categories whose top-level INSERT becomes a selectable FurnitureItem. */
const ITEM_CATEGORIES = new Set<Category>(['furniture', 'casework', 'fixture', 'glazing', 'door'])

export function parseDrawing(dxfText: string): Drawing {
  const dxf = new DxfParser().parseSync(dxfText) as unknown as {
    header?: Record<string, unknown>
    entities?: RawEntity[]
    blocks?: Record<string, RawBlock>
    tables?: { layer?: { layers?: Record<string, unknown> } }
  }

  const blocks = dxf.blocks ?? {}
  const rawEntities = dxf.entities ?? []

  // Scale is decided from the geometry, with $INSUNITS as the candidate — see
  // decideUnits(). This must happen before anything is flattened, because the
  // root matrix carries the unit→meters scale into every transform.
  const evidence = scaleEvidence(rawEntities, blocks)
  const { scale, label, source: unitsSource } = decideUnits(
    dxf.header?.$INSUNITS,
    evidence.doorRadii,
    evidence.extent,
  )
  const root: Mat = [scale, 0, 0, scale, 0, 0] // world inches/mm → meters

  const layers = Object.keys(dxf.tables?.layer?.layers ?? {})
  const entities: DrawEntity[] = []
  const furniture: FurnitureItem[] = []
  let nextId = 1

  for (const e of rawEntities) {
    try {
      if (e.type === 'INSERT') {
        const cat = categoryFor(e.layer ?? '0', e.name ?? '')
        // Sheet noise: title-blocks / viewports / dims / paperspace → drop.
        if (cat === 'annotation' || cat === 'dimension') continue

        const flat: DrawEntity[] = []
        flatten(e, root, root, blocks, flat, 0, new Set())
        if (flat.length === 0) continue

        if (ITEM_CATEGORIES.has(cat)) {
          // A real placed block instance → selectable furniture item.
          const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
          accumulateBounds(flat, bbox)
          if (!Number.isFinite(bbox[0])) continue
          // World-baked blocks ignore the (spurious) insert transform, so their
          // real origin/rotation are the geometry's, not the insert's.
          const block = blocks[e.name ?? '']
          const baked = block ? isWorldBaked(e.name ?? '', block) : false
          const origin: [number, number] = baked
            ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
            : apply(root, e.position?.x ?? 0, e.position?.y ?? 0)
          furniture.push({
            id: nextId++,
            name: cleanName(e.name ?? ''),
            raw: e.name ?? '',
            category: cat,
            bbox,
            origin,
            rotation: baked ? 0 : ((e.rotation ?? 0) * Math.PI) / 180,
            entities: flat,
          })
        } else {
          // Building shell / xref wrapper (walls, doors, casework in-place) →
          // flatten into the drawing's non-furniture geometry.
          for (const f of flat) entities.push(f)
        }
      } else {
        flatten(e, root, root, blocks, entities, 0, new Set())
      }
    } catch {
      // never throw on one bad top-level entity
    }
  }

  // Drop mirrored/xref duplicate geometry that sits far from the main plan.
  const kept = keepDominantCluster(entities, furniture)

  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  accumulateBounds(kept.entities, bounds)
  for (const f of kept.furniture) accumulateBounds(f.entities, bounds)
  if (!Number.isFinite(bounds[0])) {
    bounds[0] = bounds[1] = bounds[2] = bounds[3] = 0
  }

  return {
    units: label,
    unitsSource,
    bounds,
    layers,
    entities: kept.entities,
    furniture: kept.furniture,
  }
}
