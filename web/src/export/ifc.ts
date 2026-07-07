// Open-BIM export: DocState -> minimal valid IFC (ISO-10303-21 STEP text).
//
// Hand-written like our DXF R12 and PDF 1.4 exporters (no ifc.js/web-ifc):
// a tiny SPF writer assigns #ids sequentially and one function per concept
// emits each entity, mirroring dxf.ts's helper-per-entity style.
//
// ── Schema choice: IFC2X3 (Coordination View 2.0) ─────────────────────────
// IFC2X3 CV2.0 remains the lowest common denominator every importer accepts —
// Revit, ArchiCAD, Solibri, BIMcollab, and the web viewers all predate-and-
// support it, while IFC4 import is still uneven in older toolchains. Nothing
// we emit (extruded rectangles + spatial tree) needs an IFC4 feature. The one
// cost is that IFC2X3 makes IfcOwnerHistory and a few placement attributes
// mandatory that IFC4 relaxed — handled below.
//
// ── Entity graph ───────────────────────────────────────────────────────────
//   IfcProject ─IfcRelAggregates→ IfcSite ─→ IfcBuilding ─→ IfcBuildingStorey
//   IfcProject.UnitsInContext = SI metre / m² / m³ / radian
//   IfcProject.RepresentationContexts = one 3D IfcGeometricRepresentationContext
//   wall      → IfcWall               (Body = IfcExtrudedAreaSolid of an
//   component → IfcFurnishingElement   IfcRectangleProfileDef, extruded +Z)
//   all elements ─IfcRelContainedInSpatialStructure→ the storey
// Plain IfcWall (not IfcWallStandardCase): StandardCase implies an Axis
// representation + IfcMaterialLayerSetUsage, which importers then validate;
// a plain IfcWall with a SweptSolid Body is unconditionally accepted.
// MeetingRoom is deliberately simplified to a translucent-box-sized
// IfcFurnishingElement (2.6 m high), NOT an IfcSpace — spaces need boundary
// semantics we don't model yet; a furnishing box round-trips everywhere.
//
// ── Coordinate mapping (plan → IFC, documented reasoning) ──────────────────
// The editor plan is meters, X→right, Y→DOWN (screen convention); IFC is
// right-handed Z-up with +Y = project north. To make the model in a BIM
// tool's plan view (X right, +Y up the screen) look exactly like the editor
// canvas — and screen-up ("north-ish") land on IFC +Y — we MIRROR the Y axis:
//
//     IFC (x, y, z) = (plan.x, −plan.y, elevation),  extrusion along +Z.
//
// Under that mirror F = diag(1,−1), a plan rotation matrix R(θ) conjugates to
// F·R(θ)·F = R(−θ), so every plan rotation θ becomes −θ about IFC +Z, and a
// wall direction (dx, dy) becomes (dx, −dy). This is the same visual result
// as three/Viewer3D.ts's `rotation.y = -c.rotation` — but note the analogy
// holds for a different reason there: Viewer3D maps plan Y → world Z with NO
// mirror (the matrices for canvas-rotate(θ) and rotate-about-+Y(−θ) on the
// XZ plane are literally identical), whereas here the sign flip comes from
// the Y mirror. Taking the prompt "plan (x,y) → IFC (x,y)" literally while
// ALSO negating rotations would be inconsistent (rotated furniture would
// shear away from its walls); mirror-plus-negate is the consistent pair.
// Rectangles are mirror-symmetric about their local axes, so only placements
// need the flip — profile dims are used as-is.

import type { DocState } from '../editor/EditorCanvas'
import { triggerDownload } from './png'

export interface IfcMeta {
  project?: string
}

/** Wall extrusion height (m). */
const WALL_HEIGHT = 2.7
/** Default wall thickness when the doc has a degenerate 0 (m). */
const WALL_THICKNESS_FALLBACK = 0.15

