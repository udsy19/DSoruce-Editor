import { useEffect, useRef, useState } from 'react'
import { EditorCanvas, DocComponent, Metrics, Program, GenResult } from './editor/EditorCanvas'
import { CATALOG, catByCategory } from './editor/catalog'
import { searchBank } from './materialBank/mock'
import { Icon } from './ui/icons'
import { StatsPanel } from './ui/StatsPanel'
import { AgentPanel } from './ai/AgentPanel'
import { Scene3D } from './three/Scene3D'
import { DrawingView } from './import/DrawingView'
import { DrawingScene3D } from './three/DrawingScene3D'
import { FurnitureInspector } from './import/FurnitureInspector'
import { parseDrawing } from './import/dxf'
import type { Drawing, FurnitureItem } from './import/types'
import type { DrawingCanvas } from './import/DrawingCanvas'
import type { OfficeProduct } from './materialBank/office'
import { exportPNG } from './export/png'
import { downloadDXF } from './export/dxf'

// CAD drafting tools (map to EditorCanvas 'cad:<id>' tools).
const CAD_RAIL: { id: string; icon: string; label: string; hint?: string }[] = [
  { id: 'select', icon: 'marquee', label: 'Select', hint: 'CAD' },
  { id: 'line', icon: 'line', label: 'Line' },
  { id: 'polyline', icon: 'polyline', label: 'Polyline' },
  { id: 'rect', icon: 'rect', label: 'Rectangle' },
  { id: 'circle', icon: 'circle', label: 'Circle' },
  { id: 'arc', icon: 'arc', label: 'Arc' },
  { id: 'dimension', icon: 'dimension', label: 'Dimension' },
  { id: 'text', icon: 'text', label: 'Text' },
  { id: 'door', icon: 'door', label: 'Door' },
  { id: 'window', icon: 'window', label: 'Window' },
  { id: 'column', icon: 'column', label: 'Column' },
  { id: 'move', icon: 'move', label: 'Move' },
  { id: 'copy', icon: 'copy', label: 'Copy' },
  { id: 'rotate', icon: 'rotate', label: 'Rotate' },
  { id: 'mirror', icon: 'mirror', label: 'Mirror' },
  { id: 'scale', icon: 'scale', label: 'Scale' },
]

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const scaleRef = useRef<HTMLSpanElement>(null)
  const ecRef = useRef<EditorCanvas | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const [tool, setTool] = useState('select')
  const [mode, setMode] = useState<'2d' | '3d' | 'import'>('2d')
  const [aiOpen, setAiOpen] = useState(false)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [selItem, setSelItem] = useState<FurnitureItem | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [planView, setPlanView] = useState<'2d' | '3d'>('2d')
  const fileRef = useRef<HTMLInputElement>(null)
  const drawCanvasRef = useRef<DrawingCanvas | null>(null)
  const [, setDrawVer] = useState(0)

  const bindProduct = (it: FurnitureItem, product: OfficeProduct) => {
    it.productId = product.id
    it.productName = product.name
    drawCanvasRef.current?.refresh()
    setDrawVer((v) => v + 1)
  }

  const onImportFile = async (file: File) => {
    setImporting(true)
    setImportErr(null)
    try {
      let dxf: string
      if (file.name.toLowerCase().endsWith('.dwg')) {
        const resp = await fetch('/api/dwg', { method: 'POST', body: await file.arrayBuffer() })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error || 'DWG conversion failed')
        dxf = data.dxf
      } else {
        dxf = await file.text()
      }
      const d = parseDrawing(dxf)
      setDrawing(d)
      setSelItem(null)
      setMode('import')
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

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
            {drawing && (
              <button
                className={mode === 'import' ? 'seg on' : 'seg'}
                onClick={() => setMode('import')}
                data-testid="mode-import"
              >
                Plan
              </button>
            )}
          </div>
          {mode === 'import' && drawing && (
            <div className="mode-toggle" role="group" aria-label="Plan view">
              <button
                className={planView === '2d' ? 'seg on' : 'seg'}
                onClick={() => setPlanView('2d')}
                data-testid="plan-2d"
              >
                Plan
              </button>
              <button
                className={planView === '3d' ? 'seg on' : 'seg'}
                onClick={() => setPlanView('3d')}
                data-testid="plan-3d"
              >
                3D
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".dwg,.dxf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onImportFile(f)
              e.target.value = ''
            }}
          />
          <button
            className="export-btn"
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            data-testid="import-btn"
          >
            {importing ? 'Importing…' : 'Import DWG'}
          </button>
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
          <div className="rail-sep" />
          {CAD_RAIL.map((t) => (
            <RailButton
              key={t.id}
              id={`cad:${t.id}`}
              tool={tool}
              onClick={pickTool}
              icon={t.icon}
              tip={t.label}
              hint={t.hint}
            />
          ))}
          <span className="rail-spring" />
          <button
            className={aiOpen ? 'rail-fab on' : 'rail-fab'}
            onClick={() => setAiOpen((o) => !o)}
            title="AI assistant"
            data-testid="ai-fab"
          >
            <Icon name="sparkles" size={20} />
          </button>
        </nav>

        <main className="stage">
          <div className="canvas-wrap">
            <canvas ref={canvasRef} style={{ display: mode === '2d' ? 'block' : 'none' }} />
            {mode === '3d' && ready && ec && <Scene3D state={ec.getState()} />}
            {mode === 'import' && drawing && planView === '3d' && (
              <DrawingScene3D drawing={drawing} />
            )}
            {mode === 'import' && drawing && planView === '2d' && (
              <DrawingView
                drawing={drawing}
                onSelect={setSelItem}
                onChange={() => setDrawVer((v) => v + 1)}
                onCanvas={(c) => {
                  drawCanvasRef.current = c
                  if (import.meta.env.DEV) (window as unknown as { __dc: DrawingCanvas | null }).__dc = c
                }}
              />
            )}
            {!ready && <div className="loading">Loading Rust · Wasm core…</div>}
            {importErr && <div className="import-err">Import failed: {importErr}</div>}
          </div>
          {aiOpen && ec && mode !== 'import' && <AgentPanel ec={ec} onClose={() => setAiOpen(false)} />}
        </main>

        <aside className="inspector">
          {mode === 'import' && drawing ? (
            <ImportPanel drawing={drawing} item={selItem} onBind={bindProduct} />
          ) : selected && ec ? (
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

  const exportPng = () => {
    if (!ec) return
    // The editor's 2D canvas lives in the canvas-wrap; capture its pixels.
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')
    if (canvas) exportPNG(canvas, 'dsource-plan.png')
    setOpen(false)
  }

  const exportDxf = () => {
    if (!ec) return
    downloadDXF(ec.getState(), 'dsource-plan.dxf')
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
          <div className="export-item" onClick={exportPng} data-testid="export-png">
            PNG image
          </div>
          <div className="export-item" onClick={exportDxf} data-testid="export-dxf">
            DXF (CAD)
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
  const [program, setProgram] = useState<Program>(ec.program)
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

/* ------------------------------ Imported plan ----------------------------- */

function ImportPanel({
  drawing,
  item,
  onBind,
}: {
  drawing: Drawing
  item: FurnitureItem | null
  onBind: (it: FurnitureItem, p: OfficeProduct) => void
}) {
  const w = drawing.bounds[2] - drawing.bounds[0]
  const h = drawing.bounds[3] - drawing.bounds[1]
  const counts = new Map<string, number>()
  for (const f of drawing.furniture) counts.set(f.name, (counts.get(f.name) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const bound = drawing.furniture.filter((f) => f.productId).length

  // Selected furniture → the re-imagine (material-bank) inspector.
  if (item) return <FurnitureInspector item={item} onBind={onBind} />

  return (
    <div className="panel-body">
      <div className="panel-eyebrow">Imported plan</div>
      <div className="metric-row">
        <span className="label">Extent</span>
        <span className="value">
          {w.toFixed(1)} × {h.toFixed(1)}
          <span className="unit">m</span>
        </span>
      </div>
      <div className="metric-row">
        <span className="label">Furniture items</span>
        <span className="value">{drawing.furniture.length}</span>
      </div>
      <div className="metric-row">
        <span className="label">Line entities</span>
        <span className="value">{drawing.entities.length}</span>
      </div>
      <div className="metric-row">
        <span className="label">Layers</span>
        <span className="value">{drawing.layers.length}</span>
      </div>

      <div className="metric-row">
        <span className="label">Specified</span>
        <span className="value">{bound}</span>
      </div>
      <div className="freeze-tip">
        Click furniture to re-imagine it · drag to move · R rotate · Del delete · ⌘D duplicate · ⌘Z undo
      </div>

      <div className="panel-eyebrow gap">Furniture schedule</div>
      <div className="schedule">
        {top.map(([name, n]) => (
          <div className="row" key={name}>
            <span className="row-label import-sched-name">{name}</span>
            <span className="row-value">{n}</span>
          </div>
        ))}
      </div>
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
