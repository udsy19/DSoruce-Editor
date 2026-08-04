// The plate confidence ladder must keep separating good plates from guesses.
// Run from web/:  node src/import/plateQuality.test.mjs
//
// Runs the REAL extractPlate over the bench fixture set and asserts the verdict
// agrees with measured accuracy: every plate at IoU >= 0.95 is 'high', every
// plate below is 'low'. The thresholds in plateQuality.ts were calibrated
// against exactly this set (docs/adr/0002-plate-provenance.md), so this test is
// what stops them drifting — a tuning change that reintroduces a false 'high'
// fails here, and a false 'high' is the failure that silently propagates a wrong
// area into circulation, cost and the takeoff.

// @covers: web/src/import/plateQuality.ts
// @covers: web/src/import/testfit.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const FIX = path.join(ROOT, 'bench/fixtures')
if (!fs.existsSync(FIX)) {
  console.log('SKIP: bench/fixtures missing (run node bench/fixtures/generate.mjs)')
  process.exit(0)
}

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `pq-${path.basename(entry, '.ts')}-${process.pid}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const { extractPlate } = await bundle(path.join(ROOT, 'web/src/import/testfit.ts'))
const { assessPlate, PHANTOM_MAX_FOR_HIGH } = await bundle(path.join(ROOT, 'web/src/import/plateQuality.ts'))
const M = await bundle(path.join(ROOT, 'bench/metrics.ts'))

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

// --- the verdict must track measured accuracy -------------------------------
const ACCURATE_IOU = 0.95
let checked = 0
for (const f of fs.readdirSync(path.join(FIX, 'plate')).filter((n) => n.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '')
  const truthPath = path.join(FIX, 'truth', `${id}.geojson`)
  if (!fs.existsSync(truthPath)) continue
  const drawing = JSON.parse(fs.readFileSync(path.join(FIX, 'plate', f), 'utf8'))
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')).geometry.coordinates[0].slice(0, -1)
  const r = extractPlate(drawing)
  if (!r) { check(`${id}: produced a plate`, false); continue }
  if (!r.provenance) { check(`${id}: carries provenance`, false); continue }
  const ring = r.boundary.map(([x, y]) => [x + r.offset.x, y + r.offset.y])
  const iou = M.iou(ring, truth)
  const want = iou >= ACCURATE_IOU ? 'high' : 'low'
  check(
    `${id}: IoU ${iou.toFixed(3)} -> confidence '${want}'`,
    r.provenance.confidence === want,
    `got '${r.provenance.confidence}', phantom ${r.provenance.phantomFraction.toFixed(3)}`,
  )
  checked++
}
check('exercised the whole fixture set', checked >= 13, `${checked} fixtures`)

// --- the properties the ladder rests on -------------------------------------
{
  // A curved facade is legitimately non-orthogonal; gating on orthogonality
  // would reject a correct plate, which is why it is reported and not gated.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/curved-facade.json'), 'utf8'))
  const r = extractPlate(d)
  check('curved facade stays high-confidence despite low orthogonality',
    r.provenance.confidence === 'high' && r.provenance.orthogonality < 0.5,
    `orth ${r.provenance.orthogonality.toFixed(3)}`)
}
{
  // Rings are implicitly closed, so the closing edge is an ordinary edge and
  // must never be read as an error: a clean 30x20 rect reports a 20 m one.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/rect-clean.json'), 'utf8'))
  const r = extractPlate(d)
  check('clean rect: closing edge is a normal edge, not an error',
    r.provenance.closingEdgeM > 10 && r.provenance.confidence === 'high',
    `closingEdgeM ${r.provenance.closingEdgeM.toFixed(1)}`)
}
{
  // A user-traced plate is the ANSWER to low confidence, so it is trusted
  // unconditionally and needs no drawing to verify against.
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const p = assessPlate(square, null, 'user-traced')
  check('user-traced is trusted with no drawing', p.confidence === 'high' && p.reason === '')
  const guess = assessPlate(square, null, 'hull')
  check('an inferred plate with nothing to verify against is low', guess.confidence === 'low')
}
{
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/rect-no-shell-only-partitions.json'), 'utf8'))
  const r = extractPlate(d)
  check('low-confidence plates explain themselves',
    r.provenance.reason.includes('no wall beneath it'), r.provenance.reason)
}
check('threshold is the calibrated value', PHANTOM_MAX_FOR_HIGH === 0.15, PHANTOM_MAX_FOR_HIGH)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
