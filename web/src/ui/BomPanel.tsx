// The hierarchical BOM view — the ADR 0004 winner (`qto-native`) made visible.
//
// Structure follows the OpenConstructionERP grouping pattern pre-registered as
// this branch's UX reference: quantities grouped by Level → Room → Category with
// rolled-up subtotals, collapsible, totals at every node.
//
// The `level` dimension is real but DEGENERATE today — the document has no
// multi-storey concept — so the level row is shown for structural honesty rather
// than claimed as a feature (ADR 0004: level-correctness cannot be established on
// a single-floor fixture and must not be claimed from it).
//
// Prices come from the core (`price_inr`), never from the App bindings map.

import { useMemo, useState } from 'react'
import type { EditorCanvas } from '../editor/EditorCanvas'
import type { CostNode } from '../types/qto'

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

function Node({ node, depth }: { node: CostNode; depth: number }) {
  // Rooms open by default, categories closed: the useful default is "what is in
  // this plan", not "every line at once".
  const [open, setOpen] = useState(depth < 2)
  const hasChildren = node.children.length > 0 || node.lines.length > 0
  return (
    <div className="bom-node" style={{ marginLeft: depth === 0 ? 0 : 12 }}>
      <button
        type="button"
        className={`bom-row bom-row-${node.kind}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasChildren}
      >
        <span className="bom-caret">{hasChildren ? (open ? '▾' : '▸') : ''}</span>
        <span className="bom-label">{node.label}</span>
        <span className="bom-count num">{node.item_count}</span>
        <span className="bom-total num">{node.subtotal_inr > 0 ? inr(node.subtotal_inr) : '—'}</span>
      </button>
      {open && (
        <>
          {node.lines.map((l, i) => (
            <div className="bom-line" key={`${l.label}-${i}`} style={{ marginLeft: 12 * (depth + 1) }}>
              <span className="bom-label">{l.label}</span>
              <span className="bom-qty num">
                {l.quantity}
                <span className="unit"> {l.quantity_kind === 'count' ? 'no.' : l.quantity_kind}</span>
              </span>
              <span className="bom-area num">{l.area_m2 > 0 ? `${l.area_m2.toFixed(1)} m²` : ''}</span>
              {/* Unpriced is shown as an em dash, never as ₹0 — a bound product
                  with no price and a free product are different facts. */}
              <span className="bom-total num">{l.total_inr != null ? inr(l.total_inr) : '—'}</span>
            </div>
          ))}
          {node.children.map((c, i) => (
            <Node node={c} depth={depth + 1} key={`${c.label}-${i}`} />
          ))}
        </>
      )}
    </div>
  )
}

export function BomPanel({ ec }: { ec: EditorCanvas }) {
  // Recomputed per render off the core's revision-memoised read path; the core
  // rollup runs in well under a millisecond, so there is nothing to cache here.
  const schedule = useMemo(() => ec.getQtoSchedule(), [ec, ec.getState()])

  if (!schedule) {
    return <p className="bom-empty">Quantity schedule unavailable — rebuild the wasm core.</p>
  }
  const priced = schedule.all_lines.filter((l) => l.total_inr != null).length
  return (
    <div className="bom-panel" data-testid="bom-panel">
      <div className="bom-head">
        <span className="bom-label">Item</span>
        <span className="bom-count num">Qty</span>
        <span className="bom-total num">Cost</span>
      </div>
      <Node node={schedule.root} depth={0} />
      <div className="bom-foot">
        <div>
          <strong className="num">{schedule.item_count}</strong> items ·{' '}
          <strong className="num">{priced}</strong> priced
        </div>
        <div className="num">{inr(schedule.grand_total_inr)}</div>
      </div>
      {schedule.unassigned_items > 0 && (
        <p className="bom-note">
          {schedule.unassigned_items} item{schedule.unassigned_items === 1 ? '' : 's'} sit in no
          room and are grouped under “Unassigned” — surfaced rather than folded into a room they
          are not in.
        </p>
      )}
      <p className="bom-note">
        Grouped Level → Room → Category. One level today; multi-storey documents will nest here.
      </p>
    </div>
  )
}
