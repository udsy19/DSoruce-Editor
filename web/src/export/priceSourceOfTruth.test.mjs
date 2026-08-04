// Price is CORE-AUTHORITATIVE, end to end.
// Run from web/:  node src/export/priceSourceOfTruth.test.mjs
//
// Price used to live in two places: the core's `price_inr` (written by
// `Editor.assign_product`) and the App-layer bindings map — and every cost-line
// constructor read the MAP. A component priced through the core was therefore
// unpriced in the takeoff unless a second, unenforced sync happened. That is the
// shape of the historical Track F bug (the re-imagine panel's binds never
// reaching the App map) and of the latent one the branch-2 bake-off surfaced.
//
// The decisive assertion is the one that would have caught BOTH: bind through
// the App-layer entry point, then build the takeoff with the bindings map
// DELIBERATELY EMPTY, and require the price to arrive anyway. If a cost line
// still needs the map, the second store is back.
//
// @covers: web/src/export/takeoff.ts
// @covers: crates/ds-core/src/lib.rs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const wasmDir = path.join(ROOT, 'web/src/wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('SKIP: web/src/wasm not built (run `make wasm`)')
  process.exit(0)
}

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const out = path.join(os.tmpdir(), `pst-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(ROOT, 'web/src/export/takeoff.ts')],
  outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
})
const { buildTakeoffModel } = await import(pathToFileURL(out).href)
fs.rmSync(out, { force: true })

const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

const PRICE = 24_750
function boundEditor() {
  const ed = new Editor()
  const box = [[0, 0], [12, 0], [12, 9], [0, 9]]
  for (let i = 0; i < box.length; i++) {
    const [ax, ay] = box[i]
    const [bx, by] = box[(i + 1) % box.length]
    ed.add_wall(ax, ay, bx, by, 0.15)
  }
  const id = ed.add_component('Desk', 3, 3, 1.6, 0.8)
  // The App-layer bind path (EditorCanvas.assignProduct delegates straight to
  // this), i.e. what the re-imagine panel triggers.
  ed.assign_product(id, 'bank-777', 'Re-imagined Desk', PRICE)
  return { ed, id }
}

// --- THE decisive case: no bindings map at all -------------------------------
{
  const { ed } = boundEditor()
  const state = ed.state()
  const comp = state.components.find((c) => c.product_id === 'bank-777')
  check('the core carries the price on the component', comp?.price_inr === PRICE, comp?.price_inr)

  // Bindings map deliberately EMPTY — the sync that used to be required is not
  // performed. A correct cost line does not need it.
  const model = buildTakeoffModel(state, { bindings: new Map() })
  const priced = model.furniture.filter((r) => r.unitPrice > 0)
  check('a cost line carries the price with NO bindings map',
    priced.length === 1 && priced[0].unitPrice === PRICE,
    `${priced.length} priced line(s), unitPrice ${priced[0]?.unitPrice}`)
  check('the total follows from it', priced[0]?.totalPrice === PRICE, priced[0]?.totalPrice)
}

// --- an out-of-sync map must not be able to override the core ----------------
{
  const { ed } = boundEditor()
  // A stale map claiming a different price — the exact drift the two-store
  // design allowed. The core wins.
  const stale = new Map([['bank-777', { price: 1, image: null, supplier: 'Stale Co' }]])
  const model = buildTakeoffModel(ed.state(), { bindings: stale })
  const priced = model.furniture.filter((r) => r.unitPrice > 0)
  check('a stale map cannot override the core price',
    priced[0]?.unitPrice === PRICE, priced[0]?.unitPrice)
  // Supplier legitimately still comes from the map: it is display metadata the
  // core does not model. That split is the point, not an oversight.
  check('supplier still comes from the map (display metadata, not money)',
    priced[0]?.supplier === 'Stale Co', priced[0]?.supplier)
}

// --- unpriced stays unpriced (0 is not a price) ------------------------------
{
  const ed = new Editor()
  ed.add_wall(0, 0, 10, 0, 0.15)
  const id = ed.add_component('Desk', 2, 2, 1.6, 0.8)
  ed.assign_product(id, 'bank-888', 'Unpriced Desk', undefined)
  const model = buildTakeoffModel(ed.state(), { bindings: new Map() })
  const priced = model.furniture.filter((r) => r.unitPrice > 0)
  check('a bound-but-unpriced product yields no priced line', priced.length === 0, priced.length)
}

// --- the price survives a snapshot round-trip --------------------------------
{
  const { ed } = boundEditor()
  const reopened = Editor.from_snapshot(ed.snapshot())
  const model = buildTakeoffModel(reopened.state(), { bindings: new Map() })
  const priced = model.furniture.filter((r) => r.unitPrice > 0)
  check('price survives snapshot -> restore with no map',
    priced[0]?.unitPrice === PRICE, priced[0]?.unitPrice)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
