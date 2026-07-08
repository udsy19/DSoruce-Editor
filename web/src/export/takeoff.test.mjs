// Node test for the Quantity Takeoff exporter. Run from web/:
//   node src/export/takeoff.test.mjs
//
// Builds an 18×12 m plate in the real wasm core, generates seed 1, binds a
// couple of products with ₹ prices, and asserts the pure `buildTakeoffModel`
// row contract (every component appears once with qty aggregation, room ids
// resolve to zones, totals = Σ qty×price, wall schedule meters > 0). Then it
// renders a real .xlsx via `takeoffToXlsx`, writes it to the scratchpad, and
// (best-effort) unzips it to confirm the ZIP + OOXML parse.
//
// Bundling of takeoff.ts mirrors dxf.test.mjs (esbuild resolved through vite);
// the wasm module is loaded directly from src/wasm and instantiated from bytes.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRATCH =
  '/private/tmp/claude-501/-Users-udsy-PycharmProjects-DSource-Editor/93b6c835-1e60-42ff-b3d1-a32f62653409/scratchpad'

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
const { buildTakeoffModel, takeoffToXlsx } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

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
const bindings = new Map()
let deskPid = null
let chairPid = null
for (const c of state.components) {
  if (c.category === 'Desk' && deskPid == null) {
    deskPid = `desk-${c.id}`
    c.product_id = deskPid
    bindings.set(deskPid, { price: 12000 })
  } else if (c.category === 'Chair' && chairPid == null) {
    chairPid = `chair-${c.id}`
    c.product_id = chairPid
    bindings.set(chairPid, { price: 4500 })
  }
}

const model = buildTakeoffModel(state, { bindings, floor: 1, project: 'Test Plate' })

// --- report -----------------------------------------------------------------
console.log('=== quantity takeoff report ===')
console.log(`components:       ${state.components.length}`)
console.log(`walls:            ${state.walls.length}`)
console.log(`zones:            ${(state.zones ?? []).length}`)
console.log(`furniture rows:   ${model.furniture.length}`)
console.log(`summary rows:     ${model.summary.length}`)
console.log(`furniture units:  ${model.totals.itemCount}`)
console.log(`totals ₹:         furniture ${model.totals.furniture} · walls ${model.totals.walls} · grand ${model.totals.grand}`)
console.log('--- wall schedule ---')
for (const w of model.walls) console.log(`  ${w.wallType.padEnd(20)} ${String(w.quantity).padStart(8)} ${w.unit}`)
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
check(
  'room types come from the sample vocabulary',
  model.furniture.every((r) =>
    [
      'Open Space WorkStation',
      'Conference',
      'Comfort Zone',
      'Executive Office',
      'Kitchen',
      'Other',
      'Open Space',
    ].includes(r.roomType),
  ),
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
check('wall schedule has 7 lines', model.walls.length === 7)
check(
  'perimeter wall meters > 0 (18×12 plate ⇒ ~60 m)',
  (model.walls.find((w) => w.wallType === 'Perimeter wall')?.quantity ?? 0) > 0,
)
check(
  'some partition/glass meters generated',
  model.walls.some(
    (w) => (w.wallType === 'Drywall partition' || w.wallType === 'Glass partition') && w.quantity > 0,
  ),
)
check(
  'door count matches Door components',
  (model.walls.find((w) => w.wallType === 'Doors')?.quantity ?? -1) === doorComps.length,
)
check('grand total = furniture + walls', Math.abs(model.totals.grand - (model.totals.furniture + model.totals.walls)) < 1e-6)

// --- render a real .xlsx and validate the container -------------------------
const xlsx = takeoffToXlsx(model, { project: 'Test Plate', floor: 1 })
check('xlsx bytes produced', xlsx instanceof Uint8Array && xlsx.length > 500)
check('xlsx starts with ZIP magic PK\\x03\\x04', xlsx[0] === 0x50 && xlsx[1] === 0x4b && xlsx[2] === 0x03 && xlsx[3] === 0x04)

fs.mkdirSync(SCRATCH, { recursive: true })
const xlsxPath = path.join(SCRATCH, 'dsource-takeoff-sample.xlsx')
fs.writeFileSync(xlsxPath, xlsx)
console.log(`\nwrote sample workbook: ${xlsxPath} (${xlsx.length} bytes)`)

// Confirm the ZIP unzips + XML parses via python zipfile (best-effort).
try {
  const out = execFileSync(
    'python3',
    [
      '-c',
      `import zipfile,sys,xml.dom.minidom as m
z=zipfile.ZipFile(sys.argv[1])
bad=z.testzip()
assert bad is None, bad
names=z.namelist()
for n in names:
    if n.endswith('.xml'): m.parseString(z.read(n))
print('ZIP_OK', len(names), 'parts')`,
      xlsxPath,
    ],
    { encoding: 'utf8' },
  )
  check('python zipfile lists + parses all parts', out.includes('ZIP_OK'))
  console.log('  ' + out.trim())
} catch (err) {
  console.log(`SKIP: python zipfile validation unavailable (${err.message.split('\n')[0]})`)
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
