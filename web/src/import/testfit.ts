// Bridge between imported CAD drawings and the autonomous test-fit generator.
//
// `extractPlate` derives the building's outer floor-plate polygon from the
// wall linework of an imported `Drawing`; `pushPlateToEditor` feeds that
// polygon into the Rust `Editor` as walls so `generate`/`autoGenerate` and the
// circulation evaluator run *inside the imported plan*.
//
// The furniture IS the program — a floor plate that doesn't contain the
// drawing's furniture is wrong by definition. Every candidate boundary is
// scored by *furniture coverage* (fraction of furniture bbox centers inside),
// and the candidate ladder (see `PlateResult.method`) runs until one reaches
// `COVERAGE_ACCEPT` with a plausible area; otherwise the max-coverage
// candidate wins:
// - 'loop'  — snap wall-segment endpoints to a tolerance grid, build a planar
//             graph, trace its faces, keep the largest-area closed loop.
// - 'hull'  — rasterize the shell (walls, glazing, doors — door thresholds
//             close the gaps that leak the flood fill — casework, column-ish
//             closed polylines, plus shell-category block inserts) onto a
//             coarse occupancy grid, morphologically close remaining gaps
//             (dilate+erode of the linework itself, so passages wider than
//             the closing radius keep their true width), flood the outside,
//             and trace the outer contour of the solid region (Moore neighbor
//             tracing). Raster candidates whose boundary necks below door
//             width between two large areas (the signature of a leaked flood
//             threading a wall cavity) are passed over while the dilation
//             ladder escalates. Convex hull of shell endpoints ∪ furniture
//             corners is the last resort.
// - 'wrap'  — guaranteed-coverage fallback: rasterize shell ∪ every furniture
//             bbox outline and contour that — the plate necessarily wraps the
//             furniture field while hugging the real footprint far tighter
//             than a convex hull (which would swallow concave notches).
//
// Pure TS, dependency-free. Coordinates in meters throughout.

import type { Drawing, DrawEntity } from './types'
import { assessPlate, type PlateMethod, type PlateProvenance } from './plateQuality'
import { columnGridEnvelope, partitionContour } from './plateLadder'
import type { EditorCanvas } from '../editor/EditorCanvas'
import type { AnchorPin } from '../program/anchors'

export type Pt = [number, number]
export type Segment = [Pt, Pt]

export interface PlateResult {
  /** Ordered closed boundary polygon of the floor plate, meters, translated so min corner ≈ (margin, margin). */
  boundary: Pt[]
  /** The translation applied: editorPoint = sourcePoint - offset. */
  offset: { x: number; y: number }
  /** Diagnostic: how the boundary was derived. */
  method: 'loop' | 'hull' | 'wrap'
  /** Fraction (0–1) of furniture bbox centers inside the boundary; 1 when the drawing has no furniture. */
  coverage: number
  /** Enclosed area of `boundary`, m². */
  areaM2: number
  /**
   * How this boundary was derived and how far it can be trusted. Absent only on
   * plates built without the source drawing to check against.
   *
   * `provenance.confidence === 'low'` means the plate is a PROPOSAL: show it as
   * an editable draft with `provenance.reason`, and never print a hard area for
   * it (or for anything derived from it — circulation, cost, m²/person).
   */
  provenance?: PlateProvenance
}

// ---- tunables ----------------------------------------------------------
const SNAP_TOL = 0.05 // m — endpoint snap grid for loop tracing (CAD wiggle)
const SIMPLIFY_LOOP = 0.25 // m — Douglas-Peucker tolerance for traced loops
const SIMPLIFY_CONTOUR = 0.3 // m — DP tolerance for the grid contour
const GRID_CELL = 0.25 // m — occupancy-grid resolution for the fallback
const GRID_DILATE = 2 // cells — closing radius (2 * 0.25 m bridges ~1 m door gaps)
const MIN_PLATE_AREA = 1 // m² — below this a "loop" is noise, not a plate
const EDITOR_MARGIN = 1 // m — where the plate's min corner lands in the editor
const DESPIKE_WEDGE_DEG = 25 // ° — wedge at a vertex below this is a spike candidate
const DESPIKE_AREA_FRAC = 0.005 // fraction of |ring area| a single removal may change
const SIMPLIFY_POST = 0.05 // m — light DP pass to collapse collinear runs left by despiking
const SMOOTH_TRI_M2 = 0.45 // m² — Visvalingam: vertices whose triangle is smaller are jags
const SMOOTH_DRIFT_FRAC = 0.02 // total |area| drift budget for the whole smoothing pass
const COVERAGE_ACCEPT = 0.85 // accept the first candidate covering this fraction of furniture
const COVERAGE_EDGE_TOL = 0.5 // m — a center this close to the boundary counts as inside
// (perimeter windows/doors sit ON the traced wall line — ±1 grid cell)
const COLUMN_MAX_SIDE = 2.5 // m — 'other' closed polylines up to this size rasterize as columns
const PINCH_PASSAGE_M = 0.8 // m — a plate neck narrower than a door leaf is a trace defect
const PINCH_AREA_M2 = 20 // m² — both sides of the neck must be at least this big to count
const PINCH_CELL = 0.1 // m — raster resolution of the pinch check (must resolve sub-door necks)
const KEEPOUT_MIN_M2 = 2 // m² — an enclosed furniture-free room smaller than this is a wall cavity
const KEEPOUT_MAX_M2 = 80 // m² — bigger than this it's a floor region, not a core room
const KEEPOUT_EDGE_BAND = 1 // cells — free cells this close to the plate edge belong to the main floor
// (1, not 2: slivers between the traced boundary and the real wall always own a
// distance-≤1 cell, while a room backed by a single-cell-thick perimeter wall —
// the real drawing's stair core meets the facade exactly like that — stays ≥2)
const KEEPOUT_MERGE_GAP = 0.3 // m — candidate bboxes at most this far apart fuse into one core block
const KEEPOUT_MAX_COUNT = 12 // sanity cap on emitted rects
const KEEPOUT_AREA_FRAC = 0.4 // total keep-out area may claim at most this fraction of the plate
const ENTRY_BOUNDARY_TOL = 1.0 // m — a door within this of the plate boundary is an exterior entry
const ENTRY_MERGE_GAP = 1.5 // m — entries closer than this fuse (a double door → one entry)

// ---- public API --------------------------------------------------------

/** Derive the building's outer floor-plate polygon from a drawing's shell linework. */
/**
 * Why no floor plate could be traced.
 *
 * `extractPlate` used to return a bare `null`, which forced every caller to
 * invent a message — and the one App.tsx invented ("No wall geometry found in
 * this drawing") was WRONG on 4 of the 6 corpus files that hit it: they had
 * plenty of wall geometry, it was just 1000x too small to clear the area floor.
 * A failure that cannot say which stage failed sends the user to fix the wrong
 * thing. See cad-validation/findings/F3-no-plate-derived.md.
 */
export type PlateFailure =
  /** No wall/glazing/door/casework linework at all — nothing to trace. */
  | 'no-shell-geometry'
  /** Linework exists but never closes into a region of 3+ points. */
  | 'no-closed-region'
  /** Regions were found, but every one is below the minimum plate area. */
  | 'regions-below-minimum'

export type PlateOutcome =
  | { ok: true; plate: PlateResult }
  | { ok: false; reason: PlateFailure }

/** Plain-language, user-facing, and specific about what to try next. */
export const PLATE_FAILURE_MESSAGE: Record<PlateFailure, string> = {
  'no-shell-geometry':
    'this drawing has no wall, window or door linework we can trace a building shell from — its layers may be named in a way we do not recognise, or it may be a furniture library rather than a floor plan',
  'no-closed-region':
    'this drawing’s wall linework never closes into a region — try “Heal gaps” to bridge small breaks, or select the area by hand',
  'regions-below-minimum':
    'every enclosed region in this drawing is smaller than a square metre, which usually means it was read at the wrong scale',
}

/**
 * Trace the floor plate, or say why not.
 *
 * The primary; `extractPlate` is the plate-or-null view of the same single
 * derivation, kept because most callers only need the plate.
 */
