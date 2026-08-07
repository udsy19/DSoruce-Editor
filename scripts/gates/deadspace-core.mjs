// DEAD SPACE, derived from CORE STATE. No segmentation, no pixels, no flood fill.
//
//   node scripts/gates/deadspace-core.mjs [--radius 3.0] [--max-dead 0.14] [--fixture F1]
//
// WHY THIS EXISTS AND THE PIXEL VERSION DOES NOT
// ----------------------------------------------
// `deadspace.py` measured the wall BOUNDING BOX as the plate — 1597 m² against a
// 930 m² polygon — because the editor paints a white rectangle under the plan and
// the flood fill halted at that colour change. Flooding on ink instead leaks
// through the anti-aliased 1 px boundary and reports 0.0% on the same drawing.
// Three versions, three answers. All of its numbers are retracted.
//
// The mistake underneath was trying to RECOVER geometry from an image when the
// geometry is sitting right there in the document. `.claude/rules/
// gate-independence.md` permits exactly this: *derive from bytes or core state*.
// The plate comes from `Editor::plate()`, the programme from the components and
// zones the core emitted, and the distance transform runs in world metres. There
// is no step that can find the wrong region, so there is nothing to calibrate.
//
// WHAT IT MEASURES
//   dead = plate area more than `radius` metres from any PROGRAMME element,
//          where programme is a placed component footprint or an ENCLOSED room
//          zone. Ground and the open field zone are excluded — see OPEN_ZONES.
//
// Ground (Circulation / Unassigned) is deliberately NOT programme: a corridor is
// how you reach the plan, not part of it, and counting it would let a plate that
// named all its leftovers "circulation" score as fully used — which is the exact
// self-certification this whole queue keeps finding.
//
// WHAT IT CANNOT DO YET
// The reference has no document, so there is no comparable qbiq number here and
// therefore NO reference-derived threshold. `--max-dead` is available and the
// ledger records the measured baseline; until the reference side is rebuilt (its
// plate from the page's stated floor area, not a flood fill) any threshold is a
// ratchet against ourselves and is labelled as one.
//
// `radius` 3.0 m is a bit over two desk pitches, so an ordinary aisle never
// counts as dead and a genuinely empty wing always does. Same value the pixel
// version used, kept so the two are talking about the same quantity.
//
// THE VERDICT IS OVER A SET THAT MUST BE FULL (V1, adversary round)
// -----------------------------------------------------------------
// This gate shipped with `continue` on an unresolved plate. The ROW said so
// honestly; the VERDICT did not. `worst` is a maximum, a maximum over the empty
// set is 0, and 0 is under every threshold — so forcing `plate_resolution` to
// return Unresolved and rebuilding wasm printed, verbatim:
//
//     F1..F5: plate unresolved — nothing to measure
//     DEADSPACE OK: worst 0.0% <= 10.0%       EXIT=0
//
// A global plate-resolution regression — the founding defect of this whole queue
// — turned this gate GREEN. That is `if not x: continue` handing the producer a
// veto over its own test, which `.claude/rules/gate-independence.md` forbids by
// name, in a gate written and falsified two commits earlier.
//
// So the set of plates this run MUST measure is derived BEFORE anything is
// measured, and the verdict is refused unless every one of them was measured.
// EXPECTED_UNRESOLVED is the only exemption and it is two-sided: a fixture
// declared unresolved that RESOLVES fails exactly as loudly as one not declared
// that does not. A one-sided allowlist is the same veto with better manners.
//
// R10 — WHICH AXES THIS GUARD'S FALSIFICATION VARIES: (1) the measured VALUE —
// delete desks, the dead fraction rises past --max-dead; (2) the measured COUNT
// — force plate_resolution Unresolved, zero plates resolve; (3) the measured
// MEMBERSHIP — F3 (declared unresolved) resolving, or F1 not. The original
// falsification varied (1) only, which is why (2) shipped live.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')

const argv = process.argv.slice(2)
const arg = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}
const RADIUS = Number(arg('--radius', '3.0'))
const MAX_DEAD = argv.includes('--max-dead') ? Number(arg('--max-dead', '')) : null
const ONLY = arg('--fixture', null)
/** Load a snapshot instead of a fixture — the falsification path: build the
 *  emptier plan this gate is supposed to catch and check that it reds. */
