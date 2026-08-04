// Headless driver for the deliverable pack — the workbook + plan graphic +
// ground truth, for three independent inputs (gates G1–G5, G9).
//
// SAME CODE PATH AS THE APP. `web/src/export/qtoWorkbook.ts` `buildQtoPack` is
// the one function the Export menu calls; it needs a real `<canvas>` for the
// plan and the room thumbnails, so this script bundles it with esbuild and runs
// it inside headless Chromium via Playwright. Nothing is re-implemented for
// Node — the browser action and this harness call the identical function with
// identical arguments.
//
//   node scripts/export-pack.mjs [--out out] [--seed 7] [--cases seeded,dwg,testfit]
//
// Writes, per the artifact contract:
//   out/quantity-takeoff.xlsx     the 12-sheet, formula-wired workbook
//   out/plan.png                  master plan, 1040×780
//   out/plan.repeat.png           an INDEPENDENT re-render — G4 diffs the bytes
//   out/ground-truth.json         schema: spec/ground-truth.schema.json
//   out/thumbs/<RoomID>.png       one 240×180 crop per Inventory row
//   out/cases/<case>/{quantity-takeoff.xlsx,ground-truth.json,plan.png,plan.repeat.png}
//
// The `seeded` case is also mirrored into out/ itself, so the default gate
// invocation and G9 read the same generator.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc, buildDwgDoc, buildTestFitDoc } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const OUT = path.resolve(REPO, arg('--out', 'out'))
const SEED = Number(arg('--seed', '7'))
const CASES = arg('--cases', 'seeded,dwg,testfit')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(
  pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. bundle the ONE export path for the browser ---------------------------
const bundle = await build({
  stdin: {
    contents: `
      import { buildQtoPack } from './src/export/qtoWorkbook'
      import { classifyWalls } from './src/export/wallTypes'
      window.DS = { buildQtoPack, classifyWalls }
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

// --- 2. the documents, straight out of the Rust core -------------------------
const docs = {}
if (CASES.includes('seeded')) docs.seeded = await buildDemoDoc({ seed: SEED })
if (CASES.includes('testfit')) docs.testfit = await buildTestFitDoc()
if (CASES.includes('dwg')) docs.dwg = await buildDwgDoc({ esbuild: build })

// --- 3. render + build the workbook in headless Chromium ---------------------
const browser = await chromium.launch()
const page = await browser.newPage()
await page.addScriptTag({ content: code })

const results = {}
for (const [name, doc] of Object.entries(docs)) {
  results[name] = await page.evaluate(
    async ({ state, circulation, wallTypes, quantities, plate, project }) => {
      const b64 = (u8) => {
        let s = ''
        const CH = 0x8000
        for (let i = 0; i < u8.length; i += CH) {
          s += String.fromCharCode.apply(null, u8.subarray(i, i + CH))
        }
        return btoa(s)
      }
      const wallSpans = window.DS.classifyWalls(state, wallTypes)
      const pack = await window.DS.buildQtoPack(state, quantities, {
        circulation,
        plate,
        wallSpans,
        project,
        floor: 1,
      })
      return {
        xlsx: b64(pack.xlsx),
        plan: b64(pack.planPng),
        repeat: b64(pack.planRepeatPng),
        groundTruth: pack.groundTruth,
        thumbs: pack.thumbs.map((t) => ({ id: t.id, png: b64(t.png) })),
        rooms: pack.model.rooms.length,
      }
    },
    {
      state: doc.state,
      circulation: doc.circulation,
      wallTypes: doc.wallTypes,
      quantities: doc.quantities,
      plate: doc.plate,
      project: `DSource — ${name}`,
    },
  )
}
await browser.close()

// --- 4. write the artifacts ---------------------------------------------------
const w = (p, b64) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.from(b64, 'base64'))
}

function writeCase(dir, r, withThumbs) {
  fs.mkdirSync(dir, { recursive: true })
  w(path.join(dir, 'quantity-takeoff.xlsx'), r.xlsx)
  w(path.join(dir, 'plan.png'), r.plan)
  w(path.join(dir, 'plan.repeat.png'), r.repeat)
  // `renders` is the render agent's block (G6 reads it); this generator never
  // produces it, so carry any existing one through instead of clobbering it.
  const gtPath = path.join(dir, 'ground-truth.json')
  let renders = null
  if (fs.existsSync(gtPath)) {
    try {
      renders = JSON.parse(fs.readFileSync(gtPath, 'utf8')).renders ?? null
    } catch {
      renders = null
    }
  }
  const gt = renders ? { ...r.groundTruth, renders } : r.groundTruth
  fs.writeFileSync(gtPath, JSON.stringify(gt, null, 2))
  if (withThumbs) {
    const td = path.join(dir, 'thumbs')
    fs.rmSync(td, { recursive: true, force: true })
    for (const t of r.thumbs) w(path.join(td, `${t.id}.png`), t.png)
  }
}

for (const [name, r] of Object.entries(results)) {
  writeCase(path.join(OUT, 'cases', name), r, false)
  const gt = r.groundTruth
  console.log(
    `${name.padEnd(8)} seed ${String(docs[name].seed).padEnd(3)} rooms ${String(r.rooms).padStart(3)} · walls ` +
      `${Object.entries(gt.walls).map(([k, v]) => `${k} ${v.lengthM.toFixed(2)}`).join(', ')} · ` +
      `doors ${gt.doorCount} · xlsx ${Math.round((r.xlsx.length * 3) / 4 / 1024)}KB`,
  )
}

// The default artifact set that G1–G5 read lives at the top of out/.
const primary = results.seeded ?? Object.values(results)[0]
if (primary) {
  writeCase(OUT, primary, true)
  console.log(
    `wrote ${path.relative(REPO, OUT)}/{quantity-takeoff.xlsx, plan.png, plan.repeat.png, ` +
      `ground-truth.json, thumbs/} + ${Object.keys(results).length} case(s)`,
  )
}
