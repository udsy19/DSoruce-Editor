// Headless driver for the multi-sheet architectural drawing set (sheetSet.ts).
//
// SAME CODE PATH AS THE APP. `web/src/ui/SheetsPanel.tsx` builds a
// `DrawingSetOpts` from its form and calls `exportDrawingSet` → this script
// builds the SAME opts (fixed, deterministic title block; every available sheet
// included) and calls `buildDrawingSetPdf`, the function that download wraps.
// The sheets need a real `<canvas>` (renderPrintCanvas + canvasToJpeg) and the
// section sheets want WebGL, so — exactly as `scripts/render-plan.mjs` does for
// the plan graphic — the modules are esbuild-bundled and run inside headless
// Chromium via Playwright. Nothing is re-implemented for Node.
//
//   node scripts/render-sheets.mjs [--case seeded|testfit|dwg] [--out out/sheets]
//   node scripts/render-sheets.mjs --case all
//
// Writes `<out>/<case>-drawing-set.pdf` and prints the page count.
//
// Also the module the drawing-set regression test drives:
//   import { renderSheetSet } from './render-sheets.mjs'

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO, buildDemoDoc, buildTestFitDoc, buildDwgDoc, zoneAreaPairs } from './lib/demo-doc.mjs'

export const CASES = ['seeded', 'testfit', 'dwg']

/**
 * The title block, frozen. The app's defaults come from a form; a harness that
 * typed different words every run could not be diffed, so these are fixed here
 * and nowhere else. (`sheetSet.todayLabel()` still stamps the real date on every
 * sheet — the regression test normalises it, it is not made fake here.)
 */
export const SHEET_META = {
  project: 'DSource Demo Fit-Out',
  client: 'Studio Nova',
  address: '46 Residency Road, Bengaluru',
  studio: 'DSOURCE',
  revision: 'A',
  drawnBy: 'DS',
  approvedBy: 'UT',
}

let cachedEsbuild = null
async function esbuild() {
  if (cachedEsbuild) return cachedEsbuild
  const webRequire = createRequire(path.join(REPO, 'web/package.json'))
  const mod = await import(pathToFileURL(createRequire(webRequire.resolve('vite')).resolve('esbuild')).href)
  cachedEsbuild = mod.build
  return cachedEsbuild
}

async function playwrightChromium() {
  const webRequire = createRequire(path.join(REPO, 'web/package.json'))
  const pw = await import(pathToFileURL(webRequire.resolve('playwright')).href)
  return pw.chromium ?? pw.default.chromium
}

/** The document for a round-trip case — the same three `demo-doc.mjs` builders
 *  every other harness and gate uses (G9's cases, G11's `--case`). */
export async function buildCaseDoc(name) {
  if (name === 'seeded') return buildDemoDoc({ seed: 7 })
  if (name === 'testfit') return buildTestFitDoc()
  if (name === 'dwg') return buildDwgDoc({ esbuild: await esbuild() })
  throw new Error(`unknown case '${name}'; expected one of ${CASES.join(', ')}`)
}

/**
 * Build the drawing-set PDF for one case, in headless Chromium.
 *
 * @param {string} name  one of CASES
 * @param {{ freezeDateAt?: string }} [opts]
 *   `freezeDateAt` (ISO instant, e.g. `'2026-01-01T12:00:00Z'`) pins the page's
 *   clock to UTC and to that instant before the set is built, so `todayLabel()`
 *   stamps the same date on every run. The PDF path itself is untouched — this
 *   only removes the one legitimately-varying value from the output, which is
 *   what makes a raster harness reproducible across days. Omit it and the real
 *   clock is used (the default, and what `drawing-set.test.mjs` renders with —
 *   it masks the date in its digest instead).
 * @returns `{ pdf: Buffer, pages: number, doc, warnings, geometry }`
 */
export async function renderSheetSet(name = 'seeded', opts = {}) {
  const freezeAt = opts.freezeDateAt ?? null
  const doc = await buildCaseDoc(name)
  const build = await esbuild()
  const bundle = await build({
    stdin: {
      contents: `
        import { buildDrawingSetPdf, sheetGeometry } from './src/export/sheetSet'
        window.DS = { buildDrawingSetPdf, sheetGeometry }
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

  const chromium = await playwrightChromium()
  // SwiftShader so the section sheets take the real WebGL path headlessly
  // (sectionSheets is try-wrapped in buildDrawingSetPdf — without a GL context
  // the set would silently come back two sheets short).
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-lcd-text'],
  })
  const page = await browser.newPage(freezeAt ? { timezoneId: 'UTC' } : {})
  const warnings = []
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text())
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const { b64, geometry } = await page.evaluate(
    async ({ state, drawing, meta, freezeAt, zoneAreas }) => {
      if (freezeAt) {
        const Real = Date
        const fixed = Real.parse(freezeAt)
        class Frozen extends Real {
          constructor(...a) {
            super(...(a.length === 0 ? [fixed] : a))
          }
          static now() {
            return fixed
          }
        }
        window.Date = Frozen
      }
      // Template geometry (pt) — constants, read before anything is drawn.
      const geometry = window.DS.sheetGeometry()
      const bytes = await window.DS.buildDrawingSetPdf(state, { meta, drawing, zoneAreas: new Map(zoneAreas) })
      let s = ''
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
      return { b64: btoa(s), geometry }
    },
    { state: doc.state, drawing: doc.drawing ?? null, meta: SHEET_META, freezeAt, zoneAreas: zoneAreaPairs(doc.quantities) },
  )
  await browser.close()

  const pdf = Buffer.from(b64, 'base64')
  const pages = Number((pdf.toString('latin1').match(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/) ?? [])[1] ?? 0)
  return { pdf, pages, doc, warnings, geometry }
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
  }
  const which = arg('--case', 'seeded')
  const outDir = path.resolve(REPO, arg('--out', 'out/sheets'))
  fs.mkdirSync(outDir, { recursive: true })
  for (const name of which === 'all' ? CASES : [which]) {
    const { pdf, pages, doc, warnings } = await renderSheetSet(name)
    const file = path.join(outDir, `${name}-drawing-set.pdf`)
    fs.writeFileSync(file, pdf)
    console.log(
      `${name}: ${pages} sheets · ${pdf.length} B → ${path.relative(REPO, file)} ` +
        `(${doc.state.components.length} components, ${(doc.state.zones ?? []).length} zones)`,
    )
    for (const w of warnings) console.log(`  console: ${w}`)
  }
}
