// ONE end-to-end investor demo video of DSource Studio, recorded by Playwright.
//
//   node scripts/demo/record-demo.mjs                 # the whole film
//   node scripts/demo/record-demo.mjs --port 5199     # a different dev server
//   node scripts/demo/record-demo.mjs --fast          # same beats, short pauses (iteration)
//   node scripts/demo/record-demo.mjs --no-mp4        # skip the ffmpeg transcode
//
// Prereq: a dev server already running (default http://localhost:5199 — never
// 5173, see CLAUDE.md "Verifying a change in the browser"). If it is down:
//     cd web && pnpm dev --port 5199 --strictPort
//
// The film, in one take, driven through the app's REAL UI:
//   1  Landing → Start a project → the property form
//   2  Space   → upload samples/furniture-plan.dwg → traced plate + readouts
//   3  Program → the resolved brief
//   4  Generate→ the autonomous seed search → three scored alternatives
//   5  Editor  → the winning test-fit, live metrics, 2D ⇄ 3D
//   6  Export  → PNG / DXF / CSV / PDF / report / takeoff / IFC / OBJ
//   7  Results → the exported files, revealed on screen as a rendered listing
//
// Everything lands in out/demo/ (gitignored):
//   out/demo/dsource-demo.webm   the raw Playwright recording (1920×1080)
//   out/demo/dsource-demo.mp4    H.264 transcode (ffmpeg, when available)
//   out/demo/exports/            the artifacts the app actually produced
//   out/demo/results.html        the end-card listing (also filmed)
//
// TWO RULES THIS SCRIPT OBEYS, deliberately:
//
//  • It NEVER clicks [data-testid="plate-draft-confirm"]. That control calls
//    recordPlateOutcome() and writes the plate CALIBRATION LOG, whose entire
//    value is that a HUMAN produced its rows (ADR 0003 + .claude/rules/
//    gate-independence.md, "An agent must never perform or simulate a
//    trusted-human event"). Playwright's CDP input is `isTrusted`, so the row
//    would be indistinguishable from a real one. The flow does not need it; we
//    route around it, and assert afterwards that the store is still empty.
//
//  • Its assertions are re-derived, not transcribed. "The export worked" is
//    decided by reading the file's magic bytes off disk, never by the app
//    saying it exported; "3D is rendering" is decided by differencing two
//    screenshots that differ only in the orbit, never by the presence of a
//    <canvas>. See .claude/rules/gate-independence.md.
//
// A step whose expected element never appears throws with the step name and
// what it was waiting for. Soft measurements are recorded as checks; any
// failing check exits non-zero AFTER the video is written, so a broken run
// still leaves the evidence behind.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const arg = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

const PORT = Number(arg('--port', '5199'))
const BASE = `http://localhost:${PORT}`
const FAST = flag('--fast')
const WANT_MP4 = !flag('--no-mp4')
const PLATE = path.join(REPO, 'samples/furniture-plan.dwg')

const OUT = path.join(REPO, 'out/demo')
const EXPORTS = path.join(OUT, 'exports')
const VIDEO_DIR = path.join(OUT, '.video')

const W = 1920
const H = 1080

// ---------------------------------------------------------------------------
// checks + loud failures

let checks = 0
let failures = 0
function check(cond, msg) {
  checks++
  if (cond) console.log(`  ok    ${msg}`)
  else {
    failures++
    console.log(`  FAIL  ${msg}`)
  }
  return !!cond
}

let STEP = 'startup'
const step = (s) => {
  STEP = s
  console.log(`\n▶ ${s}`)
}
class StepError extends Error {
  constructor(why) {
    super(`[${STEP}] ${why}`)
    this.name = 'StepError'
  }
}

/** Wait for a selector, or die naming the step and the selector. */
async function need(page, sel, { timeout = 20000, what = '' } = {}) {
  const loc = page.locator(sel).first()
  try {
    await loc.waitFor({ state: 'visible', timeout })
  } catch {
    throw new StepError(
      `expected ${what || 'element'} \`${sel}\` never became visible within ${timeout} ms` +
        ` — url ${page.url()}`,
    )
  }
  return loc
}

// ---------------------------------------------------------------------------
// pacing

const SCALE = FAST ? 0.18 : 1
const beat = (page, ms) => page.waitForTimeout(Math.max(120, Math.round(ms * SCALE)))

// ---------------------------------------------------------------------------
// The on-screen furniture: a glide cursor, a click pulse, and chapter cards.
// Injected from the harness only — nothing under web/src is touched, and the
// overlay is pointer-events:none so it can never intercept a real click.

