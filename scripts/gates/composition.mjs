// COMPOSITION: our programme mix and field rhythm, against the reference's.
//
//   node scripts/gates/composition.mjs [--fixture F1] [--gate]
//
// Two measurements, one instrument each side, from CORE STATE — the plan's own
// zones and components, never a raster and never the generator's account of
// itself (`layout_diag` is diagnostic only, per its own header).
//
// The contract is `research/qbiq-composition-spec.json`, extracted from the
// reference by `research/qbiq-composition-extract.py`:
//
//   offices per 100 open seats   4.67
//   conf rooms per 100 open      8.60
//   density m2/person            9.85
//   max unpunctuated desk rows   5
//
// RHYTHM IS MEASURED THE SAME WAY ON BOTH SIDES. Desks come in two orientation
// families and must be separated; within a family the STACKING AXIS IS DERIVED
// from the data (rows are fewer than desks-per-row, so the row axis is the one
// with fewer bands) rather than assumed from orientation. The reference stacks
// portrait desks along y and our packer stacks them along x, and hard-coding
// either convention reports desks-along-a-bench as rows — it scored our longest
// run as 14 before this was fixed, against a true 7. A gap wider than 1.6x the
// median row pitch is a punctuation.
//
// FALSIFICATION (rule 1 — no number without one): `--falsify` fills the widest
// punctuation with a row of desks, merging two runs; the maximum must rise and
// the gate must exit nonzero. Its output is in the ledger.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const SPEC = JSON.parse(fs.readFileSync(path.join(REPO, 'research/qbiq-composition-spec.json'), 'utf8'))

const argv = process.argv.slice(2)
const arg = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}
const ONLY = arg('--fixture', null)
const GATE = argv.includes('--gate')

/** Same punctuation rule as the reference extractor. Not tuned to either side. */
const PUNCTUATION_FACTOR = 1.6

