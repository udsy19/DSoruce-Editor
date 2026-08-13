// Workstream E: the containment report — for EVERY placed component, the worst
// signed distance its footprint stands OUTSIDE its zone's polygon.
//
//   node scripts/containment-report.mjs [dumpPath] [--out <path>]
//
// Inputs: the document dump written by scripts/containment-dump.e2e.mjs
// (component centers/sizes/rotations + zone shapes, world meters, straight off
// `Editor.state()`). Nothing here reads pixels, the renderer, or any
// producer-side "what I placed" summary — the geometry is re-derived from the
// document alone (gate-independence.md).
//
// Zone assignment REPLICATES `Document::zone_index_at` (document.rs): among
// zones containing the component's CENTER, ground zones (Circulation /
// Unassigned) lose to any specific zone; smallest area wins. It is computed
// here independently and CROSS-CHECKED against the core's own
// `zone.component_ids` — a mismatch is a finding, not an input.
//
// Signed distance: for points sampled on the footprint's boundary (4 corners +
// every ≤0.05 m along each edge), distance to the zone's boundary, positive
// when the point is outside the zone, negative inside. The component's "worst"
// is the maximum. A fully-contained footprint reports a negative worst (its
// closest approach to the boundary).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const argv = process.argv.slice(2)
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const DUMP = positional[0] ?? path.join(ROOT, 'reports/editor-completion/containment/state.candidateA.json')
const OUT = arg('--out', path.join(ROOT, 'reports/editor-completion/containment/containment-report.json'))

const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'))

// ---- geometry ---------------------------------------------------------------

const GROUND = new Set(['Circulation', 'Unassigned'])

function shapeArea(shape) {
  if (shape.kind === 'Rect') return shape.w * shape.h
  if (shape.kind === 'RectRing') return shape.w * shape.h - shape.in_w * shape.in_h
  // shoelace
  const pts = shape.pts
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

function pointInPoly(px, py, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function shapeContains(shape, px, py) {
  if (shape.kind === 'Rect')
    return Math.abs(px - shape.x) <= shape.w / 2 && Math.abs(py - shape.y) <= shape.h / 2
  if (shape.kind === 'RectRing') {
    const inOuter = Math.abs(px - shape.x) <= shape.w / 2 && Math.abs(py - shape.y) <= shape.h / 2
    const inHole = Math.abs(px - shape.x) < shape.in_w / 2 && Math.abs(py - shape.y) < shape.in_h / 2
    return inOuter && !inHole
  }
  return pointInPoly(px, py, shape.pts)
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const qx = ax + t * dx
  const qy = ay + t * dy
  return Math.hypot(px - qx, py - qy)
}

function shapeBoundaryDist(shape, px, py) {
  if (shape.kind === 'Rect' || shape.kind === 'RectRing') {
    const rings = [
      [shape.x - shape.w / 2, shape.y - shape.h / 2, shape.x + shape.w / 2, shape.y + shape.h / 2],
    ]
    if (shape.kind === 'RectRing')
      rings.push([
        shape.x - shape.in_w / 2,
        shape.y - shape.in_h / 2,
        shape.x + shape.in_w / 2,
        shape.y + shape.in_h / 2,
      ])
    let best = Infinity
    for (const [x0, y0, x1, y1] of rings) {
      const corners = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = corners[i]
        const [bx, by] = corners[(i + 1) % 4]
        best = Math.min(best, distToSegment(px, py, ax, ay, bx, by))
      }
    }
    return best
  }
  const pts = shape.pts
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    best = Math.min(best, distToSegment(px, py, ax, ay, bx, by))
  }
  return best
}

/** Signed distance of (px,py) to `shape`: positive outside, negative inside. */
function signedDist(shape, px, py) {
  const d = shapeBoundaryDist(shape, px, py)
  return shapeContains(shape, px, py) ? -d : d
}

/** Footprint boundary sample points: 4 rotated corners + ≤0.05 m edge steps. */
function footprintSamples(c) {
  const { x, y, w, h, rotation } = c
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const corners = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([lx, ly]) => [x + lx * cos - ly * sin, y + lx * sin + ly * cos])
  const samples = []
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i]
    const [bx, by] = corners[(i + 1) % 4]
    const len = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(len / 0.05))
    for (let k = 0; k < n; k++) {
      const t = k / n
      samples.push([ax + t * (bx - ax), ay + t * (by - ay)])
    }
  }
  return samples
}

