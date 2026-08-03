// The `state()` memo contract: fast when nothing changed, NEVER stale.
// Run from web/:  node src/editor/stateCache.test.mjs
//
// EditorCanvas.getState() caches the deserialized document and reuses it while
// `Editor.revision()` is unchanged, because every read serializes the WHOLE
// document across the wasm boundary and one frame does it many times. That is
// only sound if the counter is airtight, so this drives the REAL wasm Editor and
// asserts the properties the cache depends on:
//
//   INV1  revision() is stable across reads (state/metrics/zone_stats/circulation)
//   INV2  every mutator advances it — including generate() and restore()
//   INV3  equal revision => byte-identical state(), so a cache hit cannot differ
//         from a fresh read
//   INV4  a fresh Editor restarts at 0, which is why the cache must key on the
//         editor INSTANCE too (clearAll swaps one in)
//   INV5  the memo, replicated here exactly as EditorCanvas implements it, never
//         serves a stale document across a mutate → read → mutate → read cycle
//
// Rust-side companion: tests::every_mutator_bumps_the_revision in lib.rs scans
// the source so a NEW mutator cannot forget the bump.

// @covers: web/src/editor/EditorCanvas.ts
// @covers: crates/ds-core/src/lib.rs

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmDir = path.join(here, '../wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('SKIP: web/src/wasm not built (run `make wasm`)')
  process.exit(0)
}

const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (got ${got})`}`)
  if (!cond) failures++
}

const PROGRAM = {
  desks: 20, meeting_rooms: 2, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  support_spaces: true, rooms: [], w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25,
  w_density: 0.2, w_program: 0.1, w_daylight: 0.05, w_entry: 0.05,
}

function plate() {
  const ed = new Editor()
  const box = [[0, 0], [30, 0], [30, 20], [0, 20]]
  for (let i = 0; i < box.length; i++) {
    const [ax, ay] = box[i]
    const [bx, by] = box[(i + 1) % box.length]
    ed.add_wall(ax, ay, bx, by, 0.1)
  }
  return ed
}

// --- INV1: reads never advance the revision ---------------------------------
{
  const ed = plate()
  ed.generate(PROGRAM, BigInt(3), false)
  const r0 = ed.revision()
  ed.state(); ed.metrics(); ed.zone_stats(); ed.circulation(); ed.plate()
  check('INV1 reads leave revision untouched', ed.revision() === r0, `${r0} -> ${ed.revision()}`)
}

// --- INV2: mutators advance it ----------------------------------------------
{
  const ed = plate()
  const steps = [
    ['generate', () => ed.generate(PROGRAM, BigInt(1), false)],
    ['add_component', () => ed.add_component('Desk', 2, 2, 1.4, 0.7)],
    ['add_wall', () => ed.add_wall(1, 1, 4, 1, 0.1)],
    ['clear_selection', () => ed.clear_selection()],
    ['add_zone', () => ed.add_zone('Workspace', 5, 5, 4, 3, 'Z')],
    ['restore', () => ed.restore(ed.snapshot())],
  ]
  for (const [name, run] of steps) {
    const before = ed.revision()
    run()
    check(`INV2 ${name} advances the revision`, ed.revision() !== before, `${before} -> ${ed.revision()}`)
  }
}

// --- INV3: equal revision => identical state --------------------------------
{
  const ed = plate()
  ed.generate(PROGRAM, BigInt(2), false)
  const r = ed.revision()
  const a = JSON.stringify(ed.state())
  const b = JSON.stringify(ed.state())
  check('INV3 same revision yields identical state()', a === b && ed.revision() === r, `${a.length} B`)
}

// --- INV4: a fresh Editor restarts at 0 (why the cache keys on the instance) --
{
  const fresh = new Editor()
  check('INV4 a fresh Editor starts at revision 0', fresh.revision() === 0n, fresh.revision())
  const used = plate()
  used.generate(PROGRAM, BigInt(1), false)
  check('INV4 a used Editor has advanced past 0', used.revision() !== 0n, used.revision())
}

// --- INV5: the memo, exactly as EditorCanvas implements it, is never stale ----
{
  // Mirrors EditorCanvas.getState(): keyed on (editor instance, revision).
  let cache = null
  let reads = 0
  const makeGetState = (getEd) => () => {
    const ed = getEd()
    const rev = ed.revision()
    if (cache && cache.ed === ed && cache.rev === rev) return cache.state
    reads++
    const state = ed.state()
    cache = { ed, rev, state }
    return state
  }

  let ed = plate()
  const getState = makeGetState(() => ed)

  ed.generate(PROGRAM, BigInt(3), false)
  const s1 = getState()
  const readsAfterFirst = reads
  for (let i = 0; i < 25; i++) getState()
  check('INV5 repeated reads with no mutation cost ONE serialize', reads === readsAfterFirst, `${reads} reads for 26 calls`)
  check('INV5 repeated reads return the same object', getState() === s1)

  const id = ed.add_component('Desk', 3, 3, 1.4, 0.7)
  const s2 = getState()
  check('INV5 a mutation invalidates the cache', s2 !== s1 && reads === readsAfterFirst + 1)
  check(
    'INV5 post-mutation state matches a fresh read',
    JSON.stringify(s2) === JSON.stringify(ed.state()),
  )
  check('INV5 the new component is visible', s2.components.some((c) => c.id === id))

  ed.move_component(id, 9, 9)
  const moved = getState().components.find((c) => c.id === id)
  check('INV5 a move is visible immediately', moved && Math.abs(moved.x - 9) < 1e-9, moved && moved.x)

  // The clearAll case: swap in a fresh Editor whose revision restarts at 0.
  // Keying on revision alone would serve the PREVIOUS document here.
  const beforeSwap = getState()
  ed = new Editor()
  const afterSwap = getState()
  check('INV5 swapping the Editor (clearAll) invalidates the cache', afterSwap !== beforeSwap)
  check('INV5 the swapped-in document is empty', afterSwap.components.length === 0 && afterSwap.walls.length === 0,
    `${afterSwap.components.length} comps / ${afterSwap.walls.length} walls`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
