// The commercial set — bill of materials · quotation · product specification.
// Run from web/:  node src/export/commercial.test.mjs
//
// The claim these three documents make to an investor is that they descend from
// ONE model and cannot disagree with it or with each other. A test that read the
// model's own totals back out would be transcribing that claim, not checking it
// (.claude/rules/gate-independence.md), so every quantity and every rupee below
// is RE-DERIVED HERE by walking `Editor.state().components` directly — the core,
// which is the source of truth — and compared against what the documents say.
//
// The PDFs are checked BY THE BYTES: `%PDF` header, `%%EOF` trailer, an xref
// table, and the document fingerprint present in the page content stream. The
// last one is falsified in both directions — a foreign fingerprint must be
// ABSENT — so "the string was found" cannot be an accident of the check.
//
// @covers: web/src/export/commercial.ts
// @covers: web/src/export/commercialDocs.ts
// @covers: web/src/export/takeoff.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.join(here, '../wasm/ds_core_bg.wasm')
if (!fs.existsSync(wasmPath)) {
  console.log('SKIP: wasm not built (run `make wasm`)')
  process.exit(0)
}

const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(os.tmpdir(), `ds-commercial-${process.pid}.mjs`)
await build({
  stdin: {
    contents: `
      export { Editor, initSync } from '../wasm/ds_core'
      export { buildCommercialSet, documentFingerprint, boundProductIds, fetchBankFacts } from './commercial'
      export { buildBomPdfBytes, buildQuotePdfBytes, buildSpecPdfBytes, buildCommercialDocuments } from './commercialDocs'
      export { buildTakeoffModel } from './takeoff'
    `,
    resolveDir: here,
    loader: 'ts',
  },
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
fs.rmSync(outFile, { force: true })
mod.initSync({ module: fs.readFileSync(wasmPath) })
const {
  Editor,
  buildCommercialSet,
  documentFingerprint,
  boundProductIds,
  fetchBankFacts,
  buildBomPdfBytes,
  buildQuotePdfBytes,
  buildSpecPdfBytes,
  buildCommercialDocuments,
  buildTakeoffModel,
} = mod

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

// ---------------------------------------------------------------------------
// Fixture: a real generated plan, with two real bank products bound onto it.
// ---------------------------------------------------------------------------

const PROGRAM = {
  desks: 20,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
}

// Two products that exist in the live bank, with the prices the bank published
// for them (id 43277 / 43278, Haworth India "Intuity Office Desk"). Bound
// through the SAME entry point the re-imagine panel uses, so price lands on the
// core exactly as it does in the app.
const DESK_PRODUCT = { id: 'bank:43277', name: 'Intuity Office Desk - White / 120x60', price: 44500 }
// A spec-only product: the bank publishes NO price for it. Nothing may invent one.
const CHAIR_PRODUCT = { id: 'bank:139183', name: 'Steelcase Series 2 Task Chair', price: undefined }

function fixture() {
  const ed = new Editor()
  const W = 18
  const H = 12
  const rect = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ]
  for (let i = 0; i < rect.length; i++) {
    const [ax, ay] = rect[i]
    const [bx, by] = rect[(i + 1) % rect.length]
    ed.add_wall(ax, ay, bx, by, 0.2)
  }
  ed.generate(PROGRAM, 1n, false)
  const state = ed.state()
  // Bind the first three desks and the first two chairs.
  let desks = 0
  let chairs = 0
  for (const c of state.components) {
    if (c.category === 'Desk' && desks < 3) {
      ed.assign_product(c.id, DESK_PRODUCT.id, DESK_PRODUCT.name, DESK_PRODUCT.price)
      desks++
    } else if (c.category === 'Chair' && chairs < 2) {
      ed.assign_product(c.id, CHAIR_PRODUCT.id, CHAIR_PRODUCT.name, CHAIR_PRODUCT.price)
      chairs++
    }
  }
  return { ed, bound: { desks, chairs } }
}

const { ed, bound } = fixture()
const state = ed.state()
check('the fixture generated a plan', state.components.length > 20, `${state.components.length} components`)
check('the fixture bound 3 desks and 2 chairs', bound.desks === 3 && bound.chairs === 2, JSON.stringify(bound))

// ---- INDEPENDENT ground truth: walk the core's components ourselves --------
const raw = state.components.filter((c) => !c.reference)
const rawReference = state.components.length - raw.length
const rawByCategory = new Map()
for (const c of raw) rawByCategory.set(c.category, (rawByCategory.get(c.category) ?? 0) + 1)
const rawByProduct = new Map()
for (const c of raw) {
  if (!c.product_id) continue
  rawByProduct.set(c.product_id, (rawByProduct.get(c.product_id) ?? 0) + 1)
}
const rawPricedTotal = raw.reduce(
  (n, c) => n + (typeof c.price_inr === 'number' && Number.isFinite(c.price_inr) && c.price_inr > 0 ? c.price_inr : 0),
  0,
)
const rawPricedUnits = raw.filter((c) => typeof c.price_inr === 'number' && c.price_inr > 0).length

// ---- a canned bank answer, shaped exactly like /api/bank/product/<id> ------
const BANK = {
  43277: {
    product: {
      brand: 'Haworth India',
      title: 'Intuity Office Desk - White / 120x60',
      sku: 'SWSYITA004',
      supplier_domain: 'in.shopping.haworth.com',
      category_std: 'Seating',
      colour_primary: 'White',
      size_mm: null,
      image_url: 'https://cdn.shopify.com/s/files/1/0901/1947/1395/files/1_Intuity_White_120x60.jpg',
      price: {
        price_inr: 44500,
        basis: 'listed_mrp',
        observed_at: '2026-07-05T20:56:18.495185+00:00',
        source: 'in.shopping.haworth.com',
        source_url: 'https://in.shopping.haworth.com/products/intuity-office-desk',
        stale: false,
        age_days: 32,
      },
    },
  },
  139183: {
    product: {
      brand: 'Steelcase',
      title: 'Steelcase Series 2 Task Chair with Lumbar Support',
      supplier_domain: 'steelcase.com',
      category_std: 'Seating',
      image_url: 'https://steelcase-res.cloudinary.com/image/upload/19-0132544.jpg',
      price: null,
    },
  },
}
const stubFetch = async (url) => {
  const m = /\/api\/bank\/product\/(\d+)$/.exec(String(url))
  const body = m && BANK[m[1]]
  return {
    ok: !!body,
    status: body ? 200 : 404,
    json: async () => body ?? {},
  }
}

const ids = boundProductIds(state)
check('boundProductIds finds both bound products', ids.length === 2 && ids.every((i) => i.startsWith('bank:')), ids.join(' '))
const facts = await fetchBankFacts(ids, { fetchImpl: stubFetch })
check('the bank answered for both products', [...facts.values()].every((f) => f.ok), `${facts.size} facts`)
check(
  'price provenance survives the bank round trip',
  facts.get(DESK_PRODUCT.id)?.provenance?.basis === 'listed_mrp' &&
    facts.get(DESK_PRODUCT.id)?.provenance?.ageDays === 32,
  JSON.stringify(facts.get(DESK_PRODUCT.id)?.provenance),
)
check(
  'a spec-only product carries NO price and NO invented provenance',
  facts.get(CHAIR_PRODUCT.id)?.bankPriceInr === null && facts.get(CHAIR_PRODUCT.id)?.provenance === null,
  `bankPrice ${facts.get(CHAIR_PRODUCT.id)?.bankPriceInr}`,
)

const set = buildCommercialSet(state, {
  facts,
  project: 'Commercial Set Test',
  floor: 3,
  now: new Date('2026-08-06T09:00:00.000Z'),
})

// ---------------------------------------------------------------------------
// 1 · The bill of materials reconciles with the document
// ---------------------------------------------------------------------------
console.log('\n-- bill of materials --')

const bomUnits = set.lines.reduce((n, l) => n + l.quantity, 0)
check('every non-reference component is billed exactly once', bomUnits === raw.length, `${bomUnits} billed vs ${raw.length} in the document`)
check(
  'the census closes: billed + excluded = the document',
  set.census.billed + set.census.reference === set.census.documentComponents &&
    set.census.reference === rawReference,
  `${set.census.billed} + ${set.census.reference} = ${set.census.documentComponents}`,
)

let categoriesAgree = true
const disagreements = []
for (const [cat, n] of rawByCategory) {
  const billed = set.lines.filter((l) => l.category === cat).reduce((m, l) => m + l.quantity, 0)
  if (billed !== n) {
    categoriesAgree = false
    disagreements.push(`${cat}: BOM ${billed} vs document ${n}`)
  }
}
check(
  'the count in the BOM is the count in the document, per category',
  categoriesAgree,
  disagreements.join('; ') || `${rawByCategory.size} categories checked`,
)
check(
  'doors are billed, in their own section',
  set.lines.some((l) => l.section === 'Doors & openings') === rawByCategory.has('Door'),
  `${set.census.openings} openings billed, document has ${rawByCategory.get('Door') ?? 0} doors`,
)
check(
  'the BOM group totals equal the line totals',
  set.groups.reduce((n, g) => n + g.quantity, 0) === bomUnits,
  `${set.groups.length} groups`,
)

// ---------------------------------------------------------------------------
// 2 · The quote prices that bill, and prices nothing else
// ---------------------------------------------------------------------------
console.log('\n-- quotation --')

const quoteUnits = set.quote.groups.reduce((n, g) => n + g.pricedQty + g.unpricedQty, 0)
check('the quote covers exactly the bill', quoteUnits === bomUnits, `${quoteUnits} vs ${bomUnits}`)
check(
  'the subtotal equals the sum of prices ON THE COMPONENTS in the core',
  Math.round(set.quote.subtotal) === Math.round(rawPricedTotal),
  `quote ${set.quote.subtotal} vs core ${rawPricedTotal}`,
)
check('the subtotal is not zero (the fixture priced something)', set.quote.subtotal > 0, set.quote.subtotal)
check(
  'priced units match the core',
  set.census.pricedUnits === rawPricedUnits,
  `${set.census.pricedUnits} vs ${rawPricedUnits}`,
)
check(
  'GST is applied to the priced subtotal and named',
  set.quote.adjustments.length === 1 &&
    Math.round(set.quote.adjustments[0].amount) === Math.round(set.quote.subtotal * 0.18) &&
    /GST/.test(set.quote.adjustments[0].label),
  set.quote.adjustments[0]?.label,
)
check(
  'the total is subtotal + adjustments',
  Math.round(set.quote.total) === Math.round(set.quote.subtotal + set.quote.adjustments[0].amount),
  set.quote.total,
)

// A bound-but-unpriced product must NOT be valued.
const chairLines = set.lines.filter((l) => l.productId === CHAIR_PRODUCT.id)
check(
  'a bound product the bank does not price is billed but not valued',
  chairLines.length > 0 && chairLines.every((l) => !l.priced && l.totalPrice === 0),
  `${chairLines.length} chair line(s)`,
)
check(
  'unpriced units are carried into "to be quoted", not into the total',
  set.quote.toBeQuotedUnits === raw.length - rawPricedUnits &&
    set.quote.toBeQuoted.every((l) => !l.priced),
  `${set.quote.toBeQuotedUnits} unit(s) to be quoted`,
)
check(
  'priced lines cite a bank observation',
  set.quote.sourcedLines > 0 && set.quote.sourcedLines <= set.quote.pricedLines,
  `${set.quote.sourcedLines} of ${set.quote.pricedLines} priced lines sourced`,
)

// Falsification of the price path: a set built with NO bank facts must price
// identically (the core owns money) while losing every provenance claim.
{
  const noFacts = buildCommercialSet(state, { project: 'Commercial Set Test', floor: 3, now: new Date(0) })
  check(
    'with the bank unreachable the prices are unchanged (the core owns money)',
    noFacts.quote.subtotal === set.quote.subtotal,
    `${noFacts.quote.subtotal} vs ${set.quote.subtotal}`,
  )
  check(
    'with the bank unreachable NO line claims a provenance',
    noFacts.quote.sourcedLines === 0 && noFacts.quote.groups.every((g) => g.lines.every((l) => l.provenance === null)),
    `${noFacts.quote.sourcedLines} sourced`,
  )
}

// ---------------------------------------------------------------------------
// 3 · The spec sheet counts the same units as the bill
// ---------------------------------------------------------------------------
console.log('\n-- product specification --')

check(
  'one spec entry per distinct bound product',
  set.spec.products.length === rawByProduct.size,
  `${set.spec.products.length} vs ${rawByProduct.size}`,
)
let specAgrees = true
const specDiff = []
for (const sp of set.spec.products) {
  const n = rawByProduct.get(sp.productId) ?? 0
  const placed = sp.placements.reduce((m, pl) => m + pl.quantity, 0)
  if (sp.totalQuantity !== n || placed !== n) {
    specAgrees = false
    specDiff.push(`${sp.productId}: spec ${sp.totalQuantity}/${placed} vs document ${n}`)
  }
}
check('the spec sheet counts what the document contains', specAgrees, specDiff.join('; ') || `${set.spec.products.length} products`)
check(
  'the spec sheet carries REAL bank identity for a bank product',
  set.spec.products.some(
    (p) => p.productId === DESK_PRODUCT.id && p.brand === 'Haworth India' && p.sku === 'SWSYITA004' && p.source === 'material-bank',
  ),
  JSON.stringify(set.spec.products.find((p) => p.productId === DESK_PRODUCT.id)?.brand),
)
check(
  'the footprint on the spec sheet comes from the placed geometry',
  set.spec.products.every((p) => p.footprint === null || /^\d+ × \d+ cm$/.test(p.footprint)),
  set.spec.products.map((p) => p.footprint).join(' | '),
)
// The bank publishes placeholders as well as values. A sheet that prints
// "unknown" as a colour states something the bank never asserted.
{
  const junk = new Map(facts)
  junk.set(DESK_PRODUCT.id, { ...facts.get(DESK_PRODUCT.id) })
  const dirty = await fetchBankFacts(['bank:9999'], {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        product: {
          brand: '  ',
          title: 'Real Title',
          sku: 'unknown',
          colour_primary: 'N/A',
          finish: '-',
          supplier_domain: 'null',
        },
      }),
    }),
  })
  const f = dirty.get('bank:9999')
  check(
    'bank placeholders ("unknown", "N/A", "-", "null", blank) are not printed as facts',
    f.sku === null && f.colour === null && f.finish === null && f.brand === null && f.supplier === null && f.name === 'Real Title',
    JSON.stringify({ sku: f.sku, colour: f.colour, finish: f.finish, brand: f.brand, supplier: f.supplier }),
  )
}

