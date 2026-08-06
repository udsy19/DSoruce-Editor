// Wall-type classification for the qbiq-parity plan graphic.
//
// THE CORE IS THE CLASSIFIER — THIS IS THE FALLBACK
// -------------------------------------------------
// `crates/ds-core/src/quantity.rs` owns wall-type classification, and it is the
// same code path the Quantity Takeoff workbook bills from. Call
// `editor.wall_types()` and pass the result as `classifyWalls(state, coreTypes)`
// (or as `renderHighlightedPlan(state, { wallSpans })`) so the coloured plan and
// the workbook can never disagree — that agreement is exactly what gate G3
// checks. `DocWall.wall_type`, if the core ever inlines it into `state()`, is
// honoured too.
//
// The heuristic below is the LAST resort, for callers with no wasm editor to
// hand. It derives the legend classes from what the document carries on its own
// (`glazing`, `generated`, Core zones, plate-boundary adjacency) and, unlike the
// core, splits a bare perimeter run into solid corner returns plus a glazed
// band. That split is a drawing convenience, NOT a quantity: it changes the
// per-type length totals, so never take wall quantities from this module.
// Pure, deterministic, no DOM.

import type { DocState, DocWall, DocZone } from '../types/doc'
import { zoneBBox } from '../util/zoneGeom'
import type { WallType } from './qbiqPalette'

export type { WallType }

/** One entry of `Editor.wall_types()` — the core's authoritative classification.
 *  `planKey` is a {@link WallType}; `lengthM` lets a caller reconcile totals. */
export interface CoreWallType {
  id: number
  planKey: WallType
  lengthM: number
}

/** A run of a wall carrying one type — a perimeter wall splits into a glazed
 *  band with solid returns, so a wall maps to 1..n typed spans, not one type. */
export interface WallSpan {
  wallId: number
  type: WallType
  ax: number
  ay: number
  bx: number
  by: number
  thickness: number
}

/** How close (m) a wall must sit to the plate bbox edge to count as perimeter. */
const PERIMETER_TOL = 0.4
/** Solid corner return (m) at each end of a glazed perimeter run — the pier a
 *  curtain-wall band stops short of. Only used when the document carries no
 *  explicit `Window` components to place the glazing from. */
const CORNER_RETURN = 0.6
/** Below this length a perimeter run is all solid (no room for a window band). */
const MIN_GLAZED_RUN = 2 * CORNER_RETURN + 0.5

