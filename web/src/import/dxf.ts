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
export type UnitsSource =
  | 'header'
  | 'door-anchor'
  | 'wall-anchor'
  | 'extent-anchor'
  | 'header-unverified'

/**
 * A door swing arc's radius IS the door leaf width, and that is 0.75–1.10 m in
 * every building code on earth (IBC 1010.1.1, NBC 2016 Part 4, DIN 18101).
 * Widened to 0.65–1.30 m for cupboard leaves and drafting slop.
 */
const DOOR_LEAF_MIN_M = 0.65
const DOOR_LEAF_MAX_M = 1.3

/**
 * A wall is two parallel lines a wall-assembly's thickness apart. Partitions
 * run 75–150 mm, structural and party walls 200–400 mm; the band is widened at
 * both ends for furring, cavity walls and drafting slop.
 */
const WALL_THICKNESS_MIN_M = 0.05
const WALL_THICKNESS_MAX_M = 0.6

/**
 * A building's long side. Weakest anchor, used only when neither doors nor wall
 * pairs are measurable — a drawing's extent depends on how much sheet furniture
 * travelled with it, so it can only catch gross errors, not adjudicate close
 * calls.
 */
const BUILDING_MIN_M = 3
const BUILDING_MAX_M = 1000

/**
 * Perpendicular gaps between parallel, overlapping wall lines — the population
 * of candidate wall thicknesses, in SOURCE units.
 *
 * This is the anchor that settles the drawings the door anchor cannot. Several
 * corpus files declare inches and carry 100–1800 wall segments inside a "3.4 m"
 * extent: the extent alone cannot refute that (3.4 m clears the building floor)
 * but a building whose walls are 2.5 mm thick is not a building.
 *
 * Cost is bounded by sampling the longest segments — wall faces are long, and
 * pairing the longest few hundred finds the assembly thickness without going
 * quadratic over every hatch tick in the drawing.
 */