const SNAPSHOT = arg('--snapshot', null)
/** Sampling pitch, metres. 0.25 m puts ~15 000 samples on a 930 m² plate. */
const CELL = 0.25

const wasmDir = path.join(REPO, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
wasm.initSync({ module: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

/** Ground is not programme — see the header. Mirrors `types/doc.ts::isGroundZone`
 *  and the core's fold boundary; both name the same two types. */
const GROUND = new Set(['Circulation', 'Unassigned'])

/**
 * The OPEN field is not programme either, and this is the load-bearing choice.
 *
 * `Workspace` is a 536 m² rectangle drawn over the desk field. Counting it as
 * programme means an empty half of that rectangle scores as used floor — a plan
 * could cover the whole plate in one Workspace zone and measure 0% dead. That is
 * the same self-certification the pixel version was written to avoid (a coloured
 * wash with nothing on it IS the dead space), so an open zone earns nothing; its
 * DESKS do, one footprint at a time.
 *
 * Enclosed rooms are different and do count as themselves: a meeting room is
 * occupied floor whether or not its table happens to be modelled.
 *
 * Measured both ways on F1 before choosing — **2.7%** with open zones counted,
 * **9.4%** without. The second is the number that can distinguish a filled field
 * from an empty one, which is the whole question. (The first draft of this
 * comment guessed 12.6% before the run; it is corrected here rather than
 * quietly, because writing a number before measuring it is the habit this whole
 * queue keeps catching.)
 */
const OPEN_ZONES = new Set(['Workspace'])

/**
 * Fixtures whose plate is expected NOT to resolve, with the reason it does not.
 *
 * F3 is `F2 with one plate wall removed — the outer loop is broken while a
 * smaller closed loop survives`, described in `crates/ds-core/src/fixtures.rs`
 * as **the GEA-collapse state**. It exists precisely so something exercises an
 * unresolved plate; refusing to measure it is correct, and it is the only
 * fixture for which that is true.
 *
 * TWO-SIDED, and that is the whole point. An id in this map that RESOLVES fails
 * as loudly as an id outside it that does not: the first says the fixture drifted
 * out from under its own description, the second is the V1 regression. A skip
 * list checked in one direction is a producer veto wearing a declaration.
 */
const EXPECTED_UNRESOLVED = new Map([
  ['F3', 'the GEA-collapse fixture — outer plate loop deliberately broken (crates/ds-core/src/fixtures.rs)'],
])

function pointInPoly(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]
    const [x1, y1] = poly[(i + 1) % poly.length]
    a += x0 * y1 - x1 * y0
  }
  return Math.abs(a) / 2
}

/** World AABB of a component, honouring rotation — the same extents the
 *  obstacle list uses in the core, so a rotated desk covers what it covers. */
function componentBox(c) {
  const ca = Math.abs(Math.cos(c.rotation ?? 0))
  const sa = Math.abs(Math.sin(c.rotation ?? 0))
  const w = c.w * ca + c.h * sa
  const h = c.w * sa + c.h * ca
  return { x0: c.x - w / 2, y0: c.y - h / 2, x1: c.x + w / 2, y1: c.y + h / 2 }
}

function zoneBoxes(zones) {
  const out = []
  for (const z of zones ?? []) {
    if (GROUND.has(z.zone_type) || OPEN_ZONES.has(z.zone_type)) continue
    const s = z.shape
    if (s.kind === 'Rect' || s.kind === 'RectRing') {
      out.push({ x0: s.x - s.w / 2, y0: s.y - s.h / 2, x1: s.x + s.w / 2, y1: s.y + s.h / 2 })
    } else if (s.kind === 'Poly' && s.pts?.length) {
      const xs = s.pts.map((p) => p[0])
      const ys = s.pts.map((p) => p[1])
      out.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) })
    }
  }
  return out
}