function wallBBox(walls: DocWall[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/** True when the whole segment hugs one edge of the plate bounding box. */
function onPlateEdge(
  w: DocWall,
  bb: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const near = (v: number, e: number) => Math.abs(v - e) <= PERIMETER_TOL
  return (
    (near(w.a.x, bb.minX) && near(w.b.x, bb.minX)) ||
    (near(w.a.x, bb.maxX) && near(w.b.x, bb.maxX)) ||
    (near(w.a.y, bb.minY) && near(w.b.y, bb.minY)) ||
    (near(w.a.y, bb.maxY) && near(w.b.y, bb.maxY))
  )
}

/** Core / service zones (keep-outs render as `Core` zones) that swallow a wall.
 *  Tested against the zone bbox grown by `PERIMETER_TOL`, because a core wall
 *  sits ON the core outline rather than strictly inside it. */
function inCore(x: number, y: number, coreZones: DocZone[]): boolean {
  return coreZones.some((z) => {
    const bb = zoneBBox(z.shape)
    return (
      x >= bb.minX - PERIMETER_TOL &&
      x <= bb.maxX + PERIMETER_TOL &&
      y >= bb.minY - PERIMETER_TOL &&
      y <= bb.maxY + PERIMETER_TOL
    )
  })
}

function span(w: DocWall, type: WallType, t0: number, t1: number): WallSpan {
  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  return {
    wallId: w.id,
    type,
    ax: w.a.x + dx * t0,
    ay: w.a.y + dy * t0,
    bx: w.a.x + dx * t1,
    by: w.a.y + dy * t1,
    thickness: w.thickness,
  }
}

/**
 * Classify every wall into typed spans.
 *
 * Precedence: `coreTypes` (from `Editor.wall_types()`) › core-supplied
 * `wall_type` on the wall › glazing › core zone › plate perimeter › partition.
 * Deterministic: pure geometry, iteration follows `state.walls`.
 *
 * @param coreTypes `Editor.wall_types()`. Pass it whenever a wasm editor is in
 *   reach — it is the same classification the workbook bills from.
 */
export function classifyWalls(state: DocState, coreTypes?: CoreWallType[]): WallSpan[] {
  const bb = wallBBox(state.walls)
  const coreZones = (state.zones ?? []).filter((z) => z.zone_type === 'Core')
  // Explicit window components (imported CAD) pin the glazed spans when present.
  const windows = state.components.filter((c) => c.category === 'Window')
  const byId = new Map<number, WallType>(
    (coreTypes ?? []).map((c) => [c.id, c.planKey] as const),
  )
  const out: WallSpan[] = []

  for (const w of state.walls) {
    // 1. The core's own classification wins the moment it exists.
    const core = byId.get(w.id) ?? (w as DocWall & { wall_type?: WallType }).wall_type
    if (core) {
      out.push(span(w, core, 0, 1))
      continue
    }
    // 2. Glazed partition.
    if (w.glazing === true) {
      out.push(span(w, 'glass', 0, 1))
      continue
    }
    const mx = (w.a.x + w.b.x) / 2
    const my = (w.a.y + w.b.y) / 2
    // 3. Building core / service shaft.
    if (coreZones.length > 0 && inCore(mx, my, coreZones)) {
      out.push(span(w, 'core', 0, 1))
      continue
    }
    // 4. Plate perimeter — solid returns with a glazed band between.
    if (bb && w.generated !== true && onPlateEdge(w, bb)) {
      const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
      if (windows.length > 0) {
        out.push(...perimeterFromWindows(w, len, windows))
      } else if (len >= MIN_GLAZED_RUN) {
        const f = CORNER_RETURN / len
        out.push(span(w, 'perimeter_wall', 0, f))
        out.push(span(w, 'perimeter_windows', f, 1 - f))
        out.push(span(w, 'perimeter_wall', 1 - f, 1))
      } else {
        out.push(span(w, 'perimeter_wall', 0, 1))
      }
      continue
    }
    // 5. Interior partition. `half_drywall` has no document signal yet (the
    // reference plan uses zero of it too) — it stays a legend-only class until
    // the core reports partition height.
    out.push(span(w, 'drywall', 0, 1))
  }
  return out
}

/** Project explicit `Window` components onto a perimeter run to cut glazed spans. */
function perimeterFromWindows(
  w: DocWall,
  len: number,
  windows: { x: number; y: number; w: number }[],
): WallSpan[] {
  const dx = (w.b.x - w.a.x) / len
  const dy = (w.b.y - w.a.y) / len
  const cuts: [number, number][] = []
  for (const win of windows) {
    const t = ((win.x - w.a.x) * dx + (win.y - w.a.y) * dy) / len
    const perp = Math.abs((win.x - w.a.x) * -dy + (win.y - w.a.y) * dx)
    if (perp > 0.5 || t < 0 || t > 1) continue
    const half = win.w / 2 / len
    cuts.push([Math.max(0, t - half), Math.min(1, t + half)])
  }
  if (cuts.length === 0) return [span(w, 'perimeter_wall', 0, 1)]
  cuts.sort((a, b) => a[0] - b[0])
  const out: WallSpan[] = []
  let cursor = 0
  for (const [s, e] of cuts) {
    if (s > cursor + 1e-6) out.push(span(w, 'perimeter_wall', cursor, s))
    out.push(span(w, 'perimeter_windows', s, e))
    cursor = Math.max(cursor, e)
  }
  if (cursor < 1 - 1e-6) out.push(span(w, 'perimeter_wall', cursor, 1))
  return out
}
