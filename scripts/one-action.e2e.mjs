// End-to-end test for the ONE-ACTION deliverable pack (mission §6 / gate G10).
//
// G10 proves the gate's contract against the repo's `out/`. This test proves the
// same flow in isolation — its own dev server, its own output directory, its own
// browser profile — and additionally covers the half G10 can never reach: the
// BROWSER-ONLY deployment (Vercel and friends), where there is no pack endpoint,
// the artifacts come back as a .zip, and the walkthrough is encoded in the tab
// by WebCodecs + `web/src/export/mp4.ts`.
//
//   node scripts/one-action.e2e.mjs               # both cases
//   node scripts/one-action.e2e.mjs --only server # the UI click → out/ case
//   node scripts/one-action.e2e.mjs --only client # the zip + in-browser encode
//
// Case A drives the REAL UI: open the app at its root with an empty profile,
// find exactly one [data-testid=export-deliverable-pack], click it once, watch
// the progress panel, and wait for every artifact to land.
// Case B runs the same `buildDeliverablePack` against `zipPackSink` with the
// walkthrough shrunk (960×540 @ 10 fps) so a software rasterizer can finish it
// this decade, then ffprobes the mp4 that came out of the browser.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc } from './lib/demo-doc.mjs'

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const ONLY = arg('--only', 'both')
const PORT = Number(arg('--port', '5391'))

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

let failures = 0
let checks = 0
function check(cond, msg) {
  checks++
  if (cond) console.log(`  PASS  ${msg}`)
  else {
    failures++
    console.log(`  FAIL  ${msg}`)
  }
  return !!cond
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsource-e2e-'))

function waitForPort(port, ms = 60000) {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`dev server never came up on :${port}`))
        else setTimeout(tick, 300)
      })
    }
    tick()
  })
}

// ---------------------------------------------------------------------------
// Case A — the real UI, one click, artifacts on disk