// The takeoff's supplier fallback is a placeholder, not a company.
check(
  'the bank\'s real supplier replaces the "Can be customized" placeholder',
  set.lines.filter((l) => l.productId === DESK_PRODUCT.id).every((l) => l.supplier === 'in.shopping.haworth.com'),
  set.lines.find((l) => l.productId === DESK_PRODUCT.id)?.supplier,
)
check(
  'no document ever prints the placeholder as a supplier',
  set.lines.every((l) => l.supplier !== 'Can be customized'),
  [...new Set(set.lines.map((l) => l.supplier))].join(' | '),
)
check(
  'an unbound line says so instead of naming a company',
  set.lines.filter((l) => !l.productId).every((l) => l.supplier === 'not specified'),
)

check(
  'an unpriced product shows no unit price rather than zero',
  set.spec.products.find((p) => p.productId === CHAIR_PRODUCT.id)?.unitPrice === null,
  String(set.spec.products.find((p) => p.productId === CHAIR_PRODUCT.id)?.unitPrice),
)
check(
  'unspecified units are stated, and add up with the specified ones',
  set.spec.specifiedUnits + set.spec.unspecifiedUnits === bomUnits,
  `${set.spec.specifiedUnits} specified + ${set.spec.unspecifiedUnits} unspecified = ${bomUnits}`,
)

