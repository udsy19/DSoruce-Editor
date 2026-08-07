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
  for (let k = 0; k < d.length; k++) {
    if (!inPlate[k]) continue
    plateCells++
    if ((d[k] / 3) * CELL > RADIUS) deadCells++
  }
  return {
    plateAreaSampled: plateCells * CELL * CELL,
    deadArea: deadCells * CELL * CELL,
    deadFrac: plateCells ? deadCells / plateCells : 0,
  }
}

const ids = SNAPSHOT ? ['snapshot'] : ONLY ? [ONLY] : Editor.fixture_ids()
let worst = 0
const rows = []
for (const id of ids) {
  const ed = SNAPSHOT
    ? Editor.from_snapshot(fs.readFileSync(SNAPSHOT, 'utf8'))
    : new Editor()
  if (!SNAPSHOT) ed.load_fixture(id)
  const plate = ed.plate()
  const st = ed.state()
  if (!plate || plate.length < 3) {
    // An unresolved plate has no floor to measure. Say so; do not report 0%.
    rows.push({ id, note: 'plate unresolved — nothing to measure' })
    continue
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
  worst = Math.max(worst, r.deadFrac)
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
if (MAX_DEAD != null) {
  if (worst > MAX_DEAD) {
    console.error(`DEADSPACE FAIL: worst ${(worst * 100).toFixed(1)}% > ${(MAX_DEAD * 100).toFixed(1)}%`)
    process.exit(1)
  }
  console.log(`DEADSPACE OK: worst ${(worst * 100).toFixed(1)}% <= ${(MAX_DEAD * 100).toFixed(1)}%`)
}
