// Presentational CAD layers panel — pure props, no store import. The host
// (App/EditorCanvas wiring) derives rows from CadStore.layers()/isVisible()/
// activeLayer + entity counts, and maps callbacks onto toggleLayer /
// setActiveLayer. "Adding" a layer is just making it active (a layer exists
// once an entity uses it OR it is the active layer), so onAdd typically calls
// store.setActiveLayer(name).
import { useState } from 'react'
import type { FormEvent } from 'react'

export interface LayerRow {
  name: string
  /** entities currently on this layer */
  count: number
  visible: boolean
  active: boolean
}

export interface LayersPanelProps {
  layers: LayerRow[]
  /** flip a layer's visibility */
  onToggle: (name: string) => void
  /** make a layer the active (drawing) layer */
  onSetActive: (name: string) => void
  /** create a new layer and make it active */
  onAdd: (name: string) => void
}


function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {open ? (
        <>
          <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
          <circle cx={12} cy={12} r={3} />
        </>
      ) : (
        <>
          <path d="M3 4l18 16" />
          <path d="M10.6 5.7A11 11 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.2 3.8M6.6 7.5A16.3 16.3 0 0 0 2 12s3.5 6.5 10 6.5c1.4 0 2.7-.3 3.8-.8" />
        </>
      )}
    </svg>
  )
}

export function LayersPanel({ layers, onToggle, onSetActive, onAdd }: LayersPanelProps) {
  const [draft, setDraft] = useState('')

  function submit(ev: FormEvent) {
    ev.preventDefault()
    const name = draft.trim()
    if (!name) return
    // A layer that already exists just becomes active.
    if (layers.some((l) => l.name === name)) onSetActive(name)
    else onAdd(name)
    setDraft('')
  }

  return (
    <div data-testid="layers-panel" className="layers-card">
      <div className="layers-eyebrow">Layers</div>
      {layers.map((l) => (
        <div
          key={l.name}
          className={`layers-row${l.active ? ' is-active' : ''}${l.visible ? '' : ' is-hidden'}`}
        >
          <button
            type="button"
            className="layers-icon-btn"
            title={l.visible ? `Hide layer ${l.name}` : `Show layer ${l.name}`}
            aria-label={l.visible ? `Hide layer ${l.name}` : `Show layer ${l.name}`}
            aria-pressed={l.visible}
            onClick={() => onToggle(l.name)}
          >
            <EyeIcon open={l.visible} />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={l.active}
            title={`Draw on layer ${l.name}`}
            className={`layers-radio${l.active ? ' is-active' : ''}`}
            onClick={() => onSetActive(l.name)}
          >
            {l.active && (
              <span className="layers-radio-dot" />
            )}
          </button>
          <span
            className={`layers-name${l.active ? ' is-active' : ''}`}
            title={l.name}
            onClick={() => onSetActive(l.name)}
          >
            {l.name}
          </span>
          <span className="layers-count num">{l.count}</span>
        </div>
      ))}
      <form className="layers-add-form" onSubmit={submit}>
        <input
          className="layers-add-input"
          value={draft}
          placeholder="New layer…"
          aria-label="New layer name"
          onChange={(ev) => setDraft(ev.target.value)}
        />
        <button type="submit" className="layers-add-btn">
          Add
        </button>
      </form>
    </div>
  )
}
