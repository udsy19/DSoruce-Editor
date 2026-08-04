// Presentational CAD layers panel — pure props, no store import. The host
// (App/EditorCanvas wiring) derives rows from CadStore.layers()/isVisible()/
// activeLayer + entity counts, and maps callbacks onto toggleLayer /
// setActiveLayer. "Adding" a layer is just making it active (a layer exists
// once an entity uses it OR it is the active layer), so onAdd typically calls
// store.setActiveLayer(name).
import { useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { MONO } from './type'

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

const S: Record<string, CSSProperties> = {
  card: {
    background: 'var(--surface, #ffffff)',
    border: '1px solid var(--hairline, #e6e8ec)',
    borderRadius: 10,
    padding: '10px 0 8px',
    fontFamily: '"Space Grotesk", sans-serif',
    color: 'var(--text, #1a1d21)',
    minWidth: 220,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--eyebrow, #6e7a84)',
    padding: '0 12px 8px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 12px',
    cursor: 'default',
  },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    border: 'none',
    background: 'transparent',
    borderRadius: 5,
    cursor: 'pointer',
    padding: 0,
    color: 'var(--text-2, #3a4048)',
  },
  radio: {
    width: 13,
    height: 13,
    borderRadius: '50%',
    border: '1.5px solid var(--hairline-strong, #d7dbe0)',
    background: 'var(--surface, #ffffff)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    flex: 'none',
  },
  name: {
    flex: 1,
    fontSize: 13,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  count: {
    fontFamily: `${MONO}`,
    fontSize: 11,
    color: 'var(--muted, #5c6670)',
  },
  addForm: {
    display: 'flex',
    gap: 6,
    padding: '8px 12px 2px',
    borderTop: '1px solid var(--hairline, #e6e8ec)',
    marginTop: 6,
  },
  addInput: {
    flex: 1,
    minWidth: 0,
    fontFamily: '"Space Grotesk", sans-serif',
    fontSize: 12.5,
    padding: '5px 8px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 6,
    background: 'var(--surface-2, #fbfcfd)',
    color: 'var(--text, #1a1d21)',
    outline: 'none',
  },
  addBtn: {
    fontFamily: '"Space Grotesk", sans-serif',
    fontSize: 12.5,
    fontWeight: 600,
    padding: '5px 10px',
    border: '1px solid var(--hairline-strong, #d7dbe0)',
    borderRadius: 6,
    background: 'var(--surface, #ffffff)',
    color: 'var(--text-2, #3a4048)',
    cursor: 'pointer',
  },
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
    <div data-testid="layers-panel" style={S.card}>
      <div style={S.eyebrow}>Layers</div>
      {layers.map((l) => (
        <div
          key={l.name}
          style={{
            ...S.row,
            background: l.active ? 'var(--accent-soft, #e8eefc)' : 'transparent',
            opacity: l.visible ? 1 : 0.55,
          }}
        >
          <button
            type="button"
            style={S.iconBtn}
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
            style={{
              ...S.radio,
              borderColor: l.active
                ? 'var(--accent, #2d5bd6)'
                : 'var(--hairline-strong, #d7dbe0)',
            }}
            onClick={() => onSetActive(l.name)}
          >
            {l.active && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: 'var(--accent, #2d5bd6)',
                }}
              />
            )}
          </button>
          <span
            style={{ ...S.name, fontWeight: l.active ? 600 : 400 }}
            title={l.name}
            onClick={() => onSetActive(l.name)}
          >
            {l.name}
          </span>
          <span style={S.count}>{l.count}</span>
        </div>
      ))}
      <form style={S.addForm} onSubmit={submit}>
        <input
          style={S.addInput}
          value={draft}
          placeholder="New layer…"
          aria-label="New layer name"
          onChange={(ev) => setDraft(ev.target.value)}
        />
        <button type="submit" style={S.addBtn}>
          Add
        </button>
      </form>
    </div>
  )
}