const HUD = `(() => {
  if (window.__demoHudInstalled) return
  window.__demoHudInstalled = true
  const CSS = \`
    #__demoCursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;
      border-radius:50%;border:2px solid rgba(255,255,255,.95);
      box-shadow:0 0 0 1.5px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.4);
      background:rgba(255,255,255,.14);pointer-events:none;z-index:2147483646;
      transition:transform .12s ease, background .12s ease;will-change:transform}
    #__demoCursor.__down{transform:scale(.62);background:rgba(255,255,255,.5)}
    #__demoPulse{position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;
      border-radius:50%;border:2px solid rgba(255,255,255,.9);opacity:0;
      pointer-events:none;z-index:2147483645}
    @keyframes __demoPing{from{transform:scale(.6);opacity:.85}to{transform:scale(3.2);opacity:0}}
    #__demoPulse.__ping{animation:__demoPing .5s ease-out}
    #__demoChapter{position:fixed;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:14px;
      background:rgba(9,10,12,.94);color:#fff;opacity:0;pointer-events:none;
      z-index:2147483647;transition:opacity .42s ease;
      font-family:'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;
      -webkit-font-smoothing:antialiased}
    #__demoChapter.__on{opacity:1}
    #__demoChapter .__n{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;
      font-size:13px;letter-spacing:.34em;text-transform:uppercase;color:rgba(255,255,255,.5)}
    #__demoChapter .__t{font-size:58px;line-height:1.08;font-weight:600;letter-spacing:-.02em;
      text-align:center;max-width:24ch;white-space:pre-line}
    #__demoChapter .__s{font-size:19px;color:rgba(255,255,255,.62);text-align:center;max-width:52ch}
  \`
  const install = () => {
    if (document.getElementById('__demoCursor')) return
    const st = document.createElement('style'); st.textContent = CSS
    document.head.appendChild(st)
    const cur = document.createElement('div'); cur.id = '__demoCursor'
    const pul = document.createElement('div'); pul.id = '__demoPulse'
    const ch = document.createElement('div'); ch.id = '__demoChapter'
    ch.innerHTML = '<div class="__n"></div><div class="__t"></div><div class="__s"></div>'
    document.body.append(cur, pul, ch)
    const at = (e) => {
      cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'
      pul.style.left = e.clientX + 'px'; pul.style.top = e.clientY + 'px'
    }
    addEventListener('mousemove', at, true)
    addEventListener('mousedown', (e) => { at(e); cur.classList.add('__down') }, true)
    addEventListener('mouseup', () => {
      cur.classList.remove('__down')
      pul.classList.remove('__ping'); void pul.offsetWidth; pul.classList.add('__ping')
    }, true)
  }
  if (document.body) install()
  else document.addEventListener('DOMContentLoaded', install)
  window.__demoChapter = (n, t, s, on) => {
    install()
    const el = document.getElementById('__demoChapter')
    if (!el) return
    if (on) {
      el.querySelector('.__n').textContent = n
      el.querySelector('.__t').textContent = t
      el.querySelector('.__s').textContent = s || ''
      el.classList.add('__on')
    } else el.classList.remove('__on')
  }
})()`

async function chapter(page, n, title, sub, hold = 2100) {
  await page.evaluate(([n, t, s]) => window.__demoChapter?.(n, t, s, true), [n, title, sub])
  await beat(page, hold)
  await page.evaluate(() => window.__demoChapter?.('', '', '', false))
  await beat(page, 520)
}

// ---------------------------------------------------------------------------
// input: a cursor that travels, so a viewer can follow the click

async function glide(page, x, y) {
  await page.mouse.move(x, y, { steps: FAST ? 4 : 26 })
}

/**
 * A box that has stopped moving. Cards on the Generate step reflow when the
 * Claude soft-goal verdicts land asynchronously; a click aimed at a rectangle
 * measured before that reflow lands on whatever slid into its place. (This is
 * not hypothetical — it ate one "Open in editor" click during development, and
 * the run then waited 90 s for a navigation that was never going to happen.)
 */
async function stableBox(loc, sel) {
  let prev = null
  for (let i = 0; i < 14; i++) {
    const box = await loc.boundingBox()
    if (!box) throw new StepError(`\`${sel}\` has no box to click`)
    if (prev && Math.abs(prev.x - box.x) < 0.6 && Math.abs(prev.y - box.y) < 0.6 &&
        Math.abs(prev.height - box.height) < 0.6) return box
    prev = box
    await loc.page().waitForTimeout(160)
  }
  throw new StepError(`\`${sel}\` never stopped moving — the layout is still reflowing`)
}

