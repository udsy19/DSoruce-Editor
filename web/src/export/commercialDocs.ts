// The three commercial documents, on paper.
//
//   bill-of-materials.pdf  ·  quotation.pdf  ·  product-specification.pdf
//
// Each is a projection of ONE `CommercialSet` (commercial.ts) — no document
// recounts anything, and all three print the same `DOC-…` fingerprint in their
// header, which is the whole demo: three deliverables you can hold up side by
// side and see descend from one model.
//
// Layer split, deliberately:
//   * `buildBomPdfBytes` / `buildQuotePdfBytes` / `buildSpecPdfBytes` are
//     DOM-FREE. They take a model plus already-decoded artwork, so they run —
//     and are byte-asserted — in node (`commercial.test.mjs`).
//   * `buildCommercialArtwork` is the only DOM-touching function (canvas for
//     the key plan, <img> for bank product photos), and every one of its
//     results is optional: a document with no artwork is still a complete,
//     correct document.
//
// No new PDF engine: pages compose `sheet.ts`'s `Page` + `titleBlock` +
// `productCard` over `pdfDoc.ts`'s byte writer, exactly like the drawing set.

import type { DocState } from '../types/doc'
import { PAGE_W, PAGE_H, buildMultiPagePdfBytes, textWidth, pdfSafeText, type PdfJpeg } from './pdfDoc'
import {
  Page,
  MARGIN,
  TITLE_BLOCK_H,
  titleBlock,
  keyPlanJpeg,
  logoJpeg,
  type TitleBlockInfo,
} from './sheet'
import {
  buildCommercialSet,
  boundProductIds,
  fetchBankFacts,
  type BomLine,
  type CommercialOptions,
  type CommercialSet,
  type DerivationStamp,
  type PriceProvenance,
  type QuoteLine,
  type SpecProduct,
} from './commercial'
import { triggerDownload } from './png'

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** ₹ figure. `pdfSafeText` renders ₹ as "Rs. " (WinAnsi has no rupee glyph). */
function money(n: number): string {
  return `₹${INR.format(Math.round(n))}`
}

