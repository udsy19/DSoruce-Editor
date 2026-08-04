// The seeded demo document every headless deliverable-pack harness renders.
//
// Runs the REAL Rust core (`web/src/wasm`) in Node — wasm-pack's `--target web`
// bundle initialises fine off a `Buffer` via `initSync` — so the geometry the
// gates measure is the same geometry the browser app produces. Deterministic:
// one fixed plate, one fixed program, one fixed seed.
//
// Usage:  const { state, circulation, plate, score } = await buildDemoDoc()
//         await buildDemoDoc({ seed: 11 })   // a different, still-fixed plan

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
const WASM_DIR = path.join(REPO, 'web/src/wasm')

/** 40 × 24 m floor plate with a central service core and one entry. */
export const DEMO_PLATE = [
  [0, 0],
  [40, 0],
  [40, 24],
  [0, 24],
]

export const DEMO_PROGRAM = {
  desks: 60,
  meeting_rooms: 4,
  desk_w: 1.4,
  desk_h: 0.7,
  meeting_w: 5,
  meeting_h: 4,
  cluster_cols: 4,
  target_corridor_m: 1.6,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  support_spaces: true,
  headcount: 70,
  w_capacity: 1,
  w_adjacency: 1,
  w_circulation: 1,
  w_density: 1,
  w_program: 1,
  w_daylight: 1,
  w_entry: 1,
}

let mod = null

async function core() {
  if (mod) return mod
  const js = pathToUrl(path.join(WASM_DIR, 'ds_core.js'))
  mod = await import(js)
  mod.initSync({ module: fs.readFileSync(path.join(WASM_DIR, 'ds_core_bg.wasm')) })
  return mod
}

function pathToUrl(p) {
  return new URL(`file://${p}`).href
}

/**
 * Build the seeded demo test-fit.
 * @returns `{ state, circulation, plate, score }` — plain JSON, ready to hand
 *          to the browser-side renderers.
 */
export async function buildDemoDoc({ seed = 7, program = DEMO_PROGRAM } = {}) {
  const { Editor } = await core()
  const ed = new Editor()
  const T = 0.2
  for (let i = 0; i < DEMO_PLATE.length; i++) {
    const a = DEMO_PLATE[i]
    const b = DEMO_PLATE[(i + 1) % DEMO_PLATE.length]
    ed.add_wall(a[0], a[1], b[0], b[1], T)
  }
  ed.add_entry(20, 0)
  ed.add_keepout(20, 12, 6, 5, 'Core')
  const score = ed.generate(program, BigInt(seed), false)
  const state = ed.state()
  // `circulation()` is degenerate with 0 walls (CLAUDE.md) — guard it.
  const circulation = state.walls.length > 0 ? ed.circulation() : null
  // The CORE's wall classification — the same one the workbook bills from, so
  // the coloured plan and the BOM cannot disagree (gate G3).
  const wallTypes = ed.wall_types()
  return { state, circulation, wallTypes, plate: DEMO_PLATE, score }
}
