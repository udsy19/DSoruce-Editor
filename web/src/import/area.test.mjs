// Node test for the area-select filter (`restrictDrawing`, import/area.ts).
// Run from web/:  node src/import/area.test.mjs
//
// A synthetic 10×10 plate with a 10×10 grid of furniture (100 blocks) + a
// square wall ring. Asserts the workflow.md §3.1 contract:
//   • null / empty polygon         → identity (same object reference)
//   • whole-plate polygon          → keeps every block (count unchanged)
//   • left-half polygon            → keeps exactly the left-half blocks
// Bundling mirrors testfit.test.mjs (esbuild resolved through vite).

// @covers: web/src/import/area.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
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

const { restrictDrawing } = await bundle('area.ts')

// --- synthetic drawing ------------------------------------------------------
const mkFurniture = (id, cx, cy) => ({
  id,
  name: `d${id}`,
  raw: 'd',
  category: 'furniture',
  bbox: [cx - 0.3, cy - 0.3, cx + 0.3, cy + 0.3],
  origin: [cx, cy],
  rotation: 0,
  entities: [{ kind: 'polyline', layer: 'FURN', category: 'furniture', pts: [[cx - 0.3, cy - 0.3], [cx + 0.3, cy + 0.3]] }],
})

const furniture = []
let id = 1
// 10×10 grid of centers at 0.5, 1.5, … 9.5 → 5 columns are left of x=5.
for (let gx = 0; gx < 10; gx++) for (let gy = 0; gy < 10; gy++) furniture.push(mkFurniture(id++, gx + 0.5, gy + 0.5))

const entities = [
  { kind: 'polyline', layer: 'WALL', category: 'wall', closed: true, pts: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  { kind: 'text', layer: 'TEXT', category: 'annotation', text: 'LEFT', tx: 2, ty: 2, h: 0.3 },
  { kind: 'text', layer: 'TEXT', category: 'annotation', text: 'RIGHT', tx: 8, ty: 8, h: 0.3 },
]
const drawing = { units: 'm', bounds: [0, 0, 10, 10], layers: ['WALL', 'FURN'], entities, furniture }

// --- assertions -------------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

console.log('=== restrictDrawing report ===')
console.log(`furniture in:    ${drawing.furniture.length}`)

// (1) identity for null / empty polygon (same reference, untouched)
check('null polygon → identity (same ref)', restrictDrawing(drawing, null) === drawing)
check('empty polygon → identity (same ref)', restrictDrawing(drawing, []) === drawing)
check('2-vertex polygon → identity (same ref)', restrictDrawing(drawing, [[0, 0], [1, 1]]) === drawing)

// (2) whole-plate polygon keeps every block
const whole = restrictDrawing(drawing, [[-1, -1], [11, -1], [11, 11], [-1, 11]])
check('whole-plate keeps all furniture', whole.furniture.length === drawing.furniture.length)
check('whole-plate is a fresh object (non-destructive)', whole !== drawing)
check('original drawing untouched', drawing.furniture.length === 100)

// (3) left-half polygon (x ≤ 5) keeps exactly the 50 left-column blocks
const left = restrictDrawing(drawing, [[0, 0], [5, 0], [5, 10], [0, 10]])
console.log(`left-half kept:  ${left.furniture.length}`)
check('left-half keeps exactly half the furniture', left.furniture.length === 50)
check('all kept blocks lie in the left half', left.furniture.every((f) => (f.bbox[0] + f.bbox[2]) / 2 < 5))
// Entities keep if ANY sample is inside: the LEFT text (tx=2) survives, the
// RIGHT text (tx=8) drops, the boundary wall (a sample at x=0) is retained.
const texts = left.entities.filter((e) => e.kind === 'text').map((e) => e.text)
check('inside annotation kept (LEFT)', texts.includes('LEFT'))
check('outside annotation dropped (RIGHT)', !texts.includes('RIGHT'))
check('boundary wall straddling the cut is retained', left.entities.some((e) => e.category === 'wall'))
check('restricted bounds are a fresh recomputed array', left.bounds !== drawing.bounds)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
