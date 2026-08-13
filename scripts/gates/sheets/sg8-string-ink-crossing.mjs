// SG8 — STRING-INK CROSSING (defect D-P).  No annotation string printed on a
// plan sheet may cross the base raster's wall poché or a door-swing arc.
//
//   node scripts/gates/sheets/sg8-string-ink-crossing.mjs [--pack seeded,dwg]
//
// THE INSTRUMENT IS THE FROZEN D-P METHOD (reports/sheets-defects-2.md §1),
// reconstructed from its documentation after the ephemeral original
// (`scratchpad/overlap.mjs`) was lost. Every rule below is the documented one;
// none may change while the D-P corpus is the yardstick
// (reports/phase0-editor-completion.md, pinned yardsticks).
//
//  * Wall segments and door-swing arcs come from CORE STATE (`coreState`),
//    re-projected with the SAME transform SG2 uses (`planProjection`:
//    `stateBbox` fit, pad 48 px, RES, validated plate rect). Nothing is read
//    from the renderer.
//  * Text boxes are poppler's measurement of the delivered glyph runs
//    (`pageWords`), chained into strings on the gates' own rule
//    (SAME_LINE = 0.05, WORD_GAP = 3.5 — sheetlib's `chainFrom` constants).
//  * LAYER-AWARE: a sheet is measured only against the geometry it draws.
//    A.01 draws existing walls only (no furniture, no generated partitions —
//    sheetSet.ts `demolitionSheet` layers); A.02 draws both wall classes and
//    furniture (`constructionSheet`); A.03 draws both wall classes and no
//    furniture (servicesSheets.ts `rcpSheet`); A.04 draws both wall classes and
//    furniture (`powerSheet`). Measuring a sheet against geometry it does not
//    draw produced 42 false hits in the original round.
//  * NO MIRROR: the print path draws door leaves un-mirrored in the original
//    measurement, and the frozen method does not mirror either. Core state is
//    checked: if a Door ever carries `mirror`, the gate says so in a note
//    rather than silently measuring the wrong leaf.
//  * A HIT is a string whose box is within a wall's own half-thickness
//    (`w.thickness × ptPerM / 2`) of that wall's centreline, or within 0.7 pt
//    of a door-swing arc polyline (symbols.ts `door()`, the old
//    furniture.ts:255-274: hinge at local (-w/2, 0), radius w, arc -π/2 … 0,
//    plus the leaf line).
//
// WHAT IT ASSERTS
//
//  8.1  Per plan sheet (A.01-A.04 × pack): ZERO strings crossing wall or arc
//       ink. Fail-first: at the frozen corpus this reads 107 across the twelve
//       sheets (103 at 1a2b8d5 → 106 after S2/S3 → 107 after S6).
//
// NOTES (measured, not asserted — D-Q is a DIFFERENT defect, not this gate's):
//
//  * per-sheet D-Q count: room-name/area strings whose CENTRE falls outside the
//    core-state WALL bbox (the `j2-outside.mjs` method). Workstream B must not
//    let it increase; the number is printed so before/after can be diffed.

import {
  PACKS,
  coreState,
  loadGeometry,
  pageWords,
  planProjection,
  runGate,
  GateError,
} from './lib/sheetlib.mjs'

/** The four plan sheets and the layers each one draws — spec, cited from the
 *  producers' own layer tables (sheetSet.ts `demolitionSheet` /
 *  `constructionSheet`; servicesSheets.ts `rcpSheet` / `powerSheet`). */
const PLAN_SHEETS = [
  { file: 'A01', page: 3, existingWalls: true, generatedWalls: false, furniture: false },
  { file: 'A02', page: 4, existingWalls: true, generatedWalls: true, furniture: true },
  { file: 'A03', page: 5, existingWalls: true, generatedWalls: true, furniture: false },
  { file: 'A04', page: 6, existingWalls: true, generatedWalls: true, furniture: true },
]

/** Word-chaining constants — the same values sheetlib's `chainFrom` uses
 *  (documented in the D-P method as "the gate's own rule"). */
