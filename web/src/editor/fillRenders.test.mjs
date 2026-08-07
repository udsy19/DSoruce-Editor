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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fillrender-'))
// ONE bundle re-exporting both, so `planStyle` and `paint` share a single module
// instance. Bundling them separately gives each its own copy of the style table:
// mutating one has no effect on the other, both runs render identically, and the
// difference-based guard below silently measures NOTHING. (Caught by the guard
// firing on known-good code — an instrument that cannot fail is worse than one
// that does.)
const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(entry, `
  export * from ${JSON.stringify(path.join(here, 'planStyle.ts'))}
  export { drawZones } from ${JSON.stringify(path.join(here, 'paint.ts'))}
  export { drawSymbol } from ${JSON.stringify(path.join(here, 'symbols.ts'))}
`)
const outAll = path.join(tmp, 'all.mjs')
await build({
  entryPoints: [entry], outfile: outAll, bundle: true, format: 'esm',
  platform: 'neutral', target: 'es2022', logLevel: 'silent',
})
const S = await import(pathToFileURL(outAll).href)
const P = S

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

// ---------------------------------------------------------------------------
// THE ACTUAL GUARD: does the render PATH emit marks for each declared texture?
// ---------------------------------------------------------------------------
//
// The declaration checks above are necessary and NOT sufficient — proven, not
// assumed. Re-breaking the LOD ramp (`referencePx = 0` at the three zone call
// sites, the exact defect that kept the Core poche dead for its whole life)
// leaves every declaration valid, and the checks above PASS. A guard that
// inspects the table cannot see a call site that throws the table away.
//
// So this runs `drawZones` against a recording context and requires that the
// texture changes what gets drawn. Differencing, not sampling: the same scene
// rendered with and without the texture, compared by emitted operations. A stub
// context suffices — the failure class is "no draw calls at all".

function recordingCtx() {
  const ops = []
  const target = {
    canvas: { width: 900, height: 700 },
    setLineDash() {}, getLineDash: () => [],
    // Text metrics: the label path measures before it draws.
    measureText: (t) => ({ width: String(t).length * 6 }),
  }
  return {
    ops,
    ctx: new Proxy(target, {
      get(t, k) {
        if (k in t) return t[k]
        if (typeof k === 'symbol') return undefined
        return (...a) => { ops.push(String(k)); return undefined }
      },
      set() { return true },
    }),
  }
}

const view = (ctx) => ({
  ctx, scale: 20, offset: { x: 0, y: 0 }, presentation: false,
  toScreen: (x, y) => ({ x: x * 20, y: y * 20 }),
  toWorld: (x, y) => ({ x: x / 20, y: y / 20 }),
})

/** One zone of `type`, 8x8 m — comfortably above every size/LOD gate. */
const fixture = (type) => [{
  id: 1, zone_type: type, label: type,
  shape: { kind: 'Rect', x: 10, y: 10, w: 8, h: 8 },
  component_ids: [], origin: type === 'Unassigned' ? 'Residual' : 'Drawn',
}]
const statsFor = () => new Map([[1, { area: 64, capacity: 0 }]])

let pathChecked = 0
for (const [type, field] of [['Core', 'corePoche'], ['Unassigned', 'unassignedHatch']]) {
  const editor = S.planStyle('editor')
  const declared = editor[field]
  assert.ok(declared, `editor.${field} is not declared — this guard has drifted from the table`)

  // COUNT MARKS, NOT CALLS. `fillWith` emits save/beginPath/rect/clip/restore
  // BEFORE it consults the LOD ramp, so a texture whose ramp kills it still
  // raises the raw call count by five while putting no ink on the page. Counting
  // every call made this guard pass under the exact sabotage it exists to catch.
  const MARKS = new Set(['stroke', 'fill', 'fillRect', 'strokeRect', 'fillText', 'strokeText'])
  const marks = (ops) => ops.filter((o) => MARKS.has(o)).length

  const a = recordingCtx()
  P.drawZones(view(a.ctx), fixture(type), null, statsFor(), new Set())
  const withTexture = marks(a.ops)

  const saved = editor[field]
  editor[field] = null
  const b = recordingCtx()
  P.drawZones(view(b.ctx), fixture(type), null, statsFor(), new Set())
  const withoutTexture = marks(b.ops)
  editor[field] = saved

  assert.ok(
    withTexture > withoutTexture,
    `${type}: the declared ${field} emitted NO extra draw operations ` +
      `(${withTexture} marks with vs ${withoutTexture} without). The texture is declared ` +
      `and dead — check what the call site passes as fillWith's reference size; ` +
      `\`hatchLevel(0)\` is 0 and returns before drawing anything.`,
  )
  pathChecked++
}
assert.equal(pathChecked, 2, 'both zone textures must be exercised through the render path')

// ---------------------------------------------------------------------------
// GROUND CARRIES NO RESTING NAME — and the selection exception works for BOTH
// ground types, not just the one that happened to get checked by hand.
// ---------------------------------------------------------------------------
const groundFixture = (type) => [{
  id: 1, zone_type: type, label: type === 'Unassigned' ? 'Unassigned' : 'Corridor',
  shape: { kind: 'Rect', x: 10, y: 10, w: 8, h: 8 },
  component_ids: [], origin: type === 'Unassigned' ? 'Residual' : 'Drawn',
}]
for (const type of ['Circulation', 'Unassigned']) {
  const r1 = recordingCtx()
  const atRest = P.drawZones(view(r1.ctx), groundFixture(type), null, statsFor(), new Set())
  assert.equal(atRest.length, 0, `${type}: a resting ground zone emitted a tag`)

  const r2 = recordingCtx()
  const selected = P.drawZones(view(r2.ctx), groundFixture(type), null, statsFor(), new Set([1]))
  assert.equal(selected.length, 1,
    `${type}: SELECTED ground zone emitted no tag — the selection exception is broken, ` +
    'and a corridor you cannot name is a corridor you cannot edit')
}
// A program zone is untouched by any of this.
const prog = P.drawZones(view(recordingCtx().ctx),
  [{ id: 1, zone_type: 'Meeting', label: 'Boardroom',
     shape: { kind: 'Rect', x: 10, y: 10, w: 8, h: 8 }, component_ids: [], origin: 'Drawn' }],
  null, statsFor(), new Set())
