// Headless driver for the branded walkthrough video (gate G7).
//
// SAME CODE PATH AS THE APP — mirrors scripts/render-rooms.mjs exactly. There is
// one walkthrough (`web/src/export/walkthrough.ts` over `web/src/three/
// materialTheme.ts`); it needs a real WebGL context, so this script bundles it
// with esbuild and runs it inside headless Chromium via Playwright. Frames are
// STREAMED out of the page one at a time (exposeBinding) straight into ffmpeg's
// stdin, so a 1000-frame take never has to fit in memory anywhere.
//
//   node scripts/render-walkthrough.mjs [--out out] [--seed 7] [--fps 60]
//                                       [--duration 36] [--width 1920] [--height 1080]
//                                       [--state doc.json] [--keep-frames] [--dry-run]
//
// Writes:
//   out/walkthrough.mp4    H.264 yuv420p, 60 fps, -crf 15, 1920x1080
//   out/walkthrough.json   route + camera report (stops, speed, clearance)
//
// Chromium is launched with --use-angle=metal for real hardware GL on macOS; it
// falls back to SwiftShader elsewhere (the renderer detects the software
// rasterizer and drops GTAO, exactly as Viewer3D does).

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
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
const WIDTH = Number(arg('--width', '1920'))
const HEIGHT = Number(arg('--height', '1080'))
// 60 fps and crf 15 are the REFERENCE's numbers, not a default: qbiq's
// walkthrough is 60 fps at 33 Mb/s and ours shipped 30 fps at 4.8 Mb/s, which is
// a visible smoothness and banding gap on a camera that never stops moving. The
// cost is honest and stated: twice the frames to render (~100 s → ~200 s on an
// M4 Pro) and a bigger file. Pass `--fps 30` for the cheap take.
const FPS = Number(arg('--fps', '60'))
const DURATION = argv.includes('--duration') ? Number(arg('--duration')) : undefined
const CRF = arg('--crf', '15')
const FRAME_CODEC = arg('--frame-codec', 'png') // png = lossless hand-off to x264
const DRY = argv.includes('--dry-run')
const KEEP = argv.includes('--keep-frames')
const FRAME_EVERY = Number(arg('--keep-every', '60'))

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const { build } = await import(
  pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
)
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

// --- 1. the document, straight out of the Rust core --------------------------
// `--state <file>` shoots the take for a document the CALLER already has — the
// live plan the one-action deliverable pack POSTs to /api/pack/walkthrough
// (deploy/packStore.ts). Same JSON shape `buildDemoDoc`/`readDoc` return, so
// everything downstream is unchanged; without it the seeded demo doc is used.
const STATE_FILE = arg('--state')
const doc = STATE_FILE
  ? JSON.parse(fs.readFileSync(path.resolve(STATE_FILE), 'utf8'))
  : await buildDemoDoc({ seed: SEED })
const { state, wallTypes, plate, circulation } = doc
console.log(
  `doc: ${state.walls.length} walls · ${state.components.length} components · ` +
    `${(state.zones ?? []).length} zones · ${STATE_FILE ? `state ${path.basename(STATE_FILE)}` : `seed ${SEED}`}`,
)

