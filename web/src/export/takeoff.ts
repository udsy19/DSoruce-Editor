// The FURNITURE half of the quantity takeoff: DocState -> per-room BOM rows.
//
// This file used to own an entire 4-sheet .xlsx export AND its own wall
// classification. Both are gone:
//   * the workbook is now `qtoWorkbook.ts` — the full 12-sheet, formula-wired
//     qbiq-parity deliverable, which imports `buildTakeoffModel` from here for
//     its 'Furniture Inventory' / 'Furniture Inventory Summary' sheets;
//   * wall/door/room quantities come from `Editor.quantities()` (the Rust core,
//     crates/ds-core/src/quantity.rs). The classification that lived here —
//     `!generated` as the perimeter test, zone perimeters for core — disagreed
//     with the core on every imported DWG (there, EVERY wall is `!generated`,
//     so interior partitions were billed as facade). It was deleted rather than
//     left to drift.
//
// What remains is the one thing the core does not model: priced furniture,
// aggregated per room and per item. Currency is ₹ (INR) per CLAUDE.md.
// Item Descriptions carry W×L in cm ("Desk W70 X L140"), matching the sample.

import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../types/doc'
import { isGroundZone } from '../types/doc'
import { pointInZoneShape, zoneArea } from '../util/zoneGeom'
import { catByCategory } from '../editor/catalog'
import { roomTypeLabel } from './finishSchedule'

// ---------------------------------------------------------------------------
// Model (pure — unit-testable without the xlsx layer)
// ---------------------------------------------------------------------------

export interface TakeoffOptions {
  /** product_id -> binding. Same shape as App's `bindings` (extra keys ok);
   *  `supplier`/`brand` feed the Supplier column, `price` the cost columns. */
  bindings?: Map<string, { price: number | null; supplier?: string | null; brand?: string | null }>
  /** Floor label/number shown in the BOM (default 1). */
  floor?: string | number
  /** Project name for docProps. */
  project?: string
  /** Supplier shown when a component has no bound supplier (matches sample). */
  supplierFallback?: string
  /** zone.id → user room reference (from a Space-step room marker sitting in
   *  that zone). When present, the Room ID column shows the human ref (e.g.
   *  "502") instead of the generated zone id. Re-resolved per export against
   *  the current zones (workflow.md §3.2). */
  roomRefs?: Map<number, string>
}

/** One aggregated line in the per-component furniture BOM. */
export interface TakeoffFurnitureRow {
  costCode: string
  floor: string | number
  roomId: string | number
  roomType: string
  itemDescription: string
  supplier: string
  quantity: number
  unitPrice: number
  totalPrice: number
  /** Bound product identity, carried so a downstream document (the product
   *  specification sheet) can name the ACTUAL product behind a line instead of
   *  re-deriving its own component→product map. `null` when unspecified.
   *  It is part of the aggregation key, so one line is always one product. */
  productId: string | null
  /** `Component.label` of the bound product (the core writes it on bind). */
  productName: string | null
  /** Document category the line came from (`Desk`, `Chair`, `Door`, …). */
  category: string
}

/** One line in the item-summary sheet (aggregated across all rooms). */
export interface TakeoffSummaryRow {
  costCode: string
  itemDescription: string
  supplier: string
  quantity: number
  unitPrice: number
  totalPrice: number
  /** Bound product identity (see {@link TakeoffFurnitureRow.productId}). */
  productId: string | null
  productName: string | null
  category: string
}

export interface TakeoffModel {
  furniture: TakeoffFurnitureRow[]
  summary: TakeoffSummaryRow[]
  /**
   * The SAME row shape for the categories the furniture BOM deliberately does
   * not bill as loose furniture ({@link NON_FURNITURE} — doors). They are still
   * elements of the document, so a bill of materials that claims to cover the
   * plan must list them; the workbook ignores this array and bills them off the
   * core's `quantities()` instead.
   *
   * Emitted here rather than re-derived downstream so a door is described,
   * costed and roomed by exactly the same code as a desk.
   */
  openings: TakeoffFurnitureRow[]
  totals: {
    furniture: number
    itemCount: number
  }
  /** Components the BOM legitimately leaves out, so a document can SAY so
   *  rather than silently dropping them. */
  excluded: {
    /** Passive imported/legacy furniture (`Component.reference`). */
    reference: number
  }
}

const DEFAULT_SUPPLIER = 'Can be customized'