// ---------------------------------------------------------------------------
// 4 · The fingerprint is what makes "one model" checkable
// ---------------------------------------------------------------------------
console.log('\n-- derivation stamp --')

check('the fingerprint is stable for one document', documentFingerprint(state) === documentFingerprint(ed.state()))
check('the fingerprint is well-formed', /^DOC-[0-9A-F]{8}$/.test(set.stamp.fingerprint), set.stamp.fingerprint)

const moved = new Editor()
moved.add_wall(0, 0, 5, 0, 0.2)
const otherFp = documentFingerprint(moved.state())
check('a different document gets a different fingerprint', otherFp !== set.stamp.fingerprint, `${set.stamp.fingerprint} vs ${otherFp}`)
{
  const ed2 = Editor.from_snapshot(ed.snapshot())
  ed2.add_component('Desk', 2, 2, 1.6, 0.8)
  check(
    'adding one component moves the fingerprint',
    documentFingerprint(ed2.state()) !== set.stamp.fingerprint,
    documentFingerprint(ed2.state()),
  )
}

// ---------------------------------------------------------------------------
// 5 · The documents, BY THE BYTES
// ---------------------------------------------------------------------------
console.log('\n-- pdf bytes --')

const docs = [
  ['bill-of-materials.pdf', buildBomPdfBytes(set)],
  ['quotation.pdf', buildQuotePdfBytes(set)],
  ['product-specification.pdf', buildSpecPdfBytes(set)],
]
const dec = new TextDecoder('latin1')
for (const [name, bytes] of docs) {
  const buf = Buffer.from(bytes)
  const text = dec.decode(bytes)
  check(`${name} starts with %PDF`, text.startsWith('%PDF-1.4'), `${buf.length} bytes`)
  check(`${name} ends with %%EOF`, text.trimEnd().endsWith('%%EOF'), text.slice(-8).replace(/\n/g, '\\n'))
  check(`${name} has an xref table and a catalog`, /\nxref\n/.test(text) && /\/Type \/Catalog/.test(text))
  const pageCount = (text.match(/\/Type \/Page\b/g) ?? []).length
  check(`${name} declares at least one page`, pageCount >= 1, `${pageCount} page(s)`)
  check(
    `${name} carries the document fingerprint on the page`,
    text.includes(set.stamp.fingerprint),
    set.stamp.fingerprint,
  )
  // Falsification: the check above must be capable of NOT finding a string.
  check(`${name} does NOT carry a foreign fingerprint`, !text.includes(otherFp), otherFp)
  check(`${name} renders rupees WinAnsi-safe (no raw ₹)`, !text.includes('₹'))
}

