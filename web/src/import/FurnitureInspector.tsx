import { useState } from 'react'
import type { FurnitureItem } from '../import/types'
import { bankCategoryForItem, searchOfficeBank, type OfficeProduct } from '../materialBank/office'

/**
 * Re-imagine panel for an *imported* furniture item: pick the real product it
 * should be bound to from the office material bank. Mirrors App.tsx's
 * `ReimaginePanel` markup/classes so it drops into the import inspector and
 * matches the generative editor's binding UI. Self-contained; the parent owns
 * persistence via `onBind`.
 */
export function FurnitureInspector({
  item,
  onBind,
}: {
  item: FurnitureItem
  onBind: (item: FurnitureItem, product: OfficeProduct) => void
}) {
  const [q, setQ] = useState('')
  const bankCategory = bankCategoryForItem(item)
  const results = searchOfficeBank(bankCategory, q)

  const w = item.bbox[2] - item.bbox[0]
  const h = item.bbox[3] - item.bbox[1]

  return (
    <div className="panel-body">
      <div className="sel-head">
        <div className="sel-title">
          <div className="sel-name">{item.name}</div>
          <div className="sel-cat">{item.category}</div>
        </div>
      </div>

      <div className="spec num">
        <span>
          {w.toFixed(2)} × {h.toFixed(2)} m
        </span>
      </div>

      {item.productName && (
        <div className="inline-note">Bound to {item.productName}.</div>
      )}

      <div className="panel-eyebrow gap">Re-imagine · {bankCategory}</div>
      <input
        className="search"
        placeholder="Search the material bank…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="products">
        {results.length === 0 && <div className="inline-note">No matches in the bank.</div>}
        {results.map((p) => (
          <button
            key={p.id}
            className={item.productId === p.id ? 'product on' : 'product'}
            onClick={() => onBind(item, p)}
          >
            <span className="swatch" style={{ background: p.swatch }} />
            <span className="p-main">
              <span className="p-name">{p.name}</span>
              <span className="p-vendor">{p.vendor}</span>
            </span>
            <span className="p-price num">${p.price.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