// The Room Type column is `roomTypeLabel` (finishSchedule.ts) — the SAME
// derivation the Inventory sheet's Subcategory uses. A private zone_type ->
// vocabulary table used to live here; it collapsed the core's 7 ZoneType values
// onto 7 strings of its own and therefore billed Reception (an `Amenity` zone)
// as a "Kitchen" while the Inventory row for the same Room ID said "Reception".
// One deliverable cannot tell two stories about one room, so it is deleted.

// Short per-category cost code (the sample leaves this "Can be customized";
// a real code is more useful and still overridable downstream).
const COST_CODE: Record<string, string> = {
  Desk: 'FF-DSK',
  Chair: 'FF-CHR',
  Table: 'FF-TBL',
  MeetingRoom: 'FF-MTG',
  FallCeiling: 'CL-FCL',
}
export function costCodeFor(category: string): string {
  return COST_CODE[category] ?? `FF-${category.slice(0, 3).toUpperCase()}`
}

// Categories that are NOT loose furniture — routed to the wall schedule, not
// the furniture BOM (doors are placed as components by the generator).
const NON_FURNITURE = new Set(['Door'])

/** Clean display name for a component ("Desk", "Meeting Room", …). */
function itemName(c: DocComponent): string {
  return catByCategory(c.category)?.label ?? c.category
}

/**
 * Item Description with W×L in cm, matching the sample's "Desk W70 X L140"
 * style: W is the shorter side, L the longer — rotation-independent.
 */
export function itemDescription(c: DocComponent): string {
  const a = Math.round(Math.min(c.w, c.h) * 100)
  const b = Math.round(Math.max(c.w, c.h) * 100)
  return `${itemName(c)} W${a} X L${b}`
}

/** Inverse of {@link itemDescription}: "Desk W70 X L140" → name + "70 × 140 cm".
 *  One parser, so every document that splits a description splits it the same
 *  way (the drawing set's product cards use it too). */
export function parseItemDescription(desc: string): { name: string; dims: string | null } {
  const m = desc.match(/^(.+?)\s+W(\d+)\s+X\s+L(\d+)$/)
  return m ? { name: m[1], dims: `${m[2]} × ${m[3]} cm` } : { name: desc, dims: null }
}

/**
 * The MOST SPECIFIC zone containing point (px,py) in EDITOR coords, or null.
 * Exported so the room-marker → zone association (App.tsx) reuses the one
 * point-in-zone test rather than forking it (no-bloat).
 *
 * Mirrors the core's `Document::zone_index_at` rule exactly — a specific zone
 * outranks any `Circulation` zone, and within a class the SMALLEST-area zone
 * wins — so the Furniture Elements column (this function) and the Headcount
 * column (the core's bucketing) can never disagree. A first-wins scan happened
 * to agree with the core on generated documents because rooms are emitted
 * before the plate-spanning workspace field; that agreement was an accident of
 * emission order, and this makes it structural.
 */
export function zoneAtPoint(px: number, py: number, zones: DocZone[]): DocZone | null {
  let chosen: DocZone | null = null
  let chosenArea = 0
  let foundSpecific = false
  for (const z of zones) {
    if (!pointInZoneShape(z.shape, px, py)) continue
    const circ = isGroundZone(z.zone_type)
    if (circ && foundSpecific) continue // a specific zone already outranks it
    const area = zoneArea(z.shape)
    if (!circ && !foundSpecific) {
      foundSpecific = true // first specific zone displaces circulation
      chosen = z
      chosenArea = area
    } else if (chosen === null || area < chosenArea) {
      chosen = z
      chosenArea = area
    }
  }
  return chosen
}

/** The zone whose rect contains a component's center, or null (→ catch-all). */
function zoneFor(c: DocComponent, zones: DocZone[]): DocZone | null {
  return zoneAtPoint(c.x, c.y, zones)
}

/**
 * Build the structured furniture takeoff (per-room BOM + item summary + totals)
 * from a document. Pure — no DOM, no xlsx — so it is unit-testable.
 */