export function tracePlate(drawing: Drawing): PlateOutcome {
  const wallSegs = collectWallSegments(drawing)
  const shellSegs = collectShellSegments(drawing)
  if (wallSegs.length === 0 && shellSegs.length === 0) {
    return { ok: false, reason: 'no-shell-geometry' }
  }

  const [bMinX, bMinY, bMaxX, bMaxY] = drawing.bounds
  const bboxArea = Math.max((bMaxX - bMinX) * (bMaxY - bMinY), 1)
  const plausible = Math.max(MIN_PLATE_AREA, bboxArea * 0.2)
  const centers = furnitureCenters(drawing)

  // Score a finalized candidate ring; the ladder accepts the first one that
  // clears the coverage + plausible-area bar AND carries no trace pinch, else
  // falls back to the max-coverage candidate (unpinched preferred on ties).
  type Scored = {
    ring: Pt[]
    method: PlateResult['method']
    coverage: number
    area: number
    pinched: boolean
  }
  let best: Scored | null = null
  /** Did any rung produce a closed ring at all, whatever its area? */
  let sawRing = false
  const accept = (ring: Pt[] | null, method: PlateResult['method']): Scored | null => {
    if (!ring || ring.length < 3) return null
    sawRing = true
    const area = Math.abs(signedArea(ring))
    if (area < MIN_PLATE_AREA) return null
    const coverage = ringCoverage(ring, centers)
    // Loop candidates are exact linework faces; only rasterized candidates
    // can carry a mis-trace pinch.
    const pinched = method === 'loop' ? false : ringPinched(ring)
    const scored: Scored = { ring, method, coverage, area, pinched }
    if (
      !best ||
      coverage > best.coverage ||
      (coverage === best.coverage && best.pinched && !pinched) ||
      (coverage === best.coverage && pinched === best.pinched && area > best.area)
    ) {
      best = scored
    }
    return coverage >= COVERAGE_ACCEPT && area >= plausible && area <= bboxArea * 1.05 && !pinched
      ? scored
      : null
  }

  // (a) Largest closed loop in the snapped wall+glazing graph. Without a
  // coverage gate this happily returns an interior room when the perimeter
  // has gaps — the exact failure mode the ladder exists to catch.
  const loops = traceLoops(wallSegs, SNAP_TOL)
  let bigLoop: Pt[] | null = null
  let bigArea = 0
  for (const l of loops) {
    const a = Math.abs(signedArea(l))
    if (a > bigArea) {
      bigArea = a
      bigLoop = l
    }
  }
  if (bigLoop && bigArea >= plausible) {
    // Simplify → despike → light simplify (despiking leaves collinear runs).
    const ring = simplify(smooth(despike(simplify(orientCCW(bigLoop), SIMPLIFY_LOOP, true))), SIMPLIFY_POST, true)
    const hit = accept(ring, 'loop')
    if (hit) return { ok: true, plate: finishPlate({ ...hit, drawing }) }
  }

  // ---- adopted envelope-inference rungs (ADR 0003) -----------------------
  // Tried only after loop tracing fails, i.e. only when no closed shell exists.
  // Each is guarded and declines cleanly; the rungs below still catch anything
  // they refuse, so the user is never left without a draft. All of these yield
  // `confidence: 'low'` — they improve the PROPOSAL, not what is asserted.

  // (a2) Column grid — exact when a real structural grid exists (IoU 1.000 on
  // the calibration fixture), rejects otherwise. Highest-trust inference rung.
  {
    const ring = columnGridEnvelope(drawing)
    if (ring) {
      const area = Math.abs(signedArea(ring))
      if (area >= plausible) {
        return {
          ok: true,
          plate: finishPlate({
            ring, method: 'hull', coverage: ringCoverage(ring, centers), area,
            drawing, provenanceMethod: 'column-grid',
          }),
        }
      }
    }
  }

  // (a3) Partition contour — recovers a boundary that gaps have broken
  // (0.730 -> 0.979 on shell fragments). Tried WITHOUT the furniture wrap first:
  // wrapping fills re-entrant corners the walls correctly define.
  // (a4) …then WITH the wrap, which reaches furniture no wall encloses
  // (containment 0.762 -> 0.985 on the real DWG) at the cost of that concavity.
  for (const wrap of [false, true]) {
    const ring = partitionContour(wallSegs, drawing, wrap)
    if (!ring) continue
    const area = Math.abs(signedArea(ring))
    if (area < plausible) continue
    return {
      ok: true,
      plate: finishPlate({
        ring, method: 'hull', coverage: ringCoverage(ring, centers), area,
        drawing, provenanceMethod: 'partition-envelope',
      }),
    }
  }

  // (b) Occupancy-grid outer contour of the widened shell set (doors close the
  // flood-fill leaks) with escalating gap-closing dilation.
  for (const dilate of [GRID_DILATE, GRID_DILATE * 2, GRID_DILATE * 4]) {
    const hit = accept(contourRing(shellSegs, dilate), 'hull')
    if (hit) return { ok: true, plate: finishPlate({ ...hit, drawing, provenanceMethod: 'grid-contour' }) }
  }

  // (c) Guaranteed-coverage wrap: shell ∪ every furniture bbox outline. The
  // solid region then contains the furniture field by construction.
  if (centers.length > 0) {
    const wrapSegs = shellSegs.concat(furnitureBoxSegments(drawing))
    for (const dilate of [GRID_DILATE * 2, GRID_DILATE * 4]) {
      const hit = accept(contourRing(wrapSegs, dilate), 'wrap')
      if (hit) return { ok: true, plate: finishPlate({ ...hit, drawing, provenanceMethod: 'grid-contour' }) }
    }
  }

  // (d) Last resort: convex hull of shell endpoints ∪ furniture corners.
  const hullPts: Pt[] = shellSegs.flat()
  for (const f of drawing.furniture) {
    const [x0, y0, x1, y1] = f.bbox
    hullPts.push([x0, y0], [x1, y0], [x1, y1], [x0, y1])
  }
  const hullRing = convexHull(hullPts)
  const beforeHull = best
  accept(hullRing, 'hull')
  // If the convex hull became the winner, say so: 'hull' in PlateResult.method
  // is overloaded (rung (b) uses it for the grid contour), and provenance must
  // not report a furniture-corner hull as a contour of real linework.
  const hullWon = best !== beforeHull

  // `best` is only ever assigned inside the `accept` closure, which TS's
  // control-flow analysis cannot see — it narrows the binding to `null` here.
  // The cast restores the declared type so the fields can be read.
  const chosen = best as Scored | null
  if (!chosen) {
    // `sawRing` distinguishes "the linework never closed" from "it closed, but
    // everything it enclosed was too small" — the difference between a drafting
    // problem and a scale problem, which need opposite fixes.
    return { ok: false, reason: sawRing ? 'regions-below-minimum' : 'no-closed-region' }
  }
  return {
    ok: true,
    plate: finishPlate({
      ring: chosen.ring, method: chosen.method,
      coverage: chosen.coverage, area: chosen.area, drawing,
      provenanceMethod: hullWon ? 'hull' : PROVENANCE_METHOD[chosen.method],
    }),
  }
}

/** The plate, or `null`. A view over `tracePlate` — one derivation, two shapes. */
export function extractPlate(drawing: Drawing): PlateResult | null {
  const outcome = tracePlate(drawing)
  return outcome.ok ? outcome.plate : null
}

/** Fraction (0–1) of the drawing's furniture bbox centers inside the plate boundary. */
export function plateCoverage(plate: PlateResult, drawing: Drawing): number {
  const centers = furnitureCenters(drawing).map(
    ([x, y]): Pt => [x - plate.offset.x, y - plate.offset.y],
  )
  return ringCoverage(plate.boundary, centers)
}

/** Grid contour of `segments` → despiked, lightly re-simplified ring (or null). */
function contourRing(segments: Segment[], dilate: number): Pt[] | null {
  const contour = gridContour(segments, GRID_CELL, dilate)
  if (!contour || contour.length < 3) return null
  // gridContour already ran DP; despike the needles the tracer squeezes
  // through wall gaps, then a light simplify for leftover collinear runs.
  const ring = simplify(smooth(despike(orientCCW(contour))), SIMPLIFY_POST, true)
  return ring.length >= 3 ? ring : null
}

