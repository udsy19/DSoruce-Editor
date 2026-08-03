// Node test for the Program-builder spec model (workflow.md §3.4 / Slice 5):
// templates + headcount derive a SANE starting spec, and `programSpecToProgram`
// resolves it to a core Program whose explicit `rooms` carry the right SpaceKind,
// count, placement, and desk type/size.
// Run from web/:  node src/program/spec.test.mjs

// @covers: web/src/program/spec.ts

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-spec-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'spec.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
})
const {
  TEMPLATES,
  specFromHeadcount,
  deriveCounts,
  programSpecToProgram,
  specTotals,
  defaultSpec,
} = await import(pathToFileURL(outFile).href)

// 1. Every template produces a sane, generatable spec.
for (const t of TEMPLATES) {
  const spec = specFromHeadcount(t.headcount, t.enclosedPct)
  const totals = specTotals(spec)
  assert.ok(spec.headcount === t.headcount, `${t.label}: headcount preserved`)
  assert.ok(totals.enclosedRooms >= 1, `${t.label}: at least one enclosed room`)
  assert.ok(totals.enclosedRooms < t.headcount, `${t.label}: enclosed rooms below headcount`)
  assert.ok((spec.counts['amenity-kitchen'] ?? 0) >= 1, `${t.label}: always a pantry`)
  // Bigger headcount → more enclosed rooms (monotone-ish sanity).
}
const small = specTotals(specFromHeadcount(15, 20)).enclosedRooms
const large = specTotals(specFromHeadcount(90, 30)).enclosedRooms
assert.ok(large > small, 'Large template has more enclosed rooms than Small')

// 2. Enclosed % drives the office count.
const lowEnclosed = deriveCounts(40, 10)
const highEnclosed = deriveCounts(40, 50)
const officesOf = (c) =>
  (c['office-exec'] ?? 0) + (c['office-large'] ?? 0) + (c['office-medium'] ?? 0) + (c['office-small'] ?? 0)
assert.ok(officesOf(highEnclosed) > officesOf(lowEnclosed), 'higher enclosed % → more private offices')

// 3. programSpecToProgram maps rooms + placement + desk type/size onto Program.
const spec = specFromHeadcount(40, 25)
spec.deskType = 'bench'
spec.deskSize = '140x70'
spec.placements = { offices: 'Window', team: 'Flexible', conference: 'Core' }
const prog = programSpecToProgram(spec)
assert.equal(prog.bench_pairs, true, 'bench desk type → bench_pairs')
assert.equal(prog.desk_w, 1.4, 'desk size w')
assert.equal(prog.desk_h, 0.7, 'desk size d')
assert.equal(prog.support_spaces, false, 'explicit rooms turn off the derived program')
assert.equal(prog.meeting_rooms, 0, 'meetings ride in rooms, not the override')
assert.ok(prog.headcount === 40, 'headcount carried so desks scale')
assert.ok(Array.isArray(prog.rooms) && prog.rooms.length >= 3, 'rooms emitted')
// Offices (Cabin) carry the Window placement; conference carries Core.
const cabins = prog.rooms.filter((r) => r.kind === 'Cabin')
assert.ok(cabins.length >= 1 && cabins.every((r) => r.placement === 'Window'), 'offices → Window bias')
const meetings = prog.rooms.filter((r) => r.kind === 'Meeting' || r.kind === 'Meeting4P' || r.kind === 'Meeting6P')
assert.ok(meetings.length >= 1, 'team/conference rooms present as meeting kinds')

// 4. Zero-count rooms are omitted from the Program.
const empty = programSpecToProgram({ ...spec, counts: {} })
assert.equal(empty.rooms.length, 0, 'no counts → no explicit rooms (falls back to derive at generate)')

// 5. defaultSpec prefills from a detected area.
const fromArea = defaultSpec(500)
assert.ok(fromArea.headcount >= 40 && fromArea.headcount <= 60, `500 m² → ~50 people (got ${fromArea.headcount})`)

console.log('spec.test.mjs: OK — templates, enclosed%, and programSpecToProgram all sane')