export function buildTakeoffModel(state: DocState, opts: TakeoffOptions = {}): TakeoffModel {
  const floor = opts.floor ?? 1
  const supplierFallback = opts.supplierFallback ?? DEFAULT_SUPPLIER
  const bindings = opts.bindings
  const roomRefs = opts.roomRefs
  const zones = state.zones ?? []

  // PRICE IS CORE-AUTHORITATIVE. `Editor.assign_product` writes `price_inr` onto
  // the component and it rides state()/snapshot(); the App's bindings map is
  // UI-layer display metadata (supplier, brand, thumbnail) and is NOT a price
  // source. Reading the map here was a second, unenforced store: a component
  // priced through the core reached this cost line unpriced whenever the App map
  // was out of sync — the shape of the Track F bug, and a latent one the branch-2
  // bake-off surfaced (ADR 0004).
  const priceOf = (c: DocComponent): number => {
    const p = c.price_inr
    return p != null && Number.isFinite(p) ? p : 0
  }

  // Supplier per component: the bound product's real supplier, else its brand,
  // else the sample's fallback. Empty/whitespace values are treated as absent.
  const supplierOf = (c: DocComponent): string => {
    const b = c.product_id ? bindings?.get(c.product_id) : undefined
    const s = b?.supplier?.trim() || b?.brand?.trim()
    return s || supplierFallback
  }

  // --- Furniture BOM: aggregate identical items within a room -------------
  // Key by room + description + supplier + unit price so genuinely identical
  // lines merge (e.g. 10 conference chairs) but differently-priced ones don't.
  const groups = new Map<string, TakeoffFurnitureRow>()
  const openingGroups = new Map<string, TakeoffFurnitureRow>()
  let referenceCount = 0
  for (const c of state.components) {
    // Passive imported/legacy furniture is reference-only — not part of the
    // specified fit-out you'd buy, so it stays out of the BoQ (matches the
    // cost/CO2 metric filter; laiout-deep-research.md: BoQ = generated only).
    // It is COUNTED, so a document can state what it excluded.
    if (c.reference) {
      referenceCount++
      continue
    }
    const into = NON_FURNITURE.has(c.category) ? openingGroups : groups
    const zone = zoneFor(c, zones)
    const roomId = zone ? (roomRefs?.get(zone.id) ?? zone.id) : 'OS'
    const roomType = roomTypeLabel(zone)
    const desc = itemDescription(c)
    const unitPrice = priceOf(c)
    const supplier = supplierOf(c)
    const productId = c.product_id ?? null
    const key = `${roomId}|${desc}|${supplier}|${unitPrice}|${productId ?? ''}`
    const existing = into.get(key)
    if (existing) {
      existing.quantity += 1
      existing.totalPrice = existing.quantity * existing.unitPrice
    } else {
      into.set(key, {
        costCode: costCodeFor(c.category),
        floor,
        roomId,
        roomType,
        itemDescription: desc,
        supplier,
        quantity: 1,
        unitPrice,
        totalPrice: unitPrice,
        productId,
        productName: productId ? c.label : null,
        category: c.category,
      })
    }
  }
  const byRoomThenItem = (a: TakeoffFurnitureRow, b: TakeoffFurnitureRow) =>
    String(a.roomId).localeCompare(String(b.roomId), undefined, { numeric: true }) ||
    a.itemDescription.localeCompare(b.itemDescription)
  const furniture = [...groups.values()].sort(byRoomThenItem)
  const openings = [...openingGroups.values()].sort(byRoomThenItem)

  // --- Item summary: aggregate across all rooms by description ------------
  const summaryMap = new Map<string, TakeoffSummaryRow>()
  for (const r of furniture) {
    const key = `${r.itemDescription}|${r.supplier}|${r.unitPrice}|${r.productId ?? ''}`
    const s = summaryMap.get(key)
    if (s) {
      s.quantity += r.quantity
      s.totalPrice = s.quantity * s.unitPrice
    } else {
      summaryMap.set(key, {
        costCode: r.costCode,
        itemDescription: r.itemDescription,
        supplier: r.supplier,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        totalPrice: r.totalPrice,
        productId: r.productId,
        productName: r.productName,
        category: r.category,
      })
    }
  }
  const summary = [...summaryMap.values()].sort((a, b) =>
    a.itemDescription.localeCompare(b.itemDescription),
  )

  const furnitureTotal = furniture.reduce((n, r) => n + r.totalPrice, 0)
  const itemCount = furniture.reduce((n, r) => n + r.quantity, 0)

  return {
    furniture,
    summary,
    openings,
    totals: {
      furniture: round2(furnitureTotal),
      itemCount,
    },
    excluded: { reference: referenceCount },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
