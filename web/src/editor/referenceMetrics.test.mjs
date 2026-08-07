// Three-surface agreement for the passive `reference` facet.
// Run from web/:  node src/editor/referenceMetrics.test.mjs
//
// Drives the REAL wasm `Editor` (Rust `metrics()` / `zone_stats()` /
// `cost::specified_cost`) AND the REAL bundled `stats.ts` (`buildZones` /
// `buildElements`), then asserts the ONE-definition invariants across ALL THREE
// surfaces at once — the exact disagreement the reference fix set out to kill:
//
//   INV1  metrics().workstations == Σ Workspace zone_stats().seated
//         == buildZones(zone_stats()).totalPax                (Rust ⋂ Rust ⋂ stats.ts)
//   INV2  a Desk flipped to `reference` (still inside its Workspace zone's
//         component_ids) contributes 0 to workstations / pax / specified_cost /
//         buildElements furniture; a non-reference bound desk MUST count.
//   INV3  area_per_workstation stays finite (no NaN / div-by-zero).
//   INV4  GEA / NIA / efficiency are invariant to the reference flag.
//   INV5  a clean fit counts EVERY placed Desk (workstations == desk count).
//
// This is the wasm end-to-end companion to the Rust unit tests in lib.rs and to
// mergePricing.test.mjs (which pins the Rust cost engine's binding math).

// @covers: web/src/editor/stats.ts
// @covers: crates/ds-core/src/lib.rs
// @covers: crates/ds-core/src/cost.rs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmDir = path.join(here, '../wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('SKIP: web/src/wasm not built (run `make wasm`)')
  process.exit(0)
}

// --- load the real wasm Editor -----------------------------------------------
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

