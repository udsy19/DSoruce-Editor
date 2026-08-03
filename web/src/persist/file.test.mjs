// Node test for the `.dsource` program serialization contract — the Slice-5
// data-loss trap (workflow.md §3.4): `sanitizeProgram` must carry the explicit
// `rooms` array (Detailed builder) AND the desk type/size through save/open, not
// silently drop them like every non-scalar Program field before it.
// Run from web/:  node src/persist/file.test.mjs   (bundling mirrors dxf.test.mjs)

// @covers: web/src/persist/file.ts

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-file-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'file.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  // The wasm glue is imported (not called) by EditorCanvas at module top level;
  // stub it so the pure `sanitizeProgram`/`parseProject` bundle stays node-safe.
  external: [],
})
const { sanitizeProgram, parseProject } = await import(pathToFileURL(outFile).href)

// 1. rooms + placement + desk type/size round-trip through sanitizeProgram.
const raw = {
  desks: 34,
  meeting_rooms: 0,
  desk_w: 1.4,
  desk_h: 0.7,
  bench_pairs: true,
  support_spaces: false,
  headcount: 40,
  rooms: [
    { kind: 'Cabin', count: 4, w: 3.0, d: 3.3, placement: 'Window' },
    { kind: 'Meeting', count: 2, placement: 'Core' },
    { kind: 'Pantry', count: 1 },
  ],
}
const clean = sanitizeProgram(raw)
assert.equal(clean.rooms.length, 3, 'all three room reqs survive')
assert.equal(clean.rooms[0].kind, 'Cabin')
assert.equal(clean.rooms[0].count, 4)
assert.equal(clean.rooms[0].w, 3.0)
assert.equal(clean.rooms[0].placement, 'Window')
assert.equal(clean.rooms[1].placement, 'Core')
assert.equal(clean.rooms[2].placement, undefined, 'missing placement stays undefined (→ Rust Flexible)')
assert.equal(clean.desk_w, 1.4, 'desk size (w) survives')
assert.equal(clean.desk_h, 0.7, 'desk size (h) survives')
assert.equal(clean.bench_pairs, true, 'desk type (bench) survives')
assert.equal(clean.headcount, 40, 'headcount survives')

// 2. Malformed room entries are dropped, not fatal.
const partial = sanitizeProgram({ rooms: [{ kind: 'Nonsense', count: 2 }, { kind: 'Cabin' }, { kind: 'Focus', count: 3 }] })
assert.equal(partial.rooms.length, 1, 'only the well-formed room survives')
assert.equal(partial.rooms[0].kind, 'Focus')

// 3. A missing `rooms` (every pre-S5 file) → empty array, headcount → dropped.
const legacy = sanitizeProgram({ desks: 20, meeting_rooms: 2 })
assert.deepEqual(legacy.rooms, [], 'missing rooms → []')
assert.equal('headcount' in legacy, false, 'missing headcount is not injected')

// 4. Full .dsource round-trip: build a file blob, parse it, rooms intact.
const file = {
  format: 'dsource',
  version: 1,
  savedAt: new Date().toISOString(),
  snapshot: '{"ok":1}',
  program: raw,
}
const parsed = parseProject(JSON.stringify(file))
assert.equal(parsed.program.rooms.length, 3, 'rooms survive a full parseProject round-trip')
assert.equal(parsed.program.rooms[0].placement, 'Window')

console.log('file.test.mjs: OK — rooms + desk type/size + headcount survive save/open')
