// KPI DIGEST — the acceptance instrument for C1's extraction.
// Same shape as R2's verdict digest, different artifact. Bootstrap copied from
// report.test.mjs so it exercises the real module graph.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const here = path.resolve(process.argv[2], 'src/export')
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const outFile = path.join(os.tmpdir(), `kpidigest-${Date.now()}.mjs`)
await build({
  stdin: {
    contents: `
      export { Editor, initSync } from '../wasm/ds_core'
      export { buildReportModel, computeWinners, normalizeRadar } from './report'
    `,
    resolveDir: here, loader: 'ts',
  },
  outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })
mod.initSync({ module: fs.readFileSync(wasmPath) })
const { Editor, buildReportModel, computeWinners, normalizeRadar } = mod

const PROGRAM = {
  desks: 24, meeting_rooms: 2, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25, w_density: 0.2,
}
const mk = (seed) => {
  const ed = new Editor()
  const C = [[0,0],[18,0],[18,12],[0,12]]
  for (let i = 0; i < 4; i++) ed.add_wall(C[i][0], C[i][1], C[(i+1)%4][0], C[(i+1)%4][1], 0.2)
  ed.generate(PROGRAM, BigInt(seed), false)
  return ed.snapshot()
}
const alts = [1,2,3].map((s) => ({ name: `Alt ${'ABC'[s-1]}`, snapshot: mk(s) }))
const model = buildReportModel(alts, { project: 'Digest', client: 'C' })
const q = (v) => (typeof v === 'number' ? v.toFixed(4) : JSON.stringify(v))
let rows = 0
for (const a of model.alternatives) {
  const keys = Object.keys(a).filter((k) => k !== 'snapshot').sort()
  console.log('KPI ' + keys.map((k) => `${k}=${q(a[k])}`).join(' '))
  rows += keys.length
}
console.log('KPI winners=' + JSON.stringify(computeWinners(model.alternatives)))
console.log('KPI radar=' + JSON.stringify(normalizeRadar(model).map((r) => r.map((v) => +v.toFixed(4)))))
assert.ok(rows >= 30, `only ${rows} KPI fields captured — the digest proves nothing`)
console.log(`KPI_ROWS ${rows}`)
