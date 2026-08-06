// Node test for the Quantity Takeoff exporter. Run from web/:
//   node src/export/takeoff.test.mjs
//
// Builds an 18×12 m plate in the real wasm core, generates seed 1, binds a
// couple of products with ₹ prices, and asserts:
//   1. the pure `buildTakeoffModel` FURNITURE contract (every component appears
//      once with qty aggregation, room ids resolve to zones, totals = Σ qty×price);
//   2. the CORE's quantity surface (`Editor.quantities()`) — which replaced
//      takeoff.ts's own, weaker wall classification: all six wall types present,
//      the perimeter run equals the plate perimeter exactly, door counts exact;
//
// The 12-sheet workbook itself is NOT built here: `qtoWorkbook.ts` reaches the
// plan renderer for its room set, and that graph pulls in the 3D viewer, which
// needs a real DOM. It is covered end-to-end, on real artifacts, by gates
// G1/G2/G3/G5 and by G9 (LibreOffice round-trip, three independent inputs) —
// see `scripts/export-pack.mjs`, which drives the SAME export function the app's
// Export menu calls, inside headless Chromium.
//
// Bundling mirrors dxf.test.mjs (esbuild resolved through vite); the wasm module
// is loaded directly from src/wasm and instantiated from bytes.

// @covers: web/src/export/takeoff.ts
// @covers: crates/ds-core/src/lib.rs

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// --- bundle takeoff.ts (type-only imports of EditorCanvas are dropped) ------
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-takeoff-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'takeoff.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { buildTakeoffModel, zoneAtPoint } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

