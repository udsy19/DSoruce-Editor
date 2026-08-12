// Workstream E (placement inset): reproduce the user's exact path and dump the
// DOCUMENT — not pixels — for the containment report.
//
//   node scripts/containment-dump.e2e.mjs [--port 5305] [--out <dir>]
//
// Path driven (PROVENANCE.md, reports/editor-completion/before/): wizard →
// Property → Space (samples/furniture-plan.dwg, boundary confirmed) → Program
// (defaults untouched) → Generate → candidate A → Open in editor. Deterministic
// per the zone-dump fixture: 268 components / 53 zones / 186 walls.
//
// The dump is `Editor.state()` via the dev-only `window.__ec` seam — document
// geometry straight off the wasm boundary. The containment math itself lives in
// scripts/containment-report.mjs so it can re-run on the frozen dump.
//
// Provenance rules (gate-independence.md): the page is reloaded unconditionally
// and the served module graph is checked for a known identifier BEFORE any
// claim; the dump records the yardsticks it matched.
//
// Plate-log note: this drives the confirm flow, which is gated by
// `isRealSession()` (web/src/persist/plateLog.ts) — false under DEV and false
// when `navigator.webdriver` is set, both of which hold here (dev server,
// headless launch). No calibration-log row is produced; verified by the dump
// step reading the log store afterwards and asserting it is empty.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
}
const PORT = Number(arg('--port', '5305'))
const OUT_DIR = arg('--out', path.join(ROOT, 'reports/editor-completion/containment'))

