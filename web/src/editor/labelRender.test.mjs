// ZONE-LABEL COMPOSITION + GROUND-COVERAGE gate (Workstream C, fix/label-render).
//
// Run from web/:  node src/editor/labelRender.test.mjs
//
// @covers: web/src/editor/paint.ts  (drawZones label composition, drawZoneTags)
//
// THE DEFECT (before-evidence: reports/editor-completion/before/label-garble-crop.png).
// Zone 680's tag rendered "434 m²··101 pax" — a phantom second separator — and the
// user's original screenshot showed a garbled second string under the label. The
// composer emits EXACTLY ONE U+00B7 (byte-verified in source); the phantom glyphs
// are furniture linework showing through the knockout halo, because the halo is
// `strokeText` of the glyph run: spaces carry no glyph ink, so the ` · ` region
// leaves an uncovered channel over the desk ink beneath. See
// reports/editor-completion/C-preregistration.md (hypotheses C-1/C-2).
//
// TWO PROPERTIES, anchored per gate-independence ("a prescribed fix is a
// hypothesis — anchor the gate to the property"):
//
//  P1 COMPOSITION. A zone with known {label, area, capacity} composes exactly one
//     separator between the area and pax fragments, and every drawn line is one
//     recoverable glyph run — the string handed to fillText is the composed line
//     verbatim (the D3 lesson: wrapping/duplication destroys recoverability).
//
//  P2 GROUND COVERAGE. When a resting label overlaps furniture (halo engaged),
//     the renderer must establish a CONTINUOUS ground under each line's full
//     measured extent — including the spaces — before filling the text. A
//     glyph-outline stroke cannot satisfy this by construction: a stroke of a
//     space covers nothing, which is the defect itself. So only geometry-complete
//     paints (a filled rect/path whose bbox covers the line) count as ground.
//     Watched RED on pre-fix code (halo = strokeText only), then green.
//
// The recorder-ctx method follows fillRenders.test.mjs: bundle paint+planStyle as
// ONE esbuild module, drive the real functions, record every primitive.

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labelrender-'))
const entry = path.join(tmp, 'entry.ts')
fs.writeFileSync(entry, `
  export * from ${JSON.stringify(path.join(here, 'planStyle.ts'))}
  export { drawZones, drawZoneTags } from ${JSON.stringify(path.join(here, 'paint.ts'))}
`)
const outAll = path.join(tmp, 'all.mjs')
await build({
  entryPoints: [entry], outfile: outAll, bundle: true, format: 'esm',
  platform: 'neutral', target: 'es2022', logLevel: 'silent',
})
const M = await import(pathToFileURL(outAll).href)

// ---------------------------------------------------------------------------
// Recorder canvas context. Deterministic glyph metrics: width = 0.6 * px * len.
// The assertions measure with the SAME model, so coverage comparisons are exact.
// ---------------------------------------------------------------------------
const fontPx = (font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font))
  return m ? Number(m[1]) : 10
}
const measure = (text, font) => text.length * fontPx(font) * 0.6

function recorder() {
  const ops = []
  let pathBox = null
  const grow = (x, y) => {
    if (!pathBox) pathBox = { minX: x, minY: y, maxX: x, maxY: y }
    else {
      pathBox.minX = Math.min(pathBox.minX, x)
      pathBox.minY = Math.min(pathBox.minY, y)
      pathBox.maxX = Math.max(pathBox.maxX, x)
      pathBox.maxY = Math.max(pathBox.maxY, y)
    }
  }
  const state = { font: '10px sans-serif', fillStyle: '', strokeStyle: '', lineWidth: 1 }
  const ctx = {
    canvas: { width: 1200, height: 800 },
    set font(v) { state.font = v },
    get font() { return state.font },
    set fillStyle(v) { state.fillStyle = v },
    get fillStyle() { return state.fillStyle },
    set strokeStyle(v) { state.strokeStyle = v },
    get strokeStyle() { return state.strokeStyle },
    set lineWidth(v) { state.lineWidth = v },
    get lineWidth() { return state.lineWidth },
    textAlign: 'left', textBaseline: 'alphabetic', lineJoin: 'miter',
    shadowColor: '', shadowBlur: 0, shadowOffsetY: 0, globalAlpha: 1,
    save() {}, restore() {}, setLineDash() {}, clip() {},
    beginPath() { pathBox = null },
    closePath() {},
    moveTo(x, y) { grow(x, y) },
    lineTo(x, y) { grow(x, y) },
    arcTo(x1, y1, x2, y2) { grow(x1, y1); grow(x2, y2) },
    arc(x, y, r) { grow(x - r, y - r); grow(x + r, y + r) },
    rect(x, y, w, h) { grow(x, y); grow(x + w, y + h) },
    fill() { ops.push({ op: 'fillPath', box: pathBox && { ...pathBox }, fillStyle: state.fillStyle }) },
    stroke() { ops.push({ op: 'strokePath', box: pathBox && { ...pathBox } }) },
    fillRect(x, y, w, h) {
      ops.push({ op: 'fillRect', box: { minX: x, minY: y, maxX: x + w, maxY: y + h }, fillStyle: state.fillStyle })
    },
    strokeRect() {},
    fillText(text, x, y) { ops.push({ op: 'fillText', text, x, y, font: state.font, fillStyle: state.fillStyle }) },
    strokeText(text, x, y) { ops.push({ op: 'strokeText', text, x, y, font: state.font, lineWidth: state.lineWidth }) },
    measureText(text) { return { width: measure(text, state.font) } },
    translate() {}, scale() {}, rotate() {}, drawImage() {}, createPattern() { return null },
  }
  return { ops, ctx }
}

