/**
 * THE PLAN'S HEADLINE COUNT — how many elements this drawing contains, and how
 * many of them are specified.
 *
 * The number existed already, but only in the status bar, at 11px, third in a
 * run of three: `930.0 m² · 268 items · 0 confirmed`. That is a read-out, not
 * an answer to "how big is this fit-out". This block puts the count where the
 * eye lands first in the inspector and gives it the two facts that make it mean
 * something: what the elements ARE (the category mix) and how far the plan has
 * been specified against the product bank.
 *
 * EVERY number here is read from the core — `Editor.metrics()` for the totals,
 * `Editor.state()` for the mix and the binding count. Nothing is derived twice:
 * the count is `metrics.component_count`, the same field the status bar and the
 * exports read, so three surfaces cannot disagree.
 */
import type { EditorCanvas } from '../editor/EditorCanvas'
import { intFmt } from '../editor/stats'
import { isGroundZone } from '../types/doc'
import { catByCategory } from '../editor/catalog'

/** How many category rows fit before the tail is rolled into "+n more". */
const SHOWN_CATEGORIES = 6

export function PlanTotals({ ec }: { ec: EditorCanvas }) {
  const m = ec.getMetrics()
  const state = ec.getState()
  const components = state.components ?? []
  const total = m.component_count ?? components.length
  if (total === 0) return null

  const specified = components.filter((c) => c.product_id).length
  // Imported CAD furniture is drawn for context and counted in the total, but it
  // is not part of the fit-out you would buy (`Component::reference`). Naming it
  // is why the headline count can be trusted against the BOM's smaller one.
  const reference = components.filter((c) => c.reference).length
  const rooms = (state.zones ?? []).filter((z) => !isGroundZone(z.zone_type)).length
  const specPct = total > 0 ? (specified / total) * 100 : 0

  const byCat = new Map<string, number>()
  for (const c of components) byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1)
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1])
  const head = cats.slice(0, SHOWN_CATEGORIES)
  const tail = cats.slice(SHOWN_CATEGORIES).reduce((s, [, n]) => s + n, 0)

  return (
    <section className="totals" data-testid="plan-totals">
      <div className="totals-head">
        <div className="totals-main">
          <div className="totals-eyebrow">Elements in plan</div>
          <div className="totals-count num" data-testid="plan-total-count">
            {intFmt(total)}
          </div>
        </div>
        <div className="totals-side">
          <div className="totals-side-val num">{intFmt(specified)}</div>
          <div className="totals-side-label">specified</div>
        </div>
      </div>

      <div className="totals-bar" aria-hidden>
        {/* Rendered only once something IS bound, so the track can carry a
            minimum fill width — one binding out of 269 is 0.37% of the bar and
            would otherwise be a sub-pixel nothing. */}
        {specified > 0 && <span className="totals-bar-fill" style={{ width: `${specPct}%` }} />}
      </div>
      {/* A COUNT, not a percentage. The first product bound to a 269-element plan
          is 0.37% and rounded to "0% bound" while the tile beside it read "1
          specified" — two true numbers that contradict each other on screen.
          The fraction cannot round away the first binding. */}
      <div className="totals-bar-legend">
        <span className="num">{intFmt(specified)}</span> of{' '}
        <span className="num">{intFmt(total)}</span> bound to a bank product
        {reference > 0 && (
          <>
            {' · '}
            <span className="num">{intFmt(reference)}</span> imported as context
          </>
        )}
      </div>

      <div className="totals-mix">
        {head.map(([cat, n]) => {
          // The dot carries the SAME colour the component catalogue gives that
          // category — a swatch and its geometry must agree by construction.
          const item = catByCategory(cat)
          return (
            <span className="totals-pill" key={cat}>
              <span className="totals-dot" style={item ? { background: item.color } : undefined} />
              {item?.label ?? cat}
              <span className="num">{intFmt(n)}</span>
            </span>
          )
        })}
        {tail > 0 && (
          <span className="totals-pill is-more">
            <span className="num">+{intFmt(tail)}</span> more
          </span>
        )}
      </div>

      <div className="totals-foot">
        <TotalsFact value={intFmt(rooms)} label="rooms" />
        <TotalsFact value={intFmt(m.wall_count ?? 0)} label="walls" />
        <TotalsFact value={intFmt(m.net_internal_area ?? m.floor_area ?? 0)} label="m² NIA" />
      </div>
    </section>
  )
}

function TotalsFact({ value, label }: { value: string; label: string }) {
  return (
    <span className="totals-fact">
      <span className="totals-fact-val num">{value}</span>
      <span className="totals-fact-label">{label}</span>
    </span>
  )
}
