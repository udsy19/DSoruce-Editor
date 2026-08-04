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

import type { DocState, DocComponent, DocZone, ZoneType } from '../editor/EditorCanvas'
import { pointInZoneShape } from '../util/zoneGeom'
import { catByCategory } from '../editor/catalog'

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
}

/** One line in the item-summary sheet (aggregated across all rooms). */
export interface TakeoffSummaryRow {
  costCode: string
  itemDescription: string
  supplier: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

export interface TakeoffModel {
  furniture: TakeoffFurnitureRow[]
  summary: TakeoffSummaryRow[]
  totals: {
    furniture: number
    itemCount: number
  }
}

const DEFAULT_SUPPLIER = 'Can be customized'

// zone_type -> the sample's room-type vocabulary.
const ROOM_TYPE: Record<ZoneType, string> = {
  Workspace: 'Open Space WorkStation',
  Meeting: 'Conference',
  Collaboration: 'Comfort Zone',
  ClosedOffice: 'Executive Office',
  Amenity: 'Kitchen',
  Core: 'Other',
  Circulation: 'Open Space',
}

// Short per-category cost code (the sample leaves this "Can be customized";
// a real code is more useful and still overridable downstream).
const COST_CODE: Record<string, string> = {
  Desk: 'FF-DSK',
  Chair: 'FF-CHR',
  Table: 'FF-TBL',
  MeetingRoom: 'FF-MTG',
  FallCeiling: 'CL-FCL',
}
function costCodeFor(category: string): string {
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
function itemDescription(c: DocComponent): string {
  const a = Math.round(Math.min(c.w, c.h) * 100)
  const b = Math.round(Math.max(c.w, c.h) * 100)
  return `${itemName(c)} W${a} X L${b}`
}

/** The zone whose rect contains point (px,py) in EDITOR coords, or null.
 *  Exported so the room-marker → zone association (App.tsx) reuses the one
 *  point-in-zone test rather than forking it (no-bloat). */
export function zoneAtPoint(px: number, py: number, zones: DocZone[]): DocZone | null {
  for (const z of zones) {
    if (pointInZoneShape(z.shape, px, py)) return z
  }
  return null
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

  const priceOf = (c: DocComponent): number => {
    if (!c.product_id || !bindings) return 0
    const p = bindings.get(c.product_id)?.price
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
  for (const c of state.components) {
    if (NON_FURNITURE.has(c.category)) continue
    // Passive imported/legacy furniture is reference-only — not part of the
    // specified fit-out you'd buy, so it stays out of the BoQ (matches the
    // cost/CO2 metric filter; laiout-deep-research.md: BoQ = generated only).
    if (c.reference) continue
    const zone = zoneFor(c, zones)
    const roomId = zone ? (roomRefs?.get(zone.id) ?? zone.id) : 'OS'
    const roomType = zone ? ROOM_TYPE[zone.zone_type] : 'Open Space'
    const desc = itemDescription(c)
    const unitPrice = priceOf(c)
    const supplier = supplierOf(c)
    const key = `${roomId}|${desc}|${supplier}|${unitPrice}`
    const existing = groups.get(key)
    if (existing) {
      existing.quantity += 1
      existing.totalPrice = existing.quantity * existing.unitPrice
    } else {
      groups.set(key, {
        costCode: costCodeFor(c.category),
        floor,
        roomId,
        roomType,
        itemDescription: desc,
        supplier,
        quantity: 1,
        unitPrice,
        totalPrice: unitPrice,
      })
    }
  }
  const furniture = [...groups.values()].sort(
    (a, b) =>
      String(a.roomId).localeCompare(String(b.roomId), undefined, { numeric: true }) ||
      a.itemDescription.localeCompare(b.itemDescription),
  )

  // --- Item summary: aggregate across all rooms by description ------------
  const summaryMap = new Map<string, TakeoffSummaryRow>()
  for (const r of furniture) {
    const key = `${r.itemDescription}|${r.supplier}|${r.unitPrice}`
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
    totals: {
      furniture: round2(furnitureTotal),
      itemCount,
    },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
