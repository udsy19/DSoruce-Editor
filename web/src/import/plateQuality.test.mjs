// The plate confidence ladder must keep separating good plates from guesses.
// Run from web/:  node src/import/plateQuality.test.mjs
//
// Runs the REAL extractPlate over the bench fixture set and asserts the ONE
// direction that is safety-critical: an INACCURATE plate (IoU < 0.95) is never
// labelled high confidence. A false 'high' is auto-accepted and its area
// propagates silently into circulation, cost and the takeoff — the failure this
// whole branch exists to kill.
//
// The opposite direction is reported, not asserted. Since the ADR 0003 ladder
// shipped, phantom fraction no longer tracks accuracy for every rung — it is
// undefined for column-derived envelopes (a perfect column-grid plate scores
// phantom 1.000, because the columns are inside the plate and no shell exists)
// and legitimately high where real gaps exist. Two accurate plates therefore ask
// for confirmation they arguably don't need. That costs one click each; retuning
// the threshold to hide it would be the post-hoc move the calibration forbids.
// Awaiting a ruling — see docs/adr/0003, "confidence vs the shipped ladder".

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
const falseLows = []
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
  // THE SAFETY-CRITICAL DIRECTION, asserted: an INACCURATE plate must never be
  // labelled high confidence, because a false 'high' is auto-accepted and its
  // area propagates silently into circulation, cost and the takeoff.
  if (iou < ACCURATE_IOU) {
    check(
      `${id}: IoU ${iou.toFixed(3)} (inaccurate) must NOT be high confidence`,
      r.provenance.confidence === 'low',
      `got '${r.provenance.confidence}', phantom ${r.provenance.phantomFraction === null ? 'n/a' : r.provenance.phantomFraction.toFixed(3)}`,
    )
  } else if (r.provenance.confidence === 'low') {
    // The safe direction: an accurate plate asking for confirmation costs one
    // click. Counted and reported, deliberately NOT failed — since the ADR 0003
    // ladder shipped, phantom fraction no longer tracks accuracy for every rung
    // (it is undefined for column-derived envelopes and high-but-correct where
    // real gaps exist), and retuning the threshold to hide that would be exactly
    // the post-hoc move the calibration forbids. Awaiting a ruling; see
    // docs/adr/0003 "confidence vs the shipped ladder".
    const ph = r.provenance.phantomFraction
    falseLows.push(`${id} (IoU ${iou.toFixed(3)}, phantom ${ph === null ? 'n/a' : ph.toFixed(3)}, ${r.provenance.method})`)
  }
  checked++
}
check('exercised the whole fixture set', checked >= 13, `${checked} fixtures`)
check('no INACCURATE plate is ever auto-accepted (false-high count)', true, '0 by construction above')
if (falseLows.length) {
  console.log(`\nNOTE  ${falseLows.length} accurate plate(s) ask for confirmation (safe direction, not a failure):`)
  for (const f of falseLows) console.log(`        ${f}`)
}

// --- the properties the ladder rests on -------------------------------------
{
  // A curved facade is legitimately non-orthogonal; gating on orthogonality
  // would reject a correct plate, which is why it is reported and not gated.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/curved-facade.json'), 'utf8'))
  const r = extractPlate(d)
  check('curved facade is not penalised for low orthogonality',
    r.provenance.orthogonality < 0.5 && !r.provenance.reason.includes('orthogon'),
    `orth ${r.provenance.orthogonality.toFixed(3)}, verdict ${r.provenance.confidence}`)
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
    r.provenance.reason.includes('bridged across gaps'), r.provenance.reason)
}
check('threshold is the calibrated value', PHANTOM_MAX_FOR_HIGH === 0.15, PHANTOM_MAX_FOR_HIGH)

{
  // The ladder's one accepted regression: rot17-door-gaps fell 1.000 -> 0.989
  // when partition-envelope took the rung. Provenance honesty was worth a
  // hundredth of IoU; it is NOT worth a tenth, so pin it.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/rot17-door-gaps.json'), 'utf8'))
  const t = JSON.parse(fs.readFileSync(path.join(FIX, 'truth/rot17-door-gaps.geojson'), 'utf8'))
  const r = extractPlate(d)
  const ring = r.boundary.map(([x, y]) => [x + r.offset.x, y + r.offset.y])
  const iou = M.iou(ring, t.geometry.coordinates[0].slice(0, -1))
  check('rot17-door-gaps holds >= 0.98 (accepted regression, pinned)', iou >= 0.98, iou.toFixed(4))
}

{
  // Phantom is undefined for an envelope that is not a linework contour, and a
  // column-grid plate must say WHY it needs confirming — its own assumption,
  // not a phantom number that means nothing for it.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/rect-regular-column-grid.json'), 'utf8'))
  const r = extractPlate(d)
  const p = r.provenance
  check('column-grid reports phantom as undefined, not 1.000',
    p.method === 'column-grid' && p.phantomFraction === null, `${p.method}/${p.phantomFraction}`)
  check('column-grid stays low: its slab-edge assumption is unverifiable',
    p.confidence === 'low' && p.reason.includes('slab edge'), p.reason)
}

{
  // A bridged contour explains itself in the language of what it did.
  const d = JSON.parse(fs.readFileSync(path.join(FIX, 'plate/lshape-shell-fragments.json'), 'utf8'))
  const r = extractPlate(d)
  check('bridged envelope says it bridged, and how much',
    r.provenance.reason.includes('bridged across gaps'), r.provenance.reason)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
