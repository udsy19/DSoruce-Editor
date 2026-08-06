import { useState } from 'react'
import { formatINR } from '../materialBank/client'
import { Icon } from './icons'

/**
 * Materio-style "Plan by category" sidebar section. Purely presentational —
 * the orchestrator (App) computes the groups from the furniture schedule +
 * product bindings. Each category is a collapsible header row (name · rolled-up
 * ₹ total · chevron) over item rows (thumb · name · ×qty · ₹ price).
 *
 * Appearance lives in `styles.css` (`.catplan*`); state variants are class
 * modifiers (`.is-collapsed`, `.is-pickable`, `.is-empty`).
 */

export interface CategoryPlanItem {
  name: string
  qty: number
  /** Hidden when undefined; em-dash when null. */
  priceInr?: number | null
  image?: string | null
  /** Item is bound to a bank product (shown as a small canvas-bound dot). */
  bound?: boolean
}

export interface CategoryPlanGroup {
  category: string
  count: number
  totalInr: number | null
  items: CategoryPlanItem[]
}

export function CategoryPlan({
  groups,
  onPick,
  testId = 'category-plan',
}: {
  groups: CategoryPlanGroup[]
  onPick?: (itemName: string) => void
  /** Per-MOUNT testid. This component renders in two places at once — the Space
   *  step's bill of components and the editor's import panel — and the editor is
   *  kept mounted (hidden) behind the wizard, so a single hard-coded id put two
   *  `category-plan` nodes in the DOM and broke any strict `getByTestId`. */
  testId?: string
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (cat: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  return (
    <div data-testid={testId} className="catplan">
      <div className="catplan-eyebrow">Plan by category</div>
      {groups.map((g) => {
        const open = !collapsed.has(g.category)
        return (
          <div key={g.category} className="catplan-group">
            <button onClick={() => toggle(g.category)} aria-expanded={open} className="catplan-head">
              <span className="catplan-cat">{g.category}</span>
              <span className="catplan-count num">{g.count}</span>
              <span className="catplan-total num">{formatINR(g.totalInr)}</span>
              <span aria-hidden className={`catplan-chevron${open ? '' : ' is-collapsed'}`}>
                <Icon name="caret" size={13} />
              </span>
            </button>
            {open && (
              <div className="catplan-items">
                {g.items.map((it) => (
                  <button
                    key={it.name}
                    onClick={() => onPick?.(it.name)}
                    className={`catplan-item${onPick ? ' is-pickable' : ''}`}
                  >
                    {it.image ? (
                      <img src={it.image} alt="" loading="lazy" className="catplan-thumb" />
                    ) : (
                      <span aria-hidden className="catplan-thumb is-empty" />
                    )}
                    <span className="catplan-name">
                      {it.bound && <span aria-label="Bound to a product" className="catplan-bound-dot" />}
                      {it.name}
                    </span>
                    <span className="catplan-qty num">×{it.qty}</span>
                    {it.priceInr !== undefined && (
                      <span className="catplan-price num">{formatINR(it.priceInr)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
