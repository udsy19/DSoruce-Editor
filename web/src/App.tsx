import { useEffect, useRef, useState } from 'react'
import { EditorCanvas, DocComponent, Metrics, Program, GenResult, DEFAULT_PROGRAM } from './editor/EditorCanvas'
import { CATALOG, catByCategory } from './editor/catalog'
import { searchBank } from './materialBank/mock'
import { searchBankLive, bankQueryFor, formatINR, type BankProduct } from './materialBank/client'
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
import { exportPlanPDF } from './export/pdf'
import { downloadIFC } from './export/ifc'
import { downloadDXF, downloadDrawingDXF } from './export/dxf'
import { CandidateGallery } from './ui/CandidateGallery'
import { CategoryPlan } from './ui/CategoryPlan'
import {
  extractPlate,
  pushPlateToEditor,
  extractKeepouts,
  pushKeepoutsToEditor,
  type PlateResult,
} from './import/testfit'
import { saveProject, openProject, applyProject } from './persist/file'
import { evaluateCandidates, type SoftVerdict } from './ai/evaluator'

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
  const [plateNotice, setPlateNotice] = useState<{
    variant: 'ok' | 'warn'
    msg: string
  } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const drawCanvasRef = useRef<DrawingCanvas | null>(null)
  const [, setDrawVer] = useState(0)

  /** Full product data per binding (price ₹, thumbnail) — the item itself only
   *  carries id/name; the selection card + category plan need the rest. */
  const [bindings, setBindings] = useState<Map<string, { price: number | null; image: string | null }>>(
    () => new Map(),
  )

  const bindProduct = (it: FurnitureItem, product: OfficeProduct) => {
    it.productId = product.id
    it.productName = product.name
    setBindings((prev) =>
      new Map(prev).set(product.id, {
        price: Number.isFinite(product.price) && product.price > 0 ? product.price : null,
        image: product.image ?? null,
      }),
    )
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

  // Save the whole session (document snapshot incl. CAD layer, program,
  // import session, view hints) to a local .dsource file. Routed through a
  // ref so the []-dep keydown effect below always calls the fresh closure.
  const onSave = () => {
    const ec = ecRef.current
    if (!ec) return
    saveProject({ ec, drawing, ui: { mode, planView } })
  }
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const projectFileRef = useRef<HTMLInputElement>(null)
  const onOpenProject = async (file: File) => {
    const ec = ecRef.current
    if (!ec) return
    try {
      const f = await openProject(file)
      applyProject(ec, f) // document snapshot + program (core state)
      setDrawing(f.drawing ?? null) // React-owned import session
      setSelItem(null)
      // Best-effort UI restore — fall back safely when hints are absent.
      const m = f.ui?.mode
      setMode(m === '3d' ? '3d' : m === 'import' && f.drawing ? 'import' : '2d')
      setPlanView(f.ui?.planView === '3d' ? '3d' : '2d')
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e))
    }
  }

  // Global "?" opens the shortcut help; Escape closes it; ⌘S saves. Ignored
  // while typing so it never steals focus from search or program fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (e.key === '?' && !typing) {
        e.preventDefault()
        setHelpOpen((o) => !o)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !typing) {
        e.preventDefault()
        onSaveRef.current()
      } else if (e.key === 'Escape') {
        setHelpOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Success notices fade on their own; warnings stay until dismissed.
  useEffect(() => {
    if (plateNotice?.variant !== 'ok') return
    const t = window.setTimeout(() => setPlateNotice(null), 8000)
    return () => window.clearTimeout(t)
  }, [plateNotice])

  const ec = ecRef.current
  const selected = ready && ec ? ec.getSelected() : null
  const metrics = ready && ec ? ec.getMetrics() : null
  const docEmpty = !!metrics && metrics.wall_count === 0 && metrics.component_count === 0

  const pickTool = (t: string) => {
    setTool(t)
    ec?.setTool(t)
  }

  /** The qbiq loop: extract the imported floor plate → seed the document with
   *  its boundary walls → jump to 2D where the autonomous generator runs
   *  inside the real building shell. */
  const testFitPlan = () => {
    if (!ec || !drawing) return
    const plate = extractPlate(drawing)
    if (!plate) {
      setImportErr('No wall geometry found in this drawing to derive a floor plate from.')
      return
    }
    const m = ec.getMetrics()
    if (
      (m.wall_count > 0 || m.component_count > 0) &&
      !window.confirm('Replace the current document with the imported floor plate?')
    ) {
      return
    }
    ec.clearAll()
    pushPlateToEditor(ec, plate)
    // Interior cores (stairs/shafts/service rooms = enclosed furniture-free
    // rooms) become keep-outs so the generator never furnishes them.
    // Guarded no-op until the wasm add_keepout binding is present.
    pushKeepoutsToEditor(ec, extractKeepouts(drawing, plate))
    ec.sync()
    // Plate-quality feedback. `coverage`/`areaM2` are additive optional fields
    // on PlateResult — guard so this works whether or not they're present.
    const { coverage, areaM2 } = plate as PlateResult & { coverage?: number; areaM2?: number }
    // Scale the default program to the traced plate so "Generate test-fit"
    // fills the building instead of dropping 20 desks into 800 m². NBC
    // business occupancy is ~10 m²/person; ~12 m²/desk leaves meeting/
    // circulation share. Only nudge when the user hasn't customized desks.
    if (areaM2 && areaM2 > 100 && ec.program.desks === DEFAULT_PROGRAM.desks) {
      ec.program = {
        ...ec.program,
        desks: Math.min(200, Math.max(10, Math.round(areaM2 / 12))),
        meeting_rooms: Math.min(8, Math.max(1, Math.round(areaM2 / 200))),
      }
    }
    if (coverage !== undefined || areaM2 !== undefined) {
      const traced = [
        areaM2 !== undefined ? `${Math.round(areaM2)} m²` : null,
        coverage !== undefined ? `covers ${Math.round(coverage * 100)}% of the furniture` : null,
      ]
        .filter(Boolean)
        .join(' · ')
      if (coverage !== undefined && coverage < 0.85) {
        setPlateNotice({
          variant: 'warn',
          msg: `${traced} — the boundary may be wrong — check the outline in 2D and adjust walls before generating.`,
        })
      } else {
        setPlateNotice({ variant: 'ok', msg: `${traced}.` })
      }
    } else {
      setPlateNotice(null)
    }
    setMode('2d')
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
                <span className="seg-dot" aria-hidden />
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
          {mode === 'import' && drawing && (
            <button className="export-btn" onClick={testFitPlan} data-testid="testfit-plan">
              Test-fit this plan
            </button>
          )}
          <button className="export-btn" onClick={onSave} data-testid="save-project" title="Save project (⌘S)">
            Save
          </button>
          <button
            className="export-btn"
            onClick={() => projectFileRef.current?.click()}
            data-testid="open-project"
            title="Open a .dsource project"
          >
            Open
          </button>
          <input
            ref={projectFileRef}
            type="file"
            accept=".dsource,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onOpenProject(f)
              e.target.value = ''
            }}
          />
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
            aria-label="Import a DWG or DXF plan"
            title="Import a DWG or DXF plan"
            data-testid="import-btn"
          >
            {importing ? (
              <>
                <span className="btn-spinner" aria-hidden /> Importing…
              </>
            ) : (
              <>
                <Icon name="upload" size={14} /> Import
              </>
            )}
          </button>
          <ExportMenu ec={ec} mode={mode} drawing={drawing} />
          <button
            className="icon-btn"
            onClick={() => setHelpOpen(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            data-testid="help-btn"
          >
            <Icon name="help" size={17} />
          </button>
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
                price={selItem?.productId ? bindings.get(selItem.productId)?.price : undefined}
                image={selItem?.productId ? bindings.get(selItem.productId)?.image : undefined}
              />
            )}
            {!ready && <div className="loading">Loading Rust · Wasm core…</div>}
            {(mode === '2d' || mode === '3d') && ready && docEmpty && drawing && (
              <EmptyState
                kind="imported"
                onGoToPlan={() => setMode('import')}
                onTestFit={testFitPlan}
              />
            )}
            {mode === '2d' && ready && docEmpty && !drawing && (
              <EmptyState
                kind="fresh"
                onWall={() => pickTool('wall')}
                onImport={() => fileRef.current?.click()}
              />
            )}
            {importing && (
              <div className="import-overlay" role="status" aria-live="polite">
                <span className="import-spinner" aria-hidden />
                <span className="import-overlay-text">Converting &amp; parsing CAD…</span>
                <span className="import-overlay-sub">DWG → DXF → plan</span>
              </div>
            )}
            {plateNotice && !importErr && (
              <div className={`import-err ${plateNotice.variant}`} role="status" data-testid="plate-notice">
                <Icon name={plateNotice.variant === 'warn' ? 'warn' : 'check'} size={15} />
                <div className="import-err-body">
                  <span className="import-err-title">Floor plate traced</span>
                  <span className="import-err-msg">{plateNotice.msg}</span>
                </div>
                <button
                  className="import-err-close"
                  onClick={() => setPlateNotice(null)}
                  aria-label="Dismiss notice"
                  data-testid="plate-notice-dismiss"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
            {importErr && (
              <div className="import-err" role="alert">
                <Icon name="warn" size={15} />
                <div className="import-err-body">
                  <span className="import-err-title">Import failed</span>
                  <span className="import-err-msg">{importErr}</span>
                </div>
                <button
                  className="import-err-close"
                  onClick={() => setImportErr(null)}
                  aria-label="Dismiss error"
                  data-testid="import-err-dismiss"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
          </div>
        </main>

        <aside className="inspector">
          {mode === 'import' && drawing ? (
            <ImportPanel
              drawing={drawing}
              item={selItem}
              onBind={bindProduct}
              bindings={bindings}
              onPickItem={(name) => {
                const it = drawing.furniture.find((f) => f.name === name)
                if (!it) return
                // Route through the canvas so highlight/anchor stay in sync.
                if (drawCanvasRef.current) drawCanvasRef.current.select(it)
                else setSelItem(it)
              }}
            />
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

      {/* App-level assistant dock: fixed overlay so the AI works in 2D, 3D and
          Plan mode alike (it used to be mounted inside the 2D/3D stage only). */}
      {aiOpen && ec && (
        <div className="agent-dock">
          {mode === 'import' && docEmpty && (
            <div className="agent-note" role="note" data-testid="agent-import-note">
              The assistant drives the test-fit document — run <strong>Test-fit this plan</strong>{' '}
              first to give it a floor plate.
            </div>
          )}
          <AgentPanel ec={ec} onClose={() => setAiOpen(false)} />
        </div>
      )}

      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function ExportMenu({
  ec,
  mode,
  drawing,
}: {
  ec: EditorCanvas | null
  mode: '2d' | '3d' | 'import'
  drawing: Drawing | null
}) {
  const [open, setOpen] = useState(false)
  const importMode = mode === 'import' && !!drawing

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
    // Capture the currently-visible canvas in the stage: the 2D editor plan, or
    // the imported DrawingCanvas when a plan is loaded. (Hidden canvases have no
    // offsetParent.)
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.canvas-wrap canvas'))
    const canvas = canvases.find((c) => c.offsetParent !== null) ?? canvases[0]
    if (canvas) exportPNG(canvas, importMode ? 'dsource-import.png' : 'dsource-plan.png')
    setOpen(false)
  }

  const exportDxf = () => {
    if (importMode && drawing) {
      downloadDrawingDXF(drawing, 'dsource-import.dxf')
    } else if (ec) {
      downloadDXF(ec.getState(), 'dsource-plan.dxf', ec.cadEntities())
    }
    setOpen(false)
  }

  const exportPdf = () => {
    if (!ec) return
    // Exports the editor document (in import mode that's the test-fit doc).
    void exportPlanPDF(ec.getState(), ec.getMetrics(), { project: 'Untitled Plan' })
    setOpen(false)
  }

  const exportIfc = () => {
    if (!ec) return
    downloadIFC(ec.getState(), 'dsource-plan.ifc', { project: 'Untitled Plan' })
    setOpen(false)
  }

  const source = importMode ? 'imported plan' : 'generated plan'

  return (
    <div className="export">
      <button
        className="export-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="export-btn"
      >
        Export <Icon name="caret" size={13} />
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <div className="export-source">From {source}</div>
          {!importMode && (
            <div className="export-item" role="menuitem" onClick={exportCSV} data-testid="export-csv">
              Data <span className="hint">CSV</span>
            </div>
          )}
          <div className="export-item" role="menuitem" onClick={exportPng} data-testid="export-png">
            PNG image <span className="hint">raster</span>
          </div>
          <div className="export-item" role="menuitem" onClick={exportDxf} data-testid="export-dxf">
            DXF <span className="hint">vector CAD</span>
          </div>
          <div className="export-item" role="menuitem" onClick={exportPdf} data-testid="export-pdf">
            PDF sheet <span className="hint">A3 drawing</span>
          </div>
          <div className="export-sep" />
          <div className="export-item" role="menuitem" onClick={exportIfc} data-testid="export-ifc">
            IFC model <span className="hint">BIM</span>
          </div>
          <div className="export-item disabled" aria-disabled="true">
            OBJ · RVT <span className="hint">soon</span>
          </div>
          <div className="export-item disabled" aria-disabled="true">
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
      aria-label={hint ? `${tip} (${hint})` : tip}
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

/* ------------------------- Empty state + help ----------------------------- */

function EmptyState(
  props:
    | { kind: 'fresh'; onWall: () => void; onImport: () => void }
    | { kind: 'imported'; onGoToPlan: () => void; onTestFit: () => void },
) {
  // Import-aware variant: a plan was imported but the generative document is
  // still empty — point at the Plan tab instead of claiming a blank session.
  if (props.kind === 'imported') {
    return (
      <div className="empty-state" data-testid="empty-state-import">
        <div className="empty-card">
          <span className="empty-glyph" aria-hidden>
            <Icon name="upload" size={26} />
          </span>
          <h2 className="empty-title">
            Your imported plan is open in the <strong>Plan</strong> tab
          </h2>
          <p className="empty-lead">
            This view holds the generative test-fit document, which is still empty. Trace the
            imported floor plate into it to generate layouts inside your building.
          </p>
          <div className="empty-actions">
            <button className="empty-btn" onClick={props.onGoToPlan}>
              Go to Plan
            </button>
            <button className="empty-btn primary" onClick={props.onTestFit}>
              <Icon name="sparkles" size={15} /> Test-fit this plan
            </button>
          </div>
          <p className="empty-hint">
            Test-fit derives the floor plate from the imported walls, then the autonomous generator
            runs inside it.
          </p>
        </div>
      </div>
    )
  }
  const { onWall, onImport } = props
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-card">
        <span className="empty-glyph" aria-hidden>
          <Icon name="generate" size={26} />
        </span>
        <h2 className="empty-title">Start your plan</h2>
        <p className="empty-lead">
          Draw a room boundary and let the engine generate a test-fit — or import a real CAD plan to
          edit and re-imagine.
        </p>
        <div className="empty-actions">
          <button className="empty-btn primary" onClick={onWall}>
            <Icon name="wall" size={15} /> Draw walls
          </button>
          <button className="empty-btn" onClick={onImport}>
            <Icon name="upload" size={15} /> Import a plan
          </button>
        </div>
        <p className="empty-hint">
          Then set the program on the right and hit <strong>Generate test-fit</strong>. Press{' '}
          <kbd>?</kbd> for shortcuts.
        </p>
      </div>
    </div>
  )
}

const SHORTCUT_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'General',
    rows: [
      ['?', 'Toggle this help'],
      ['Esc', 'Cancel · deselect · close'],
      ['⌘ / Ctrl Z', 'Undo'],
    ],
  },
  {
    title: '2D editor',
    rows: [
      ['V', 'Select tool'],
      ['W', 'Wall tool'],
      ['Scroll', 'Zoom · drag empty space to pan'],
      ['Tool rail', 'Furniture + CAD tools (hover for keys)'],
    ],
  },
  {
    title: 'Imported plan',
    rows: [
      ['Click', 'Select furniture · drag to move'],
      ['R / Shift R', 'Rotate selected ±15°'],
      ['⌘ / Ctrl D', 'Duplicate selected'],
      ['Del / ⌫', 'Delete selected'],
    ],
  },
  {
    title: '3D walkthrough',
    rows: [
      ['W A S D', 'Walk'],
      ['Shift', 'Run'],
      ['Mouse', 'Look around'],
    ],
  },
]

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-scrim" onClick={onClose} data-testid="help-overlay">
      <div
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-head">
          <span className="help-title">Keyboard shortcuts</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close shortcuts">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="help-grid">
          {SHORTCUT_GROUPS.map((g) => (
            <div className="help-group" key={g.title}>
              <div className="help-group-title">{g.title}</div>
              {g.rows.map(([keys, desc]) => (
                <div className="help-row" key={keys}>
                  <span className="help-keys">
                    {keys.split(' ').map((k, i) => (
                      <kbd key={i}>{k}</kbd>
                    ))}
                  </span>
                  <span className="help-desc">{desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------- Autonomous test-fit -------------------------- */

function GenerateCard({ ec, metrics }: { ec: EditorCanvas; metrics: Metrics | null }) {
  const [program, setProgram] = useState<Program>(ec.program)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenResult | null>(null)
  const [activeSeed, setActiveSeed] = useState<number | null>(null)
  const [verdicts, setVerdicts] = useState<Record<number, SoftVerdict> | null>(null)
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
      setActiveSeed(res.seed)
      setBusy(false)
      // Claude soft-goal evaluation. Gate = the best achieved score capped at
      // the hard target: when the search hits 82 the gate is vision-strict
      // (only passing plans spend tokens); when the room tops out below it,
      // the best candidates still get judged — junk never reaches the API
      // because the gallery already keeps only the top-K. Silently skipped
      // when no ANTHROPIC_API_KEY is configured.
      setVerdicts(null)
      const gate = Math.min(82, Math.floor(res.best.total))
      void evaluateCandidates(res.candidates, program, gate).then((ai) => {
        if (!ai) return
        setVerdicts(Object.fromEntries(ai.verdicts.map((v) => [v.seed, v])))
      })
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
      <label
        className="freeze-tip"
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
      >
        <input
          type="checkbox"
          checked={program.bench_pairs}
          onChange={(e) => set({ bench_pairs: e.target.checked })}
          data-testid="bench-pairs"
          style={{ accentColor: 'var(--accent, #2d5bd6)' }}
        />
        Bench desking (back-to-back pairs)
      </label>

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
          <CandidateGallery
            candidates={result.candidates}
            activeSeed={activeSeed}
            verdicts={verdicts ?? undefined}
            onPick={(c) => {
              ec.applyCandidate(c.snap)
              setActiveSeed(c.seed)
              setResult((r) => (r ? { ...r, best: c.score } : r))
            }}
          />
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
  bindings,
  onPickItem,
}: {
  drawing: Drawing
  item: FurnitureItem | null
  onBind: (it: FurnitureItem, p: OfficeProduct) => void
  bindings: Map<string, { price: number | null; image: string | null }>
  onPickItem?: (name: string) => void
}) {
  const w = drawing.bounds[2] - drawing.bounds[0]
  const h = drawing.bounds[3] - drawing.bounds[1]
  const bound = drawing.furniture.filter((f) => f.productId).length

  // Materio-style "plan by category": group furniture by category, aggregate
  // items by name with bound-product price/image rolled in.
  const groups = (() => {
    const byCat = new Map<string, Map<string, { qty: number; item: FurnitureItem }>>()
    for (const f of drawing.furniture) {
      const cat = byCat.get(f.category) ?? new Map()
      const agg = cat.get(f.name) ?? { qty: 0, item: f }
      agg.qty++
      if (f.productId && !agg.item.productId) agg.item = f // prefer a bound exemplar
      cat.set(f.name, agg)
      byCat.set(f.category, cat)
    }
    return [...byCat.entries()]
      .map(([category, items]) => {
        const rows = [...items.entries()]
          .map(([name, { qty, item: ex }]) => {
            const b = ex.productId ? bindings.get(ex.productId) : undefined
            return {
              name,
              qty,
              priceInr: ex.productId ? (b?.price != null ? b.price * qty : null) : undefined,
              image: b?.image ?? null,
              bound: !!ex.productId,
            }
          })
          .sort((a, b) => b.qty - a.qty)
        const priced = rows.filter((r) => typeof r.priceInr === 'number')
        return {
          category,
          count: rows.reduce((s, r) => s + r.qty, 0),
          totalInr: priced.length ? priced.reduce((s, r) => s + (r.priceInr as number), 0) : null,
          items: rows,
        }
      })
      .sort((a, b) => b.count - a.count)
  })()

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

      <CategoryPlan groups={groups} onPick={onPickItem} />
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
  const [live, setLive] = useState<BankProduct[] | null>(null)
  const [bankUp, setBankUp] = useState(true)
  const cat = catByCategory(c.category)

  // Live bank first (semantic search over ~140k real products), debounced;
  // fall back to the local mock so the panel keeps working offline.
  useEffect(() => {
    let cancelled = false
    const query = q.trim() || bankQueryFor(c.category)
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
  }, [q, c.category])

  const results = searchBank(c.category, q)

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
        {live && live.length === 0 && <div className="inline-note">No matches in the bank.</div>}
        {live?.map((p) => (
          <button
            key={p.id}
            className={c.product_id === p.id ? 'product on' : 'product'}
            onClick={() => ec.assignProduct(c.id, p.id, p.name, p.price)}
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

      {bankUp ? (
        <div className="mock-note">Live material bank · 140k+ products · prices in INR.</div>
      ) : (
        <div className="mock-note">Bank offline — showing local samples.</div>
      )}
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