// The Inventory sheet's own room-type derivation, bundled independently. The
// point of the room-type checks below is that these two modules agree, so the
// test must reach `roomTypeLabel` through its OWN entry point — not through the
// copy takeoff.ts bundled — or it would only be comparing a value with itself.
const finishOut = path.join(os.tmpdir(), `ds-finish-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'finishSchedule.ts')],
  outfile: finishOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { roomTypeLabel, TYPE_LABEL } = await import(pathToFileURL(finishOut).href)
fs.rmSync(finishOut, { force: true })

// --- load the wasm core and instantiate from bytes -------------------------
const wasmJs = pathToFileURL(path.join(here, '../wasm/ds_core.js')).href
const wasm = await import(wasmJs)
const wasmBytes = fs.readFileSync(path.join(here, '../wasm/ds_core_bg.wasm'))
const wasmModule = await WebAssembly.compile(wasmBytes)
await wasm.default({ module_or_path: wasmModule })
const { Editor } = wasm

// --- build an 18×12 plate, generate seed 1 ---------------------------------
const ed = new Editor()
const W = 18
const H = 12
const rect = [
  [0, 0],
  [W, 0],
  [W, H],
  [0, H],
]
for (let i = 0; i < rect.length; i++) {
  const [ax, ay] = rect[i]
  const [bx, by] = rect[(i + 1) % rect.length]
  ed.add_wall(ax, ay, bx, by, 0.15)
}
const program = {
  desks: 20,
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
ed.generate(program, 1n, false)
const state = ed.state()

// --- bind a couple of products with ₹ prices --------------------------------
// Give the first Desk and first Chair a product + price so pricing math runs.
//
// PRICE IS CORE-AUTHORITATIVE (ADR 0004): it goes on the component as
// `price_inr`, exactly as `Editor.assign_product` writes it. This test used to
// put price ONLY in the bindings map, which encoded the two-store design that
// let a core-bound component reach a cost line unpriced — so it failed when the
// second store was removed, correctly. The map keeps supplier/brand, which are
// display metadata the core does not model.
const bindings = new Map()
let deskPid = null
let chairPid = null
for (const c of state.components) {
  if (c.category === 'Desk' && deskPid == null) {
    deskPid = `desk-${c.id}`
    c.product_id = deskPid
    c.price_inr = 12000
    bindings.set(deskPid, {})
  } else if (c.category === 'Chair' && chairPid == null) {
    chairPid = `chair-${c.id}`
    c.product_id = chairPid
    c.price_inr = 4500
    // supplier/brand stay in the map → exercises the takeoff Supplier column
    bindings.set(chairPid, { supplier: 'steelcase.com', brand: 'Steelcase' })
  }
}

const model = buildTakeoffModel(state, { bindings, floor: 1, project: 'Test Plate' })
// The core is the classifier — takeoff.ts no longer derives wall types at all.
const qty = ed.quantities()

// --- report -----------------------------------------------------------------
console.log('=== quantity takeoff report ===')
console.log(`components:       ${state.components.length}`)
console.log(`walls:            ${state.walls.length}`)
console.log(`zones:            ${(state.zones ?? []).length}`)
console.log(`furniture rows:   ${model.furniture.length}`)
console.log(`summary rows:     ${model.summary.length}`)
console.log(`furniture units:  ${model.totals.itemCount}`)
console.log(`furniture total ₹: ${model.totals.furniture}`)
console.log('--- core wall schedule (Editor.quantities()) ---')
for (const w of qty.walls)
  console.log(`  ${w.label.padEnd(20)} ${w.lengthM.toFixed(2).padStart(8)} m × ${w.heightM.toFixed(2)} m`)
console.log(`  doors: ${qty.doors.map((d) => `${d.label} ${d.count}`).join(' · ')}`)
console.log('--- first 6 furniture rows ---')
for (const r of model.furniture.slice(0, 6))
  console.log(`  [${r.costCode}] room ${r.roomId} (${r.roomType})  ${r.itemDescription}  ×${r.quantity}  @₹${r.unitPrice} = ₹${r.totalPrice}`)

// --- assertions -------------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const furnitureComps = state.components.filter((c) => c.category !== 'Door')
const doorComps = state.components.filter((c) => c.category === 'Door')

check('generated components (> 0)', state.components.length > 0)
check('furniture rows present', model.furniture.length > 0)
// supplier resolution: a bound product carries its real supplier into the column
check('bound row shows real supplier (not fallback)', model.furniture.some((r) => r.supplier === 'steelcase.com'))
check(
  'every furniture unit accounted for (Σ qty === non-door component count)',
  model.totals.itemCount === furnitureComps.length,
)
check(
  'doors excluded from furniture BOM',
  !model.furniture.some((r) => /door/i.test(r.itemDescription)),
)
check(
  'every item description carries W×L dims',
  model.furniture.every((r) => /W\d+ X L\d+$/.test(r.itemDescription)),
)
check(
  'room ids resolve (numeric zone id or "OS" catch-all)',
  model.furniture.every((r) => typeof r.roomId === 'number' || r.roomId === 'OS'),
)
// --- ONE room-type derivation across the workbook ---------------------------
// The `Furniture Inventory` Room Type and the `Inventory` Subcategory must be
// the same string for the same Room ID. They used to be two mappings: a private
// zone_type table here billed Reception (an `Amenity` zone) as "Kitchen" while
// the Inventory row said "Reception". Both now resolve through `roomTypeLabel`.
const VOCAB = new Set([...Object.values(TYPE_LABEL), 'Circulation'])
check(
  'room types come from the ONE canonical vocabulary (finishSchedule TYPE_LABEL)',
  model.furniture.every((r) => VOCAB.has(r.roomType)),
)
// Independently recompute the Inventory's label for every billed room and
// compare. This is the assertion that fails the moment a second mapping appears.
const zonesById = new Map((state.zones ?? []).map((z) => [z.id, z]))
const typeDisagreements = model.furniture.filter((r) => {
  const zone = typeof r.roomId === 'number' ? zonesById.get(r.roomId) ?? null : null
  return r.roomType !== roomTypeLabel(zone)
})
for (const r of typeDisagreements)
  console.log(`  room ${r.roomId}: Furniture Inventory "${r.roomType}" vs Inventory "${roomTypeLabel(zonesById.get(r.roomId) ?? null)}"`)
check(
  `Furniture Inventory Room Type === Inventory Subcategory for every billed room (${typeDisagreements.length} disagreements)`,
  typeDisagreements.length === 0,
)
const receptionRow = model.furniture.find(
  (r) => (zonesById.get(r.roomId)?.label ?? '').toLowerCase().includes('reception'),
)
check(
  'a Reception room is NOT billed as a Kitchen',
  receptionRow == null || receptionRow.roomType === 'Reception',
)

// --- zone bucketing matches the core's rule ---------------------------------
// `zoneAtPoint` must return the MOST SPECIFIC containing zone, exactly as
// `Document::zone_index_at` does — not merely the first in emission order.
// Synthetic zones: a small room fully inside a plate-spanning workspace field,
// with the field emitted FIRST so a first-wins scan would swallow the room.
const nested = [
  { id: 1, zone_type: 'Circulation', label: 'Corridor', shape: { kind: 'Rect', x: 9, y: 6, w: 18, h: 12 }, component_ids: [] },
  { id: 2, zone_type: 'Workspace', label: 'Open Workspace', shape: { kind: 'Rect', x: 9, y: 6, w: 16, h: 10 }, component_ids: [] },
  { id: 3, zone_type: 'ClosedOffice', label: 'Cabin 1', shape: { kind: 'Rect', x: 4, y: 4, w: 3, h: 3 }, component_ids: [] },
]
check('zoneAtPoint picks the SMALLEST containing zone, not the first', zoneAtPoint(4, 4, nested)?.id === 3)
check('zoneAtPoint prefers a specific zone over Circulation', zoneAtPoint(14, 9, nested)?.id === 2)
check('zoneAtPoint falls back to Circulation when nothing else contains the point', zoneAtPoint(17.5, 11.5, nested)?.id === 1)
// Agreement with the core is now structural: every component the core bucketed
// into a zone must land in that same zone here.
const coreDisagreements = state.components.filter((c) => {
  const zone = (state.zones ?? []).find((z) => (z.component_ids ?? []).includes(c.id))
  if (!zone) return false
  return zoneAtPoint(c.x, c.y, state.zones ?? [])?.id !== zone.id
})
check(
  `zoneAtPoint agrees with the core's component bucketing for all ${state.components.length} components (${coreDisagreements.length} disagreements)`,
  coreDisagreements.length === 0,
)
check(
  'per-row total = qty × unit price',
  model.furniture.every((r) => Math.abs(r.totalPrice - r.quantity * r.unitPrice) < 1e-6),
)
const sumFurniture = model.furniture.reduce((n, r) => n + r.totalPrice, 0)
check('grand furniture total = Σ row totals', Math.abs(model.totals.furniture - sumFurniture) < 1e-6)
check('bound products contribute ₹ (furniture total > 0)', model.totals.furniture > 0)
check(
  'summary aggregates across rooms (Σ summary qty === Σ furniture qty)',
  model.summary.reduce((n, r) => n + r.quantity, 0) === model.totals.itemCount,
)
// --- the CORE's quantity surface (replaced takeoff.ts's own classification) --
const WALL_TYPES = ['Drywall', 'Half Drywall', 'Glass', 'Core', 'Perimeter windows', 'Perimeter wall']
check(
  'core reports all six wall types, legend order',
  qty.walls.length === 6 && qty.walls.every((w, i) => w.label === WALL_TYPES[i]),
)
const perimeter = qty.walls
  .filter((w) => w.label.startsWith('Perimeter'))
  .reduce((n, w) => n + w.lengthM, 0)