function measure(plate, boxes) {
  const xs = plate.map((p) => p[0])
  const ys = plate.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const nx = Math.ceil((x1 - x0) / CELL)
  const ny = Math.ceil((y1 - y0) / CELL)

  // Sample grid: which cells are in the plate, and which are on programme.
  const inPlate = new Uint8Array(nx * ny)
  const onProg = new Uint8Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * CELL
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * CELL
      const k = j * nx + i
      if (!pointInPoly(x, y, plate)) continue
      inPlate[k] = 1
      for (const b of boxes) {
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          onProg[k] = 1
          break
        }
      }
    }
  }

  // Chamfer distance to the nearest programme cell, 3/4 weights, in cells.
  const BIG = 1 << 24
  const d = new Int32Array(nx * ny).fill(BIG)
  for (let k = 0; k < d.length; k++) if (onProg[k]) d[k] = 0
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? BIG : d[j * nx + i])
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      d[k] = Math.min(d[k], at(i - 1, j) + 3, at(i, j - 1) + 3, at(i - 1, j - 1) + 4, at(i + 1, j - 1) + 4)
    }
  for (let j = ny - 1; j >= 0; j--)
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i
      d[k] = Math.min(d[k], at(i + 1, j) + 3, at(i, j + 1) + 3, at(i + 1, j + 1) + 4, at(i - 1, j + 1) + 4)
    }

  let plateCells = 0
  let deadCells = 0
  const dead = new Uint8Array(nx * ny)
  for (let k = 0; k < d.length; k++) {
    if (!inPlate[k]) continue
    plateCells++
    if ((d[k] / 3) * CELL > RADIUS) {
      deadCells++
      dead[k] = 1
    }
  }

  // WHERE, not only how much. A fraction cannot tell a ring of thin boundary
  // ribbons from one large empty wing, and those need different fixes in
  // different files — which is the mistake the retracted instrument's map
  // finally exposed. Flood the dead cells into connected clusters and report
  // each with the descriptors that can separate the two shapes (area, bbox,
  // aspect), per the rules file's "settle shape disputes with tables".
  const clusters = []
  const seen = new Uint8Array(nx * ny)
  for (let k0 = 0; k0 < dead.length; k0++) {
    if (!dead[k0] || seen[k0]) continue
    const stack = [k0]
    seen[k0] = 1
    let n = 0
    let bx0 = Infinity
    let by0 = Infinity
    let bx1 = -Infinity
    let by1 = -Infinity
    while (stack.length) {
      const k = stack.pop()
      const i = k % nx
      const j = (k - i) / nx
      n++
      bx0 = Math.min(bx0, x0 + i * CELL)
      by0 = Math.min(by0, y0 + j * CELL)
      bx1 = Math.max(bx1, x0 + (i + 1) * CELL)
      by1 = Math.max(by1, y0 + (j + 1) * CELL)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di
        const jj = j + dj
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue
        const kk = jj * nx + ii
        if (dead[kk] && !seen[kk]) {
          seen[kk] = 1
          stack.push(kk)
        }
      }
    }
    const w = bx1 - bx0
    const h = by1 - by0
    clusters.push({
      area: n * CELL * CELL,
      w,
      h,
      aspect: Math.max(w, h) / Math.max(1e-9, Math.min(w, h)),
      // FILL RATIO — area over bbox. Without it the bbox reads as a solid block
      // and it usually is not: the largest cluster on the sample plate has a
      // 7.0 x 19.8 m bbox and fills 39% of it, so it is a RIBBON hugging the
      // plate edge, not a room-shaped void. A bbox is a scalar wearing two
      // numbers; this is the descriptor that separates the classes.
      fill: (n * CELL * CELL) / Math.max(1e-9, w * h),
      x: bx0,
      y: by0,
    })
  }
  clusters.sort((a, b) => b.area - a.area)

  return {
    plateAreaSampled: plateCells * CELL * CELL,
    deadArea: deadCells * CELL * CELL,
    deadFrac: plateCells ? deadCells / plateCells : 0,
    clusters,
  }
}

const ids = SNAPSHOT ? ['snapshot'] : ONLY ? [ONLY] : Editor.fixture_ids()
/**
 * The plates this run MUST measure, fixed BEFORE the first measurement. A
 * snapshot is always in it — the caller named that file on purpose, so an
 * unresolved one is a failed run, not an empty one.
 */
const MUST_MEASURE = ids.filter((id) => !EXPECTED_UNRESOLVED.has(id))
let worst = 0
let measured = 0
/** Failures about WHICH plates resolved — a different class from how dead they
 *  are, collected so all of them are reported rather than the first. */
