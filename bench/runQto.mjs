// Branch-2 runner.  node bench/runQto.mjs
//
// Scores every QuantityEngine against bench/fixtures/qto/truth.json. Gates come
// before scores (ADR 0004): a candidate failing accuracy, the cost-line
// invariant or determinism has no meaningful hierarchy number.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const truth = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/qto/truth.json'), 'utf8'))

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
let seq = 0
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `qtob-${process.pid}-${seq++}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

// Rehydrate the exact document the truth was taken from.
const wasmDir = path.join(ROOT, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const ed = wasm.Editor.from_snapshot(truth.snapshot)
const state = ed.state()

const bindings = truth.bindingRegression.bindings

const impls = []
for (const f of ['baseline.ts', 'qtoNative.ts']) {
  const mod = await bundle(path.join(here, 'adapters/qto', f))
  const impl = mod.default ?? Object.values(mod).find((v) => v && v.schedule)
  if (!impl) { console.log(`  ! ${f}: no QuantityEngine export`); continue }
  if (mod.setWasmHost) mod.setWasmHost(ed) // qto-native reads the live document
  impls.push(impl)
}

const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / b * 100)

function depth(node, d = 0) {
  if (!node?.children?.length) return d
  return Math.max(...node.children.map((c) => depth(c, d + 1)))
}
function rollupConsistent(node) {
  if (!node) return false
  const own = node.lines.reduce((s, l) => s + (l.totalInr ?? 0), 0)
  const kids = node.children.reduce((s, c) => s + c.subtotalInr, 0)
  const ok = Math.abs(node.subtotalInr - (own + kids)) < 0.01
  return ok && node.children.every(rollupConsistent)
}

const results = {}
for (const impl of impls) {
  const t0 = performance.now()
  let sched = null
  try { sched = await impl.schedule(state, bindings) } catch (e) {
    results[impl.meta.id] = { meta: impl.meta, ok: false, note: String(e.message ?? e).slice(0, 200) }
    continue
  }
  const ms = performance.now() - t0
  if (!sched) {
    results[impl.meta.id] = { meta: impl.meta, ok: false, note: 'returned null' }
    continue
  }

  // --- accuracy: PER-CATEGORY, over the categories this engine covers -------
  // Engines legitimately cover different sets — the incumbent excludes Door as
  // non-furniture, an IFC consumer includes walls — so a single total is not
  // comparable across them. Comparing totals was this runner's first metric and
  // it scored correct engines as failures; coverage is reported separately
  // instead of being folded into accuracy.
  const counted = {}
  for (const l of sched.allLines) {
    const key = l.category ?? 'Uncategorised'
    counted[key] = (counted[key] ?? 0) + l.quantity
  }
  const truthCats = truth.byCategory
  const shared = Object.keys(counted).filter((k) => k in truthCats)
  const perCategory = {}
  let worstErr = 0
  for (const k of shared) {
    const e = pct(counted[k], truthCats[k].count)
    perCategory[k] = { got: counted[k], want: truthCats[k].count, errPct: +e.toFixed(2) }
    worstErr = Math.max(worstErr, e)
  }
  const omitted = Object.keys(truthCats).filter((k) => !(k in counted))
  const extra = Object.keys(counted).filter((k) => !(k in truthCats))
  const totalItems = sched.itemCount
  const itemErrPct = shared.length ? +worstErr.toFixed(2) : Infinity

  // --- gate: cost-line invariant --------------------------------------------
  const pricedLines = sched.allLines.filter((l) => (l.totalInr ?? 0) > 0)
  const pricedSum = pricedLines.reduce((s, l) => s + (l.totalInr ?? 0), 0)
  const costLineOk =
    pricedLines.length >= 1 &&
    Math.abs(pricedSum - truth.bindingRegression.expectedSpecifiedCostInr) < 1

  // --- determinism -----------------------------------------------------------
  let det = true
  try {
    const again = await impl.schedule(state, bindings)
    det = JSON.stringify(again?.allLines ?? null) === JSON.stringify(sched.allLines)
  } catch { det = false }

  results[impl.meta.id] = {
    meta: impl.meta, ok: true,
    itemCount: totalItems,
    perCategory,
    categoriesCovered: shared,
    categoriesOmitted: omitted,
    categoriesExtra: extra,
    itemErrPct,
    accuracyGate: shared.length > 0 && itemErrPct < 1,
    pricedLineCount: pricedLines.length,
    pricedSumInr: Math.round(pricedSum),
    costLineGate: costLineOk,
    deterministic: det,
    hierarchical: sched.hierarchical,
    depth: depth(sched.root),
    rollupConsistent: rollupConsistent(sched.root),
    ms: +ms.toFixed(1),
    diagnostics: sched._diagnostics,
  }
}

fs.mkdirSync(path.join(here, 'results'), { recursive: true })
fs.writeFileSync(path.join(here, 'results/qto.json'), JSON.stringify({ truth: truth.source, results }, null, 2))

console.log(`\nBRANCH 2 — ${Object.keys(results).length} engines vs truth (${truthItems_()} components)\n`)
function truthItems_() { return truth.document.componentCount }
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('engine', 16) + pad('class', 12) + pad('GATES', 8) + pad('items', 8) + pad('err%', 7) + pad('priced', 8) + pad('Σ₹', 10) + pad('hier', 6) + pad('depth', 7) + pad('roll', 6) + 'ms')
console.log('-'.repeat(100))
for (const [id, r] of Object.entries(results)) {
  if (!r.ok) { console.log(pad(id, 16) + pad(r.meta.portability, 12) + 'FAILED  ' + r.note); continue }
  const gates = r.accuracyGate && r.costLineGate && r.deterministic ? 'pass' : 'FAIL'
  console.log(
    pad(id, 16) + pad(r.meta.portability, 12) + pad(gates, 8) + pad(r.itemCount, 8) +
    pad(r.itemErrPct, 7) + pad(r.pricedLineCount, 8) + pad(r.pricedSumInr, 10) +
    pad(r.hierarchical ? 'yes' : 'no', 6) + pad(r.depth, 7) + pad(r.rollupConsistent ? 'ok' : 'BAD', 6) + r.ms,
  )
}
console.log(`\ntruth: ${truth.document.componentCount} components · cost-line gate: ${truth.bindingRegression.expectedPricedLineCount} binds, Σ₹${truth.bindingRegression.expectedSpecifiedCostInr.toLocaleString('en-IN')}`)
for (const [id, r] of Object.entries(results)) {
  if (!r.ok) continue
  console.log(`\n${id}: per-category ${JSON.stringify(r.perCategory)}`)
  if (r.categoriesOmitted.length) console.log(`  omitted (by design, not an error): ${r.categoriesOmitted.join(', ')}`)
  if (r.categoriesExtra.length) console.log(`  extra beyond truth's components: ${r.categoriesExtra.join(', ')}`)
  if (r.diagnostics) console.log(`  diagnostics: ${JSON.stringify(r.diagnostics)}`)
}
