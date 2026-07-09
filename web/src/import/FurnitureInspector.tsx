import { useEffect, useState } from 'react'
import type { FurnitureItem } from '../import/types'
import { bankCategoryForItem, searchOfficeBank, type OfficeProduct } from '../materialBank/office'
import { searchBankLive, formatINR, type BankProduct } from '../materialBank/client'

/**
 * Re-imagine panel for an *imported* furniture item: pick the real product it
 * should be bound to. Searches the LIVE material bank first — the imported
 * item's real product name (e.g. "Steelcase Seating SILQ Task Chair") makes an
 * excellent semantic query — and falls back to the local office bank offline.
 * Mirrors App.tsx's `ReimaginePanel` markup/classes; the parent owns
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
  const [live, setLive] = useState<BankProduct[] | null>(null)
  const [bankUp, setBankUp] = useState(true)
  const bankCategory = bankCategoryForItem(item)
  const results = searchOfficeBank(bankCategory, q)

  useEffect(() => {
    let cancelled = false
    const query = q.trim() || item.name
    const t = window.setTimeout(
      () => {
        searchBankLive(query)
          .then((r) => {
            if (!cancelled) {
              setLive(r)
              setBankUp(true)
            }
          })
          .catch(() => {
            if (!cancelled) {
              setLive(null)
              setBankUp(false)
            }
          })
      },
      q ? 250 : 0,
    )
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q, item])

  const w = item.bbox[2] - item.bbox[0]
  const h = item.bbox[3] - item.bbox[1]

  /** Live bank hit → the OfficeProduct shape the parent's onBind expects. */
  const asOfficeProduct = (p: BankProduct): OfficeProduct => ({
    id: p.id,
    name: p.name,
    vendor: p.vendor,
    price: p.price ?? 0,
    swatch: '#dfe3e8',
    image: p.image,
    supplier: p.supplier,
  })

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
        {live && live.length === 0 && <div className="inline-note">No matches in the bank.</div>}
        {live?.map((p) => (
          <button
            key={p.id}
            className={item.productId === p.id ? 'product on' : 'product'}
            onClick={() => onBind(item, asOfficeProduct(p))}
            title={p.supplier}
          >
            {p.image ? (
              <img className="p-thumb" src={p.image} alt="" loading="lazy" />
            ) : (
              <span className="swatch" style={{ background: '#dfe3e8' }} />
            )}
            <span className="p-main">
              <span className="p-name">{p.name}</span>
              <span className="p-vendor">
                {p.vendor}
                {p.supplier ? ` · ${p.supplier}` : ''}
              </span>
            </span>
            <span className="p-price num">{formatINR(p.price)}</span>
          </button>
        ))}
        {!live && results.length === 0 && (
          <div className="inline-note">No matches in the bank.</div>
        )}
        {!live &&
          results.map((p) => (
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
      {!bankUp && <div className="mock-note">Bank offline — showing local samples.</div>}
    </div>
  )
}