// --- bundle the real stats.ts (type-only import of EditorCanvas is erased, so
//     no wasm/canvas is dragged in) -----------------------------------------
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const bundle = async (entry) => {
  const outFile = path.join(os.tmpdir(), `ds-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({ entryPoints: [path.join(here, entry)], outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(outFile).href)
  fs.rmSync(outFile, { force: true })
  return mod
}
const { buildZones, buildElements } = await bundle('stats.ts')
// The REAL `ZoneAreas` constructor, through its own entry point rather than the
// copy stats.ts bundled — so a check that the panel bills the core's areas is
// comparing two modules and not one value with itself.
const { zoneAreasFromStats } = await bundle('../types/metrics.ts')

// --- helpers -----------------------------------------------------------------
let failures = 0
const check = (label, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (got ${got})`}`); if (!cond) failures++ }
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 1e-6

// DEFAULT_PROGRAM (mirrors EditorCanvas.ts) — a real professional test-fit.
const PROGRAM = {
  desks: 20, meeting_rooms: 2, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  support_spaces: true, rooms: [], w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25,
  w_density: 0.2, w_program: 0.1, w_daylight: 0.05, w_entry: 0.05,
}

// A 30×20 plate + a clean generated fit.
function freshFit() {
  const ed = new Editor()
  const box = [[0, 0], [30, 0], [30, 20], [0, 20]]
  for (let i = 0; i < box.length; i++) {
    const [ax, ay] = box[i]
    const [bx, by] = box[(i + 1) % box.length]
    ed.add_wall(ax, ay, bx, by, 0.1)
  }
  ed.generate(PROGRAM, BigInt(3), false)
  return ed
}

const surfaces = (ed) => {
  const m = ed.metrics()
  const zs = ed.zone_stats()
  const state = ed.state()
  const zones = buildZones(zs)
  const nia = zones.totalArea || m.net_internal_area || 0
  const elements = buildElements(state, nia, zoneAreasFromStats(zs))
  const wsSeated = zs.filter((z) => z.zone_type === 'Workspace').reduce((s, z) => s + z.seated, 0)
  return { m, zs, state, zones, elements, wsSeated }
}

console.log('=== reference facet: three-surface agreement (wasm ⋂ stats.ts) ===')

// --- 1) INV1 + INV5 on a clean fit ------------------------------------------
const ed = freshFit()
let s = surfaces(ed)
const deskIds = s.state.components.filter((c) => c.category === 'Desk').map((c) => c.id)
const W0 = s.m.workstations

check('clean fit seats desks (W0 > 0)', W0 > 0, W0)
check('INV5 clean fit: workstations == every placed Desk', W0 === deskIds.length, `${W0} vs ${deskIds.length} desks`)
check('INV1a: metrics.workstations == Σ Workspace seated', W0 === s.wsSeated, `${W0} vs ${s.wsSeated}`)
check('INV1b: metrics.workstations == buildZones.totalPax (stats.ts)', W0 === s.zones.totalPax, `${W0} vs ${s.zones.totalPax}`)
check('no generated component is reference', s.state.components.every((c) => !c.reference), '')
check('INV3: area_per_workstation finite & > 0', Number.isFinite(s.m.area_per_workstation) && s.m.area_per_workstation > 0, s.m.area_per_workstation)

const GEA0 = s.m.gross_external_area, NIA0 = s.m.net_internal_area, EFF0 = s.m.efficiency_pct

// --- 2) INV2: flip a real in-Workspace generated desk to reference ----------
// (it stays inside its Workspace zone's component_ids, so this is the
//  "reference desk in a Workspace zone" case — it must STOP counting.)
const flipId = deskIds[0]
ed.set_component_reference(flipId, true)
s = surfaces(ed)
check('INV2: flipping an in-zone desk to reference decrements workstations', s.m.workstations === W0 - 1, `${s.m.workstations}`)
check('INV2: pax decrements in lockstep (stats.ts)', s.zones.totalPax === W0 - 1, `${s.zones.totalPax}`)
check('INV1 holds after flip (all three agree)', s.m.workstations === s.wsSeated && s.m.workstations === s.zones.totalPax, `${s.m.workstations}/${s.wsSeated}/${s.zones.totalPax}`)

// --- 3) INV4: areas / efficiency untouched by the reference flag -------------
check('INV4: GEA unchanged by reference', near(s.m.gross_external_area, GEA0), s.m.gross_external_area)
check('INV4: NIA unchanged by reference', near(s.m.net_internal_area, NIA0), s.m.net_internal_area)
check('INV4: efficiency unchanged by reference', near(s.m.efficiency_pct, EFF0), s.m.efficiency_pct)

// flip back → the count is restored (no drift).
ed.set_component_reference(flipId, false)
s = surfaces(ed)
check('un-referencing restores the count', s.m.workstations === W0, `${s.m.workstations}`)

// --- 4) Unzoned desk: a non-reference desk in NO zone never counts -----------
ed.add_component('Desk', -100, -100, 1.6, 0.8) // far outside every zone
s = surfaces(ed)
check('unzoned non-reference desk does NOT count (Rust)', s.m.workstations === W0, `${s.m.workstations}`)
check('unzoned desk does NOT count (stats.ts pax)', s.zones.totalPax === W0, `${s.zones.totalPax}`)

// --- 5) Cost: specified_cost + buildElements both exclude reference ----------
// Bind a real price to a counted generated desk → it enters BOTH cost surfaces.
ed.assign_product(flipId, 'sku-x', 'Bench X', 5000)
s = surfaces(ed)
const specWith = s.m.specified_cost
const furnWith = s.elements.groups.find((g) => g.label === 'Furniture')?.cost ?? 0
check('bound generated desk enters specified_cost (Rust)', near(specWith, 5000), specWith)
check('bound generated desk enters buildElements furniture (stats.ts)', furnWith >= 5000, furnWith)

// Flip that SAME bound desk to reference → it must drop from BOTH cost surfaces.
// (Rust `specified_cost` sums `price_inr`, so it drops by the full 5000; stats.ts
//  `buildElements` prices furniture from the mock bank / per-group default — the
//  two cost MODELS differ by design (stats.ts header) — so the invariant asserted
//  here is only the EXCLUSION: the item leaves the furniture line entirely.)
ed.set_component_reference(flipId, true)
s = surfaces(ed)
const specRef = s.m.specified_cost
const furnRef = s.elements.groups.find((g) => g.label === 'Furniture')?.cost ?? 0
check('reference bound desk drops from specified_cost (Rust, -5000)', near(specRef, 0), specRef)
check('reference bound desk leaves buildElements furniture (stats.ts)', furnRef < furnWith, `${furnRef} < ${furnWith}`)
check('INV3 stays finite when workstations dip', Number.isFinite(s.m.area_per_workstation), s.m.area_per_workstation)

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1) }
console.log('\nAll reference-facet three-surface assertions passed.')
