// The live bank's `price` field is a RECORD, not a number — and reading it as a
// number is silent.
//
// Run from web/:  node src/materialBank/bankPrice.test.mjs
// @covers: web/src/materialBank/client.ts
//
// What this guards. `/api/bank/match` returns, for a priced row:
//
//   "price": { "price_inr": 140500.0, "basis": "listed_mrp",
//              "observed_at": "...", "source_url": "...",
//              "stale": false, "age_days": 21 }
//
// `client.ts` read that with `r.price ?? r.price_inr ?? null`, so `price` became
// the OBJECT. `formatINR` then asked `Number.isFinite(object)`, got false, and
// rendered an em dash — the panel's own "spec-only supplier" wording. Every live
// price in the product bank displayed as "—" while the bank had priced the
// product to the rupee, and nothing failed: the fallback path was already the
// designed behaviour for genuinely unpriced rows, so the bug wore the costume of
// a feature.
//
// INDEPENDENCE (.claude/rules/gate-independence.md). The fixture below is a
// VERBATIM response captured from the running bank service, not a shape this
// repo emits, and the expected rupee figures are read out of that captured JSON
// rather than out of the parser. The parser cannot decide what it is measured
// against. A row with a bare-number price and a row with an empty record are
// included so back-compat and the honest-null path are asserted too.

import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const out = path.join(here, `.bankprice-${process.pid}.mjs`)
await build({
  stdin: {
    contents: `export { searchBankLive, priceProvenanceLine, formatINR, BANK_SHELVES, shelfFootprint } from './client'`,
    resolveDir: here,
    loader: 'ts',
  },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
})
const { searchBankLive, priceProvenanceLine, formatINR, BANK_SHELVES, shelfFootprint } =
  await import(pathToFileURL(out).href)
fs.rmSync(out, { force: true })

// --- captured verbatim from GET /api/bank/match (2026-08-07) -----------------
const CAPTURED = {
  query: 'office lounge sofa',
  count: 3,
  results: [
    {
      id: 40311,
      brand: 'Pinakin',
      title: 'Lounge Sofa',
      category: 'furniture|seating',
      size_mm: null,
      finish: null,
      price_unit: null,
      image_url: 'https://pinakinstudio.com/img/lounge-sofa.jpg',
      supplier_domain: 'pinakinstudio.com',
      score: 0.031,
      price: {
        price_inr: 140500.0,
        price_unit: null,
        basis: 'listed_mrp',
        observed_at: '2026-07-16T06:46:52.072329+00:00',
        source: 'pinakinstudio.com',
        source_url: 'https://pinakinstudio.com/product/lounge-sofa/',
        stale: false,
        age_days: 21,
      },
    },
    {
      // Spec-only supplier: the bank publishes no price at all.
      id: 51002,
      brand: 'Steelcase',
      title: 'Cornet Modern Office Lounge Sofa',
      category: 'office_furniture|lounge',
      image_url: null,
      supplier_domain: 'steelcase.com',
      price: null,
    },
    {
      // Older bank builds sent a bare number. It must keep working, with no
      // provenance invented to fill the gap.
      id: 60004,
      brand: 'Ek Design',
      title: 'Neo Two-Seater',
      category: 'furniture|seating',
      image_url: null,
      supplier_domain: 'ekdesign.in',
      price: 88000,
    },
  ],
}

// Ground truth read out of the CAPTURE, never out of the parser.
const expected = CAPTURED.results.map((r) =>
  r.price == null ? null : typeof r.price === 'number' ? r.price : r.price.price_inr,
)
assert.deepEqual(expected, [140500, null, 88000], 'fixture self-check')

globalThis.window = globalThis
let requested = null
globalThis.fetch = async (url) => {
  requested = String(url)
  return { ok: true, status: 200, json: async () => CAPTURED }
}

const rows = await searchBankLive('office lounge sofa')

assert.ok(
  requested.startsWith('/api/bank/match?q='),
  `bank client must call /match (not /search, which 404s) — called ${requested}`,
)
assert.equal(rows.length, 3)

// 1. THE DEFECT: a record-shaped price yields a NUMBER equal to price_inr.
assert.equal(typeof rows[0].price, 'number', 'record-shaped price must parse to a number')
assert.equal(rows[0].price, expected[0])
assert.equal(formatINR(rows[0].price), '₹1,40,500', 'and must render as ₹, not an em dash')

// 2. Provenance travels with the money, verbatim.
assert.deepEqual(rows[0].provenance, {
  basis: 'listed_mrp',
  observedAt: CAPTURED.results[0].price.observed_at,
  sourceUrl: CAPTURED.results[0].price.source_url,
  ageDays: 21,
  stale: false,
})
assert.equal(priceProvenanceLine(rows[0].provenance), 'listed mrp · observed 21d ago')

// 3. Genuinely unpriced stays unpriced — an em dash, and NO invented provenance.
assert.equal(rows[1].price, null)
assert.equal(rows[1].provenance, null)
assert.equal(formatINR(rows[1].price), '—')
assert.equal(priceProvenanceLine(rows[1].provenance), null)

// 4. Back-compat: a bare number still parses, and carries no provenance.
assert.equal(rows[2].price, expected[2])
assert.equal(rows[2].provenance, null)

// 5. Ids stay namespaced so a binding is traceable back to the catalogue row.
assert.equal(rows[0].id, `bank:${CAPTURED.results[0].id}`)
assert.equal(rows[0].supplier, 'pinakinstudio.com')
assert.equal(rows[0].vendor, 'Pinakin')

// --- the shelves the editor's library places from ---------------------------
// A shelf that names a footprint the bank table does not define would stamp
// `undefined × undefined` onto the plan.
for (const s of BANK_SHELVES) {
  const [w, h] = shelfFootprint(s)
  assert.ok(w > 0 && h > 0, `shelf ${s.key} has no footprint`)
  assert.ok(s.docCategory.length > 0 && s.query.length > 0, `shelf ${s.key} is incomplete`)
}
assert.equal(new Set(BANK_SHELVES.map((s) => s.key)).size, BANK_SHELVES.length, 'shelf keys unique')

console.log(`bankPrice.test.mjs: ALL PASS (${rows.length} rows, ${BANK_SHELVES.length} shelves)`)
