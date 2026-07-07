import { useEffect, useRef, useState } from 'react'
import {
  EditorCanvas,
  DocComponent,
  Metrics,
  Program,
  LayoutScore,
  CirculationScore,
  GenResult,
} from './editor/EditorCanvas'
import { CATALOG, catByCategory } from './editor/catalog'
import { searchBank } from './materialBank/mock'
import { Icon } from './ui/icons'
import { Scene3D } from './three/Scene3D'

// Full program sent to the Rust engine. The panel exposes a few fields; the rest
// are sensible defaults grounded in ADA/IBC clearances (see circulation.rs).
const DEFAULT_PROGRAM: Program = {
  desks: 20,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const scaleRef = useRef<HTMLSpanElement>(null)
  const ecRef = useRef<EditorCanvas | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const [tool, setTool] = useState('select')
  const [mode, setMode] = useState<'2d' | '3d'>('2d')

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
      ec.coordEl = coordRef.current
      ec.scaleEl = scaleRef.current
      ec.refresh()
      setReady(true)
    })
    return () => {
      disposed = true
      inst?.dispose()
    }
  }, [])

  // Repaint the 2D canvas when returning from 3D (it was display:none → 0-size).
  useEffect(() => {
    if (mode === '2d' && ready) ecRef.current?.refresh()
  }, [mode, ready])

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
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">DSOURCE</span>
          <span className="brand-doc">/ Untitled Plan</span>
        </div>
        <div className="topbar-right">
          <div className="mode-toggle" role="group" aria-label="View mode">
            <button className={mode === '2d' ? 'seg on' : 'seg'} onClick={() => setMode('2d')} data-testid="mode-2d">
              2D
            </button>
            <button className={mode === '3d' ? 'seg on' : 'seg'} onClick={() => setMode('3d')} data-testid="mode-3d">
              3D
            </button>
          </div>
        </div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Tools">
          <RailButton id="select" tool={tool} onClick={pickTool} icon="select" tip="Select" hint="V" />
          <RailButton id="wall" tool={tool} onClick={pickTool} icon="wall" tip="Wall" hint="W" />
          <div className="rail-sep" />
          {CATALOG.map((it) => (
            <RailButton
              key={it.category}
              id={`place:${it.category}`}
              tool={tool}
              onClick={pickTool}
              icon={it.icon}
              tip={it.label}
              hint={`${it.w} × ${it.h} m`}
              swatch={it.color}
            />
          ))}
        </nav>

        <main className="stage">
          <div className="canvas-wrap">
            <canvas ref={canvasRef} style={{ display: mode === '3d' ? 'none' : 'block' }} />
            {mode === '3d' && ready && ec && <Scene3D state={ec.getState()} />}
            {!ready && <div className="loading">Loading Rust · Wasm core…</div>}
          </div>
        </main>

        <aside className="inspector">
          {selected && ec ? (
            <ReimaginePanel ec={ec} c={selected} />
          ) : (
            <OverviewPanel ec={ec} metrics={metrics} />
          )}
        </aside>
      </div>

      <footer className="statusbar">
        <span className="sb-coord">
          <span className="sb-glyph">⌖</span>
          <span ref={coordRef} className="mono">
            x —  y —
          </span>
        </span>
        <span className="sb-dot" />
        <span className="mono muted" ref={scaleRef}>
          46 px/m
        </span>
        <span className="sb-spring" />
        <span className="mono sb-metrics">
          {metrics
            ? `${metrics.floor_area.toFixed(1)} m²  ·  ${metrics.component_count} items  ·  ${metrics.confirmed} confirmed`
            : '—'}
        </span>
      </footer>
    </div>
  )
}

function RailButton({
  id,
  tool,
  onClick,
  icon,
  tip,
  hint,
  swatch,
}: {
  id: string
  tool: string
  onClick: (t: string) => void
  icon: string
  tip: string
  hint?: string
  swatch?: string
}) {
  const active = tool === id
  return (
    <button
      className={active ? 'rail-btn on' : 'rail-btn'}
      onClick={() => onClick(id)}
      aria-pressed={active}
      data-testid={id}
    >
      <Icon name={icon} />
      {swatch && <span className="rail-swatch" style={{ background: swatch }} />}
      <span className="rail-tip">
        <span className="rail-tip-name">{tip}</span>
        {hint && <span className="rail-tip-hint mono">{hint}</span>}
      </span>
    </button>
  )
}

/* -------------------------------- Overview -------------------------------- */

