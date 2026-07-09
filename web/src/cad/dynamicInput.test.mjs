// Node test for the Dynamic Input math (doc §6.1 acceptance). Run from web/:
//   node src/cad/dynamicInput.test.mjs
//
// dynamicInput.ts is dependency-free (types-only import, erased at build), so we
// bundle it with esbuild (resolved through vite, same pattern as strategy.test.mjs)
// and assert the polar/resolve contract the drawing loop depends on.

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-dyninput-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dynamicInput.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
})
const { polarSnap, resolvePoint, parseTyped, bearingDeg, norm360, emptyDyn, dynEmpty } =
  await import(pathToFileURL(outFile).href)

const O = { x: 0, y: 0 }
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} (${a} ≈ ${b})`)
const nearPt = (p, x, y, eps = 1e-9, msg = '') => {
  near(p.x, x, eps, `${msg} x`)
  near(p.y, y, eps, `${msg} y`)
}

// (1) Ortho snap within tolerance: a near-horizontal drag snaps to exactly 0°.
{
  const to = { x: 5, y: 0.2 } // bearing ≈ 2.29° — inside the 8° default tol
  const r = polarSnap(O, to, { stepDeg: 90 })
  assert.equal(r.snapped, true, 'near-horizontal snaps')
  near(r.angleDeg, 0, 1e-9, 'snapped to 0°')
  near(r.point.y, 0, 1e-9, 'y flattened to axis')
  near(Math.hypot(r.point.x, r.point.y), Math.hypot(5, 0.2), 1e-9, 'length preserved')
}

// (2) 45° polar snap: a ~47° bearing snaps to exactly 45°.
{
  const a = 47 * (Math.PI / 180)
  const to = { x: Math.cos(a) * 3, y: Math.sin(a) * 3 }
  const r = polarSnap(O, to, { stepDeg: 45 })
  assert.equal(r.snapped, true, '47° within tol of 45°')
  near(r.angleDeg, 45, 1e-9, 'snapped to 45°')
  near(r.point.x, Math.cos(Math.PI / 4) * 3, 1e-9, '45° x')
  near(r.point.y, Math.sin(Math.PI / 4) * 3, 1e-9, '45° y')
}

// (3) No-snap passthrough: a clearly diagonal bearing is left untouched.
{
  const to = { x: 3, y: 1 } // ≈ 18.4°, > 8° from 0° and from any 90° multiple
  const r = polarSnap(O, to, { stepDeg: 90 })
  assert.equal(r.snapped, false, 'diagonal not snapped')
  nearPt(r.point, 3, 1, 1e-9, 'passthrough point')
  near(r.angleDeg, bearingDeg(O, to), 1e-9, 'raw bearing reported')
}

// (4) Distance-only: exact length along the (polar-snapped) cursor direction.
{
  const cursor = { x: 10, y: 0.1 } // ~0.57°, snaps to 0° under ortho
  const r = resolvePoint(O, cursor, { distance: 5, angleDeg: null }, { stepDeg: 90 })
  assert.equal(r.locked, true, 'distance locks')
  near(r.distance, 5, 1e-9, 'distance honored')
  near(r.angleDeg, 0, 1e-9, 'direction snapped to 0°')
  nearPt(r.point, 5, 0, 1e-9, 'point 5m along +x')
}

// (5) Angle-only: the cursor's distance placed along the locked angle.
{
  const cursor = { x: 3, y: 4 } // dist 5, off-axis
  const r = resolvePoint(O, cursor, { distance: null, angleDeg: 90 })
  assert.equal(r.locked, true, 'angle locks')
  near(r.distance, 5, 1e-9, 'cursor distance used')
  near(r.angleDeg, 90, 1e-9, 'locked to 90°')
  nearPt(r.point, 0, 5, 1e-9, 'point 5m along +y (world down)')
}

// (6) Both typed → exact point regardless of cursor.
{
  const r = resolvePoint(O, { x: 999, y: -999 }, { distance: 2, angleDeg: 180 })
  nearPt(r.point, -2, 0, 1e-12, 'exact 2m @180°')
  assert.equal(r.locked, true)
}

// (7) No-snap passthrough in resolvePoint: blank fields + no polar → raw cursor.
{
  const cursor = { x: 3, y: 1 }
  const r = resolvePoint(O, cursor, { distance: null, angleDeg: null })
  assert.equal(r.locked, false, 'nothing locked')
  nearPt(r.point, 3, 1, 1e-9, 'follows cursor exactly')
}

// (8) Shift-force-ortho semantics: a wide tolerance always snaps to nearest 90°.
{
  const to = { x: 1, y: 3 } // ~71.6°
  const r = polarSnap(O, to, { stepDeg: 90, tolDeg: 45 })
  assert.equal(r.snapped, true, 'forced ortho snaps')
  near(r.angleDeg, 90, 1e-9, 'nearest ortho is 90°')
}

// (9) parseTyped / helpers.
{
  assert.deepEqual(parseTyped({ active: 'distance', distance: '5.5', angle: '' }), {
    distance: 5.5,
    angleDeg: null,
  })
  assert.deepEqual(parseTyped({ active: 'angle', distance: '', angle: '-90' }), {
    distance: null,
    angleDeg: -90,
  })
  assert.deepEqual(parseTyped({ active: 'distance', distance: 'x', angle: '' }), {
    distance: null,
    angleDeg: null,
  })
  assert.equal(norm360(-90), 270, 'norm360 wraps negatives')
  assert.equal(dynEmpty(emptyDyn()), true, 'fresh state is empty')
}

// (10) A locked negative angle normalizes but still lands on the same ray.
{
  const r = resolvePoint(O, { x: 1, y: 1 }, { distance: 4, angleDeg: -90 })
  near(r.angleDeg, 270, 1e-9, 'angle normalized to [0,360)')
  nearPt(r.point, 0, -4, 1e-9, '-90°/270° is +... along -y')
}

console.log('dynamicInput.test.mjs — all assertions passed')
