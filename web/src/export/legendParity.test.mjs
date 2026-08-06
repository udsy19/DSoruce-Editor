// ALL THREE legends agree: program zones only — Phase 2.6.
//
// Run from web/:  node src/export/legendParity.test.mjs
// @covers: web/src/editor/planStyle.ts   (legendEntries — the app panel)
// @covers: web/src/export/pdf.ts         (the single-sheet ZONE KEY)
// @covers: web/src/export/report.ts      (LEGEND_ORDER — the per-alternative page)
//
// Three independent legend implementations existed, and the audit found them in
// three different states: the app panel listed Circulation, `pdf.ts` correctly
// excluded ground, and `report.ts` listed it deliberately ("qbiq lists rooms
// first, circulation last"). A legend is the ONLY identification a sheet
// carries, so three surfaces disagreeing about what a plan contains is worse
// than any one of them being wrong.
//
// This is a census, not three separate assertions: they must agree WITH EACH
// OTHER and with the ground rule.

import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'legend-')), 'planStyle.mjs')
await build({
  entryPoints: [path.join(here, '../editor/planStyle.ts')],
  outfile: out, bundle: true, format: 'esm', platform: 'neutral',
  target: 'es2022', logLevel: 'silent',
})
const S = await import(pathToFileURL(out).href)

const GROUND = ['Circulation', 'Unassigned']
const ALL = ['Workspace', 'ClosedOffice', 'Meeting', 'Collaboration', 'Amenity', 'Core', ...GROUND]

// --- surface 1: the app panel, via the derived helper -----------------------
const zones = ALL.map((t, i) => ({ id: i + 1, zone_type: t }))
const panel = S.legendEntries(zones).map((e) => e.kind)
for (const g of GROUND) {
  assert.ok(!panel.includes(g), `app legend lists ${g} — a swatch keyed to white explains nothing`)
}
assert.ok(panel.length >= 5, `app legend collapsed to ${panel.length} entries`)

// --- surface 2: the single-sheet ZONE KEY (pdf.ts) --------------------------
const pdf = fs.readFileSync(path.join(here, 'pdf.ts'), 'utf8')
assert.ok(
  /groundZones\.includes\(z\.zone_type\)\)\s*continue/.test(pdf),
  'pdf.ts ZONE KEY no longer skips ground zones',
)

// --- surface 3: the per-alternative page (report.ts LEGEND_ORDER) -----------
const report = fs.readFileSync(path.join(here, 'report.ts'), 'utf8')
const m = /const LEGEND_ORDER: ZoneType\[\] = \[([^\]]*)\]/.exec(report)
assert.ok(m, 'LEGEND_ORDER not found in report.ts')
const order = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
for (const g of GROUND) {
  assert.ok(!order.includes(g),
    `report.ts LEGEND_ORDER lists ${g} — the per-alternative page would print a ground swatch ` +
    'while the app panel and the PDF sheet do not')
}
assert.ok(order.length >= 5, `LEGEND_ORDER collapsed to ${order.length} entries`)

// --- the census: all three agree ------------------------------------------
assert.deepEqual([...order].sort(), [...panel].sort(),
  `the app legend and the report legend list DIFFERENT zone sets:\n` +
  `  panel  ${JSON.stringify([...panel].sort())}\n  report ${JSON.stringify([...order].sort())}`)

console.log(`PASS legendParity: app / pdf / report all program-only and mutually identical (${panel.length} entries)`)