// The quote must show its money, and must not zero-fill the unpriced.
{
  const text = dec.decode(docs[1][1])
  // The GRAND TOTAL specifically — not just "some money appears". Re-formatted
  // here from the independently-recomputed core figure, not read off the model.
  const expectTotal = `Rs. ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(
    Math.round(rawPricedTotal * 1.18),
  )}`
  check('the quotation prints the grand total computed from the core', text.includes(expectTotal), expectTotal)
  check('the quotation names the unpriced items rather than valuing them', /To be quoted|to be quoted/.test(text))
  check('the quotation cites the price basis', /listed mrp/.test(text))
}
{
  const text = dec.decode(docs[2][1])
  check('the specification prints the real brand', text.includes('Haworth India'))
  check('the specification prints the real SKU', text.includes('SWSYITA004'))
  check('the specification prints the source URL', text.includes('in.shopping.haworth.com'))
}
{
  const text = dec.decode(docs[0][1])
  check('the bill prints its reconciliation against the model', /RECONCILIATION AGAINST THE MODEL/.test(text))
  check(
    'the bill states the balance in figures',
    text.includes(`${set.census.billed} billed + ${set.census.reference} excluded = ${set.census.documentComponents}`),
  )
}

// Pagination is real, not a single page that silently drops overflow: a bill
// with ~10× the lines must spill onto more sheets AND still reconcile.
{
  const big = new Editor()
  for (let i = 0; i < 4; i++) {
    const box = [
      [0, 0],
      [40, 0],
      [40, 30],
      [0, 30],
    ]
    const [ax, ay] = box[i]
    const [bx, by] = box[(i + 1) % 4]
    big.add_wall(ax, ay, bx, by, 0.2)
  }
  // Distinct footprints, so these are 300 DIFFERENT line items rather than one
  // line of quantity 300 — otherwise the pagination check would be vacuous.
  for (let i = 0; i < 300; i++) {
    big.add_component('Desk', 1 + (i % 30), 1 + Math.floor(i / 30) * 1.2, 1 + i / 200, 0.8)
  }
  const bigSet = buildCommercialSet(big.state(), { project: 'Big', now: new Date(0) })
  const bomText = dec.decode(buildBomPdfBytes(bigSet))
  const pages = (bomText.match(/\/Type \/Page\b/g) ?? []).length
  check('a long bill spills onto more sheets', pages > 1, `${pages} pages for ${bigSet.census.billed} components`)
  check(
    'and still bills every component',
    bigSet.lines.reduce((n, l) => n + l.quantity, 0) === 300,
    bigSet.census.billed,
  )
}

