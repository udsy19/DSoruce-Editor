// Branch-4a runner.  node bench/runSearch.mjs
//
// Budget is a metered generate() count (ADR 0005): generate() is 34.2 ms against
// 0.2 ms of bookkeeping, so it is the only cost that scales with search effort,
// and metering it is machine-independent in a way wall-clock is not. Wall-clock
// is reported alongside, and a candidate exceeding 2x the incumbent at equal call
// count triggers a wall-clock-matched re-run (the pre-registered loophole guard).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const truth = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/qto/truth.json'), 'utf8'))

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
let seq = 0
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `srch-${process.pid}-${seq++}.mjs`)
  await build({ entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const wasmDir = path.join(ROOT, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

const BASE = truth.source.program

// ---- THE yardstick ---------------------------------------------------------
// `LayoutScore.total` is a weighted sum using the PROGRAM'S OWN weights, so a
// candidate that mutates weights raises `total` by shifting weight onto whatever
// already scores well — optimizing the RULER, not the design. Two of the four
// candidates mutate weights, so `total` is not comparable across them.
//
// Every candidate is therefore scored on the BASE program's fixed weights,
// whatever program it searched with. This is not a new invention: `ai/refine.ts`
// already does exactly this (`refScore`) so that an LLM's program change cannot
// flatter itself, and the same reasoning applies here.
const REF_PAIRS = [
  ['capacity', 'w_capacity'], ['adjacency', 'w_adjacency'],
  ['circulation', 'w_circulation'], ['density', 'w_density'],
  ['program_fit', 'w_program'], ['daylight', 'w_daylight'],
  ['entry_adjacency', 'w_entry'],
]
function yardstick(score) {
  let num = 0, den = 0
  for (const [sk, wk] of REF_PAIRS) { const w = BASE[wk]; num += w * score[sk]; den += w }
  return den > 0 ? num / den : score.total
}

// ---- fixtures ---------------------------------------------------------------
function rect(w, h) {
  const ed = new Editor()
  const box = [[0, 0], [w, 0], [w, h], [0, h]]
  for (let i = 0; i < box.length; i++) {
    const [ax, ay] = box[i]
    const [bx, by] = box[(i + 1) % box.length]
    ed.add_wall(ax, ay, bx, by, 0.15)
  }
  return ed
}
function rotRect(w, h, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [x * c - y * s, x * s + y * c])
  const ed = new Editor()
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    ed.add_wall(ax, ay, bx, by, 0.15)
  }
  return ed
}
function lshape() {
  const ed = new Editor()
  const pts = [[0, 0], [34, 0], [34, 12], [18, 12], [18, 24], [0, 24]]
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[(i + 1) % pts.length]
    ed.add_wall(ax, ay, bx, by, 0.15)
  }
  return ed
}
const FIXTURES = [
  { id: 'real/standard', make: () => Editor.from_snapshot(truth.snapshot), program: BASE },
  { id: 'real/dense', make: () => Editor.from_snapshot(truth.snapshot), program: { ...BASE, desks: 200 } },
  { id: 'real/pinned-rooms', make: () => Editor.from_snapshot(truth.snapshot),
    program: { ...BASE, rooms: [
      { kind: 'Cabin', count: 4, placement: 'Window' },
      { kind: 'Meeting6P', count: 3, placement: 'Flexible' },
      { kind: 'PhoneBooth', count: 4, placement: 'Core' },
    ] } },
  { id: 'small-90m2', make: () => rect(12, 7.5), program: { ...BASE, desks: 10, meeting_rooms: 1 } },
  { id: 'tilted-17deg', make: () => rotRect(26, 18, 17), program: { ...BASE, desks: 40 } },
  { id: 'lshape-concave', make: () => lshape(), program: { ...BASE, desks: 50 } },
  { id: 'high-constraint', make: () => Editor.from_snapshot(truth.snapshot),
    program: { ...BASE, target_corridor_m: 1.5, desk_clearance_m: 1.2 } },
]

const BUDGETS = [15, 27, 51]
const SEARCH_SEEDS = [1, 2, 3]

// ---- metered solver ---------------------------------------------------------
function makeSolver(ed, budget, searchSeed) {
  let used = 0
  let s = (searchSeed * 2654435761) >>> 0
  return {
    solver: {
      generate(program, seed) {
        if (used >= budget) return null
        used++
        return ed.generate(program, BigInt(Math.abs(Math.floor(seed)) % 1_000_000 || 1), false)
      },
      remaining: () => budget - used,
      rand: () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 0x100000000
      },
    },
    usedCalls: () => used,
  }
}

/** Constraint check — the same NBC minimums the core scores against. */
function violations(ed, program) {
  const circ = ed.circulation()
  let n = 0
  if (circ.min_corridor_width < Math.min(program.target_corridor_m, 1.5) - 0.01) n++
  if (circ.min_corridor_width < program.desk_clearance_m * 0.95) n++
  return n
}

const impls = []
for (const f of ['baseline.ts', 'evolutionary.ts', 'iterativeAlign.ts', 'hardConstraints.ts']) {
  const mod = await bundle(path.join(here, 'adapters/search', f))
  const impl = mod.default ?? Object.values(mod).find((v) => v && v.search)
  if (impl) impls.push(impl)
}

const results = {}
for (const impl of impls) {
  results[impl.meta.id] = { meta: impl.meta, fixtures: {} }
}

