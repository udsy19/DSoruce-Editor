// `qto-native` — class A. Hierarchical rollup in the Rust core.
//
// Reads the in-memory `Document` and builds level → room → category → item with
// rolled-up subtotals. No IFC round-trip, no service, works offline.
//
// Room attribution comes from `Zone::component_ids` — exactly the information
// our IFC export drops, which is the structural reason this rung can build a
// room level and an IFC-consuming one cannot (ADR 0004 prediction (b)).
//
// Independence: the bench truth is a flat summation over SERIALIZED state in JS;
// this is a rollup over the in-memory Document in Rust. No shared aggregation
// code, so agreement is evidence rather than tautology.

import type { DocState } from '../../../web/src/types/doc'
import type { CostSchedule, QuantityEngine } from './types'

/** Injected by the runner: a live wasm Editor already holding the document. */
export interface WasmHost {
  qto_schedule(): unknown
}
let host: WasmHost | null = null
export function setWasmHost(h: WasmHost | null): void {
  host = h
}

interface RustLine {
  label: string
  category: string
  product_id: string | null
  quantity_kind: string
  quantity: number
  area_m2: number
  unit_price_inr: number | null
  total_inr: number | null
}
interface RustNode {
  kind: string
  label: string
  children: RustNode[]
  lines: RustLine[]
  subtotal_inr: number
  item_count: number
}

const toNode = (n: RustNode): CostSchedule['root'] => ({
  kind: n.kind,
  label: n.label,
  children: n.children.map(toNode),
  lines: n.lines.map((l) => ({
    productId: l.product_id ?? undefined,
    label: l.label,
    category: l.category,
    quantityKind: (l.quantity_kind as 'count') ?? 'count',
    quantity: l.quantity,
    basis: 'counted' as const,
    unitPriceInr: l.unit_price_inr ?? undefined,
    totalInr: l.total_inr ?? undefined,
  })),
  subtotalInr: n.subtotal_inr,
  itemCount: n.item_count,
})

export const qtoNative: QuantityEngine = {
  meta: {
    id: 'qto-native',
    summary:
      'Hierarchical rollup in the Rust core (level → room → category → item) from the document directly. Offline, no IFC round-trip.',
    portability: 'A-port',
    license: 'original',
  },
  schedule(_state: DocState): CostSchedule | null {
    if (!host) return null
    const raw = host.qto_schedule() as {
      root: RustNode
      all_lines: RustLine[]
      grand_total_inr: number
      item_count: number
      hierarchical: boolean
      unassigned_items: number
    }
    const root = toNode(raw.root)
    const flatten = (n: CostSchedule['root']): CostSchedule['allLines'] => [
      ...n.lines,
      ...n.children.flatMap(flatten),
    ]
    return {
      root,
      allLines: flatten(root),
      grandTotalInr: raw.grand_total_inr,
      itemCount: raw.item_count,
      hierarchical: raw.hierarchical,
    }
  },
}
export default qtoNative