check(
  `perimeter run == the 18×12 plate perimeter (60 m), got ${perimeter.toFixed(2)}`,
  Math.abs(perimeter - 2 * (W + H)) < 0.01,
)
check(
  'no generated partition leaked into the perimeter buckets (drywall > 0)',
  (qty.walls.find((w) => w.label === 'Drywall')?.lengthM ?? 0) > 0,
)
check('every wall area == length × height', qty.walls.every((w) => Math.abs(w.areaM2 - w.lengthM * w.heightM) < 1e-9))
check('door count is exact', qty.doorCount === doorComps.length)
check(
  'every door lands in exactly one type bucket',
  qty.doors.reduce((n, d) => n + d.count, 0) === doorComps.length,
)
check('sqf factor is 10.764', Math.abs(qty.sqfPerM2 - 10.764) < 1e-12)

// --- the ground-truth arithmetic the workbook writes verbatim ---------------
check(
  'Area (sqf) == Area (m2) × 10.764 exactly, every room',
  qty.rooms.every((r) => Math.abs(r.areaSqf - r.areaM2 * qty.sqfPerM2) < 1e-9),
)
check('room ids are unique', new Set(qty.rooms.map((r) => r.roomId)).size === qty.rooms.length)
check(
  'Σ room area <= plate area',
  qty.rooms.reduce((n, r) => n + r.areaM2, 0) <= qty.floorAreaM2 + 1e-6,
)

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