/** Push a plate's boundary into the editor as walls (one per polygon edge). */
/** Thickness (m) of the walls an imported plate stamps into the document. The
 *  ONE declaration — `mergeFit` used to keep its own 0.15 beside a comment
 *  promising it "matches pushPlateToEditor's default", which is the same
 *  unverifiable mirror that let OPEN_SHARE drift. */
export const PLATE_WALL_THICKNESS_M = 0.15

export function pushPlateToEditor(
  ec: EditorCanvas,
  plate: PlateResult,
  thickness = PLATE_WALL_THICKNESS_M,
): void {
  // The plate's trustworthiness travels with the document from here on.
  ec.plateProvenance = plate.provenance ?? null
  const b = plate.boundary
  for (let i = 0; i < b.length; i++) {
    const [ax, ay] = b[i]
    const [bx, by] = b[(i + 1) % b.length]
    ec.ed.add_wall(ax, ay, bx, by, thickness)
  }
  ec.refresh()
}

// ---- entries (test-fit circulation anchor) ---------------------------------

/** Bounding-box center of a set of segments, or null if empty. */
function segsCenter(segs: Segment[]): Pt | null {
  if (segs.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [a, b] of segs) {
    for (const [x, y] of [a, b]) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2]
}

/** Drop entries closer than `gap` to one already kept (double doors → one). */
function dedupeNearby(pts: Pt[], gap: number): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    if (!out.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= gap)) out.push(p)
  }
  return out
}

/**
 * Building **entry points** for the test-fit generator's circulation spine
 * (spec §3: enter → reception → spine → neighborhoods). Returned in EDITOR
 * coordinates (plate offset applied) so they feed straight into
 * `Editor.add_entry` (see the orchestrator snippet in the PR notes).
 *
 * Rule: a `door` entity or block INSERT whose center lies within
 * `ENTRY_BOUNDARY_TOL` of the plate boundary is an exterior entry threshold.
 * With no boundary door, fall back to the midpoint of the plate's longest edge
 * (the most likely public frontage). Deterministic; nearby doubles are fused.
 */
export function extractEntries(drawing: Drawing, plate: PlateResult): Pt[] {
  const ring = plate.boundary
  const { x: ox, y: oy } = plate.offset
  const entries: Pt[] = []
  const consider = (cx: number, cy: number) => {
    const p: Pt = [cx - ox, cy - oy] // source → editor coords
    if (distToRing(p[0], p[1], ring) <= ENTRY_BOUNDARY_TOL) entries.push(p)
  }
  // Loose door linework (swing arcs / thresholds).
  for (const e of drawing.entities) {
    if (e.category !== 'door') continue
    const segs: Segment[] = []
    pushEntitySegments(e, segs)
    const c = segsCenter(segs)
    if (c) consider(c[0], c[1])
  }
  // Door block INSERTs (most real plans carry doors as blocks, not loose lines).
  for (const f of drawing.furniture) {
    if (f.category !== 'door') continue
    consider((f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2)
  }
  if (entries.length > 0) return dedupeNearby(entries, ENTRY_MERGE_GAP)

  // Fallback: midpoint of the plate's longest boundary edge.
  let bestLen = -1
  let mid: Pt | null = null
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len > bestLen) {
      bestLen = len
      mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
  }
  return mid ? [mid] : []
}

/** Push extracted entries into the editor (clears any previous ones first). */
export function pushEntriesToEditor(ec: EditorCanvas, entries: Pt[]): void {
  ec.ed.clear_entries()
  for (const [x, y] of entries) ec.ed.add_entry(x, y)
}

/** Push anchor pins into the editor (workflow.md §3.5), clearing any previous
 *  ones first — mirrors {@link pushEntriesToEditor}. Pins are stored in
 *  drawing/source coords; project them into EDITOR coords with the same plate
 *  offset the plate/keepouts/entries use, then `Editor.add_anchor` records each
 *  so the next `generate()` places its room FIRST at (near) the point. Unknown
 *  kinds are ignored core-side. Guarded no-op on a stale wasm without the
 *  binding (fresh clones must `make wasm`). */
export function pushAnchorsToEditor(ec: EditorCanvas, anchors: AnchorPin[], plate: PlateResult): void {
  const ed = ec.ed as unknown as {
    clear_anchors?: () => void
    add_anchor?: (kind: string, x: number, y: number) => void
  }
  if (!ed.add_anchor || !ed.clear_anchors) return
  ed.clear_anchors()
  const { x: ox, y: oy } = plate.offset
  for (const a of anchors) ed.add_anchor(a.kind, a.x - ox, a.y - oy)
}

// ---- interior partition walls ----------------------------------------------

/** An interior partition wall segment in EDITOR coordinates (same offset
 *  translation as the plate boundary), ready for `Editor.add_wall`. */
export interface InteriorWall {
  ax: number
  ay: number
  bx: number
  by: number
  thickness: number
}

const IWALL_THICKNESS = 0.1 // m — emitted thickness for single-line partitions
const IWALL_MIN_LEN = 0.5 // m — merged runs shorter than this are jambs/noise
const IWALL_MAX_COUNT = 400 // sanity cap; longest-first keeps coverage
const IWALL_BOUNDARY_TOL = 0.4 // m — a segment this close to the plate ring IS the ring
// (the ring is DP-simplified/despiked up to ~0.3 m off the raw wall lines)
const IWALL_INSIDE_TOL = 0.05 // m — endpoints may touch the boundary (partition abuts facade)
const IWALL_ANGLE_TOL = 0.5 // ° — direction bucket for collinear merging
const IWALL_LINE_TOL = 0.05 // m — perpendicular offset bucket for collinear merging
const IWALL_MERGE_GAP = 0.05 // m — collinear runs within this end gap fuse

/** Distance from point (x,y) to the closest edge of `ring`. */
function distToRing(x: number, y: number, ring: Pt[]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    const ex = x - (ax + t * dx)
    const ey = y - (ay + t * dy)
    best = Math.min(best, ex * ex + ey * ey)
  }
  return Math.sqrt(best)
}

/**
 * Extract the drawing's **interior partition walls**: wall-category linework
 * that lies inside the extracted plate but is not the plate boundary itself.
 * Returns segments in EDITOR coordinates (plate offset applied) so they feed
 * straight into `pushInteriorWallsToEditor` → `Editor.add_wall`, where the
 * generator treats them as packing obstacles and the circulation evaluator
 * rasterizes them.
 *
 * Pipeline: collect `wall` segments → drop ring-coincident ones (every sample
 * within `IWALL_BOUNDARY_TOL` of the plate ring) → keep only segments whose
 * ends/midpoint are inside the ring (or touching it within `IWALL_INSIDE_TOL`)
 * → merge collinear/overlapping runs → drop runs < `IWALL_MIN_LEN` → cap at
 * `IWALL_MAX_COUNT`, longest first (coverage-preserving priority).
 */