function wallPairGaps(segments: [number, number, number, number][]): number[] {
  const MAX_SAMPLE = 300
  const longest = segments
    .map((s) => ({ s, len: Math.hypot(s[2] - s[0], s[3] - s[1]) }))
    .filter((e) => e.len > 0)
    .sort((a, b) => b.len - a.len)
    .slice(0, MAX_SAMPLE)

  const gaps: number[] = []
  for (let i = 0; i < longest.length; i++) {
    const [ax0, ay0, ax1, ay1] = longest[i].s
    const alen = longest[i].len
    const ux = (ax1 - ax0) / alen
    const uy = (ay1 - ay0) / alen
    for (let j = i + 1; j < longest.length; j++) {
      const [bx0, by0, bx1, by1] = longest[j].s
      const blen = longest[j].len
      const vx = (bx1 - bx0) / blen
      const vy = (by1 - by0) / blen
      // Parallel within ~2°: |cross| small.
      if (Math.abs(ux * vy - uy * vx) > 0.035) continue
      // Perpendicular offset of b's start from a's infinite line.
      const gap = Math.abs((bx0 - ax0) * -uy + (by0 - ay0) * ux)
      if (gap <= 0) continue
      // They must overlap along the shared direction, else they are two
      // different walls that merely happen to be parallel.
      const t0 = (bx0 - ax0) * ux + (by0 - ay0) * uy
      const t1 = (bx1 - ax0) * ux + (by1 - ay0) * uy
      const lo = Math.min(t0, t1)
      const hi = Math.max(t0, t1)
      if (hi < alen * 0.25 || lo > alen * 0.75) continue
      // A wall's two faces are close relative to its length; anything much
      // further apart is the opposite side of a room, not the same wall.
      if (gap > alen * 0.5) continue
      gaps.push(gap)
    }
  }
  return gaps
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
 *   1. door-swing arc radii must land in the legal leaf-width band;
 *   2. gaps between parallel wall lines must be wall-assembly thicknesses;
 *   3. the drawing's long side must be a building.
 *
 * Each is a POPULATION, and each candidate unit is scored by what fraction of
 * each population it makes physical (see below). The header is scored first, so
 * a correct header — the common case — is kept on ties and never second-guessed.
 * With no measurable anchor at all we keep the header and say so, via
 * `header-unverified`.
 */
function decideUnits(
  insunits: unknown,
  evidence: ScaleEvidence,
): { scale: number; label: string; source: UnitsSource } {
  const header = metersPerUnit(insunits)

  const inBand = (v: number, s: number, lo: number, hi: number) => v * s >= lo && v * s <= hi
  // Prefer the header's own unit on ties, then larger units, so a drawing that
  // satisfies several candidates resolves the same way every run.
  const order = [header.label, ...Object.keys(UNIT_SCALE).filter((u) => u !== header.label)]

  // Each anchor is a POPULATION of measurements, and the question asked of a
  // candidate unit is what FRACTION of that population it makes physical.
  //
  // A modal point estimate was not good enough. Door layers carry hinge arcs,
  // handle arcs and radiused jambs alongside the leaf swings, and on several
  // corpus files the most-repeated radius is the hardware, not the door — one
  // file's modal "door" came out at 1 mm on 34 of 198 samples. Asking instead
  // "which unit puts the most of these arcs in the legal leaf band?" uses the
  // whole population, so a minority of hardware cannot outvote the doors.
  //
  // Weights reflect how hard each population is to fool: a door swing is
  // unambiguous; a wall gap can be mimicked by hatch spacing; an extent depends
  // on how much sheet furniture travelled with the plan.
  const wallGaps = wallPairGaps(evidence.wallSegments)
  const populations: [number[], number, number, UnitsSource, number][] = [
    [evidence.doorRadii, DOOR_LEAF_MIN_M, DOOR_LEAF_MAX_M, 'door-anchor', 3],
    [wallGaps, WALL_THICKNESS_MIN_M, WALL_THICKNESS_MAX_M, 'wall-anchor', 2],
    [evidence.extent > 0 ? [evidence.extent] : [], BUILDING_MIN_M, BUILDING_MAX_M, 'extent-anchor', 1],
  ]

  /** Fraction of a population this unit makes physical, or null if empty. */
  const support = (vals: number[], s: number, lo: number, hi: number): number | null => {
    if (vals.length === 0) return null
    let n = 0
    for (const v of vals) if (inBand(v, s, lo, hi)) n++
    return n / vals.length
  }

  // A unit must make a real share of a population physical to earn its weight.
  // Below this, the few that landed in band are coincidence.
  const MIN_SUPPORT = 0.15

  let bestLabel: string | null = null
  let bestScore = 0
  let bestSource: UnitsSource = 'header-unverified'
  for (const unit of order) {
    let score = 0
    let strongest: UnitsSource | null = null
    for (const [vals, lo, hi, source, weight] of populations) {
      const frac = support(vals, UNIT_SCALE[unit], lo, hi)
      if (frac == null || frac < MIN_SUPPORT) continue
      score += weight * frac
      if (strongest === null) strongest = source
    }
    // `order` puts the header first, so a strict > keeps the header on ties.
    if (score > bestScore) {
      bestScore = score
      bestLabel = unit
      bestSource = strongest ?? 'header-unverified'
    }
  }

  if (bestLabel == null) return { ...header, source: 'header-unverified' }
  return {
    scale: UNIT_SCALE[bestLabel],
    label: bestLabel,
    source: bestLabel === header.label ? 'header' : bestSource,
  }
}

interface ScaleEvidence {
  doorRadii: number[]
  /** Wall-category segments as [x0, y0, x1, y1], source units. */
  wallSegments: [number, number, number, number][]
  extent: number
}

/**
 * Grade the scale we settled on, by re-measuring the FINISHED drawing.
 *
 * The unit decision picks the best-supported candidate, but "best available"
 * is not "right": across the validation corpus several drawings land on a unit
 * that makes only a minority of their doors and walls physical, and today they
 * are indistinguishable from the ones we got right — they trace a plate, place
 * furniture and score well, all at (say) 30× the true size. Every area, cost
 * and m²/person figure downstream is then wrong, silently.
 *
 * So this asks the finished metres-space geometry the same question the
 * validation gate asks from outside: what fraction of the door swings are legal
 * doors, and what fraction of the wall pairs are legal wall assemblies? The
 * bands are the same external specifications used to choose the unit — they are
 * a statement about buildings, not about this drawing.
 *
 * `low` does NOT mean the import is unusable. It means the size is unconfirmed,
 * and nothing derived from it should be presented as a hard number.
 */
function assessScale(
  entities: DrawEntity[],
  furniture: FurnitureItem[],
  source: UnitsSource,
): { confidence: 'high' | 'low'; reason: string } {
  // No anchor was measurable at all — we took the header on trust and said so.
  if (source === 'header-unverified') {
    return {
      confidence: 'low',
      reason:
        'this drawing has no doors or wall pairs to measure, so its size is taken from the file’s own units setting and could not be checked',
    }
  }

  const ev = scaleEvidence(entities, furniture)
  const share = (vals: number[], lo: number, hi: number): number | null =>
    vals.length === 0 ? null : vals.filter((v) => v >= lo && v <= hi).length / vals.length

  const doors = share(ev.doorRadii, DOOR_LEAF_MIN_M, DOOR_LEAF_MAX_M)
  const walls = share(wallPairGaps(ev.wallSegments), WALL_THICKNESS_MIN_M, WALL_THICKNESS_MAX_M)

  // Majority of either population physical → the size is corroborated.
  const MAJORITY = 0.5
  if ((doors != null && doors >= MAJORITY) || (walls != null && walls >= MAJORITY)) {
    return { confidence: 'high', reason: '' }
  }
  if (doors == null && walls == null) {
    return {
      confidence: 'low',
      reason:
        'this drawing has no doors or wall pairs to measure, so its size could not be checked',
    }
  }
  const pct = (v: number | null) => (v == null ? 'none' : `${Math.round(v * 100)}%`)
  return {
    confidence: 'low',
    reason:
      `at the size we read this drawing at, only ${pct(doors)} of its door swings are door-width ` +
      `and ${pct(walls)} of its wall pairs are wall-thickness — so the scale may be wrong, and every area below with it`,
  }
}

/** Multiply one entity's geometry by `s`, in place. Angles are unaffected. */
function scaleEntity(e: DrawEntity, s: number): void {
  if (e.pts) {
    for (const p of e.pts) {
      p[0] *= s
      p[1] *= s
    }
  }
  if (e.cx != null) e.cx *= s
  if (e.cy != null) e.cy *= s
  if (e.r != null) e.r *= s
  if (e.tx != null) e.tx *= s
  if (e.ty != null) e.ty *= s
  if (e.h != null) e.h *= s
}

/**
 * Door-swing radii and the raw extent, in SOURCE units, gathered before any
 * scale is chosen. Reads top-level entities and block definitions alike, since
 * on most real plans the door swing lives inside a block.
 */
/**
 * Radius of the circle through three points, or null if they are collinear.
 *
 * Door swings arrive here as tessellated polylines — `flatten` turns every ARC
 * into one — so the radius has to be recovered from the curve rather than read
 * off a field. Recovering it geometrically is also what makes the measurement
 * world-space-correct: a swing inside a block scaled by its INSERT yields the
 * radius the building actually has, which reading `e.radius` off the raw entity
 * never would.
 */
function circleThrough(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): { cx: number; cy: number; r: number } | null {
  const ax = a[0]
  const ay = a[1]
  const bx = b[0]
  const by = b[1]
  const cx = c[0]
  const cy = c[1]
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return null // collinear: a straight polyline, not an arc
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  return Number.isFinite(r) && r > 0 ? { cx: ux, cy: uy, r } : null
}

/**
 * The radius of a polyline that really is a circular arc, else null.
 *
 * Fitting a circle through three points of *any* polyline always succeeds — a
 * door-layer rectangle, an L-shaped jamb and a leaf outline all yield a number,
 * and feeding those to the scale anchor drowns the real swings in noise. So the
 * fit is verified against every vertex: a tessellated arc has all of them on
 * the circle, and nothing else does.
 *
 * Closed polylines are rejected outright — a door swing is an open arc; a
 * closed one is a leaf, a knob or a column.
 */
function arcLikeRadius(pts: [number, number][], closed?: boolean): number | null {
  if (closed || pts.length < 5) return null
  const fit = circleThrough(pts[0], pts[pts.length >> 1], pts[pts.length - 1])
  if (!fit) return null
  const tol = fit.r * 0.02
  for (const [x, y] of pts) {
    if (Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r) > tol) return null
  }
  return fit.r
}

