// Headless driver for the plan graphic + room thumbnails (gates G4, G5).
//
// SAME CODE PATH AS THE APP. There is one renderer — `web/src/export/
// planGraphic.ts` + `roomThumbs.ts` — and it needs a real `<canvas>`, so this
// script bundles those modules with esbuild and runs them inside headless
// Chromium via Playwright. Nothing is re-implemented for Node; the browser
// export action calls the very same functions with the very same arguments.
//
//   node scripts/render-plan.mjs [--out out] [--seed 7] [--scale 1]
//
// Writes:
//   out/plan.png            the workbook's master plan, 1040×780
//   out/plan.repeat.png     an INDEPENDENT re-render of the same seed — G4
//                           diffs the bytes to prove determinism
//   out/plan@2x.png         the same plan at 2080×1560
//   out/thumbs/<RoomID>.png one 240×180 crop per Inventory room
//   out/plan-labels.json    { labels, rooms } — feeds ground-truth.planLabels

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const OUT = path.resolve(REPO, arg('--out', 'out'))
const SEED = Number(arg('--seed', '7'))

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. the document, straight out of the Rust core --------------------------
const { state, circulation, wallTypes, plate } = await buildDemoDoc({ seed: SEED })
console.log(
  `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
    `${(state.zones ?? []).length} zones · seed ${SEED}`,
)

// --- 2. bundle the renderers for the browser --------------------------------
const bundle = await build({
  stdin: {
    contents: `
      import { renderHighlightedPlan, planRoomList } from './src/export/planGraphic'
      import { renderRoomThumbnail } from './src/export/roomThumbs'
      import { classifyWalls } from './src/export/wallTypes'
      window.DS = { renderHighlightedPlan, planRoomList, renderRoomThumbnail, classifyWalls }
    `,
    resolveDir: path.join(REPO, 'web'),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'warning',
})
const code = bundle.outputFiles[0].text

// --- 3. render in headless Chromium ------------------------------------------
const browser = await chromium.launch()
const page = await browser.newPage()
await page.addScriptTag({ content: code })

const result = await page.evaluate(
  async ({ state, circulation, wallTypes, plate }) => {
    const b64 = (u8) => {
      let s = ''
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
      return btoa(s)
    }
    // The CORE's classification, not the TS fallback — one source for the
    // coloured plan, the thumbnails and the workbook's wall quantities.
    const wallSpans = window.DS.classifyWalls(state, wallTypes)
    const opts = { circulation, plate, wallSpans }
    const one = await window.DS.renderHighlightedPlan(state, opts)
    // An INDEPENDENT second render — fresh canvases, same inputs (G4's twin).
    const two = await window.DS.renderHighlightedPlan(state, opts)
    const hi = await window.DS.renderHighlightedPlan(state, { ...opts, scale: 2 })
    const rooms = window.DS.planRoomList(state)
    const thumbs = []
    for (const r of rooms) {
      const png = await window.DS.renderRoomThumbnail(state, r.id, { wallSpans })
      thumbs.push({ id: r.id, label: r.label, png: b64(png) })
    }
    return { plan: b64(one.png), repeat: b64(two.png), hi: b64(hi.png), labels: one.labels, rooms, thumbs }
  },
  { state, circulation, wallTypes, plate },
)
await browser.close()

// --- 4. write the artifacts ---------------------------------------------------
fs.mkdirSync(OUT, { recursive: true })
const thumbDir = path.join(OUT, 'thumbs')
fs.rmSync(thumbDir, { recursive: true, force: true })
fs.mkdirSync(thumbDir, { recursive: true })

const w = (p, b64) => fs.writeFileSync(p, Buffer.from(b64, 'base64'))
w(path.join(OUT, 'plan.png'), result.plan)
w(path.join(OUT, 'plan.repeat.png'), result.repeat)
w(path.join(OUT, 'plan@2x.png'), result.hi)
for (const t of result.thumbs) w(path.join(thumbDir, `${t.id}.png`), t.png)

fs.writeFileSync(
  path.join(OUT, 'plan-labels.json'),
  JSON.stringify({ seed: SEED, labels: result.labels, rooms: result.rooms }, null, 2),
)

const dup = result.labels.filter((l, i) => result.labels.indexOf(l) !== i)
console.log(
  `wrote plan.png (${fs.statSync(path.join(OUT, 'plan.png')).size} B) · ` +
    `plan.repeat.png (${fs.statSync(path.join(OUT, 'plan.repeat.png')).size} B) · ` +
    `${result.thumbs.length} thumbnails · ${result.labels.length} labels` +
    (dup.length ? ` · DUPLICATE LABELS: ${dup.join(', ')}` : ''),
)