const view = (ctx, scale = 12) => ({
  ctx, scale, offset: { x: 0, y: 0 }, presentation: false,
  toScreen: (wx, wy) => ({ x: wx * scale, y: wy * scale }),
  toWorld: (sx, sy) => ({ x: sx / scale, y: sy / scale }),
})

// The fixture: zone 680's published truth (scripts/fixtures/zone-dump.furniture-plan.json).
const AREA = 433.6
const CAP = 101
const LABEL = 'Open Workspace (1)'
const EXPECT_METRICS = '434 m² · 101 pax'
const SEPARATORS = /[·•‧∙⋅]/g // middot, bullet, hyphenation pt, bullet op, dot op

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }

// ---------------------------------------------------------------------------
// P1 — composition, both shape branches of drawZones.
// ---------------------------------------------------------------------------
const statFor = (id) => new Map([[id, { area: AREA, capacity: CAP }]])

const rectZone = {
  id: 680, label: LABEL, zone_type: 'Meeting',
  shape: { kind: 'Rect', x: 10, y: 5, w: 20, h: 10 },
}
const polyZone = {
  id: 681, label: LABEL, zone_type: 'Meeting',
  shape: { kind: 'Poly', pts: [[0, 0], [20, 0], [20, 10], [0, 10]] },
}

for (const [branch, zone] of [['Rect', rectZone], ['Poly', polyZone]]) {
  const { ctx } = recorder()
  const tags = M.drawZones(view(ctx), [zone], null, statFor(zone.id))
  ok(tags.length === 1, `${branch}: one tag collected`)
  const t = tags[0]
  ok(t.metrics === EXPECT_METRICS,
    `${branch}: metrics composed verbatim — got ${JSON.stringify(t.metrics)}, want ${JSON.stringify(EXPECT_METRICS)}`)
  const seps = t.metrics.match(SEPARATORS) ?? []
  ok(seps.length === 1, `${branch}: exactly one separator glyph (got ${seps.length})`)
  ok(!/\n/.test(t.metrics) && !/\n/.test(t.name), `${branch}: single-line fragments (no wrap)`)
  ok(!/ {2,}/.test(t.metrics), `${branch}: no doubled whitespace`)
}

// ---------------------------------------------------------------------------
// P2 — ground coverage when the halo engages (label resting on furniture).
// ---------------------------------------------------------------------------
const covers = (box, minX, minY, maxX, maxY, tol = 0.51) =>
  box && box.minX <= minX + tol && box.minY <= minY + tol &&
  box.maxX >= maxX - tol && box.maxY >= maxY - tol

function drawWithObstacles(obstacles, highlight) {
  const { ops, ctx } = recorder()
  const tag = {
    id: 680, name: LABEL.toUpperCase(), metrics: EXPECT_METRICS,
    cx: 120, cy: 60, bx: 0, by: 0, bw: 240, bh: 120, namePx: 10, color: '#334',
  }
  M.drawZoneTags(view(ctx), [tag], highlight, obstacles)
  return ops
}

// One obstacle blanketing the zone: wherever the label lands, it overlaps.
const blanket = [{ x: 120, y: 60, w: 240, h: 120 }]
const opsHalo = drawWithObstacles(blanket)

const fillTexts = opsHalo.filter((o) => o.op === 'fillText')
ok(fillTexts.length === 2, `halo case: two lines drawn (got ${fillTexts.length})`)
for (const ft of fillTexts) {
  ok(ft.text === LABEL.toUpperCase() || ft.text === EXPECT_METRICS,
    `line is one recoverable glyph run, verbatim — got ${JSON.stringify(ft.text)}`)
}