/** Extrusion height per component category (m); others get DEFAULT_HEIGHT. */
const HEIGHTS: Record<string, number> = {
  Desk: 0.75,
  Chair: 0.9,
  Table: 0.75,
  MeetingRoom: 2.6, // simplified full-height furnishing box, not an IfcSpace
  FallCeiling: 0.1, // thin slab hung below the ceiling (BASE_Z lifts it)
}
/** Base elevation per category (m); FallCeiling hangs just below the ceiling. */
const BASE_Z: Record<string, number> = { FallCeiling: 2.4 }
const DEFAULT_HEIGHT = 0.75

// ---------------------------------------------------------------------------
// STEP value formatting
// ---------------------------------------------------------------------------

/** STEP REAL: always contains a '.', no float noise ("2.7", "0.", "-1.25"). */
function real(n: number): string {
  if (!Number.isFinite(n)) n = 0
  if (Object.is(n, -0)) n = 0
  return n.toFixed(6).replace(/(\.\d*?)0+$/, '$1')
}

/** STEP STRING: quoted, '' -escaped quotes, ASCII-only (SPF basic alphabet). */
function str(s: string): string {
  const clean = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/[^\x20-\x7e]/g, '?')
  return `'${clean}'`
}

// ---------------------------------------------------------------------------
// IFC GUIDs — 22 chars in the IFC base64 alphabet, deterministic per document
// ---------------------------------------------------------------------------
// A GlobalId is a 128-bit value compressed to 22 digits of this alphabet
// (6 bits each; 22×6 = 132 ≥ 128, so the leading digit is always 0..3).
// We derive the 128 bits deterministically — four FNV-1a 32-bit lanes over
// `${fileSeed}#${counter}` — instead of crypto.getRandomValues, so exporting
// the same document twice yields byte-identical GUIDs (diff-able exports).
// The fileSeed hashes the document content, so *different* documents still
// get different GUIDs; a Set guards in-file uniqueness regardless.

const IFC64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Compress a seed string into a 22-char IFC GlobalId. */
function ifcGuid(seed: string): string {
  let v = 0n
  for (const lane of ['a', 'b', 'c', 'd']) {
    v = (v << 32n) | BigInt(fnv1a(`${lane}|${seed}`))
  }
  let out = ''
  for (let i = 0; i < 22; i++) {
    out = IFC64[Number(v & 63n)] + out
    v >>= 6n
  }
  return out
}

