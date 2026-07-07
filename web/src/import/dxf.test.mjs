// Node test for the DXF importer. Run from web/:  node src/import/dxf.test.mjs
//
// dxf.ts is TypeScript importing a bare specifier ('dxf-parser'), so we
// transpile it to a temp ESM bundle with esbuild (dxf-parser kept external,
// resolved from node_modules at runtime), then import + exercise it against
// the real furniture-plan sample.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const samplePath = path.resolve(here, '../../../samples/furniture-plan.dxf')

// esbuild is a nested (pnpm) dep of vite, not top-level. Resolve it through
// vite so this runs on a fresh `pnpm install` without extra deps.
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

// Bundle dxf.ts fully self-contained (dxf-parser included) so the temp output
// needs no runtime module resolution.
const outFile = path.join(os.tmpdir(), `ds-dxf-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dxf.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { parseDrawing } = await import(pathToFileURL(outFile).href)

const dxfText = fs.readFileSync(samplePath, 'utf8')
const t0 = Date.now()
const dwg = parseDrawing(dxfText)
const ms = Date.now() - t0

// --- report --------------------------------------------------------------
const [minX, minY, maxX, maxY] = dwg.bounds
const w = maxX - minX
const h = maxY - minY

const catHist = {}
const bump = (c) => (catHist[c] = (catHist[c] || 0) + 1)
for (const e of dwg.entities) bump(e.category)
for (const f of dwg.furniture) bump(`furniture-item:${f.category}`)

console.log('=== DXF import report ===')
console.log(`parse+build:      ${ms} ms`)
console.log(`units:            ${dwg.units}`)
console.log(`layers:           ${dwg.layers.length}`)
console.log(`entities:         ${dwg.entities.length}`)
console.log(`furniture items:  ${dwg.furniture.length}`)
console.log(`bounds (m):       [${dwg.bounds.map((v) => v.toFixed(2)).join(', ')}]`)
console.log(`size (m):         ${w.toFixed(2)} × ${h.toFixed(2)}`)

console.log('\n--- category histogram (entities + furniture items) ---')
for (const [c, n] of Object.entries(catHist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${c}`)
}

const wallPolys = dwg.entities.filter((e) => e.category === 'wall' && e.kind === 'polyline').length
console.log(`\nwall polylines in entities: ${wallPolys}`)

console.log('\n--- top 15 cleaned furniture names (by frequency) ---')
const nameHist = {}
for (const f of dwg.furniture) nameHist[f.name] = (nameHist[f.name] || 0) + 1
for (const [name, n] of Object.entries(nameHist)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)) {
  console.log(`  ${String(n).padStart(4)} ×  ${name}`)
}

// --- assertions ----------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

console.log('\n=== assertions ===')
check('furniture count in the hundreds (>=200)', dwg.furniture.length >= 200)
check('entities has wall polylines', wallPolys > 0)
check('bounds width 30–45 m', w >= 30 && w <= 45)
check('bounds height 30–45 m', h >= 30 && h <= 45)
check(
  'a furniture name contains SILQ / Task Chair / Workstation',
  dwg.furniture.some((f) => /SILQ|Task Chair|Workstation/i.test(f.name)),
)
check('every entity has a category', dwg.entities.every((e) => typeof e.category === 'string'))

fs.rmSync(outFile, { force: true })
if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
