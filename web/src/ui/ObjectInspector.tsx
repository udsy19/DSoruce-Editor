import { useState } from 'react'
import { EditorCanvas, SelectedInfo } from '../editor/EditorCanvas'
import { CATALOG, catByCategory } from '../editor/catalog'

const DEG = 180 / Math.PI

/**
 * Context-sensitive object inspector (Rayon-parity M3). Mirrors the selected
 * object's geometry as editable numeric fields (commit on blur / Enter through
 * `ec.updateSelected`); when nothing is selected it shows canvas/model props.
 * Reads live from `ec.selectedInfo()`, so it repaints whenever the editor ticks
 * React on selection / edit.
 */
export function ObjectInspector({ ec }: { ec: EditorCanvas }) {
  const info = ec.selectedInfo()
  if (info?.kind === 'component') return <ComponentProps ec={ec} c={info} />
  if (info?.kind === 'wall') return <WallProps info={info} />
  return <CanvasProps ec={ec} />
}

/* ------------------------------ selected object --------------------------- */

function ComponentProps({
  ec,
  c,
}: {
  ec: EditorCanvas
  c: Extract<SelectedInfo, { kind: 'component' }>
}) {
  const cat = catByCategory(c.category)
  const known = !!cat
  return (
    <div className="panel-body" data-testid="object-inspector">
      <div className="sel-head">
        <span className="sel-tag num" style={{ color: cat?.color }}>
          #{String(c.id).padStart(2, '0')}
        </span>
        <div className="sel-title">
          <div className="sel-name">{c.label}</div>
          <div className="sel-cat">{cat?.label ?? c.category} · geometry</div>
        </div>
      </div>

      <div className="panel-eyebrow">Position · m</div>
      <div className="field-grid">
        <PropNumber label="X" testid="obj-prop-x" value={c.x} onCommit={(v) => ec.updateSelected({ x: v })} />
        <PropNumber label="Y" testid="obj-prop-y" value={c.y} onCommit={(v) => ec.updateSelected({ y: v })} />
      </div>

      <div className="panel-eyebrow gap">Size · m</div>
      <div className="field-grid">
        <PropNumber label="W" testid="obj-prop-w" value={c.w} onCommit={(v) => ec.updateSelected({ w: v })} />
        <PropNumber label="H" testid="obj-prop-h" value={c.h} onCommit={(v) => ec.updateSelected({ h: v })} />
      </div>

      <div className="panel-eyebrow gap">Orientation & type</div>
      <div className="field-grid">
        <PropNumber
          label="Rotation °"
          testid="obj-prop-rot"
          value={c.rotation * DEG}
          decimals={0}
          onCommit={(v) => ec.updateSelected({ rotation: v / DEG })}
        />
        <label className="field">
          <span className="field-label">Category</span>
          <select
            className="field-input"
            data-testid="obj-prop-category"
            value={c.category}
            onChange={(e) => ec.updateSelected({ category: e.target.value })}
          >
            {CATALOG.map((it) => (
              <option key={it.category} value={it.category}>
                {it.label}
              </option>
            ))}
            {!known && <option value={c.category}>{c.category}</option>}
          </select>
        </label>
      </div>

      <div className="metric-row">
        <span className="label">Area</span>
        <span className="value num">
          {(c.w * c.h).toFixed(2)}
          <span className="unit">m²</span>
        </span>
      </div>
    </div>
  )
}

/* ----------------------------- selected wall ------------------------------ */

function WallProps({ info }: { info: Extract<SelectedInfo, { kind: 'wall' }> }) {
  return (
    <div className="panel-body" data-testid="object-inspector">
      <div className="panel-eyebrow">Wall geometry</div>
      <div className="metric-row">
        <span className="label">Length</span>
        <span className="value num">
          {info.length.toFixed(2)}
          <span className="unit">m</span>
        </span>
      </div>
      <div className="metric-row">
        <span className="label">Thickness</span>
        <span className="value num">
          {info.thickness.toFixed(2)}
          <span className="unit">m</span>
        </span>
      </div>
      <div className="metric-row">
        <span className="label">Start</span>
        <span className="value num">
          {info.a.x.toFixed(1)}, {info.a.y.toFixed(1)}
        </span>
      </div>
      <div className="metric-row">
        <span className="label">End</span>
        <span className="value num">
          {info.b.x.toFixed(1)}, {info.b.y.toFixed(1)}
        </span>
      </div>
    </div>
  )
}

/* ---------------------------- canvas / model ------------------------------ */

/**
 * Nothing selected → the one canvas control that actually does something.
 *
 * This card used to list Units / Grid / Axis / Background as four "settings"
 * rows that were pure read-outs of hard-coded constants, followed by a sentence
 * admitting it: "…the rest are display-only until per-canvas settings land."
 * Four inert controls plus an apology for them. A control that does nothing is
 * worse than an absent one — it costs the user a click and their trust — so they
 * are gone (no-bloat §2), leaving Presentation, which works.
 */
function CanvasProps({ ec }: { ec: EditorCanvas }) {
  return (
    <div className="panel-body" data-testid="canvas-props">
      <div className="panel-eyebrow">Drawing</div>
      <div className="metric-row">
        <span className="label">
          Presentation
          <span className="row-hint">Swap the plan for a paper sheet</span>
        </span>
        <button
          className={ec.presentation ? 'seg on' : 'seg'}
          data-testid="canvas-presentation"
          aria-pressed={ec.presentation}
          onClick={() => ec.setPresentation(!ec.presentation)}
        >
          {ec.presentation ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  )
}

/* -------------------------------- fields ---------------------------------- */

/**
 * Numeric field that shows the live model value but lets the user type freely,
 * committing on blur / Enter. When the model value changes elsewhere (a drag on
 * the canvas), the field re-syncs because `draft` is cleared after each commit
 * and the shown value falls back to the prop.
 */
function PropNumber({
  label,
  value,
  testid,
  decimals = 2,
  onCommit,
}: {
  label: string
  value: number
  testid: string
  decimals?: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? value.toFixed(decimals)
  const commit = () => {
    if (draft === null) return
    const n = Number(draft)
    setDraft(null)
    if (!Number.isNaN(n) && n !== value) onCommit(n)
  }
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="field-input num"
        type="number"
        step={decimals === 0 ? 1 : 0.1}
        data-testid={testid}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </label>
  )
}
