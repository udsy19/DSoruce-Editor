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
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..', '..')
const WASM_DIR = path.join(REPO, 'web/src/wasm')

// ONE definition of the demo test-fit, shared with the app's sample plan
// (`web/src/editor/samplePlan.ts`), so the plan a visitor exports from the UI
// and the plan these harnesses render are the same document. JSON precisely
// because both a TS bundle and this plain Node script have to read it.
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(REPO, 'web/src/editor/samplePlan.json'), 'utf8'),
)

/** 40 × 24 m floor plate with a central service core and one entry. */
export const DEMO_PLATE = SAMPLE.plate

export const DEMO_PROGRAM = SAMPLE.program

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
export async function buildDemoDoc({ seed = SAMPLE.seed, program = DEMO_PROGRAM } = {}) {
  const { Editor } = await core()
  const ed = new Editor()
  const T = SAMPLE.wallThickness
  for (let i = 0; i < DEMO_PLATE.length; i++) {
    const a = DEMO_PLATE[i]
    const b = DEMO_PLATE[(i + 1) % DEMO_PLATE.length]
    ed.add_wall(a[0], a[1], b[0], b[1], T)
  }
  ed.add_entry(SAMPLE.entry[0], SAMPLE.entry[1])
  ed.add_keepout(SAMPLE.core.x, SAMPLE.core.y, SAMPLE.core.w, SAMPLE.core.h, SAMPLE.core.label)
  const score = ed.generate(program, BigInt(seed), false)
  return { ...readDoc(ed), plate: DEMO_PLATE, score, ed, seed }
}

/** Everything the deliverable-pack renderers + the workbook need off an editor. */
export function readDoc(ed) {
  const state = ed.state()
  // `circulation()` is degenerate with 0 walls (CLAUDE.md) — guard it.
  const circulation = state.walls.length > 0 ? ed.circulation() : null
  // The CORE's wall classification — the same one the workbook bills from, so
  // the coloured plan and the BOM cannot disagree (gate G3).
  const wallTypes = ed.wall_types()
  // The CORE's quantity surface — wall runs, door counts, room areas.
  const quantities = ed.quantities()
  return { state, circulation, wallTypes, quantities }
}

/**
 * A DIFFERENT brief on the same plate — meeting-heavy rather than desk-heavy.
 * Kept distinct from `DEMO_PROGRAM` on purpose: seed variation alone collapses
 * to two layouts on this plate, so a seed sweep would hand G9 a byte-identical
 * copy of the `seeded` case instead of an independent third input.
 */
export const TESTFIT_PROGRAM = {
  ...DEMO_PROGRAM,
  desks: 34,
  meeting_rooms: 9,
  meeting_w: 4,
  meeting_h: 3.5,
  cluster_cols: 3,
  target_corridor_m: 1.8,
  headcount: 40,
  w_adjacency: 2,
  w_daylight: 2,
}

/**
 * An AUTONOMOUS test-fit: sweep seeds through the real generator and keep the
 * best `layout_score`, which is exactly what `EditorCanvas.autoGenerate` does
 * in the app. Deterministic (fixed seed list), so the pack is reproducible.
 */
export async function buildTestFitDoc({ seeds = [3, 11, 19, 27, 41], program = TESTFIT_PROGRAM } = {}) {
  let best = null
  for (const seed of seeds) {
    const doc = await buildDemoDoc({ seed, program })
    const total = doc.score?.score?.total ?? doc.score?.total ?? 0
    if (!best || total > best.total) best = { ...doc, total }
  }
  return best
}

/**
 * The DWG sample as a real imported plan: convert with LibreDWG's `dwg2dxf`,
 * parse it with the app's own DXF importer, extract the plate / entries /
 * keep-outs with the app's own `testfit.ts`, then generate on that irregular
 * plate. Nothing here is a Node-only fork — it is the browser import pipeline
 * driven from Node.
 */
export async function buildDwgDoc({ program = DEMO_PROGRAM, seed = 5, esbuild } = {}) {
  const dwg = path.join(REPO, 'samples/furniture-plan.dwg')
  if (!fs.existsSync(dwg)) throw new Error(`missing DWG sample: ${dwg}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dwg-'))
  const dxfPath = path.join(tmp, 'furniture-plan.dxf')
  execFileSync('dwg2dxf', ['-o', dxfPath, dwg], { stdio: 'pipe' })

  const importBundle = path.join(tmp, 'import.mjs')
  await esbuild({
    stdin: {
      contents: `
        export { parseDrawing } from './src/import/dxf'
        export { extractPlate, extractEntries, extractKeepouts, extractInteriorWalls } from './src/import/testfit'
      `,
      resolveDir: path.join(REPO, 'web'),
      loader: 'ts',
    },
    outfile: importBundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
  })
  const imp = await import(new URL(`file://${importBundle}`).href)

  const drawing = imp.parseDrawing(fs.readFileSync(dxfPath, 'utf8'))
  const plate = imp.extractPlate(drawing)
  if (!plate) throw new Error('could not extract a floor plate from the DWG sample')
  const entries = imp.extractEntries(drawing, plate)
  const keepouts = imp.extractKeepouts(drawing, plate)

  const { Editor } = await core()
  const ed = new Editor()
  const b = plate.boundary
  for (let i = 0; i < b.length; i++) {
    const [ax, ay] = b[i]
    const [bx, by] = b[(i + 1) % b.length]
    ed.add_wall(ax, ay, bx, by, 0.15)
  }
  for (const [x, y] of entries) ed.add_entry(x, y)
  for (const k of keepouts) ed.add_keepout(k.x, k.y, k.w, k.h, k.label)
  const score = ed.generate(program, BigInt(seed), false)
  fs.rmSync(tmp, { recursive: true, force: true })
  return { ...readDoc(ed), plate: b, score, ed, seed, method: plate.method, areaM2: plate.areaM2 }
}