export function extractInteriorWalls(drawing: Drawing, plate: PlateResult): InteriorWall[] {
  const ring = plate.boundary
  if (ring.length < 3) return []

  // Wall-category segments only (glazing is facade; casework/doors aren't
  // partitions), translated into editor coordinates.
  const raw: Segment[] = []
  for (const e of drawing.entities) {
    if (e.category === 'wall') pushEntitySegments(e, raw)
  }
  const segs: Segment[] = raw.map(([a, b]) => [
    [a[0] - plate.offset.x, a[1] - plate.offset.y],
    [b[0] - plate.offset.x, b[1] - plate.offset.y],
  ])

  // Classify each segment by its end/quarter/mid samples.
  const interior: Segment[] = []
  for (const [a, b] of segs) {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue
    const samples: Pt[] = [0, 0.25, 0.5, 0.75, 1].map((t) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ])
    // The plate boundary itself: every sample hugs the ring.
    if (samples.every(([x, y]) => distToRing(x, y, ring) <= IWALL_BOUNDARY_TOL)) continue
    // Inside the plate: every sample inside or touching the ring.
    const inside = samples.every(
      ([x, y]) => pointInRing(x, y, ring) || distToRing(x, y, ring) <= IWALL_INSIDE_TOL,
    )
    if (!inside) continue
    interior.push([a, b])
  }

  // Merge collinear, overlapping/abutting runs. Group by direction bucket +
  // signed line offset bucket, then merge 1D projection intervals per group.
  type Run = { t0: number; t1: number }
  const groups = new Map<string, { dir: Pt; origin: Pt; runs: Run[] }>()
  for (const [a, b] of interior) {
    let dx = b[0] - a[0]
    let dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    dx /= len
    dy /= len
    // Canonical direction (upper half-plane) so opposite drawings coincide.
    if (dy < 0 || (dy === 0 && dx < 0)) {
      dx = -dx
      dy = -dy
    }
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI // [0, 180)
    const aKey = Math.round(angle / IWALL_ANGLE_TOL)
    // Perpendicular offset of the line from the origin.
    const c = a[0] * -dy + a[1] * dx
    const cKey = Math.round(c / IWALL_LINE_TOL)
    const key = `${aKey}:${cKey}`
    let g = groups.get(key)
    if (!g) {
      g = { dir: [dx, dy], origin: [-dy * c, dx * c], runs: [] }
      groups.set(key, g)
    }
    const t = (p: Pt) => p[0] * g!.dir[0] + p[1] * g!.dir[1]
    const ta = t(a)
    const tb = t(b)
    g.runs.push({ t0: Math.min(ta, tb), t1: Math.max(ta, tb) })
  }

  const merged: InteriorWall[] = []
  for (const g of groups.values()) {
    g.runs.sort((p, q) => p.t0 - q.t0)
    let cur: Run | null = null
    const flush = (r: Run | null) => {
      if (!r || r.t1 - r.t0 < IWALL_MIN_LEN) return
      merged.push({
        ax: g.origin[0] + g.dir[0] * r.t0,
        ay: g.origin[1] + g.dir[1] * r.t0,
        bx: g.origin[0] + g.dir[0] * r.t1,
        by: g.origin[1] + g.dir[1] * r.t1,
        thickness: IWALL_THICKNESS,
      })
    }
    for (const r of g.runs) {
      if (cur && r.t0 <= cur.t1 + IWALL_MERGE_GAP) {
        cur.t1 = Math.max(cur.t1, r.t1)
      } else {
        flush(cur)
        cur = { ...r }
      }
    }
    flush(cur)
  }

  // Coverage-preserving cap: longest first.
  merged.sort(
    (p, q) => Math.hypot(q.bx - q.ax, q.by - q.ay) - Math.hypot(p.bx - p.ax, p.by - p.ay),
  )
  return merged.slice(0, IWALL_MAX_COUNT)
}

/** Push interior partition walls into the editor (one `add_wall` per segment,
 *  mirroring `pushPlateToEditor`). The generator then packs around them and
 *  the circulation evaluator rasterizes them. */
export function pushInteriorWallsToEditor(ec: EditorCanvas, walls: InteriorWall[]): void {
  if (walls.length === 0) return
  for (const w of walls) ec.ed.add_wall(w.ax, w.ay, w.bx, w.by, w.thickness)
  ec.refresh()
}

// ---- building-core keep-outs ----------------------------------------------

/** An area the generator must not place program in — a stair core, elevator
 *  shaft, riser, or WC. Center-based x/y in EDITOR coordinates (same offset
 *  translation as the plate boundary), matching `Editor.add_keepout`. */
export interface KeepOutRect {
  x: number
  y: number
  w: number
  h: number
  label: string
}

/**
 * Detect building-core keep-outs inside an extracted plate.
 *
 * Principle: in a FURNITURE plan, an enclosed interior room containing zero
 * furniture is service space — stair cores, elevator shafts, risers, WCs.
 * Rasterize the wall-category linework inside the plate polygon (walls only:
 * shaft X-marks are 'other'/annotation and must not fabricate rooms), flood
 * the free space into 4-connected components, and keep the components that
 * (a) never come within `KEEPOUT_EDGE_BAND` cells of the plate edge (fully
 * enclosed — anything touching that band drains into the main floor),
 * (b) span a room-plausible 2–80 m², and (c) contain no furniture bbox
 * center. Candidate bboxes closer than `KEEPOUT_MERGE_GAP` fuse, so a
 * stair+shaft cluster emerges as one core block instead of five slivers.
 */
export function extractKeepouts(drawing: Drawing, plate: PlateResult): KeepOutRect[] {
  // The plate boundary back in source (drawing) coordinates.
  const ring: Pt[] = plate.boundary.map(([x, y]) => [x + plate.offset.x, y + plate.offset.y])
  if (ring.length < 3) return []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const cell = GRID_CELL
  const ox = minX - 2 * cell
  const oy = minY - 2 * cell
  const W = Math.ceil((maxX - minX) / cell) + 4
  const H = Math.ceil((maxY - minY) / cell) + 4
  if (W * H > 4_000_000) return []

  const inside = fillRing(ring, ox, oy, cell, W, H)

  // Wall-category linework only (no casework, no glazing: glass fronts mean
  // occupiable rooms, and those are cleared by the furniture test anyway).
  const wallSegs: Segment[] = []
  for (const e of drawing.entities) {
    if (e.category === 'wall') pushEntitySegments(e, wallSegs)
  }
  const wall = new Uint8Array(W * H)
  stampSegments(wallSegs, wall, ox, oy, cell, W, H)

  // Free space inside the plate → 4-connected rooms.
  const free = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) free[i] = inside[i] && !wall[i] ? 1 : 0
  const { comp, counts } = labelComponents(free, W, H)
  const n = counts.length
  if (n === 0) return []

  // (a) Components reaching the plate-edge band connect to the main floor.
  const touchesBand = new Uint8Array(n)
  const band = KEEPOUT_EDGE_BAND
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = comp[y * W + x]
      if (id < 0 || touchesBand[id]) continue
      edge: for (let dy = -band; dy <= band; dy++) {
        for (let dx = -band; dx <= band; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !inside[ny * W + nx]) {
            touchesBand[id] = 1
            break edge
          }
        }
      }
    }
  }

  // (c) Components holding a furniture bbox center are occupied rooms. A
  // center landing ON a wall cell taints the neighboring rooms instead —
  // half-overlap is ambiguity, and ambiguity must not become a keep-out.
  const centers = furnitureCenters(drawing)
  const furnished = new Uint8Array(n)
  for (const [fx, fy] of centers) {
    const gx = Math.floor((fx - ox) / cell)
    const gy = Math.floor((fy - oy) / cell)
    if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue
    const id = comp[gy * W + gx]
    if (id >= 0) {
      furnished[id] = 1
    } else if (wall[gy * W + gx]) {
      for (const j of [gy * W + gx - 1, gy * W + gx + 1, (gy - 1) * W + gx, (gy + 1) * W + gx]) {
        if (j >= 0 && j < W * H && comp[j] >= 0) furnished[comp[j]] = 1
      }
    }
  }

  // Tight bboxes (source coords) of the surviving candidates.
  const box = new Float64Array(n * 4)
  box.fill(Infinity)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = comp[y * W + x]
      if (id < 0) continue
      box[id * 4] = Math.min(box[id * 4], ox + x * cell)
      box[id * 4 + 1] = Math.min(box[id * 4 + 1], oy + y * cell)
      box[id * 4 + 2] = Math.min(box[id * 4 + 2], -(ox + (x + 1) * cell))
      box[id * 4 + 3] = Math.min(box[id * 4 + 3], -(oy + (y + 1) * cell))
    }
  }
  let boxes: [number, number, number, number][] = []
  for (let id = 0; id < n; id++) {
    const area = counts[id] * cell * cell
    if (touchesBand[id] || furnished[id] || area < KEEPOUT_MIN_M2 || area > KEEPOUT_MAX_M2) continue
    boxes.push([box[id * 4], box[id * 4 + 1], -box[id * 4 + 2], -box[id * 4 + 3]])
  }

  // (d) Merge near-touching bboxes: one stair+shaft cluster, one core block.
  let fused = true
  while (fused) {
    fused = false
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const gapX = Math.max(a[0] - b[2], b[0] - a[2], 0)
        const gapY = Math.max(a[1] - b[3], b[1] - a[3], 0)
        if (gapX <= KEEPOUT_MERGE_GAP && gapY <= KEEPOUT_MERGE_GAP) {
          boxes[i] = [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[2], b[2]),
            Math.max(a[3], b[3]),
          ]
          boxes.splice(j, 1)
          fused = true
          break outer
        }
      }
    }
  }

  // (e) An L-shaped cluster's bbox can overreach into furnished floor (its
  // notch). Trim each rect just past any furniture center it contains —
  // cheapest edge first — so a keep-out never claims occupied floor; rects
  // trimmed below the minimum room size drop out.
  const EPS = 0.01
  boxes = boxes.filter((b) => {
    for (let guard = 0; guard < 64; guard++) {
      const hit = centers.find(
        ([cx, cy]) => cx > b[0] + EPS && cx < b[2] - EPS && cy > b[1] + EPS && cy < b[3] - EPS,
      )
      if (!hit) break
      const [cx, cy] = hit
      const w = b[2] - b[0]
      const h = b[3] - b[1]
      const costs = [(cx - b[0]) * h, (b[2] - cx) * h, (cy - b[1]) * w, (b[3] - cy) * w]
      const k = costs.indexOf(Math.min(...costs))
      if (k === 0) b[0] = cx + EPS
      else if (k === 1) b[2] = cx - EPS
      else if (k === 2) b[1] = cy + EPS
      else b[3] = cy - EPS
      if (b[2] - b[0] <= 0 || b[3] - b[1] <= 0) break
    }
    return (b[2] - b[0]) * (b[3] - b[1]) >= KEEPOUT_MIN_M2
  })

  // (f) Sanity caps: largest first, total area ≤ 40% of plate, ≤ 12 rects.
  boxes.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))
  const out: KeepOutRect[] = []
  let claimed = 0
  const budget = plate.areaM2 * KEEPOUT_AREA_FRAC
  for (const [x0, y0, x1, y1] of boxes) {
    if (out.length >= KEEPOUT_MAX_COUNT) break
    const area = (x1 - x0) * (y1 - y0)
    if (claimed + area > budget) continue
    claimed += area
    out.push({
      x: (x0 + x1) / 2 - plate.offset.x,
      y: (y0 + y1) / 2 - plate.offset.y,
      w: x1 - x0,
      h: y1 - y0,
      label: `Core ${out.length + 1}`,
    })
  }
  return out
}