const structural = []
const rows = []
for (const id of ids) {
  const ed = SNAPSHOT
    ? Editor.from_snapshot(fs.readFileSync(SNAPSHOT, 'utf8'))
    : new Editor()
  if (!SNAPSHOT) ed.load_fixture(id)
  const plate = ed.plate()
  const st = ed.state()
  if (!plate || plate.length < 3) {
    // An unresolved plate has no floor to measure. Say so; do not report 0% —
    // AND do not let the run reach a verdict without it, unless it is declared.
    rows.push({ id, note: 'plate unresolved — nothing to measure' })
    if (!EXPECTED_UNRESOLVED.has(id)) {
      structural.push(
        `${id}: plate UNRESOLVED and NOT declared so — this is the measurement, ` +
          'not a row to skip. Either the plate regressed or EXPECTED_UNRESOLVED is stale.',
      )
    }
    continue
  }
  if (EXPECTED_UNRESOLVED.has(id)) {
    structural.push(
      `${id}: plate RESOLVED, but it is declared unresolved (${EXPECTED_UNRESOLVED.get(id)}). ` +
        'The fixture moved out from under its declaration; re-derive both, do not delete the entry.',
    )
  }
  const boxes = [...st.components.map(componentBox), ...zoneBoxes(st.zones)]

  // NON-VACUITY, and it is the check the retracted instrument did not have.
  // The sampled plate must agree with the polygon's own area, or the sampling is
  // covering the wrong region and every fraction below is over the wrong
  // denominator — which is exactly how 1597 m² got reported as a 930 m² plate.
  const truth = polyArea(plate)
  const r = measure(plate, boxes)
  const err = Math.abs(r.plateAreaSampled - truth) / truth
  if (err > 0.02) {
    console.error(
      `${id}: sampled plate ${r.plateAreaSampled.toFixed(0)} m² vs polygon ${truth.toFixed(0)} m² ` +
        `(${(err * 100).toFixed(1)}% off) — the sampler is the finding`,
    )
    process.exit(1)
  }
  if (boxes.length < 10) {
    console.error(`${id}: only ${boxes.length} programme elements — the instrument is the finding`)
    process.exit(1)
  }
  rows.push({ id, truth, boxes: boxes.length, ...r })
  if (argv.includes('--clusters') && (!ONLY || ONLY === id)) {
    console.log(`  ${id} dead clusters (area m² · bbox · aspect · at):`)
    for (const c of r.clusters.filter((c) => c.area >= 2)) {
      console.log(
        `    ${c.area.toFixed(1).padStart(6)} · bbox ${c.w.toFixed(1)}x${c.h.toFixed(1)} · ` +
          `fill ${(c.fill * 100).toFixed(0)}% · ${c.aspect.toFixed(1)}:1 · ` +
          `${c.x.toFixed(1)},${c.y.toFixed(1)}`,
      )
    }
  }
  worst = Math.max(worst, r.deadFrac)
  measured++
}

for (const r of rows) {
  if (r.note) {
    console.log(`${r.id}: ${r.note}`)
    continue
  }
  console.log(
    `${r.id}: plate ${r.truth.toFixed(1)} m² · ${r.boxes} programme elements · ` +
      `dead (>${RADIUS} m) ${r.deadArea.toFixed(1)} m² = ${(r.deadFrac * 100).toFixed(1)}%`,
  )
}
// NON-VACUITY OF THE VERDICT (V1). Before any threshold is applied: every plate
// this run committed to measuring must have been measured, and there must be at
// least one. Unconditional — a report-only run that measured nothing found
// nothing, and should say so rather than print an empty table quietly.
if (structural.length) {
  for (const s of structural) console.error(`  ${s}`)
  console.error(
    `DEADSPACE FAIL: ${structural.length} plate(s) did not resolve as declared — ` +
      'no dead-space verdict is available for this run.',
  )
  process.exit(1)
}
if (measured !== MUST_MEASURE.length || measured === 0) {
  console.error(
    `DEADSPACE FAIL: measured ${measured} of ${MUST_MEASURE.length} required plate(s) ` +
      `[${MUST_MEASURE.join(', ')}] — worst over an empty or partial set is not a verdict.`,
  )
  process.exit(1)
}

if (MAX_DEAD != null) {
  if (worst > MAX_DEAD) {
    console.error(`DEADSPACE FAIL: worst ${(worst * 100).toFixed(1)}% > ${(MAX_DEAD * 100).toFixed(1)}%`)
    process.exit(1)
  }
  console.log(
    `DEADSPACE OK: worst ${(worst * 100).toFixed(1)}% <= ${(MAX_DEAD * 100).toFixed(1)}% ` +
      `over ${measured}/${MUST_MEASURE.length} required plate(s)`,
  )
}