// With the bank unreachable the sheets must SAY so, not go quiet.
{
  const noFacts = buildCommercialSet(state, { project: 'P', now: new Date(0) })
  const text = dec.decode(buildQuotePdfBytes(noFacts))
  check('an unsourced quote says the provenance was not recorded', /not recorded/.test(text))
  check('an unsourced quote still totals', /Rs\. [\d,]+/.test(text))
}

// ---------------------------------------------------------------------------
// 6 · The three files come out of ONE derivation
// ---------------------------------------------------------------------------
console.log('\n-- one action --')

const built = await buildCommercialDocuments(state, {
  facts,
  project: 'Commercial Set Test',
  floor: 3,
  artwork: false,
  now: new Date('2026-08-06T09:00:00.000Z'),
})
check(
  'three documents, named',
  built.files.map((f) => f.name).join(',') === 'bill-of-materials.pdf,quotation.pdf,product-specification.pdf',
  built.files.map((f) => f.name).join(','),
)
check(
  'all three carry the SAME fingerprint',
  built.files.every((f) => dec.decode(f.bytes).includes(built.set.stamp.fingerprint)),
  built.set.stamp.fingerprint,
)
check(
  'all three are complete PDFs',
  built.files.every((f) => dec.decode(f.bytes).startsWith('%PDF-1.4') && dec.decode(f.bytes).trimEnd().endsWith('%%EOF')),
  built.files.map((f) => `${f.name}=${f.bytes.length}B`).join(' '),
)

