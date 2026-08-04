// Synthesize plate-extraction fixtures WITH EXACT GROUND TRUTH.
//
// Run from repo root:  node bench/fixtures/generate.mjs
//
// The direction matters and is the reason these fixtures are trustworthy: we
// start from a known plate polygon (the truth), then synthesize defective wall
// linework FROM it. The truth is therefore not an estimate of what an algorithm
// should have found — it is the thing the drawing was built out of. Nothing
// infers it, so nothing can bias it.
//
// The real furniture-plan.dwg is the one fixture this cannot cover; its truth
// has to be established against the actual linework and human-confirmed (see
// bench/fixtures/truth/README.md).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = here
const TRUTH = path.join(here, 'truth')
fs.mkdirSync(path.join(OUT, 'plate'), { recursive: true })
fs.mkdirSync(TRUTH, { recursive: true })

// Deterministic PRNG — fixtures must be byte-identical on every machine, so
// Math.random() is banned here.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const rot = (pts, deg, cx = 0, cy = 0) => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return pts.map(([x, y]) => [
    +(cx + (x - cx) * c - (y - cy) * s).toFixed(6),
    +(cy + (x - cx) * s + (y - cy) * c).toFixed(6),
  ])
}

// ---- truth polygons ---------------------------------------------------------
const RECT = [[0, 0], [30, 0], [30, 20], [0, 20]]
const LSHAPE = [[0, 0], [34, 0], [34, 12], [18, 12], [18, 24], [0, 24]]
const NOTCHED = [[0, 0], [40, 0], [40, 26], [24, 26], [24, 18], [16, 18], [16, 26], [0, 26]]
// Curved facade: one long edge replaced by a shallow arc, tessellated. The truth
// IS the tessellation — a candidate is judged against the same discretization it
// is given, so arc handling is tested without punishing chord resolution.
function curvedPlate() {
  const pts = [[0, 0], [30, 0]]
  const R = 26, cx = 15, cy = 20 - Math.sqrt(R * R - 15 * 15)
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const a0 = Math.atan2(0 - cy, 30 - cx)
    const a1 = Math.atan2(0 - cy, 0 - cx)
    const a = a0 + (a1 - a0) * t
    pts.push([+(cx + R * Math.cos(a)).toFixed(6), +(cy + R * Math.sin(a)).toFixed(6)])
  }
  return pts
}

// ---- defect synthesis -------------------------------------------------------

/** Ring → wall segments, optionally punched with door/window gaps. */
function ringToSegments(ring, { gaps = 0, gapWidth = 0.9, seed = 1 } = {}) {
  const rand = rng(seed)
  const segs = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const holes = []
    for (let g = 0; g < gaps; g++) {
      if (len < gapWidth * 4) break
      const c = 0.15 + rand() * 0.7
      holes.push([c - gapWidth / 2 / len, c + gapWidth / 2 / len])
    }
    holes.sort((p, q) => p[0] - q[0])
    let cursor = 0
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    for (const [h0, h1] of holes) {
      if (h0 > cursor) segs.push([at(cursor), at(Math.max(cursor, h0))])
      cursor = Math.max(cursor, h1)
    }
    if (cursor < 1) segs.push([at(cursor), at(1)])
  }
  return segs
}

/** Nudge endpoints off the grid so nothing is exactly coincident. */
function jitter(segs, amp, seed) {
  const rand = rng(seed)
  const j = (p) => [
    +(p[0] + (rand() - 0.5) * 2 * amp).toFixed(6),
    +(p[1] + (rand() - 0.5) * 2 * amp).toFixed(6),
  ]
  return segs.map(([a, b]) => [j(a), j(b)])
}

/** Duplicate the wall run on a second layer, slightly offset (xref double-up). */
function duplicated(segs, offset, layer) {
  return segs.map(([a, b]) => ({
    seg: [[a[0] + offset, a[1] + offset], [b[0] + offset, b[1] + offset]],
    layer,
  }))
}

function drawingFrom(segs, extra = [], { units = 'm', furniture = [] } = {}) {
  const entities = []
  for (const s of segs) {
    const seg = Array.isArray(s) ? s : s.seg
    const layer = Array.isArray(s) ? 'A-WALL' : s.layer
    entities.push({ kind: 'polyline', layer, category: 'wall', pts: seg, closed: false })
  }
  entities.push(...extra)
  const xs = entities.flatMap((e) => (e.pts ?? []).map((p) => p[0]))
  const ys = entities.flatMap((e) => (e.pts ?? []).map((p) => p[1]))
  return {
    units,
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    layers: [...new Set(entities.map((e) => e.layer))],
    entities,
    furniture,
  }
}

