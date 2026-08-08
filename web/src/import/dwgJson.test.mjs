// Node test for the LibreDWG-JSON → DXF transcoder (dwgJson.ts).
// Run from web/:  node src/import/dwgJson.test.mjs
//
// The transcoder is the fallback conversion path for the DWG files `dwg2dxf`
// cannot finish. Its correctness question is not "does it emit DXF" but "does
// it describe the SAME BUILDING the direct path describes".
//
// So the central assertion is a CROSS-PATH EQUIVALENCE check, on a file both
// paths can read: convert it with dwg2dxf, convert it again with
// `dwgread -O JSON` + this transcoder, run BOTH through the same parseDrawing,
// and require the two Drawings to agree on the things a floor plan is — units,
// extent, wall count, plate area.
//
// That is deliberately not a comparison against a stored expectation. Both
// sides are re-derived on every run from a real DWG by two independent
// LibreDWG front ends; a transcoder bug has to fool the direct path too in
// order to pass, which a stored golden could never demand.
//
// Structural cases below use hand-built JSON so they hold with no converter
// installed.

// @covers: web/src/import/dwgJson.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `ds-dj-${path.basename(entry, '.ts')}-${Date.now()}.mjs`)
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const m = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return m
}
const { dwgJsonToDxf } = await bundle('dwgJson.ts')
const { parseDrawing } = await bundle('dxf.ts')
const { verifyDxf } = await bundle('dwgVerify.ts')
const { extractPlate } = await bundle('testfit.ts')

let failed = 0
let checks = 0
const ok = (cond, label) => {
  checks++
  if (!cond) {
    failed++
    console.log(`FAIL: ${label}`)
  }
}

// ---------------------------------------------------------------------------
// Structural cases — hand-built JSON in LibreDWG's shape.
// ---------------------------------------------------------------------------

/** LibreDWG handles are [code, size, value, absref]; the id is the last item. */
const H = (n) => [5, 1, n, n]

const minimalJson = {
  HEADER: { INSUNITS: 6 },
  OBJECTS: [
    { object: 'LAYER', handle: [0, 1, 10], name: 'MURO' },
    { object: 'BLOCK_HEADER', handle: [0, 1, 20], name: '*Model_Space', entities: [H(31), H(32), H(33)] },
    { entity: 'LINE', handle: H(31), layer: H(10), start: [0, 0, 0], end: [20, 0, 0] },
    { entity: 'ARC', handle: H(32), layer: H(10), center: [5, 0, 0], radius: 2, start_angle: 0, end_angle: Math.PI / 2 },
    { entity: 'LWPOLYLINE', handle: H(33), layer: H(10), flag: 1, points: [[0, 0], [10, 0], [10, 10]] },
  ],
}

{
  const dxf = dwgJsonToDxf(minimalJson)
  ok(verifyDxf(dxf).ok, 'transcoded output is a structurally complete DXF')

  const d = parseDrawing(dxf)
  ok(d.units === 'm', `header INSUNITS survives the transcode (got '${d.units}')`)
  ok(d.layers.includes('MURO'), 'layer table is carried across, so categories still work')
  ok(
    d.entities.some((e) => e.category === 'wall'),
    'a MURO line arrives classified as wall, not dropped to `other`',
  )
  const line = d.entities.find((e) => e.kind === 'polyline' && e.pts?.length === 2)
  ok(line != null, 'the LINE survives')
  ok(
    line && Math.abs(line.pts[1][0] - 20) < 1e-6,
    `LINE endpoint is preserved exactly (got ${line?.pts?.[1]?.[0]})`,
  )
}

// Angles: LibreDWG JSON stores radians, DXF wants degrees. Getting this wrong
// silently rotates every door swing, which no structural check would notice.
{
  // Transcode the ARC alone, so the assertion measures the arc and nothing else.
  const arcOnly = {
    HEADER: { INSUNITS: 6 },
    OBJECTS: [
      { object: 'LAYER', handle: [0, 1, 10], name: 'MURO' },
      { object: 'BLOCK_HEADER', handle: [0, 1, 20], name: '*Model_Space', entities: [H(32)] },
      { entity: 'ARC', handle: H(32), layer: H(10), center: [5, 0, 0], radius: 2, start_angle: 0, end_angle: Math.PI / 2 },
    ],
  }
  const d = parseDrawing(dwgJsonToDxf(arcOnly))
  ok(d.entities.length > 0, 'the ARC survives the transcode')
  // A quarter-circle of radius 2 centred at (5,0) sweeps x in [5,7], y in [0,2].
  // Read as radians instead of degrees it would sweep 0->1.57 deg and stay a
  // near-flat sliver at y ~= 0.05, so this pins the unit conversion.
  const pts = d.entities.flatMap((e) => e.pts ?? [])
  const maxY = Math.max(...pts.map((p) => p[1]))
  const maxX = Math.max(...pts.map((p) => p[0]))
  ok(maxY > 1.9 && maxY < 2.1, `ARC swept 0->90 degrees, not 0->90 radians (max y ${maxY.toFixed(3)})`)
  ok(maxX > 6.9 && maxX < 7.1, `ARC centre + radius land correctly (max x ${maxX.toFixed(3)})`)
}

// A damaged block table must cost placement, never the geometry itself.
{
  const orphaned = {
    HEADER: { INSUNITS: 6 },
    OBJECTS: [
      { object: 'LAYER', handle: [0, 1, 10], name: 'MURO' },
      // No *Model_Space BLOCK_HEADER at all — the shape the crashing files have.
      { entity: 'LINE', handle: H(31), layer: H(10), start: [0, 0, 0], end: [20, 0, 0] },
      { entity: 'LINE', handle: H(32), layer: H(10), start: [20, 0, 0], end: [20, 12, 0] },
    ],
  }
  const d = parseDrawing(dwgJsonToDxf(orphaned))
  ok(d.entities.length === 2, `entities with no owner list are still emitted (got ${d.entities.length})`)
}

