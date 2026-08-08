// Node test for the layer/block category vocabulary (dxf.ts `categoryFor`).
// Run from web/:  node src/import/category.test.mjs
//
// Real-world CAD is not authored to AIA/NCS in English. The validation corpus
// in cad-validation/ found 13 of 21 parsed files classifying ≥ 70 % of their
// linework as `other` — and 4 at 100 % — because the vocabulary only knew
// English. With no entity classified `wall`, `collectWallSegments` returns
// empty and `extractPlate` has nothing to trace.
//
// This test asserts the PROPERTY ("a layer a human reads as a wall yields the
// wall category"), not the fix: every case below is a layer name observed in a
// real supplied drawing, listed with the file it came from. Cases are grouped
// so a regression names the language that broke.
//
// It deliberately also pins the NOISE cases. Trees, hatch patterns and cut
// lines are the "random elements" that wreck wall tracing — one corpus file
// carries 5 761 entities on `TREE J 1 100`, and hatch layers lay dense parallel
// linework exactly where a wall detector looks for wall faces. Classifying them
// as building fabric is as damaging as missing a real wall.

// @covers: web/src/import/dxf.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

// `categoryFor` is module-private; exercise it through the public parseDrawing
// by feeding a minimal DXF whose single LINE sits on the layer under test.
const outFile = path.join(os.tmpdir(), `ds-category-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dxf.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { parseDrawing } = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })

/** Smallest DXF that carries one LINE on `layer`. */
const dxfWithLayer = (layer) =>
  [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', layer, '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n')

const categoryOf = (layer) => {
  const d = parseDrawing(dxfWithLayer(layer))
  return d.entities[0]?.category ?? '(no entity)'
}

// [layer name, expected category, source file it was observed in]
const CASES = [
  // --- English / AIA — must not regress ---
  ['WALL 1 100', 'wall', 'BUSNSS-Offcs-Trdtnl_AG.dwg'],
  ['A-WALL', 'wall', 'BUSNSS-Offcs-Trdtnl_AH.dwg'],
  ['I-WALL', 'wall', 'BUSNSS-Offcs-Trdtnl_AB.dwg'],
  ['DOOR WINDOW 1 100', 'door', 'BUSNSS-Offcs-Trdtnl_AG.dwg'],
  ['A-GLAZ-CWMG', 'glazing', 'samples/furniture-plan.dwg'],
  ['FURNITURE F 1 100', 'furniture', 'BUSNSS-Offcs-Trdtnl_AG.dwg'],
  ['A-STAIR', 'wall', 'BUSNSS-Offcs-Trdtnl_AB.dwg'],
  ['COLU_C16', 'wall', 'fast-food-Restaurant.dwg'],

  // --- Spanish — 5 corpus files, previously 100 % `other` ---
  ['MURO-PROY', 'wall', 'call-center-offices.dwg'],
  ['MURO-NO SEC', 'wall', 'call-center-offices.dwg'],
  ['MURO-ACTUALES', 'wall', 'call-center-offices.dwg'],
  ['MUROS', 'wall', 'Apto.1404202.dwg'],
  ['Muro1', 'wall', 'Small-apto..dwg'],
  ['PUERTAS', 'door', 'muebles varios.dwg'],
  ['Puertas', 'door', 'Apartment-413201.dwg'],
  ['VENTANAS', 'glazing', 'call-center-offices.dwg'],
  ['Muebles', 'furniture', 'call-center-offices.dwg'],
  ['MOBILIARIO', 'furniture', 'MOBILIARIO HOSPITAL.dwg'],
  ['A. muebles', 'furniture', 'MOBILIARIO HOSPITAL.dwg'],
  ['10-MUEBLES', 'furniture', 'Apto.1404202.dwg'],
  ['MOB-FIJO', 'furniture', 'call-center-offices.dwg'],

  // --- Italian ---
  ['ARREDI', 'furniture', 'BUSNSS-Offcs-Trdtnl_AM.dwg'],

  // --- Transliterated (ru/id) ---
  ['MEBEL', 'furniture', 'BUSNSS-Offcs-Trdtnl_AI.dwg'],

  // --- Noise: decoration and drafting, NOT building fabric ---
  ['TREE J 1 100', 'annotation', 'BUSNSS-Offcs-Trdtnl_AL.dwg'],
  ['TREE I 1 100', 'annotation', 'BUSNSS-Offcs-Trdtnl_AG.dwg'],
  ['VEGETACION', 'annotation', 'muebles varios.dwg'],
  ['JARD0001', 'annotation', 'MOBILIARIO HOSPITAL.dwg'],
  ['HATCH K 1 150', 'annotation', 'BUSNSS-Offcs-Trdtnl_AB.dwg'],
  ['A-WALL-PATT', 'annotation', 'samples/furniture-plan.dwg'],
  ['Defpoints', 'annotation', 'BUSNSS-Offcs-Trdtnl_AG.dwg'],
  ['01-Text', 'annotation', 'BUSNSS-Offcs-Trdtnl_AB.dwg'],
  ['A-AREA-IDEN', 'annotation', 'samples/furniture-plan.dwg'],
  ['G-ANNO-TTLB', 'annotation', 'samples/furniture-plan.dwg'],
]

let failed = 0
let checks = 0
for (const [layer, expected, source] of CASES) {
  checks++
  const got = categoryOf(layer)
  if (got !== expected) {
    failed++
    console.log(`FAIL: layer ${JSON.stringify(layer)} → ${got}, expected ${expected}  (${source})`)
  }
}

// `A-WALL-PATT` must be annotation even though it contains WALL: hatch first.
// Assert the ordering property explicitly so a reordering of LAYER_VOCAB that
// happens to keep every case above passing still fails here.
checks++
if (categoryOf('A-WALL-PATT') === 'wall') {
  failed++
  console.log('FAIL: hatch pattern layer A-WALL-PATT classified as building fabric')
}

// An unknown layer must fall through to `other`, never guess.
checks++
if (categoryOf('ZZQQ-NOTHING') !== 'other') {
  failed++
  console.log('FAIL: unknown layer did not fall through to `other`')
}

console.log(failed === 0 ? `PASS (${checks} checks)` : `FAIL (${checks} checks, ${failed} failing)`)
process.exit(failed === 0 ? 0 : 1)