/** Desks scattered inside the truth ring — drives the coverage heuristic. */
function furnitureIn(ring, n, seed) {
  const rand = rng(seed)
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const inside = (p) => {
    let ins = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins
    }
    return ins
  }
  const out = []
  let guard = 0
  while (out.length < n && guard++ < n * 200) {
    const p = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)]
    if (!inside([p[0] - 0.9, p[1] - 0.5]) || !inside([p[0] + 0.9, p[1] + 0.5])) continue
    out.push({
      id: out.length + 1, name: 'Desk', raw: 'DESK', category: 'furniture',
      bbox: [p[0] - 0.8, p[1] - 0.4, p[0] + 0.8, p[1] + 0.4],
      origin: [p[0], p[1]], rotation: 0, entities: [],
    })
  }
  return out
}

// ---- the fixture matrix -----------------------------------------------------
const FIXTURES = [
  {
    id: 'rect-clean',
    why: 'Control. If a candidate cannot do this, nothing else matters.',
    truth: RECT,
    build: (t) => drawingFrom(ringToSegments(t), [], { furniture: furnitureIn(t, 20, 7) }),
  },
  {
    id: 'rect-door-gaps',
    why: 'Doors/windows break wall continuity — the gap-closing case (L5IN / IIETA).',
    truth: RECT,
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 2, gapWidth: 1.1, seed: 11 }), [],
      { furniture: furnitureIn(t, 20, 8) }),
  },
  {
    id: 'rect-wide-gaps',
    why: 'Gaps widened to 2.4 m — past a door leaf, where naive closing over-bridges.',
    truth: RECT,
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 2, gapWidth: 2.4, seed: 12 }), [],
      { furniture: furnitureIn(t, 20, 9) }),
  },
  {
    id: 'rect-jitter',
    why: 'Endpoints 8 mm off coincident — the snap/set_precision case (dxf-fix).',
    truth: RECT,
    build: (t) => drawingFrom(jitter(ringToSegments(t), 0.008, 21), [],
      { furniture: furnitureIn(t, 20, 10) }),
  },
  {
    id: 'rect-duplicated-layers',
    why: 'A second, 40 mm-offset wall layer — overlapping-wall elimination (Wu et al.).',
    truth: RECT,
    build: (t) => drawingFrom(
      ringToSegments(t),
      duplicated(ringToSegments(t), 0.04, 'A-WALL-XREF').map(({ seg, layer }) => ({
        kind: 'polyline', layer, category: 'wall', pts: seg, closed: false,
      })),
      { furniture: furnitureIn(t, 20, 13) },
    ),
  },
  {
    id: 'rot17-door-gaps',
    why: 'Rotated 17°: every axis-aligned assumption breaks; regularisation must not force it square.',
    truth: rot(RECT, 17),
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 2, gapWidth: 1.1, seed: 14 }), [],
      { furniture: furnitureIn(t, 18, 15) }),
  },
  {
    id: 'lshape-door-gaps',
    why: 'Re-entrant corner: hull tracers cut the notch off — the classic phantom diagonal.',
    truth: LSHAPE,
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 2, gapWidth: 1.1, seed: 16 }), [],
      { furniture: furnitureIn(t, 24, 17) }),
  },
  {
    id: 'notched-core',
    why: 'Deep notch (a lift core biting into the slab) — two re-entrant corners.',
    truth: NOTCHED,
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 1, gapWidth: 1.0, seed: 18 }), [],
      { furniture: furnitureIn(t, 26, 19) }),
  },
  {
    id: 'curved-facade',
    why: 'Arc facade: over-regularisation destroys it, so it guards the regularise candidate.',
    truth: curvedPlate(),
    build: (t) => drawingFrom(ringToSegments(t, { gaps: 1, gapWidth: 1.2, seed: 20 }), [],
      { furniture: furnitureIn(t, 20, 21) }),
  },
  {
    id: 'lshape-jitter-dup-gaps',
    why: 'All three defects at once — the composed-pipeline case the research predicts.',
    truth: LSHAPE,
    build: (t) => drawingFrom(
      jitter(ringToSegments(t, { gaps: 2, gapWidth: 1.1, seed: 22 }), 0.008, 23),
      duplicated(ringToSegments(t), 0.035, 'A-WALL-2').map(({ seg, layer }) => ({
        kind: 'polyline', layer, category: 'wall', pts: seg, closed: false,
      })),
      { furniture: furnitureIn(t, 24, 24) },
    ),
  },

  // ---- the class that actually reproduces the production bug ---------------
  // Everything above keeps a traceable perimeter loop, so the incumbent's loop
  // tracer succeeds and scores ~1.0 — they never exercise the failing path.
  // The real furniture-plan.dwg has NO closed exterior envelope on ANY wall
  // layer (verified: WALL/A-WALL/I-WALL are all fragments), which forces the
  // hull fallback, and the hull cuts phantom diagonals across every concavity.
  // These fixtures reproduce that condition with truth still exact, because the
  // truth polygon is what the surviving fragments were cut from.
  {
    id: 'lshape-shell-fragments',
    why: 'PRODUCTION BUG CLASS: shell present only as fragments — forces hull fallback across the notch.',
    truth: LSHAPE,
    build: (t) => drawingFrom(
      // keep only ~45% of each wall run, so no perimeter loop can close
      ringToSegments(t, { gaps: 3, gapWidth: 3.2, seed: 31 }),
      interiorPartitions(t, 26, 32),
      { furniture: furnitureIn(t, 24, 33) },
    ),
  },
  {
    id: 'notched-shell-fragments',
    why: 'PRODUCTION BUG CLASS: two re-entrant corners with a fragmented shell — worst case for a hull.',
    truth: NOTCHED,
    build: (t) => drawingFrom(
      ringToSegments(t, { gaps: 3, gapWidth: 3.6, seed: 34 }),
      interiorPartitions(t, 30, 35),
      { furniture: furnitureIn(t, 28, 36) },
    ),
  },
  {
    id: 'rect-no-shell-only-partitions',
    why: 'PRODUCTION BUG CLASS: no exterior wall at all, only interior partitions + scattered columns — the real DWG condition.',
    truth: RECT,
    build: (t) => drawingFrom(
      [], // no shell whatsoever
      [...interiorPartitions(t, 34, 37), ...columnsIn(t, 12, 38)],
      { furniture: furnitureIn(t, 26, 39) },
    ),
  },
  {
    // The column-grid rung's fair test. `rect-no-shell-only-partitions` CANNOT
    // serve: its columns are random scatter (11 distinct x lines for 12
    // columns), so no bay spacing exists to infer and the plausibility guard
    // should reject it. Here the columns are a real 4x3 grid on 7.5 x 6.667 m
    // bays, inset exactly half a bay — so the half-bay extension rule recovers
    // the truth EXACTLY, and any deviation is the rung's own error, not the
    // fixture's ambiguity.
    id: 'rect-regular-column-grid',
    why: 'Fair test for the column-grid rung: no shell, a REGULAR 4x3 column grid inset half a bay.',
    truth: RECT,
    build: (t) => {
      const cols = []
      const bx = 7.5, by = 20 / 3
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          const cx = bx / 2 + i * bx
          const cy = by / 2 + j * by
          const s = 0.3
          cols.push({
            kind: 'polyline', layer: 'COL', category: 'wall', closed: true,
            pts: [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]]
              .map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]),
          })
        }
      }
      return drawingFrom([], [...interiorPartitions(t, 20, 41), ...cols],
        { furniture: furnitureIn(t, 24, 42) })
    },
  },
]

