import { useEffect, useRef, useState } from 'react'
import { EditorCanvas, DocComponent, Metrics, Program, GenResult } from './editor/EditorCanvas'
import { CATALOG, catByCategory } from './editor/catalog'
import { searchBank } from './materialBank/mock'
import { Icon } from './ui/icons'
import { StatsPanel } from './ui/StatsPanel'
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
      if (import.meta.env.DEV) (window as unknown as { __ec: EditorCanvas }).__ec = ec
      setReady(true)
    })
    return () => {
      disposed = true
      inst?.dispose()
    }
  }, [])

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
          <ExportMenu ec={ec} />
        </div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Tools">
          <span className="rail-avatar" aria-hidden />
          <div className="rail-sep" />
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
          <span className="rail-spring" />
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
          ) : ec ? (
            <>
              <StatsPanel ec={ec} />
              <GenerateCard ec={ec} metrics={metrics} />
            </>
          ) : null}
        </aside>
      </div>

      <footer className="statusbar">
        <span className="sb-coord">
          <span className="sb-glyph">⌖</span>
          <span ref={coordRef} className="num">
            x —  y —
          </span>
        </span>
        <span className="sb-dot" />
        <span className="num muted" ref={scaleRef}>
          46 px/m
        </span>
        <span className="sb-spring" />
        <span className="num sb-metrics">
          {metrics
            ? `${metrics.floor_area.toFixed(1)} m²  ·  ${metrics.component_count} items  ·  ${metrics.confirmed} confirmed`
            : '—'}
        </span>
      </footer>
    </div>
  )
}

function ExportMenu({ ec }: { ec: EditorCanvas | null }) {
  const [open, setOpen] = useState(false)

  const exportCSV = () => {
    if (!ec) return
    const m = ec.getMetrics()
    const zs = ec.getZoneStats()
    const rows = [
      'metric,value',
      `gross_external_area_m2,${(m.gross_external_area ?? 0).toFixed(2)}`,
      `net_internal_area_m2,${(m.net_internal_area ?? 0).toFixed(2)}`,
      `workstations,${m.workstations ?? 0}`,
      `area_per_workstation_m2,${(m.area_per_workstation ?? 0).toFixed(2)}`,
      `efficiency_pct,${(m.efficiency_pct ?? 0).toFixed(1)}`,
      `indicative_cost,${Math.round(m.indicative_cost ?? 0)}`,
      `indicative_carbon_kgco2e,${Math.round(m.indicative_carbon ?? 0)}`,
      '',
      'zone_id,zone_type,label,area_m2,capacity,seated,pct_of_nia',
      ...zs.map(
        (z) =>
          `${z.id},${z.zone_type},"${z.label}",${z.area.toFixed(2)},${z.capacity},${z.seated},${z.pct_of_nia.toFixed(1)}`,
      ),
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'dsource-plan.csv'
    a.click()
    URL.revokeObjectURL(url)
    setOpen(false)
  }

  return (
    <div className="export">
      <button className="export-btn" onClick={() => setOpen((o) => !o)} data-testid="export-btn">
        Export <Icon name="caret" size={13} />
      </button>
      {open && (
        <div className="export-menu">
          <div className="export-item" onClick={exportCSV} data-testid="export-csv">
            Export CSV
          </div>
          <div className="export-item">
            Export PDF <span className="hint">soon</span>
          </div>
          <div className="export-sep" />
          <div className="export-item">
            Export 2D <span className="hint">DWG · DXF</span>
          </div>
          <div className="export-item">
            Export 3D <span className="hint">IFC · OBJ · RVT</span>
          </div>
          <div className="export-sep" />
          <div className="export-item">
            Share… <span className="hint">soon</span>
          </div>
        </div>
      )}
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
        {hint && <span className="rail-tip-hint num">{hint}</span>}
      </span>
    </button>
  )
}

/* ---------------------------- Autonomous test-fit -------------------------- */

function GenerateCard({ ec, metrics }: { ec: EditorCanvas; metrics: Metrics | null }) {
  const [program, setProgram] = useState<Program>(DEFAULT_PROGRAM)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenResult | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const set = (patch: Partial<Program>) => setProgram((p) => ({ ...p, ...patch }))
  const confirmed = metrics?.confirmed ?? 0

  const run = (keepConfirmed: boolean) => {
    if (ec.getState().walls.length === 0) {
      setNote('Draw a closed room boundary first, then generate.')
      return
    }
    setNote(null)
    setBusy(true)
    window.setTimeout(() => {
      const res = ec.autoGenerate(program, { maxIter: 18, target: 82, keepConfirmed })
      setResult(res)
      setBusy(false)
    }, 16)
  }

  return (
    <div className="panel-body" style={{ borderTop: '1px solid var(--hairline)' }}>
      <div className="panel-eyebrow">
        <Icon name="sparkles" size={13} /> Autonomous test-fit
      </div>
      <p className="panel-lead">
        Set the program. The engine searches layouts and keeps the best-scoring fit for your criteria.
      </p>

      <div className="field-grid">
        <NumberField label="Desks" value={program.desks} min={0} max={400} onChange={(v) => set({ desks: v })} />
        <NumberField
          label="Meeting rooms"
          value={program.meeting_rooms}
          min={0}
          max={40}
          onChange={(v) => set({ meeting_rooms: v })}
        />
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

      <button className="cta" onClick={() => run(false)} disabled={busy} data-testid="generate">
        {busy ? 'Searching layouts…' : 'Generate test-fit'}
      </button>
      {confirmed > 0 ? (
        <button className="cta-ghost" onClick={() => run(true)} disabled={busy} data-testid="regenerate">
          Regenerate · keep {confirmed} frozen
        </button>
      ) : (
        <div className="freeze-tip">Confirm a component to freeze it, then regenerate around it.</div>
      )}
      {note && <div className="inline-note">{note}</div>}

      {result && (
        <div className="score-card">
          <div className="score-head">
            <span className="score-total num">{Math.round(result.best.total)}</span>
            <span className="score-of num">/100</span>
            <span className="score-meta num">
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
        <span className="sel-tag num" style={{ color: cat?.color }}>
          #{String(c.id).padStart(2, '0')}
        </span>
        <div className="sel-title">
          <div className="sel-name">{c.label}</div>
          <div className="sel-cat">{cat?.label ?? c.category}</div>
        </div>
      </div>

      <div className="spec num">
        <span>
          {c.w.toFixed(2)} × {c.h.toFixed(2)} m
        </span>
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
            <span className="p-price num">${p.price.toLocaleString()}</span>
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

function ScoreBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </span>
      <span className="bar-val num">{Math.round(v)}</span>
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
        className="field-input num"
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
        <span className="field-value num">
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
