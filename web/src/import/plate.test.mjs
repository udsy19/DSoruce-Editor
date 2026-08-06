// Node test for the area-select plate math (`plateFromArea` / `clipToRect`). Run
// from web/:  node src/import/plate.test.mjs
// testfit.ts is dependency-free at runtime (types-only imports), so we bundle it
// with esbuild (same pattern as dimEdit.test.mjs) and assert the clip + area
// contract that makes a lassoed sub-area's plate match the selection.

// @covers: web/src/import/testfit.ts

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-plate-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'testfit.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { plateFromArea, plateSourceBounds, signedArea, tracePlate, PLATE_FAILURE_MESSAGE } =
  await import(pathToFileURL(outFile).href)

// Typed plate failures are asserted against real parsed drawings, so bundle the
// importer too rather than hand-building a Drawing (which could drift from what
// parseDrawing actually produces).
const dxfOut = path.join(os.tmpdir(), `ds-plate-dxf-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'dxf.ts')],
  outfile: dxfOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { parseDrawing } = await import(pathToFileURL(dxfOut).href)
fs.rmSync(dxfOut, { force: true })

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} (${a} ≈ ${b})`)
let pass = 0
const ok = (label, cond) => {
  assert.ok(cond, label)
  console.log('PASS ' + label)
  pass++
}

const BIG = [-1000, -1000, 1000, 1000] // bounds that clip nothing

// 1) An in-bounds rectangle polygon → plate area equals the polygon area exactly
//    (this is the core fix: a lasso over open floor no longer shrinks to a hull).
const rect = [[0, 0], [11, 0], [11, 8], [0, 8]] // 88 m²
const p1 = plateFromArea(rect, BIG)
ok('in-bounds rectangle → non-null plate', p1)
near(p1.areaM2, 88, 1e-6, 'area == polygon area')
ok('area == 88', Math.abs(p1.areaM2 - 88) < 1e-6)

// 2) Boundary is normalized so its min corner lands at the editor margin (≈1 m).
const minX = Math.min(...p1.boundary.map((q) => q[0]))
const minY = Math.min(...p1.boundary.map((q) => q[1]))
near(minX, 1, 1e-6, 'boundary minX at margin')
near(minY, 1, 1e-6, 'boundary minY at margin')
ok('boundary normalized to (1,1) margin', Math.abs(minX - 1) < 1e-6 && Math.abs(minY - 1) < 1e-6)

// 3) An over-drawn lasso is clipped to the building bounds (never spills past it).
const wide = [[-50, -50], [50, -50], [50, 50], [-50, 50]] // 10000 m² gesture
const bounds = [0, 0, 11, 8] // an 88 m² building bbox
const p2 = plateFromArea(wide, bounds)
ok('over-drawn lasso → non-null plate', p2)
near(p2.areaM2, 88, 1e-6, 'clipped to building bbox (88 m²)')
ok('over-drawn clipped to 88 m²', Math.abs(p2.areaM2 - 88) < 1e-6)

// 4) Degenerate selections return null (caller falls back to the hull tracer).
ok('< 3 vertices → null', plateFromArea([[0, 0], [1, 1]], BIG) === null)
ok('tiny (<4 m²) selection → null', plateFromArea([[0, 0], [1, 0], [1, 1], [0, 1]], BIG) === null)
ok('empty polygon → null', plateFromArea([], BIG) === null)

// 5) plateSourceBounds round-trips the offset back to source coords.
const sb = plateSourceBounds(p1)
near(sb[2] - sb[0], 11, 1e-6, 'source width preserved')
near(sb[3] - sb[1], 8, 1e-6, 'source height preserved')
ok('plateSourceBounds recovers 11×8 extent', Math.abs(sb[2] - sb[0] - 11) < 1e-6)

// sanity: signedArea magnitude matches
near(Math.abs(signedArea(rect)), 88, 1e-6, 'signedArea of rect')

console.log(`\nAll ${pass} assertions passed.`)

// ---------------------------------------------------------------------------
// Typed plate-failure reasons (F3).
//
// A bare `null` forced every caller to invent a message, and the one App.tsx
// invented — "No wall geometry found in this drawing" — was WRONG on 4 of the 6
// corpus files that reached it: they had plenty of wall geometry, it was just
// 1000x too small to clear the area floor. A failure that cannot name its stage
// sends the user to fix the wrong thing.
//
// Anchored to the distinction that matters: "no linework" and "linework at the
// wrong scale" must NOT report the same reason, because their fixes are
// opposite (check the layers vs. check the scale).
// ---------------------------------------------------------------------------
{
  const dxfOf = (ents) =>
    ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
     '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', '0', 'EOF'].join('\n')
  const box = (layer, w, h) => {
    const c = [[0, 0], [w, 0], [w, h], [0, h]]
    const out = []
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = c[i]
      const [bx, by] = c[(i + 1) % 4]
      out.push('0', 'LINE', '8', layer, '10', String(ax), '20', String(ay), '11', String(bx), '21', String(by))
    }
    return out
  }

  // (1) Nothing the shell tracer recognises — only furniture linework.
  {
    const d = parseDrawing(dxfOf(box('FURNITURE', 20, 12)))
    const o = tracePlate(d)
    ok('no shell linework -> no plate', !o.ok)
    ok(`reason is no-shell-geometry (got ${o.reason})`, o.reason === 'no-shell-geometry')
  }

  // (2) Real walls, but the whole building is under a square metre — the
  //     signature of a wrong scale, and it must NOT read as "no wall geometry".
  {
    const d = parseDrawing(dxfOf(box('WALL', 0.4, 0.3)))
    const o = tracePlate(d)
    ok('sub-square-metre building -> no plate', !o.ok)
    ok(
      `reason is regions-below-minimum, not no-shell-geometry (got ${o.reason})`,
      o.reason === 'regions-below-minimum',
    )
  }

  // (3) The two must be distinguishable — this is the whole point.
  {
    const a = tracePlate(parseDrawing(dxfOf(box('FURNITURE', 20, 12))))
    const b = tracePlate(parseDrawing(dxfOf(box('WALL', 0.4, 0.3))))
    ok('missing linework and wrong scale report different reasons', a.reason !== b.reason)
  }

  // (4) Every reason carries a message a user can act on.
  for (const r of ['no-shell-geometry', 'no-closed-region', 'regions-below-minimum']) {
    ok(
      `${r} has a user-facing message`,
      typeof PLATE_FAILURE_MESSAGE[r] === 'string' && PLATE_FAILURE_MESSAGE[r].length > 20,
    )
  }

  // (5) A real plate still reports ok, with the plate attached.
  {
    const o = tracePlate(parseDrawing(dxfOf(box('WALL', 20, 12))))
    ok('a real building still succeeds', o.ok)
    ok(`plate area is real (got ${o.plate?.areaM2})`, o.plate && o.plate.areaM2 > 100)
  }
}