for (const fx of FIXTURES) {
  for (const budget of BUDGETS) {
    for (const impl of impls) {
      const perSeed = []
      for (const searchSeed of SEARCH_SEEDS) {
        const ed = fx.make()
        const { solver, usedCalls } = makeSolver(ed, budget, searchSeed)
        const t0 = performance.now()
        let cands = []
        try { cands = impl.search(solver, fx.program) } catch (e) {
          perSeed.push({ error: String(e.message ?? e).slice(0, 120) }); continue
        }
        const ms = performance.now() - t0
        // Re-rank on the fixed yardstick, NOT on each candidate's own `total`.
        cands.sort((a, b) => yardstick(b.score) - yardstick(a.score))
        const best = cands[0]
        // Re-generate the winner so the document reflects it for constraint checks.
        let viol = 0
        if (best) {
          ed.generate(best.program, BigInt(Math.abs(best.seed) % 1_000_000 || 1), false)
          viol = violations(ed, best.program)
        }
        perSeed.push({
          searchSeed,
          best: best ? +yardstick(best.score).toFixed(2) : null,
          rawTotal: best ? +best.score.total.toFixed(2) : null,
          desks: best ? best.score.placed_desks : null,
          circ: best ? +best.score.circulation.toFixed(2) : null,
          calls: usedCalls(), ms: +ms.toFixed(1), violations: viol,
          fingerprint: cands.map((c) => `${c.seed}:${c.score.total.toFixed(4)}`).join('|'),
        })
      }
      const ok = perSeed.filter((r) => r.best != null)
      const totals = ok.map((r) => r.best)
      const raws = ok.map((r) => r.rawTotal)
      const mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null
      const variance = totals.length > 1
        ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (totals.length - 1)) : 0
      results[impl.meta.id].fixtures[`${fx.id}@${budget}`] = {
        meanBest: mean != null ? +mean.toFixed(2) : null,
        bestOfSeeds: totals.length ? +Math.max(...totals).toFixed(2) : null,
        sdAcrossSeeds: +variance.toFixed(3),
        meanRawTotal: raws.length ? +(raws.reduce((a, b) => a + b, 0) / raws.length).toFixed(2) : null,
        meanDesks: ok.length ? Math.round(ok.reduce((a, r) => a + r.desks, 0) / ok.length) : null,
        meanCirc: ok.length ? +(ok.reduce((a, r) => a + r.circ, 0) / ok.length).toFixed(2) : null,
        violations: Math.max(...perSeed.map((r) => r.violations ?? 0)),
        callsUsed: Math.max(...perSeed.map((r) => r.calls ?? 0)),
        meanMs: ok.length ? +(perSeed.reduce((a, r) => a + (r.ms ?? 0), 0) / perSeed.length).toFixed(1) : null,
        perSeed,
      }
    }
  }
}

// ---- determinism gate: same search seed must reproduce exactly ---------------
for (const impl of impls) {
  const fx = FIXTURES[0]
  const runFp = (seed) => {
    const ed = fx.make()
    const { solver } = makeSolver(ed, 27, seed)
    return impl.search(solver, fx.program).map((c) => `${c.seed}:${c.score.total.toFixed(6)}`).join('|')
  }
  results[impl.meta.id].deterministic = runFp(7) === runFp(7)
}

fs.mkdirSync(path.join(here, 'results'), { recursive: true })
fs.writeFileSync(path.join(here, 'results/search.json'), JSON.stringify(results, null, 2))

const pad = (s, n) => String(s).padEnd(n)
console.log('\nBRANCH 4a — best on the FIXED yardstick (base weights), mean of 3 search seeds')
console.log('(a candidate that mutates weights cannot flatter itself here)\n')
for (const budget of BUDGETS) {
  console.log(`--- budget ${budget} generate() calls ---`)
  console.log(pad('fixture', 22) + impls.map((i) => pad(i.meta.id, 17)).join(''))
  for (const fx of FIXTURES) {
    const row = impls.map((i) => {
      const r = results[i.meta.id].fixtures[`${fx.id}@${budget}`]
      return pad(r?.meanBest != null ? `${r.meanBest} ±${r.sdAcrossSeeds}` : '—', 17)
    })
    console.log(pad(fx.id, 22) + row.join(''))
  }
  console.log('')
}
console.log('\nRAW LayoutScore.total (each candidate scored on ITS OWN weights) — diagnostic,')
console.log('shown so the gap between it and the yardstick is visible:')
console.log(pad('fixture', 22) + impls.map((i) => pad(i.meta.id, 17)).join(''))
for (const fx of FIXTURES) {
  const row = impls.map((i) => {
    const r = results[i.meta.id].fixtures[`${fx.id}@51`]
    return pad(r?.meanRawTotal != null ? String(r.meanRawTotal) : '—', 17)
  })
  console.log(pad(fx.id, 22) + row.join(''))
}
console.log('\ndeterminism gate: ' + impls.map((i) => `${i.meta.id}=${results[i.meta.id].deterministic ? 'ok' : 'FAIL'}`).join('  '))
console.log('\nviolations on high-constraint (gate for hard-constraints, diagnostic for others):')
for (const i of impls) {
  const r = results[i.meta.id].fixtures[`high-constraint@51`]
  console.log(`  ${pad(i.meta.id, 18)} ${r?.violations ?? '—'}   desks ${r?.meanDesks ?? '—'}  circ ${r?.meanCirc ?? '—'}  ${r?.meanMs ?? '—'} ms`)
}