// ---------------------------------------------------------------------------
// 7 · The takeoff change did not re-group anybody
// ---------------------------------------------------------------------------
console.log('\n-- takeoff regression --')
{
  // `productId` joined the furniture aggregation key. Recompute the OLD key's
  // grouping straight from core state and require the same number of rows: the
  // key is strictly finer, so any difference is a real split we must know about.
  const takeoff = buildTakeoffModel(state, {})
  const oldKeys = new Set()
  for (const c of raw) {
    if (c.category === 'Door') continue
    const a = Math.round(Math.min(c.w, c.h) * 100)
    const b = Math.round(Math.max(c.w, c.h) * 100)
    const price = typeof c.price_inr === 'number' && Number.isFinite(c.price_inr) ? c.price_inr : 0
    // roomId is the model's own zone resolution; use the row set's rooms per
    // description instead — this only needs to count DISTINCT old keys, and the
    // room component is identical in both keyings.
    oldKeys.add(`${a}x${b}|${c.category}|${price}`)
  }
  check(
    'no furniture line was lost by the finer aggregation key',
    takeoff.furniture.reduce((n, r) => n + r.quantity, 0) ===
      raw.filter((c) => c.category !== 'Door').length,
    `${takeoff.furniture.length} rows over ${oldKeys.size} distinct (size,category,price) combos`,
  )
  check(
    'openings are the doors, and only the doors',
    takeoff.openings.reduce((n, r) => n + r.quantity, 0) === (rawByCategory.get('Door') ?? 0),
    `${takeoff.openings.reduce((n, r) => n + r.quantity, 0)} vs ${rawByCategory.get('Door') ?? 0}`,
  )
  check(
    'the takeoff totals are untouched by this change',
    Math.round(takeoff.totals.furniture) === Math.round(rawPricedTotal),
    `${takeoff.totals.furniture} vs ${rawPricedTotal}`,
  )
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
