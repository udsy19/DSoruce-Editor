// Capture every edited-plan fixture through the EDITOR'S OWN renderer.
//
//   node scripts/capture-fixtures.mjs [--out docs/evidence/qbiq-parity-q3] [--tag before]
//
// Writes  <out>/<tag>/<fixture>@<zoom>.png  for F1..F5 × {fit, 2x, 4x}
// plus    <out>/<tag>/manifest.json         with the document's own counts.
//
// WHY IT RENDERS THE WAY IT DOES. The plan sequence is `paint.ts::paintPlan` —
// the same function `EditorCanvas.render()` calls, not a re-implementation. That
// mattered enough to refactor for: a capture harness with its own draw order is
// measuring a renderer nobody ships. What this script owns is only what is NOT
// the plan — the mat, the white plate under the footprint, the viewport.
//
// PROVENANCE. esbuild bundles from source on every run, so there is no stale
// build to photograph — but the rule is that a capture asserts its own
// provenance rather than being trusted, so the bundle is grepped for a token
// from the change under test before a single pixel is written. A screenshot from
// a stale build is indistinguishable from a screenshot of a broken feature.
//
// The fixtures come from the CORE (`Editor.load_fixture`), so these images and
// `crates/ds-core/src/metrics_tests.rs` are looking at the same documents.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const OUT = path.resolve(REPO, arg('--out', 'docs/evidence/qbiq-parity-q3'), arg('--tag', 'current'))
const W = Number(arg('--width', '1400'))
const H = Number(arg('--height', '900'))

// Tokens that must appear in the bundled renderer. Each names a change this
// capture is evidence for; a missing one means the page would draw the old
// picture and the capture would be a lie told confidently.
const PROVENANCE_TOKENS = ['paintPlan', 'drawWallNetwork', 'drawZoneTags']

