#!/usr/bin/env node
// G10 — One-action UX.
//
// Every earlier gate can pass while the product still requires a designer to
// click six different export buttons. This gate proves the whole pack falls out
// of ONE action: find the "Export deliverable pack" control, click it once, and
// wait for all five artifacts to appear.
//
//   xlsx + 4 renders + mp4 + a share link, from a single click.
//
// Usage: g10-one-action.mjs [--base http://localhost:5173] [--out out]
//                           [--selector "[data-testid=export-deliverable-pack]"]
//                           [--timeout 300000] [--verify-only]
//
// --verify-only skips the browser and just asserts the artifacts exist, which
// is what CI runs when a previous step already produced them.
import fs from 'node:fs'
import path from 'node:path'
import * as L from './lib/gatelib.mjs'

const RENDERS = ['Reception', 'Open_space', 'Work_stations', 'Conference_room']

function present(p) {
  return fs.existsSync(p) && fs.statSync(p).size > 0
}

await L.runGate('G10', async (g) => {
  const base = L.arg('--base', process.env.DSOURCE_BASE_URL || 'http://localhost:5173')
  const out = path.resolve(L.arg('--out', L.OUT))
  const selector = L.arg('--selector', '[data-testid="export-deliverable-pack"]')
  const timeout = Number(L.arg('--timeout', '300000'))
  const verifyOnly = L.hasFlag('--verify-only')

  const expected = [
    ['workbook', path.join(out, 'quantity-takeoff.xlsx')],
    ['ground truth', path.join(out, 'ground-truth.json')],
    ['plan', path.join(out, 'plan.png')],
    ...RENDERS.map((r) => [`render ${r}`, path.join(out, 'renders', `${r}.png`)]),
    ['walkthrough', path.join(out, 'walkthrough.mp4')],
    ['share link', path.join(out, 'share.json')],
  ]

  if (!verifyOnly) {
    // ---- drive the single action -----------------------------------------
    const chromium = await L.loadPlaywright()
    let browser
    try {
      browser = await chromium.launch()
    } catch (e) {
      throw new Error(`could not launch Chromium: ${e.message}`)
    }
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
      page.on('pageerror', (e) => g.note(`pageerror: ${String(e.message).slice(0, 140)}`))

      try {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } catch (e) {
        throw new L.Missing(
          `app unreachable at ${base} (${e.message}) — start it with ` +
          '`pnpm --dir web dev` before running G10',
        )
      }

      // Snapshot what already exists so we can prove the click produced it.
      const before = new Map(expected.map(([, p]) => [p, present(p) ? fs.statSync(p).mtimeMs : 0]))

      const btn = await page.$(selector)
      if (!btn) {
        g.fail(
          `no single "Export deliverable pack" control found (selector ${selector}). ` +
          'The UI must expose one control carrying data-testid="export-deliverable-pack" ' +
          'that produces the whole pack.',
        )
        return
      }

      const clicks = await page.$$(selector)
      g.check(clicks.length === 1,
        `${clicks.length} controls match ${selector} — the action must be unambiguous`)

      await btn.click()

      // Poll for every artifact to land.
      const deadline = Date.now() + timeout
      let pending = expected.filter(([, p]) => !present(p) ||
        fs.statSync(p).mtimeMs <= before.get(p))
      while (pending.length && Date.now() < deadline) {
        await page.waitForTimeout(2000)
        pending = expected.filter(([, p]) => !present(p) ||
          fs.statSync(p).mtimeMs <= before.get(p))
      }
      g.check(pending.length === 0,
        `after one click, ${pending.length} artifact(s) never appeared within ` +
        `${Math.round(timeout / 1000)}s: ${pending.map(([n]) => n).join(', ')}`)
    } finally {
      await browser.close()
    }
  }

  // ---- the pack is complete either way -----------------------------------
  for (const [what, p] of expected) {
    if (!present(p)) throw new L.Missing(`${what} ${p}`)
  }

  const share = L.loadJson(path.join(out, 'share.json'), 'share link')
  g.check(!!(share.url || share.planId),
    'share.json has neither "url" nor "planId" — the pack has no viewer link')

  const sizes = expected.map(([what, p]) => `${what}=${(fs.statSync(p).size / 1024).toFixed(0)}KB`)
  g.note(sizes.join(' '))
  g.check(fs.statSync(path.join(out, 'walkthrough.mp4')).size > 100 * 1024,
    'walkthrough.mp4 is under 100KB — almost certainly an empty encode')
})
