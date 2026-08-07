// The commercial set: ONE model, three documents.
//
//   Bill of materials  ·  Quotation  ·  Product specification sheet
//
// The whole point of this module is that those three documents cannot disagree.
// They are three PROJECTIONS of a single `CommercialSet` built once from one
// `DocState`, and that set is itself built on `buildTakeoffModel` — the same
// derivation the 12-sheet QTO workbook bills from. Nothing here re-counts a
// component, re-assigns a room or re-reads a price:
//
//   Editor.state()  ──►  buildTakeoffModel  ──►  CommercialSet  ──┬──►  BOM
//   (the core, the                                               ├──►  Quote
//    source of truth)                                            └──►  Spec
//
// Consequences worth stating, because an investor will ask:
//   * PRICE IS CORE-AUTHORITATIVE (takeoff.ts, ADR 0004). ₹ comes off
//     `Component.price_inr`, written by `Editor.assign_product`. This module
//     never invents one, and an item the bank prices as null is carried through
//     as "to be quoted", never as zero and never as a guess.
//   * EVERY non-reference component in the document appears on the bill exactly
//     once — furniture and doors alike — and `census` states what was excluded
//     rather than dropping it silently.
//   * All three documents print the same `stamp.fingerprint`, which is a hash of
//     the document census. Two documents carrying the same fingerprint were
//     derived from the same model; a document whose fingerprint differs from the
//     plan's was made from a different plan. That is the "one model, every
//     deliverable" claim reduced to eight characters you can read off the paper.
//
// This file is PURE and DOM-free (node-testable). `fetchBankFacts` is the one
// async function and it only speaks HTTP.

import type { DocState } from '../types/doc'
import {
  buildTakeoffModel,
  parseItemDescription,
  type TakeoffFurnitureRow,
  type TakeoffOptions,
} from './takeoff'

// ---------------------------------------------------------------------------
// Derivation stamp — the visible link between the three documents
// ---------------------------------------------------------------------------

export interface DerivationStamp {
  project: string
  floor: string | number
  /** ISO instant the set was derived. */
  derivedAt: string
  /** Non-reference components in the document — what the bill must cover. */
  components: number
  walls: number
  zones: number
  /** `DOC-XXXXXXXX` — see {@link documentFingerprint}. */
  fingerprint: string
}

/** FNV-1a (32-bit). Deterministic, dependency-free, and enough to tell two
 *  documents apart on a printed page — this is a provenance label, not a
 *  cryptographic commitment. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * A short, stable label for "which document is this". Derived from the census
 * the deliverables actually bill — every non-reference component's category,
 * footprint, bound product and price, plus the wall and zone counts — so it
 * moves when anything a document would print moves, and does not move when
 * something no document prints (a selection, a camera) does.
 */