/** Push detected keep-outs into the editor. Calls through a guarded cast:
 *  `Editor.add_keepout` ships from the Rust side and may be absent in stale
 *  wasm bindings — then this is a no-op. */
export function pushKeepoutsToEditor(ec: EditorCanvas, keepouts: KeepOutRect[]): void {
  const ed = ec.ed as unknown as {
    add_keepout?: (x: number, y: number, w: number, h: number, label: string) => number
  }
  if (!ed.add_keepout || keepouts.length === 0) return
  for (const k of keepouts) ed.add_keepout(k.x, k.y, k.w, k.h, k.label)
  ec.refresh()
}

// ---- wall-segment collection -------------------------------------------

/** Categories that form the building shell. Glazing is included because real
 *  plans routinely draw the perimeter as curtain wall — wall-only collection
 *  finds an interior room as the "largest loop" on such drawings. */
const SHELL_CATEGORIES = new Set(['wall', 'glazing'])

/** Widened shell set for rasterization: door thresholds and casework runs
 *  close the gaps that a wall-only raster leaks the flood fill through. */
const WIDE_SHELL_CATEGORIES = new Set(['wall', 'glazing', 'door', 'casework'])

/** One entity's segments: polyline pt pairs (+closing pair) and tessellated arcs. */
function pushEntitySegments(e: DrawEntity, segs: Segment[]): void {
  if (e.kind === 'polyline' && e.pts && e.pts.length >= 2) {
    for (let i = 0; i + 1 < e.pts.length; i++) segs.push([e.pts[i], e.pts[i + 1]])
    if (e.closed && e.pts.length >= 3) segs.push([e.pts[e.pts.length - 1], e.pts[0]])
  } else if ((e.kind === 'arc' || e.kind === 'circle') && e.cx != null && e.cy != null && e.r != null) {
    // Tessellate so curved walls participate in loop tracing / rasterizing.
    const a0 = e.kind === 'circle' ? 0 : (e.start ?? 0)
    let a1 = e.kind === 'circle' ? Math.PI * 2 : (e.end ?? Math.PI * 2)
    while (a1 <= a0) a1 += Math.PI * 2
    const sweep = a1 - a0
    const n = Math.max(8, Math.ceil((sweep * e.r) / 0.2))
    let prev: Pt = [e.cx + e.r * Math.cos(a0), e.cy + e.r * Math.sin(a0)]
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n
      const p: Pt = [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]
      segs.push([prev, p])
      prev = p
    }
  }
}

/** All wall/glazing segments — the clean linework the loop tracer runs on. */
export function collectWallSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const e of drawing.entities) {
    if (SHELL_CATEGORIES.has(e.category)) pushEntitySegments(e, segs)
  }
  return segs
}

/** The widened raster shell: wall/glazing/door/casework linework, column-ish
 *  `other` closed polylines, plus the bbox outlines of shell-category block
 *  inserts — on real plans most windows and doors are INSERTs living in
 *  `drawing.furniture`, not loose entities, and without them the perimeter
 *  raster is full of holes. */
function collectShellSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const e of drawing.entities) {
    if (WIDE_SHELL_CATEGORIES.has(e.category)) {
      pushEntitySegments(e, segs)
    } else if (e.category === 'other' && e.kind === 'polyline' && e.closed && e.pts && e.pts.length >= 3) {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of e.pts) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      if (x1 - x0 <= COLUMN_MAX_SIDE && y1 - y0 <= COLUMN_MAX_SIDE) pushEntitySegments(e, segs)
    }
  }
  for (const f of drawing.furniture) {
    if (WIDE_SHELL_CATEGORIES.has(f.category) && f.category !== 'wall') {
      pushBoxSegments(f.bbox, segs)
    }
  }
  return segs
}

/** The four edges of an axis-aligned bbox as segments. */
function pushBoxSegments(bbox: [number, number, number, number], segs: Segment[]): void {
  const [x0, y0, x1, y1] = bbox
  segs.push(
    [
      [x0, y0],
      [x1, y0],
    ],
    [
      [x1, y0],
      [x1, y1],
    ],
    [
      [x1, y1],
      [x0, y1],
    ],
    [
      [x0, y1],
      [x0, y0],
    ],
  )
}

/** Every furniture bbox outline — the wrap fallback rasterizes these so the
 *  traced region contains the furniture field by construction. */
function furnitureBoxSegments(drawing: Drawing): Segment[] {
  const segs: Segment[] = []
  for (const f of drawing.furniture) pushBoxSegments(f.bbox, segs)
  return segs
}

// ---- furniture coverage --------------------------------------------------

/** Bbox centers of every placed block instance (all categories — they are all program). */
function furnitureCenters(drawing: Drawing): Pt[] {
  return drawing.furniture.map((f): Pt => [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2])
}

/** Fraction of `centers` inside (or within `COVERAGE_EDGE_TOL` of) `ring`.
 *  Vacuously 1 with no furniture, so furniture-free drawings keep the plain
 *  area-plausibility ladder. */
function ringCoverage(ring: Pt[], centers: Pt[]): number {
  if (centers.length === 0) return 1
  let inside = 0
  for (const [x, y] of centers) if (coveredByRing(x, y, ring)) inside++
  return inside / centers.length
}

/** Plain ray-cast point-in-polygon (ring: first vertex not repeated). Exported
 *  so the area-select filter (`import/area.ts`) reuses the one point-in-polygon
 *  implementation rather than forking it (no-bloat). */
export function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Ray-cast point-in-polygon, with centers within `COVERAGE_EDGE_TOL` of an
 *  edge counting as covered — perimeter windows/doors sit ON the wall line the
 *  boundary traces through, so exact containment would flap on them. */