function scaleEvidence(entities: DrawEntity[], furniture: FurnitureItem[]): ScaleEvidence {
  const doorRadii: number[] = []
  const wallSegments: [number, number, number, number][] = []
  const xs: number[] = []
  const ys: number[] = []

  const note = (e: DrawEntity) => {
    if (e.category === 'door' && e.pts) {
      const r = arcLikeRadius(e.pts, e.closed)
      if (r != null) doorRadii.push(r)
    }
    if (e.pts) {
      if (e.category === 'wall') {
        for (let i = 0; i + 1 < e.pts.length; i++) {
          const [ax, ay] = e.pts[i]
          const [bx, by] = e.pts[i + 1]
          wallSegments.push([ax, ay, bx, by])
        }
      }
      for (const [x, y] of e.pts) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        xs.push(x)
        ys.push(y)
      }
    }
  }

  for (const e of entities) note(e)
  // Door and window blocks are placed as furniture items; their swings are the
  // best anchor a plan offers and must not be skipped just because the importer
  // classed the INSERT as an item rather than shell linework.
  for (const f of furniture) for (const e of f.entities) note(e)

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

  return { doorRadii, wallSegments, extent: Math.max(span(xs), span(ys)) }
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

  // Flatten in SOURCE UNITS (root = identity), decide the scale from the
  // flattened result, then scale once at the end.
  //
  // The scale evidence must be measured in world space, not in block-local
  // space. A block inserted at scale 100 has internal coordinates 100× smaller
  // than the building it draws, so reading door radii and wall gaps straight
  // out of block definitions measures the wrong thing — and on real plans most
  // doors and walls live inside blocks. Flattening first costs one pass and
  // makes every anchor read the geometry the user will actually see.
  const root: Mat = IDENTITY

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

  // Everything above is in source units. Decide what they are from the
  // flattened geometry, then convert to meters in one pass.
  const { scale, label, source: unitsSource } = decideUnits(
    dxf.header?.$INSUNITS,
    scaleEvidence(entities, furniture),
  )
  if (scale !== 1) {
    for (const e of entities) scaleEntity(e, scale)
    for (const f of furniture) {
      for (const e of f.entities) scaleEntity(e, scale)
      f.bbox = [f.bbox[0] * scale, f.bbox[1] * scale, f.bbox[2] * scale, f.bbox[3] * scale]
      f.origin = [f.origin[0] * scale, f.origin[1] * scale]
    }
  }

  // Drop mirrored/xref duplicate geometry that sits far from the main plan.
  // Runs AFTER scaling because its threshold floor is an absolute 60 m.
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
    scaleConfidence: assessScale(kept.entities, kept.furniture, unitsSource),
    bounds,
    layers,
    entities: kept.entities,
    furniture: kept.furniture,
  }
}
