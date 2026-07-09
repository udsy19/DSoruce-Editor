// Node test for the room-marker → ref → zone-label → takeoff Room ID chain
// (zoneAtPoint + buildTakeoffModel roomRefs, export/takeoff.ts).
// Run from web/:  node src/export/roomrefs.test.mjs
//
// Mirrors what App.tsx#buildRoomRefs does: a marker (editor coords) resolves to
// the zone whose rect contains it via zoneAtPoint; that { zone.id → ref } map is
// handed to buildTakeoffModel, which must then show the user ref (e.g. "502") in
// the Room ID column instead of the generated zone id. Bundling mirrors
// testfit.test.mjs (esbuild resolved through vite).

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

const { buildTakeoffModel, zoneAtPoint } = await bundle('takeoff.ts')

// --- synthetic document -----------------------------------------------------
// Two zones: an IT/Storage core (zone 7) and a pantry (zone 9). One desk sits
// in each. Markers (editor coords) drop 502 into zone 7 and 503 into zone 9.
const zones = [
  { id: 7, zone_type: 'Core', shape: { kind: 'Rect', x: 5, y: 5, w: 4, h: 4 }, label: 'Storage 7', component_ids: [] },
  { id: 9, zone_type: 'Amenity', shape: { kind: 'Rect', x: 15, y: 5, w: 4, h: 4 }, label: 'Pantry 9', component_ids: [] },
]
const comp = (id, x, y) => ({ id, category: 'Desk', x, y, w: 1.4, h: 0.7, rotation: 0, label: 'Desk', product_id: null, decision: 'Open' })
const state = { walls: [], components: [comp(1, 5, 5), comp(2, 15, 5)], zones, selection: null }

// Markers in EDITOR coords (as App.tsx stores them post-plate-offset).
const markers = [
  { ref: '502', x: 5, y: 5 },
  { ref: '503', x: 15, y: 5 },
]

// Replicate App.tsx#buildRoomRefs using the exported zoneAtPoint.
const buildRoomRefs = (zs, ms) => {
  const out = new Map()
  for (const m of ms) {
    const z = zoneAtPoint(m.x, m.y, zs)
    if (z && !out.has(z.id)) out.set(z.id, m.ref)
  }
  return out
}

// --- assertions -------------------------------------------------------------
let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

console.log('=== room-ref → takeoff Room ID report ===')

check('zoneAtPoint resolves marker 502 → zone 7', zoneAtPoint(5, 5, zones)?.id === 7)
check('zoneAtPoint resolves marker 503 → zone 9', zoneAtPoint(15, 5, zones)?.id === 9)
check('point outside every zone → null', zoneAtPoint(50, 50, zones) === null)

const roomRefs = buildRoomRefs(zones, markers)
check('roomRefs maps zone 7 → 502', roomRefs.get(7) === '502')
check('roomRefs maps zone 9 → 503', roomRefs.get(9) === '503')

// With roomRefs: Room ID shows the user ref.
const withRefs = buildTakeoffModel(state, { roomRefs })
const idsWith = withRefs.furniture.map((r) => String(r.roomId)).sort()
console.log(`Room IDs (with refs):    ${idsWith.join(', ')}`)
check('takeoff Room ID column shows 502', idsWith.includes('502'))
check('takeoff Room ID column shows 503', idsWith.includes('503'))

// Without roomRefs: Room ID falls back to the generated zone id (regression).
const without = buildTakeoffModel(state, {})
const idsWithout = without.furniture.map((r) => String(r.roomId)).sort()
console.log(`Room IDs (no refs):      ${idsWithout.join(', ')}`)
check('fallback Room ID is the zone id (7)', idsWithout.includes('7'))
check('fallback Room ID is the zone id (9)', idsWithout.includes('9'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