function coveredByRing(x: number, y: number, ring: Pt[]): boolean {
  if (pointInRing(x, y, ring)) return true
  const tol2 = COVERAGE_EDGE_TOL * COVERAGE_EDGE_TOL
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    const ex = x - (ax + t * dx)
    const ey = y - (ay + t * dy)
    if (ex * ex + ey * ey <= tol2) return true
  }
  return false
}

// ---- pinch detection ------------------------------------------------------

/**
 * Trace-artifact detector: true when the ring's interior contains two or more
 * regions of at least `PINCH_AREA_M2` that connect only through passages
 * narrower than `PINCH_PASSAGE_M`. Real plates join their areas through
 * door-width-or-better openings; a sub-door neck between two big areas is the
 * signature of a mis-trace (the outside flood leaked around a room and the
 * boundary threads a wall cavity), so the candidate ladder keeps escalating
 * its closing radius instead of accepting the pinched ring.
 */
function ringPinched(ring: Pt[]): boolean {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0 && h > 0)) return false
  // Adaptive cell keeps the raster small on pathological extents.
  const cell = Math.max(PINCH_CELL, Math.sqrt((w * h) / 250_000))
  const W = Math.ceil(w / cell) + 4
  const H = Math.ceil(h / cell) + 4
  // Scanline fill of the ring interior.
  const inside = fillRing(ring, minX - 2 * cell, minY - 2 * cell, cell, W, H)
  // Clearance to the exterior: Chebyshev BFS (8-neighbor), matching the
  // Chebyshev box kernel gridContour closes with.
  const dist = new Int32Array(W * H).fill(-1)
  let frontier: number[] = []
  for (let i = 0; i < W * H; i++) {
    if (!inside[i]) {
      dist[i] = 0
      frontier.push(i)
    }
  }
  let d = 0
  while (frontier.length > 0) {
    d++
    const next: number[] = []
    for (const i of frontier) {
      const x = i % W
      const y = (i - x) / W
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
          const j = ny * W + nx
          if (dist[j] === -1) {
            dist[j] = d
            next.push(j)
          }
        }
    }
    frontier = next
  }
  // Regions of clearance ≥ PINCH_PASSAGE_M/2 fall apart at every narrower
  // neck; two big survivors ⇒ the plate's areas only meet through a pinch.
  const t = Math.max(1, Math.round(PINCH_PASSAGE_M / 2 / cell))
  const minCells = Math.ceil(PINCH_AREA_M2 / (cell * cell))
  const seen = new Uint8Array(W * H)
  let bigRegions = 0
  for (let i0 = 0; i0 < W * H; i0++) {
    if (dist[i0] < t || seen[i0]) continue
    let count = 0
    const st = [i0]
    seen[i0] = 1
    while (st.length > 0) {
      const i = st.pop()!
      count++
      const x = i % W
      const y = (i - x) / W
      const nb = [i - 1, i + 1, i - W, i + W]
      const ok = [x > 0, x < W - 1, y > 0, y < H - 1]
      for (let k = 0; k < 4; k++) {
        if (ok[k] && dist[nb[k]] >= t && !seen[nb[k]]) {
          seen[nb[k]] = 1
          st.push(nb[k])
        }
      }
    }
    if (count >= minCells) bigRegions++
    if (bigRegions >= 2) return true
  }
  return false
}

// ---- loop tracing (planar-graph face traversal) --------------------------

/**
 * Snap segment endpoints to a `tol` grid, build the wall graph, prune dangling
 * chains, then trace the faces of the planar subdivision. Returns every face
 * ring (first vertex not repeated). The floor plate is the largest-|area| one.
 */