/** Interior partition stubs inside the truth ring (never touching the boundary). */
function interiorPartitions(ring, n, seed) {
  const rand = rng(seed)
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const inside = (p) => {
    let ins = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins
    }
    return ins
  }
  const out = []
  let guard = 0
  while (out.length < n && guard++ < n * 200) {
    const ax = x0 + 1.5 + rand() * (x1 - x0 - 3)
    const ay = y0 + 1.5 + rand() * (y1 - y0 - 3)
    const horiz = rand() < 0.5
    const len = 1.5 + rand() * 4
    const b = horiz ? [ax + len, ay] : [ax, ay + len]
    if (!inside([ax, ay]) || !inside(b)) continue
    out.push({
      kind: 'polyline', layer: 'I-WALL', category: 'wall',
      pts: [[+ax.toFixed(4), +ay.toFixed(4)], [+b[0].toFixed(4), +b[1].toFixed(4)]], closed: false,
    })
  }
  return out
}

/** Structural column squares — present in the real drawing on its own COL layer. */
function columnsIn(ring, n, seed) {
  const rand = rng(seed)
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const out = []
  for (let i = 0; i < n; i++) {
    const cx = x0 + 2 + rand() * (x1 - x0 - 4)
    const cy = y0 + 2 + rand() * (y1 - y0 - 4)
    const s = 0.4
    out.push({
      kind: 'polyline', layer: 'COL', category: 'wall', closed: true,
      pts: [[cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s]]
        .map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]),
    })
  }
  return out
}

const manifest = []
for (const f of FIXTURES) {
  const truth = f.truth
  const drawing = f.build(truth)
  fs.writeFileSync(path.join(OUT, 'plate', `${f.id}.json`), JSON.stringify(drawing, null, 1))
  fs.writeFileSync(
    path.join(TRUTH, `${f.id}.geojson`),
    JSON.stringify({
      type: 'Feature',
      properties: {
        id: f.id,
        why: f.why,
        source: 'synthetic — truth is the generating polygon, exact by construction',
        areaM2: +Math.abs(truth.reduce((a, p, i) => {
          const q = truth[(i + 1) % truth.length]
          return a + (p[0] * q[1] - q[0] * p[1])
        }, 0) / 2).toFixed(4),
      },
      geometry: { type: 'Polygon', coordinates: [[...truth, truth[0]]] },
    }, null, 1),
  )
  manifest.push({ id: f.id, why: f.why, vertices: truth.length, entities: drawing.entities.length })
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`wrote ${manifest.length} synthetic fixtures + exact truth`)
for (const m of manifest) console.log(`  ${m.id.padEnd(24)} ${m.entities} entities`)
