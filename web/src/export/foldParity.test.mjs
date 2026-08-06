// C6, AS RE-REGISTERED. Run from web/:  node src/export/foldParity.test.mjs
// @covers: crates/ds-core/src/lib.rs  (zone_stats / zone_stats_published / metrics)
//
// The ORIGINAL C6 said "efficiency_pct decreased or equal; it must not increase".
// That was withdrawn: it was built on a wrong model. `usable_area` already
// excluded Circulation, so reclassifying that floor as Unassigned could not move
// efficiency at all — measured 61.63 before and after. A gate written to the old
// wording would have passed on a tautology and kept passing if the fold were
// bypassed entirely.
//
// Registered instead, and asserted here:
//   1. EFFICIENCY INVARIANCE — `efficiency_pct` equals usable/NIA re-derived
//      INDEPENDENTLY from the honest zone rows. Not "≤": equal.
//   2. FOLD EXACTNESS — published Circulation area == honest (Circulation +
//      Unassigned) area, and the row counts match.
//   3. NO `Unassigned` STRING in any published projection. This is the half that
//      actually guards the rule: 1 and 2 are arithmetic, 3 is the promise.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
if (!fs.existsSync(wasmPath)) { console.log('SKIP: wasm not built (run `make wasm`)'); process.exit(0) }
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const outFile = path.join(os.tmpdir(), `ds-fold-${Date.now()}.mjs`)
await build({
  stdin: { contents: `export { Editor, initSync } from '../wasm/ds_core'`, resolveDir: here, loader: 'ts' },
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })
mod.initSync({ module: fs.readFileSync(wasmPath) })
const { Editor } = mod

const PROGRAM = {
  desks: 24, meeting_rooms: 2, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25, w_density: 0.2,
}
// An L-shaped plate: irregular, so the residual pass actually fires and the fold
// has something to fold. A rectangular plate would make every assertion vacuous.
const CORNERS = [[0,0],[20,0],[20,8],[12,8],[12,14],[0,14]]

const GROUND = new Set(['Circulation', 'Unassigned'])
const USABLE_EXCLUDED = new Set(['Circulation', 'Unassigned', 'Core'])
let sawUnassigned = 0
let seeds = 0

for (const seed of [1, 2, 3, 4]) {
  const ed = new Editor()
  for (let i = 0; i < CORNERS.length; i++) {
    const a = CORNERS[i], b = CORNERS[(i + 1) % CORNERS.length]
    ed.add_wall(a[0], a[1], b[0], b[1], 0.2)
  }
  ed.generate(PROGRAM, BigInt(seed), false)
  const honest = ed.zone_stats()
  const pub = ed.zone_stats_published()
  const m = ed.metrics()
  seeds++

  // 3. NO `Unassigned` anywhere in the published projection — type OR label.
  for (const z of pub) {
    assert.notEqual(z.zone_type, 'Unassigned',
      `seed ${seed}: a published row is typed Unassigned — the fold was bypassed`)
    assert.ok(!String(z.label ?? '').includes('Unassigned'),
      `seed ${seed}: a published row is LABELLED Unassigned — the fold missed the label`)
  }

  // 2. FOLD EXACTNESS — area and row count.
  const sum = (rows, pred) => rows.filter(pred).reduce((s, z) => s + z.area, 0)
  const honestGround = sum(honest, (z) => GROUND.has(z.zone_type))
  const pubCirc = sum(pub, (z) => z.zone_type === 'Circulation')
  assert.ok(Math.abs(honestGround - pubCirc) < 1e-6,
    `seed ${seed}: fold not exact — honest ground ${honestGround.toFixed(4)} vs published circulation ${pubCirc.toFixed(4)}`)
  const nHonest = honest.filter((z) => GROUND.has(z.zone_type)).length
  const nPub = pub.filter((z) => z.zone_type === 'Circulation').length
  assert.equal(nPub, nHonest, `seed ${seed}: fold changed the row COUNT (${nHonest} honest vs ${nPub} published)`)
  if (honest.some((z) => z.zone_type === 'Unassigned')) sawUnassigned++

  // 1. EFFICIENCY INVARIANCE — re-derived independently from the honest rows,
  //    not read back from the same number under test.
  const nia = honest.reduce((s, z) => s + z.area, 0)
  const usable = sum(honest, (z) => !USABLE_EXCLUDED.has(z.zone_type))
  const expect = nia > 0 ? (usable / nia) * 100 : 0
  assert.ok(Math.abs(expect - m.efficiency_pct) < 0.01,
    `seed ${seed}: efficiency_pct ${m.efficiency_pct.toFixed(4)} != independently re-derived ${expect.toFixed(4)} ` +
    '— either waste has been folded into a benchmarked ratio, or usable membership changed without a decision')
  ed.free()
}

// NON-VACUITY: if no seed produced Unassigned floor, the fold assertions above
// compared two identical sets and proved nothing.
assert.ok(sawUnassigned > 0,
  `no seed produced Unassigned floor across ${seeds} seeds — the fold assertions are vacuous on this fixture`)

console.log(`PASS foldParity: ${seeds} seeds, ${sawUnassigned} with unassigned floor; fold exact, efficiency independently re-derived, no 'Unassigned' published`)