/** GUID factory: deterministic sequence, unique within the file. */
function guidGen(fileSeed: string): () => string {
  const used = new Set<string>()
  let n = 0
  return () => {
    for (;;) {
      const g = ifcGuid(`${fileSeed}#${n++}`)
      if (!used.has(g)) {
        used.add(g)
        return g
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SPF writer: sequential #ids, one line per entity instance
// ---------------------------------------------------------------------------

class SpfWriter {
  private rows: string[] = []
  private n = 0

  /** Emit `#id=NAME(arg,arg,…);` and return the `#id` reference. */
  add(name: string, args: string[]): string {
    const id = `#${++this.n}`
    this.rows.push(`${id}=${name}(${args.join(',')});`)
    return id
  }

  body(): string {
    return this.rows.join('\n')
  }
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

/** Build a minimal valid IFC2X3 SPF/STEP text from a document state. */
export function docStateToIFC(state: DocState, meta?: { project?: string }): string {
  const project = meta?.project ?? 'DSource Plan'
  const w = new SpfWriter()
  const gid = guidGen(
    fnv1a(JSON.stringify({ project, walls: state.walls, components: state.components })).toString(16),
  )

  // Owner history — mandatory on every IfcRoot in IFC2X3 (optional only in
  // IFC4). CreationDate 0 keeps the DATA section deterministic.
  const person = w.add('IFCPERSON', ['$', '$', str('DSource'), '$', '$', '$', '$', '$'])
  const org = w.add('IFCORGANIZATION', ['$', str('DSource Editor'), '$', '$', '$'])
  const pao = w.add('IFCPERSONANDORGANIZATION', [person, org, '$'])
  const app = w.add('IFCAPPLICATION', [org, str('1.0'), str('DSource Editor'), str('dsource-editor')])
  const oh = w.add('IFCOWNERHISTORY', [pao, app, '$', '.ADDED.', '$', '$', '$', '0'])

  // SI units: metre, square metre, cubic metre, radian. IfcSIUnit.Dimensions
  // is a derived attribute in the subtype, so SPF writes it as '*'.
  const units = w.add('IFCUNITASSIGNMENT', [
    `(${[
      w.add('IFCSIUNIT', ['*', '.LENGTHUNIT.', '$', '.METRE.']),
      w.add('IFCSIUNIT', ['*', '.AREAUNIT.', '$', '.SQUARE_METRE.']),
      w.add('IFCSIUNIT', ['*', '.VOLUMEUNIT.', '$', '.CUBIC_METRE.']),
      w.add('IFCSIUNIT', ['*', '.PLANEANGLEUNIT.', '$', '.RADIAN.']),
    ].join(',')})`,
  ])

  // World 3D representation context. Mandatory attrs: dimension (3) and the
  // world coordinate system; precision 1.E-05 and TrueNorth +Y are the values
  // checkers expect. This is the part hand-written IFC usually gets wrong —
  // attribute order is (ContextIdentifier, ContextType, CoordinateSpace-
  // Dimension, Precision, WorldCoordinateSystem, TrueNorth).
  const origin3 = w.add('IFCCARTESIANPOINT', ['(0.,0.,0.)'])
  const dirZ = w.add('IFCDIRECTION', ['(0.,0.,1.)'])
  const dirX = w.add('IFCDIRECTION', ['(1.,0.,0.)'])
  const worldAxis = w.add('IFCAXIS2PLACEMENT3D', [origin3, dirZ, dirX])
  const trueNorth = w.add('IFCDIRECTION', ['(0.,1.)'])
  const ctx = w.add('IFCGEOMETRICREPRESENTATIONCONTEXT', [
    '$',
    str('Model'),
    '3',
    '1.E-05',
    worldAxis,
    trueNorth,
  ])

  const proj = w.add('IFCPROJECT', [str(gid()), oh, str(project), '$', '$', '$', '$', `(${ctx})`, units])

  // Spatial tree: project → site → building → storey (elevation 0), each with
  // a local placement chained to its parent, linked by IfcRelAggregates.
  const sitePl = w.add('IFCLOCALPLACEMENT', ['$', worldAxis])
  const site = w.add('IFCSITE', [
    str(gid()), oh, str('Site'), '$', '$', sitePl, '$', '$', '.ELEMENT.', '$', '$', '$', '$', '$',
  ])
  const bldgPl = w.add('IFCLOCALPLACEMENT', [sitePl, worldAxis])
  const bldg = w.add('IFCBUILDING', [
    str(gid()), oh, str('Building'), '$', '$', bldgPl, '$', '$', '.ELEMENT.', '$', '$', '$',
  ])
  const storeyPl = w.add('IFCLOCALPLACEMENT', [bldgPl, worldAxis])
  const storey = w.add('IFCBUILDINGSTOREY', [
    str(gid()), oh, str('Ground Floor'), '$', '$', storeyPl, '$', '$', '.ELEMENT.', '0.',
  ])
  w.add('IFCRELAGGREGATES', [str(gid()), oh, '$', '$', proj, `(${site})`])
  w.add('IFCRELAGGREGATES', [str(gid()), oh, '$', '$', site, `(${bldg})`])
  w.add('IFCRELAGGREGATES', [str(gid()), oh, '$', '$', bldg, `(${storey})`])

  // Shared geometry bits: 2D profile position and the identity solid position
  // (IFC2X3 makes both mandatory where IFC4 allows $).
  const origin2 = w.add('IFCCARTESIANPOINT', ['(0.,0.)'])
  const profilePos = w.add('IFCAXIS2PLACEMENT2D', [origin2, '$'])
  const solidPos = w.add('IFCAXIS2PLACEMENT3D', [origin3, '$', '$'])

  // A Body SweptSolid product shape: xdim×ydim rectangle extruded `depth` up.
  const boxShape = (xdim: number, ydim: number, depth: number): string => {
    const prof = w.add('IFCRECTANGLEPROFILEDEF', ['.AREA.', '$', profilePos, real(xdim), real(ydim)])
    const solid = w.add('IFCEXTRUDEDAREASOLID', [prof, solidPos, dirZ, real(depth)])
    const rep = w.add('IFCSHAPEREPRESENTATION', [ctx, str('Body'), str('SweptSolid'), `(${solid})`])
    return w.add('IFCPRODUCTDEFINITIONSHAPE', ['$', '$', `(${rep})`])
  }

  // Element placement on the storey at plan (x, y) / elevation z, rotated by
  // `angleIfc` about +Z. Plan Y is mirrored here (see header comment).
  const placement = (xPlan: number, yPlan: number, z: number, angleIfc: number): string => {
    const loc = w.add('IFCCARTESIANPOINT', [`(${real(xPlan)},${real(-yPlan)},${real(z)})`])
    const ref =
      angleIfc === 0
        ? dirX
        : w.add('IFCDIRECTION', [`(${real(Math.cos(angleIfc))},${real(Math.sin(angleIfc))},0.)`])
    const axis = w.add('IFCAXIS2PLACEMENT3D', [loc, dirZ, ref])
    return w.add('IFCLOCALPLACEMENT', [storeyPl, axis])
  }

  const contained: string[] = []

  // Walls: length×thickness profile centered on the a→b midpoint, rotated to
  // the a→b direction (Y mirrored), extruded to WALL_HEIGHT.
  state.walls.forEach((wall, i) => {
    const dx = wall.b.x - wall.a.x
    const dyIfc = -(wall.b.y - wall.a.y) // plan Y-down → IFC Y-up
    const len = Math.hypot(dx, dyIfc)
    if (len < 1e-9) return // zero-length wall: no valid profile
    const pl = placement(
      (wall.a.x + wall.b.x) / 2,
      (wall.a.y + wall.b.y) / 2,
      0,
      Math.atan2(dyIfc, dx),
    )
    const shape = boxShape(len, wall.thickness > 0 ? wall.thickness : WALL_THICKNESS_FALLBACK, WALL_HEIGHT)
    contained.push(w.add('IFCWALL', [str(gid()), oh, str(`Wall ${i + 1}`), '$', '$', pl, shape, '$']))
  })

  // Components: w×h footprint box, category-heuristic height, plan rotation θ
  // → −θ about +Z (see header comment). Name carries the label; a bound
  // product id travels in Description so nothing in Name gets mangled.
  for (const c of state.components) {
    const height = HEIGHTS[c.category] ?? DEFAULT_HEIGHT
    const z = BASE_Z[c.category] ?? 0
    const pl = placement(c.x, c.y, z, -c.rotation)
    const shape = boxShape(c.w, c.h, height)
    contained.push(
      w.add('IFCFURNISHINGELEMENT', [
        str(gid()),
        oh,
        str(c.label || c.category),
        c.product_id ? str(`product:${c.product_id}`) : '$',
        str(c.category),
        pl,
        shape,
        '$',
      ]),
    )
  }

  if (contained.length > 0) {
    w.add('IFCRELCONTAINEDINSPATIALSTRUCTURE', [
      str(gid()), oh, str('Storey contents'), '$', `(${contained.join(',')})`, storey,
    ])
  }

  const now = new Date().toISOString().slice(0, 19)
  return [
    'ISO-10303-21;',
    'HEADER;',
    // '2;1' is the ISO-10303-21 implementation level; the description string
    // is the MVD tag importers key on for IFC2X3.
    `FILE_DESCRIPTION((${str('ViewDefinition [CoordinationView_V2.0]')}),'2;1');`,
    `FILE_NAME(${str(`${project}.ifc`)},'${now}',(${str('DSource')}),(${str('DSource Editor')}),` +
      `${str('DSource Editor IFC exporter')},${str('DSource Editor')},'');`,
    "FILE_SCHEMA(('IFC2X3'));",
    'ENDSEC;',
    'DATA;',
    w.body(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n')
}

/** Build the IFC for a document state and trigger a download. */
export function downloadIFC(state: DocState, filename = 'dsource-plan.ifc', meta?: IfcMeta): void {
  const blob = new Blob([docStateToIFC(state, meta)], { type: 'application/x-step' })
  triggerDownload(blob, filename)
}