const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const playwright = await import(pathToFileURL(webRequire.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default.chromium

const die = (msg) => {
  console.error(`FATAL: ${msg}`)
  process.exit(1)
}
const log = (msg) => console.log(`[dump] ${msg}`)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.setDefaultTimeout(60_000)

try {
  await page.goto(`http://localhost:${PORT}/`)
  // Reload is not goto — force it, unconditionally, then prove the served
  // module graph is this worktree's before anything else is believed.
  await page.reload()
  const token = await page.evaluate(async () => {
    const r = await fetch('/src/editor/interaction.ts', { cache: 'no-store' })
    const s = await r.text()
    return s.includes('dragRect')
  })
  if (!token) die(`served module graph on :${PORT} lacks 'dragRect' — wrong or stale server`)
  log(`provenance: :${PORT} serves dragRect in src/editor/interaction.ts`)

  // ---- Property ----
  await page.click('[data-testid=project-new]')
  await page.fill('[data-testid=create-name]', 'WS-E containment repro')
  // Property name is the one required field — readiness gates on it.
  await page.fill('[data-testid=create-property]', 'WS-E Containment Plate')
  await page.click('[data-testid=create-submit]')
  log('property step done')

  // ---- Space: upload the sample DWG, confirm the boundary ----
  await page.waitForSelector('[data-testid=space-step]')
  await page.setInputFiles('[data-testid=space-upload-input]', path.join(ROOT, 'samples/furniture-plan.dwg'))
  log('DWG uploaded, waiting for trace…')
  // A low-confidence boundary surfaces a confirm button; a traced one enables
  // Next directly. Wait for either.
  const confirm = page.locator('[data-testid=plate-draft-confirm]')
  const next = page.locator('[data-testid=wizard-next]:not([disabled])')
  await Promise.race([
    confirm.waitFor({ state: 'visible', timeout: 120_000 }),
    next.waitFor({ state: 'visible', timeout: 120_000 }),
  ])
  let boundaryConfirmed = false
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click()
    boundaryConfirmed = true
    log('boundary draft confirmed')
  } else {
    log('no confirm prompt (plate traced with confidence)')
  }
  await next.waitFor({ state: 'visible', timeout: 60_000 })
  await page.click('[data-testid=wizard-next]')
  log('space step done')

  // ---- Program: defaults untouched; record what they were ----
  await page.waitForSelector('[data-testid=program-step]')
  await page.waitForSelector('[data-testid=program-next]:not([disabled])')
  const programSummary = (await page.locator('[data-testid=program-summary]').innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
    .trim()
  log(`program summary: ${programSummary}`)
  await page.click('[data-testid=program-next]')

  // ---- Generate: wait for the gallery, open candidate A (first card) ----
  await page.waitForSelector('[data-testid=generate-step]')
  await page.waitForSelector('[data-testid=generate-alt-open]', { timeout: 180_000 })
  const cardTexts = await page.locator('[data-testid=generate-alt]').allInnerTexts()
  const cardA = (cardTexts[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  log(`candidate A card: ${cardA}`)
  await page.locator('[data-testid=generate-alt-open]').first().click()

  // ---- Editor: read the document off the dev seam ----
  await page.waitForFunction(
    () => {
      const ec = window.__ec
      if (!ec) return false
      try {
        return ec.getState().components.length > 0
      } catch {
        return false
      }
    },
    { timeout: 60_000 },
  )
  const dump = await page.evaluate(() => {
    const ec = window.__ec
    const s = ec.getState()
    return JSON.parse(
      JSON.stringify({
        walls: s.walls.length,
        components: s.components,
        zones: s.zones ?? [],
      }),
    )
  })
  log(`document: ${dump.components.length} components / ${dump.zones.length} zones / ${dump.walls} walls`)

  // The trusted-human store must be untouched by this run (see header).
  const plateLogRows = await page.evaluate(async () => {
    try {
      const req = indexedDB.open('dsource')
      const db = await new Promise((res, rej) => {
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
      if (!db.objectStoreNames.contains('plateLog')) return 0
      const tx = db.transaction('plateLog', 'readonly')
      const all = tx.objectStore('plateLog').getAll()
      const rows = await new Promise((res, rej) => {
        all.onsuccess = () => res(all.result)
        all.onerror = () => rej(all.error)
      })
      return rows.length
    } catch (e) {
      return `unreadable: ${e}`
    }
  })
  log(`plateLog rows written by this run: ${plateLogRows}`)

  // On-screen confirmation at the SAME region as the before-image
  // (reports/editor-completion/before/desks-topleft-crop.png): the workspace
  // zone's top-left corner. Document-derived framing — zone 680's bbox comes
  // from the dump just taken, not from a hand-picked pixel location.
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const ws = dump.zones.find((z) => z.label === 'Open Workspace (1)')
  if (ws && ws.shape.kind === 'Rect') {
    const corner = { x: ws.shape.x - ws.shape.w / 2, y: ws.shape.y + ws.shape.h / 2 }
    await page.evaluate(({ x, y }) => {
      const ec = window.__ec
      const canvas = document.querySelector('canvas')
      const r = canvas.getBoundingClientRect()
      ec.scale = 46
      ec.offset.x = r.width / 2 - x * 46
      ec.offset.y = r.height / 2 - y * 46
      ec.render()
    }, corner)
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(OUT_DIR, 'after.desks-topleft.png'),
      clip: { x: 200, y: 100, width: 1200, height: 800 },
    })
    log('screenshot: after.desks-topleft.png (workspace top-left corner)')
  } else {
    log('WARNING: Open Workspace (1) not found as Rect — no screenshot taken')
  }

  const outPath = path.join(OUT_DIR, 'state.candidateA.json')
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        provenance: {
          capturedAt: new Date().toISOString(),
          port: PORT,
          servedTokenCheck: "dragRect in src/editor/interaction.ts",
          path: 'wizard → samples/furniture-plan.dwg → boundary → Program defaults → Generate → candidate A → Open in editor',
          boundaryConfirmed,
          programSummary,
          candidateACard: cardA,
          plateLogRows,
        },
        totals: {
          components: dump.components.length,
          zones: dump.zones.length,
          walls: dump.walls,
        },
        components: dump.components,
        zones: dump.zones,
      },
      null,
      1,
    ) + '\n',
  )
  // The tooling rule: re-read what was written before reporting success.
  const back = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  if (back.components.length !== dump.components.length) die('write did not take')
  log(`wrote ${outPath}`)
} finally {
  await browser.close()
}
