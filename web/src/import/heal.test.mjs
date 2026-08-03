// Node test for wall healing (`healWalls`, import/heal.ts).
// Run from web/:  node src/import/heal.test.mjs
//
// Asserts the workflow.md §3.3 contract on synthetic near-miss geometry:
//   • a hairline COLLINEAR partition break closes (bridge added, loop traces)
//   • an L-CORNER that stops just short closes
//   • a T-JUNCTION (partition short of a corridor wall) closes
//   • a DOORWAY-size gap (≥ 0.8 m) is preserved even with a large gapM
//   • an already-clean drawing → identity (same object reference)
//   • the outer wall ring goes from OPEN (no traced loop) to CLOSED with heal
// Bundling mirrors area.test.mjs (esbuild resolved through vite).

// @covers: web/src/import/heal.ts
// @covers: web/src/import/testfit.ts

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

const { healWalls } = await bundle('heal.ts')
const { traceLoops, collectWallSegments } = await bundle('testfit.ts')

const wall = (pts) => ({ kind: 'polyline', layer: 'WALL', category: 'wall', pts })
const mkDrawing = (entities) => ({
  units: 'm',
  bounds: [0, 0, 10, 10],
  layers: ['WALL'],
  entities,
  furniture: [],
})

// Count wall bridge entities the heal added (HEAL layer).
const bridgeCount = (out) => out.entities.filter((e) => e.layer === 'HEAL').length
// Does any traced loop enclose ≳ the given area? (rooms actually closed)
const hasLoopArea = (drawing, minArea) => {
  const loops = traceLoops(collectWallSegments(drawing))
  const area = (r) => {
    let a = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++)
      a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1])
    return Math.abs(a / 2)
  }
  return loops.some((l) => area(l) >= minArea)
}

let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

console.log('=== healWalls report ===')

// (1) Collinear hairline break: one wall drawn as two segments with a 0.2 m gap
//     along y=0. The gap should be bridged.
{
  const d = mkDrawing([wall([[0, 0], [4.9, 0]]), wall([[5.1, 0], [10, 0]])])
  const out = healWalls(d)
  check('collinear 0.2 m break → 1 bridge', bridgeCount(out) === 1)
  check('collinear break: original untouched (non-destructive)', d.entities.length === 2)
}

// (2) A square room whose four walls each stop 0.2 m short of the corners
//     (L-corner near-misses). Heal should bridge all four so the room closes
//     into a traceable ~25 m² loop that the AS-DRAWN pass misses.
{
  const g = 0.1 // each wall ends 0.1 m before the corner → 0.2 m corner gaps
  const room = mkDrawing([
    wall([[g, 0], [5 - g, 0]]), // bottom
    wall([[5, g], [5, 5 - g]]), // right
    wall([[5 - g, 5], [g, 5]]), // top
    wall([[0, 5 - g], [0, g]]), // left
  ])
  check('as-drawn: open room does NOT trace a ~25 m² loop', !hasLoopArea(room, 20))
  const healed = healWalls(room)
  check('heal: 4 corner gaps bridged', bridgeCount(healed) === 4)
  check('heal: room now traces a ~25 m² closed loop', hasLoopArea(healed, 20))
}

// (3) T-junction: a partition stops 0.2 m short of a long corridor wall,
//     meeting it perpendicular. Heal should extend it to the wall.
{
  const d = mkDrawing([
    wall([[0, 0], [10, 0]]), // corridor wall along y=0
    wall([[5, 0.2], [5, 4]]), // partition rising from y=0.2 (0.2 m short)
  ])
  const out = healWalls(d)
  check('T-junction 0.2 m short → 1 bridge', bridgeCount(out) === 1)
}

// (4) Doorway guard: a 0.9 m collinear gap is a door opening — NOT bridged,
//     even when gapM is set well above it.
{
  const d = mkDrawing([wall([[0, 0], [4.55, 0]]), wall([[5.45, 0], [10, 0]])]) // 0.9 m gap
  check('doorway 0.9 m gap → no bridge (default gapM)', bridgeCount(healWalls(d)) === 0)
  check('doorway 0.9 m gap → no bridge (gapM 2.0, doorway guard holds)', bridgeCount(healWalls(d, { gapM: 2.0 })) === 0)
}

// (5) Already-clean geometry → identity (same object reference, no work).
{
  const clean = mkDrawing([wall([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])])
  check('clean drawing → identity (same ref)', healWalls(clean) === clean)
}

// (6) Non-collinear, non-perpendicular near-miss (two walls at ~45°) is left
//     alone — conservative, only genuine splits/corners/Ts heal.
{
  const d = mkDrawing([wall([[0, 0], [3, 0]]), wall([[3.15, 0.15], [6, 3]])]) // ~45°, 0.21 m gap
  check('45° near-miss → not bridged (conservative)', bridgeCount(healWalls(d)) === 0)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
