// The metrics card FORMATS; it never derives — and the average tick is a real
// per-batch mean.
//
// Run from web/:  node src/ui/metricsCard.test.mjs
// @covers: web/src/ui/MetricsCard.tsx
//
// Two failure modes this guards, both of which look fine on screen:
//   1. a metric recomputed here instead of read from `AltKpis` — a second
//      derivation that drifts from the PDF the client receives;
//   2. an "average" tick that is a constant. A benchmark that does not move when
//      the batch changes tells the user they beat a number nobody measured.

import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
// Bundle INSIDE web/ so the externalised `react` resolves from node_modules;
// a /tmp bundle cannot see it and dies with ERR_MODULE_NOT_FOUND.
const out = path.join(here, `.mcard-${process.pid}.mjs`)
await build({
  stdin: { contents: `export { batchMean } from './MetricsCard'`, resolveDir: here, loader: 'tsx' },
  outfile: out, bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', logLevel: 'silent', external: ['react'],
})
const { batchMean } = await import(pathToFileURL(out).href)
fs.rmSync(out, { force: true })

const mk = (d, p, e) => ({ daylightPct: d, privacyPct: p, efficiencyPct: e })
const batchA = [mk(40, 10, 60), mk(50, 20, 62), mk(60, 30, 64)]
assert.equal(batchMean(batchA, 'daylightPct'), 50)
assert.equal(batchMean(batchA, 'privacyPct'), 20)
assert.equal(batchMean(batchA, 'efficiencyPct'), 62)

const batchB = [mk(80, 70, 90), mk(90, 80, 92), mk(100, 90, 94)]
assert.notEqual(batchMean(batchB, 'daylightPct'), batchMean(batchA, 'daylightPct'),
  'the average tick did not move when the batch changed — it is a constant, not a benchmark')
assert.equal(batchMean(batchB, 'daylightPct'), 90)

assert.equal(batchMean([mk(50, 50, 50)], 'daylightPct'), null,
  'a single-plan batch must show NO tick: the mean of one is that one')
assert.equal(batchMean([], 'daylightPct'), null)

const src = fs.readFileSync(path.join(here, 'MetricsCard.tsx'), 'utf8')
for (const forbidden of ['Editor', 'zone_stats', 'from_snapshot', 'metrics()']) {
  assert.ok(!src.includes(forbidden),
    `MetricsCard reaches for ${forbidden} — it must FORMAT AltKpis, not derive metrics`)
}
assert.ok(/from '\.\.\/export\/kpis'/.test(src), 'MetricsCard must read its type from the shared KPI module')

console.log('PASS metricsCard: values formatted from AltKpis; the average tick is a live per-batch mean')
