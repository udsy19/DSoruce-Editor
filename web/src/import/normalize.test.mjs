// Node test for furniture normalization (normalize.ts).
// Run from web/:  node src/import/normalize.test.mjs
//
// Parses the real samples/furniture-plan.dwg (via LibreDWG's dwg2dxf, same as
// testfit.test.mjs) and asserts that imported vendor blocks collapse onto the
// canonical editor vocabulary: workstation benches → Desk, task/side/lounge
// chairs → Chair, conference/side tables → Table, real doors → Door, glazing →
// Window, and everything else → the neutral 'Furniture' symbol. Also asserts the
// size-snap contract (all Desks share one footprint, all Chairs one footprint)
// and that no block leaks through as raw geometry / an unknown category.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dwgPath = path.resolve(here, '../../../samples/furniture-plan.dwg')
const dxfSample = path.resolve(here, '../../../samples/furniture-plan.dxf')

// Prefer a pre-converted DXF (gitignored); else convert with LibreDWG.
let dxfText
if (fs.existsSync(dxfSample)) {
  dxfText = fs.readFileSync(dxfSample, 'utf8')
} else {
  const dxfPath = path.join(os.tmpdir(), `ds-normalize-${Date.now()}.dxf`)
  try {
    execFileSync('dwg2dxf', ['-o', dxfPath, dwgPath], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    console.log(`SKIP: dwg2dxf unavailable or failed (${err.message})`)
    process.exit(0)
  }
  dxfText = fs.readFileSync(dxfPath, 'utf8')
  fs.rmSync(dxfPath, { force: true })
}

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

const { parseDrawing } = await bundle('dxf.ts')
const { normalizeFurniture, inferCategory } = await bundle('normalize.ts')

const drawing = parseDrawing(dxfText)
const norms = drawing.furniture.map((f) => ({ f, n: normalizeFurniture(f) }))

// --- category distribution report -------------------------------------------
const dist = {}
for (const { n } of norms) dist[n.category] = (dist[n.category] ?? 0) + 1
console.log('=== normalized category distribution ===')
for (const [c, k] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  console.log(`${String(k).padStart(4)}  ${c}`)
}

const canonical = new Set(['Desk', 'Chair', 'Table', 'MeetingRoom', 'FallCeiling', 'Door', 'Window', 'Column', 'Furniture'])
const byName = (kw) => norms.filter(({ f }) => new RegExp(kw, 'i').test(`${f.name} ${f.raw}`))
const catOf = (kw) => new Set(byName(kw).map(({ n }) => n.category))

// --- assertions --------------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

check('every block maps to a canonical category (no raw / unknown)', norms.every(({ n }) => canonical.has(n.category)))
check('workstation benches → Desk', [...catOf('Workstations? BENCH')].every((c) => c === 'Desk') && byName('Workstations? BENCH').length > 0)
check('SILQ / task chairs → Chair', [...catOf('Task Chair')].every((c) => c === 'Chair') && byName('Task Chair').length > 0)
check('conference tables → Table', catOf('CONF TABLE').has('Table'))
check('club / lounge chairs → Chair', [...catOf('Club Chair|Lounge')].every((c) => c === 'Chair'))
check('cupboard "1 Door" casework is NOT a Door', byName('Cupbd').length > 0 && [...catOf('Cupbd')].every((c) => c !== 'Door'))

// Size-snap: all Desks share one footprint; all Chairs share one footprint.
const desks = norms.filter(({ n }) => n.category === 'Desk').map(({ n }) => n)
const chairs = norms.filter(({ n }) => n.category === 'Chair').map(({ n }) => n)
const areasEqual = (arr) => arr.every((n) => Math.abs(n.w * n.h - arr[0].w * arr[0].h) < 1e-6)
check('all Desks snapped to one canonical footprint (area)', desks.length > 0 && areasEqual(desks))
check('all Chairs snapped to one canonical footprint', chairs.length > 0 && chairs.every((n) => Math.abs(n.w - chairs[0].w) < 1e-6 && Math.abs(n.h - chairs[0].h) < 1e-6))
check('chair footprint is the catalog 0.5 × 0.5', chairs.length > 0 && Math.abs(chairs[0].w - 0.5) < 1e-6 && Math.abs(chairs[0].h - 0.5) < 1e-6)

// Tables keep varied real footprints (a boardroom must not equal a side table).
const tables = norms.filter(({ n }) => n.category === 'Table').map(({ n }) => n)
check('tables keep varied footprints (not all snapped equal)', tables.length < 2 || !areasEqual(tables))

// Labels + bindings carried through.
check('every normalized component carries a non-empty label', norms.every(({ n }) => typeof n.label === 'string' && n.label.length > 0))

// inferCategory is the pure decision function.
check('inferCategory agrees with normalizeFurniture', norms.every(({ f, n }) => inferCategory(f) === n.category))

// --- rotation / orientation recovery -----------------------------------------
// A directional symbol (Desk monitor/chair, Chair backrest) must FACE the way the
// source block did. normalize encodes that in `rotation`; the imported canvas
// un-swaps the aspect-baked w/h back to natural and rotates by it. Two invariants
// keep that exact and mergeFit-safe (mergeFit ignores rotation, stamps upright):
const HALF_PI = Math.PI / 2
const quarterTurns = (rot) => (((Math.round(rot / HALF_PI) % 4) + 4) % 4)
const isCardinal = (rot) => Math.abs(rot - quarterTurns(rot) * HALF_PI) < 1e-9

// (1) every rotation is a finite cardinal multiple of 90°.
check('every rotation is a cardinal (0/90/180/270) angle', norms.every(({ n }) => Number.isFinite(n.rotation) && isCardinal(n.rotation)))

// (2) PARITY: a Desk's rotation quarter-turn parity matches its footprint aspect
//     (portrait ⟺ odd), so the canvas un-swap `odd ? [h,w] : [w,h]` reproduces the
//     exact aspect-baked w/h — no double-rotation, no footprint drift.
const deskItems = norms.filter(({ n }) => n.category === 'Desk')
check('Desk rotation parity matches footprint aspect (un-swap is exact)', deskItems.every(({ n }) => {
  const odd = quarterTurns(n.rotation) % 2 === 1
  const portrait = n.h > n.w
  // reconstruct the on-screen extent from natural + rotation; must equal w/h.
  const nw = odd ? n.h : n.w
  const nh = odd ? n.w : n.h
  const ew = odd ? nh : nw
  const eh = odd ? nw : nh
  return odd === portrait && Math.abs(ew - n.w) < 1e-9 && Math.abs(eh - n.h) < 1e-9
}))

// (3) the fix actually turns rotated desks: the real plan has 180°/270° benches, so
//     a healthy fraction of desks must carry a non-zero rotation (else it's a no-op).
const turnedDesks = deskItems.filter(({ n }) => quarterTurns(n.rotation) !== 0).length
check('rotated source desks recover a non-zero orientation', turnedDesks > 0 && deskItems.length > turnedDesks)

// (4) non-directional pieces stay upright (Table/Door/Window/Furniture → rotation 0).
check('non-directional categories carry rotation 0', norms.every(({ n }) => ['Desk', 'Chair'].includes(n.category) || n.rotation === 0))

// (5) SYNTHETIC pure contract: fabricate desks at each cardinal authored angle and
//     assert the recovered orientation — independent of the sample DWG. A landscape
//     block flips 0↔180; a portrait block turns 90↔270.
const mkDesk = (bw, bh, rotDeg) => ({
  id: 1, name: 'WORKSTATION', raw: 'WORKSTATION', category: 'furniture',
  bbox: [0, 0, bw, bh], origin: [bw / 2, bh / 2], rotation: (rotDeg * Math.PI) / 180, entities: [],
})
const synth = [
  [mkDesk(1.5, 0.7, 0), 0], // landscape, upright
  [mkDesk(1.5, 0.7, 180), 180], // landscape, flipped (monitor to the opposite edge)
  [mkDesk(0.7, 1.5, 90), 90], // portrait, quarter-turned
  [mkDesk(0.7, 1.5, 270), 270], // portrait, three-quarter-turned
  [mkDesk(0.7, 1.5, -90), 270], // negative angles normalize (−90 ≡ 270), portrait bbox
]
check('synthetic desk orientations recover the authored cardinal angle', synth.every(([item, deg]) => {
  const n = normalizeFurniture(item)
  return Math.round((((n.rotation * 180) / Math.PI) % 360 + 360) % 360) === deg
}))

// (6) ROBUSTNESS: degenerate / NaN / negative dims never crash or emit non-finite
//     footprints (the canvas guards `w>0 && h>0`, but normalize must not throw).
const degenerate = [
  mkDesk(0, 0, 0), mkDesk(-1, 0.7, 90), mkDesk(NaN, 0.7, 0),
  { id: 2, name: 'Mystery Object', raw: 'MYSTERY', category: 'furniture', bbox: [0, 0, 0, 0], origin: [0, 0], rotation: NaN, entities: [] },
]
check('degenerate/NaN items normalize without throwing and yield finite rotation', degenerate.every((item) => {
  try {
    const n = normalizeFurniture(item)
    return Number.isFinite(n.rotation)
  } catch {
    return false
  }
}))

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
