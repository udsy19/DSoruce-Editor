// Node test for the M4 dimension-edit math (click-a-dimension-to-edit). Run from web/:
//   node src/cad/dimEdit.test.mjs
// dimEdit.ts is dependency-free (types-only import), so we bundle it with esbuild
// (same pattern as dynamicInput.test.mjs) and assert the length/format contract.

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-dimedit-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dimEdit.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
})
const { fmtMeters, parseDim, endpointForLength } = await import(pathToFileURL(outFile).href)

const near = (a, b, eps = 1e-9, msg = '') =>
  assert.ok(Math.abs(a - b) <= eps, `${msg} (${a} ≈ ${b})`)

// fmtMeters: meters, 2-dp, trailing unit.
assert.equal(fmtMeters(5), '5.00 m')
assert.equal(fmtMeters(1.234), '1.23 m')

// parseDim: blank / junk → null; finite → number.
assert.equal(parseDim(''), null)
assert.equal(parseDim('  '), null)
assert.equal(parseDim('abc'), null)
assert.equal(parseDim('3.5'), 3.5)
assert.equal(parseDim(' -2 '), -2)

// endpointForLength: retarget b along the a→b bearing, anchoring a.
{
  const a = { x: 1, y: 1 }
  const b = { x: 4, y: 1 } // bearing 0°, len 3
  const r = endpointForLength(a, b, 5)
  near(r.x, 6, 1e-9, 'horizontal length grows along +x')
  near(r.y, 1, 1e-9, 'y preserved')
}
{
  const a = { x: 0, y: 0 }
  const b = { x: 3, y: 4 } // len 5, bearing atan2(4,3)
  const r = endpointForLength(a, b, 10) // double the length, same bearing
  near(r.x, 6, 1e-9, 'diagonal x scales')
  near(r.y, 8, 1e-9, 'diagonal y scales')
  near(Math.hypot(r.x - a.x, r.y - a.y), 10, 1e-9, 'resulting length exact')
}
{
  // Degenerate (zero-length) → fall back to +x so a value still applies.
  const a = { x: 2, y: 2 }
  const r = endpointForLength(a, { ...a }, 4)
  near(r.x, 6, 1e-9, 'degenerate falls back to +x')
  near(r.y, 2, 1e-9, 'degenerate y = anchor y')
}
{
  // Negative length clamps to 0 (endpoint collapses onto the anchor).
  const a = { x: 1, y: 1 }
  const r = endpointForLength(a, { x: 5, y: 1 }, -3)
  near(r.x, 1, 1e-9, 'negative clamps to anchor')
  near(r.y, 1, 1e-9)
}

console.log('dimEdit.test.mjs: OK')
