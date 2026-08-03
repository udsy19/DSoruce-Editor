// End-to-end pricing test for the merge-into-plan stamp.
// Run from web/:  node src/import/mergePricing.test.mjs
//
// Drives the REAL wasm `Editor` (the Rust cost engine, cost::specified_cost =
// Σ component.price_inr) with the REAL `baseStampAround` output, applying the
// exact `assign_product` resolution that `App.stampBaseInto` uses:
//
//     if (c.productId)
//       ed.assign_product(id, c.productId, c.productName ?? c.label,
//                         bindings.get(c.productId)?.price ?? undefined)
//
// This pins the Rust cost engine's BINDING MATH on COUNTED (non-reference)
// components across the pricing edge cases: no bindings, all/partial, a productId
// absent from the bindings map (price → None, never NaN/0-double-count), the same
// product on several items (Σ, no under/over count), non-accumulation on a
// re-stamp, and the generated region's own bindings surviving the surroundings
// rebind.
//
// NOTE: the loop below omits `set_component_reference(id, true)` on purpose — the
// REAL `App.stampBaseInto` marks stamped surroundings `reference: true`, and since
// the reference fix those pieces contribute 0 to `specified_cost` (Laiout: legacy
// isn't purchased). That reference-path exclusion — and the three-surface
// agreement it guarantees — is covered end-to-end in
// `web/src/editor/referenceMetrics.test.mjs`. Here we deliberately isolate the
// non-reference binding arithmetic that `specified_cost` still performs on the
// generated/adopted content that DOES count.

// @covers: web/src/import/mergeFit.ts
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

// --- bundle the real merge stamp ---------------------------------------------
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
const { baseStampAround } = await bundle('mergeFit.ts')

// --- fixtures ----------------------------------------------------------------
let seq = 0
const mkItem = (name, productId, productName) => ({
  id: ++seq, name, raw: name, category: 'furniture',
  bbox: [seq * 5, 0, seq * 5 + 1.4, 0.7], origin: [seq * 5, 0], rotation: 0, entities: [],
  ...(productId ? { productId, productName } : {}),
})
const drawingOf = (furniture) => ({ units: 'm', bounds: [0, 0, 1000, 10], layers: [], entities: [], furniture })
const FAR = [[1e5, 1e5], [1e5 + 1, 1e5], [1e5 + 1, 1e5 + 1], [1e5, 1e5 + 1]] // keep all (outside)

// Verbatim mirror of App.stampBaseInto's stamping loop (the code under review).
function stampBaseInto(ed, comps, bindings) {
  for (const c of comps) {
    const id = ed.add_component(c.category, c.x, c.y, c.w, c.h)
    if (c.rotation) ed.set_component_rotation(id, c.rotation)
    if (c.productId) ed.assign_product(id, c.productId, c.productName ?? c.label, bindings.get(c.productId)?.price ?? undefined)
  }
  ed.clear_selection()
}
const compsFor = (furniture) => baseStampAround(drawingOf(furniture), FAR, { x: 0, y: 0 }).comps
const specCost = (ed) => ed.metrics().specified_cost

let failures = 0
const check = (label, cond, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (got ${got})`}`); if (!cond) failures++ }
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 1e-6

console.log('=== merge pricing: specified_cost across binding scenarios ===')

// 1) no bound items → 0
{
  const ed = new Editor()
  stampBaseInto(ed, compsFor([mkItem('SOFA'), mkItem('PLANTER')]), new Map())
  check('0 bound items → specified_cost 0', near(specCost(ed), 0), specCost(ed))
}

// 2) all bound → exact Σ of bank prices
{
  const bindings = new Map([['p1', { price: 1200 }], ['p2', { price: 3400 }]])
  const ed = new Editor()
  stampBaseInto(ed, compsFor([mkItem('CHAIR', 'p1', 'Task Chair'), mkItem('DESK', 'p2', 'Bench')]), bindings)
  check('all bound → Σ prices', near(specCost(ed), 4600), specCost(ed))
}

// 3) partial → only the bound item counts
{
  const bindings = new Map([['p1', { price: 1200 }]])
  const ed = new Editor()
  stampBaseInto(ed, compsFor([mkItem('CHAIR', 'p1', 'Task Chair'), mkItem('SOFA')]), bindings)
  check('partial bound → only bound item priced', near(specCost(ed), 1200), specCost(ed))
}