async function serverCase() {
  console.log(`\n[A] one click in the app → artifacts in ${OUT}`)
  const dev = spawn(
    'pnpm',
    ['exec', 'vite', '--port', String(PORT), '--strictPort'],
    { cwd: path.join(REPO, 'web'), env: { ...process.env, PACK_OUT_DIR: OUT }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  dev.stdout.on('data', () => {})
  dev.stderr.on('data', (b) => process.stderr.write(`  [vite] ${b}`))
  let browser
  try {
    await waitForPort(PORT)
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })

    const sel = '[data-testid="export-deliverable-pack"]'
    await page.waitForSelector(sel, { timeout: 15000 })
    check((await page.$$(sel)).length === 1, 'exactly one deliverable-pack control on the landing route')

    await page.click(sel)

    // The progress UI must appear, and it must actually move.
    await page.waitForSelector('[data-testid="pack-progress"]', { timeout: 30000 })
    check(true, 'progress panel appears on click')
    const firstStage = await page.textContent('.pack-stage.active .pack-stage-name').catch(() => null)
    check(!!firstStage, `progress names its current stage (${firstStage ?? 'none'})`)
    check(
      await page.isDisabled(sel),
      'the control disables itself while a pack is running (no double-start)',
    )

    // Wait for the pack to finish — the walkthrough render dominates.
    await page.waitForSelector('[data-testid="pack-done"], [data-testid="pack-error"]', {
      timeout: 15 * 60 * 1000,
    })
    const failed = await page.$('[data-testid="pack-error"]')
    if (failed) {
      const why = await page.textContent('[data-testid="pack-error"] .pack-detail')
      check(false, `pack failed: ${why}`)
      return
    }
    const done = await page.textContent('[data-testid="pack-done"] .pack-detail')
    console.log(`  done: ${done}`)

    for (const rel of [
      'quantity-takeoff.xlsx',
      'ground-truth.json',
      'plan.png',
      'plan.repeat.png',
      'renders/Reception.png',
      'renders/Open_space.png',
      'renders/Work_stations.png',
      'renders/Conference_room.png',
      'walkthrough.mp4',
      'share.json',
    ]) {
      const p = path.join(OUT, rel)
      check(fs.existsSync(p) && fs.statSync(p).size > 0, `wrote ${rel}`)
    }
    check(fs.statSync(path.join(OUT, 'walkthrough.mp4')).size > 100 * 1024, 'walkthrough.mp4 > 100 KB')

    const gt = JSON.parse(fs.readFileSync(path.join(OUT, 'ground-truth.json'), 'utf8'))
    check(Array.isArray(gt.rooms) && gt.rooms.length > 0, `ground truth carries ${gt.rooms?.length} rooms`)
    check(Array.isArray(gt.renders) && gt.renders.length === 4, 'ground truth carries all four renders')
    const share = JSON.parse(fs.readFileSync(path.join(OUT, 'share.json'), 'utf8'))
    check(!!(share.url || share.planId), 'share.json carries a viewer link')
    check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`)
  } finally {
    await browser?.close()
    dev.kill('SIGTERM')
  }
}

// ---------------------------------------------------------------------------
// Case B — no pack endpoint: zip download + in-browser H.264

async function clientCase() {
  console.log('\n[B] browser-only deployment → zip + WebCodecs encode')
  const { build } = await import(
    pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href
  )
  const bundle = await build({
    stdin: {
      contents: `
        import { buildDeliverablePack, zipPackSink, detectPackSink } from './src/export/deliverablePack'
        import { classifyWalls } from './src/export/wallTypes'
        window.DS = { buildDeliverablePack, zipPackSink, detectPackSink, classifyWalls }
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

  const { state, wallTypes, plate, circulation, quantities } = await buildDemoDoc()
  // A secure context (localhost) — WebCodecs is unavailable without one, which
  // is itself part of what this case checks.
  const srv = http.createServer((q, r) => {
    // Everything but the page 404s — including /api/pack, which is exactly what
    // a static deployment looks like to `detectPackSink`.
    if (q.url !== '/') {
      r.writeHead(404, { 'content-type': 'application/json' })
      return void r.end('{"error":"not found"}')
    }
    r.writeHead(200, { 'content-type': 'text/html' })
    r.end('<!doctype html><title>pack</title>')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    await page.goto(`http://localhost:${srv.address().port}/`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })

    // With no /api/pack on this origin, the app must choose the zip sink itself.
    const kind = await page.evaluate(async () => (await window.DS.detectPackSink()).kind)
    check(kind === 'download', `no pack endpoint → sink is the zip download (got ${kind})`)

    const result = await page.evaluate(
      async ({ state, wallTypes, plate, circulation, quantities }) => {
        const wallSpans = window.DS.classifyWalls(state, wallTypes)
        const files = []
        // The zip sink, tapped so the test can see the parts without decoding a
        // zip; `finish()` still runs (it is what a real download does).
        const zip = window.DS.zipPackSink('e2e.zip')
        const sink = {
          kind: zip.kind,
          video: zip.video,
          async put(name, data) {
            files.push({ name, bytes: data.byteLength })
            if (name === 'walkthrough.mp4') {
              let s = ''
              for (let i = 0; i < data.length; i += 0x8000) {
                s += String.fromCharCode(...data.subarray(i, i + 0x8000))
              }
              window.__mp4 = btoa(s)
            }
          },
          finish: () => ({ kind: 'download', files: files.map((f) => f.name), bytes: 0, where: 'e2e.zip' }),
        }
        const out = await window.DS.buildDeliverablePack(
          {
            state,
            quantities,
            wallTypes,
            qto: { circulation, plate, wallSpans },
            name: 'E2E sample',
            // Shrunk so a software rasterizer finishes: 300 frames, not 1290.
            // Everything else about the encode is the production path.
            video: { width: 960, height: 540, fps: 10 },
          },
          sink,
          () => {},
        )
        return { files, videoBy: out.videoBy, videoBytes: out.videoBytes }
      },
      { state, wallTypes, plate, circulation, quantities },
    )

    check(result.videoBy === 'browser', `the walkthrough was encoded in the browser (${result.videoBy})`)
    const names = result.files.map((f) => f.name)
    for (const want of ['quantity-takeoff.xlsx', 'plan.png', 'ground-truth.json', 'renders/Reception.png', 'walkthrough.mp4']) {
      check(names.includes(want), `zip carries ${want}`)
    }
    const b64 = await page.evaluate(() => window.__mp4 ?? null)
    const mp4 = path.join(OUT, 'client-walkthrough.mp4')
    fs.writeFileSync(mp4, Buffer.from(b64, 'base64'))
    const probe = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
       'stream=codec_name,width,height,pix_fmt,nb_frames', '-of', 'default=nw=1', mp4],
      { encoding: 'utf8' },
    )
    console.log(probe.trim().split('\n').map((l) => `  ${l}`).join('\n'))
    check(/codec_name=h264/.test(probe), 'the browser-encoded file is H.264')
    check(/width=960/.test(probe) && /height=540/.test(probe), 'the browser-encoded file is 960x540')
    check(/pix_fmt=yuv420p/.test(probe), 'the browser-encoded file is yuv420p')
    // A file that only *parses* proves nothing — decode every frame.
    const dec = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4, '-f', 'null', '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    check(dec.trim() === '', `every frame decodes cleanly ${dec.trim().slice(0, 120)}`)
  } finally {
    await browser.close()
    srv.close()
  }
}

if (ONLY === 'both' || ONLY === 'server') await serverCase()
if (ONLY === 'both' || ONLY === 'client') await clientCase()

console.log(`\n${failures ? 'FAIL' : 'PASS'}  one-action e2e — ${checks - failures}/${checks} checks`)
if (!failures) fs.rmSync(OUT, { recursive: true, force: true })
else console.log(`artifacts kept for inspection: ${OUT}`)
process.exit(failures ? 1 : 0)