// How many label draws may land on furniture across the whole capture set.
// MEASURED IN BOTH DIRECTIONS, not chosen: with tags pinned to their zone
// centres (the shipped behaviour, reproduced in a disposable worktree) the set
// scores **127 of 211**; with furniture-aware placement it scores **29 of 205**.
// The budget sits just above the achieved number so a regression toward
// centre-pinning fails loudly, and it is a BUDGET rather than zero because a
// small room whose table fills it has nowhere else for its own tag to go.
const FURNITURE_OVERLAP_BUDGET = Number(arg('--furniture-budget', '32'))

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(
  pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. the documents, straight out of the core ------------------------------
const wasmDir = path.join(REPO, 'web/src/wasm')
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
wasm.initSync({ module: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

const FIXTURES = Editor.fixture_ids()
const docs = FIXTURES.map((id) => {
  const ed = new Editor()
  ed.load_fixture(id)
  const state = ed.state()
  return {
    id,
    state,
    zoneStats: ed.zone_stats(),
    plate: ed.plate() ?? null,
    outlines: ed.wall_outlines(),
    metrics: ed.metrics(),
  }
})

// --- 2. bundle the renderer, then PROVE it is the one under test -------------
const entry = path.join(os.tmpdir(), `q3-capture-entry-${process.pid}.ts`)
fs.writeFileSync(
  entry,
  `import * as paint from ${JSON.stringify(path.join(REPO, 'web/src/editor/paint.ts'))}\n` +
    `import * as style from ${JSON.stringify(path.join(REPO, 'web/src/editor/planStyle.ts'))}\n` +
    `;(globalThis as any).__paint = paint;(globalThis as any).__style = style\n`,
)
const bundlePath = path.join(os.tmpdir(), `q3-capture-${process.pid}.js`)
await build({
  entryPoints: [entry],
  outfile: bundlePath,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  logLevel: 'silent',
})
const bundleSrc = fs.readFileSync(bundlePath, 'utf8')
for (const tok of PROVENANCE_TOKENS) {
  if (!bundleSrc.includes(tok)) {
    console.error(
      `provenance FAILED: the bundled renderer does not contain ${tok}. ` +
        'Refusing to write captures that would not be of the code under test.',
    )
    process.exit(1)
  }
}
console.log(`provenance ok — bundle carries ${PROVENANCE_TOKENS.join(', ')}`)

// --- 3. render ---------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.setContent('<body style="margin:0"><canvas id="c"></canvas></body>')
await page.addScriptTag({ content: bundleSrc })

const ZOOMS = [
  { name: 'fit', k: 1 },
  { name: '2x', k: 2 },
  { name: '4x', k: 4 },
]
const manifest = []
const collisions = []

for (const d of docs) {
  for (const z of ZOOMS) {
    const png = await page.evaluate(
      ({ doc, zoom, w, h }) => {
        const paint = globalThis.__paint
        const style = globalThis.__style
        const canvas = document.getElementById('c')
        canvas.width = w
        canvas.height = h
        canvas.style.width = w + 'px'
        canvas.style.height = h + 'px'
        const ctx = canvas.getContext('2d')

        // Fit the wall bbox, then zoom about the plan's centre.
        const bb = paint.wallBbox(doc.state.walls) ?? { minX: 0, minY: 0, maxX: 10, maxY: 10 }
        const pad = 40
        const fit = Math.min((w - pad * 2) / (bb.maxX - bb.minX), (h - pad * 2) / (bb.maxY - bb.minY))
        const scale = fit * zoom.k
        const cx = (bb.minX + bb.maxX) / 2
        const cy = (bb.minY + bb.maxY) / 2
        const offset = { x: w / 2 - cx * scale, y: h / 2 - cy * scale }
        const view = {
          ctx,
          scale,
          offset,
          presentation: false,
          toScreen: (wx, wy) => ({ x: wx * scale + offset.x, y: wy * scale + offset.y }),
          toWorld: (sx, sy) => ({ x: (sx - offset.x) / scale, y: (sy - offset.y) / scale }),
        }

        // Chrome only — everything below this line is `paintPlan`, i.e. the app's.
        ctx.fillStyle = style.C.mat
        ctx.fillRect(0, 0, w, h)
        const p0 = view.toScreen(bb.minX, bb.minY)
        const p1 = view.toScreen(bb.maxX, bb.maxY)
        ctx.fillStyle = style.C.surface
        ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)

        // TAG CENSUS, taken at the CANVAS API. Every `fillText` the plan
        // sequence emits is recorded with its real measured extent, so the
        // collision check is over what was actually drawn — not over a
        // "no collisions" flag the renderer could hand us, and not over
        // screenshot pixels that cannot tell a label from a desk edge.
        const texts = []
        const realFill = ctx.fillText.bind(ctx)
        ctx.fillText = function (t, x, y) {
          const m = ctx.measureText(t)
          const asc = m.actualBoundingBoxAscent ?? 6
          const desc = m.actualBoundingBoxDescent ?? 3
          texts.push({ t, x: x - m.width / 2, y: y - asc, w: m.width, h: asc + desc })
          return realFill(t, x, y)
        }

        const stats = new Map(doc.zoneStats.map((s) => [s.id, s]))
        paint.paintPlan(view, doc.state, {
          platePoly: doc.plate,
          zoneStats: stats,
          exteriorIds: new Set(doc.outlines.filter((o) => o.exterior).map((o) => o.wall)),
          outlines: doc.outlines,
        })
        ctx.fillText = realFill
        // The furniture, in the same screen space as the recorded text boxes.
        // A label over a desk is the defect that was actually on screen; label
        // over label was already prevented and measuring it proves nothing.
        const furniture = doc.state.components.map((c) => {
          const p = view.toScreen(c.x, c.y)
          const w2 = Math.abs(c.w * scale) / 2
          const h2 = Math.abs(c.h * scale) / 2
          return { x: p.x - w2, y: p.y - h2, w: w2 * 2, h: h2 * 2 }
        })
        return {
          png: canvas.toDataURL('image/png').slice('data:image/png;base64,'.length),
          texts,
          furniture,
        }
      },
      { doc: d, zoom: z, w: W, h: H },
    )
    const file = path.join(OUT, `${d.id}@${z.name}.png`)
    fs.writeFileSync(file, Buffer.from(png.png, 'base64'))

    // THE COLLISION GATE. Pairwise overlap over the recorded text boxes. This
    // fails the capture run, so a regression cannot be photographed and shipped
    // as evidence of an improvement.
    const boxes = png.texts
    const clashes = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          clashes.push(`${JSON.stringify(a.t)} x ${JSON.stringify(b.t)}`)
        }
      }
    }
    // Label OVER FURNITURE — the defect the captures actually showed.
    const rect = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    const onFurniture = boxes.filter((t) => png.furniture.some((f) => rect(t, f))).map((t) => t.t)
    collisions.push({
      id: d.id,
      zoom: z.name,
      texts: boxes.length,
      furniture: png.furniture.length,
      clashes,
      onFurniture,
    })
    // A capture that cannot fail loudly reports success quietly.
    const bytes = fs.statSync(file).size
    if (bytes < 1000) {
      console.error(`${file} is ${bytes} bytes — that is not a rendered plan`)
      process.exit(1)
    }
  }
  manifest.push({
    id: d.id,
    walls: d.state.walls.length,
    components: d.state.components.length,
    zones: (d.state.zones ?? []).length,
    outlineSegs: d.outlines.length,
    plateState: d.metrics.plate_state,
    gea: Math.round(d.metrics.gross_external_area * 100) / 100,
    nia: Math.round(d.metrics.net_internal_area * 100) / 100,
    efficiency: Math.round(d.metrics.efficiency_pct * 10) / 10,
  })
  console.log(
    `${d.id}: ${d.state.walls.length} walls -> ${d.outlines.length} outline segs · ` +
      `${d.state.components.length} components · plate ${d.metrics.plate_state}`,
  )
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync(path.join(OUT, 'tag-census.json'), JSON.stringify(collisions, null, 2) + '\n')
const totalTexts = collisions.reduce((n, c) => n + c.texts, 0)
const bad = collisions.filter((c) => c.clashes.length)
// NON-VACUITY: a census that recorded nothing would report zero collisions and
// mean nothing at all. The plans carry room tags; if none were drawn, the
// instrument is the finding.
if (totalTexts < 20) {
  console.error(`tag census recorded only ${totalTexts} text draws — the instrument is broken`)
  process.exit(1)
}
console.log(`tag census: ${totalTexts} text draws across ${collisions.length} captures`)
const onFurn = collisions.reduce((n, c) => n + c.onFurniture.length, 0)
if (bad.length) {
  for (const c of bad) console.error(`  ${c.id}@${c.zoom}: ${c.clashes.length} — ${c.clashes.join(' | ')}`)
  console.error(`TAG COLLISIONS (label x label): ${bad.length} capture(s) affected`)
  process.exitCode = 1
} else {
  console.log('tag census: 0 label-on-label collisions')
}
// NON-VACUITY for the furniture check: these plans are furnished, so a zero
// here with no furniture recorded would mean the boxes never arrived.
const totalFurn = collisions.reduce((n, c) => n + c.furniture, 0)
if (totalFurn < 100) {
  console.error(`furniture census recorded ${totalFurn} boxes — the instrument is broken`)
  process.exit(1)
}
console.log(`tag census: ${onFurn} label draw(s) land on furniture (of ${totalTexts}, over ${totalFurn} furniture boxes)`)
if (onFurn > FURNITURE_OVERLAP_BUDGET) {
  for (const c of collisions.filter((x) => x.onFurniture.length))
    console.error(`  ${c.id}@${c.zoom}: ${c.onFurniture.join(' | ')}`)
  console.error(`LABELS ON FURNITURE: ${onFurn} > budget ${FURNITURE_OVERLAP_BUDGET}`)
  process.exitCode = 1
}
await browser.close()
fs.rmSync(entry, { force: true })
fs.rmSync(bundlePath, { force: true })
console.log(`wrote ${docs.length * ZOOMS.length} captures to ${OUT}`)
