// The lost-update race on a project RECORD (persist/projects.ts).
//
// Not "the race in updateDraft" — that framing is what let the class survive a
// fix. `updateProject` performs the same read-modify-write, on the same record,
// with the same `await` between the read and the write, and spreads `...cur`, so
// an `updateProject` that never mentions `draft` still writes a stale draft over
// a newer one. This file therefore sweeps BOTH writers against each other, in
// BOTH orders, across a range of interleaving gaps: a single ordering passing is
// exactly why the one-sided chain read green for eight weeks.
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
const { createProject, updateDraft, updateProject, getProject } = await import(pathToFileURL(out).href)

/**
 * Reject rather than hang. `updateDraft` runs INSIDE the per-record queue, so if
 * its inner write ever re-entered `updateProject` it would enqueue behind itself
 * and never settle. A test that hangs forever is a worse failure than one that
 * reds, so every awaited write in this file carries a deadline.
 */
function withTimeout(p, label, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`DEADLOCK: ${label} did not settle within ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

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
const [a, b] = await withTimeout(Promise.all([
  updateDraft(rec.id, { drawing: heavy, anchors: [] }),
  updateDraft(rec.id, { markers: [{ ref: '501', kind: 'office', x: 1, y: 2 }], keepExisting: true }),
]), 'updateDraft ↔ updateDraft')

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
const stillOk = await withTimeout(updateDraft(rec.id, { winningSeed: 7 }), 'updateDraft after a rejection')
assert.equal(stillOk.draft.winningSeed, 7, 'a failed write for another id blocked later writes')
assert.ok((await getProject(rec.id)).draft.drawing, 'the drawing must still be there at the end')

// --- no self-wait: updateDraft must still RESOLVE --------------------------
// The serialisation point is keyed on the RECORD, so `updateDraft`'s inner write
// has to call the unchained `applyPatch`. Routing it back through the exported
// `updateProject` would queue it behind the very job it is running inside, and
// the promise would never settle. Pinned explicitly, with a deadline.
const solo = await createProject({ name: 'self-wait', propertyName: 'p' })
const settled = await withTimeout(updateDraft(solo.id, { winningSeed: 3 }), 'updateDraft self-wait', 3000)
assert.equal(settled.draft?.winningSeed, 3, 'updateDraft must resolve with its own record')

// --- the CLASS: updateProject ↔ updateDraft, across the interleaving window -
// The wizard's exact shape: GenerateStep awaits `updateProject(id,
// {chosenPlanId})` while SpaceStep/ProgramStep have fire-and-forget
// `void updateDraft(...)` calls in flight. Both writers read-modify-write the
// same record and both spread `...cur`, so whichever writes last silently
// restores the other's stale half.
//
// The gap between the two calls is what decides who reads what, and it is not
// controllable in the app — so sweep it: issue the second call after N awaited
// microtasks, N over 0..6, in both orders. Asserting one ordering is how this
// was missed; the sweep IS the test. Every gap must end with BOTH the draft
// field and the top-level field present.
const GAPS = 7
const PLAN_ID = 'plan-chosen-1'

/** Start `fn` after `gap` awaited microtasks (gap 0 = same synchronous turn). */
function startAfter(gap, fn) {
  return (async () => {
    for (let i = 0; i < gap; i++) await Promise.resolve()
    return fn()
  })()
}

async function sweep(order) {
  const losses = []
  for (let gap = 0; gap < GAPS; gap++) {
    const r = await createProject({ name: `sweep-${order}-${gap}`, propertyName: 'p' })
    const writeDraft = () => updateDraft(r.id, { drawing: heavy })
    const writeTop = () => updateProject(r.id, { chosenPlanId: PLAN_ID })
    const [first, second] = order === 'draft-first' ? [writeDraft, writeTop] : [writeTop, writeDraft]
    const p1 = first()
    const p2 = startAfter(gap, second)
    // allSettled: a lost update is a SILENT success, so neither call rejecting
    // is part of the defect — the record is the only witness.
    await withTimeout(Promise.allSettled([p1, p2]), `${order} gap=${gap}`)

    const got = await getProject(r.id)
    const lost = []
    if (!got?.draft?.drawing) lost.push('draft.drawing (the uploaded floor plate)')
    if (got?.chosenPlanId !== PLAN_ID) lost.push('chosenPlanId')
    if (lost.length) losses.push(`  ${order} gap=${gap}: LOST ${lost.join(' + ')}`)
  }
  return losses
}

const lostAt = [...(await sweep('draft-first')), ...(await sweep('project-first'))]
const swept = GAPS * 2
console.log(`draftRace sweep: ${swept - lostAt.length}/${swept} interleavings preserved both fields`)
for (const line of lostAt) console.log(line)
assert.equal(
  lostAt.length, 0,
  `LOST UPDATE between updateProject and updateDraft — ${lostAt.length} of ${swept} interleavings lost data:\n${lostAt.join('\n')}`,
)

console.log('PASS draftRace: concurrent record writes preserve every field')