const wasmDir = path.join(REPO, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
wasm.initSync({ module: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

/** Enclosed single-occupant / small rooms — the reference's "Offices". */
const OFFICE_TYPES = new Set(['ClosedOffice'])
/** The reference's "Conf Room". */
const CONF_TYPES = new Set(['Meeting', 'Collaboration'])

function rhythm(desks) {
  // Split by orientation the way the desk actually sits in the world.
  const fams = { portrait: [], landscape: [] }
  for (const c of desks) {
    const ca = Math.abs(Math.cos(c.rotation ?? 0))
    const sa = Math.abs(Math.sin(c.rotation ?? 0))
    const w = c.w * ca + c.h * sa
    const h = c.w * sa + c.h * ca
    fams[h > w ? 'portrait' : 'landscape'].push({ x: c.x, y: c.y })
  }
  const band = (pts, axis) => {
    const vals = pts.map((p) => p[axis]).sort((a, b) => a - b)
    const bands = []
    let cur = [vals[0]]
    for (const v of vals.slice(1)) {
      if (v - cur[cur.length - 1] <= 0.2) cur.push(v)
      else {
        bands.push(cur.reduce((a, b) => a + b, 0) / cur.length)
        cur = [v]
      }
    }
    bands.push(cur.reduce((a, b) => a + b, 0) / cur.length)
    return bands
  }

  const out = {}
  let max = 0
  for (const [name, pts] of Object.entries(fams)) {
    if (pts.length < 4) continue
    // THE STACKING AXIS IS DERIVED, NOT ASSUMED.
    //
    // The reference stacks portrait desks along y; our packer stacks them along
    // x — it rotates desks ±π/2 in a portrait WING, so orientation alone does
    // not tell you which way rows run. Assuming it reported our longest run as
    // "14 rows at 2.5 m pitch", which is desks along a bench measured as if they
    // were rows: the exact mistake the reference extraction made first, repeated
    // on our side by hard-coding its correction.
    //
    // Rows are fewer than desks-per-row, so the row axis is the one that yields
    // FEWER bands. That is a property of a grid, not of a convention, and it
    // holds for either arrangement.
    const bx = band(pts, 'x')
    const by = band(pts, 'y')
    const axis = bx.length <= by.length ? 'x' : 'y'
    const bands = axis === 'x' ? bx : by
    const gaps = bands.slice(1).map((b, i) => b - bands[i])
    if (!gaps.length) continue
    const med = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]
    const thr = PUNCTUATION_FACTOR * med
    const runs = []
    let n = 1
    for (const g of gaps) {
      if (g > thr) {
        runs.push(n)
        n = 1
      } else n++
    }
    runs.push(n)
    out[name] = {
      rows: bands.length,
      axis,
      medianPitch: +med.toFixed(2),
      threshold: +thr.toFixed(2),
      runs,
      maxRun: Math.max(...runs),
    }
    max = Math.max(max, out[name].maxRun)
  }
  return { families: out, maxRun: max }
}

const FALSIFY = argv.includes('--falsify')
const ids = ONLY ? [ONLY] : FALSIFY ? ['F1'] : Editor.fixture_ids()
const ref = SPEC.programme_mix
const refMaxRows = SPEC.field_rhythm.max_unpunctuated_rows
let failed = 0

console.log(
  `reference: offices/100 ${ref.offices_per_100_open} · conf/100 ${ref.conf_rooms_per_100_open} · ` +
    `${ref.density_m2_per_person} m²/person · max ${refMaxRows} rows`,
)

for (const id of ids) {
  const ed = new Editor()
  ed.load_fixture(id)
  const st = ed.state()
  const m = ed.metrics()
  let desks = st.components.filter((c) => c.category === 'Desk' && !c.reference)
  if (FALSIFY) {
    // INDUCE THE DEFECT: fill the widest aisle in the dominant family with a row
    // of desks, so two runs merge into one longer than the reference allows.
    const before = rhythm(desks)
    const fam = Object.entries(before.families).sort((a, b) => b[1].rows - a[1].rows)[0]
    const axis = fam[1].axis
    const vals = [...new Set(desks.map((d) => +d[axis].toFixed(2)))].sort((a, b) => a - b)
    let gi = 0
    for (let i = 1; i < vals.length; i++) if (vals[i] - vals[i - 1] > vals[gi + 1] - vals[gi]) gi = i - 1
    const at = (vals[gi] + vals[gi + 1]) / 2
    const donor = desks.filter((d) => Math.abs(d[axis] - vals[gi]) < 0.05)
    for (const d of donor) {
      const x = axis === 'x' ? at : d.x
      const y = axis === 'y' ? at : d.y
      const id = ed.add_component('Desk', x, y, d.w, d.h)
      ed.set_component_rotation(id, d.rotation ?? 0)
    }
    console.log(`  falsify: added ${donor.length} desks into the ${axis} aisle at ${at.toFixed(2)}`)
    desks = ed.state().components.filter((c) => c.category === 'Desk' && !c.reference)
  }
  const zones = st.zones ?? []
  const offices = zones.filter((z) => OFFICE_TYPES.has(z.zone_type)).length
  const conf = zones.filter((z) => CONF_TYPES.has(z.zone_type)).length

  // NON-VACUITY: a plan with no desks would score every ratio as 0/0 and pass.
  if (desks.length < 10) {
    console.error(`${id}: ${desks.length} desks — the instrument is the finding`)
    process.exit(1)
  }
  const per100 = (n) => +((100 * n) / desks.length).toFixed(2)
  const r = rhythm(desks)
  const density = m.workstations > 0 ? +(m.net_internal_area / m.workstations).toFixed(2) : null

  const offR = per100(offices)
  const confR = per100(conf)
  console.log(
    `${id}: ${desks.length} desks · offices ${offices} (${offR}/100) · conf ${conf} (${confR}/100) · ` +
      `${density} m²/person · max run ${r.maxRun} ` +
      Object.entries(r.families)
        .map(([k, v]) => `[${k}/${v.axis} rows ${v.rows} runs ${v.runs.join(',')} pitch ${v.medianPitch}]`)
        .join(' '),
  )

  if (GATE) {
    // The RHYTHM maximum is a hard contract: the reference's own longest run.
    if (r.maxRun > refMaxRows) {
      console.error(`  FAIL ${id}: desk run of ${r.maxRun} rows exceeds the reference's ${refMaxRows}`)
      failed++
    }
    // The MIX band is deliberately one-sided for now — a plan may exceed the
    // reference's room ratios (ours already does on offices) but not fall far
    // below them. Half the reference ratio is the line; it is stated here and
    // ledgered, not derived from what we happen to score.
    if (confR < 0.5 * ref.conf_rooms_per_100_open) {
      console.error(
        `  FAIL ${id}: ${confR} conf rooms per 100 open seats is under half the reference's ` +
          `${ref.conf_rooms_per_100_open}`,
      )
      failed++
    }
  }
}

if (GATE) {
  if (failed) {
    console.error(`COMPOSITION FAIL: ${failed} violation(s)`)
    process.exit(1)
  }
  console.log('COMPOSITION OK')
}
