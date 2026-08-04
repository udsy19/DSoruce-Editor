// A plate's HONESTY must survive save → open.
// Run from web/:  node src/persist/plateRoundTrip.test.mjs
//
// The import path no longer asserts an inferred boundary as fact. Persistence
// can reintroduce exactly that bug: if `.dsource` drops the provenance, a
// low-confidence plate reopens presenting however the default presents —
// potentially as an unlabelled hard number. The feature is not shipped until the
// honesty round-trips.
//
// Both write paths (⌘S `saveProject` and the plan library `savePlan`) funnel
// through `buildProjectFile`, so one threading should cover both. This asserts
// that rather than assuming it.
//
// Also pins the calibration log's trust rule: it records humans only, and rows
// written before that rule existed are not evidence.

// @covers: web/src/persist/file.ts
// @covers: web/src/persist/plateLog.ts
// @covers: web/src/import/plateQuality.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const wasmDir = path.join(ROOT, 'web/src/wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('SKIP: web/src/wasm not built (run `make wasm`)')
  process.exit(0)
}

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
let seq = 0
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `rt-${process.pid}-${seq++}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const { buildProjectFile, applyProject } = await bundle(path.join(ROOT, 'web/src/persist/file.ts'))
const { assessPlate } = await bundle(path.join(ROOT, 'web/src/import/plateQuality.ts'))
const { isRealSession, PLATE_LOG_SCHEMA } = await bundle(path.join(ROOT, 'web/src/persist/plateLog.ts'))

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

// A stand-in for EditorCanvas carrying only what the persistence path touches.
// Using the real class would drag in a DOM canvas for no extra coverage here.
const fakeEc = (provenance) => ({
  plateProvenance: provenance,
  program: { desks: 20 },
  snapshot: () => '{"walls":[],"components":[],"zones":[],"selection":null,"next_id":1}',
  restore() {},
})

// A boundary that was INFERRED, not traced: a square with nothing beneath it.
const square = [[0, 0], [20, 0], [20, 14], [0, 14]]
const drawingWithNoShell = {
  units: 'm', bounds: [0, 0, 20, 14], layers: ['I-WALL'],
  entities: [{ kind: 'polyline', layer: 'I-WALL', category: 'wall', pts: [[5, 5], [8, 5]], closed: false }],
  furniture: [],
}

// --- 1. a LOW-confidence plate round-trips as low ----------------------------
{
  const prov = assessPlate(square, drawingWithNoShell, 'partition-envelope')
  check('the fixture plate really is low confidence', prov.confidence === 'low', prov.confidence)

  const file = buildProjectFile({ ec: fakeEc(prov) })
  check('save writes plateProvenance into the .dsource', Boolean(file.plateProvenance))

  // Through a real JSON round-trip, as a saved file would be.
  const reopened = JSON.parse(JSON.stringify(file))
  const ec2 = fakeEc(null)
  applyProject(ec2, reopened)

  check('open restores the confidence state', ec2.plateProvenance?.confidence === 'low',
    ec2.plateProvenance?.confidence)
  check('open restores the method', ec2.plateProvenance?.method === 'partition-envelope',
    ec2.plateProvenance?.method)
  check('open restores the reason shown to the user',
    typeof ec2.plateProvenance?.reason === 'string' && ec2.plateProvenance.reason.length > 0,
    ec2.plateProvenance?.reason?.slice(0, 60))
  // This is the approximate-area treatment surviving: the UI keys off
  // confidence === 'low', so a reopened plan still prints "≈".
  check('a reopened low plate still reads as approximate',
    ec2.plateProvenance?.confidence === 'low')
}

// --- 2. a CONFIRMED plate round-trips as trusted ------------------------------
{
  const prov = assessPlate(square, null, 'user-traced')
  check('a user-traced plate is high confidence', prov.confidence === 'high', prov.confidence)

  const file = buildProjectFile({ ec: fakeEc(prov) })
  const ec2 = fakeEc(null)
  applyProject(ec2, JSON.parse(JSON.stringify(file)))
  check('open restores user-traced/high, so the figure is hard again',
    ec2.plateProvenance?.method === 'user-traced' && ec2.plateProvenance?.confidence === 'high',
    `${ec2.plateProvenance?.method}/${ec2.plateProvenance?.confidence}`)
  check('a confirmed plate carries no confirm prompt', ec2.plateProvenance?.reason === '')
}

// --- 3. BOTH write paths carry it (they share buildProjectFile) ---------------
{
  const prov = assessPlate(square, drawingWithNoShell, 'hull')
  // savePlan (plan library) and saveProject (⌘S) both call buildProjectFile with
  // an `ec`; neither passes plateProvenance explicitly, so the canvas fallback is
  // what makes them agree. Assert the fallback, not the intent.
  const viaCanvasOnly = buildProjectFile({ ec: fakeEc(prov) })
  check('provenance rides along without either caller passing it explicitly',
    viaCanvasOnly.plateProvenance?.method === 'hull', viaCanvasOnly.plateProvenance?.method)

  const explicit = buildProjectFile({ ec: fakeEc(null), plateProvenance: prov })
  check('an explicit provenance is honoured too', explicit.plateProvenance?.method === 'hull')

  const neither = buildProjectFile({ ec: fakeEc(null) })
  check('no plate ⇒ no key (older readers unaffected)', neither.plateProvenance === undefined)
}

// --- 4. the calibration log records humans only -------------------------------
{
  // Node has no window: not a real session, so nothing is ever logged from here.
  check('a non-browser session is not calibration evidence', isRealSession() === false)
  check('the trust-rule version is set', PLATE_LOG_SCHEMA >= 2, PLATE_LOG_SCHEMA)
  // The E2E companion to this lives in the browser: driving the confirm flow with
  // an automation agent must leave the log's trusted-row count unchanged.
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
