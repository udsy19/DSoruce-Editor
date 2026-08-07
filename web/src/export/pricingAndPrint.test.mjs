// Two things this change introduced, tested where they are PURE. Run from web/:
//   node src/export/pricingAndPrint.test.mjs
//
//   A. `takeoff.ts`'s rate-card fallback — including the boundary that makes it
//      safe: it is OFF by default, so `commercial.ts`'s quotation still refuses
//      to invent a price (ADR 0004), and it never beats a bound `price_inr`.
//   B. `workbook.ts`'s page setup — the print area, fit-to-width and repeated
//      header row, asserted on the emitted OOXML bytes.
//
// The 12-sheet workbook itself is NOT built here, for the reason takeoff.test.mjs
// already records: `qtoWorkbook.ts` reaches the plan renderer for its room set
// and that graph needs a real DOM (importing it in Node throws
// `document is not defined`). It is covered end-to-end on real artifacts by
// G1/G2/G3/G5 and by G9's LibreOffice round-trip.
//
// @covers: web/src/export/takeoff.ts
// @covers: web/src/export/workbook.ts
// @covers: web/src/export/rateCard.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

async function bundle(entry) {
  const out = path.join(os.tmpdir(), `pp-${path.basename(entry, '.ts')}-${process.pid}.mjs`)
  await build({
    entryPoints: [path.join(here, entry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}

const { buildTakeoffModel } = await bundle('takeoff.ts')
const { buildXlsx } = await bundle('workbook.ts')

let failures = 0
const check = (label, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got === undefined ? '' : `  (${got})`}`)
  if (!cond) failures++
}

// ---------------------------------------------------------------------------
// A. the rate-card fallback
// ---------------------------------------------------------------------------

/** A minimal DocState: one zone, and whatever components the caller wants. */
function stateOf(components) {
  return {
    walls: [],
    zones: [
      {
        id: 1,
        zone_type: 'Meeting',
        label: 'Meeting Room 1',
        shape: { kind: 'rect', x: 0, y: 0, w: 10, h: 10 },
      },
    ],
    components: components.map((c, i) => ({
      id: i + 1,
      x: 5,
      y: 5,
      rotation: 0,
      mirror: false,
      reference: false,
      label: '',
      product_id: null,
      price_inr: null,
      seats: 0,
      decision: 'Open',
      ...c,
    })),
  }
}

const CHAIR = { category: 'Chair', w: 0.5, h: 0.5 }
const DESK = { category: 'Desk', w: 1.4, h: 0.7 }

// A1 — the default must not have changed. `commercial.ts` builds the quotation
// through this same function with no options, and a quotation that invents a
// price for an unbound item is the failure ADR 0004 exists to prevent.
{
  const m = buildTakeoffModel(stateOf([CHAIR, DESK]))
  check(
    'DEFAULT: an unbound component is still unpriced (no rate card unless asked)',
    m.furniture.every((r) => r.unitPrice === 0 && r.priceBasis === 'unpriced'),
    m.furniture.map((r) => `${r.itemDescription}=${r.unitPrice}/${r.priceBasis}`).join(' · '),
  )
  check('DEFAULT: the furniture total is 0, not a guess', m.totals.furniture === 0, m.totals.furniture)
}

// A2 — opted in, the takeoff prices from the card and SAYS it did.
{
  const m = buildTakeoffModel(stateOf([CHAIR, DESK]), { rateCard: true })
  const byName = Object.fromEntries(m.furniture.map((r) => [r.category, r]))
  check('rateCard: a chair is priced', byName.Chair?.unitPrice === 12_000, byName.Chair?.unitPrice)
  check('rateCard: a desk is priced', byName.Desk?.unitPrice === 20_000, byName.Desk?.unitPrice)
  check(
    'rateCard: every priced line is labelled "rate-card", never passed off as bound',
    m.furniture.every((r) => r.priceBasis === 'rate-card'),
    m.furniture.map((r) => r.priceBasis).join(','),
  )
  check(
    'rateCard: every priced line carries the justification for its rate',
    m.furniture.every((r) => (r.priceNote ?? '').length > 40),
  )
  check('rateCard: the total follows', m.totals.furniture === 32_000, m.totals.furniture)
}

// A3 — THE precedence rule. A real product's real price is authoritative and a
// category rate must never overwrite it, in either direction.
{
  const bound = { ...DESK, product_id: 'bank:43277', label: 'Intuity Office Desk', price_inr: 44_500 }
  const m = buildTakeoffModel(stateOf([bound, DESK]), { rateCard: true })
  const boundRow = m.furniture.find((r) => r.productId === 'bank:43277')
  const freeRow = m.furniture.find((r) => !r.productId)
  check('a BOUND price wins over the rate card', boundRow?.unitPrice === 44_500, boundRow?.unitPrice)
  check('and is labelled as bound, not as a rate', boundRow?.priceBasis === 'bound', boundRow?.priceBasis)
  check('the unbound twin still gets the rate', freeRow?.unitPrice === 20_000, freeRow?.unitPrice)
  check(
    'the two do not merge into one line (different price, different basis)',
    m.furniture.length === 2,
    m.furniture.length,
  )
}

// A4 — a category the card cannot defend a figure for stays unpriced even with
// the rate card ON. "To be quoted" and "₹0" are different facts.
{
  const m = buildTakeoffModel(stateOf([{ category: 'Aquarium', w: 2, h: 1 }]), { rateCard: true })
  check(
    'an unknown category stays unpriced even with the rate card on',
    m.furniture[0]?.unitPrice === 0 && m.furniture[0]?.priceBasis === 'unpriced',
    `${m.furniture[0]?.unitPrice}/${m.furniture[0]?.priceBasis}`,
  )
}

// A5 — the supplier placeholder is a status, not a company.
{
  const m = buildTakeoffModel(stateOf([CHAIR]), { rateCard: true })
  check(
    'the supplier placeholder no longer reads as an unfilled template',
    m.furniture[0]?.supplier === 'To be appointed',
    m.furniture[0]?.supplier,
  )
}

// ---------------------------------------------------------------------------
// B. page setup, on the emitted bytes
// ---------------------------------------------------------------------------

/** Minimal unzip: pull one stored/deflated entry out of a .xlsx by name. */
function unzipEntry(buf, want) {
  const b = Buffer.from(buf)
  // Walk local file headers — this writer emits them in order, no data
  // descriptors, so a forward scan is enough.
  let i = 0
  while (i + 30 <= b.length && b.readUInt32LE(i) === 0x04034b50) {
    const method = b.readUInt16LE(i + 8)
    const csize = b.readUInt32LE(i + 18)
    const nlen = b.readUInt16LE(i + 26)
    const elen = b.readUInt16LE(i + 28)
    const name = b.subarray(i + 30, i + 30 + nlen).toString('utf8')
    const start = i + 30 + nlen + elen
    const data = b.subarray(start, start + csize)
    if (name === want) return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8')
    i = start + csize
  }
  return null
}

const xlsx = buildXlsx([
  {
    name: 'Main Summary',
    cells: { B4: 'Material Category', I9: 1234 },
    page: {
      orientation: 'landscape',
      paperSize: 9,
      fitToWidth: 1,
      fitToHeight: 0,
      printArea: 'A1:I9',
      printTitleRows: '4:4',
      horizontalCentered: true,
    },
  },
  { name: 'Plain', cells: { A1: 'x' } },
])

const wbXml = unzipEntry(xlsx, 'xl/workbook.xml')
const sheet1 = unzipEntry(xlsx, 'xl/worksheets/sheet1.xml')
const sheet2 = unzipEntry(xlsx, 'xl/worksheets/sheet2.xml')
check('the workbook part parses out of the archive', !!wbXml && !!sheet1)

check(
  'a print area is emitted as a sheet-scoped defined name',
  wbXml.includes(
    `<definedName name="_xlnm.Print_Area" localSheetId="0">&apos;Main Summary&apos;!$A$1:$I$9</definedName>`,
  ),
  (wbXml.match(/<definedName[^>]*>[^<]*<\/definedName>/g) ?? []).join(' | '),
)
check(
  'repeated header rows are emitted as Print_Titles',
  wbXml.includes(
    `<definedName name="_xlnm.Print_Titles" localSheetId="0">&apos;Main Summary&apos;!$4:$4</definedName>`,
  ),
)
check(
  'definedNames sit between </sheets> and <calcPr> (schema order)',
  /<\/sheets><definedNames>.*<\/definedNames><calcPr/.test(wbXml),
)

// `fitToWidth` alone does nothing: without `<pageSetUpPr fitToPage="1"/>` both
// Excel and LibreOffice ignore it and slice the sheet by column. That element
// must also be the FIRST child of <worksheet>.
check(
  'fitToPage is declared, as the first child of <worksheet>',
  /<worksheet[^>]*><sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/.test(sheet1),
  sheet1.slice(sheet1.indexOf('<worksheet'), sheet1.indexOf('<dimension')).slice(-90),
)
check(
  'the page setup itself carries orientation, paper and the fit',
  sheet1.includes('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'),
  (sheet1.match(/<pageSetup[^>]*\/>/) ?? [])[0],
)
check('horizontal centring is emitted', sheet1.includes('<printOptions horizontalCentered="1"/>'))
check(
  'pageSetup follows pageMargins (schema order)',
  sheet1.indexOf('<pageMargins') < sheet1.indexOf('<pageSetup') &&
    sheet1.indexOf('<printOptions') < sheet1.indexOf('<pageMargins'),
)

// A sheet with no page spec must be byte-unaffected — the feature is opt-in.
check('a sheet with no page spec emits no pageSetup', !sheet2.includes('<pageSetup'))
check('a sheet with no page spec emits no sheetPr', !sheet2.includes('<sheetPr>'))
check('a sheet with no page spec contributes no defined name', !wbXml.includes('localSheetId="1"'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
