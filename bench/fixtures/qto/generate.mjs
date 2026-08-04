// Ground truth for the BOM/QTO bake-off.
//
// Run from repo root:  node bench/fixtures/qto/generate.mjs
//
// HONESTY ABOUT WHAT "HAND-COUNT" MEANS HERE. Nobody counted 500+ blocks by eye,
// and a count done that way would be less trustworthy, not more. The truth below
// is derived MECHANICALLY from the document the quantity engine is asked to
// price — `Editor.state()` — using nothing from `export/takeoff.ts`. It is exact
// and reproducible, and it is independent of every candidate.
//
// What that does verify: the ROLLUP. Given this document, do the quantities,
// groupings and cost lines come out right?
// What it does NOT verify: that the document faithfully reflects the DWG. That
// is the importer's job and is covered by import/*.test.mjs — a different
// branch's truth, deliberately not conflated with this one.
//
// The document is pinned: the real DWG -> the ADR 0003 ladder plate -> a
// deterministic generate at a fixed seed. Same input, same document, every run.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const SEED = 3

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
let seq = 0
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `qto-${process.pid}-${seq++}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const wasmDir = path.join(ROOT, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm
const { parseDrawing } = await bundle(path.join(ROOT, 'web/src/import/dxf.ts'))
const { extractPlate } = await bundle(path.join(ROOT, 'web/src/import/testfit.ts'))

const dxfOut = path.join(os.tmpdir(), `qto-${process.pid}.dxf`)
execFileSync('dwg2dxf', ['-o', dxfOut, path.join(ROOT, 'samples/furniture-plan.dwg')], { stdio: ['ignore', 'ignore', 'pipe'] })
const drawing = parseDrawing(fs.readFileSync(dxfOut, 'utf8'))
fs.rmSync(dxfOut, { force: true })

const plate = extractPlate(drawing)
const ed = new Editor()
const b = plate.boundary
for (let i = 0; i < b.length; i++) {
  const [ax, ay] = b[i]
  const [bx, by] = b[(i + 1) % b.length]
  ed.add_wall(ax, ay, bx, by, 0.15)
}
const PROGRAM = {
  desks: 90, meeting_rooms: 6, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  support_spaces: true, rooms: [],
  w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25, w_density: 0.2,
  w_program: 0.1, w_daylight: 0.05, w_entry: 0.05,
}
ed.generate(PROGRAM, BigInt(SEED), false)

const state = ed.state()
const metrics = ed.metrics()
const zoneStats = ed.zone_stats()

// ---- truth, derived from the document alone ---------------------------------
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n

const byCategory = {}
for (const c of state.components) {
  const k = c.category
  byCategory[k] ??= { count: 0, areaM2: 0, reference: 0 }
  byCategory[k].count++
  byCategory[k].areaM2 = round(byCategory[k].areaM2 + c.w * c.h)
  if (c.reference) byCategory[k].reference++
}

const byZoneType = {}
for (const z of zoneStats) {
  byZoneType[z.zone_type] ??= { zones: 0, areaM2: 0, seated: 0 }
  byZoneType[z.zone_type].zones++
  byZoneType[z.zone_type].areaM2 = round(byZoneType[z.zone_type].areaM2 + z.area)
  byZoneType[z.zone_type].seated += z.seated
}

let wallLengthM = 0
for (const w of state.walls) wallLengthM += Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)

// The regression case from ROADMAP Track F: the re-imagine panel's binds never
// reached the App bindings map, so priced binds surfaced NO price and NO supplier
// in the takeoff. Bind a sample here so a candidate that drops them is caught.
const PRICED = [199_00, 45_50, 12_000, 8_750, 33_333]
const bindings = {}
const bound = state.components
  .filter((c) => !c.reference)
  .filter((_, i) => i % 17 === 0)
  .slice(0, PRICED.length)
for (let i = 0; i < bound.length; i++) {
  const pid = `bank-${1000 + i}`
  ed.assign_product(bound[i].id, pid, `Bound Product ${i + 1}`, PRICED[i])
  // BindingInfo's field is `price`, not `priceInr` — using the wrong name here
  // silently prices everything at 0, which is how this fixture first failed.
  bindings[pid] = { price: PRICED[i], image: null, supplier: `Supplier ${i + 1}` }
}
const boundState = ed.state()
const boundIds = bound.map((c) => c.id)
const expectedSpecifiedCost = PRICED.slice(0, bound.length).reduce((s, v) => s + v, 0)

const truth = {
  note: 'Derived mechanically from Editor.state(); uses nothing from export/takeoff.ts.',
  source: { dwg: 'samples/furniture-plan.dwg', plateM2: round(plate.areaM2, 1), plateMethod: plate.provenance.method, seed: SEED, program: PROGRAM },
  document: {
    componentCount: state.components.length,
    wallCount: state.walls.length,
    wallLengthM: round(wallLengthM, 3),
    zoneCount: (state.zones ?? []).length,
  },
  byCategory,
  byZoneType,
  metrics: {
    floorAreaM2: round(metrics.floor_area, 3),
    grossExternalAreaM2: round(metrics.gross_external_area, 3),
    netInternalAreaM2: round(metrics.net_internal_area, 3),
    workstations: metrics.workstations,
  },
  /** The ROADMAP Track F regression: every priced binding must reach a cost line. */
  bindingRegression: {
    boundComponentIds: boundIds,
    bindings,
    expectedSpecifiedCostInr: expectedSpecifiedCost,
    expectedPricedLineCount: bound.length,
  },
  snapshot: ed.snapshot(),
}

fs.writeFileSync(path.join(here, 'truth.json'), JSON.stringify(truth, null, 2))
console.log(`plate ${truth.source.plateM2} m2 via ${truth.source.plateMethod}, seed ${SEED}`)
console.log(`document: ${truth.document.componentCount} components, ${truth.document.wallCount} walls, ${truth.document.zoneCount} zones`)
console.log('\nby category:')
for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${k.padEnd(14)} ${String(v.count).padStart(4)}  ${String(round(v.areaM2, 1)).padStart(8)} m2${v.reference ? `  (${v.reference} reference)` : ''}`)
}
console.log('\nby zone type:')
for (const [k, v] of Object.entries(byZoneType).sort((a, b) => b[1].areaM2 - a[1].areaM2)) {
  console.log(`  ${k.padEnd(14)} ${String(v.zones).padStart(3)} zones  ${String(round(v.areaM2, 1)).padStart(8)} m2  ${v.seated} seated`)
}
console.log(`\nNIA ${truth.metrics.netInternalAreaM2} m2 · workstations ${truth.metrics.workstations}`)
console.log(`binding regression: ${bound.length} priced binds, Σ ₹${expectedSpecifiedCost.toLocaleString('en-IN')}`)
