#!/usr/bin/env node
// G8 — Web 3D viewer.
//
// qbiq's fourth deliverable is a link: a shareable page that opens the model in
// the browser. This gate proves the link exists, serves HTML, and paints real
// 3D — not an empty canvas.
//
//   * GET /share/:planId returns 200 with an HTML content type
//   * Playwright loads it and a <canvas> with a live WebGL context appears
//   * a screenshot has >5% non-background pixels
//   * walk mode toggles (a control matching --walk-selector flips state)
//
// Usage: g8-web-viewer.mjs [--base http://localhost:5173] [--url <full share url>]
//                          [--share out/share.json] [--timeout 20000]
//                          [--walk-selector "[data-testid=walk-toggle]"]
//                          [--screenshot out/g8-viewer.png] [--min-ink 5]
import fs from 'node:fs'
import path from 'node:path'
import * as L from './lib/gatelib.mjs'

await L.runGate('G8', async (g) => {
  const base = L.arg('--base', process.env.DSOURCE_BASE_URL || 'http://localhost:5173')
  const timeout = Number(L.arg('--timeout', '20000'))
  const walkSel = L.arg('--walk-selector', '[data-testid="walk-toggle"]')
  const shot = L.arg('--screenshot', path.join(L.OUT, 'g8-viewer.png'))
  const minInk = Number(L.arg('--min-ink', '5')) / 100

  const url = L.resolveShareUrl(base)
  g.note(`share url: ${url}`)

  // ---- 1. the route serves HTML ------------------------------------------
  let res
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (e) {
    throw new L.Missing(
      `share route unreachable at ${url} (${e.message}) — start the app ` +
      '(pnpm --dir web dev, or ./deploy) before running G8',
    )
  }
  if (!g.check(res.status === 200, `GET ${url} returned ${res.status}, need 200`)) return
  const ctype = res.headers.get('content-type') || ''
  g.check(/text\/html/i.test(ctype), `share route content-type is ${ctype!== '' ? ctype : '(none)'}, need text/html`)
  const html = await res.text()
  g.check(html.length > 200, `share route returned ${html.length} bytes of HTML, looks empty`)

  // ---- 2. it actually paints ---------------------------------------------
  const chromium = await L.loadPlaywright()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))
    await page.goto(url, { waitUntil: 'load', timeout })

    await page.waitForSelector('canvas', { timeout }).catch(() => {})
    const canvasInfo = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      if (!c) return null
      let ctx = null
      try { ctx = c.getContext('webgl2') || c.getContext('webgl') } catch { /* ignore */ }
      return { w: c.width, h: c.height, webgl: !!ctx }
    })
    if (!g.check(canvasInfo, 'no <canvas> element on the share page')) return
    g.check(canvasInfo.webgl, 'the <canvas> has no WebGL context — the 3D viewer never initialised')
    g.check(canvasInfo.w > 100 && canvasInfo.h > 100,
      `canvas is ${canvasInfo.w}x${canvasInfo.h}, too small to be the viewer`)

    // Give the renderer a couple of frames to draw.
    await page.waitForTimeout(1500)
    fs.mkdirSync(path.dirname(shot), { recursive: true })
    await page.screenshot({ path: shot })

    const ink = await page.evaluate(() => {
      const c = document.querySelector('canvas')
      const off = document.createElement('canvas')
      const s = 200
      off.width = s; off.height = s
      const g2 = off.getContext('2d')
      g2.drawImage(c, 0, 0, s, s)
      const d = g2.getImageData(0, 0, s, s).data
      // Background = the modal colour of the four corners.
      const corner = [0, (s - 1) * 4, (s * (s - 1)) * 4, (s * s - 1) * 4]
        .map((i) => [d[i], d[i + 1], d[i + 2]])
      const bg = corner[0]
      let hit = 0
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - bg[0]) > 10 || Math.abs(d[i + 1] - bg[1]) > 10 ||
            Math.abs(d[i + 2] - bg[2]) > 10) hit++
      }
      return hit / (s * s)
    }).catch(() => 0)
    g.check(ink > minInk,
      `viewer canvas is ${(ink * 100).toFixed(2)}% non-background, need >${minInk * 100}% — ` +
      `the scene is empty (screenshot: ${shot})`)
    g.note(`canvas ${canvasInfo.w}x${canvasInfo.h} webgl=${canvasInfo.webgl} ink=${(ink * 100).toFixed(2)}%`)

    // ---- 3. walk mode toggles --------------------------------------------
    const toggle = await page.$(walkSel)
    if (!toggle) {
      g.fail(`walk-mode control not found (selector ${walkSel}) — the viewer must expose ` +
             'a walk toggle carrying data-testid="walk-toggle"')
    } else {
      const before = await page.evaluate((s) => {
        const el = document.querySelector(s)
        return el.getAttribute('aria-pressed') ?? el.dataset.active ?? el.className
      }, walkSel)
      await toggle.click()
      await page.waitForTimeout(600)
      const after = await page.evaluate((s) => {
        const el = document.querySelector(s)
        return el.getAttribute('aria-pressed') ?? el.dataset.active ?? el.className
      }, walkSel)
      g.check(before !== after,
        `walk toggle did not change state on click (still ${String(before)}) — ` +
        'expose the mode via aria-pressed or data-active')
    }

    g.check(errors.length === 0, `page threw ${errors.length} JS error(s): ${errors.slice(0, 2).join(' | ')}`)
  } finally {
    await browser.close()
  }
})
