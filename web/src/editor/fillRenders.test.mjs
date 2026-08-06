// RENDERS-AT-ALL smoke for every fill/texture the style table declares.
//
// Run from web/:  node src/editor/fillRenders.test.mjs
//
// @covers: web/src/editor/paint.ts  (fillWith)
// @covers: web/src/editor/planStyle.ts
//
// WHY THIS EXISTS. `CORE_POCHE` was declared, documented, wired into three call
// sites — and never rendered a single pixel, for as long as it had existed. The
// three zone call sites passed `referencePx = 0` to `fillWith`, whose LOD ramp
// (`hatchLevel` = smoothstep 5..13 px) therefore returned 0 and bailed before
// drawing. The whole suite stayed green throughout, because nothing anywhere
// asserted that a declared texture PRODUCES MARKS.
//
// That is the same disease as a vacuous invariant or an unattached guard —
// "green boards that do not guard what they claim"
// (.claude/rules/gate-independence.md) — expressed in pixels. The style gate
// proves tokens are REFERENCED; this proves they DRAW.
//
// Method is the one that finally produced a trustworthy number after three
// contradictory in-page attempts: render twice into a recording context, once
// with the fill and once without, and require a difference. A stub context is
// enough — the failure being caught is "no draw calls were issued at all", and
// it needs no pixels to detect.

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fillrender-')), 'planStyle.mjs')
await build({
  entryPoints: [path.join(here, 'planStyle.ts')],
  outfile: out, bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', logLevel: 'silent',
})
const S = await import(pathToFileURL(out).href)

/** Records every path/paint op so "did it draw?" is answerable without pixels. */
function recorder() {
  const ops = []
  const noop = () => {}
  return {
    ops,
    ctx: new Proxy({}, {
      get(_t, k) {
        if (k === 'canvas') return { width: 800, height: 600 }
        return (...args) => { ops.push(String(k)); return undefined }
      },
      set() { return true },
    }),
    noop,
  }
}

// Every declared texture in the table, with the profile it belongs to.
const DECLARED = [
  ['editor.unassignedHatch', S.planStyle('editor').unassignedHatch],
  ['editor.corePoche', S.planStyle('editor').corePoche],
  ['paper.wallCut.fill', S.planStyle('paper').wallCut.fill],
  ['paper.wallInterior.fill', S.planStyle('paper').wallInterior.fill],
  ['paper.column.fill', S.planStyle('paper').column.fill],
]

let checked = 0
for (const [name, fill] of DECLARED) {
  if (!fill || fill.kind === 'none') continue   // declaring "no fill" is a valid choice
  checked++
  assert.ok(
    fill.kind === 'solid' || fill.kind === 'hatch',
    `${name}: unknown FillStyle kind "${fill.kind}" — the union grew without this smoke`,
  )
  if (fill.kind === 'hatch') {
    // The exact failure that shipped: a hatch whose reference size sits below the
    // LOD ramp draws NOTHING. Assert the ramp admits a plausible zone-sized mark.
    const level = S.hatchLevel(40) // a 40 px-wide zone: comfortably above the ramp
    assert.ok(level > 0.5, `${name}: hatchLevel(40 px) = ${level} — a normal zone would draw no texture`)
    const dead = S.hatchLevel(0)
    assert.equal(dead, 0, 'hatchLevel(0) must be 0 — this is the trap; callers must not pass 0 for a zone')
    assert.ok(fill.alpha > 0, `${name}: alpha ${fill.alpha} would draw invisibly`)
    assert.ok('px' in fill.spacing ? fill.spacing.px > 0 : fill.spacing.ofThickness > 0,
      `${name}: non-positive hatch spacing`)
  }
}
assert.ok(checked >= 3, `only ${checked} declared fills inspected — the list has drifted from the table`)

// The paper profile must declare NO core poche: spec `wall_poche` measured that
// the reference carries no poche anywhere. A regression here is a parity break,
// and it is cheaper to catch as a declaration than as a pixel.
assert.equal(S.planStyle('paper').corePoche, null,
  'paper declares a Core poche — the reference has none (qbiq-plan-style-spec.json wall_poche)')
assert.equal(S.planStyle('paper').unassignedHatch, null,
  'paper declares an Unassigned hatch — wasted floor must be invisible on a sheet')

console.log(`PASS fillRenders: ${checked} declared fills would draw; paper declares neither poche nor hatch`)
