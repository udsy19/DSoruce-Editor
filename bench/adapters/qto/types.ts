// The QuantityEngine contract for the BOM/QTO bake-off.
//
// The incumbent's takeoff is flat. What this branch is testing is whether a
// HIERARCHICAL schedule — level → category → type → item, with parametric
// quantity links and rolled-up subtotals — can be produced accurately, and at
// what portability cost.

import type { DocState } from '../../../web/src/types/doc'
import type { PortabilityClass } from '../plate/types'

export type { PortabilityClass }

/** How a quantity was arrived at — scored, because derivation is not declaration. */
export type QuantityBasis =
  /** Read from an explicit quantity the source declared. */
  | 'declared'
  /** Computed from geometry by the engine. */
  | 'derived'
  /** Counted by enumeration. */
  | 'counted'

export interface CostLine {
  /** Stable identifier of the priced item, when one is bound. */
  productId?: string
  label: string
  /**
   * Document category this line measures (Desk / Door / Wall …). Required for
   * per-category accuracy: engines legitimately cover DIFFERENT category sets —
   * the incumbent excludes Door as non-furniture, an IFC consumer includes walls
   * — so a single total is not comparable across them.
   */
  category?: string
  /** Parametric quantity link — what is being measured. */
  quantityKind: 'count' | 'length' | 'area' | 'volume'
  quantity: number
  basis: QuantityBasis
  /** ₹, when the item carries a bound price. Absent ⇒ unpriced, not zero-priced. */
  unitPriceInr?: number
  totalInr?: number
}

/** One node of the hierarchy. Leaves carry lines; branches carry rolled subtotals. */
export interface CostNode {
  /** 'level' | 'room' | 'category' | 'type' — depth vocabulary, engine's choice. */
  kind: string
  label: string
  children: CostNode[]
  lines: CostLine[]
  /** Σ of this node's lines and every descendant's. */
  subtotalInr: number
  /** Σ counted items at and below this node. */
  itemCount: number
}

export interface CostSchedule {
  root: CostNode
  /** Flat view, for engines that have no hierarchy and for cost-line auditing. */
  allLines: CostLine[]
  grandTotalInr: number
  itemCount: number
  /** True when the engine produced real depth rather than a single flat level. */
  hierarchical: boolean
}

export interface QuantityEngineMeta {
  id: string
  summary: string
  portability: PortabilityClass
  license: string
  upstream?: string
}

export interface QuantityEngine {
  meta: QuantityEngineMeta
  /**
   * Build a schedule. `bindings` maps productId → priced binding, mirroring what
   * the app holds; an engine that ignores it will fail the cost-line gate.
   *
   * Returning null means "this engine cannot process this input" and scores as a
   * total miss — never a free pass.
   */
  schedule(
    state: DocState,
    bindings: Record<string, { productId: string; name?: string; priceInr?: number; supplier?: string }>,
  ): CostSchedule | null | Promise<CostSchedule | null>
}