// 4) bound productId absent from the bindings map → price undefined → skipped,
//    never NaN and never a phantom 0-that-double-counts.
{
  const ed = new Editor()
  stampBaseInto(ed, compsFor([mkItem('CHAIR', 'ghost', 'Orphan')]), new Map())
  const c = specCost(ed)
  check('missing binding → finite specified_cost (no NaN)', Number.isFinite(c), c)
  check('missing binding → contributes 0 (skipped)', near(c, 0), c)
}

// 5) same product on several items → per-item Σ, no under/over count
{
  const bindings = new Map([['pX', { price: 900 }]])
  const ed = new Editor()
  stampBaseInto(ed, compsFor([
    mkItem('CHAIR', 'pX', 'Task Chair'), mkItem('CHAIR', 'pX', 'Task Chair'), mkItem('CHAIR', 'pX', 'Task Chair'),
  ]), bindings)
  check('same product ×3 → 3 × price (per physical item)', near(specCost(ed), 2700), specCost(ed))
}

// 6) a 0-price bound item is kept as 0 (nullish `?? undefined` preserves 0), not
//    dropped and not turned into undefined.
{
  const bindings = new Map([['free', { price: 0 }], ['paid', { price: 500 }]])
  const ed = new Editor()
  stampBaseInto(ed, compsFor([mkItem('CHAIR', 'free', 'Freebie'), mkItem('DESK', 'paid', 'Bench')]), bindings)
  check('0-price bound item keeps 0 (Σ = 500)', near(specCost(ed), 500), specCost(ed))
}

// 7) NON-ACCUMULATION. The merge flow restores the clean region snapshot before
//    each stamp (App: `applyCandidate(c.snap)` / `runGenerate` restores plateSnap),
//    so a regenerate never double-stamps. Prove the primitive: stamping the SAME
//    stamp into a FRESH document is deterministic (X every time) — while stamping
//    twice into the SAME doc would double it (which is exactly what the restore
//    guards against). Both are asserted so the guard's necessity is pinned.
{
  const bindings = new Map([['p1', { price: 1000 }]])
  const comps = compsFor([mkItem('CHAIR', 'p1', 'Task Chair')])
  const a = new Editor(); stampBaseInto(a, comps, bindings)
  const b = new Editor(); stampBaseInto(b, comps, bindings)
  check('re-merge into a fresh doc is deterministic (no drift)', near(specCost(a), 1000) && near(specCost(b), specCost(a)), `${specCost(a)}/${specCost(b)}`)
  const dbl = new Editor(); stampBaseInto(dbl, comps, bindings); stampBaseInto(dbl, comps, bindings)
  check('double-stamp into one doc WOULD accumulate (why the flow restores first)', near(specCost(dbl), 2000), specCost(dbl))
}

// 8) the GENERATED region's own bindings survive the surroundings rebind: the
//    stamp only assigns to the NEW ids it creates, never touching pre-existing
//    (generated) components.
{
  const bindings = new Map([['surr', { price: 700 }]])
  const ed = new Editor()
  // a pre-existing "generated" component with its own bank price
  const gen = ed.add_component('Desk', -50, -50, 1.4, 0.7)
  ed.assign_product(gen, 'genProd', 'Generated Desk', 4200)
  stampBaseInto(ed, compsFor([mkItem('CHAIR', 'surr', 'Task Chair')]), bindings)
  check('generated binding preserved through surroundings stamp (4200 + 700)', near(specCost(ed), 4900), specCost(ed))
}

// 9) assign_product is idempotent per id (overwrite, not accumulate) — the Rust
//    invariant the re-imagine + merge both rely on.
{
  const ed = new Editor()
  const id = ed.add_component('Chair', 0, 0, 0.5, 0.5)
  ed.assign_product(id, 'p', 'A', 100)
  ed.assign_product(id, 'p', 'A', 250)
  check('assign_product overwrites price (idempotent, not summed)', near(specCost(ed), 250), specCost(ed))
}

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1) }
console.log('\nAll merge-pricing assertions passed.')
