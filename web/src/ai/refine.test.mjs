// Node test for the autonomous-refinement PURE logic (no live API):
//   1. adjust_program response parse + clamp — valid applied, out-of-range
//      clamped, malformed ignored (→ no-op / null).
//   2. applyDelta + refScore (fixed-weight yardstick) behave.
//   3. Regenerate-variety: consecutive seed cursors yield DISJOINT seed windows
//      (seedWindowOffset, the single source autoGenerate uses).
//
// Run from web/:  node src/ai/refine.test.mjs
// Bundling mirrors suggestProgram.test.mjs (esbuild → esm → import). Works only
// because refine.ts / claudeDriver.ts import EditorCanvas types via `import
// type`, so nothing pulls the wasm module at runtime.

// @covers: web/src/ai/refine.ts
// @covers: web/src/editor/strategy.ts

import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

async function load(rel) {
  const out = path.join(os.tmpdir(), `ds-${path.basename(rel, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({ entryPoints: [path.join(here, rel)], outfile: out, bundle: true, format: 'esm', platform: 'node' })
  return import(pathToFileURL(out).href)
}

const { clampProgramDelta, parseAdjustProgram, applyDelta, refScore } = await load('refine.ts')
const { seedWindowOffset, STRATEGY_SEED_STRIDE, STRATEGIES } = await load('../editor/strategy.ts')

/* -------------------------------------------------------------------------- */
/* 1. clampProgramDelta — valid / out-of-range / malformed                    */
/* -------------------------------------------------------------------------- */

// (a) A valid delta is applied verbatim (within range).
const valid = clampProgramDelta({
  desks: 30,
  meeting_rooms: 4,
  target_corridor_m: 1.5,
  cluster_cols: 5,
  adjacency_emphasis: 0.4,
  circulation_emphasis: 0.35,
  rationale: 'Widen circulation and add desks to lift density.',
})
assert.deepEqual(
  { ...valid, rationale: undefined },
  {
    desks: 30,
    meeting_rooms: 4,
    target_corridor_m: 1.5,
    cluster_cols: 5,
    w_adjacency: 0.4,
    w_circulation: 0.35,
    rationale: undefined,
  },
  'valid delta applied verbatim',
)
assert.ok(valid.rationale?.startsWith('Widen'), 'rationale preserved')

// (b) Out-of-range values are CLAMPED to the sane bounds, not dropped.
const clamped = clampProgramDelta({
  desks: 9999, // → 400
  meeting_rooms: -5, // → 0
  target_corridor_m: 10, // → 3.0
  cluster_cols: 40, // → 8
  adjacency_emphasis: 2, // → 1
  circulation_emphasis: -1, // → 0
})
assert.equal(clamped.desks, 400, 'desks clamped to 400')
assert.equal(clamped.meeting_rooms, 0, 'meetings clamped to 0')
assert.equal(clamped.target_corridor_m, 3.0, 'corridor clamped to 3.0')
assert.equal(clamped.cluster_cols, 8, 'cluster_cols clamped to 8')
assert.equal(clamped.w_adjacency, 1, 'adjacency emphasis clamped to 1')
assert.equal(clamped.w_circulation, 0, 'circulation emphasis clamped to 0')

// (c) Malformed → ignored (dropped field), and an all-malformed / rationale-only
//     delta is a NO-OP (null) so the loop treats it as "converged".
const partial = clampProgramDelta({ desks: 'abc', meeting_rooms: 6 })
assert.equal(partial.desks, undefined, 'non-numeric desks dropped')
assert.equal(partial.meeting_rooms, 6, 'the valid sibling still applies')
assert.equal(clampProgramDelta({ desks: 'abc', foo: 1 }), null, 'all-malformed → null no-op')
assert.equal(clampProgramDelta({ rationale: 'looks good' }), null, 'rationale-only → null no-op')
assert.equal(clampProgramDelta({}), null, 'empty → null no-op')
assert.equal(clampProgramDelta(null), null, 'null input → null')
assert.equal(clampProgramDelta('nope'), null, 'non-object input → null')

/* -------------------------------------------------------------------------- */
/* 2. parseAdjustProgram — over Claude content blocks                         */
/* -------------------------------------------------------------------------- */

const toolBlocks = [
  { type: 'text', text: 'Sure, tightening circulation.' },
  { type: 'tool_use', name: 'adjust_program', input: { target_corridor_m: 1.4, rationale: 'ok' } },
]
const parsed = parseAdjustProgram(toolBlocks)
assert.equal(parsed.target_corridor_m, 1.4, 'tool_use input parsed + clamped')

assert.equal(parseAdjustProgram([{ type: 'text', text: 'no tool here' }]), null, 'no tool_use → null')
assert.equal(
  parseAdjustProgram([{ type: 'tool_use', name: 'something_else', input: { desks: 5 } }]),
  null,
  'wrong tool name → null',
)
assert.equal(parseAdjustProgram([]), null, 'empty blocks → null')
// A tool call whose input clamps down to nothing actionable → null (no-op).
assert.equal(
  parseAdjustProgram([{ type: 'tool_use', name: 'adjust_program', input: { rationale: 'no change' } }]),
  null,
  'rationale-only tool call → null no-op',
)

/* -------------------------------------------------------------------------- */
/* 3. applyDelta + refScore                                                   */
/* -------------------------------------------------------------------------- */

const program = {
  desks: 20,
  meeting_rooms: 2,
  target_corridor_m: 1.2,
  cluster_cols: 4,
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
  w_program: 0.1,
  w_daylight: 0.05,
  w_entry: 0.05,
}
const applied = applyDelta(program, { desks: 40, w_circulation: 0.5 })
assert.equal(applied.desks, 40, 'applyDelta sets desks')
assert.equal(applied.w_circulation, 0.5, 'applyDelta sets circulation weight')
assert.equal(applied.meeting_rooms, 2, 'untouched fields preserved')
assert.equal(program.desks, 20, 'applyDelta does not mutate the input')

// refScore is a normalized weighted mean of sub-scores; an all-80 plan scores 80
// regardless of the weight split (sanity), and a fixed rubric ranks a
// strictly-better plan higher even when the trial re-weighted.
const flat = { capacity: 80, adjacency: 80, circulation: 80, density: 80, program_fit: 80, daylight: 80, entry_adjacency: 80, total: 0, placed_desks: 20 }
assert.ok(Math.abs(refScore(flat, program) - 80) < 1e-9, 'flat 80 → yardstick 80')
const worse = { ...flat, circulation: 50 }
const better = { ...flat, circulation: 90 }
assert.ok(refScore(better, program) > refScore(worse, program), 'higher circulation → higher yardstick')

/* -------------------------------------------------------------------------- */
/* 4. Regenerate variety — consecutive cursors → DISJOINT seed windows        */
/* -------------------------------------------------------------------------- */

const MAX_ITER = 18
const WINDOW = 64 // GenerateCard's SEED_WINDOW (> maxIter, so windows are disjoint)

// The exact seed set autoGenerate explores for a given regenerate press `k`.
function seedSet(k) {
  const off = seedWindowOffset(k * WINDOW, MAX_ITER)
  const set = new Set()
  STRATEGIES.forEach((_s, si) => {
    for (let seed = 1; seed <= MAX_ITER; seed++) set.add(si * STRATEGY_SEED_STRIDE + off + seed)
  })
  return set
}

const s0 = seedSet(0)
const s1 = seedSet(1)
const s2 = seedSet(2)
const overlap = (a, b) => [...a].filter((x) => b.has(x)).length
assert.equal(overlap(s0, s1), 0, 'press 0 vs 1 seed windows are disjoint')
assert.equal(overlap(s1, s2), 0, 'press 1 vs 2 seed windows are disjoint')
assert.equal(overlap(s0, s2), 0, 'press 0 vs 2 seed windows are disjoint')
// Determinism: the SAME cursor reproduces the SAME window.
assert.equal(overlap(seedSet(1), seedSet(1)), s1.size, 'same cursor → identical window (deterministic)')

console.log(
  `PASS refine: clamp+parse (valid/clamped/malformed) · applyDelta+refScore · regenerate windows disjoint (${s0.size}/set)`,
)
