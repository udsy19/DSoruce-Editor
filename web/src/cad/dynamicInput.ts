// Dynamic Input — the pure math + state behind cursor-first, type-as-you-draw
// precision (Rayon parity, doc §6.1). UI-agnostic and dependency-free so it is
// unit-testable in node (see dynamicInput.test.mjs), like strategy.ts.
//
// Coordinates are METERS in EditorCanvas world space (same convention as
// cad/snap.ts — no Y-flip). Angles are DEGREES in [0, 360), measured with the
// same bearing convention as geomTools.ts `bearing()` (atan2(dy, dx)), so 0° is
// +x and 90° is +y (downward on screen). This keeps the typed angle consistent
// with every tool's existing `hint()` readout.

import type { Vec2 } from './model'

const DEG = 180 / Math.PI
const RAD = Math.PI / 180

const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y)

/** Normalize degrees to [0, 360). */
export function norm360(d: number): number {
  d %= 360
  if (d < 0) d += 360
  return d
}

/** Bearing a→b in degrees, [0, 360). Mirrors geomTools.bearing(). */
export function bearingDeg(a: Vec2, b: Vec2): number {
  return norm360(Math.atan2(b.y - a.y, b.x - a.x) * DEG)
}

/** Smallest signed angular difference a−b in degrees, in (−180, 180]. */
function angDiff(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180
}

// ---- which field the typed digits flow into ------------------------------
export type DynField = 'distance' | 'angle'

export interface DynState {
  /** which field the typed digits go to */
  active: DynField
  /** raw text (meters); '' = follow the cursor */
  distance: string
  /** raw text (degrees); '' = follow cursor / polar snap */
  angle: string
}

export function emptyDyn(): DynState {
  return { active: 'distance', distance: '', angle: '' }
}

/** True when nothing has been typed — the point is still purely cursor-driven. */
export function dynEmpty(st: DynState): boolean {
  return st.distance === '' && st.angle === ''
}

/** A parsed numeric lock; `null` means "left blank, follow the cursor". */
export interface Typed {
  distance: number | null
  angleDeg: number | null
}

/** Parse the raw text buffers into numbers (blank / unparseable → null). */
export function parseTyped(st: DynState): Typed {
  const d = st.distance.trim()
  const a = st.angle.trim()
  const dn = d === '' ? NaN : Number(d)
  const an = a === '' ? NaN : Number(a)
  return {
    distance: Number.isFinite(dn) ? dn : null,
    angleDeg: Number.isFinite(an) ? an : null,
  }
}

// ---- polar / ortho snap ---------------------------------------------------
export interface PolarOpts {
  /** angular increment to snap to (90 = pure ortho, 45/15 = polar) */
  stepDeg: number
  /** how close (deg) the bearing must be to a multiple before it snaps */
  tolDeg?: number
  /** false → passthrough (no snapping) */
  enabled?: boolean
}

export interface PolarResult {
  /** `to`, rotated onto the snapped bearing (same distance from `from`) */
  point: Vec2
  /** the active bearing in degrees, [0, 360) */
  angleDeg: number
  /** whether the raw bearing was within tolerance of an increment */
  snapped: boolean
}

/**
 * Snap the in-progress segment `from`→`to` to the nearest ortho/polar bearing
 * (multiple of `stepDeg`) when the raw bearing is within `tolDeg`. Returns the
 * point rotated onto that bearing (preserving length) plus the active angle.
 * Passthrough (snapped=false) when disabled, degenerate, or out of tolerance.
 */
export function polarSnap(from: Vec2, to: Vec2, opts: PolarOpts): PolarResult {
  const d = dist(from, to)
  const raw = bearingDeg(from, to)
  const tol = opts.tolDeg ?? Math.min(opts.stepDeg / 2, 8)
  if (opts.enabled === false || d === 0 || opts.stepDeg <= 0) {
    return { point: { ...to }, angleDeg: raw, snapped: false }
  }
  const nearest = norm360(Math.round(raw / opts.stepDeg) * opts.stepDeg)
  if (Math.abs(angDiff(raw, nearest)) <= tol) {
    const a = nearest * RAD
    return {
      point: { x: from.x + Math.cos(a) * d, y: from.y + Math.sin(a) * d },
      angleDeg: nearest,
      snapped: true,
    }
  }
  return { point: { ...to }, angleDeg: raw, snapped: false }
}

// ---- resolve the candidate point -----------------------------------------
export interface Resolved {
  point: Vec2
  distance: number
  angleDeg: number
  /** whether a typed distance and/or angle constrained the point */
  locked: boolean
}

/**
 * Resolve the next point from the anchor, honoring any typed Distance/Angle and
 * falling back to the (optionally polar-snapped) cursor for blank fields:
 *  - both typed        → exact point at distance∠angle
 *  - distance only     → that distance along the cursor's (polar) direction
 *  - angle only        → the cursor's distance along the locked angle
 *  - neither typed     → the cursor point, polar-snapped when `polar` is armed
 * A half-typed value still previews, so the widget updates live as you type.
 */
export function resolvePoint(
  from: Vec2,
  cursor: Vec2,
  typed: Typed,
  polar?: PolarOpts,
): Resolved {
  // Free (cursor) direction — polar-snapped when armed and no angle is typed.
  const snap = polar ? polarSnap(from, cursor, polar) : null
  const cursorBearing = snap ? snap.angleDeg : bearingDeg(from, cursor)

  const angleDeg =
    typed.angleDeg != null ? norm360(typed.angleDeg) : cursorBearing
  const distance = typed.distance != null ? typed.distance : dist(from, cursor)

  const a = angleDeg * RAD
  const point = {
    x: from.x + Math.cos(a) * distance,
    y: from.y + Math.sin(a) * distance,
  }
  return {
    point,
    distance,
    angleDeg,
    locked: typed.distance != null || typed.angleDeg != null,
  }
}