const SAME_LINE = 0.05
const WORD_GAP = 3.5
/** Arc proximity threshold (pt), frozen in the D-P method. */
const ARC_TOL = 0.7
/** Segments a quarter-circle swing arc is sampled into. At door radii ≈ 15 pt
 *  the polyline sagitta is < 0.01 pt — far inside ARC_TOL. */
const ARC_STEPS = 24

// ---------------------------------------------------------------------------
// Strings: every maximal same-baseline word chain on the page
// ---------------------------------------------------------------------------

/**
 * Chain ALL of a page's words into maximal strings: two words join when they
 * share a baseline (|Δy0| ≤ SAME_LINE) and the next starts within WORD_GAP of
 * where the previous ended (and not before it by more than 0.5 pt) — exactly
 * the adjacency `findLabelRuns`/`chainFrom` use, applied greedily left-to-right
 * so the result is the page's own reading of its strings, with no expected-text
 * list steering it.
 */
function chainStrings(words) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const used = new Set()
  const out = []
  for (const w of sorted) {
    if (used.has(w)) continue
    const run = [w]
    used.add(w)
    let cur = w
    for (;;) {
      const next = sorted
        .filter(
          (x) =>
            !used.has(x) &&
            Math.abs(x.y0 - w.y0) <= SAME_LINE &&
            x.x0 >= cur.x1 - 0.5 &&
            x.x0 - cur.x1 <= WORD_GAP,
        )
        .sort((a, b) => a.x0 - b.x0)[0]
      if (!next) break
      run.push(next)
      used.add(next)
      cur = next
    }
    out.push({
      text: run.map((r) => r.text).join(' '),
      box: {
        x: Math.min(...run.map((r) => r.x0)),
        y: Math.min(...run.map((r) => r.y0)),
        w: Math.max(...run.map((r) => r.x1)) - Math.min(...run.map((r) => r.x0)),
        h: Math.max(...run.map((r) => r.y1)) - Math.min(...run.map((r) => r.y0)),
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Distance: axis-aligned box ↔ segment / polyline
// ---------------------------------------------------------------------------

function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = orient(ax, ay, bx, by, cx, cy)
  const d2 = orient(ax, ay, bx, by, dx, dy)
  const d3 = orient(cx, cy, dx, dy, ax, ay)
  const d4 = orient(cx, cy, dx, dy, bx, by)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(
    pointSegDist(cx, cy, ax, ay, bx, by),
    pointSegDist(dx, dy, ax, ay, bx, by),
    pointSegDist(ax, ay, cx, cy, dx, dy),
    pointSegDist(bx, by, cx, cy, dx, dy),
  )
}

function orient(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}

/** Min distance from an axis-aligned box to a segment (0 when they touch). */
function boxSegDist(box, x1, y1, x2, y2) {
  // Either endpoint inside the box → touching.
  const inside = (x, y) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h
  if (inside(x1, y1) || inside(x2, y2)) return 0
  const L = box.x
  const R = box.x + box.w
  const T = box.y
  const B = box.y + box.h
  return Math.min(
    segSegDist(x1, y1, x2, y2, L, T, R, T),
    segSegDist(x1, y1, x2, y2, R, T, R, B),
    segSegDist(x1, y1, x2, y2, R, B, L, B),
    segSegDist(x1, y1, x2, y2, L, B, L, T),
  )
}

function boxPolylineDist(box, pts) {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, boxSegDist(box, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y))
    if (best === 0) return 0
  }
  return best
}

// ---------------------------------------------------------------------------
// The geometry a sheet draws, in sheet pt
// ---------------------------------------------------------------------------

/** The door-swing polyline (leaf line + quarter arc) of one Door component, in
 *  sheet pt. Local geometry per symbols.ts `door()` (ex-furniture.ts:255-274):
 *  hinge at (-w/2, 0), leaf to (-w/2, -w), arc centre the hinge, radius w,
 *  -π/2 … 0. Rotated by the component's rotation, NOT mirrored (see header). */
function doorSwing(c, map) {
  const cos = Math.cos(c.rotation)
  const sin = Math.sin(c.rotation)
  const world = (lx, ly) => map(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos)
  const hx = -c.w / 2
  const r = c.w
  const pts = [world(hx, 0), world(hx, -r)] // the leaf
  for (let i = 0; i <= ARC_STEPS; i++) {
    const th = -Math.PI / 2 + (i / ARC_STEPS) * (Math.PI / 2)
    pts.push(world(hx + r * Math.cos(th), r * Math.sin(th)))
  }
  return pts
}

// ---------------------------------------------------------------------------
// The candidate families — D-P is "room-name / area / dimension strings"
// ---------------------------------------------------------------------------
//
// The corpus counts ANNOTATION strings, not every glyph run on the plate:
// opening-tag texts (`W6`, `D11`), circuit tags (`LC-02`) and word-carrying
// fixture glyphs (`E`, `DB`) are attached to walls/openings BY DESIGN (SG2 2.5
// asserts exactly that attribution), so counting them would gate the drawing
// for being correct. The three families, each anchored to the producer's own
// format string:
//
//   * area:      `${publishedAreaText(...)} m²`   → /^\d+\.\d m²$/
//   * dimension: `${meters.toFixed(2)} m`         → /^\d+\.\d{2} m$/
//   * room name: an UPPERCASED zone label, with or without a ` (n)` ordinal
//     (`roomDisplayNames` grammar), or the `ROOM NN` empty-label fallback.
//     Matching is by BASE NAME derived from core-state labels, so the filter
//     needs no naming helper from the drawing layer and accepts both the bare
//     and the disambiguated form (which name is CORRECT is SG4's assertion,
//     not this gate's).

const AREA_RE = /^\d+(\.\d+)? m²$/
const DIM_RE = /^\d+\.\d{2} m$/
const ROOM_FALLBACK_RE = /^ROOM \d{2}$/
const ORDINAL_RE = /\s+\(\d+\)\s*$/

function roomBaseNames(state) {
  const bases = new Set()
  for (const z of state.zones ?? []) {
    const label = (z.label ?? '').trim()
    if (!label) continue
    bases.add(label.toUpperCase())
    bases.add(label.toUpperCase().replace(ORDINAL_RE, '').trim())
  }
  return bases
}

function isCandidate(text, bases) {
  if (AREA_RE.test(text) || DIM_RE.test(text) || ROOM_FALLBACK_RE.test(text)) return true
  return bases.has(text) || bases.has(text.replace(ORDINAL_RE, '').trim())
}

// ---------------------------------------------------------------------------
// D-Q (note only): room-name/area strings whose centre is outside the walls
// ---------------------------------------------------------------------------

function outsideFootprintCount(strings, state, map, bases) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    for (const p of [w.a, w.b]) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (minX === Infinity) return 0
  const a = map(minX, minY)
  const b = map(maxX, maxY)
  const fp = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
  let n = 0
  for (const s of strings) {
    // D-Q's j2-outside counted "room names / areas" — names and areas only,
    // never dimensions (the overall dim string legitimately lives outside).
    const isName = bases.has(s.text) || bases.has(s.text.replace(ORDINAL_RE, '').trim()) || ROOM_FALLBACK_RE.test(s.text)
    if (!isName && !AREA_RE.test(s.text)) continue
    const cx = s.box.x + s.box.w / 2
    const cy = s.box.y + s.box.h / 2
    if (cx < fp.x || cx > fp.x + fp.w || cy < fp.y || cy > fp.y + fp.h) n++
  }
  return n
}

// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG8', async (c) => {
    let total = 0
    let dq = 0
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)
      const state = await coreState(pack)
      const mirrored = (state.components ?? []).filter((k) => k.category === 'Door' && k.mirror)
      if (mirrored.length > 0) {
        c.note(
          `${pack}: ${mirrored.length} Door component(s) carry mirror — the frozen method measures the ` +
            'un-mirrored leaf; revisit if these counts look wrong',
        )
      }
      for (const sheet of PLAN_SHEETS) {
        const g = loadGeometry(pack, sheet.file)
        if (!g.plate) throw new GateError(`${pack}/${sheet.file}: no plate rect — cannot project core geometry`)
        const { map, ptPerM } = planProjection(state, g.plate.pt, g.spec.RES)

        // The geometry THIS sheet draws.
        const walls = state.walls
          .filter((w) => (w.generated === true ? sheet.generatedWalls : sheet.existingWalls))
          .map((w) => ({
            a: map(w.a.x, w.a.y),
            b: map(w.b.x, w.b.y),
            halfT: ((w.thickness > 0 ? w.thickness : 0.1) * ptPerM) / 2,
          }))
        const swings = sheet.furniture
          ? (state.components ?? []).filter((k) => k.category === 'Door').map((k) => doorSwing(k, map))
          : []

        // PROJECTION SANITY (SG2 2.5's check, per sheet): a broken projection
        // would land every wall away from every string and this gate would go
        // green VACUOUSLY — the "check whose subject moved out from under it"
        // failure. Every mapped wall must lie inside the plate.
        {
          const all = state.walls.map((w) => [map(w.a.x, w.a.y), map(w.b.x, w.b.y)])
          const out = all.filter(
            ([a, b]) =>
              Math.min(a.x, b.x) < g.plate.pt.x - 0.5 ||
              Math.max(a.x, b.x) > g.plate.pt.x + g.plate.pt.w + 0.5 ||
              Math.min(a.y, b.y) < g.plate.pt.y - 0.5 ||
              Math.max(a.y, b.y) > g.plate.pt.y + g.plate.pt.h + 0.5,
          )
          if (out.length > 0) {
            throw new GateError(
              `${pack}/${sheet.file}: ${out.length} of ${all.length} core-state walls project outside the plate — ` +
                "the gate's map is wrong, and every count below it would be measuring nothing",
            )
          }
        }
        const bases = roomBaseNames(state)
        const strings = chainStrings(pageWords(pack, sheet.page))
        const candidates = strings.filter((s) => isCandidate(s.text, bases))
        if (candidates.length === 0) {
          throw new GateError(
            `${pack}/${sheet.file}: no room-name/area/dimension strings found at all — ` +
              'the candidate filter or the text layer is broken, and a gate over an empty set proves nothing',
          )
        }
        const hits = []
        for (const s of candidates) {
          const wallHit = walls.some((w) => boxSegDist(s.box, w.a.x, w.a.y, w.b.x, w.b.y) <= w.halfT)
          const arcHit = swings.some((pts) => boxPolylineDist(s.box, pts) <= ARC_TOL)
          if (wallHit || arcHit) hits.push({ ...s, wallHit, arcHit })
        }
        total += hits.length
        const nWall = hits.filter((h) => h.wallHit).length
        const nArc = hits.filter((h) => h.arcHit).length
        const dqSheet = outsideFootprintCount(strings, state, map, bases)
        dq += dqSheet
        c.note(
          `${pack}/${sheet.file}: ${hits.length} crossing (wall ${nWall}, arc ${nArc}); D-Q outside-footprint ${dqSheet}`,
        )
        c.ok(
          `${pack}/${sheet.file} no string crosses wall or door-swing ink`,
          hits.length === 0,
          hits
            .slice(0, 8)
            .map(
              (h) =>
                `"${h.text}"@(${h.box.x.toFixed(0)},${h.box.y.toFixed(0)})` +
                `${h.wallHit ? ' wall' : ''}${h.arcHit ? ' arc' : ''}`,
            )
            .join(', ') + (hits.length > 8 ? ` … +${hits.length - 8} more` : ''),
        )
      }
    }
    c.note(`TOTAL strings on wall/arc ink: ${total}   (frozen D-P corpus: 107)`)
    c.note(`TOTAL D-Q outside-footprint strings: ${dq}   (must not increase across this workstream)`)
  })
}

process.exit((await main()) ? 0 : 1)
