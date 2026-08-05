// Presentational "place furniture" palette for an IMPORTED plan — the sibling
// affordance to the generative editor's component rail. Lists placeable specs
// derived from the office material bank (`materialBank/office.ts`) grouped by
// bank-category, plus a free-form custom row. Pure props: the orchestrator
// maps `onPlace` onto `DrawingCanvas.beginPlace(spec)`; this component owns no
// canvas or drawing state. Design language matches LayersPanel/ImportPanel
// (UI face for labels, the numeric face for sizes, CSS-var surfaces).
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { PlaceSpec } from './DrawingCanvas'
import { BANK_FOOTPRINT, searchOfficeBank, type BankCategory } from '../materialBank/office'



/** 'task-chair' → 'Task chair'. */
function catLabel(c: string): string {
  const s = c.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function PlacePalette({ onPlace }: { onPlace: (spec: PlaceSpec) => void }) {
  // Groups default collapsed — the palette stays a compact section until the
  // user reaches for a bucket.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [w, setW] = useState('0.8')
  const [h, setH] = useState('0.8')

  const toggle = (cat: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  const submitCustom = (ev: FormEvent) => {
    ev.preventDefault()
    const wNum = parseFloat(w)
    const hNum = parseFloat(h)
    if (!(wNum > 0) || !(hNum > 0)) return
    onPlace({ name: name.trim() || 'Custom item', category: 'furniture', w: wNum, h: hNum })
  }

  return (
    <div data-testid="place-palette" className="place-card">
      <div className="place-eyebrow">Place furniture</div>
      <div className="place-hint">
        Pick an item, then click the plan to stamp it — R rotates, Esc exits.
      </div>
      {(Object.keys(BANK_FOOTPRINT) as BankCategory[]).map((cat) => {
        const products = searchOfficeBank(cat, '')
        const [fw, fh] = BANK_FOOTPRINT[cat]
        const isOpen = open.has(cat)
        return (
          <div key={cat}>
            <button
              type="button"
              className="place-group"
              onClick={() => toggle(cat)}
              aria-expanded={isOpen}
              data-testid={`place-group-${cat}`}
            >
              <span className="place-chev">{isOpen ? '▾' : '▸'}</span>
              {catLabel(cat)}
              <span className="place-count num">{products.length}</span>
            </button>
            {isOpen &&
              products.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="place-item"
                  title={`${p.vendor} — place ${fw.toFixed(2)} × ${fh.toFixed(2)} m`}
                  data-testid="place-item"
                  onClick={() => onPlace({ name: p.name, category: cat, w: fw, h: fh })}
                >
                  <span className="place-item-name">{p.name}</span>
                  <span className="place-dims num">
                    {fw.toFixed(2)} × {fh.toFixed(2)} m
                  </span>
                  <span className="place-plus" aria-hidden>
                    +
                  </span>
                </button>
              ))}
          </div>
        )
      })}
      <form className="place-custom-form" onSubmit={submitCustom} data-testid="place-custom">
        <input
          className="place-input"
          value={name}
          placeholder="Custom item…"
          aria-label="Custom item name"
          onChange={(ev) => setName(ev.target.value)}
        />
        <input
          className="place-input is-num num"
          value={w}
          aria-label="Width (m)"
          onChange={(ev) => setW(ev.target.value)}
        />
        <span className="place-dims num">×</span>
        <input
          className="place-input is-num num"
          value={h}
          aria-label="Depth (m)"
          onChange={(ev) => setH(ev.target.value)}
        />
        <button type="submit" className="place-btn">
          Place
        </button>
      </form>
    </div>
  )
}