export function documentFingerprint(state: DocState): string {
  const counts = new Map<string, number>()
  for (const c of state.components) {
    if (c.reference) continue
    const k = `${c.category}|${Math.round(c.w * 100)}x${Math.round(c.h * 100)}|${c.product_id ?? ''}|${
      c.price_inr ?? ''
    }`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}#${n}`)
  parts.push(`walls:${state.walls.length}`, `zones:${(state.zones ?? []).length}`)
  return `DOC-${fnv1a(parts.join(';')).toString(16).toUpperCase().padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// Price provenance — where a number on the quote came from
// ---------------------------------------------------------------------------

/**
 * Everything the material bank records about ONE observed price. Field names
 * mirror the bank's `/api/bank/product/<id>` `price` object exactly, so there is
 * no translation layer to drift: `basis` ("listed_mrp"), `observedAt`, `source`,
 * `sourceUrl`, `stale`, `ageDays`.
 */
export interface PriceProvenance {
  basis: string | null
  observedAt: string | null
  source: string | null
  sourceUrl: string | null
  stale: boolean | null
  ageDays: number | null
}

/** Descriptive facts about a bound product, as the bank publishes them. */
export interface BankFacts {
  productId: string
  ok: boolean
  name: string | null
  brand: string | null
  supplier: string | null
  sku: string | null
  classification: string | null
  colour: string | null
  finish: string | null
  sizeMm: string | null
  imageUrl: string | null
  description: string | null
  /** The bank's own ₹ figure. NOT used as the quote's price — the core is
   *  authoritative for money — but shown when it disagrees, which is the
   *  designer's cue that the binding is stale. */
  bankPriceInr: number | null
  provenance: PriceProvenance | null
  fetchedAt: string
}

const BANK_ID = /^bank:(\d+)$/

interface BankPriceJson {
  price_inr?: number | null
  basis?: string | null
  observed_at?: string | null
  source?: string | null
  source_url?: string | null
  stale?: boolean | null
  age_days?: number | null
}
interface BankProductJson {
  brand?: string | null
  title?: string | null
  sku?: string | null
  supplier_domain?: string | null
  category_std?: string | null
  category?: string | null
  omniclass?: string | null
  colour_primary?: string | null
  color?: string | null
  finish?: string | null
  size_mm?: string | null
  image_url?: string | null
  description?: string | null
  price?: BankPriceJson | number | null
}

function provenanceOf(p: BankProductJson['price']): PriceProvenance | null {
  if (!p || typeof p !== 'object') return null
  return {
    basis: p.basis ?? null,
    observedAt: p.observed_at ?? null,
    source: p.source ?? null,
    sourceUrl: p.source_url ?? null,
    stale: p.stale ?? null,
    ageDays: p.age_days ?? null,
  }
}

/**
 * Bank string fields carry placeholders as well as values — `""`, `"unknown"`,
 * `"n/a"`, `"null"`. Printing one of those on a specification sheet states a
 * fact the bank never asserted, so they are normalised to absent and the sheet
 * shows its own "—" instead.
 */
function clean(s: string | null | undefined): string | null {
  const t = s?.trim()
  if (!t) return null
  return /^(unknown|n\/?a|none|null|undefined|-)$/i.test(t) ? null : t
}

function factsFrom(productId: string, j: BankProductJson): BankFacts {
  const price = j.price && typeof j.price === 'object' ? j.price : null
  return {
    productId,
    ok: true,
    name: clean(j.title),
    brand: clean(j.brand),
    supplier: clean(j.supplier_domain),
    sku: clean(j.sku),
    classification: clean(j.category_std) ?? clean(j.category),
    colour: clean(j.colour_primary) ?? clean(j.color),
    finish: clean(j.finish),
    sizeMm: clean(j.size_mm),
    imageUrl: clean(j.image_url),
    description: clean(j.description),
    bankPriceInr: typeof price?.price_inr === 'number' ? price.price_inr : null,
    provenance: provenanceOf(j.price),
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Re-read each bound product from the LIVE material bank at export time.
 *
 * Deliberately not taken from the App's in-memory bindings map: that map is a
 * cache of what the panel showed when the designer bound the product, and a
 * quote's whole value is that its prices carry a source and a date. Asking the
 * bank again is the independent path — the quote cites what the bank says NOW,
 * with the observation date the bank itself records.
 *
 * Never throws: a product the bank does not know (a local mock id, an offline
 * export) comes back `ok: false`, and every document then says "provenance not
 * available" for that line instead of printing something unsourced.
 */
export async function fetchBankFacts(
  productIds: Iterable<string>,
  o: { origin?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Map<string, BankFacts>> {
  const out = new Map<string, BankFacts>()
  const doFetch = o.fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  const base = (o.origin ?? '').replace(/\/$/, '')
  const ids = [...new Set(productIds)]
  for (const pid of ids) {
    const m = BANK_ID.exec(pid)
    if (!m || !doFetch) {
      out.set(pid, unknownFacts(pid))
      continue
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs ?? 6000) : null
    try {
      const res = await doFetch(`${base}/api/bank/product/${m[1]}`, ctrl ? { signal: ctrl.signal } : undefined)
      if (!res.ok) throw new Error(`bank ${res.status}`)
      const j = (await res.json()) as { product?: BankProductJson }
      out.set(pid, j.product ? factsFrom(pid, j.product) : unknownFacts(pid))
    } catch {
      out.set(pid, unknownFacts(pid))
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  return out
}

function unknownFacts(productId: string): BankFacts {
  return {
    productId,
    ok: false,
    name: null,
    brand: null,
    supplier: null,
    sku: null,
    classification: null,
    colour: null,
    finish: null,
    sizeMm: null,
    imageUrl: null,
    description: null,
    bankPriceInr: null,
    provenance: null,
    fetchedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// The one model
// ---------------------------------------------------------------------------

/** Which part of the bill a line belongs to. */
export type BomSection = 'Furniture & fixtures' | 'Doors & openings'

/** One aggregated line — the atom all three documents are made of. */
export interface BomLine {
  section: BomSection
  costCode: string
  category: string
  /** "Desk W70 X L140" — the takeoff's own description, verbatim. */
  item: string
  /** "Desk" */
  name: string
  /** "70 × 140 cm", from the placed footprint in the core. Null if unparseable. */
  dims: string | null
  roomId: string | number
  roomType: string
  quantity: number
  productId: string | null
  productName: string | null
  supplier: string
  /** ₹ per unit. 0 means NOT PRICED — see {@link priced}. */
  unitPrice: number
  totalPrice: number
  priced: boolean
}

export interface BomGroup {
  name: string
  costCode: string
  section: BomSection
  quantity: number
  /** Distinct rooms this item appears in. */
  rooms: number
  lines: BomLine[]
}

export interface BomCensus {
  /** Components billed = furniture + openings. */
  billed: number
  furniture: number
  openings: number
  /** Passive imported/legacy furniture, deliberately not billed. */
  reference: number
  /** Every component in the document, billed or not. */
  documentComponents: number
  /** Billed components carrying a bound product. */
  specified: number
  /** Billed components with a bound product AND a ₹ price. */
  pricedUnits: number
}

/** A statutory or commercial adjustment applied under the quote's subtotal. */
export interface QuoteAdjustment {
  label: string
  /** Fraction of the subtotal (0.18 = 18%). */
  rate: number
  amount: number
  /** True when the figure is a demo assumption rather than a statutory rate. */
  demo: boolean
}

export interface QuoteLine extends BomLine {
  provenance: PriceProvenance | null
  /** The bank's current ₹ for this product, when it could be re-read. */
  bankPriceInr: number | null
  /** Bank price ≠ the price on the document. Shown, never silently corrected. */
  drifted: boolean
}

export interface QuoteGroup {
  name: string
  costCode: string
  lines: QuoteLine[]
  /** Σ of the PRICED lines only. */
  subtotal: number
  pricedQty: number
  unpricedQty: number
}

export interface QuoteModel {
  currency: 'INR'
  groups: QuoteGroup[]
  subtotal: number
  adjustments: QuoteAdjustment[]
  total: number
  /** Lines carrying no published price — listed, never zero-filled. */
  toBeQuoted: BomLine[]
  toBeQuotedUnits: number
  /** How many priced lines could cite a bank observation. */
  sourcedLines: number
  pricedLines: number
}

export interface SpecPlacement {
  roomId: string | number
  roomType: string
  quantity: number
}

export interface SpecProduct {
  productId: string
  /** Bank title when the bank answered, else the name bound into the document. */
  name: string
  brand: string | null
  supplier: string | null
  sku: string | null
  classification: string | null
  colour: string | null
  finish: string | null
  /** Manufacturer's published size, when the bank has one. */
  sizeMm: string | null
  /** Footprint AS PLACED, from the core's geometry. Always real. */
  footprint: string | null
  imageUrl: string | null
  description: string | null
  unitPrice: number | null
  provenance: PriceProvenance | null
  bankPriceInr: number | null
  /** Where the descriptive fields came from — what an investor is asking when
   *  they ask "is this real?". */
  source: 'material-bank' | 'document'
  placements: SpecPlacement[]
  totalQuantity: number
}

export interface SpecModel {
  products: SpecProduct[]
  /** Billed items with no product bound yet, aggregated by item. */
  unspecified: { name: string; item: string; quantity: number }[]
  unspecifiedUnits: number
  specifiedUnits: number
}

export interface CommercialSet {
  stamp: DerivationStamp
  lines: BomLine[]
  groups: BomGroup[]
  census: BomCensus
  quote: QuoteModel
  spec: SpecModel
}

export interface CommercialOptions extends TakeoffOptions {
  /** Bank facts keyed by product id — {@link fetchBankFacts}. Absent → every
   *  document says provenance was not available, which is the honest answer for
   *  an offline export. */
  facts?: Map<string, BankFacts>
  /**
   * Applied to the priced subtotal. Defaults to Indian GST at 18%, the
   * statutory rate for office furniture (HSN 9403) — a real rate, marked
   * `demo: false`. Pass `[]` for a pre-tax quote.
   */
  adjustments?: Omit<QuoteAdjustment, 'amount'>[]
  /** Overrides `new Date()` so a test can pin the stamp. */
  now?: Date
}

/** The takeoff's "no bound supplier" placeholder — a spec sheet must not print
 *  it as if it were a company. Kept honest by `commercial.test.mjs`, which
 *  asserts an unbound line's supplier equals this string. */
const DEFAULT_SUPPLIER_TEXT = 'Can be customized'

const DEFAULT_ADJUSTMENTS: Omit<QuoteAdjustment, 'amount'>[] = [
  { label: 'GST @ 18% (HSN 9403, office furniture)', rate: 0.18, demo: false },
]

/**
 * Who a line is bought from.
 *
 * The takeoff's supplier comes from the App's bindings map, which is UI-layer
 * display metadata and is frequently empty (it holds only what the re-imagine
 * panel happened to cache). The bank knows the real distributor domain, so a
 * bank answer WINS over the takeoff's "Can be customized" placeholder — that
 * placeholder is not a company and must never print on a quote as if it were.
 * A real bound supplier in the map still wins over both.
 */
function supplierFor(r: TakeoffFurnitureRow, f: BankFacts | undefined): string {
  const bound = r.supplier?.trim()
  if (bound && bound !== DEFAULT_SUPPLIER_TEXT) return bound
  return f?.supplier ?? (r.productId ? 'not published' : 'not specified')
}

function toLine(r: TakeoffFurnitureRow, section: BomSection, facts?: Map<string, BankFacts>): BomLine {
  const { name, dims } = parseItemDescription(r.itemDescription)
  const f = r.productId ? facts?.get(r.productId) : undefined
  return {
    section,
    costCode: r.costCode,
    category: r.category,
    item: r.itemDescription,
    name,
    dims,
    roomId: r.roomId,
    roomType: r.roomType,
    quantity: r.quantity,
    productId: r.productId,
    productName: f?.name ?? r.productName,
    supplier: supplierFor(r, f),
    unitPrice: r.unitPrice,
    totalPrice: r.totalPrice,
    priced: r.unitPrice > 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Build the whole commercial set from one document state. Pure: same state and
 * same options in, byte-identical set out (`now` is the only clock, and it is
 * injectable).
 */
export function buildCommercialSet(state: DocState, opts: CommercialOptions = {}): CommercialSet {
  const takeoff = buildTakeoffModel(state, opts)
  const facts = opts.facts
  const now = opts.now ?? new Date()

  const lines: BomLine[] = [
    ...takeoff.furniture.map((r) => toLine(r, 'Furniture & fixtures', facts)),
    ...takeoff.openings.map((r) => toLine(r, 'Doors & openings', facts)),
  ]

  // ---- census ------------------------------------------------------------
  const furnitureUnits = takeoff.furniture.reduce((n, r) => n + r.quantity, 0)
  const openingUnits = takeoff.openings.reduce((n, r) => n + r.quantity, 0)
  const census: BomCensus = {
    billed: furnitureUnits + openingUnits,
    furniture: furnitureUnits,
    openings: openingUnits,
    reference: takeoff.excluded.reference,
    documentComponents: state.components.length,
    specified: lines.filter((l) => l.productId).reduce((n, l) => n + l.quantity, 0),
    pricedUnits: lines.filter((l) => l.priced).reduce((n, l) => n + l.quantity, 0),
  }

  // ---- BOM view: by item, across rooms -----------------------------------
  const groupMap = new Map<string, BomGroup>()
  for (const l of lines) {
    const key = `${l.section}|${l.item}`
    const g = groupMap.get(key)
    if (g) {
      g.quantity += l.quantity
      g.lines.push(l)
    } else {
      groupMap.set(key, {
        name: l.item,
        costCode: l.costCode,
        section: l.section,
        quantity: l.quantity,
        rooms: 0,
        lines: [l],
      })
    }
  }
  const groups = [...groupMap.values()].sort(
    (a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name),
  )
  for (const g of groups) g.rooms = new Set(g.lines.map((l) => String(l.roomId))).size

  // ---- Quote view --------------------------------------------------------
  const quoteLine = (l: BomLine): QuoteLine => {
    const f = l.productId ? facts?.get(l.productId) : undefined
    const bankPriceInr = f?.bankPriceInr ?? null
    return {
      ...l,
      provenance: f?.provenance ?? null,
      bankPriceInr,
      drifted: l.priced && bankPriceInr != null && Math.round(bankPriceInr) !== Math.round(l.unitPrice),
    }
  }
  const qGroupMap = new Map<string, QuoteGroup>()
  for (const l of lines) {
    const g = qGroupMap.get(l.item) ?? {
      name: l.item,
      costCode: l.costCode,
      lines: [],
      subtotal: 0,
      pricedQty: 0,
      unpricedQty: 0,
    }
    qGroupMap.set(l.item, g)
    const ql = quoteLine(l)
    g.lines.push(ql)
    if (ql.priced) {
      g.subtotal = round2(g.subtotal + ql.totalPrice)
      g.pricedQty += ql.quantity
    } else {
      g.unpricedQty += ql.quantity
    }
  }
  const qGroups = [...qGroupMap.values()].sort((a, b) => a.name.localeCompare(b.name))
  const subtotal = round2(qGroups.reduce((n, g) => n + g.subtotal, 0))
  const adjustments: QuoteAdjustment[] = (opts.adjustments ?? DEFAULT_ADJUSTMENTS).map((a) => ({
    ...a,
    amount: round2(subtotal * a.rate),
  }))
  const toBeQuoted = lines.filter((l) => !l.priced)
  const pricedLines = lines.filter((l) => l.priced)
  const quote: QuoteModel = {
    currency: 'INR',
    groups: qGroups,
    subtotal,
    adjustments,
    total: round2(subtotal + adjustments.reduce((n, a) => n + a.amount, 0)),
    toBeQuoted,
    toBeQuotedUnits: toBeQuoted.reduce((n, l) => n + l.quantity, 0),
    sourcedLines: pricedLines.filter((l) => l.productId && facts?.get(l.productId)?.provenance).length,
    pricedLines: pricedLines.length,
  }

  // ---- Spec view ---------------------------------------------------------
  const specMap = new Map<string, SpecProduct>()
  for (const l of lines) {
    if (!l.productId) continue
    const f = facts?.get(l.productId)
    const existing = specMap.get(l.productId)
    if (existing) {
      existing.placements.push({ roomId: l.roomId, roomType: l.roomType, quantity: l.quantity })
      existing.totalQuantity += l.quantity
      continue
    }
    specMap.set(l.productId, {
      productId: l.productId,
      name: f?.name ?? l.productName ?? l.name,
      brand: f?.brand ?? null,
      supplier: f?.supplier ?? (l.supplier.startsWith('not ') ? null : l.supplier),
      sku: f?.sku ?? null,
      classification: f?.classification ?? null,
      colour: f?.colour ?? null,
      finish: f?.finish ?? null,
      sizeMm: f?.sizeMm ?? null,
      footprint: l.dims,
      imageUrl: f?.imageUrl ?? null,
      description: f?.description ?? null,
      unitPrice: l.priced ? l.unitPrice : null,
      provenance: f?.provenance ?? null,
      bankPriceInr: f?.bankPriceInr ?? null,
      source: f?.ok ? 'material-bank' : 'document',
      placements: [{ roomId: l.roomId, roomType: l.roomType, quantity: l.quantity }],
      totalQuantity: l.quantity,
    })
  }
  const unspecMap = new Map<string, { name: string; item: string; quantity: number }>()
  for (const l of lines) {
    if (l.productId) continue
    const u = unspecMap.get(l.item)
    if (u) u.quantity += l.quantity
    else unspecMap.set(l.item, { name: l.name, item: l.item, quantity: l.quantity })
  }
  const spec: SpecModel = {
    products: [...specMap.values()].sort((a, b) => b.totalQuantity - a.totalQuantity || a.name.localeCompare(b.name)),
    unspecified: [...unspecMap.values()].sort((a, b) => b.quantity - a.quantity),
    unspecifiedUnits: [...unspecMap.values()].reduce((n, u) => n + u.quantity, 0),
    specifiedUnits: census.specified,
  }

  return {
    stamp: {
      project: opts.project ?? 'Untitled Plan',
      floor: opts.floor ?? 1,
      derivedAt: now.toISOString(),
      components: census.billed,
      walls: state.walls.length,
      zones: (state.zones ?? []).length,
      fingerprint: documentFingerprint(state),
    },
    lines,
    groups,
    census,
    quote,
    spec,
  }
}

/** Product ids bound anywhere in a set — the input to {@link fetchBankFacts}. */
export function boundProductIds(state: DocState): string[] {
  const ids = new Set<string>()
  for (const c of state.components) {
    if (c.reference) continue
    if (c.product_id) ids.add(c.product_id)
  }
  return [...ids]
}
