// Presentational "place furniture" palette for an IMPORTED plan — the sibling
// affordance to the generative editor's component rail. Lists placeable specs
// derived from the office material bank (`materialBank/office.ts`) grouped by
// bank-category, plus a free-form custom row. Pure props: the orchestrator
// maps `onPlace` onto `DrawingCanvas.beginPlace(spec)`; this component owns no
// canvas or drawing state. Design language matches LayersPanel/ImportPanel
// (Space Grotesk UI, IBM Plex Mono numerics, CSS-var surfaces).
import { useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { PlaceSpec } from './DrawingCanvas'
import { BANK_FOOTPRINT, searchOfficeBank, type BankCategory } from '../materialBank/office'

const MONO = '"IBM Plex Mono", ui-monospace, monospace'

const S: Record<string, CSSProperties> = {
  card: {
    background: 'var(--surface, #ffffff)',
    border: '1px solid var(--hairline, #e6e8ec)',
    borderRadius: 10,
    padding: '10px 0 8px',
    fontFamily: '"Space Grotesk", sans-serif',
    color: 'var(--text, #1a1d21)',
    marginTop: 10,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--eyebrow, #6e7a84)',
    padding: '0 12px 6px',
  },
  hint: {
    fontSize: 11.5,
    color: 'var(--muted, #5c6670)',
    padding: '0 12px 8px',
    lineHeight: 1.45,
  },
  group: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    background: 'transparent',
    padding: '6px 12px',
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--text-2, #3a4048)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  chev: {
    fontSize: 9,
    color: 'var(--muted, #5c6670)',
    width: 10,
    flex: 'none',
  },
  count: {
    marginLeft: 'auto',
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 400,
    color: 'var(--muted, #5c6670)',
  },
  item: {
    width: '100%',
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    border: 'none',
    background: 'transparent',
    padding: '4px 12px 4px 28px',
    fontFamily: 'inherit',
    fontSize: 12.5,
    color: 'var(--text, #1a1d21)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  itemName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dims: {
    fontFamily: MONO,
    fontSize: 11,
    color: 'var(--muted, #5c6670)',
    flex: 'none',
  },
  plus: {
    color: 'var(--accent, #2d5bd6)',
    fontWeight: 700,
    fontSize: 13,
    flex: 'none',
    lineHeight: 1,
  },
  customForm: {
    display: 'flex',
    gap: 6,
    padding: '8px 12px 2px',
    borderTop: '1px solid var(--hairline, #e6e8ec)',
    marginTop: 6,
    alignItems: 'center',
  },
  input: {
    fontFamily: '"Space Grotesk", sans-serif',
    fontSize: 12.5,
    padding: '5px 8px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 6,
    background: 'var(--surface-2, #fbfcfd)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
    minWidth: 0,
  },
  numInput: {
    fontFamily: MONO,
    fontSize: 11.5,
    width: 48,
    flex: 'none',
  },
  placeBtn: {
    fontFamily: '"Space Grotesk", sans-serif',
    fontSize: 12.5,
    fontWeight: 600,
    padding: '5px 10px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 6,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text-2, #3a4048)',
    cursor: 'pointer',
    flex: 'none',
  },
}

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
    <div data-testid="place-palette" style={S.card}>
      <div style={S.eyebrow}>Place furniture</div>
      <div style={S.hint}>
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
              style={S.group}
              onClick={() => toggle(cat)}
              aria-expanded={isOpen}
              data-testid={`place-group-${cat}`}
            >
              <span style={S.chev}>{isOpen ? '▾' : '▸'}</span>
              {catLabel(cat)}
              <span style={S.count}>{products.length}</span>
            </button>
            {isOpen &&
              products.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  style={S.item}
                  title={`${p.vendor} — place ${fw.toFixed(2)} × ${fh.toFixed(2)} m`}
                  data-testid="place-item"
                  onClick={() => onPlace({ name: p.name, category: cat, w: fw, h: fh })}
                >
                  <span style={S.itemName}>{p.name}</span>
                  <span style={S.dims}>
                    {fw.toFixed(2)} × {fh.toFixed(2)} m
                  </span>
                  <span style={S.plus} aria-hidden>
                    +
                  </span>
                </button>
              ))}
          </div>
        )
      })}
      <form style={S.customForm} onSubmit={submitCustom} data-testid="place-custom">
        <input
          style={{ ...S.input, flex: 1 }}
          value={name}
          placeholder="Custom item…"
          aria-label="Custom item name"
          onChange={(ev) => setName(ev.target.value)}
        />
        <input
          style={{ ...S.input, ...S.numInput }}
          value={w}
          aria-label="Width (m)"
          onChange={(ev) => setW(ev.target.value)}
        />
        <span style={S.dims}>×</span>
        <input
          style={{ ...S.input, ...S.numInput }}
          value={h}
          aria-label="Depth (m)"
          onChange={(ev) => setH(ev.target.value)}
        />
        <button type="submit" style={S.placeBtn}>
          Place
        </button>
      </form>
    </div>
  )
}
