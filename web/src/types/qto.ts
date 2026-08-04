// The hierarchical quantity schedule produced by the Rust core (`qto.rs`).
//
// Adopted from bake-off branch 2 (ADR 0004): level → room → category → item with
// rolled-up subtotals. Field names are the core's serde output — the TS side
// mirrors, it does not rename.
//
// Prices come from the core's `price_inr`; the App bindings map is display
// metadata and is NOT a price source (see `priceSourceOfTruth.test.mjs`).

export type QuantityKind = 'count' | 'length' | 'area' | 'volume'

export interface CostLine {
  label: string
  category: string
  product_id: string | null
  quantity_kind: QuantityKind
  quantity: number
  /** Footprint area (m²) of the items on this line. */
  area_m2: number
  /** ₹ unit price when bound. `null` means UNPRICED — never conflated with 0. */
  unit_price_inr: number | null
  total_inr: number | null
}

export interface CostNode {
  /** 'level' | 'room' | 'category' */
  kind: string
  label: string
  children: CostNode[]
  lines: CostLine[]
  /** Σ of this node's lines and every descendant's. */
  subtotal_inr: number
  item_count: number
}

export interface CostSchedule {
  root: CostNode
  all_lines: CostLine[]
  grand_total_inr: number
  item_count: number
  hierarchical: boolean
  /** Items in no zone — surfaced, never folded silently into a room. */
  unassigned_items: number
}
