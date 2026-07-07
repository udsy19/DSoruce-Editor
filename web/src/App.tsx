import { useEffect, useRef, useState } from 'react'
import { EditorCanvas, DocComponent, Metrics } from './editor/EditorCanvas'
import { CATALOG } from './editor/catalog'
import { searchBank } from './materialBank/mock'

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ecRef = useRef<EditorCanvas | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const [tool, setTool] = useState('select')

  useEffect(() => {
    let inst: EditorCanvas | null = null
    let disposed = false
    EditorCanvas.create(canvasRef.current!).then((ec) => {
      if (disposed) {
        ec.dispose()
        return
      }
      inst = ec
      ecRef.current = ec
      ec.onChange = () => setTick((t) => t + 1)
      setReady(true)
    })
    return () => {
      disposed = true
      inst?.dispose()
    }
  }, [])

  const ec = ecRef.current
  const selected = ready && ec ? ec.getSelected() : null
  const metrics = ready && ec ? ec.getMetrics() : null

  const pickTool = (t: string) => {
    setTool(t)
    ec?.setTool(t)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          DSource <span>Editor</span>
        </div>
        <div className="toolbar">
          <button className={tool === 'select' ? 'tbtn active' : 'tbtn'} onClick={() => pickTool('select')}>
            Select
          </button>
          <button className={tool === 'wall' ? 'tbtn active' : 'tbtn'} onClick={() => pickTool('wall')}>
            Wall
          </button>
          <span className="divider" />
          {CATALOG.map((it) => (
            <button
              key={it.category}
              className={tool === `place:${it.category}` ? 'tbtn active' : 'tbtn'}
              onClick={() => pickTool(`place:${it.category}`)}
              title={`Place ${it.label}`}
            >
              <span className="emoji">{it.emoji}</span>
              {it.label}
            </button>
          ))}
        </div>
        <div className="hint">Wall: click to chain · Esc stop · Wheel zoom · Middle-drag pan · Del removes</div>
      </header>

      <div className="stage">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} />
          {!ready && <div className="loading">Loading Rust/Wasm core…</div>}
        </div>
        <aside className="panel">
          {selected && ec ? (
            <SelectionPanel ec={ec} c={selected} />
          ) : (
            <MetricsPanel m={metrics} />
          )}
        </aside>
      </div>

      <footer className="statusbar">
        {metrics
          ? `Floor ${metrics.floor_area.toFixed(1)} m²  ·  ${metrics.component_count} components  ·  ${metrics.confirmed} confirmed  ·  ${metrics.wall_count} walls`
          : 'Loading core…'}
      </footer>
    </div>
  )
}

const DECISIONS: { key: string; label: string }[] = [
  { key: 'Open', label: 'Open' },
  { key: 'InReview', label: 'In Review' },
  { key: 'Confirmed', label: 'Confirmed' },
]

function SelectionPanel({ ec, c }: { ec: EditorCanvas; c: DocComponent }) {
  const [q, setQ] = useState('')
  const results = searchBank(c.category, q)

  return (
    <div className="selpanel">
      <div className="sel-head">
        <span className="sel-cat">{c.category}</span>
        <span className="sel-label">{c.label}</span>
      </div>

      <div className="section-title">Decision</div>
      <div className="chip-row">
        {DECISIONS.map((d) => (
          <button
            key={d.key}
            className={c.decision === d.key ? 'chip active' : 'chip'}
            onClick={() => ec.setDecision(c.id, d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="section-title">Re-imagine — {c.category} options</div>
      <input
        className="search"
        placeholder={`Search ${c.category} bank…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="products">
        {results.length === 0 && <div className="empty">No matches in the (mock) bank.</div>}
        {results.map((p) => (
          <button
            key={p.id}
            className={c.product_id === p.id ? 'product active' : 'product'}
            onClick={() => ec.assignProduct(c.id, p.id, p.name)}
          >
            <span className="swatch" style={{ background: p.swatch }} />
            <span className="p-main">
              <span className="p-name">{p.name}</span>
              <span className="p-vendor">{p.vendor}</span>
            </span>
            <span className="p-price">${p.price.toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="mock-note">Mock material bank — the real searchable bank wires in here later.</div>
      <button className="danger" onClick={() => ec.deleteSelected()}>
        Delete component
      </button>
    </div>
  )
}

function MetricsPanel({ m }: { m: Metrics | null }) {
  return (
    <div className="metrics">
      <div className="section-title">Live metrics</div>
      <Stat label="Floor area" value={m ? `${m.floor_area.toFixed(1)} m²` : '—'} />
      <Stat label="Components" value={m ? String(m.component_count) : '—'} />
      <Stat label="Confirmed" value={m ? String(m.confirmed) : '—'} />
      <Stat label="Walls" value={m ? String(m.wall_count) : '—'} />
      <div className="empty-hint">
        Draw walls and place items from the toolbar, then select a component to re-imagine it from the
        material bank.
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}