export function traceLoops(segments: Segment[], tol = SNAP_TOL): Pt[][] {
  // Snap endpoints → node ids (first-seen coordinate represents the cell).
  const nodes: Pt[] = []
  const keyToId = new Map<string, number>()
  const idOf = (p: Pt): number => {
    const k = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`
    let id = keyToId.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push(p)
      keyToId.set(k, id)
    }
    return id
  }

  const adj: Set<number>[] = []
  const ensure = (id: number) => {
    while (adj.length <= id) adj.push(new Set())
  }
  for (const [a, b] of segments) {
    const u = idOf(a)
    const v = idOf(b)
    if (u === v) continue
    ensure(Math.max(u, v))
    adj[u].add(v)
    adj[v].add(u)
  }

  // Prune degree ≤ 1 nodes iteratively (dangling stubs break clean faces).
  const queue: number[] = []
  for (let i = 0; i < adj.length; i++) if (adj[i].size <= 1) queue.push(i)
  while (queue.length > 0) {
    const u = queue.pop()!
    if (adj[u].size > 1) continue
    for (const v of adj[u]) {
      adj[v].delete(u)
      if (adj[v].size <= 1) queue.push(v)
    }
    adj[u].clear()
  }

  // Angular order of neighbors per node (CCW), for face traversal.
  const sorted: number[][] = adj.map((nbrs, u) =>
    [...nbrs].sort(
      (p, q) =>
        Math.atan2(nodes[p][1] - nodes[u][1], nodes[p][0] - nodes[u][0]) -
        Math.atan2(nodes[q][1] - nodes[u][1], nodes[q][0] - nodes[u][0]),
    ),
  )

  // Trace each face once: from half-edge u→v, at v continue with the neighbor
  // clockwise-previous to the reverse edge v→u.
  const used = new Set<number>()
  const N = nodes.length
  const loops: Pt[][] = []
  for (let u0 = 0; u0 < adj.length; u0++) {
    for (const v0 of sorted[u0]) {
      if (used.has(u0 * N + v0)) continue
      const ring: Pt[] = []
      let u = u0
      let v = v0
      let guard = segments.length * 4 + 16
      while (!used.has(u * N + v) && guard-- > 0) {
        used.add(u * N + v)
        ring.push(nodes[u])
        const list = sorted[v]
        const i = list.indexOf(u)
        const w = list[(i - 1 + list.length) % list.length]
        u = v
        v = w
      }
      if (ring.length >= 3) loops.push(ring)
    }
  }
  return loops
}

// ---- occupancy-grid fallback ---------------------------------------------

/**
 * Rasterize wall segments onto a `cell`-meter grid, morphologically close the
 * linework (dilate `dilate` cells, then erode the dilated mask by the same
 * Chebyshev box), flood-fill the outside across the closed mask, keep the
 * largest enclosed component and Moore-trace its outer contour. Returns a
 * simplified polygon or null when the region degenerates.
 *
 * Closing the mask itself — rather than eroding against the outside flood, as
 * this used to — is what preserves passage widths. Dilation is exactly
 * {Chebyshev distance to linework ≤ dilate}, so eroding it keeps no cell
 * farther than `dilate` cells from a real wall: the reconstruction rule
 * "closing-added cell deeper than `dilate` into free space ⇒ free again"
 * holds by construction. Gaps and cavities narrower than 2·dilate·cell close;
 * anything wider stays open at full width. The old erode-the-fill approach
 * kept fused-flood residue where dilation had bridged a doorway, thinning a
 * real ≥1 m opening to a sliver in the traced polygon.
 */
export function gridContour(segments: Segment[], cell = GRID_CELL, dilate = GRID_DILATE): Pt[] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [a, b] of segments) {
    minX = Math.min(minX, a[0], b[0])
    minY = Math.min(minY, a[1], b[1])
    maxX = Math.max(maxX, a[0], b[0])
    maxY = Math.max(maxY, a[1], b[1])
  }
  if (!isFinite(minX)) return null
  const pad = (dilate + 2) * cell
  const ox = minX - pad
  const oy = minY - pad
  const W = Math.max(4, Math.ceil((maxX - minX + 2 * pad) / cell))
  const H = Math.max(4, Math.ceil((maxY - minY + 2 * pad) / cell))
  if (W * H > 4_000_000) return null // pathological extent — let hull handle it

  const idx = (x: number, y: number) => y * W + x
  const wall = new Uint8Array(W * H)
  stampSegments(segments, wall, ox, oy, cell, W, H)

  // Close: dilate walls by `dilate` cells (Chebyshev box).
  const dil = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!wall[idx(x, y)]) continue
      for (let dy = -dilate; dy <= dilate; dy++)
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) dil[idx(nx, ny)] = 1
        }
    }

  // Erode the dilated mask by the same box: the morphological closing of the
  // linework. Every surviving cell has its whole box inside the dilation, so
  // no closed cell lies deeper than `dilate` cells (Chebyshev) into original
  // free space — a passage wider than 2·dilate·cell can never fuse shut.
  const closed = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    outer: for (let x = 0; x < W; x++) {
      if (!dil[idx(x, y)]) continue
      for (let dy = -dilate; dy <= dilate; dy++)
        for (let dx = -dilate; dx <= dilate; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !dil[idx(nx, ny)]) continue outer
        }
      closed[idx(x, y)] = 1
    }

  // Flood the outside across non-closed cells from the grid border.
  const outside = new Uint8Array(W * H)
  const stack: number[] = []
  const pushOut = (x: number, y: number) => {
    const i = idx(x, y)
    if (!outside[i] && !closed[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < W; x++) {
    pushOut(x, 0)
    pushOut(x, H - 1)
  }
  for (let y = 0; y < H; y++) {
    pushOut(0, y)
    pushOut(W - 1, y)
  }
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % W
    const y = (i - x) / W
    if (x > 0) pushOut(x - 1, y)
    if (x < W - 1) pushOut(x + 1, y)
    if (y > 0) pushOut(x, y - 1)
    if (y < H - 1) pushOut(x, y + 1)
  }

  // Solid = everything the outside flood cannot reach: real walls, sub-2k
  // bridges, and the interiors they enclose. The closing already sits at true
  // wall scale, so there is no dilation left to undo.
  const er = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) er[i] = outside[i] ? 0 : 1

  // Largest 4-connected solid component.
  const { comp, counts } = labelComponents(er, W, H)
  let bestComp = -1
  let bestCount = 0
  for (let id = 0; id < counts.length; id++) {
    if (counts[id] > bestCount) {
      bestCount = counts[id]
      bestComp = id
    }
  }
  if (bestComp < 0 || bestCount < 4) return null
  const solid = (x: number, y: number) =>
    x >= 0 && x < W && y >= 0 && y < H && comp[idx(x, y)] === bestComp

  // Moore neighbor tracing (clockwise) of the component's outer contour.
  let sx = -1
  let sy = -1
  outerScan: for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (solid(x, y)) {
        sx = x
        sy = y
        break outerScan
      }
  const dirs: Pt[] = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ]
  const dirIndex = (dx: number, dy: number) => dirs.findIndex((d) => d[0] === dx && d[1] === dy)
  const contourCells: Pt[] = [[sx, sy]]
  let cx = sx
  let cy = sy
  let bx = sx - 1 // backtrack starts west of start (non-solid by scan order)
  let by = sy
  let guard = 4 * W * H
  do {
    const from = dirIndex(bx - cx, by - cy)
    let advanced = false
    for (let k = 1; k <= 8; k++) {
      const d = dirs[(from + k) % 8]
      const nx = cx + d[0]
      const ny = cy + d[1]
      if (solid(nx, ny)) {
        const pd = dirs[(from + k - 1) % 8]
        bx = cx + pd[0]
        by = cy + pd[1]
        cx = nx
        cy = ny
        contourCells.push([cx, cy])
        advanced = true
        break
      }
    }
    if (!advanced) break // isolated cell
  } while ((cx !== sx || cy !== sy) && guard-- > 0)
  if (contourCells.length < 3) return null
  // Drop the repeated start cell if the trace closed on it.
  const last = contourCells[contourCells.length - 1]
  if (last[0] === sx && last[1] === sy) contourCells.pop()

  const poly: Pt[] = contourCells.map(([gx, gy]) => [ox + (gx + 0.5) * cell, oy + (gy + 0.5) * cell])
  const simplified = simplify(poly, SIMPLIFY_CONTOUR, true)
  return simplified.length >= 3 ? simplified : null
}

// ---- raster utilities -------------------------------------------------------

/** Stamp `segments` onto a W×H occupancy `mask` (origin ox/oy, `cell` meters):
 *  sample each segment every half-cell and mark the containing cell. */
function stampSegments(
  segments: Segment[],
  mask: Uint8Array,
  ox: number,
  oy: number,
  cell: number,
  W: number,
  H: number,
): void {
  for (const [a, b] of segments) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const gx = Math.floor((a[0] + (b[0] - a[0]) * t - ox) / cell)
      const gy = Math.floor((a[1] + (b[1] - a[1]) * t - oy) / cell)
      if (gx >= 0 && gx < W && gy >= 0 && gy < H) mask[gy * W + gx] = 1
    }
  }
}

/** Scanline-fill a ring's interior onto a W×H grid (origin ox/oy, `cell`
 *  meters): a cell is marked when its CENTER lies inside the polygon. */
function fillRing(ring: Pt[], ox: number, oy: number, cell: number, W: number, H: number): Uint8Array {
  const inside = new Uint8Array(W * H)
  for (let gy = 0; gy < H; gy++) {
    const y = oy + (gy + 0.5) * cell
    const xs: number[] = []
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y) xs.push(xi + ((xj - xi) * (y - yi)) / (yj - yi))
    }
    xs.sort((a, b) => a - b)
    for (let p = 0; p + 1 < xs.length; p += 2) {
      const gx0 = Math.max(0, Math.ceil((xs[p] - ox) / cell - 0.5))
      const gx1 = Math.min(W - 1, Math.floor((xs[p + 1] - ox) / cell - 0.5))
      for (let gx = gx0; gx <= gx1; gx++) inside[gy * W + gx] = 1
    }
  }
  return inside
}

/** 4-connected component labeling of the truthy cells of `pass`.
 *  `comp[i]` is the component id (or -1); `counts[id]` its cell count. */
function labelComponents(pass: Uint8Array, W: number, H: number): { comp: Int32Array; counts: number[] } {
  const comp = new Int32Array(W * H).fill(-1)
  const counts: number[] = []
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!pass[i0] || comp[i0] !== -1) continue
    const id = counts.length
    let count = 0
    const st = [i0]
    comp[i0] = id
    while (st.length > 0) {
      const i = st.pop()!
      count++
      const x = i % W
      const y = (i - x) / W
      const nb = [i - 1, i + 1, i - W, i + W]
      const ok = [x > 0, x < W - 1, y > 0, y < H - 1]
      for (let k = 0; k < 4; k++) {
        if (ok[k] && pass[nb[k]] && comp[nb[k]] === -1) {
          comp[nb[k]] = id
          st.push(nb[k])
        }
      }
    }
    counts.push(count)
  }
  return { comp, counts }
}

// ---- polygon utilities ----------------------------------------------------

/** Shoelace signed area (CCW positive). Ring: first vertex not repeated. */
export function signedArea(ring: Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % ring.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function orientCCW(ring: Pt[]): Pt[] {
  return signedArea(ring) < 0 ? [...ring].reverse() : ring
}

/**
 * Remove needle spikes from a closed ring (first vertex not repeated).
 *
 * A vertex is a spike candidate when the wedge between its two edges is below
 * `wedgeDeg` (the edges nearly double back — |turn| > 180° − wedgeDeg). It is
 * only removed when doing so changes the ring's |area| by at most `areaFrac`
 * of the total — that guard is what separates a contour-tracer needle from a
 * genuine narrow wing of the building. Iterates until a full pass removes
 * nothing; never drops below 3 vertices; preserves vertex order/orientation.
 */
export function despike(
  ring: Pt[],
  opts: { wedgeDeg?: number; areaFrac?: number } = {},
): Pt[] {
  const wedgeDeg = opts.wedgeDeg ?? DESPIKE_WEDGE_DEG
  const areaFrac = opts.areaFrac ?? DESPIKE_AREA_FRAC
  const cosMin = Math.cos((wedgeDeg * Math.PI) / 180) // wedge < wedgeDeg ⇔ cos(wedge) > cosMin
  const out = [...ring]
  const totalArea = Math.abs(signedArea(out))
  const maxAreaDelta = totalArea * areaFrac

  let removed = true
  while (removed && out.length > 3) {
    removed = false
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const p = out[(i - 1 + out.length) % out.length]
      const v = out[i]
      const n = out[(i + 1) % out.length]
      const ax = p[0] - v[0]
      const ay = p[1] - v[1]
      const bx = n[0] - v[0]
      const by = n[1] - v[1]
      const la = Math.hypot(ax, ay)
      const lb = Math.hypot(bx, by)
      // Degenerate (duplicate neighbor) counts as a zero-area spike.
      const isSpike = la < 1e-9 || lb < 1e-9 || (ax * bx + ay * by) / (la * lb) > cosMin
      if (!isSpike) continue
      // Removing v changes the area by the triangle (p, v, n).
      const triArea = Math.abs(ax * by - ay * bx) / 2
      if (triArea > maxAreaDelta) continue
      out.splice(i, 1)
      i--
      removed = true
    }
  }
  return out
}

/** Douglas-Peucker simplification. `closed` treats pts as a ring. */

/**
 * Visvalingam–Whyatt smoothing: repeatedly remove the vertex whose triangle
 * (prev, v, next) has the smallest area, while it stays under `triM2` and the
 * ring's cumulative |area| drift stays under `driftFrac`. Complements despike:
 * despike kills needle REVERSALS; this collapses the small jags and stair-step
 * wedges the occupancy tracer leaves at diagonal walls — the slivers that made
 * even an EMPTY plate report a 0.3 m "min corridor".
 */
export function smooth(
  ring: Pt[],
  opts: { triM2?: number; driftFrac?: number } = {},
): Pt[] {
  const triM2 = opts.triM2 ?? SMOOTH_TRI_M2
  const driftFrac = opts.driftFrac ?? SMOOTH_DRIFT_FRAC
  const out = [...ring]
  const total = Math.abs(signedArea(out))
  let budget = total * driftFrac
  const triArea = (i: number): number => {
    const n = out.length
    const [ax, ay] = out[(i - 1 + n) % n]
    const [bx, by] = out[i]
    const [cx, cy] = out[(i + 1) % n]
    return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  while (out.length > 4) {
    let best = -1
    let bestA = triM2
    for (let i = 0; i < out.length; i++) {
      const a = triArea(i)
      if (a < bestA) {
        bestA = a
        best = i
      }
    }
    if (best < 0 || bestA > budget) break
    out.splice(best, 1)
    budget -= bestA
  }
  return out
}
export function simplify(pts: Pt[], tol: number, closed = false): Pt[] {
  // Collapse consecutive duplicates first.
  const src: Pt[] = []
  for (const p of pts) {
    const q = src[src.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) src.push(p)
  }
  if (src.length <= 2) return src
  const chain = closed ? [...src, src[0]] : src
  const keep = new Uint8Array(chain.length)
  keep[0] = keep[chain.length - 1] = 1
  const stack: [number, number][] = [[0, chain.length - 1]]
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!
    if (i1 - i0 < 2) continue
    const [ax, ay] = chain[i0]
    const [bx, by] = chain[i1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    let maxD = -1
    let maxI = -1
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = chain[i]
      let d: number
      if (len2 < 1e-12) {
        d = Math.hypot(px - ax, py - ay)
      } else {
        d = Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(len2)
      }
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > tol) {
      keep[maxI] = 1
      stack.push([i0, maxI], [maxI, i1])
    }
  }
  const out: Pt[] = []
  for (let i = 0; i < chain.length - (closed ? 1 : 0); i++) if (keep[i]) out.push(chain[i])
  return out
}

/** Andrew's monotone-chain convex hull (CCW, no repeated first vertex). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const dedup: Pt[] = []
  for (const p of pts) {
    const q = dedup[dedup.length - 1]
    if (!q || q[0] !== p[0] || q[1] !== p[1]) dedup.push(p)
  }
  if (dedup.length < 3) return dedup
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of dedup) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (let i = dedup.length - 1; i >= 0; i--) {
    const p = dedup[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

// ---- finalization -----------------------------------------------------

/** Translate the ring so its min corner sits at (EDITOR_MARGIN, EDITOR_MARGIN). */
/** Ladder rung → the provenance vocabulary shown to the user. */
const PROVENANCE_METHOD: Record<PlateResult['method'], PlateMethod> = {
  loop: 'traced-loop',
  hull: 'grid-contour', // the 'hull' rung is the grid contour; true hull is the 'wrap' last resort
  wrap: 'hull',
}

function finishPlate(c: {
  ring: Pt[]
  method: PlateResult['method']
  coverage: number
  area: number
  /** Source drawing — needed to check the boundary against real linework. */
  drawing?: Drawing | null
  /** Overrides the ladder mapping (area-select is user-traced, not inferred). */
  provenanceMethod?: PlateMethod
}): PlateResult {
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of c.ring) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
  }
  const offset = { x: minX - EDITOR_MARGIN, y: minY - EDITOR_MARGIN }
  // Assessed in SOURCE coordinates, before the editor offset is applied, so the
  // ring lines up with the drawing's own linework.
  const method = c.provenanceMethod ?? PROVENANCE_METHOD[c.method]
  const provenance = c.drawing !== undefined
    ? assessPlate(c.ring, c.drawing, method)
    : undefined
  return {
    boundary: c.ring.map(([x, y]) => [x - offset.x, y - offset.y]),
    offset,
    method: c.method,
    coverage: c.coverage,
    areaM2: c.area,
    provenance,
  }
}

// ---- area-select plate ------------------------------------------------------

/** Source-coord bounding box [x0,y0,x1,y1] of a finished plate (undoes offset). */
export function plateSourceBounds(p: PlateResult): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p.boundary) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return [x0 + p.offset.x, y0 + p.offset.y, x1 + p.offset.x, y1 + p.offset.y]
}

/** Clip a polygon to an axis-aligned rectangle (Sutherland–Hodgman; the rect is
 *  convex so this is exact). Returns the clipped ring (possibly empty). */
function clipToRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  const stage = (pts: Pt[], inside: (p: Pt) => boolean, cut: (a: Pt, b: Pt) => Pt): Pt[] => {
    const out: Pt[] = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const cur = pts[i]
      const prev = pts[(i + n - 1) % n]
      const curIn = inside(cur)
      const prevIn = inside(prev)
      if (curIn) {
        if (!prevIn) out.push(cut(prev, cur))
        out.push(cur)
      } else if (prevIn) {
        out.push(cut(prev, cur))
      }
    }
    return out
  }
  let r = poly
  r = stage(r, (p) => p[0] >= x0, (a, b) => [x0, a[1] + ((x0 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])])
  if (r.length < 3) return r
  r = stage(r, (p) => p[0] <= x1, (a, b) => [x1, a[1] + ((x1 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])])
  if (r.length < 3) return r
  r = stage(r, (p) => p[1] >= y0, (a, b) => [a[0] + ((y0 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y0])
  if (r.length < 3) return r
  r = stage(r, (p) => p[1] <= y1, (a, b) => [a[0] + ((y1 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y1])
  return r
}

/**
 * Build a floor plate that matches a user-selected AREA polygon (source coords)
 * instead of a tight hull around whatever furniture the lasso happened to catch.
 * The polygon IS the work boundary; we only clip it to the building's bounding
 * box (`bounds`, source coords) so a loose lasso never spills past the floor.
 * Returns null when the clipped region is degenerate (< ~4 m²), so a stray tiny
 * selection can't seed an empty plate. The caller's `?? extractPlate(...)` is a
 * WEAK fallback, not a guarantee — it traces the area-restricted drawing, which
 * such a selection has usually already emptied; see `plate.ts`.
 */
export function plateFromArea(
  polygon: Pt[],
  bounds: [number, number, number, number],
  /** Source drawing, for provenance. Optional: a user-traced plate is trusted
   *  regardless, so callers that lack it still get `confidence: 'high'`. */
  drawing?: Drawing,
): PlateResult | null {
  if (!polygon || polygon.length < 3) return null
  const clipped = clipToRect(polygon, bounds[0], bounds[1], bounds[2], bounds[3])
  if (clipped.length < 3) return null
  const area = Math.abs(signedArea(clipped))
  if (area < 4) return null
  return finishPlate({ ring: clipped, method: 'loop', coverage: 1, area, drawing: drawing ?? null, provenanceMethod: 'user-traced' })
}