// THE gate: each line's full extent — spaces included — must be grounded by a
// geometry-complete paint BEFORE the text is filled. strokeText does not count:
// a glyph-outline stroke covers no ink under a space character, by construction.
for (const ft of fillTexts) {
  const px = fontPx(ft.font)
  const w = measure(ft.text, ft.font)
  const minX = ft.x - w / 2, maxX = ft.x + w / 2 // ctx.textAlign = 'center'
  const minY = ft.y - px / 2, maxY = ft.y + px / 2 // ctx.textBaseline = 'middle'
  const before = opsHalo.slice(0, opsHalo.indexOf(ft))
  const grounded = before.some(
    (o) => (o.op === 'fillRect' || o.op === 'fillPath') && covers(o.box, minX, minY, maxX, maxY),
  )
  ok(grounded,
    `GROUND COVERAGE: line ${JSON.stringify(ft.text)} must sit on a continuous ` +
    `ground covering [${minX.toFixed(1)}..${maxX.toFixed(1)}] x ` +
    `[${minY.toFixed(1)}..${maxY.toFixed(1)}] — none found among ${before.length} prior ops`)
}

// Hot (selected) case: the pill IS the ground — but it must be drawn at the
// PLACED anchor, not the zone centre. Pre-fix, the pill's fill was issued at
// (t.cx, t.cy) while its hairline and the text sit at the placed (ax, ay); when
// the placement ladder moves the label off-centre the text lands beside its own
// pill. Same property as above: each line's extent sits on a prior ground.
const opsHot = drawWithObstacles(blanket, new Set([680]))
const hotTexts = opsHot.filter((o) => o.op === 'fillText')
ok(hotTexts.length === 2, `hot case: two lines drawn (got ${hotTexts.length})`)
for (const ft of hotTexts) {
  const px = fontPx(ft.font)
  const w = measure(ft.text, ft.font)
  const before = opsHot.slice(0, opsHot.indexOf(ft))
  const grounded = before.some(
    (o) => (o.op === 'fillRect' || o.op === 'fillPath') &&
      covers(o.box, ft.x - w / 2, ft.y - px / 2, ft.x + w / 2, ft.y + px / 2),
  )
  ok(grounded,
    `HOT PILL ANCHOR: line ${JSON.stringify(ft.text)} must sit on its own pill — ` +
    `no prior ground covers it (pill filled at the zone centre instead of the placed anchor?)`)
}

// Control: on clear floor (no obstacles) the resting label stays bare — no halo,
// no ground slab. Guards the halo's gating, so the fix cannot "pass" by slabbing
// every label on the sheet.
const opsBare = drawWithObstacles([])
ok(opsBare.filter((o) => o.op === 'fillText').length === 2, 'bare case: both lines drawn')
ok(!opsBare.some((o) => o.op === 'strokeText'), 'bare case: no halo stroke on clear floor')
ok(!opsBare.some((o) => o.op === 'fillRect' || o.op === 'fillPath'), 'bare case: no ground slab on clear floor')

// ---------------------------------------------------------------------------
// P3 — viewport-aware anchoring (the Phase 0 "no label at 35 px/m" defect).
// The label was drawn but anchored by GLOBAL clearance over the whole zone, so
// zooming into one end of a long room put its only label off-screen (measured:
// at 35 px/m over zone 680's north end the label drew at y=862 in an 818 px
// viewport). Property: when any part of the zone can host the label on-screen,
// the label is placed on-screen; when none can, it still draws (no cull).
// ---------------------------------------------------------------------------
const tallTag = {
  id: 900, name: LABEL.toUpperCase(), metrics: EXPECT_METRICS,
  cx: 190, cy: 450, bx: 0, by: 0, bw: 380, bh: 900, namePx: 10, color: '#334',
}
function drawTall(viewport) {
  const { ops, ctx } = recorder()
  M.drawZoneTags(view(ctx), [{ ...tallTag }], undefined, [], viewport)
  return ops.filter((o) => o.op === 'fillText')
}

// Zone extends far below a short viewport; the zone centre (the pre-fix anchor)
// is off-screen, but plenty of on-screen zone can host the label.
const vp = { w: 400, h: 300 }
const inVp = drawTall(vp)
ok(inVp.length === 2, `viewport case: both lines drawn (got ${inVp.length})`)
for (const ft of inVp) {
  ok(ft.x >= 0 && ft.x <= vp.w && ft.y >= 0 && ft.y <= vp.h,
    `VIEWPORT ANCHOR: line ${JSON.stringify(ft.text)} drawn at (${ft.x.toFixed(0)},${ft.y.toFixed(0)}) ` +
    `must be inside the ${vp.w}x${vp.h} viewport when on-screen zone can host it`)
}

// Viewport too short to host the label at all: fall back to the old behaviour
// (drawn off-screen), never culled.
const tiny = drawTall({ w: 400, h: 8 })
ok(tiny.length === 2, 'unhostable viewport: label still drawn (fallback, no cull)')

// No viewport supplied (headless harnesses): behaviour unchanged, label drawn.
const noVp = drawTall(undefined)
ok(noVp.length === 2, 'no viewport: label drawn as before')

console.log(`labelRender: OK (${checks} checks)`)
