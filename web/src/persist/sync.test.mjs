// Node test for the cloud plan sync engine (docs/design/plan-library.md §5).
// Run from web/:  node src/persist/sync.test.mjs
//
// Same esbuild pattern as plans.test.mjs, but bundled via `stdin` so sync.ts
// AND plans.ts share ONE db.ts instance (its in-memory Map fallback IS the
// local store under test). A fake `fetch` stands in for the server, mirroring
// deploy/server.ts's /api/plans routes over an in-memory Map. The wasm Editor
// is stubbed; sanitizeSavedPlan only touches parseProject (pure), never wasm.

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-sync-${Date.now()}.mjs`)
await build({
  // One bundle so sync.ts + plans.ts share the same db.ts module instance.
  stdin: {
    contents: `
      export { syncPlans } from './sync.ts'
      export { putPlan, deletePlan, listPlans, sanitizeSavedPlan } from './plans.ts'
    `,
    resolveDir: here,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
  plugins: [
    {
      name: 'stub-wasm',
      setup(b) {
        b.onResolve({ filter: /\/wasm\/ds_core$/ }, (args) => ({
          path: args.path,
          namespace: 'wasm-stub',
        }))
        b.onLoad({ filter: /.*/, namespace: 'wasm-stub' }, () => ({
          contents:
            'export class Editor {}\n' +
            // `openShare()` reads this across the boundary; the stub throws so the
            // caller takes its documented not-ready path instead of a fake number.
            'export function open_share() { throw new Error("wasm stub") }\n' +
            'export default function init() {}',
          loader: 'js',
        }))
      },
    },
  ],
})
const { syncPlans, putPlan, deletePlan, listPlans, sanitizeSavedPlan } = await import(
  pathToFileURL(outFile).href
)

// --- fixtures --------------------------------------------------------------

let n = 0
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
    file: { format: 'dsource', version: 1, savedAt: '2026-07-01T00:00:00.000Z', snapshot: `snap-${n}`, program: {} },
    ...overrides,
  }
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** In-memory server mirroring deploy/server.ts's /api/plans routes. */
function makeServer(seed = []) {
  const store = new Map(seed.map((p) => [p.id, p]))
  const calls = { post: 0, listGet: 0, recGet: 0 }
  const fetch = async (url, init = {}) => {
    const u = new URL(url, 'http://internal')
    const method = init.method ?? 'GET'
    if (u.pathname === '/api/plans' && method === 'POST') {
      calls.post += 1
      const body = JSON.parse(init.body)
      if (typeof body.id !== 'string' || body.file?.format !== 'dsource') return json(400, { error: 'bad' })
      store.set(body.id, body)
      return json(200, { ok: true, id: body.id })
    }
    if (u.pathname === '/api/plans' && method === 'GET') {
      calls.listGet += 1
      const list = [...store.values()].map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, metrics: p.metrics }))
      return json(200, list)
    }
    const m = u.pathname.match(/^\/api\/plans\/(.+)$/)
    if (m && method === 'GET') {
      calls.recGet += 1
      const p = store.get(decodeURIComponent(m[1]))
      return p ? json(200, p) : json(404, { error: 'not found' })
    }
    return json(405, {})
  }
  return { fetch, store, calls }
}

async function clearLocal() {
  for (const p of await listPlans()) await deletePlan(p.id)
}

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

// --- tests -----------------------------------------------------------------

await test('push: a fresh local plan uploads to an empty server and is stamped', async () => {
  await clearLocal()
  const srv = makeServer()
  const p = makePlan()
  await putPlan(p)
  const r = await syncPlans({ fetch: srv.fetch })
  assert.equal(r.pushed, 1)
  assert.equal(r.pulled, 0)
  assert.equal(r.error, undefined)
  assert.ok(srv.store.has(p.id), 'server received the plan')
  // The pushed body must NOT carry device-local sync bookkeeping.
  assert.equal(srv.store.get(p.id).syncedAt, undefined)
  assert.equal(srv.store.get(p.id).remoteRev, undefined)
  // Local record is stamped so a re-run is a no-op.
  const [localAfter] = await listPlans()
  assert.ok(localAfter.syncedAt, 'syncedAt stamped')
  assert.equal(localAfter.remoteRev, p.updatedAt, 'remoteRev = pushed updatedAt')
})

await test('pull: a plan only on the server is downloaded to a fresh device', async () => {
  await clearLocal()
  const remote = makePlan()
  const srv = makeServer([remote])
  const r = await syncPlans({ fetch: srv.fetch })
  assert.equal(r.pushed, 0)
  assert.equal(r.pulled, 1)
  const local = await listPlans()
  assert.equal(local.length, 1)
  assert.equal(local[0].id, remote.id)
  assert.equal(local[0].name, remote.name)
  assert.ok(local[0].syncedAt && local[0].remoteRev, 'reconciled record is stamped')
})

await test('LWW: remote newer overwrites local (conflict counted)', async () => {
  await clearLocal()
  const id = `plan-lww-a`
  const localOld = makePlan({ id, name: 'OLD', updatedAt: '2026-07-01T10:00:00.000Z' })
  const remoteNew = makePlan({ id, name: 'NEW', updatedAt: '2026-07-01T12:00:00.000Z' })
  await putPlan(localOld)
  const srv = makeServer([remoteNew])
  const r = await syncPlans({ fetch: srv.fetch })
  assert.equal(r.pushed, 0, 'stale local must NOT clobber newer remote')
  assert.equal(r.pulled, 1)
  assert.equal(r.conflicts, 1)
  const got = (await listPlans()).find((p) => p.id === id)
  assert.equal(got.name, 'NEW', 'remote won')
})

await test('LWW: local newer wins and is pushed; remote not pulled back', async () => {
  await clearLocal()
  const id = `plan-lww-b`
  const remoteOld = makePlan({ id, name: 'OLD', updatedAt: '2026-07-01T10:00:00.000Z' })
  const localNew = makePlan({ id, name: 'NEW', updatedAt: '2026-07-01T12:00:00.000Z' })
  await putPlan(localNew)
  const srv = makeServer([remoteOld])
  const r = await syncPlans({ fetch: srv.fetch })
  assert.equal(r.pushed, 1)
  assert.equal(r.pulled, 0)
  assert.equal(srv.store.get(id).name, 'NEW', 'server updated to local')
  const got = (await listPlans()).find((p) => p.id === id)
  assert.equal(got.name, 'NEW')
})

await test('idempotent: a second run pushes/pulls nothing', async () => {
  await clearLocal()
  await putPlan(makePlan()) // will be pushed
  const srv = makeServer([makePlan()]) // will be pulled
  const first = await syncPlans({ fetch: srv.fetch })
  assert.equal(first.pushed, 1)
  assert.equal(first.pulled, 1)
  const second = await syncPlans({ fetch: srv.fetch })
  assert.equal(second.pushed, 0, 'nothing new to push')
  assert.equal(second.pulled, 0, 'nothing new to pull')
  assert.equal(second.conflicts, 0)
  // No redundant full-record GETs on the idempotent re-run.
  const gets = srv.calls.recGet
  await syncPlans({ fetch: srv.fetch })
  assert.equal(srv.calls.recGet, gets, 'remoteRev guard skips re-GET of held versions')
})

await test('idempotent under clock skew: a future-dated pulled record does not re-push', async () => {
  await clearLocal()
  // A remote record whose updatedAt sits AHEAD of this device's wall-clock.
  const future = makePlan({ updatedAt: new Date(Date.now() + 3600_000).toISOString() })
  const srv = makeServer([future])
  const first = await syncPlans({ fetch: srv.fetch })
  assert.equal(first.pulled, 1)
  const posts = srv.calls.post
  const second = await syncPlans({ fetch: srv.fetch })
  assert.equal(second.pushed, 0, 'remoteRev guard prevents re-pushing a held future-dated record')
  assert.equal(srv.calls.post, posts, 'no POST on the idempotent re-run')
})

await test('malformed remote record is skipped, not fatal', async () => {
  await clearLocal()
  const good = makePlan()
  const bad = { id: 'plan-bad', name: 'Broken', updatedAt: '2026-07-01T09:00:00.000Z', file: { format: 'nope' } }
  const srv = makeServer([good, bad])
  const r = await syncPlans({ fetch: srv.fetch })
  assert.equal(r.error, undefined, 'a bad record must not abort the whole sync')
  assert.equal(r.pulled, 1, 'the good record still pulled')
  const ids = (await listPlans()).map((p) => p.id)
  assert.ok(ids.includes(good.id))
  assert.ok(!ids.includes('plan-bad'), 'malformed record not stored')
})

await test('offline: fetch failure returns a clean error, no local corruption', async () => {
  await clearLocal()
  const p = makePlan()
  await putPlan(p)
  const failing = async () => {
    throw new Error('network down')
  }
  const r = await syncPlans({ fetch: failing })
  assert.match(r.error, /network down/)
  assert.equal(r.pushed, 0)
  const [after] = await listPlans()
  assert.equal(after.syncedAt, undefined, 'local record untouched on failure')
})

await test('sanitizeSavedPlan: coerces metrics + validates file via parseProject', () => {
  const clean = sanitizeSavedPlan(makePlan({ metrics: { workstations: 'x' } }))
  assert.ok(clean)
  assert.equal(clean.metrics.workstations, 0, 'non-number metric coerced to 0')
  assert.equal(sanitizeSavedPlan({ id: 'a', name: 'b', file: { format: 'nope' } }), null)
  assert.equal(sanitizeSavedPlan(null), null)
  assert.equal(sanitizeSavedPlan({ name: 'no id', file: {} }), null)
})

console.log(`\n${passed} passed`)
