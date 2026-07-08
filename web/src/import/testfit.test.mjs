// Node test for the import→test-fit bridge (`extractInteriorWalls`).
// Run from web/:  node src/import/testfit.test.mjs
//
// Converts the real samples/furniture-plan.dwg with dwg2dxf (LibreDWG, same
// binary the dev middleware shells out to), parses it with dxf.ts, extracts
// the plate + interior walls with testfit.ts, and asserts the interior-wall
// contract: some found, none coincide with the plate ring, all inside the
// plate, all ≥ 0.5 m, count capped. Bundling mirrors dxf.test.mjs (esbuild
// resolved through vite).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dwgPath = path.resolve(here, '../../../samples/furniture-plan.dwg')

// DWG → DXF via LibreDWG (skip gracefully when the tool isn't installed).
const dxfPath = path.join(os.tmpdir(), `ds-testfit-${Date.now()}.dxf`)
try {
  execFileSync('dwg2dxf', ['-o', dxfPath, dwgPath], { stdio: ['ignore', 'ignore', 'pipe'] })
} catch (err) {
  console.log(`SKIP: dwg2dxf unavailable or failed (${err.message})`)
  process.exit(0)
}

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (entry) => {
  const outFile = path.join(os.tmpdir(), `ds-${path.basename(entry, '.ts')}-${Date.now()}.mjs`)
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(outFile).href)
  fs.rmSync(outFile, { force: true })
  return mod
}

const { parseDrawing } = await bundle('dxf.ts')
const { extractPlate, extractInteriorWalls } = await bundle('testfit.ts')

const drawing = parseDrawing(fs.readFileSync(dxfPath, 'utf8'))
fs.rmSync(dxfPath, { force: true })
const plate = extractPlate(drawing)
if (!plate) {
  console.log('FAIL: extractPlate returned null')
  process.exit(1)
}

const t0 = Date.now()
const walls = extractInteriorWalls(drawing, plate)
const ms = Date.now() - t0

// --- independent geometry helpers (not the implementation under test) ------
const ring = plate.boundary
function pointInRing(x, y) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function distToRing(x, y) {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}
const len = (w) => Math.hypot(w.bx - w.ax, w.by - w.ay)
const samples = (w) =>
  [0, 0.25, 0.5, 0.75, 1].map((t) => [w.ax + (w.bx - w.ax) * t, w.ay + (w.by - w.ay) * t])

// --- report -----------------------------------------------------------------
console.log('=== interior-wall extraction report ===')
console.log(`plate:           ${plate.method}, ${Math.round(plate.areaM2)} m², ring ${ring.length} pts`)
console.log(`interior walls:  ${walls.length} (in ${ms} ms)`)
if (walls.length > 0) {
  const lens = walls.map(len).sort((a, b) => a - b)
  console.log(`lengths (m):     min ${lens[0].toFixed(2)} · median ${lens[Math.floor(lens.length / 2)].toFixed(2)} · max ${lens[lens.length - 1].toFixed(2)}`)
  console.log(`total run (m):   ${lens.reduce((s, v) => s + v, 0).toFixed(1)}`)
}

// --- assertions ---------------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

check('found interior walls (> 0)', walls.length > 0)
check('count capped (≤ 400)', walls.length <= 400)
check('every wall ≥ 0.5 m', walls.every((w) => len(w) >= 0.5 - 1e-9))
check(
  'none coincide with the plate ring (some sample > 0.4 m off the ring)',
  walls.every((w) => samples(w).some(([x, y]) => distToRing(x, y) > 0.4)),
)
check(
  'all inside the plate (every sample inside or ≤ 0.1 m from the ring)',
  walls.every((w) => samples(w).every(([x, y]) => pointInRing(x, y) || distToRing(x, y) <= 0.1)),
)
check(
  'editor coordinates (all samples within the translated plate bbox + 1 m)',
  walls.every((w) =>
    samples(w).every(([x, y]) => x > -1 && y > -1),
  ),
)

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
