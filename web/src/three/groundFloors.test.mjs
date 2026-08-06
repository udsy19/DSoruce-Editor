// Ground zones take the NEUTRAL floor in 3D — Phase 2.4.
//
// Run from web/:  node src/three/groundFloors.test.mjs
// @covers: web/src/three/theme.ts
// @covers: web/src/three/Viewer3D.ts
//
// A zone-tinted carpet under circulation resurrects the fill the whole
// figure/ground rule removed from the 2D plan: walk the model and the corridors
// are a coloured floor again. The 2D and 3D views must agree about what is
// ground, or the plan and the walkthrough tell different stories about the same
// building.
//
// `floorByZone` KEEPS its keys — `ViewerToolbar` reads `floorByZone.Circulation`
// for its theme swatch, and deleting the key to change a material would break an
// unrelated consumer. The material assignment is what changes, not the table.

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'groundfloor-')), 'theme.mjs')
await build({
  entryPoints: [path.join(here, 'theme.ts')],
  outfile: out, bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', logLevel: 'silent',
})
const T = await import(pathToFileURL(out).href)

// (a) The ground set exists and is exactly the two ground types.
assert.ok(T.NEUTRAL_FLOOR_ZONES, 'theme.ts must export NEUTRAL_FLOOR_ZONES')
const ground = [...T.NEUTRAL_FLOOR_ZONES].sort()
assert.deepEqual(ground, ['Circulation', 'Unassigned'],
  `ground floor set is ${JSON.stringify(ground)} — must be exactly the two ground types`)

// (b) Every preset still carries every key, including the ground ones the
//     toolbar swatch reads. Changing a material must not delete a table entry.
const ids = Object.keys(T.THEMES)
assert.equal(ids.length, 4, `expected 4 theme presets, found ${ids.length}`)
const KEYS = ['Workspace', 'Meeting', 'Collaboration', 'Circulation', 'Unassigned', 'Core', 'ClosedOffice', 'Amenity']
for (const id of ids) {
  const t = T.THEMES[id]
  for (const k of KEYS) {
    assert.equal(typeof t.floorByZone[k], 'number',
      `${id}.floorByZone.${k} is missing — ViewerToolbar reads floorByZone.Circulation for its swatch`)
  }
  assert.equal(typeof t.floorBase, 'number', `${id}.floorBase missing — it is what ground falls back to`)
}

// (c) The VIEWER must actually consult the set. A set nobody reads is a
//     declaration, and this cycle has already shipped one of those.
const viewer = fs.readFileSync(path.join(here, 'Viewer3D.ts'), 'utf8')
assert.ok(/NEUTRAL_FLOOR_ZONES/.test(viewer),
  'Viewer3D.ts never references NEUTRAL_FLOOR_ZONES — ground would keep its zone-tinted carpet')

console.log(`PASS groundFloors: ${ids.length} presets keep all ${KEYS.length} keys; ground → neutral floor`)