async function demoClick(page, sel, { timeout = 20000, what = '', settle = 260 } = {}) {
  const loc = await need(page, sel, { timeout, what })
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  const box = await stableBox(loc, sel)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > W || y > H) {
    throw new StepError(`\`${sel}\` sits outside the 1920×1080 frame at (${x | 0},${y | 0})`)
  }
  await glide(page, x, y)
  await beat(page, settle)
  await page.mouse.down()
  await page.waitForTimeout(70)
  await page.mouse.up()
  return loc
}

async function type(page, sel, text) {
  const loc = await need(page, sel, { what: 'form field' })
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  const box = await loc.boundingBox()
  if (box) {
    await glide(page, box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  await loc.fill('')
  await loc.pressSequentially(text, { delay: FAST ? 4 : 42 })
}

/** Poll the hash route. `waitForURL` is fine for documents; this is fine for both. */
async function waitForHash(page, re, ms, what) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (re.test(page.url())) return page.url()
    await page.waitForTimeout(200)
  }
  throw new StepError(`never reached ${what} (expected ${re}) — url is ${page.url()}`)
}

/** Animate the real scroll owner under `sel` (the pane, not the window). */
async function smoothScroll(page, sel, to, ms = 2600) {
  await page.evaluate(
    async ({ sel, to, ms }) => {
      const root = document.querySelector(sel)
      if (!root) return
      const scrollable = (el) => el.scrollHeight - el.clientHeight > 8
      let owner = scrollable(root) ? root : null
      if (!owner) for (const c of root.querySelectorAll('*')) if (scrollable(c)) { owner = c; break }
      if (!owner) return
      const from = owner.scrollTop
      const dest = (owner.scrollHeight - owner.clientHeight) * to
      const t0 = performance.now()
      await new Promise((res) => {
        const tick = (t) => {
          const k = Math.min(1, (t - t0) / ms)
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
          owner.scrollTop = from + (dest - from) * e
          k < 1 ? requestAnimationFrame(tick) : res()
        }
        requestAnimationFrame(tick)
      })
    },
    { sel, to, ms: Math.max(200, ms * SCALE) },
  )
}

// ---------------------------------------------------------------------------
// artifact identification — from the BYTES, never from the file name the app
// chose or from anything the app told us it wrote.

const MAGIC = [
  { kind: 'PNG image', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: 'PDF document', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    kind: 'Excel workbook',
    test: (b) =>
      b.subarray(0, 2).toString('latin1') === 'PK' &&
      b.subarray(Math.max(0, b.length - 66000)).includes(Buffer.from('PK\x05\x06', 'latin1')),
  },
  { kind: 'ZIP archive', test: (b) => b.subarray(0, 2).toString('latin1') === 'PK' },
  { kind: 'DXF drawing', test: (b) => /^\s*0\r?\nSECTION/.test(b.subarray(0, 64).toString('latin1')) },
  { kind: 'IFC model', test: (b) => b.subarray(0, 11).toString('latin1') === 'ISO-10303-2' },
  { kind: 'OBJ mesh', test: (b, n) => n.endsWith('.obj') },
  { kind: 'MTL material', test: (b, n) => n.endsWith('.mtl') },
  { kind: 'CSV data', test: (b, n) => n.endsWith('.csv') && b.includes(0x2c) },
  { kind: 'glTF binary', test: (b) => b.subarray(0, 4).toString('latin1') === 'glTF' },
]
const identify = (buf, name) => MAGIC.find((m) => { try { return m.test(buf, name) } catch { return false } })?.kind ?? 'binary'

// ---------------------------------------------------------------------------

function waitForServer(port, ms = 8000) {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      // `localhost`, not 127.0.0.1 — vite binds ::1 too, and a v4-only probe
      // reports "no server" for a server that is answering perfectly well.
      const req = http.get({ host: 'localhost', port, path: '/' }, (res) => { res.resume(); resolve() })
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(
            `No dev server on :${port}. Start one with:  cd web && pnpm dev --port ${port} --strictPort`,
          ))
        } else setTimeout(tick, 250)
      })
    }
    tick()
  })
}

// ---------------------------------------------------------------------------

fs.rmSync(EXPORTS, { recursive: true, force: true })
fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
fs.mkdirSync(EXPORTS, { recursive: true })
fs.mkdirSync(VIDEO_DIR, { recursive: true })

if (!fs.existsSync(PLATE)) throw new Error(`demo CAD plate missing: ${PLATE}`)
await waitForServer(PORT)

const webRequire = createRequire(path.join(REPO, 'web/package.json'))
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

const t0 = Date.now()
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--hide-scrollbars'],
})
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
})
await context.addInitScript(HUD)

const page = await context.newPage()
const pageErrors = []
const consoleErrors = []
const dialogs = []
page.on('pageerror', (e) => pageErrors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)) })
page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss() })

