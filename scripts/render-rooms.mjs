// Headless driver for the per-room hero stills (gate G6).
//
// SAME CODE PATH AS THE APP — mirrors scripts/render-plan.mjs exactly. There is
// one renderer (`web/src/export/roomRenders.ts` over `web/src/three/
// materialTheme.ts` + `interiorStill.ts`); it needs a real WebGL context, so
// this script bundles those modules with esbuild and runs them inside headless
// Chromium via Playwright. Nothing is re-implemented for Node.
//
//   node scripts/render-rooms.mjs [--out out] [--seed 7] [--width 3840] [--height 2160]
//
// Writes:
//   out/renders/<Space>.png      Reception · Open_space · Work_stations · Conference_room
//   out/renders/manifest.json    camera + floor-material + floorRect per still
//   out/ground-truth.json        MERGED — only the `renders` block is touched, so
//                                the workbook agent's rooms/walls/doors survive.
//
// Chromium is launched with --use-angle=metal, which gives real hardware GL on
// macOS; it silently falls back to SwiftShader elsewhere (the renderer detects
// a software rasterizer and drops GTAO, exactly as Viewer3D does).

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc, zoneAreaPairs } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}

const OUT = path.resolve(REPO, arg('--out', 'out'))
const SEED = Number(arg('--seed', '7'))
const WIDTH = Number(arg('--width', '3840'))
const HEIGHT = Number(arg('--height', '2160'))
const EXPOSURE = Number(arg('--exposure', '1.15'))
const LAMP = Number(arg('--lamp', '2'))

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(
  pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. the document, straight out of the Rust core --------------------------
const { state, wallTypes, plate, quantities } = await buildDemoDoc({ seed: SEED })
const zoneAreas = zoneAreaPairs(quantities)
console.log(
  `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
    `${(state.zones ?? []).length} zones · seed ${SEED}`,
)

// --- 2. bundle the renderer for the browser ---------------------------------
const bundle = await build({
  stdin: {
    contents: `
      import { renderRoomPack, roomRenderGroundTruth } from './src/export/roomRenders'
      import { classifyWalls } from './src/export/wallTypes'
      window.DS = { renderRoomPack, roomRenderGroundTruth, classifyWalls }
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
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => console.log('  [page error]', e.message))
await page.addScriptTag({ content: code })
if (argv.includes('--camera-debug')) await page.evaluate(() => { window.DS_CAMERA_DEBUG = true })

const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2')
  const d = c && c.getExtension('WEBGL_debug_renderer_info')
  return d ? String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown'
})
console.log(`gpu: ${gl}`)

const result = await page.evaluate(
  async ({ state, wallTypes, plate, width, height, exposure, lamp, zoneAreas }) => {
    const b64 = (u8) => {
      let s = ''
      const chunk = 0x8000
      for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
      }
      return btoa(s)
    }
    // The CORE's wall classification — one source for the coloured plan, the
    // 3D fabric and the workbook's wall quantities.
    const wallSpans = window.DS.classifyWalls(state, wallTypes)
    const pack = await window.DS.renderRoomPack(state, {
      wallSpans,
      plate,
      width,
      height,
      exposure,
      lampIntensity: lamp,
      zoneAreas: new Map(zoneAreas),
    })
    return {
      renders: window.DS.roomRenderGroundTruth(pack),
      stills: pack.map((r) => ({
        key: r.key,
        title: r.title,
        roomId: r.roomId,
        roomLabel: r.roomLabel,
        floorMaterial: r.floorMaterial,
        floorCheck: r.floorCheck,
        floorRect: r.floorRect,
        floorRectPurity: r.floorRectPurity,
        floorRectLuma: r.floorRectLuma,
        camera: r.camera,
        width: r.width,
        height: r.height,
        png: b64(r.png),
      })),
    }
  },
  { state, wallTypes, plate, width: WIDTH, height: HEIGHT, exposure: EXPOSURE, lamp: LAMP, zoneAreas },
)
await browser.close()

// --- 4. write the artifacts ---------------------------------------------------
const dir = path.join(OUT, 'renders')
fs.mkdirSync(dir, { recursive: true })
for (const s of result.stills) {
  fs.writeFileSync(path.join(dir, `${s.key}.png`), Buffer.from(s.png, 'base64'))
}
const manifest = result.stills.map(({ png, ...rest }) => rest)
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ seed: SEED, gpu: gl, stills: manifest }, null, 2))

// Ground truth is a SHARED artifact (the workbook agent owns rooms/walls/doors).
// Merge, never overwrite.
const gtPath = path.join(OUT, 'ground-truth.json')
let gt = {}
if (fs.existsSync(gtPath)) {
  try {
    gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'))
  } catch (e) {
    console.warn(`  ground-truth.json unreadable (${e.message}) — writing a fresh one`)
  }
}
gt.renders = result.renders
fs.writeFileSync(gtPath, JSON.stringify(gt, null, 2))

for (const s of manifest) {
  const bytes = fs.statSync(path.join(dir, `${s.key}.png`)).size
  console.log(
    `  ${s.key.padEnd(16)} ${s.width}x${s.height}  room ${String(s.roomId).padEnd(4)} ` +
      `${s.roomLabel.padEnd(16)} ${s.floorMaterial.padEnd(26)} ` +
      `eye(${s.camera.eye.map((n) => n.toFixed(1)).join(',')}) ${s.camera.placement} ` +
      `fwd ${s.camera.forwardClearanceM}m  floor ${s.floorCheck} ` +
      `${(s.floorRectPurity * 100).toFixed(0)}%/L${s.floorRectLuma.toFixed(2)}  ` +
      `${(bytes / 1024).toFixed(0)} KB`,
  )
}
console.log(`wrote ${result.stills.length} stills → ${dir}`)