/** A price that may not exist. Never 0 — an unpriced item is not a free item. */
function moneyOrRfq(n: number | null): string {
  return n != null && n > 0 ? money(n) : 'To be quoted'
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** One line summarising where a price came from, for a table cell. */
function provenanceCell(p: PriceProvenance | null): string {
  if (!p) return 'not recorded'
  const basis = (p.basis ?? 'observed').replace(/_/g, ' ')
  const age = p.ageDays != null ? `${p.ageDays}d` : shortDate(p.observedAt)
  return `${basis} · ${age}${p.stale ? ' · STALE' : ''}`
}

function clip(s: string, size: number, bold: boolean, maxW: number): string {
  if (textWidth(pdfSafeText(s), size, bold) <= maxW) return s
  let t = s
  while (t.length > 1 && textWidth(pdfSafeText(`${t}...`), size, bold) > maxW) t = t.slice(0, -1)
  return `${t}...`
}

// ---------------------------------------------------------------------------
// Shared page furniture
// ---------------------------------------------------------------------------

/** Artwork a commercial document can use but never requires. */
export interface CommercialArtwork {
  keyPlan: PdfJpeg | null
  /** product id → decoded bank photo. */
  photos: Map<string, PdfJpeg>
}

export const EMPTY_ARTWORK: CommercialArtwork = { keyPlan: null, photos: new Map() }

const CONTENT_TOP = 76
const CONTENT_BOTTOM = PAGE_H - MARGIN - TITLE_BLOCK_H - 14

function tb(stamp: DerivationStamp, no: string, title: string, keyPlan: PdfJpeg | null): TitleBlockInfo {
  return {
    no,
    title,
    scale: 'NTS',
    studio: 'DSOURCE',
    project: stamp.project,
    revision: stamp.fingerprint,
    date: shortDate(stamp.derivedAt),
    drawnBy: 'DSOURCE',
    keyPlan,
  }
}

/**
 * The derivation banner every commercial document carries, identically.
 *
 * This is the "how could all of this be derived" answer printed on the page: the
 * document id (a hash of the plan's own census), what the model contained when
 * the set was derived, and the instant it was derived. Two sheets showing the
 * same DOC id came out of the same model; one showing a different id did not.
 */
function derivationBanner(p: Page, stamp: DerivationStamp, kicker: string): void {
  p.text(MARGIN + 6, 42, 15, kicker.toUpperCase(), { bold: true, gray: 0.1 })
  p.text(PAGE_W - MARGIN - 6, 34, 8, 'DERIVED FROM ONE EDITOR DOCUMENT', { align: 'right', gray: 0.45 })
  p.text(PAGE_W - MARGIN - 6, 47, 12, stamp.fingerprint, { align: 'right', bold: true, gray: 0.1 })
  p.text(
    PAGE_W - MARGIN - 6,
    59,
    7.5,
    `${stamp.components} components · ${stamp.walls} walls · ${stamp.zones} zones · ${shortDate(stamp.derivedAt)}`,
    { align: 'right', gray: 0.45 },
  )
  p.line(MARGIN + 6, 52, PAGE_W / 2, 52, { gray: 0.2, width: 1.2 })
}

interface Col {
  key: string
  label: string
  w: number
  align?: 'left' | 'right'
  bold?: boolean
}

/** Header band for a table; returns the y of the first body row. */
function tableHead(p: Page, x: number, yTop: number, cols: Col[]): number {
  const w = cols.reduce((n, c) => n + c.w, 0)
  p.box(x, yTop, w, 16, { fill: true, gray: 0.92 })
  let cx = x
  for (const c of cols) {
    p.text(c.align === 'right' ? cx + c.w - 6 : cx + 6, yTop + 11, 7.5, c.label.toUpperCase(), {
      align: c.align === 'right' ? 'right' : 'left',
      bold: true,
      gray: 0.3,
    })
    cx += c.w
  }
  return yTop + 16 + 12
}

const ROW_H = 13

function tableRow(p: Page, x: number, y: number, cols: Col[], cells: Record<string, string>, o?: { gray?: number }): void {
  let cx = x
  for (const c of cols) {
    const v = cells[c.key] ?? ''
    if (v) {
      p.text(c.align === 'right' ? cx + c.w - 6 : cx + 6, y, 8, clip(v, 8, !!c.bold, c.w - 12), {
        align: c.align === 'right' ? 'right' : 'left',
        bold: c.bold,
        gray: o?.gray ?? 0.15,
      })
    }
    cx += c.w
  }
}

function rowRule(p: Page, x: number, y: number, w: number): void {
  p.line(x, y + 3.5, x + w, y + 3.5, { gray: 0.9, width: 0.4 })
}

// ---------------------------------------------------------------------------
// 1 · Bill of materials
// ---------------------------------------------------------------------------

const BOM_COLS: Col[] = [
  { key: 'code', label: 'Code', w: 62 },
  { key: 'item', label: 'Item', w: 240, bold: true },
  { key: 'dims', label: 'Size', w: 90 },
  { key: 'room', label: 'Room', w: 70 },
  { key: 'type', label: 'Room type', w: 150 },
  { key: 'product', label: 'Specified product', w: 300 },
  { key: 'qty', label: 'Qty', w: 46, align: 'right', bold: true },
]
const BOM_TABLE_W = BOM_COLS.reduce((n, c) => n + c.w, 0)

/**
 * The bill of materials: every non-reference component in the document, grouped
 * by item, with its rooms and counts. Reconciliation is printed on the sheet —
 * billed + excluded must equal the document's component count, and the sheet
 * says so in figures rather than asking to be trusted.
 */
export function buildBomPdfBytes(set: CommercialSet, art: CommercialArtwork = EMPTY_ARTWORK): Uint8Array<ArrayBuffer> {
  const pages: Page[] = []
  const x = MARGIN + 6
  let p = new Page()
  let sheetNo = 1
  derivationBanner(p, set.stamp, 'Bill of materials')
  let y = tableHead(p, x, CONTENT_TOP, BOM_COLS)

  const newPage = () => {
    titleBlock(p, tb(set.stamp, `B.${String(sheetNo).padStart(2, '0')}`, 'Bill of Materials', art.keyPlan))
    pages.push(p)
    sheetNo++
    p = new Page()
    derivationBanner(p, set.stamp, `Bill of materials (cont.)`)
    y = tableHead(p, x, CONTENT_TOP, BOM_COLS)
  }
  const room = (n: number) => {
    if (y + n * ROW_H > CONTENT_BOTTOM) newPage()
  }

  let section: string | null = null
  for (const g of set.groups) {
    room(3)
    if (g.section !== section) {
      section = g.section
      p.box(x, y - 9, BOM_TABLE_W, 14, { fill: true, gray: 0.97 })
      p.text(x + 6, y + 1, 8.5, section.toUpperCase(), { bold: true, gray: 0.25 })
      y += 20
    }
    for (const l of g.lines) {
      room(1)
      tableRow(p, x, y, BOM_COLS, {
        code: l.costCode,
        item: l.name,
        dims: l.dims ?? '—',
        room: String(l.roomId),
        type: l.roomType,
        product: l.productName ?? (l.productId ? l.productId : 'not specified'),
        qty: String(l.quantity),
      }, { gray: l.productId ? 0.15 : 0.42 })
      rowRule(p, x, y, BOM_TABLE_W)
      y += ROW_H
    }
    // Item subtotal across rooms — the number the quote and the spec sheet
    // must both agree with.
    room(1)
    tableRow(p, x, y, BOM_COLS, {
      item: `${g.name} — total`,
      type: `${g.rooms} room${g.rooms === 1 ? '' : 's'}`,
      qty: String(g.quantity),
    }, { gray: 0.1 })
    p.line(x, y + 4, x + BOM_TABLE_W, y + 4, { gray: 0.45, width: 0.8 })
    y += ROW_H + 8
  }

  // ---- reconciliation ----------------------------------------------------
  const c = set.census
  room(6)
  y += 6
  p.box(x, y - 10, BOM_TABLE_W, 74, { fill: false, gray: 0.35, width: 1 })
  p.text(x + 10, y + 4, 9, 'RECONCILIATION AGAINST THE MODEL', { bold: true, gray: 0.15 })
  const recon: [string, string][] = [
    ['Furniture & fixtures billed', `${c.furniture}`],
    ['Doors & openings billed', `${c.openings}`],
    ['Reference / imported items (not billed)', `${c.reference}`],
    ['Components in the editor document', `${c.documentComponents}`],
  ]
  let ry = y + 20
  for (const [k, v] of recon) {
    p.text(x + 10, ry, 8, k, { gray: 0.35 })
    p.text(x + 300, ry, 8, v, { align: 'right', bold: true, gray: 0.1 })
    ry += 12
  }
  const balanced = c.billed + c.reference === c.documentComponents
  p.text(
    x + 330,
    y + 20,
    8.5,
    balanced
      ? `${c.billed} billed + ${c.reference} excluded = ${c.documentComponents} in the document.`
      : `WARNING: ${c.billed} billed + ${c.reference} excluded does not equal ${c.documentComponents}.`,
    { bold: true, gray: balanced ? 0.12 : 0 },
  )
  p.text(x + 330, y + 34, 7.5, `${c.specified} of ${c.billed} billed units carry a specified product.`, { gray: 0.4 })
  p.text(x + 330, y + 46, 7.5, `${c.pricedUnits} of ${c.billed} billed units carry a price.`, { gray: 0.4 })
  p.text(x + 330, y + 58, 7.5, `Counts are read from the editor document, not from a maintained list.`, { gray: 0.4 })

  titleBlock(p, tb(set.stamp, `B.${String(sheetNo).padStart(2, '0')}`, 'Bill of Materials', art.keyPlan))
  pages.push(p)
  return buildMultiPagePdfBytes(pages.map((pg) => ({ ops: pg.ops, images: pg.images })))
}

// ---------------------------------------------------------------------------
// 2 · Quotation
// ---------------------------------------------------------------------------

const QUOTE_COLS: Col[] = [
  { key: 'code', label: 'Code', w: 62 },
  { key: 'item', label: 'Item', w: 190, bold: true },
  { key: 'supplier', label: 'Supplier', w: 180 },
  { key: 'room', label: 'Room', w: 60 },
  { key: 'qty', label: 'Qty', w: 40, align: 'right' },
  { key: 'unit', label: 'Unit (INR)', w: 100, align: 'right' },
  { key: 'total', label: 'Line total (INR)', w: 110, align: 'right', bold: true },
  { key: 'prov', label: 'Price basis · age', w: 128 },
  { key: 'src', label: 'Observed at', w: 148 },
]
const QUOTE_TABLE_W = QUOTE_COLS.reduce((n, c) => n + c.w, 0)

/**
 * The quotation: the bill of materials priced in ₹.
 *
 * Two rules it will not break. Money comes from the core (`price_inr`, written
 * by `Editor.assign_product`) and nowhere else; and an item with no published
 * price is carried into a named "to be quoted" block rather than being priced
 * at zero, which would understate the total while looking complete.
 */
export function buildQuotePdfBytes(set: CommercialSet, art: CommercialArtwork = EMPTY_ARTWORK): Uint8Array<ArrayBuffer> {
  const q = set.quote
  const pages: Page[] = []
  const x = MARGIN + 6
  let p = new Page()
  let sheetNo = 1
  derivationBanner(p, set.stamp, 'Quotation')
  let y = tableHead(p, x, CONTENT_TOP, QUOTE_COLS)

  const newPage = () => {
    titleBlock(p, tb(set.stamp, `Q.${String(sheetNo).padStart(2, '0')}`, 'Quotation', art.keyPlan))
    pages.push(p)
    sheetNo++
    p = new Page()
    derivationBanner(p, set.stamp, 'Quotation (cont.)')
    y = tableHead(p, x, CONTENT_TOP, QUOTE_COLS)
  }
  const room = (n: number) => {
    if (y + n * ROW_H > CONTENT_BOTTOM) newPage()
  }

  const cells = (l: QuoteLine): Record<string, string> => ({
    code: l.costCode,
    item: l.name,
    supplier: l.supplier,
    room: String(l.roomId),
    qty: String(l.quantity),
    unit: l.priced ? money(l.unitPrice) : 'RFQ',
    total: l.priced ? money(l.totalPrice) : '—',
    prov: l.priced ? provenanceCell(l.provenance) : 'no published price',
    // The DATE the price was observed — the supplier column already names who
    // published it, so repeating the domain here would say nothing new.
    src: l.provenance?.observedAt ? shortDate(l.provenance.observedAt) : l.priced ? 'not recorded' : '—',
  })

  for (const g of q.groups) {
    room(g.lines.length + 2)
    for (const l of g.lines) {
      room(1)
      tableRow(p, x, y, QUOTE_COLS, cells(l), { gray: l.priced ? 0.15 : 0.45 })
      rowRule(p, x, y, QUOTE_TABLE_W)
      y += ROW_H
    }
    room(1)
    tableRow(p, x, y, QUOTE_COLS, {
      item: `${g.name} — subtotal`,
      qty: String(g.pricedQty + g.unpricedQty),
      total: g.subtotal > 0 ? money(g.subtotal) : '—',
      prov: g.unpricedQty > 0 ? `${g.unpricedQty} unit(s) to be quoted` : '',
    })
    p.line(x, y + 4, x + QUOTE_TABLE_W, y + 4, { gray: 0.45, width: 0.8 })
    y += ROW_H + 8
  }

  // ---- totals ------------------------------------------------------------
  room(8)
  y += 8
  const totalsW = 340
  const tx = x + QUOTE_TABLE_W - totalsW
  const rows: [string, string, boolean][] = [
    ['Subtotal (priced items)', money(q.subtotal), false],
    ...q.adjustments.map((a) => [a.label, money(a.amount), false] as [string, string, boolean]),
    ['Total', money(q.total), true],
  ]
  for (const [k, v, big] of rows) {
    if (big) p.line(tx, y - 6, tx + totalsW, y - 6, { gray: 0.25, width: 1 })
    p.text(tx, y + (big ? 6 : 0), big ? 11 : 8.5, k, { bold: big, gray: big ? 0.08 : 0.35 })
    p.text(tx + totalsW, y + (big ? 6 : 0), big ? 13 : 9, v, { align: 'right', bold: true, gray: big ? 0.05 : 0.12 })
    y += big ? 24 : 15
  }

  // ---- what is NOT in the total ------------------------------------------
  y += 6
  room(4)
  p.text(x, y, 9, 'NOT INCLUDED IN THE TOTAL', { bold: true, gray: 0.15 })
  y += 14
  if (q.toBeQuoted.length === 0) {
    p.text(x, y, 8, 'Every billed item carries a published price.', { gray: 0.4 })
    y += 12
  } else {
    p.text(
      x,
      y,
      8,
      `${q.toBeQuotedUnits} unit(s) across ${q.toBeQuoted.length} line(s) have no published price and are excluded ` +
        'from the total. They are listed here rather than valued at zero.',
      { gray: 0.4 },
    )
    y += 14
    const seen = new Map<string, number>()
    for (const l of q.toBeQuoted) seen.set(l.item, (seen.get(l.item) ?? 0) + l.quantity)
    for (const [item, qty] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
      room(1)
      p.text(x + 10, y, 8, `${qty} × ${item}`, { gray: 0.3 })
      y += 11
    }
  }

  // ---- provenance note ---------------------------------------------------
  y += 10
  room(4)
  p.box(x, y - 10, QUOTE_TABLE_W, 62, { fill: false, gray: 0.35, width: 1 })
  p.text(x + 10, y + 4, 9, 'WHERE THESE PRICES COME FROM', { bold: true, gray: 0.15 })
  // The second note is CONDITIONAL, and it has to be. "Every ₹ figure is the
  // price recorded on the component" is true only when every priced line came
  // from a binding. Once the rate card is enabled — which it is for the
  // quotation, or an unspecified plan quotes as 1 priced line out of 42 — that
  // sentence becomes false for every unbound line, and a provenance box that
  // misstates its own provenance is worse than no box. Say which prices came
  // from where, and let the PRICE BASIS column carry it per line.
  const fromRateCard = Math.max(0, q.pricedLines - q.sourcedLines)
  const notes = [
    `${q.sourcedLines} of ${q.pricedLines} priced line(s) cite a material-bank observation with a basis and a date.`,
    fromRateCard === 0
      ? 'Every ₹ figure is the price recorded on the component in the editor document ' +
        '(Editor.assign_product); this sheet does not hold a second price list.'
      : `A bound product's ₹ figure is the price recorded on the component (Editor.assign_product). ` +
        `The remaining ${fromRateCard} line(s) are priced from the published rate card, ` +
        `whose rates are derived from the core cost model. The PRICE BASIS column states which is which.`,
    'Quantities are the same quantities as the bill of materials — both are read from the same model.',
  ]
  let ny = y + 20
  for (const n of notes) {
    p.text(x + 10, ny, 7.5, clip(n, 7.5, false, QUOTE_TABLE_W - 20), { gray: 0.4 })
    ny += 12
  }

  titleBlock(p, tb(set.stamp, `Q.${String(sheetNo).padStart(2, '0')}`, 'Quotation', art.keyPlan))
  pages.push(p)
  return buildMultiPagePdfBytes(pages.map((pg) => ({ ops: pg.ops, images: pg.images })))
}

// ---------------------------------------------------------------------------
// 3 · Product specification sheet
// ---------------------------------------------------------------------------

const CARD_H = 178
const CARD_GAP = 8

function specCard(p: Page, x: number, yTop: number, w: number, sp: SpecProduct, photo: PdfJpeg | null): void {
  const pad = 10
  p.box(x, yTop, w, CARD_H, { fill: true, gray: 1 })
  p.box(x, yTop, w, CARD_H, { fill: false, gray: 0.75, width: 0.9 })

  // Photo (or a labelled placeholder — never a silent gap).
  const iw = 150
  const ih = CARD_H - pad * 2
  const ix = x + pad
  const iy = yTop + pad
  p.box(ix, iy, iw, ih, { fill: true, gray: 0.96 })
  if (photo) {
    const s = Math.min(iw / photo.width, ih / photo.height)
    p.image(photo, ix + (iw - photo.width * s) / 2, iy + (ih - photo.height * s) / 2, photo.width * s, photo.height * s)
  } else {
    p.text(ix + iw / 2, iy + ih / 2 - 4, 8, 'NO IMAGE', { align: 'center', bold: true, gray: 0.55 })
    p.text(ix + iw / 2, iy + ih / 2 + 8, 6.5, sp.imageUrl ? 'not embeddable' : 'none published', {
      align: 'center',
      gray: 0.6,
    })
  }
  p.box(ix, iy, iw, ih, { fill: false, gray: 0.82, width: 0.5 })

  // Identity block.
  const tx = ix + iw + 14
  const tw = w - (tx - x) - pad
  let y = yTop + pad + 12
  p.text(tx, y, 11, clip(sp.name, 11, true, tw), { bold: true, gray: 0.08 })
  y += 13
  p.text(tx, y, 8, clip([sp.brand, sp.supplier].filter(Boolean).join('  ·  ') || 'unbranded', 8, false, tw), {
    gray: 0.4,
  })
  y += 14

  const facts: [string, string][] = [
    ['SKU', sp.sku ?? '—'],
    ['Classification', sp.classification ?? '—'],
    ['Colour / finish', [sp.colour, sp.finish].filter(Boolean).join(' · ') || '—'],
    ['Published size', sp.sizeMm ?? '—'],
    ['Footprint as placed', sp.footprint ?? '—'],
    ['Unit price', moneyOrRfq(sp.unitPrice)],
    ['Price basis', provenanceCell(sp.provenance)],
    ['Source', sp.provenance?.sourceUrl ?? sp.provenance?.source ?? (sp.source === 'material-bank' ? 'material bank' : 'document binding')],
  ]
  const colW = tw / 2 - 8
  facts.forEach(([k, v], i) => {
    const cx = tx + (i % 2) * (colW + 16)
    const cy = y + Math.floor(i / 2) * 22
    p.text(cx, cy, 6.5, k.toUpperCase(), { gray: 0.5 })
    p.text(cx, cy + 10, 8.5, clip(v, 8.5, false, colW), { gray: 0.12, bold: k === 'Unit price' })
  })
  y += Math.ceil(facts.length / 2) * 22 + 4

  // Placements — which rooms, how many. The link back to the plan.
  p.line(tx, y, tx + tw, y, { gray: 0.88, width: 0.4 })
  y += 12
  p.text(tx, y, 6.5, `SPECIFIED IN ${sp.placements.length} LOCATION(S) — ${sp.totalQuantity} UNIT(S)`, { gray: 0.5 })
  y += 11
  const places = sp.placements
    .map((pl) => `${pl.roomType} ${pl.roomId} × ${pl.quantity}`)
    .join('    ')
  p.text(tx, y, 7.5, clip(places, 7.5, false, tw), { gray: 0.3 })

  if (sp.source !== 'material-bank') {
    p.text(x + w - pad, yTop + 14, 6.5, 'BANK LOOKUP UNAVAILABLE', { align: 'right', gray: 0.5 })
  }
}

/**
 * The product specification sheet: one card per SPECIFIED product, carrying the
 * bank's own identity fields and price provenance, the footprint as actually
 * placed (from the core's geometry), and the rooms it appears in with counts.
 *
 * The counts are the bill of materials' counts — same lines, regrouped by
 * product instead of by room — so the two sheets cannot disagree about how many
 * of anything the plan contains.
 */
export function buildSpecPdfBytes(set: CommercialSet, art: CommercialArtwork = EMPTY_ARTWORK): Uint8Array<ArrayBuffer> {
  const pages: Page[] = []
  const x = MARGIN + 6
  const w = PAGE_W - MARGIN - x
  let p = new Page()
  let sheetNo = 1
  derivationBanner(p, set.stamp, 'Product specification')
  let y = CONTENT_TOP

  const close = () => {
    titleBlock(p, tb(set.stamp, `S.${String(sheetNo).padStart(2, '0')}`, 'Product Specification', art.keyPlan))
    pages.push(p)
    sheetNo++
  }
  const newPage = () => {
    close()
    p = new Page()
    derivationBanner(p, set.stamp, 'Product specification (cont.)')
    y = CONTENT_TOP
  }

  p.text(x, y, 8.5, `${set.spec.products.length} specified product(s) · ${set.spec.specifiedUnits} unit(s) bound to a real product`, {
    gray: 0.35,
  })
  y += 18

  if (set.spec.products.length === 0) {
    p.box(x, y, w, 110, { fill: true, gray: 0.97 })
    p.text(PAGE_W / 2, y + 52, 12, 'NO PRODUCTS SPECIFIED YET', { align: 'center', bold: true, gray: 0.45 })
    p.text(PAGE_W / 2, y + 72, 9, 'Select an element and bind a product from the material bank.', {
      align: 'center',
      gray: 0.5,
    })
    y += 126
  }

  for (const sp of set.spec.products) {
    if (y + CARD_H > CONTENT_BOTTOM) newPage()
    specCard(p, x, y, w, sp, art.photos.get(sp.productId) ?? null)
    y += CARD_H + CARD_GAP
  }

  // ---- what is NOT specified --------------------------------------------
  if (set.spec.unspecified.length > 0) {
    if (y + 90 > CONTENT_BOTTOM) newPage()
    p.box(x, y, w, 22, { fill: true, gray: 0.95 })
    p.text(x + 8, y + 15, 9, `NOT YET SPECIFIED — ${set.spec.unspecifiedUnits} UNIT(S)`, { bold: true, gray: 0.25 })
    y += 30
    p.text(x, y, 7.5, 'Billed on the plan and quoted as RFQ; no product bound in the editor document.', { gray: 0.45 })
    y += 14
    for (const u of set.spec.unspecified) {
      if (y + ROW_H > CONTENT_BOTTOM) newPage()
      p.text(x + 10, y, 8, `${u.quantity} × ${u.item}`, { gray: 0.3 })
      y += 12
    }
  }

  close()
  return buildMultiPagePdfBytes(pages.map((pg) => ({ ops: pg.ops, images: pg.images })))
}

// ---------------------------------------------------------------------------
// Artwork (the only DOM-touching layer) + the export action
// ---------------------------------------------------------------------------

/**
 * Decode what the documents can show: the key plan, and one photo per specified
 * product. Every failure resolves to `null` — a bank CDN that sends no CORS
 * headers, an offline export, a headless run with no canvas — and the documents
 * are complete without them.
 */
export async function buildCommercialArtwork(state: DocState, set: CommercialSet): Promise<CommercialArtwork> {
  let keyPlan: PdfJpeg | null = null
  try {
    if (typeof document !== 'undefined' && state.walls.length > 0) keyPlan = keyPlanJpeg(state, 'all', 340, 190)
  } catch {
    keyPlan = null
  }
  const photos = new Map<string, PdfJpeg>()
  for (const sp of set.spec.products) {
    if (!sp.imageUrl) continue
    const jpeg = await logoJpeg(sp.imageUrl, 520, { crossOrigin: true })
    if (jpeg) photos.set(sp.productId, jpeg)
  }
  return { keyPlan, photos }
}

/** The three documents as named byte streams — the shape both the download
 *  action and the deliverable pack consume, so neither can produce a document
 *  the other cannot. */
export interface CommercialDocuments {
  set: CommercialSet
  files: { name: string; bytes: Uint8Array<ArrayBuffer> }[]
}

/**
 * Derive the set (re-reading price provenance from the live bank), render all
 * three documents, and hand back their bytes.
 *
 * `opts.facts` short-circuits the bank round-trip; `opts.origin` points it
 * somewhere other than the current page.
 */
export async function buildCommercialDocuments(
  state: DocState,
  opts: CommercialOptions & { origin?: string; artwork?: boolean } = {},
): Promise<CommercialDocuments> {
  const facts =
    opts.facts ??
    (await fetchBankFacts(boundProductIds(state), {
      origin: opts.origin ?? (typeof location !== 'undefined' ? location.origin : ''),
    }))
  const set = buildCommercialSet(state, { ...opts, facts })
  const art = opts.artwork === false ? EMPTY_ARTWORK : await buildCommercialArtwork(state, set)
  return {
    set,
    files: [
      { name: 'bill-of-materials.pdf', bytes: buildBomPdfBytes(set, art) },
      { name: 'quotation.pdf', bytes: buildQuotePdfBytes(set, art) },
      { name: 'product-specification.pdf', bytes: buildSpecPdfBytes(set, art) },
    ],
  }
}

/**
 * One action → three PDFs in the designer's downloads: the bill of materials,
 * the quotation and the product specification sheet, all stamped with the same
 * document fingerprint.
 */
export async function exportCommercialSet(
  state: DocState,
  opts: CommercialOptions & { origin?: string } = {},
): Promise<CommercialDocuments> {
  const docs = await buildCommercialDocuments(state, opts)
  for (const f of docs.files) {
    triggerDownload(new Blob([f.bytes as unknown as BlobPart], { type: 'application/pdf' }), f.name)
  }
  return docs
}