assert.equal(prog.length, 1, 'a program zone lost its resting tag — suppression over-reached')

// ---------------------------------------------------------------------------
// THUMBNAILS obey the ground rule too — the card is the first thing anyone sees.
// ---------------------------------------------------------------------------
// `renderThumb` needs a real 2D context, which node has not got. What CAN be
// checked here without pixels is the decision: does the thumbnail consult the
// ground list at all? The pixel proof is the colour census in the evidence set
// (docs/evidence/circulation-audit/), which is the method that measured the
// 1 226 px Circulation-fill flood in the first place.
{
  const src = fs.readFileSync(path.join(here, 'paint.ts'), 'utf8')
  const body = src.slice(src.indexOf('export function renderThumb'))
  assert.ok(
    /groundZones/.test(body.slice(0, 2500)),
    'renderThumb no longer consults groundZones — the candidate cards will flood ground again',
  )
}

// ---------------------------------------------------------------------------
// THE SYMBOL FILL CENSUS — figure/ground, per category
// ---------------------------------------------------------------------------
//
// MEASURED RULE (W4). `research/qbiq-symbol-spec.json`
// `conventions.figure_ground.census`: of the reference's 2354 furniture-tier
// paths, **2084 carry an opaque white fill** (`fill_opacity 1.0`) and 270 are
// stroke-only. A furniture mark there is a filled body with an outline over it —
// that is what makes a desk read as an object standing ON the zone wash instead
// of a hollow frame the wash shows through.
//
// So: every symbol category must FILL BEFORE IT STROKES. The exemptions are
// named, with reasons, and the census asserts the exempt set is EXACTLY the set
// that draws no fill — so a new category that forgets its fill fails here rather
// than shipping as a transparent outline nobody notices.
//
// The population is parsed out of the switch in `symbols.ts`, for the same
// reason §7 of symbols.test.mjs does it: a hand-kept list certifies a vocabulary
// that has moved.
{
  const src = fs.readFileSync(path.join(here, 'symbols.ts'), 'utf8')
  const sw = src.slice(src.indexOf('switch (s.category)'), src.indexOf('default:'))
  const categories = [...sw.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1])
  assert.ok(categories.length >= 12,
    `only ${categories.length} categories parsed — the census has lost its population`)

  // DECLARED EXEMPTIONS. Each is a mark the reference ALSO draws as pure
  // line-work, so filling it would be the divergence, not the fix.
  const LINEWORK_ONLY = {
    Door: 'a leaf + swing arc; a filled slab would read as a wall',
    Window: 'the frame-glass-frame triple line; glazing is not opaque',
    FallCeiling: 'a reflected-ceiling overlay — filling it would hide the furniture beneath it',
  }

  const ink = { stroke: '#000', detail: '#888', fill: '#fff', seat: '#eee', accent: '#f00' }
  const unfilled = []
  for (const category of categories) {
    const ops = []
    const ctx = new Proxy({}, {
      get(_t, k) {
        if (typeof k === 'symbol') return undefined
        return (...a) => { ops.push(String(k)); return undefined }
      },
      set() { return true },
    })
    // 200 px/m: every LOD band fully on, so nothing is missed for being faded.
    S.drawSymbol(ctx, { category, cx: 0, cy: 0, w: 1.2, h: 0.9, rotation: 0, seats: 4 },
                 ink, { pxPerM: 200, dpr: 1 })
    const firstFill = Math.min(
      ...['fill', 'fillRect'].map((o) => (ops.indexOf(o) < 0 ? Infinity : ops.indexOf(o))))
    const firstStroke = Math.min(
      ...['stroke', 'strokeRect'].map((o) => (ops.indexOf(o) < 0 ? Infinity : ops.indexOf(o))))
    if (firstFill === Infinity) { unfilled.push(category); continue }
    assert.ok(firstFill < firstStroke,
      `${category}: strokes before it fills — the outline is drawn under the body, ` +
      'which is the figure/ground rule inverted (spec conventions.figure_ground)')
  }
  assert.deepEqual(unfilled.sort(), Object.keys(LINEWORK_ONLY).sort(),
    `the line-work-only set has drifted. Got [${unfilled}], declared ` +
    `[${Object.keys(LINEWORK_ONLY)}]. A category that stopped filling is a hollow ` +
    'symbol; one that started is an undeclared change to the drawing convention.')
  console.log(`  symbol fill census: ${categories.length - unfilled.length} of ` +
              `${categories.length} categories fill before they stroke; ` +
              `${unfilled.length} declared line-work only (${unfilled.join(', ')})`)
}

console.log(
  `PASS fillRenders: ${checked} declared fills valid; ${pathChecked} exercised through ` +
  `drawZones and proven to emit marks; ground silent at rest and named on selection ` +
  `(both types); paper declares neither poche nor hatch`,
)
