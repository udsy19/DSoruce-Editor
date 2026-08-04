// The incumbent, wrapped unchanged: `buildTakeoffModel` (export/takeoff.ts).
//
// It is FLAT by construction — furniture[], summary[], walls[], totals — so its
// `hierarchical` flag is false and the hierarchy metric is UNDEFINED for it, not
// zero (ADR 0004). It exists here as the accuracy floor every candidate must
// match, and as the guard on the cost-line invariant.

import { buildTakeoffModel } from '../../../web/src/export/takeoff'
import type { DocState } from '../../../web/src/types/doc'
import type { CostLine, CostSchedule, QuantityEngine } from './types'

/** Inverse of takeoff.ts's COST_CODE map, for per-category scoring. */
const COST_CODE_TO_CATEGORY: Record<string, string> = {
  'FF-DSK': 'Desk', 'FF-CHR': 'Chair', 'FF-TBL': 'Table', 'FF-STG': 'Storage',
}

export const baseline: QuantityEngine = {
  meta: {
    id: 'baseline',
    summary: 'Current flat takeoff (buildTakeoffModel), unmodified.',
    portability: 'A-port',
    license: 'original',
  },
  schedule(state: DocState, bindings): CostSchedule | null {
    // The incumbent takes a Map; the contract passes a plain object because
    // that is what crosses a service boundary. Adapting here, not there.
    const model = buildTakeoffModel(state, { bindings: new Map(Object.entries(bindings)) })
    if (!model) return null
    // The flat model has no productId on its rows — a priced row is identified
    // only by carrying a unitPrice. That is itself a finding for the cost-line
    // gate: the incumbent cannot say WHICH binding a line came from.
    // costCode encodes the category the row came from (FF-DES etc.); the model
    // does not carry the raw category, so it is recovered here.
    const catOf = (costCode: string) => COST_CODE_TO_CATEGORY[costCode] ?? costCode
    const lines: CostLine[] = model.furniture.map((r) => ({
      label: r.itemDescription,
      category: catOf(r.costCode),
      quantityKind: 'count' as const,
      quantity: r.quantity,
      basis: 'counted' as const,
      unitPriceInr: r.unitPrice || undefined,
      totalInr: r.totalPrice || undefined,
    }))
    return {
      root: {
        kind: 'level', label: 'Level 1', children: [], lines,
        subtotalInr: model.totals.furniture, itemCount: model.totals.itemCount,
      },
      allLines: lines,
      grandTotalInr: model.totals.grand,
      itemCount: model.totals.itemCount,
      hierarchical: false,
    }
  },
}
export default baseline
