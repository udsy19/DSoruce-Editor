// Node test for the space-planning report's PURE model layer
// (buildReportModel + normalizeRadar). Run from web/:
//   node src/export/report.test.mjs
//
// Unlike the DOM-free sheet tests, this one needs the REAL wasm core
// (from_snapshot / generate / metrics / zone_stats), so we esbuild-bundle a
// tiny entry that re-exports the wasm Editor + init alongside report.ts, then
// initSync the compiled ds_core_bg.wasm. No canvas is touched (the model layer
// is pure), so it runs headless.

// @covers: web/src/export/report.ts
// @covers: crates/ds-core/src/lib.rs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
if (!fs.existsSync(wasmPath)) {
  console.log('SKIP: wasm not built (run `make wasm`)')
  process.exit(0)
}

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-report-${Date.now()}.mjs`)
await build({
  stdin: {
    contents: `
      export { Editor, initSync } from '../wasm/ds_core'
      export { buildReportModel, normalizeRadar, RADAR_AXES } from './report'
    `,
    resolveDir: here,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })
mod.initSync({ module: fs.readFileSync(wasmPath) })
const { Editor, buildReportModel, normalizeRadar, RADAR_AXES } = mod

// --- build fixture snapshots: an 18×12 m plate, generated at 3 seeds --------
const PROGRAM = {
  desks: 24,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
}

function makeSnapshot(seed) {
  const ed = new Editor()
  // 18×12 rectangular plate.
  ed.add_wall(0, 0, 18, 0, 0.2)
  ed.add_wall(18, 0, 18, 12, 0.2)
  ed.add_wall(18, 12, 0, 12, 0.2)
  ed.add_wall(0, 12, 0, 0, 0.2)
  ed.generate(PROGRAM, BigInt(seed), false)
  const snap = ed.snapshot()
  ed.free()
  return snap
}

const alternatives = [1, 2, 3].map((s) => ({ name: `Alternative ${'ABC'[s - 1]}`, snapshot: makeSnapshot(s) }))

let passed = 0
let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  cond ? passed++ : failed++
}

// --- model shape ------------------------------------------------------------
const model = buildReportModel(alternatives, {
  project: 'Test Fit',
  style: 'Modern',
  client: 'Acme',
  address: '1 Test Rd',
  floor: '6th Floor',
})

check('one KPI block per alternative', model.alternatives.length === 3)

console.log('\n=== per-alternative KPIs ===')
for (const a of model.alternatives) {
  console.log(
    `${a.name}  design#${a.designId}  USF=${Math.round(a.usfSf)}sf  seats=${a.seats}` +
      ` (ws=${a.workstations}+mtg=${a.meetingSeats})  open=${a.openSpaceSeats}  offices=${a.offices}` +
      `  conf=${a.confRooms}  density=${a.densitySqf.toFixed(1)}sqf/${a.densityM2.toFixed(1)}m²` +
      `  daylight=${a.daylightPct.toFixed(0)}%  privacy=${a.privacyPct.toFixed(0)}%  eff=${a.efficiencyPct.toFixed(0)}%`,
  )
  const label = a.name
  check(`${label}: seats > 0`, a.seats > 0)
  check(`${label}: workstations > 0`, a.workstations > 0)
  check(`${label}: USF > 0 sf`, a.usfSf > 0)
  check(`${label}: seats = workstations + meeting seats`, a.seats === a.workstations + a.meetingSeats)
  check(`${label}: density sqf/person in a sane band (20..600)`, a.densitySqf > 20 && a.densitySqf < 600)
  check(`${label}: daylight in [0,100]`, a.daylightPct >= 0 && a.daylightPct <= 100)
  check(`${label}: privacy in [0,100]`, a.privacyPct >= 0 && a.privacyPct <= 100)
  check(`${label}: efficiency in [0,100]`, a.efficiencyPct >= 0 && a.efficiencyPct <= 100)
  check(`${label}: open space ≤ workstations`, a.openSpaceSeats <= a.workstations)
  check(`${label}: hasWalls`, a.hasWalls === true)
  const mix = a.spaceMix
  check(`${label}: space mix has positive area`, mix.work + mix.sharedSpace + mix.amenities + mix.shared > 0)
  check(`${label}: legend has zone types`, a.zoneTypes.length > 0)
}

// --- radar normalization ----------------------------------------------------
const radar = normalizeRadar(model)
check('radar: one row per alternative', radar.length === 3)
check('radar: 8 axes per row', radar.every((r) => r.length === RADAR_AXES.length))
check('radar: all values in [0,1]', radar.every((r) => r.every((v) => v >= 0 && v <= 1)))
// Each axis with any positive value must normalize to 1 for its best alt
// (all-zero axes — e.g. offices on a small plate — legitimately never hit 1).
check(
  'radar: each non-zero axis maxes at 1 for some alternative',
  RADAR_AXES.every((_, i) => {
    const anyPositive = radar.some((r) => r[i] > 0)
    return !anyPositive || radar.some((r) => Math.abs(r[i] - 1) < 1e-9)
  }),
)

// --- degradation: single alternative ---------------------------------------
const solo = buildReportModel([alternatives[0]], { project: 'Solo' })
check('single-alternative model builds', solo.alternatives.length === 1)
check('single-alternative radar: 1 row, 8 axes', normalizeRadar(solo).length === 1 && normalizeRadar(solo)[0].length === 8)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