// Corrupt coordinates must be rejected where they enter, not left for a
// downstream heuristic to notice. This path exists to recover files whose DXF
// writer crashed, and those files are damaged: BUSNSS-Offcs-Trdtnl_AC.dwg
// yields LINE coordinates of 3.47e+115 in LibreDWG's own JSON.
{
  const corrupt = {
    HEADER: { INSUNITS: 6 },
    OBJECTS: [
      { object: 'LAYER', handle: [0, 1, 10], name: 'MURO' },
      { object: 'BLOCK_HEADER', handle: [0, 1, 20], name: '*Model_Space', entities: [H(31), H(32)] },
      { entity: 'LINE', handle: H(31), layer: H(10), start: [0, 0, 0], end: [20, 0, 0] },
      // The real shape of the corruption, verbatim from that file.
      { entity: 'LINE', handle: H(32), layer: H(10), start: [3.475664063979877e115, 0, 0], end: [3.4795447382161538e115, 0, 0] },
    ],
  }
  const d = parseDrawing(dwgJsonToDxf(corrupt))
  ok(d.entities.length === 1, `the corrupt line is dropped, the good one kept (got ${d.entities.length})`)
  const maxCoord = Math.max(...d.entities.flatMap((e) => e.pts ?? []).flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]))
  ok(maxCoord < 1e6, `bounds stay physical (max |coord| ${maxCoord.toExponential(2)})`)
}

// Degenerate input must not throw — a fallback that crashes is not a fallback.
for (const [label, input] of [
  ['null', null],
  ['empty object', {}],
  ['OBJECTS not an array', { OBJECTS: 'nope' }],
  ['entity with no coordinates', { OBJECTS: [{ entity: 'LINE', handle: H(1) }] }],
  ['entity with NaN coordinates', { OBJECTS: [{ entity: 'LINE', handle: H(1), start: [NaN, 0, 0], end: [1, 1, 0] }] }],
]) {
  checks++
  try {
    dwgJsonToDxf(input)
  } catch (e) {
    failed++
    console.log(`FAIL: transcoding ${label} threw: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// CROSS-PATH EQUIVALENCE — the real assertion.
// ---------------------------------------------------------------------------
const CORPUS = path.resolve(here, '../../../cad-validation/raw')
let haveTools = true
try {
  execFileSync('dwg2dxf', ['--version'], { stdio: 'ignore' })
  execFileSync('dwgread', ['--version'], { stdio: 'ignore' })
} catch {
  haveTools = false
}

const SUBJECT = path.join(CORPUS, 'fast-food-Restaurant.dwg')
if (haveTools && fs.existsSync(SUBJECT)) {
  const stamp = `${Date.now()}`
  const dxfPath = path.join(os.tmpdir(), `ds-dj-direct-${stamp}.dxf`)
  const jsonPath = path.join(os.tmpdir(), `ds-dj-json-${stamp}.json`)
  execFileSync('dwg2dxf', ['-o', dxfPath, SUBJECT], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 128 << 20 })
  execFileSync('dwgread', ['-O', 'JSON', '-o', jsonPath, SUBJECT], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 512 << 20 })

  const direct = parseDrawing(fs.readFileSync(dxfPath, 'utf8'))
  const viaJson = parseDrawing(dwgJsonToDxf(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))))
  fs.rmSync(dxfPath, { force: true })
  fs.rmSync(jsonPath, { force: true })

  ok(direct.units === viaJson.units, `both paths infer the same units (${direct.units} vs ${viaJson.units})`)

  const span = (d) => [d.bounds[2] - d.bounds[0], d.bounds[3] - d.bounds[1]]
  const [dw, dh] = span(direct)
  const [jw, jh] = span(viaJson)
  ok(Math.abs(dw - jw) < Math.max(0.5, dw * 0.02), `same width: ${dw.toFixed(2)} m vs ${jw.toFixed(2)} m`)
  ok(Math.abs(dh - jh) < Math.max(0.5, dh * 0.02), `same height: ${dh.toFixed(2)} m vs ${jh.toFixed(2)} m`)

  const walls = (d) => d.entities.filter((e) => e.category === 'wall').length
  const wd = walls(direct)
  const wj = walls(viaJson)
  ok(wd > 0, 'the subject drawing has walls to compare at all')
  ok(
    Math.abs(wd - wj) <= Math.max(5, wd * 0.1),
    `same wall count within 10%: ${wd} direct vs ${wj} via JSON`,
  )

  const pd = extractPlate(direct)
  const pj = extractPlate(viaJson)
  ok(pd != null && pj != null, 'both paths yield a floor plate')
  if (pd && pj) {
    ok(
      Math.abs(pd.areaM2 - pj.areaM2) < Math.max(5, pd.areaM2 * 0.05),
      `same plate area within 5%: ${pd.areaM2.toFixed(1)} m2 direct vs ${pj.areaM2.toFixed(1)} m2 via JSON`,
    )
  }
} else {
  console.log('(skipped cross-path equivalence: dwg2dxf/dwgread or cad-validation/raw absent)')
}

console.log(failed === 0 ? `PASS (${checks} checks)` : `FAIL (${checks} checks, ${failed} failing)`)
process.exit(failed === 0 ? 0 : 1)