// Every download the app produces, saved under out/demo/exports/ by its own name.
const saved = []
const savers = []
page.on('download', (d) => {
  const name = d.suggestedFilename()
  savers.push(
    d.saveAs(path.join(EXPORTS, name))
      .then(() => saved.push(name))
      .catch((e) => console.log(`  (download ${name} failed: ${e.message})`)),
  )
})
const waitForDownloads = async (n, ms = 120000) => {
  const deadline = Date.now() + ms
  while (saved.length < n && Date.now() < deadline) await page.waitForTimeout(250)
  await Promise.all(savers)
  return saved.length
}

let videoPath = null
let projectId = null

try {
  // -------------------------------------------------------------- 0 · landing
  step('landing')
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await need(page, '[data-testid="project-library"]', { timeout: 30000, what: 'the landing page' })

  // CLEAN STATE, established positively rather than assumed: a brand-new browser
  // context has an empty IndexedDB, and the library says so in the DOM. If a
  // profile were ever reused, this is where the run stops.
  const emptyLib = await page.locator('[data-testid="project-library-empty"]').count()
  if (emptyLib !== 1) {
    throw new StepError(
      `state is not clean — the project library already lists projects (empty-marker count ${emptyLib})`,
    )
  }
  check(true, 'clean start: IndexedDB empty, project library shows "No projects yet"')

  await beat(page, 900)
  await chapter(page, 'DSource Studio', 'Plate to priced plan,\nin one autonomous loop.',
    'Trace · program · generate · evaluate · deliver.', 3000)
  await beat(page, 1600)

  // ------------------------------------------------------------- 1 · property
  step('create project')
  await chapter(page, '01 — Project', 'Start a project', 'The property details flow straight into the priced report and takeoff.')
  await demoClick(page, '[data-testid="project-new"]', { what: '"Start a project"' })
  await need(page, '[data-testid="create-project-form"]', { what: 'the property form' })
  await beat(page, 700)

  await type(page, '[data-testid="create-name"]', 'Q3 Tenant Fit-out')
  await type(page, '[data-testid="create-property"]', 'One Prestige Tower')
  await type(page, '[data-testid="create-address"]', '12 MG Road, Bengaluru 560001')
  await type(page, '[data-testid="create-floor"]', 'L14')
  await beat(page, 1100)

  const nextBtn = page.locator('[data-testid="create-submit"]')
  if (await nextBtn.isDisabled()) throw new StepError('"Create project" stayed disabled after filling the form')
  await demoClick(page, '[data-testid="create-submit"]', { what: '"Create project"' })

  await waitForHash(page, /#\/p\/[^/]+\/space/, 30000, 'the Space step')
  projectId = page.url().match(/#\/p\/([^/]+)\/space/)?.[1] ?? null
  check(!!projectId, `project created → ${page.url().split('#')[1]}`)

  // ---------------------------------------------------------------- 2 · space
  step('upload the CAD plate')
  await need(page, '[data-testid="space-step"]', { what: 'the Space step' })
  await chapter(page, '02 — Space', 'Drop the CAD floor plate',
    'A real DWG. The shell, the keep-outs and the existing furniture are read for you.')
  await beat(page, 900)

  // The drop target is a label over a hidden input; setInputFiles is the honest
  // path to the same handler a drag-and-drop takes.
  await page.setInputFiles('[data-testid="space-upload-input"]', PLATE)
  await beat(page, 700)

  const failed = page.locator('[data-testid="space-error"]')
  const readouts = page.locator('[data-testid="space-readouts"]')
  const deadline = Date.now() + 240000
  for (;;) {
    if (await readouts.count()) break
    if (await failed.count()) {
      throw new StepError(`the import failed: ${(await failed.first().innerText()).trim()}`)
    }
    if (Date.now() > deadline) throw new StepError('the DWG never produced readouts within 240 s')
    await page.waitForTimeout(400)
  }
  // The headline metrics, read out of the metric tiles rather than the whole
  // pane (whose innerText starts with the toolbar and says nothing).
  const metrics = await page.locator('[data-testid="space-readouts"] .space-metric').evaluateAll((els) =>
    els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
  )
  const areaM2 = parseFloat((metrics.find((m) => /m²/.test(m)) ?? '').replace(/[^\d.]/g, '')) || 0
  check(areaM2 > 50, `plate traced — ${metrics.join(' · ') || '(no metric tiles)'}`)

  // NOT CLICKED, ON PURPOSE: [data-testid="plate-draft-confirm"] writes the
  // human-only plate calibration log. Note whether it was even offered.
  const draftOffered = await page.locator('[data-testid="plate-draft-confirm"]').count()
  console.log(`  note  plate-draft-confirm present: ${draftOffered ? 'yes — deliberately NOT clicked' : 'no'}`)

  await beat(page, 5200)
  await smoothScroll(page, '[data-testid="space-step"]', 1, 4200)
  await beat(page, 3200)
  await smoothScroll(page, '[data-testid="space-step"]', 0, 1800)
  await beat(page, 800)

  const spaceNext = page.locator('[data-testid="wizard-next"]')
  if (await spaceNext.isDisabled()) {
    const why = await page.locator('[data-testid="wizard-next-reason"]').innerText().catch(() => '')
    throw new StepError(`"Next: Program" stayed disabled — ${why || 'no reason given'}`)
  }
  await demoClick(page, '[data-testid="wizard-next"]', { what: '"Next: Program"' })

  // -------------------------------------------------------------- 3 · program
  step('program')
  await need(page, '[data-testid="program-step"]', { what: 'the Program step' })
  await chapter(page, '03 — Program', 'State the brief',
    'Headcount, enclosed-office mix and room counts — pre-filled from the plate you just dropped.')
  await need(page, '[data-testid="program-summary"]', { what: 'the program summary' })
  const summary = (await page.locator('[data-testid="program-summary"]').innerText()).replace(/\s+/g, ' ')
  check(/\d/.test(summary), `program resolved — ${summary.slice(0, 100)}…`)
  await beat(page, 2600)
  await smoothScroll(page, '[data-testid="program-step"]', 1, 3800)
  await beat(page, 2600)
  await smoothScroll(page, '[data-testid="program-step"]', 0, 1600)
  await beat(page, 900)

  const progNext = page.locator('[data-testid="program-next"]')
  if (await progNext.isDisabled()) throw new StepError('"Next: Generate" stayed disabled')
  await demoClick(page, '[data-testid="program-next"]', { what: '"Next: Generate"' })

  // ------------------------------------------------------------- 4 · generate
  step('autonomous test-fit')
  await need(page, '[data-testid="generate-step"]', { what: 'the Generate step' })
  await chapter(page, '04 — Generate', 'The autonomous test-fit',
    'The engine generates, scores and re-seeds — keeping the strongest fits for your criteria.')

  const alts = page.locator('[data-testid="generate-alt"]')
  const genDeadline = Date.now() + 300000
  for (;;) {
    if ((await alts.count()) >= 2) break
    for (const bad of ['generate-noplate', 'generate-error']) {
      if (await page.locator(`[data-testid="${bad}"]`).count()) {
        throw new StepError(`generation refused (${bad}): ${(await page.locator(`[data-testid="${bad}"]`).innerText()).replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    if (Date.now() > genDeadline) throw new StepError('no scored alternatives after 300 s')
    await page.waitForTimeout(500)
  }
  const nAlts = await alts.count()
  check(nAlts >= 2, `${nAlts} scored alternatives returned`)

  // Scores read out of the DOM, so the winner we open is the winner the UI shows.
  // The score node is `<span>87<span>/100</span></span>` — read the FIRST text
  // node, or "/100" concatenates into the number and every card scores 87100.
  const scores = await page.locator('.generate-alt-score').evaluateAll((els) =>
    els.map((e) => parseFloat((e.firstChild?.textContent ?? e.textContent).replace(/[^\d.]/g, '')) || 0),
  )
  check(scores.length === nAlts && scores.every((s) => s > 0), `every card is scored: ${scores.join(' / ')}`)
  await beat(page, 4800)

  // Step through the cards so the metrics strip visibly re-computes per option.
  for (const i of [1, 2, 0].filter((i) => i < nAlts)) {
    await demoClick(page, `[data-testid="generate-alt"] >> nth=${i} >> .generate-alt-thumb`, {
      what: `alternative ${'ABC'[i]}`,
    })
    await beat(page, 2600)
  }

  // Let the soft-goal (Claude) pass finish before aiming at anything: it adds a
  // verdict row to every card and reflows the gallery. Absent a key it never
  // starts, so this returns immediately.
  await page
    .locator('[data-testid="generate-alt-ai"].is-pending')
    .first()
    .waitFor({ state: 'detached', timeout: 60000 })
    .catch(() => {})
  await beat(page, 700)

  const winner = scores.indexOf(Math.max(...scores))
  await chapter(page, '04 — Generate', `Alternative ${'ABC'[winner]} wins`,
    `${Math.round(scores[winner])} / 100 against the program. Open it and keep designing.`, 1900)
  await smoothScroll(page, '[data-testid="generate-step"]', 0.55, 1600)
  const openSel = `[data-testid="generate-alt"] >> nth=${winner} >> [data-testid="generate-alt-open"]`
  await demoClick(page, openSel, { what: '"Open in editor"' })

  // ---------------------------------------------------------------- 5 · editor
  step('editor')
  const EDITOR_RE = /#\/p\/[^/]+\/f\/[^/]+/
  let landed = await waitForHash(page, EDITOR_RE, 20000, 'the editor deep-link').then(() => true, () => false)
  if (!landed) {
    // openCandidate persists a floor before it navigates; one missed click is
    // survivable, a silent 90-second stall is not. Say so, try once, then die.
    console.log('  retry  no navigation 20 s after "Open in editor" — clicking once more')
    await demoClick(page, openSel, { what: '"Open in editor" (retry)' }).catch(() => {})
    try {
      await waitForHash(page, EDITOR_RE, 60000, 'the editor deep-link')
    } catch (e) {
      console.log(`  page errors: ${pageErrors.slice(-4).join(' | ') || 'none'}`)
      console.log(`  console errors: ${consoleErrors.slice(-4).join(' | ') || 'none'}`)
      throw e
    }
    landed = true
  }
  await need(page, '[data-testid="mode-3d"]', { timeout: 30000, what: 'the editor top bar' })
  await need(page, '.canvas-wrap canvas', { timeout: 30000, what: 'the 2D plan canvas' })
  check(true, `editor open at ${page.url().split('#')[1]}`)
  await chapter(page, '05 — Editor', 'The winning fit, live',
    'One document, four facets per object: geometry · category · product binding · decision state.')
  await beat(page, 5200)

  // 2D → 3D. "The viewer works" is decided by pixels that CHANGE under an orbit,
  // not by a <canvas> existing: a black rectangle satisfies the latter.
  step('3D walkthrough')
  await demoClick(page, '[data-testid="mode-3d"]', { what: 'the 3D toggle' })
  await need(page, '[data-testid="v3d-frame"]', { timeout: 60000, what: 'the 3D viewer toolbar' })
  await beat(page, 2600)
  await demoClick(page, '[data-testid="v3d-frame"]', { what: '"Frame"' })
  await beat(page, 2200)

  const stage = page.locator('.canvas-wrap').first()
  const stageBox =
    (await stage.boundingBox().catch(() => null)) ?? { x: 480, y: 140, width: 1200, height: 800 }
  const clip = { x: stageBox.x + 40, y: stageBox.y + 40, width: Math.min(900, stageBox.width - 80), height: Math.min(600, stageBox.height - 80) }
  const before3d = await page.screenshot({ clip })

  // A slow orbit — the drag a person would do.
  const cx = stageBox.x + stageBox.width / 2
  const cy = stageBox.y + stageBox.height / 2
  await glide(page, cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 34; i++) {
    await page.mouse.move(cx + i * 11, cy + Math.sin(i / 7) * 16, { steps: 1 })
    await page.waitForTimeout(FAST ? 4 : 28)
  }
  await page.mouse.up()
  await beat(page, 1800)
  const after3d = await page.screenshot({ clip })
  check(!before3d.equals(after3d), `the 3D viewport re-renders under an orbit (${before3d.length} vs ${after3d.length} bytes)`)

  await demoClick(page, '[data-testid="v3d-top"]', { what: '"Top" view' })
  await beat(page, 2200)
  await demoClick(page, '[data-testid="v3d-persp"]', { what: '"Perspective"' })
  await beat(page, 2400)
  await demoClick(page, '[data-testid="mode-2d"]', { what: 'the 2D toggle' })
  await beat(page, 1800)

  // The plate calibration log must still be empty: we never performed the
  // trusted-human event, and this reads the store itself rather than trusting
  // that we did not.
  const plateRows = await page.evaluate(
    () =>
      new Promise((res) => {
        const rq = indexedDB.open('dsource')
        rq.onerror = () => res(-1)
        rq.onsuccess = () => {
          const db = rq.result
          if (!db.objectStoreNames.contains('plateLog')) return res(0)
          const c = db.transaction('plateLog', 'readonly').objectStore('plateLog').count()
          c.onsuccess = () => res(c.result)
          c.onerror = () => res(-1)
        }
      }),
  )
  check(plateRows === 0, `plate calibration log untouched by this run (${plateRows} rows) — no trusted-human event performed`)

  // ---------------------------------------------------------------- 6 · export
  step('exports')
  await chapter(page, '06 — Deliverables', 'Export the pack',
    'Plan, CAD, data, priced report, 12-sheet takeoff, BIM and 3D mesh — all from one document.')

  const MENU = [
    ['export-png', 'PNG image'],
    ['export-dxf', 'DXF'],
    ['export-csv', 'Data CSV'],
    ['export-pdf', 'PDF sheet'],
    ['export-report', 'Space planning report'],
    ['export-takeoff', 'Quantity Takeoff'],
    ['export-ifc', 'IFC model'],
    ['export-obj', 'OBJ model'],
  ]
  for (const [id, label] of MENU) {
    const before = saved.length
    await demoClick(page, '[data-testid="export-btn"]', { what: 'the Export menu' })
    await need(page, `[data-testid="${id}"]`, { timeout: 8000, what: `the "${label}" menu item` })
    await beat(page, 600)
    await demoClick(page, `[data-testid="${id}"]`, { what: `"${label}"`, settle: 180 })
    const got = await waitForDownloads(before + 1, id === 'export-report' || id === 'export-takeoff' ? 180000 : 60000)
    check(got > before, `${label} produced a download (${saved.slice(before).join(', ') || 'none'})`)
    await beat(page, 900)
  }
  await Promise.all(savers)

  // ---------------------------------------------------------------- 7 · reveal
  step('reveal the artifacts')
  const files = fs
    .readdirSync(EXPORTS)
    .sort()
    .map((name) => {
      const p = path.join(EXPORTS, name)
      const buf = fs.readFileSync(p)
      return { name, bytes: buf.length, kind: identify(buf, name.toLowerCase()), path: p, buf }
    })
  check(files.length >= MENU.length, `${files.length} artifacts on disk in out/demo/exports/`)
  for (const f of files) check(f.bytes > 256, `${f.name} — ${f.kind}, ${fmtBytes(f.bytes)}`)
  check(
    files.some((f) => f.kind === 'PNG image') &&
      files.some((f) => f.kind === 'PDF document') &&
      files.some((f) => f.kind === 'Excel workbook') &&
      files.some((f) => f.kind === 'DXF drawing') &&
      files.some((f) => f.kind === 'IFC model'),
    'the pack carries a raster plan, a PDF, a real .xlsx (EOCD found), a DXF and an IFC — identified from magic bytes',
  )

  const hero = files.find((f) => f.kind === 'PNG image')
  const resultsHtml = renderResults(files, hero, { project: 'Q3 Tenant Fit-out', floor: 'L14' })
  const resultsPath = path.join(OUT, 'results.html')
  fs.writeFileSync(resultsPath, resultsHtml)
  for (const f of files) delete f.buf

  await chapter(page, '07 — Results', 'What just came out',
    'Every file below was produced by the run you just watched.')
  await page.goto(pathToFileURL(resultsPath).href, { waitUntil: 'load' })
  await need(page, '#results', { timeout: 15000, what: 'the results page' })
  await beat(page, 4200)
  await smoothScroll(page, '#results', 1, 5200)
  await beat(page, 3600)
  await smoothScroll(page, '#results', 0, 2000)
  await beat(page, 2200)
  await chapter(page, 'DSource Studio', 'One document.\nEvery deliverable.', '', 2600)

  check(pageErrors.length === 0, `no uncaught page errors (${pageErrors.slice(0, 2).join(' | ') || 'none'})`)
  check(dialogs.length === 0, `no unexpected dialogs (${dialogs.join(' | ') || 'none'})`)
} finally {
  const video = page.video()
  await page.close()
  await context.close()
  await browser.close()
  if (video) {
    const raw = await video.path()
    videoPath = path.join(OUT, 'dsource-demo.webm')
    fs.rmSync(videoPath, { force: true })
    fs.renameSync(raw, videoPath)
    fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The recording is itself an artifact: verify it off its own bytes.

step('verify the recording')
if (!videoPath || !fs.existsSync(videoPath)) throw new StepError('Playwright wrote no video file')
const vbytes = fs.statSync(videoPath).size
check(vbytes > 512 * 1024, `dsource-demo.webm is ${fmtBytes(vbytes)}`)

let mp4Path = null
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
if (haveFfmpeg) {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height:format=duration', '-of', 'default=nw=1', videoPath], { encoding: 'utf8' })
  const dur = Number(probe.match(/duration=([\d.]+)/)?.[1] ?? 0)
  console.log(probe.trim().split('\n').map((l) => `  ${l}`).join('\n'))
  check(/width=1920/.test(probe) && /height=1080/.test(probe), 'the recording is 1920×1080')
  check(dur > 45, `the recording runs ${dur.toFixed(1)} s`)
  const dec = execFileSync('ffmpeg', ['-v', 'error', '-i', videoPath, '-f', 'null', '-'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  check(dec.trim() === '', `every frame of the webm decodes cleanly ${dec.trim().slice(0, 120)}`)

  if (WANT_MP4) {
    mp4Path = path.join(OUT, 'dsource-demo.mp4')
    fs.rmSync(mp4Path, { force: true })
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', videoPath, '-vf', 'scale=1920:1080:flags=lanczos,fps=30',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    const mdec = execFileSync('ffmpeg', ['-v', 'error', '-i', mp4Path, '-f', 'null', '-'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    check(fs.statSync(mp4Path).size > 256 * 1024 && mdec.trim() === '',
      `dsource-demo.mp4 is ${fmtBytes(fs.statSync(mp4Path).size)} and decodes cleanly`)
  }
} else {
  console.log('  note  ffmpeg not found — skipping the mp4 transcode and the decode check')
}

const secs = ((Date.now() - t0) / 1000).toFixed(0)
console.log(`\n${'─'.repeat(72)}`)
console.log(`${failures ? 'FAIL' : 'PASS'}  demo recording — ${checks - failures}/${checks} checks in ${secs} s`)
console.log(`\nVIDEO   ${videoPath}`)
if (mp4Path) console.log(`MP4     ${mp4Path}`)
console.log(`FILES   ${EXPORTS}`)
console.log(`RESULTS ${path.join(OUT, 'results.html')}`)
process.exit(failures ? 1 : 0)

// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** The end card: the artifacts, listed from what is actually on disk. */
function renderResults(files, hero, meta) {
  const total = files.reduce((s, f) => s + f.bytes, 0)
  const heroImg = hero
    ? `<img class="hero" src="data:image/png;base64,${hero.buf.toString('base64')}" alt="Exported plan" />`
    : ''
  const rows = files
    .map(
      (f) => `<tr>
      <td class="n">${esc(f.name)}</td>
      <td class="k">${esc(f.kind)}</td>
      <td class="b num">${fmtBytes(f.bytes)}</td>
    </tr>`,
    )
    .join('\n')
  return `<!doctype html><meta charset="utf-8"><title>DSource — exported artifacts</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:#0b0c0e;color:#eef0f3;
    font-family:'Hanken Grotesk',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
  #results{height:100%;overflow:auto;padding:64px 88px 96px}
  .eyebrow{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:12px;
    letter-spacing:.32em;text-transform:uppercase;color:#7d8592}
  h1{font-size:52px;line-height:1.06;letter-spacing:-.02em;margin:12px 0 10px;font-weight:600}
  .sub{color:#9aa3af;font-size:18px;margin:0 0 40px;max-width:70ch}
  .grid{display:grid;grid-template-columns:1.15fr 1fr;gap:52px;align-items:start}
  .hero{width:100%;border-radius:10px;border:1px solid #23262c;background:#fff;display:block}
  table{width:100%;border-collapse:collapse;font-size:16px}
  th{text-align:left;font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:11px;
    letter-spacing:.22em;text-transform:uppercase;color:#7d8592;font-weight:500;
    padding:0 0 12px;border-bottom:1px solid #23262c}
  td{padding:13px 0;border-bottom:1px solid #17191d;vertical-align:baseline}
  td.n{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:14.5px;color:#eef0f3}
  td.k{color:#9aa3af}
  .num{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;text-align:right;color:#c9cfd8}
  .foot{margin-top:34px;display:flex;gap:44px;flex-wrap:wrap}
  .stat .v{font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;font-size:30px}
  .stat .l{font-size:13px;color:#7d8592;margin-top:4px}
  .where{margin-top:40px;font-family:ui-monospace,'IBM Plex Mono',Menlo,monospace;
    font-size:14px;color:#7d8592;border-top:1px solid #23262c;padding-top:18px;word-break:break-all}
</style>
<div id="results">
  <div class="eyebrow">Deliverables · ${esc(meta.project)} · Floor ${esc(meta.floor)}</div>
  <h1>Every file the run produced.</h1>
  <p class="sub">One CAD plate in. One document. These came out of it — drawing, data, priced
     report, 12-sheet quantity takeoff, BIM and a 3D mesh.</p>
  <div class="grid">
    <div>${heroImg}</div>
    <div>
      <table>
        <thead><tr><th>File</th><th>Kind</th><th style="text-align:right">Size</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="foot">
        <div class="stat"><div class="v">${files.length}</div><div class="l">artifacts</div></div>
        <div class="stat"><div class="v">${fmtBytes(total)}</div><div class="l">total on disk</div></div>
        <div class="stat"><div class="v">${new Set(files.map((f) => f.kind)).size}</div><div class="l">formats</div></div>
      </div>
    </div>
  </div>
  <div class="where">out/demo/exports/</div>
</div>`
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
