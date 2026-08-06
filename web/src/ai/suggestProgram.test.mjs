// Node test for the fresh-fit program derivation (`suggestProgram`).
// Run from web/:  node src/ai/suggestProgram.test.mjs
//
// Guards deliverable 1 of the room-vs-desk rebalance: a fresh test-fit derives
// an OPEN-PLAN-DOMINANT program from the plate area / headcount with realistic
// room ratios — NOT inherited from the imported drawing's furniture clusters.
// The regression: the user's real building traced ~11 conference clusters, so
// the old code set meeting_rooms=11, which (with the derived support program)
// produced ~31 rooms against ~14 desks. Bundling mirrors dxf.test.mjs.

// @covers: web/src/ai/suggestProgram.ts

import path from 'node:path'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-suggestProgram-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'suggestProgram.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
})
const { suggestProgram } = await import(pathToFileURL(outFile).href)

// Minimal DEFAULT-like base program (only the fields suggestProgram spreads over).
const base = { desks: 20, meeting_rooms: 2, support_spaces: true }

// A furniture item that lands in a bank category via its name.
const item = (id, name) => ({
  id,
  name,
  raw: name,
  category: 'furniture',
  bbox: [0, 0, 1, 1],
  origin: [0, 0],
  rotation: 0,
  entities: [],
})

// The imported drawing that provoked the bug: ~11 conference-table clusters and
// only a handful of drawn workstations, on the real ~882 m² plate.
const conferenceHeavy = []
for (let i = 0; i < 33; i++) conferenceHeavy.push(item(i, `Conference Table ${i}`)) // ~11 clusters of 3
for (let i = 0; i < 14; i++) conferenceHeavy.push(item(100 + i, `Bench Workstation ${i}`))
const drawing = { units: 'm', bounds: [0, 0, 40, 22], layers: [], entities: [], furniture: conferenceHeavy }

// The core owns this (layout.rs `OPEN_SHARE`). Read it FROM the Rust source so
// this test fails the moment the two diverge — the previous arrangement was a TS
// copy plus a comment asserting it matched, which is how it drifted to 0.85.
// Path corrected 2026-08-06. `OPEN_SHARE` moved to `layout/program.rs` when the
// generator was split into submodules (c15451b); this kept reading `layout.rs`,
// the regex returned null, and the test CRASHED on `[1]` before asserting
// anything. It had been listed as a passing parity guard while guarding nothing
// — the same species as a vacuous invariant, and worse, because a crashing
// guard's history claims coverage it stopped providing.
const rustSrc = readFileSync(
  path.join(here, '../../../crates/ds-core/src/layout/program.rs'), 'utf8',
)
const OPEN_SHARE = Number(/pub const OPEN_SHARE: f64 = ([0-9.]+);/.exec(rustSrc)[1])
assert.ok(OPEN_SHARE > 0 && OPEN_SHARE <= 1, `OPEN_SHARE parsed from Rust: ${OPEN_SHARE}`)

// --- The real plate: ~882 m² -------------------------------------------------
const p = suggestProgram(drawing, 882, base, OPEN_SHARE)

// (a) Meetings are capped modest (~1 per 15–20 people), NOT the ~11 clusters.
assert.ok(p.meeting_rooms <= 6, `meetings ${p.meeting_rooms} not capped ≤ 6`)
assert.ok(p.meeting_rooms >= 2, `meetings ${p.meeting_rooms} below the floor`)
assert.ok(
  p.meeting_rooms < conferenceHeavy.filter((f) => /conference/i.test(f.name)).length / 3,
  'meetings must not track the drawing’s conference clusters',
)

// (b) Headcount is set to the plate at the professional density (~88 for 882 m²).
assert.ok(p.headcount >= 80 && p.headcount <= 96, `headcount ${p.headcount} off ~88`)

// (c) Desks scale to FILL the plate (open share of headcount, ~75), the majority
// use — never the sparse ~14 the old drawing carried.
assert.ok(p.desks >= 70, `desks ${p.desks} do not scale to fill the plate`)
assert.ok(p.desks > p.meeting_rooms * 5, 'the program must be open-desk-dominant')

// (d) A genuinely denser imported plan raises desks (floor), never lowers them.
const dense = { ...drawing, furniture: Array.from({ length: 160 }, (_, i) => item(i, `Bench ${i}`)) }
const pd = suggestProgram(dense, 882, base, OPEN_SHARE)
assert.equal(pd.desks, 160, 'a denser drawn plan is honoured as a desk floor')

// (e) Small plate still gets a sane minimum.
const small = suggestProgram({ ...drawing, furniture: [] }, 120, base, OPEN_SHARE)
assert.ok(small.meeting_rooms >= 2 && small.desks >= 10, 'small plate sane minimums')

console.log(
  `PASS suggestProgram: 882 m² → headcount ${p.headcount}, ${p.desks} desks, ${p.meeting_rooms} meetings`,
)