/** `Document::zone_index_at`, replicated: smallest-area containing zone, ground
 *  (Circulation/Unassigned) losing to any specific zone. */
function zoneIndexAt(zones, x, y) {
  let chosen = null // [idx, area]
  let foundNonGround = false
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i]
    if (!shapeContains(z.shape, x, y)) continue
    const ground = GROUND.has(z.zone_type)
    if (ground && foundNonGround) continue
    const area = shapeArea(z.shape)
    if (!ground && !foundNonGround) {
      foundNonGround = true
      chosen = [i, area]
    } else if (chosen === null || area < chosen[1]) {
      chosen = [i, area]
    }
  }
  return chosen ? chosen[0] : null
}

// ---- the report -------------------------------------------------------------

const zones = dump.zones
const rows = []
const skipped = { reference: 0, groundCenter: 0, noZone: 0 }
let assignMismatches = 0

// The core's own assignment, for the cross-check only (never an input).
const coreZoneOf = new Map()
for (const z of zones) for (const id of z.component_ids ?? []) coreZoneOf.set(id, z.id)

for (const c of dump.components) {
  if (c.reference) {
    // Imported CAD context: not placed by the generator, excluded from the
    // placement-containment question (counted so the exclusion is visible).
    skipped.reference++
    continue
  }
  const zi = zoneIndexAt(zones, c.x, c.y)
  const coreZid = coreZoneOf.get(c.id) ?? null
  const myZid = zi === null ? null : zones[zi].id
  if (myZid !== coreZid) assignMismatches++
  if (zi === null) {
    skipped.noZone++
    continue
  }
  const z = zones[zi]
  if (GROUND.has(z.zone_type)) {
    // Center in ground: belongs to no room zone (document.rs:176-190).
    skipped.groundCenter++
    continue
  }
  let worst = -Infinity
  for (const [px, py] of footprintSamples(c)) {
    worst = Math.max(worst, signedDist(z.shape, px, py))
  }
  rows.push({
    id: c.id,
    category: c.category,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    rotation: c.rotation,
    zone: z.id,
    zoneLabel: z.label,
    zoneType: z.zone_type,
    worstOutsideM: Math.round(worst * 1e6) / 1e6,
  })
}

rows.sort((a, b) => b.worstOutsideM - a.worstOutsideM)

const EPS = 1e-6 // fp noise
const CM = 0.01 // a centimeter: visible at no drawing scale
const violations = rows.filter((r) => r.worstOutsideM > EPS)
const violationsCm = rows.filter((r) => r.worstOutsideM > CM)

const byCategory = {}
for (const r of rows) {
  const b = (byCategory[r.category] ??= { n: 0, worst: -Infinity, violations: 0 })
  b.n++
  b.worst = Math.max(b.worst, r.worstOutsideM)
  if (r.worstOutsideM > EPS) b.violations++
}

const summary = {
  dump: path.relative(ROOT, DUMP),
  dumpProvenance: dump.provenance,
  totals: dump.totals,
  measured: rows.length,
  skipped,
  assignMismatchesVsCore: assignMismatches,
  method:
    'per component: footprint boundary sampled at 4 rotated corners + ≤0.05 m edge steps; ' +
    'signed distance to the assigned zone shape (positive = outside); assignment replicates ' +
    'Document::zone_index_at (smallest-area containing zone, ground loses to rooms) and is ' +
    'cross-checked against zone.component_ids',
  thresholds: { epsilonM: EPS, centimeterM: CM },
  violations: violations.length,
  violationsOverOneCm: violationsCm.length,
  byCategory,
  worstTen: rows.slice(0, 10),
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1) + '\n')
const back = JSON.parse(fs.readFileSync(OUT, 'utf8'))
if (back.rows.length !== rows.length) {
  console.error('write did not take — refusing to report success')
  process.exit(1)
}

console.log(`containment report → ${OUT}`)
console.log(`  measured ${rows.length} placed components against ${zones.length} zones`)
console.log(`  skipped: ${JSON.stringify(skipped)} · assignment mismatches vs core: ${assignMismatches}`)
console.log(`  violations (> ${EPS} m): ${violations.length} · over 1 cm: ${violationsCm.length}`)
for (const r of summary.worstTen) {
  console.log(
    `    ${String(r.worstOutsideM).padStart(12)} m  ${r.category} #${r.id} → zone ${r.zone} (${r.zoneLabel})`,
  )
}
process.exit(violations.length > 0 ? 2 : 0)
