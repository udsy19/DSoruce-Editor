// Node test for the plan library's multi-floor project layer
// (docs/design/multi-floor.md). Run from web/:  node src/persist/plans.test.mjs
//
// Same esbuild pattern as src/import/dxf.test.mjs: plans.ts is TypeScript, so
// transpile a temp ESM bundle and import it. The wasm module is stubbed (its
// Editor is only touched on the parked-candidate path, which these tests
// avoid); db.ts detects the absence of `indexedDB` and runs on in-memory Maps.

// @covers: web/src/persist/plans.ts
// @covers: web/src/persist/db.ts

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// esbuild is a nested (pnpm) dep of vite, not top-level. Resolve it through
// vite so this runs on a fresh `pnpm install` without extra deps.
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-plans-${Date.now()}.mjs`)
await build({
  entryPoints: [path.join(here, 'plans.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  plugins: [
    {
      // Generated wasm bindings (web/src/wasm is gitignored) are irrelevant
      // here — stub the Editor so the bundle builds without `make wasm`.
      name: 'stub-wasm',
      setup(b) {
        b.onResolve({ filter: /\/wasm\/ds_core$/ }, (args) => ({
          path: args.path,
          namespace: 'wasm-stub',
        }))
        b.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, () => ({
          contents: 'export class Editor {}\nexport default function init() {}',
          loader: 'js',
        }))
      },
    },
  ],
})
const { groupPlans, listProjects, resolveProject, assignToProject, buildSavedPlan, putPlan } =
  await import(pathToFileURL(outFile).href)

// --- fixtures --------------------------------------------------------------

let n = 0
/** Minimal SavedPlan record. Old (pre-project) records = no overrides. */
function makePlan(overrides = {}) {
  n += 1
  return {
    id: `plan-${n}`,
    name: `Plan ${n}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: `2026-07-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    thumb: '',
    metrics: {
      workstations: 10 + n,
      netInternalArea: 100,
      efficiencyPct: 50,
      indicativeCost: 1000,
      circulationScore: null,
      minCorridorM: null,
    },
    file: {
      format: 'dsource',
      version: 1,
      savedAt: '2026-07-01T00:00:00.000Z',
      snapshot: `snap-${n}`,
      program: {},
    },
    ...overrides,
  }
}

const inProject = (projectId, projectName, label, index) => ({
  projectId,
  projectName,
  floor: { label, index },
})

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`PASS  ${name}`)
    })
    .catch((e) => {
      console.error(`FAIL  ${name}\n${e?.stack ?? e}`)
      process.exitCode = 1
    })
}

// --- groupPlans: pure derivation -------------------------------------------

await test('groupPlans: mixed old/new records → projects first, ungrouped pseudo-group trails', () => {
  const old1 = makePlan() // pre-project records: no fields at all
  const old2 = makePlan()
  const a2 = makePlan(inProject('pA', 'Tower A', 'L2', 1))
  const a1 = makePlan(inProject('pA', 'Tower A', 'L1', 0))
  const b1 = makePlan(inProject('pB', 'Annex', 'G', 0))
  // Input arrives listPlans()-sorted (updatedAt desc).
  const groups = groupPlans([b1, a1, a2, old2, old1])
  assert.equal(groups.length, 3)
  // Groups keep first-appearance (most-recently-updated) order; pseudo last.
  assert.deepEqual(
    groups.map((g) => g.projectId),
    ['pB', 'pA', ''],
  )
  assert.equal(groups[1].projectName, 'Tower A')
  assert.equal(groups[2].projectName, '')
  assert.deepEqual(
    groups[2].floors.map((p) => p.id),
    [old2.id, old1.id], // ungrouped keep their input (updatedAt) order
  )
})

await test('groupPlans: floors sort by floor.index, not input order', () => {
  const l3 = makePlan(inProject('pC', 'HQ', 'L3', 2))
  const l1 = makePlan(inProject('pC', 'HQ', 'L1', 0))
  const l2 = makePlan(inProject('pC', 'HQ', 'L2', 1))
  const [g] = groupPlans([l3, l1, l2])
  assert.deepEqual(
    g.floors.map((p) => p.floor.label),
    ['L1', 'L2', 'L3'],
  )
})

await test('groupPlans: old records only → single pseudo-group, nothing throws', () => {
  const groups = groupPlans([makePlan(), makePlan()])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].projectId, '')
  assert.equal(groups[0].floors.length, 2)
})

// --- store-backed API (db.ts in-memory fallback) ----------------------------

await test('listProjects derives from stored records; old records stay ungrouped', async () => {
  const oldRec = makePlan()
  const flr = makePlan(inProject('pD', 'Depot', 'L1', 0))
  await putPlan(oldRec)
  await putPlan(flr)
  const projects = await listProjects()
  const depot = projects.find((g) => g.projectId === 'pD')
  const pseudo = projects.find((g) => g.projectId === '')
  assert.equal(depot.floors[0].id, flr.id)
  assert.ok(pseudo.floors.some((p) => p.id === oldRec.id))
  assert.equal(projects[projects.length - 1].projectId, '') // pseudo-group trails
})

await test('resolveProject: case-insensitive reuse returns canonical id + name', async () => {
  await putPlan(makePlan(inProject('pE', 'Tower East', 'L1', 0)))
  const hit = await resolveProject('  tower east ')
  assert.deepEqual(hit, { projectId: 'pE', projectName: 'Tower East' })
})

await test('resolveProject: unknown name mints a fresh projectId', async () => {
  const made = await resolveProject('Brand New')
  assert.equal(made.projectName, 'Brand New')
  assert.match(made.projectId, /^[0-9a-f-]{36}$/)
  const again = await resolveProject('brand new') // not stored yet → mints again
  assert.notEqual(again.projectId, made.projectId)
})

await test('assignToProject: updates the record, bumps updatedAt, appends floor index', async () => {
  const existing = makePlan(inProject('pF', 'Yard', 'L1', 0))
  const loose = makePlan({ updatedAt: '2026-07-01T00:00:00.000Z' })
  await putPlan(existing)
  await putPlan(loose)
  const before = loose.updatedAt
  const next = await assignToProject(loose.id, 'pF', 'Yard', { label: 'L2' })
  assert.equal(next.projectId, 'pF')
  assert.equal(next.projectName, 'Yard')
  assert.deepEqual(next.floor, { label: 'L2', index: 1 }) // max existing (0) + 1
  assert.ok(next.updatedAt > before, 'updatedAt must be bumped')
  const groups = await listProjects()
  const yard = groups.find((g) => g.projectId === 'pF')
  assert.deepEqual(
    yard.floors.map((p) => p.floor.label),
    ['L1', 'L2'],
  )
})

await test('assignToProject: re-assign within the same project keeps the floor index', async () => {
  const flr = makePlan(inProject('pG', 'Lab', 'Level 2', 4))
  await putPlan(flr)
  const next = await assignToProject(flr.id, 'pG', 'Lab', { label: 'Mezzanine' })
  assert.deepEqual(next.floor, { label: 'Mezzanine', index: 4 })
})

await test('assignToProject: unknown plan id throws', async () => {
  await assert.rejects(() => assignToProject('nope', 'p', 'P', { label: 'L1' }), /No saved plan/)
})

// --- buildSavedPlan: optional project opt -----------------------------------

const fakeEc = {
  snapshot: () => 'live-snap',
  program: { desks: 40 },
  getMetrics: () => ({
    workstations: 40,
    net_internal_area: 300,
    efficiency_pct: 55,
    indicative_cost: 5000,
    wall_count: 0,
  }),
  circulation: () => null,
}

await test('buildSavedPlan: project opt stamps the additive fields', () => {
  const p = buildSavedPlan(fakeEc, 'Baseline', {
    project: { projectId: 'pH', projectName: 'Tower H', floor: { label: 'L1', index: 0 } },
  })
  assert.equal(p.projectId, 'pH')
  assert.equal(p.projectName, 'Tower H')
  assert.deepEqual(p.floor, { label: 'L1', index: 0 })
  assert.equal(p.file.snapshot, 'live-snap')
})

await test('buildSavedPlan: without project opt the fields are absent (old shape)', () => {
  const p = buildSavedPlan(fakeEc, 'Baseline')
  assert.ok(!('projectId' in p) && !('projectName' in p) && !('floor' in p))
})

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`)
