// Node test for the M7 strategy contract the A/B/C gallery + autoGenerate loop
// depend on. Run from web/:  node src/editor/strategy.test.mjs
//
// `strategy.ts` is dependency-free (no wasm / three), so we bundle it with
// esbuild (resolved through vite, same as dxf.test.mjs) and assert the contract.
// The STRUCTURAL distinctness of the three plans is proven deterministically in
// the Rust suite (`strategies_are_structurally_distinct`); this guards the TS
// wiring: three distinct strategies, complete labels/blurbs, a stable A/B/C
// order, and disjoint per-strategy seed ranges so the search below never mints
// two candidates with the same (gallery-key) seed.

// @covers: web/src/editor/strategy.ts

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-strategy-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'strategy.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
})
const { STRATEGIES, STRATEGY_LABEL, STRATEGY_BLURB, STRATEGY_SEED_STRIDE } = await import(
  pathToFileURL(outFile).href
)

// (1) Exactly three distinct strategies, in the A/B/C order the gallery labels.
assert.deepEqual(STRATEGIES, ['Open', 'Balanced', 'Cellular'], 'three strategies, A/B/C order')
assert.equal(new Set(STRATEGIES).size, 3, 'strategies are distinct')

// (2) Every strategy has a non-empty label + blurb (the gallery/report render them).
for (const s of STRATEGIES) {
  assert.ok(STRATEGY_LABEL[s]?.length > 0, `label for ${s}`)
  assert.ok(STRATEGY_BLURB[s]?.length > 10, `blurb for ${s}`)
}
// Blurbs are distinct → the three cards read as genuinely different trade-offs.
assert.equal(new Set(STRATEGIES.map((s) => STRATEGY_BLURB[s])).size, 3, 'blurbs distinct')

// (3) The disjoint seed ranges autoGenerate uses (`strategyIndex·STRIDE + s`)
// never collide across strategies for any realistic search width — so a
// candidate's `seed` is a unique gallery key while (strategy, seed) still
// reproduces the exact plan. Simulate the widest search the UI runs.
const MAX_ITER = 18 + 3 * 8 // GenerateStep: maxIter grows with the regenerate round
const seeds = new Set()
STRATEGIES.forEach((_s, si) => {
  for (let s = 1; s <= MAX_ITER; s++) seeds.add(si * STRATEGY_SEED_STRIDE + s)
})
assert.equal(seeds.size, STRATEGIES.length * MAX_ITER, 'per-strategy seed ranges are disjoint')

console.log('OK strategy.test.mjs — 3 distinct strategies, complete labels/blurbs, disjoint seeds')