// --- 2. bundle the walkthrough for the browser --------------------------------
const bundle = await build({
  stdin: {
    contents: `
      import { renderWalkthrough } from './src/export/walkthrough'
      import { classifyWalls } from './src/export/wallTypes'
      window.DS = { renderWalkthrough, classifyWalls }
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

// --- 3. ffmpeg, fed from the page --------------------------------------------
fs.mkdirSync(OUT, { recursive: true })
const mp4 = path.join(OUT, 'walkthrough.mp4')
const frameDir = KEEP ? path.join(OUT, 'walkthrough-frames') : null
if (frameDir) fs.rmSync(frameDir, { recursive: true, force: true })
if (frameDir) fs.mkdirSync(frameDir, { recursive: true })

let ff = null
if (!DRY) {
  ff = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0',
      '-an',
      // JPEG frames decode as FULL-range (yuvj420p) and x264 carries that tag
      // through, so the range is pinned explicitly and the deliverable is the
      // broadcast-safe yuv420p the spec asks for.
      '-vf', 'scale=in_range=full:out_range=limited,format=yuv420p',
      '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF,
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-movflags', '+faststart', '-r', String(FPS),
      mp4,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  ff.on('error', (e) => {
    console.error('ffmpeg failed to start:', e.message)
    process.exit(1)
  })
}

let ffError = null
if (ff) ff.stdin.on('error', (e) => { ffError = e })
const writeFrame = (buf) =>
  new Promise((res, rej) => {
    if (!ff) return res()
    if (ffError) return rej(ffError)
    if (ff.stdin.write(buf)) res()
    else ff.stdin.once('drain', res)
  })

// --- 4. render in headless Chromium ------------------------------------------
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => console.log('  [page error]', e.message))

const t0 = Date.now()
let received = 0
await page.exposeBinding('dsFrame', async (_src, { index, total, b64 }) => {
  const buf = Buffer.from(b64, 'base64')
  await writeFrame(buf)
  if (frameDir && index % FRAME_EVERY === 0) {
    fs.writeFileSync(path.join(frameDir, `f${String(index).padStart(5, '0')}.${FRAME_CODEC === 'png' ? 'png' : 'jpg'}`), buf)
  }
  received++
  if (index % 30 === 0 || index === total - 1) {
    const el = (Date.now() - t0) / 1000
    const pct = ((index + 1) / total) * 100
    const eta = index > 5 ? ((el / (index + 1)) * (total - index - 1)).toFixed(0) : '?'
    process.stdout.write(
      `\r  frame ${String(index + 1).padStart(4)}/${total}  ${pct.toFixed(1).padStart(5)}%  ` +
        `${el.toFixed(0)}s elapsed · ~${eta}s left   `,
    )
  }
})

await page.addScriptTag({ content: code })

const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2')
  const d = c && c.getExtension('WEBGL_debug_renderer_info')
  return d ? String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown'
})
console.log(`gpu: ${gl}`)

const summary = await page.evaluate(
  async ({ state, wallTypes, plate, circulation, width, height, fps, duration, title, subtitle, frameCodec }) => {
    const wallSpans = window.DS.classifyWalls(state, wallTypes)
    return await window.DS.renderWalkthrough(state, {
      width,
      height,
      fps,
      durationS: duration,
      wallSpans,
      plate,
      circulation,
      title,
      subtitle,
      onProgress: (done, total, phase) => {
        if (phase !== 'render') console.log(`phase: ${phase}`)
      },
      onFrame: async (f) => {
        const url = frameCodec === 'png' ? f.canvas.toDataURL('image/png') : f.canvas.toDataURL('image/jpeg', 0.96)
        await window.dsFrame({ index: f.index, total: f.total, b64: url.slice(url.indexOf(',') + 1) })
      },
    })
  },
  {
    state, wallTypes, plate, circulation,
    width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
    // A posted document carries its own plan name; the seeded demo keeps its.
    title: doc.title ?? 'DSource Test-Fit Walkthrough',
    subtitle: doc.subtitle ?? `GCC office fit-out · 40 x 24 m plate · seed ${SEED}`,
    frameCodec: FRAME_CODEC,
  },
)
await browser.close()
process.stdout.write('\n')

if (ff) {
  ff.stdin.end()
  const rc = await new Promise((res) => ff.on('close', res))
  if (rc !== 0) {
    console.error(`ffmpeg exited ${rc}`)
    process.exit(1)
  }
}

// --- 5. the report -------------------------------------------------------------
const report = { seed: SEED, gpu: gl, crf: Number(CRF), frameCodec: FRAME_CODEC, ...summary }
fs.writeFileSync(path.join(OUT, 'walkthrough.json'), JSON.stringify(report, null, 2))

console.log(
  `route ${summary.pathLengthM} m · ${summary.meanSpeedMps} m/s · ` +
    `${summary.thresholdPasses} threshold passes · min clearance ${summary.minClearanceM} m · ` +
    `${summary.containmentFixes} containment fixes · ${summary.displays} branded displays`,
)
console.log(`stops: ${summary.stops.map((s) => `${s.name}@${s.sM}m`).join(' → ')}`)
console.log(
  `frames ${received}/${summary.frames} · ${summary.durationS.toFixed(2)}s @ ${summary.fps}fps · ` +
    `${((Date.now() - t0) / 1000).toFixed(0)}s wall clock`,
)
if (!DRY) {
  console.log(`wrote ${path.relative(REPO, mp4)} (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)} MB)`)
}