function OverviewPanel({ ec, metrics }: { ec: EditorCanvas | null; metrics: Metrics | null }) {
  const [program, setProgram] = useState<Program>(DEFAULT_PROGRAM)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenResult | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const circ: CirculationScore | null =
    ec && metrics && metrics.wall_count > 0 ? ec.circulation() : null

  const set = (patch: Partial<Program>) => setProgram((p) => ({ ...p, ...patch }))

  const generate = () => {
    if (!ec) return
    if (ec.getState().walls.length === 0) {
      setNote('Draw a closed room boundary first, then generate.')
      return
    }
    setNote(null)
    setBusy(true)
    // Defer so the "Generating…" state paints before the synchronous search runs.
    window.setTimeout(() => {
      const res = ec.autoGenerate(program, { maxIter: 18, target: 82 })
      setResult(res)
      setBusy(false)
    }, 16)
  }

  return (
    <div className="panel-body">
      <div className="panel-eyebrow">Plan</div>

      <div className="schedule">
        <Row label="Floor area" value={metrics ? `${metrics.floor_area.toFixed(1)} m²` : '—'} />
        <Row label="Components" value={metrics ? String(metrics.component_count) : '—'} />
        <Row label="Confirmed" value={metrics ? String(metrics.confirmed) : '—'} />
        <Row label="Walls" value={metrics ? String(metrics.wall_count) : '—'} />
        {circ && (
          <>
            <Row label="Min corridor" value={`${circ.min_corridor_width.toFixed(2)} m`} />
            <Row label="Circulation" value={`${Math.round(circ.score)}/100`} />
          </>
        )}
      </div>

      <div className="panel-eyebrow gap">
        <Icon name="generate" size={13} /> Autonomous test-fit
      </div>
      <p className="panel-lead">
        Set the program. The engine searches layouts and keeps the best-scoring fit for your criteria.
      </p>

      <div className="field-grid">
        <NumberField label="Desks" value={program.desks} min={0} max={400}
          onChange={(v) => set({ desks: v })} />
        <NumberField label="Meeting rooms" value={program.meeting_rooms} min={0} max={40}
          onChange={(v) => set({ meeting_rooms: v })} />
      </div>
      <SliderField
        label="Target corridor"
        value={program.target_corridor_m}
        min={0.9}
        max={1.8}
        step={0.1}
        suffix="m"
        onChange={(v) => set({ target_corridor_m: v })}
      />

      <button className="cta" onClick={generate} disabled={busy} data-testid="generate">
        {busy ? 'Searching layouts…' : 'Generate test-fit'}
      </button>
      {note && <div className="inline-note">{note}</div>}

      {result && (
        <div className="score-card">
          <div className="score-head">
            <span className="score-total mono">{Math.round(result.best.total)}</span>
            <span className="score-of mono">/100</span>
            <span className="score-meta mono">
              {result.best.placed_desks} desks · {result.iterations} iterations
            </span>
          </div>
          <ScoreBar label="Capacity" v={result.best.capacity} />
          <ScoreBar label="Adjacency" v={result.best.adjacency} />
          <ScoreBar label="Circulation" v={result.best.circulation} />
          <ScoreBar label="Density" v={result.best.density} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------- Re-imagine ------------------------------- */

const DECISIONS: { key: string; label: string }[] = [
  { key: 'Open', label: 'Open' },
  { key: 'InReview', label: 'Review' },
  { key: 'Confirmed', label: 'Confirmed' },
]

function ReimaginePanel({ ec, c }: { ec: EditorCanvas; c: DocComponent }) {
  const [q, setQ] = useState('')
  const results = searchBank(c.category, q)
  const cat = catByCategory(c.category)

  return (
    <div className="panel-body">
      <div className="sel-head">
        <span className="sel-tag mono" style={{ color: cat?.color }}>
          #{String(c.id).padStart(2, '0')}
        </span>
        <div className="sel-title">
          <div className="sel-name">{c.label}</div>
          <div className="sel-cat">{cat?.label ?? c.category}</div>
        </div>
      </div>

      <div className="spec mono">
        <span>{c.w.toFixed(2)} × {c.h.toFixed(2)} m</span>
        <span className="spec-sep" />
        <span>{(c.w * c.h).toFixed(2)} m²</span>
      </div>

      <div className="panel-eyebrow gap">Decision</div>
      <div className="segmented">
        {DECISIONS.map((d) => (
          <button
            key={d.key}
            className={c.decision === d.key ? `seg on ${d.key}` : 'seg'}
            onClick={() => ec.setDecision(c.id, d.key)}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="panel-eyebrow gap">Re-imagine · {cat?.label ?? c.category}</div>
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
            className={c.product_id === p.id ? 'product on' : 'product'}
            onClick={() => ec.assignProduct(c.id, p.id, p.name)}
          >
            <span className="swatch" style={{ background: p.swatch }} />
            <span className="p-main">
              <span className="p-name">{p.name}</span>
              <span className="p-vendor">{p.vendor}</span>
            </span>
            <span className="p-price mono">${p.price.toLocaleString()}</span>
          </button>
        ))}
      </div>

      <div className="mock-note">Mock bank — the real searchable material bank connects here.</div>
      <button className="ghost-danger" onClick={() => ec.deleteSelected()}>
        Delete component
      </button>
    </div>
  )
}

/* -------------------------------- Fields ---------------------------------- */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value mono">{value}</span>
    </div>
  )
}

function ScoreBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </span>
      <span className="bar-val mono">{Math.round(v)}</span>
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="field-input mono"
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
      />
    </label>
  )
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="field slider-field">
      <span className="field-label">
        {label}
        <span className="field-value mono">
          {value.toFixed(1)}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </span>
      <input
        className="slider"
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function clamp(v: number, min: number, max: number) {
  return Number.isNaN(v) ? min : Math.max(min, Math.min(max, v))
}
