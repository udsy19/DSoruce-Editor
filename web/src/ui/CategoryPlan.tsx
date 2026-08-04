import { useState, type CSSProperties } from 'react'
import { formatINR } from '../materialBank/client'
import { Icon } from './icons'

/**
 * Materio-style "Plan by category" sidebar section. Purely presentational —
 * the orchestrator (App) computes the groups from the furniture schedule +
 * product bindings. Each category is a collapsible header row (name · rolled-up
 * ₹ total · chevron) over item rows (thumb · name · ×qty · ₹ price).
 */

export interface CategoryPlanItem {
  name: string
  qty: number
  /** Hidden when undefined; em-dash when null. */
  priceInr?: number | null
  image?: string | null
  /** Item is bound to a bank product (shown as a small accent dot). */
  bound?: boolean
}

export interface CategoryPlanGroup {
  category: string
  count: number
  totalInr: number | null
  items: CategoryPlanItem[]
}

const MONO: CSSProperties = {
  fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
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
    <div
      data-testid={testId}
      style={{ fontFamily: '"Space Grotesk", system-ui, sans-serif' }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: '#7a828c',
          margin: '2px 0 6px',
        }}
      >
        Plan by category
      </div>
      {groups.map((g) => {
        const open = !collapsed.has(g.category)
        return (
          <div
            key={g.category}
            style={{
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 1px 3px rgba(24,30,40,0.08)',
              marginBottom: 8,
              overflow: 'hidden',
            }}
          >
            <button
              onClick={() => toggle(g.category)}
              aria-expanded={open}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#1e2329',
                  textTransform: 'capitalize',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {g.category}
              </span>
              <span style={{ ...MONO, fontSize: 10.5, color: '#9aa2ad' }}>{g.count}</span>
              <span
                style={{
                  ...MONO,
                  marginLeft: 'auto',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#1e2329',
                }}
              >
                {formatINR(g.totalInr)}
              </span>
              <span
                aria-hidden
                style={{
                  color: '#9aa2ad',
                  lineHeight: 0,
                  transform: open ? 'none' : 'rotate(-90deg)',
                  transition: 'transform 120ms ease',
                }}
              >
                <Icon name="caret" size={13} />
              </span>
            </button>
            {open && (
              <div style={{ padding: '0 6px 6px' }}>
                {g.items.map((it) => (
                  <button
                    key={it.name}
                    onClick={() => onPick?.(it.name)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '5px 6px',
                      border: 'none',
                      borderRadius: 8,
                      background: 'transparent',
                      cursor: onPick ? 'pointer' : 'default',
                      textAlign: 'left',
                      font: 'inherit',
                    }}
                  >
                    {it.image ? (
                      <img
                        src={it.image}
                        alt=""
                        loading="lazy"
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          objectFit: 'cover',
                          flex: 'none',
                          background: '#eef0f3',
                        }}
                      />
                    ) : (
                      <span
                        aria-hidden
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          flex: 'none',
                          background: '#e6e9ee',
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 12.5,
                        color: '#1e2329',
                        minWidth: 0,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {it.bound && (
                        <span
                          aria-label="Bound to a product"
                          style={{
                            display: 'inline-block',
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: 'var(--accent, #2d5bd6)',
                            marginRight: 6,
                            verticalAlign: 'middle',
                          }}
                        />
                      )}
                      {it.name}
                    </span>
                    <span style={{ ...MONO, fontSize: 11, color: '#9aa2ad', flex: 'none' }}>
                      ×{it.qty}
                    </span>
                    {it.priceInr !== undefined && (
                      <span
                        style={{
                          ...MONO,
                          fontSize: 11.5,
                          color: '#1e2329',
                          flex: 'none',
                          minWidth: 52,
                          textAlign: 'right',
                        }}
                      >
                        {formatINR(it.priceInr)}
                      </span>
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
