// The lost-update race in `updateDraft` (persist/projects.ts).
//
// Run from web/:  node src/persist/draftRace.test.mjs
//
// Same esbuild pattern as plans.test.mjs: projects.ts is TypeScript, so
// transpile a temp ESM bundle and import it. db.ts falls back to in-memory Maps
// when `indexedDB` is absent, which is exactly the store this test wants.
//
// @covers: web/src/persist/projects.ts

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// esbuild is a nested (pnpm) dep of vite, not top-level. Resolve it through
// vite so this runs on a fresh `pnpm install` without extra deps.
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'draftrace-')), 'projects.mjs')
await build({
  entryPoints: [path.join(here, 'projects.ts')],
  bundle: true, format: 'esm', platform: 'neutral', outfile: out,
  target: 'es2022', logLevel: 'silent',
})
const { createProject, updateDraft, getProject } = await import(pathToFileURL(out).href)

// --- the race -----------------------------------------------------------
// Two overlapping draft writes with DISJOINT patches. Both must survive.
//
// This is the wizard's exact shape: the Space step awaits `{drawing}` after an
// upload while a persist effect fires `{markers, keepExisting}` on the same
// tick. Unserialised, the second read happens before the first write lands and
// the second write clobbers it — the uploaded plate vanishes and the Generate
// step reports "There's no floor plate to fit."
const rec = await createProject({ name: 'race', propertyName: 'p' })

const heavy = { units: 'm', bounds: [0, 0, 40, 22], layers: [], entities: [], furniture: [] }
const [a, b] = await Promise.all([
  updateDraft(rec.id, { drawing: heavy, anchors: [] }),
  updateDraft(rec.id, { markers: [{ ref: '501', kind: 'office', x: 1, y: 2 }], keepExisting: true }),
])

const after = await getProject(rec.id)
assert.ok(after?.draft?.drawing, 'LOST UPDATE: the drawing was clobbered by a concurrent draft write')
assert.equal(after.draft.markers?.length, 1, 'LOST UPDATE: markers were clobbered')
assert.equal(after.draft.keepExisting, true, 'LOST UPDATE: keepExisting was clobbered')
assert.ok(a && b, 'both callers must receive their record')

// --- ordering: a later write still wins for the SAME key ------------------
await Promise.all([
  updateDraft(rec.id, { keepExisting: false }),
  updateDraft(rec.id, { keepExisting: true }),
])
const seq = await getProject(rec.id)
assert.equal(typeof seq.draft.keepExisting, 'boolean', 'same-key writes must still resolve to one value')
assert.ok(seq.draft.drawing, 'the drawing must survive further draft writes')

// --- a rejected write must not poison the queue ---------------------------
await assert.rejects(updateDraft('no-such-project', { keepExisting: true }))
const stillOk = await updateDraft(rec.id, { winningSeed: 7 })
assert.equal(stillOk.draft.winningSeed, 7, 'a failed write for another id blocked later writes')
assert.ok((await getProject(rec.id)).draft.drawing, 'the drawing must still be there at the end')

console.log('PASS draftRace: concurrent draft writes preserve every field')
