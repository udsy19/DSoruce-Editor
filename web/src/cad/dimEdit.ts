// Dimension-edit math + formatting behind M4's "click a dimension label, type a
// new value" (Rayon parity, editor-ux doc §M4). Pure and dependency-free so it
// is unit-testable in node (like dynamicInput.ts / strategy.ts). Coordinates are
// METERS in EditorCanvas world space, same convention as cad/snap.ts.

import type { Vec2 } from './model'

/** On-canvas dimension text: meters, 2-dp — the single source for the label
 *  format shared by the M1 helper chips and the M4 selection dimensions. */
export function fmtMeters(m: number): string {
  return `${m.toFixed(2)} m`
}

/** Parse a typed dimension buffer into a finite number (blank / junk → null). */
export function parseDim(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * Move endpoint `b` along the current a→b bearing so the segment has length
 * `len` (anchoring `a`). A degenerate (zero-length) segment falls back to +x so
 * a value can still be applied. `len` is clamped non-negative.
 */
export function endpointForLength(a: Vec2, b: Vec2, len: number): Vec2 {
  const L = Math.max(0, len)
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  if (d < 1e-9) return { x: a.x + L, y: a.y }
  const k = L / d
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}
