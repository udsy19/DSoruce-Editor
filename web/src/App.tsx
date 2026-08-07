import { forwardRef, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react'
import type { DocComponent, DocState, DocZone, RoomSelection } from './types/doc'
import type { Metrics } from './types/metrics'
import type { Program, GenResult, Candidate } from './types/program'
import { DEFAULT_PROGRAM } from './types/program'
import { EditorCanvas, STRATEGY_LABEL, openShare } from './editor/EditorCanvas'
import type { RefineOutcome } from './editor/search'
import { CATALOG, catByCategory } from './editor/catalog'
import { searchBank } from './materialBank/mock'
import { searchBankLive, bankQueryFor, formatINR, type BankProduct } from './materialBank/client'
import { Icon } from './ui/icons'
import { ToolDock, type DockTool } from './ui/ToolDock'
import { StatsPanel } from './ui/StatsPanel'
import { BomPanel } from './ui/BomPanel'
import { logSearch } from './persist/searchLog'
import { RoomTools } from './ui/RoomTools'
import { ObjectInspector } from './ui/ObjectInspector'
import { LayersPanel } from './ui/LayersPanel'
import { SheetsPanel } from './ui/SheetsPanel' // M6 — sheets manager + publish
import { AgentPanel } from './ai/AgentPanel'
import { suggestProgram, suggestProgramSummary } from './ai/suggestProgram'
import { Scene3D } from './three/Scene3D'
import { DrawingView } from './import/DrawingView'
import { FurnitureInspector } from './import/FurnitureInspector'
import { parseDrawing } from './import/dxf'
import type { Drawing, FurnitureItem } from './import/types'
import type { DrawingCanvas } from './import/DrawingCanvas'
import type { OfficeProduct } from './materialBank/office'
import { exportPNG, triggerDownload } from './export/png'
import { exportPlanPDF, exportDrawingPDF } from './export/pdf'
import { downloadIFC } from './export/ifc'
import { downloadOBJ } from './export/obj'
import { publishShareLink, downloadPlanGlb } from './export/share'
import { exportSpacePlanningReport } from './export/report'
import { exportDrawingSet } from './export/sheetSet'
import { zoneAtPoint } from './export/takeoff'
import { exportQtoWorkbook, type Quantities } from './export/qtoWorkbook'
import {
  buildDeliverablePack,
  detectPackSink,
  type DeliverablePackResult,
  type PackProgressFn,
} from './export/deliverablePack'
import { seedSamplePlan } from './editor/samplePlan'
import { classifyWalls } from './export/wallTypes'
import { restrictDrawing } from './import/area'
import { healWalls } from './import/heal'
import type { RoomMarker } from './import/markers'
import type { AnchorPin } from './program/anchors'
import { downloadDXF, downloadDrawingDXF } from './export/dxf'
import { CandidateGallery } from './ui/CandidateGallery'
import { DesignWithAI } from './ui/DesignWithAI'
import { CategoryPlan, type CategoryPlanGroup } from './ui/CategoryPlan'
import {
  pushPlateToEditor,
  extractKeepouts,
  pushKeepoutsToEditor,
  extractEntries,
  pushEntriesToEditor,
  extractInteriorWalls,
  pushInteriorWallsToEditor,
  pushAnchorsToEditor,
  type PlateResult,
  type Pt,
} from './import/testfit'
import { derivePlate } from './import/plate'
import { baseStampAround, type BaseStamp } from './import/mergeFit'
import {
  saveProject,
  openProject,
  applyProject,
  buildProjectFile,
  type BindingInfo,
  type DSourceFile,
} from './persist/file'
import {
  buildSavedPlan,
  listPlans,
  getPlan,
  putPlan,
  deletePlan,
  resolveProject,
  assignToProject,
  type SavedPlan,
} from './persist/plans'
import type { ProjectRecord } from './persist/projects'
import { navigate } from './shell/route'
import { syncPlans, type SyncResult } from './persist/sync'
import { cloudEnabled } from './cloud'
import { CloudSyncPanel } from './cloud/CloudSyncPanel'
import { noteChange, listHistory, restoreEntry, type HistoryEntry } from './persist/history'
import { comparePlans, snapshotThumb, type PlanComparison } from './plans/compare'
import { commitCadToPlan } from './cad/commit'
import { PlacePalette } from './import/PlacePalette'
import type { PlaceSpec } from './import/DrawingCanvas'
import { renderThumb } from './editor/paint'
import { LibraryPanel } from './ui/LibraryPanel'
import { CompareView } from './ui/CompareView'
import { CommandPalette } from './ui/CommandPalette'
import { buildCommands, letterShortcuts, type Command, type CommandCtx } from './editor/commands'
import { evaluateCandidates, evaluatorAvailable, type SoftVerdict } from './ai/evaluator'

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
  { id: 'hatch', icon: 'hatch', label: 'Hatch' },
  { id: 'move', icon: 'move', label: 'Move' },
  { id: 'copy', icon: 'copy', label: 'Copy' },
  { id: 'rotate', icon: 'rotate', label: 'Rotate' },
  { id: 'mirror', icon: 'mirror', label: 'Mirror' },
  { id: 'scale', icon: 'scale', label: 'Scale' },
  { id: 'trim', icon: 'trim', label: 'Trim' },
  { id: 'extend', icon: 'extend', label: 'Extend' },
  { id: 'fillet', icon: 'fillet', label: 'Fillet ( [ / ] radius )' },
]

/** Command-palette bridge to actions owned by other components: click the live
 *  button by its data-testid (the button IS the single source of that handler).
 *  `export-*` items live inside the collapsed Export menu, so open it first. */
function fireTestId(testid: string) {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  if (el) {
    el.click()
    return
  }
  if (testid.startsWith('export-')) {
    document.querySelector<HTMLElement>('[data-testid="export-btn"]')?.click()
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.click(),
    )
  }
}

/**
 * Imperative seam by which the AppShell/wizard steers the editor without
 * owning its state (docs/design/workflow.md §1). Every method is a LIFT of an
 * existing closure — no new editor logic. Later slices call these; S0 only
 * needs the shell to mount EditorView and keep it alive.
 */
/** A room marker projected into EDITOR coords (plate offset applied), stored at
 *  test-fit time. Stable across regenerates (the plate is fixed), so the ref →
 *  zone association can be re-resolved against the current zones on demand. */
interface EditorMarker {
  ref: string
  x: number
  y: number
}

/** Resolve editor-coord markers to { zone.id → ref } against the current zones.
 *  Re-run per read (export/AI), because zones are regenerated wholesale while
 *  markers stay pinned to points (workflow.md §3.2). First marker in a zone wins. */
function buildRoomRefs(zones: DocZone[], markers: EditorMarker[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const m of markers) {
    const z = zoneAtPoint(m.x, m.y, zones)
    if (z && !out.has(z.id)) out.set(z.id, m.ref)
  }
  return out
}

/** Merge-into-plan (design: merge-into-plan): stamp a {@link BaseStamp} — the
 *  imported plan's surroundings, already in editor coords — into the live document
 *  as plain walls + components. Called on top of a generated region test-fit so the
 *  rest of the floor rejoins it as one editable document; the generated region is
 *  never rebuilt, so its zones/labels/glazing stay intact. `bindings` re-applies the
 *  imported product bindings (price ₹) so a bank-specified surrounding keeps its
 *  cost/takeoff line + "specified furniture" tally through the merge. */
function stampBaseInto(ec: EditorCanvas, stamp: BaseStamp, bindings: Map<string, BindingInfo>): void {
  for (const w of stamp.walls) ec.ed.add_wall(w.ax, w.ay, w.bx, w.by, w.thickness)
  for (const c of stamp.comps) {
    const id = ec.ed.add_component(c.category, c.x, c.y, c.w, c.h)
    if (c.rotation) ec.ed.set_component_rotation(id, c.rotation)
    if (c.mirror) ec.ed.set_component_mirror(id, c.mirror) // door hinge hand (mergeFit)
    // Imported/legacy furniture is PASSIVE REFERENCE (Laiout parity): it renders for
    // context but is EXCLUDED from every metric (workstations, pax, cost, CO2). Only
    // the generated region (never stamped here) counts — so a merged plan reports the
    // generated desk count, not generated + every imported desk-block.
    ec.ed.set_component_reference(id, true)
    // Retain the imported bank binding on the reference piece so its product
    // identity/price survives the merge (same primitive user re-imagine uses; the
    // item itself only carries id/name). Because it is `reference`, the price does
    // NOT enter specified_cost or the per-element BoQ — legacy furniture isn't
    // purchased (Laiout parity). The binding only re-enters cost if the user later
    // un-references the piece (adopts it into the fit-out).
    if (c.productId) {
      ec.ed.assign_product(id, c.productId, c.productName ?? c.label, bindings.get(c.productId)?.price ?? undefined)
    }
  }
  ec.ed.clear_selection()
}

/** Options carried into a wizard-driven test-fit (workflow.md §3.1/§3.2). */
export interface TestFitOpts {
  /** Restrict the plate/keepouts/entries to this sub-area (drawing coords). */
  areaPolygon?: Pt[]
  /** Seed the document with room markers (drawing coords) so a marker's ref
   *  becomes the Room ID/label of the zone it falls in. */
  markers?: RoomMarker[]
  /** Anchor pins (drawing coords, workflow.md §3.5): forced room placements —
   *  each is pushed into the document so generate() places it FIRST at its pin. */
  anchors?: AnchorPin[]
  /** S4 wall-heal (workflow.md §3.3): bridge near-miss partition gaps before the
   *  plate/keepout/entry extraction so the traced plate closes cleanly. Default
   *  on (the Space step persists the draft's `heal.on`). */
  heal?: boolean
  /** Layout mode (Space step "Keep existing walls" toggle). When true, the
   *  imported interior partitions are pushed into the document so generate()
   *  fits AROUND them (work with the existing fit-out); when false/absent the
   *  base shell is laid out fresh — the deliberate inverse of the default. */
  keepExisting?: boolean
  /** The wizard owns the document, so it replaces the plate without a confirm
   *  prompt (a user-driven import into a hand-built doc still asks). */
  silent?: boolean
}

export interface EditorController {
  /** Runs the exact DWG/DXF import path; resolves to the parsed Drawing (or
   *  null on failure) so a wizard step can render/persist it without re-parsing. */
  importFile(f: File): Promise<Drawing | null>
  /** Push a previously-parsed Drawing into the editor (wizard reload / resume). */
  loadDrawing(d: Drawing | null): void
  /** Does the editor already hold a parsed Drawing? The wizard's resume path
   *  (`shell/resume.ts`) asks before re-pushing the persisted plate — a cold
   *  start into a late step has none, and generating without one silently
   *  produced empty candidates. */
  hasDrawing(): boolean
  testFit(opts?: TestFitOpts): void
  /** Set the editor's live test-fit program (the Program step's output). Also
   *  re-syncs the mounted GenerateCard so its form + a Generate click use it. */
  setProgram(p: Program): void
  runGenerate(p: Program, o?: { maxIter?: number; target?: number; keepConfirmed?: boolean }): GenResult | null
  /** Make a chosen Generate-step candidate the live document AND persist it as a
   *  library floor (linked to the project when given). Returns the saved plan id
   *  so the wizard can deep-link the editor at #/p/:pid/f/:planId. */
  openCandidate(
    c: Candidate,
    project?: { id: string; name: string; floor: string },
  ): Promise<string | null>
  setMode(m: '2d' | '3d' | 'import'): void
  ec(): EditorCanvas | null
  drawingCanvas(): DrawingCanvas | null
  /** Current room refs: { zone.id → user ref } resolved against live zones —
   *  the AI/engine + takeoff read this to reference "room 502". */
  roomRefs(): Map<number, string>
  /** The whole qbiq-parity deliverable pack from one action (gate G10). With an
   *  empty document it generates the sample test-fit first. */
  deliverablePack(onProgress?: PackProgressFn): Promise<DeliverablePackResult>
}

/** The active project (from the wizard/editor route) — threads real identity
 *  (name/address/logo/floor) into the exports. Null on the dev #/editor route. */
export interface EditorViewProps {
  project?: ProjectRecord | null
  /** Cold-reload floor-open (Known bug): a saved-plan id from the
   *  #/p/:pid/f/:planId route. When the live doc is not already this record,
   *  EditorView loads it (getPlan → openSavedPlan) once wasm is ready, so a hard
   *  reload lands straight on the saved floor. Guarded against double-loading the
   *  in-session pick. */
  openPlanId?: string
  /**
   * Is the editor the screen the user is actually looking at?
   *
   * EditorView is deliberately never unmounted (the wasm doc, canvas transform
   * and the `__ec` seam must survive navigation), so during every wizard step it
   * is alive behind the step with `display:none`. That made its window-level
   * listeners fire on a document nobody could see: `Delete` removed a component
   * (133 → 132, no click, no feedback), `⌘S` wrote a .dsource file from the
   * upload screen, `p` toggled Presentation, `Escape` cleared the selection, and
   * `⌘K` opened the editor's command palette over the wizard.
   *
   * The rule is NOT "guard each handler" — that leaves the next handler someone
   * adds broken by default. It is: **a hidden EditorView does not listen.** This
   * flag gates the BINDING, so when the editor is not the active surface those
   * listeners do not exist at all.
   */
  active?: boolean
}

export const EditorView = forwardRef<EditorController, EditorViewProps>(function EditorView(
  { project = null, openPlanId, active = true },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const scaleRef = useRef<HTMLSpanElement>(null)
  const ecRef = useRef<EditorCanvas | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  // Bumped when the Program step sets a new program → re-keys GenerateCard so it
  // re-reads `ec.program` (its form state is seeded once at mount otherwise).
  const [programVersion, setProgramVersion] = useState(0)
  const [tool, setTool] = useState('select')
  const [roomSel, setRoomSel] = useState<RoomSelection | null>(null)
  const [mode, setMode] = useState<'2d' | '3d' | 'import'>('2d')
  const [aiOpen, setAiOpen] = useState(false)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  // Live mirror of `drawing` for the controller's testFit — the controller is
  // memoized once (deps []), so its closures must read refs, not render values.
  const drawingRef = useRef<Drawing | null>(null)
  drawingRef.current = drawing
  const [selItem, setSelItem] = useState<FurnitureItem | null>(null)
  const [importing, setImporting] = useState(false)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [plateNotice, setPlateNotice] = useState<{
    variant: 'ok' | 'warn'
    msg: string
  } | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  /** ⌘K command palette (M2) — one registry drives it + the letter shortcuts. */
  const [cmdkOpen, setCmdkOpen] = useState(false)
  /** M6 — sheets manager + publish overlay (opened from the Export menu). */
  const [sheetsOpen, setSheetsOpen] = useState(false)
  /** Right-inspector tab: the working plan vs the saved-plan library. */
  const [panelTab, setPanelTab] = useState<'plan' | 'bom' | 'library'>('plan')
  const [plans, setPlans] = useState<SavedPlan[]>([])
  /** Last autonomous-search candidates, lifted from GenerateCard so the topbar
   *  export menu can build the A/B/C space-planning report from them. */
  const [candidates, setCandidates] = useState<Candidate[]>([])
  /** Which SavedPlan the live session came from — drives the floor switcher.
   *  Cleared when the doc stops being that record (file open / fresh doc). */
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null)
  // Read by the autosave path, which runs from a stable EditorCanvas callback.
  const currentPlanIdRef = useRef<string | null>(null)
  currentPlanIdRef.current = currentPlanId
  const [history, setHistory] = useState<HistoryEntry[]>([])
  /** Cloud plan sync (persist/sync.ts): last run's result + in-flight flag. */
  const [syncState, setSyncState] = useState<SyncResult | null>(null)
  const [syncing, setSyncing] = useState(false)
  /** Guards against concurrent sync runs (auto-on-open vs manual button). */
  const syncingRef = useRef(false)
  /** Open compare modal + the two library records behind its panes. */
  const [compare, setCompare] = useState<{ cmp: PlanComparison; a: SavedPlan; b: SavedPlan } | null>(
    null,
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const drawCanvasRef = useRef<DrawingCanvas | null>(null)
  const [, setDrawVer] = useState(0)
  /** Room markers in EDITOR coords, captured at the last test-fit — resolved to
   *  zones on demand for the takeoff Room ID + AI room refs (workflow.md §3.2). */
  const roomMarkersRef = useRef<EditorMarker[]>([])

  /** Merge-into-plan context (design: merge-into-plan). Set by `testFitPlan` when a
   *  test-fit is generated for a SELECTED sub-area: the selection ring (source
   *  coords) + the region plate offset. `runGenerate` reads it after generation to
   *  stamp the imported plan's surroundings around the generated region, producing
   *  ONE merged document. Null for a whole-plate test-fit (full replace, as before). */
  const mergeCtxRef = useRef<{
    selection: Pt[]
    offset: { x: number; y: number }
    /** Clean region-plate-only snapshot (walls/keepouts/entries, no fit) — restored
     *  before every (re)generate so packing stays scoped to the region. */
    plateSnap: string
  } | null>(null)

  /** Full product data per binding (price ₹, thumbnail) — the item itself only
   *  carries id/name; the selection card + category plan need the rest. */
  const [bindings, setBindings] = useState<Map<string, BindingInfo>>(() => new Map())
  // Live mirror so the []-memoized merge closure re-binds against the CURRENT prices.
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings

  const bindProduct = (it: FurnitureItem, product: OfficeProduct) => {
    it.productId = product.id
    it.productName = product.name
    setBindings((prev) =>
      new Map(prev).set(product.id, {
        price: Number.isFinite(product.price) && product.price > 0 ? product.price : null,
        image: product.image ?? null,
        // Real supplier (live bank supplier_domain) → Takeoff Supplier column;
        // `vendor` is the brand, used as a fallback when there's no supplier.
        supplier: product.supplier ?? null,
        brand: product.vendor ?? null,
      }),
    )
    drawCanvasRef.current?.refresh()
    setDrawVer((v) => v + 1)
  }

  /** A generated component was re-imagined to a bank/mock product: mirror the
   *  binding into the takeoff `bindings` map (price/image/supplier/brand) so the
   *  Quantity Takeoff resolves it — `ec.assignProduct` only stores it in core.
   *  Additive/idempotent per product id; safe on repeated clicks. */
  const assignPanelProduct = (p: PanelProduct) => {
    setBindings((prev) =>
      new Map(prev).set(p.id, {
        price: p.price != null && Number.isFinite(p.price) && p.price > 0 ? p.price : null,
        image: p.image ?? null,
        supplier: p.supplier ?? null,
        brand: p.vendor ?? null,
      }),
    )
  }

  const onImportFile = async (file: File): Promise<Drawing | null> => {
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
      return d
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setImporting(false)
    }
  }

  /** Push an already-parsed Drawing into the editor — the wizard's resume path
   *  (a project reopened from its persisted draft). Mirrors the tail of
   *  onImportFile without re-running the DWG→DXF→parse pipeline. */
  const loadDrawing = (d: Drawing | null) => {
    // Update the ref SYNCHRONOUSLY, not just via the render-time mirror below.
    // `setDrawing` schedules; `drawingRef.current = drawing` only runs on the
    // next render — but the wizard's resume path calls `loadDrawing` and then
    // `testFit` in the same tick, so the ref was still null and the test-fit
    // built its plate from no drawing at all. That is what made a reloaded
    // Generate step search an empty plate.
    drawingRef.current = d
    setDrawing(d)
    setSelItem(null)
    setMode(d ? 'import' : '2d')
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
      ec.onChange = () => {
        setTick((t) => t + 1)
        noteChange(ec, 'edit') // undo/version ring (debounced/deduped in history.ts)
        // …and write the edit back to the open floor, so a plan opened from a
        // project behaves like a document rather than a scratch buffer.
        queueFloorSave()
      }
      ec.onRoom = (sel) => setRoomSel(sel)
      ec.coordEl = coordRef.current
      ec.scaleEl = scaleRef.current
      ec.refresh()
      // dev __ec seam lives in EditorCanvas.create itself
      setReady(true)
    })
    return () => {
      disposed = true
      inst?.dispose()
    }
  }, [])

  // Save the whole session (document snapshot incl. CAD layer, program,
  // import session, view hints) to a local .dsource file. Routed through a
  // ref so the []-dep keydown effect below always calls the fresh closure.
  const onSave = () => {
    const ec = ecRef.current
    if (!ec) return
    saveProject({ ec, drawing, bindings, ui: { mode } })
  }
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  const projectFileRef = useRef<HTMLInputElement>(null)
  /** Make a parsed DSourceFile the live session — shared by "Open" (file
   *  picker) and the plan library, so restore semantics can never drift. */
  const applyOpenedFile = (ec: EditorCanvas, f: DSourceFile) => {
    applyProject(ec, f) // document snapshot + program (core state)
    setDrawing(f.drawing ?? null) // React-owned import session
    // Product-binding prices/thumbnails ride alongside the drawing —
    // restore (or clear) so a reopened import session keeps its ₹ data.
    setBindings(new Map(Object.entries(f.bindings ?? {})))
    setSelItem(null)
    // Best-effort UI restore — fall back safely when hints are absent. The raw
    // import-staging view (mode 'import') only exists while the document is empty;
    // once a fit was placed, the plan lives in the ONE Document, so restore to 2D.
    const m = f.ui?.mode
    const savedEmpty =
      ec.getMetrics().wall_count === 0 &&
      ec.getMetrics().component_count === 0 &&
      ec.cad.store.entities.length === 0
    setMode(m === '3d' ? '3d' : m === 'import' && f.drawing && savedEmpty ? 'import' : '2d')
  }

  const onOpenProject = async (file: File) => {
    const ec = ecRef.current
    if (!ec) return
    try {
      applyOpenedFile(ec, await openProject(file))
      setCurrentPlanId(null) // a picked file is not a library record
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e))
    }
  }

  // ----- Plan library (IndexedDB) — docs/design/plan-library.md -----
  const refreshLibrary = async () => {
    setPlans(await listPlans())
    setHistory(await listHistory())
  }

  /** Cloud plan sync (design §5): push local changes + pull remote, then
   *  reflect any pulls back into the list. `silent` swallows failures (the
   *  auto-sync path) — the manual button surfaces the error in the status. */
  const syncLibrary = async (silent = false) => {
    if (syncingRef.current) return
    syncingRef.current = true
    if (!silent) setSyncing(true)
    try {
      const result = await syncPlans()
      setSyncState(result)
      if (result.pulled > 0) await refreshLibrary()
    } finally {
      syncingRef.current = false
      setSyncing(false)
    }
  }

  useEffect(() => {
    if (panelTab !== 'library') return
    void refreshLibrary().then(() => syncLibrary(true)) // auto-sync, best-effort
    // Ask the browser to exempt our origin from storage eviction (design M5;
    // idempotent, safe to re-request).
    void navigator.storage?.persist?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelTab])

  const saveCurrentToLibrary = async (name: string) => {
    const ec = ecRef.current
    if (!ec) return
    const thumb = renderThumb(ec.getState(), 200, 140)
    const saved = buildSavedPlan(ec, name, { drawing, bindings, ui: { mode }, thumb })
    await putPlan(saved)
    setCurrentPlanId(saved.id) // the live doc IS this record now
    await refreshLibrary()
  }

  /**
   * Persist edits back to the OPEN FLOOR.
   *
   * Until now nothing did. `noteChange` wrote only to the `history` ring (a
   * capped undo buffer), and the topbar "Save" downloaded a .dsource file — so a
   * user could open a floor from their project, edit it, press the button
   * labelled Save, and lose the work on reload. Measured: 133 components →
   * delete one → 132 → reload → 133, with a file downloaded in between and no
   * warning anywhere.
   *
   * A floor opened from a project is now saved like a document, not like a file:
   * every change writes the snapshot back to its own record, keyed on the id
   * already open. Debounced so a drag doesn't hammer IndexedDB; the history ring
   * still captures every step, so undo and version-restore are unaffected.
   */
  const persistOpenFloor = async () => {
    const ec = ecRef.current
    const planId = currentPlanIdRef.current
    if (!ec || !planId) return // no floor open (scratch doc) → nothing to update
    const existing = await getPlan(planId)
    if (!existing) return // record deleted underneath us — don't resurrect it
    await putPlan({
      ...existing,
      file: buildProjectFile({ ec, drawing: drawingRef.current, bindings: bindingsRef.current, ui: { mode: modeRef.current } }),
      thumb: renderThumb(ec.getState(), 200, 140),
      updatedAt: new Date().toISOString(),
    })
  }
  const persistOpenFloorRef = useRef(persistOpenFloor)
  persistOpenFloorRef.current = persistOpenFloor

  /** Debounce the floor write so a drag doesn't hammer IndexedDB. Longer than
   *  the history ring's cadence — history wants every step for undo; the floor
   *  only needs to end up correct. */
  const floorSaveTimer = useRef<number | null>(null)
  const queueFloorSave = () => {
    if (floorSaveTimer.current !== null) clearTimeout(floorSaveTimer.current)
    floorSaveTimer.current = window.setTimeout(() => {
      floorSaveTimer.current = null
      void persistOpenFloorRef.current()
    }, 900)
  }

  /** LibraryPanel.onAssign — resolve the typed project name (case-insensitive
   *  reuse or mint, in persist/plans) and attach the plan as a floor. */
  const assignPlanToProject = async (planId: string, projectName: string, floorLabel: string) => {
    const proj = await resolveProject(projectName)
    await assignToProject(planId, proj.projectId, proj.projectName, { label: floorLabel })
    await refreshLibrary()
  }

  const saveCandidateToLibrary = async (c: Candidate) => {
    const ec = ecRef.current
    if (!ec) return
    const name = `Option · seed ${c.seed}`
    await putPlan(
      buildSavedPlan(ec, name, {
        drawing,
        bindings,
        ui: { mode },
        snapshot: c.snap as string,
        thumb: c.thumb,
      }),
    )
    await refreshLibrary()
  }

  /** Carry a chosen Generate-step candidate into the editor: make it live and
   *  save it as a project floor so it deep-links + persists. Mirrors
   *  saveCandidateToLibrary but sets the project link (workflow.md §2) and
   *  returns the id. Kept in render scope (fresh drawing/bindings) and
   *  reached from the memoized controller via a ref, like onSaveRef. */
  const openCandidateInEditor = async (
    c: Candidate,
    proj?: { id: string; name: string; floor: string },
  ): Promise<string | null> => {
    const ec = ecRef.current
    if (!ec) return null
    ec.applyCandidate(c.snap)
    const saved = buildSavedPlan(ec, proj ? `${proj.name} · ${proj.floor}` : `Option · seed ${c.seed}`, {
      drawing,
      bindings,
      ui: { mode: '2d' },
      snapshot: c.snap as string,
      thumb: c.thumb,
      project: proj ? { projectId: proj.id, projectName: proj.name, floor: { label: proj.floor, index: 0 } } : undefined,
    })
    await putPlan(saved)
    setCurrentPlanId(saved.id)
    setSelItem(null)
    setMode('2d')
    frameEditor() // frame the applied candidate on the deep-link into the editor
    if (panelTab === 'library') await refreshLibrary()
    return saved.id
  }
  const openCandidateRef = useRef(openCandidateInEditor)
  openCandidateRef.current = openCandidateInEditor

  const openSavedPlan = (p: SavedPlan) => {
    const ec = ecRef.current
    if (!ec) return
    // SavedPlan.file IS a v1 DSourceFile — same restore path as the file picker.
    applyOpenedFile(ec, p.file)
    setCurrentPlanId(p.id) // remember which record is open → floor switcher
    setPanelTab('plan')
    frameEditor() // frame the loaded saved plan (cold-reload of #/p/:pid/f/:planId)
  }

  const openedPlanRef = useRef<string | null>(null)

  const restoreHistory = async (e: HistoryEntry) => {
    const ec = ecRef.current
    if (!ec) return
    await restoreEntry(ec, e)
    await refreshLibrary()
  }

  // Global "?" opens the shortcut help; Escape closes it; ⌘S saves. Ignored
  // while typing so it never steals focus from search or program fields.
  //
  // NOT BOUND while the editor is hidden behind a wizard step (see `active`):
  // ⌘S here was writing a .dsource file from the Space upload screen.
  useEffect(() => {
    if (!active) return
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
  }, [active])

  // Hand the same active/hidden fact to the canvas, which owns Delete, Escape
  // and 'p' on its own window listeners. `setActive(false)` UNBINDS them.
  //
  // Transient overlays close too. They are React state on a component that never
  // unmounts, so an open command palette or help sheet SURVIVED navigation into
  // the wizard: invisible there (the whole subtree is display:none), then still
  // open when the user came back, over a screen they had since left. A hidden
  // editor holds no open overlays.
  useEffect(() => {
    ecRef.current?.setActive(active)
    if (!active) {
      setCmdkOpen(false)
      setHelpOpen(false)
    }
  }, [active, ready])

  // Success notices fade on their own; warnings stay until dismissed.
  useEffect(() => {
    if (plateNotice?.variant !== 'ok') return
    const t = window.setTimeout(() => setPlateNotice(null), 8000)
    return () => window.clearTimeout(t)
  }, [plateNotice])

  const ec = ecRef.current
  const selected = ready && ec ? ec.getSelected() : null
  const metrics = ready && ec ? ec.getMetrics() : null
  // CAD entities count as content too — otherwise the empty-state overlay sits
  // over the canvas and hijacks clicks while someone drafts on a blank sheet.
  const docEmpty =
    !!metrics &&
    metrics.wall_count === 0 &&
    metrics.component_count === 0 &&
    (ec?.cad.store.entities.length ?? 0) === 0

  // Open the floor named by the route (#/p/:pid/f/:planId) once the editor is
  // ready, via the SAME library open path (getPlan → openSavedPlan =
  // applyProject). This is now the PRIMARY way a user returns to their work —
  // the project library routes straight here via `chosenPlanId` — so it has to be
  // reliable, not best-effort.
  //
  // The guards skip a redundant re-load of a plan that is already open, but they
  // are deliberately subordinate to the one condition that actually matters: IS
  // THE DOCUMENT EMPTY? EditorView is never unmounted, so `openedPlanRef` and
  // `currentPlanId` outlive any number of navigations, while the wasm doc can be
  // emptied underneath them — a Generate run clears it. Re-entering the same
  // floor afterwards hit the latch, returned early, and left the user staring at
  // an empty canvas under the "trace your imported plan" empty state. Keying on
  // the doc makes this self-correcting and idempotent: it loads exactly when
  // there is nothing to show, and never otherwise.
  useEffect(() => {
    if (!ready || !openPlanId) return
    const alreadyOpen = openPlanId === currentPlanId || openPlanId === openedPlanRef.current
    if (alreadyOpen && !docEmpty) return
    openedPlanRef.current = openPlanId
    void getPlan(openPlanId).then((p) => {
      if (p) openSavedPlan(p)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, openPlanId, currentPlanId, docEmpty])

  const pickTool = (t: string) => {
    setTool(t)
    ec?.setTool(t)
  }

  // ---- Command palette + shortcuts (M2) — ONE registry drives both --------
  // Derived from the same CAD_RAIL/CATALOG the tool rail renders (no duplicate
  // tool list). Rebuilt only if those arrays change (module constants → once).
  const commands = useMemo(() => buildCommands(CAD_RAIL, CATALOG), [])
  const letterMap = useMemo(() => letterShortcuts(commands), [commands])
  // Host callbacks a command runs — rebuilt each render so it closes over fresh
  // pickTool/setMode/ec; the []-dep keydown effect reaches it via a ref.
  const cmdCtx: CommandCtx = {
    setTool: pickTool,
    setMode,
    ec: () => ecRef.current,
    save: () => onSaveRef.current(),
    open: () => projectFileRef.current?.click(),
    fire: fireTestId,
  }
  const runCommand = (c: Command) => c.run(cmdCtx)
  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand
  // Live mirrors for the []-dep window handler (avoid re-binding on every state).
  const cmdkOpenRef = useRef(cmdkOpen)
  cmdkOpenRef.current = cmdkOpen
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Live mirrors so the async frame-on-open path (frameEditor/tryFrameEditor) reads
  // the current mode/ready/doc-content, not the values captured when it was queued.
  const readyRef = useRef(ready)
  readyRef.current = ready
  const docEmptyRef = useRef(docEmpty)
  docEmptyRef.current = docEmpty

  // After a load/generate replaces the document, frame the whole plan so it sits
  // centered and fully visible — otherwise the fixed default view leaves a large
  // plate off-screen or a small one as a corner sliver, reading as a blank canvas.
  //
  // Framing must run when the 2D canvas is at its FINAL laid-out size: the plan
  // callers (openSavedPlan, generate, trace) all `setMode('2d')` right before this,
  // and setMode is async — so at call time modeRef is stale AND the doc isn't
  // committed, meaning the stats panel isn't mounted yet and the canvas is full
  // width. Framing then fits the plate to the wrong extent and lands it off-center
  // (the cold-reload-into-3D symptom). So `frameEditor` only latches a request; the
  // effect below fires it once mode/ready/docEmpty settle — by which point the 2D
  // canvas is shown with the panel mounted and its real width. `frameContent`
  // itself retries via rAF if it still measures a not-yet-sized viewport.
  const pendingFrameRef = useRef(false)
  const tryFrameEditor = () => {
    if (modeRef.current === '2d' && readyRef.current && !docEmptyRef.current) {
      pendingFrameRef.current = false
      ecRef.current?.frameContent()
    }
  }
  const frameEditor = () => {
    pendingFrameRef.current = true
    tryFrameEditor() // frame now if the 2D canvas is already live; else the effect will
  }

  useEffect(() => {
    if (mode === '2d' && ready) ecRef.current?.refresh()
    if (pendingFrameRef.current) tryFrameEditor()
  }, [mode, ready, docEmpty])
  const letterMapRef = useRef(letterMap)
  letterMapRef.current = letterMap

  // ⌘K / Ctrl+K toggles the palette (works anywhere IN THE EDITOR). Single-letter
  // tool shortcuts fire only in 2D, with no modifier, when not typing and the
  // palette is closed. Presentation 'P' is intentionally NOT here —
  // EditorCanvas.onKey owns it (re-wiring would toggle twice); `letterShortcuts`
  // already excludes it.
  //
  // NOT BOUND while the editor is hidden (see `active`): "anywhere" used to
  // include the wizard, so ⌘K opened the editor's tool palette over the Space
  // step.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen((o) => !o)
        return
      }
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing || cmdkOpenRef.current) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (modeRef.current !== '2d') return
      const cmd = letterMapRef.current.get(e.key.toLowerCase())
      if (cmd) {
        e.preventDefault()
        runCommandRef.current(cmd)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // The grouped tool dock's data — assembled from the SAME sources the flat rail
  // used (select/wall + CATALOG + CAD_RAIL), so there is still one tool list.
  // `shortcut` mirrors the letters the old rail badges showed; M2 owns the real
  // key map, so when it exports one, source these from there instead. `meta` is
  // the non-shortcut hint the rail already surfaced (place size, 'CAD', radius).
  const TOOL_SHORTCUT: Record<string, string> = { select: 'V', wall: 'W' }
  const dockTools: DockTool[] = [
    { id: 'select', icon: 'select', label: 'Select', shortcut: TOOL_SHORTCUT.select },
    { id: 'wall', icon: 'wall', label: 'Wall', shortcut: TOOL_SHORTCUT.wall },
    ...CATALOG.map((it) => ({
      id: `place:${it.category}`,
      icon: it.icon,
      label: it.label,
      meta: `${it.w} × ${it.h} m`,
      swatch: it.color,
    })),
    ...CAD_RAIL.map((t) => ({
      id: `cad:${t.id}`,
      icon: t.icon,
      label: t.label,
      meta: t.hint,
    })),
  ]

  /** The qbiq loop: extract the imported floor plate → seed the document with
   *  its boundary walls → jump to 2D where the autonomous generator runs
   *  inside the real building shell. */
  const testFitPlan = (opts?: TestFitOpts) => {
    // Read live via refs — the controller memoizes this closure once (deps []),
    // so the render-scoped `ec`/`drawing` would be stale when called from Next.
    const ec = ecRef.current
    const drawing = drawingRef.current
    if (!ec || !drawing) return
    // Area-select (workflow.md §3.1): restrict the plate/keepouts/entries to the
    // selected sub-area. Non-destructive — the full `drawing` stays as-is.
    const hasArea = !!opts?.areaPolygon && opts.areaPolygon.length >= 3
    const restricted = hasArea ? restrictDrawing(drawing, opts!.areaPolygon!) : drawing
    // S4 wall-heal (workflow.md §3.3): bridge near-miss partition gaps so the
    // plate/keepout/entry traces close cleanly. Default on (identity when off or
    // nothing to heal), so every downstream extract sees the same healed linework
    // the Space step's readouts previewed.
    const working = opts?.heal === false ? restricted : healWalls(restricted)
    // Plate derivation (shared with the Space-step readouts via `derivePlate`, so
    // the usable area a user saw is exactly what gets fitted). For an AREA
    // selection the plate matches the lassoed region clipped to the floor — not a
    // tight hull around whichever furniture the lasso caught.
    const plate = derivePlate(drawing, opts?.areaPolygon, opts?.heal !== false)
    if (!plate) {
      setImportErr('No wall geometry found in this drawing to derive a floor plate from.')
      return
    }
    // Room markers (workflow.md §3.2): project into editor coords (plate offset
    // applied, like entries) and stash so the takeoff Room ID + AI resolve refs.
    roomMarkersRef.current = (opts?.markers ?? []).map((m) => ({
      ref: m.ref,
      x: m.x - plate.offset.x,
      y: m.y - plate.offset.y,
    }))
    const m = ec.getMetrics()
    // The wizard OWNS this document (it built the plate), so it replaces silently.
    // Only a user-driven import into a hand-built doc asks to confirm the replace.
    if (
      !opts?.silent &&
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
    pushKeepoutsToEditor(ec, extractKeepouts(working, plate))
    // Layout mode (Space step "Fresh fit / Keep existing walls").
    //
    // DEFAULT — Fresh fit: generate into the BASE SHELL (perimeter + cores +
    // entries), NOT around the existing tenant fit-out. The imported interior
    // partitions ARE the old layout we're replacing, and treating them as hard
    // obstacles would starve the new room program into the wall-free gaps
    // (sparse, unprofessional plans). This mirrors qbiq/Laiout, which fit the
    // shell. The partitions stay in `drawing` for the as-drawn reference view.
    //
    // OPT-IN — Keep existing walls (opts.keepExisting): push the imported
    // interior partitions so generate() fits the new furniture/rooms AROUND the
    // current fit-out. This is the DELIBERATE INVERSE of the fresh-fit default;
    // the generator already treats non-boundary walls as packing obstacles, so
    // pushing them is the whole mechanism. Use the same `working` drawing the
    // plate was traced from so heal/area settings are honored consistently.
    //
    // Deliberately drafted CAD walls still block packing via commitCadToPlan.
    if (opts?.keepExisting) {
      pushInteriorWallsToEditor(ec, extractInteriorWalls(working, plate))
    }
    // Entry points (boundary doors, else the longest-edge midpoint) anchor the
    // generator's circulation spine and reception placement.
    pushEntriesToEditor(ec, extractEntries(working, plate))
    // Anchor pins (workflow.md §3.5): forced room placements, projected into
    // editor coords with the plate offset (like markers), pushed so the next
    // generate() places each pinned room FIRST at (near) its point.
    pushAnchorsToEditor(ec, opts?.anchors ?? [], plate)
    ec.sync()
    // Merge-into-plan (design: merge-into-plan). For a SUB-AREA test-fit, stash the
    // selection ring + plate offset + this clean region-plate snapshot so
    // `runGenerate` can (a) run every (re)generate on the region alone — restoring
    // this snapshot first, so a prior merge's surrounding walls never widen the
    // packed plate — and (b) stamp the imported plan's surroundings back around the
    // generated region afterward, yielding ONE unified, editable document where only
    // the selected area is re-fitted. A whole-plate test-fit merges nothing (full
    // replace, as before): clear the context.
    mergeCtxRef.current =
      hasArea && opts?.areaPolygon
        ? { selection: opts.areaPolygon, offset: plate.offset, plateSnap: ec.snapshot() }
        : null
    // Plate-quality feedback. `coverage`/`areaM2` are additive optional fields
    // on PlateResult — guard so this works whether or not they're present.
    const { coverage, areaM2 } = plate as PlateResult & { coverage?: number; areaM2?: number }
    // Scale the default program to the traced plate: count the actual
    // furniture in the drawing (bench desks, meeting clusters) and fall back
    // to NBC-informed area heuristics. Only nudge when the user hasn't
    // customized desks.
    let suggested: string | null = null
    if (areaM2 && areaM2 > 100 && ec.program.desks === DEFAULT_PROGRAM.desks) {
      // wasm is initialised by this point (ec exists), so the core can answer;
      // the ?? guard is for the type, not a fallback policy.
      const share = openShare()
      if (share != null) ec.program = suggestProgram(working, areaM2, ec.program, share)
      suggested = suggestProgramSummary(ec.program)
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
        setPlateNotice({ variant: 'ok', msg: suggested ? `${traced} — ${suggested}.` : `${traced}.` })
      }
    } else {
      setPlateNotice(null)
    }
    setMode('2d')
    frameEditor() // frame the freshly-traced plate so the editor shows it
  }

  /** Merge-into-plan (design: merge-into-plan). Turn each region-only test-fit
   *  candidate into a merged document = the generated region fit (kept native, so
   *  its zones/room labels/glazing survive) PLUS the imported plan's surroundings
   *  stamped around it (furniture + shell walls outside the selection, translated
   *  into editor coords; furniture inside the selection dropped). Leaves the merged
   *  BEST candidate live. No-op unless the last test-fit was for a sub-area. Reads
   *  live state via refs so the []-memoized controller closure never goes stale. */
  const mergeCandidatesIntoPlan = (ec: EditorCanvas, candidates: Candidate[]) => {
    const mc = mergeCtxRef.current
    const drawing = drawingRef.current
    if (!mc || !drawing || candidates.length === 0) return
    const stamp = baseStampAround(drawing, mc.selection, mc.offset)
    for (const c of candidates) {
      ec.applyCandidate(c.snap) // restore this candidate's region-only fit
      stampBaseInto(ec, stamp, bindingsRef.current) // + the untouched rest of the floor
      c.snap = ec.snapshot() // now one merged document
    }
    // Keep the merged best-scoring option live (candidates stay in strategy order).
    const best = candidates.reduce((a, b) => (b.score.total > a.score.total ? b : a))
    ec.applyCandidate(best.snap)
  }

  /**
   * The one-action deliverable pack (gate G10): the 12-sheet workbook, the
   * master plan, the per-room thumbnails, ground truth, the four hero stills,
   * the walkthrough video and a share link — from a single click, wherever the
   * app is running (see `export/deliverablePack.ts` for the sink split).
   *
   * With nothing open it first generates the SAMPLE test-fit, which is the very
   * document `scripts/lib/demo-doc.mjs` renders — one plan definition, so what
   * a visitor exports is what the gates measure.
   *
   * Assigned to a ref every render so the []-memoized controller closure reads
   * the live project + bindings rather than the first render's.
   */
  const runDeliverablePack = async (
    onProgress: PackProgressFn = () => {},
  ): Promise<DeliverablePackResult> => {
    const ec = ecRef.current
    if (!ec) throw new Error('The editor is still starting up — try again in a moment.')
    let plate: [number, number][] | null = null
    if (ec.getState().walls.length === 0) {
      onProgress({ stage: 'workbook', label: 'Generating a sample test-fit', fraction: 0 })
      plate = seedSamplePlan(ec)
      setProgramVersion((v) => v + 1) // the doc changed under React
      frameEditor()
    }
    const state = ec.getState()
    return buildDeliverablePack(
      {
        state,
        quantities: ec.ed.quantities() as Quantities,
        // Raw, so a server-side renderer classifies with the app's own
        // `classifyWalls` instead of trusting a pre-chewed list.
        wallTypes: ec.ed.wall_types(),
        qto: {
          bindings: bindingsRef.current,
          floor: project?.floor ?? '1',
          project: project?.name ?? 'Untitled Plan',
          roomRefs: buildRoomRefs(state.zones ?? [], roomMarkersRef.current),
          // `circulation()` is degenerate with 0 walls (CLAUDE.md) — guard it.
          circulation: state.walls.length > 0 ? ec.circulation() : null,
          wallSpans: classifyWalls(state, ec.ed.wall_types() as never),
          plate,
        },
        name: project?.name ?? 'DSource test-fit',
      },
      await detectPackSink(),
      onProgress,
    )
  }
  const deliverablePackRef = useRef(runDeliverablePack)
  deliverablePackRef.current = runDeliverablePack

  // Controller seam (workflow.md §1) — thin lifts of the closures above, so
  // the shell/wizard can drive the editor while its internals stay untouched.
  useImperativeHandle(
    ref,
    (): EditorController => ({
      importFile: onImportFile,
      loadDrawing,
      hasDrawing: () => !!drawingRef.current,
      testFit: testFitPlan,
      setProgram: (p) => {
        if (ecRef.current) ecRef.current.program = { ...p }
        setProgramVersion((v) => v + 1)
      },
      runGenerate: (program, o) => {
        const ec = ecRef.current
        if (!ec) return null
        const mc = mergeCtxRef.current
        // Merge-into-plan (design: merge-into-plan): re-fit the SELECTED region
        // alone — restore the clean region plate so a prior merge's surrounding
        // walls never widen the packed area on a Regenerate.
        if (mc) ec.restore(mc.plateSnap)
        const res = ec.autoGenerate(program, {
          maxIter: o?.maxIter ?? 18,
          target: o?.target ?? 82,
          keepConfirmed: o?.keepConfirmed ?? false,
        })
        // Stamp the imported plan's surroundings back around each candidate's
        // region-only fit, so opening ANY candidate (and the live best) yields one
        // unified document. No-op for a whole-plate test-fit (`mc` null → replace).
        mergeCandidatesIntoPlan(ec, res.candidates)
        frameEditor() // frame the generated plan when the wizard lands in the editor
        return res
      },
      openCandidate: (c, proj) => openCandidateRef.current(c, proj),
      setMode,
      ec: () => ecRef.current,
      drawingCanvas: () => drawCanvasRef.current,
      roomRefs: () => buildRoomRefs(ecRef.current?.getState().zones ?? [], roomMarkersRef.current),
      deliverablePack: (onProgress) => deliverablePackRef.current(onProgress),
    }),
    [],
  )

  return (
    <div className="app">
      <header className="topbar">
        {/* Persistent context + the way out (ui-system.md §2.1). Every segment is
            a real link. Until now the editor had NO route back to the project or
            the library — the brand and project name were plain <span>s, so once a
            user opened a fit the browser Back button was the only exit. */}
        <nav className="brand" aria-label="Breadcrumb">
          <button
            className="brand-home"
            onClick={() => navigate({ name: 'projects' })}
            data-testid="crumb-home"
            title="All projects"
          >
            <span className="brand-mark" aria-hidden />
            <span className="brand-name">DSOURCE</span>
          </button>
          {project && (
            <>
              <span className="crumb-sep" aria-hidden>
                /
              </span>
              <button
                className="crumb-link"
                onClick={() => navigate({ name: 'wizard', projectId: project.id, step: 'space' })}
                data-testid="crumb-project"
                title="Back to this project's setup"
              >
                {project.name || project.propertyName}
              </button>
            </>
          )}
          <span className="crumb-sep" aria-hidden>
            /
          </span>
          <span className="crumb-current" data-testid="crumb-floor">
            {project?.floor || 'Untitled Plan'}
          </span>
        </nav>
        <div className="topbar-right">
          <div className="mode-toggle" role="group" aria-label="View mode">
            <button className={mode === '2d' ? 'seg on' : 'seg'} onClick={() => setMode('2d')} data-testid="mode-2d">
              2D
            </button>
            <button className={mode === '3d' ? 'seg on' : 'seg'} onClick={() => setMode('3d')} data-testid="mode-3d">
              3D
            </button>
            {/* The raw import-staging view exists only BEFORE a fit is placed. Once
                a test-fit exists, the plan lives entirely in the ONE Document (2D/3D
                project it), so the raw-drawing tab is retired to avoid a second,
                divergent truth. It reappears only while empty or mid-import. */}
            {drawing && (docEmpty || mode === 'import') && (
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
            <button className="export-btn" onClick={() => testFitPlan()} data-testid="testfit-plan">
              Test-fit this plan
            </button>
          )}
          {/* These two move a FILE to and from disk. They were labelled "Save" /
              "Open", which read as "save my work" — while the floor open in the
              editor was never written back at all, so pressing Save downloaded a
              file and lost the edit on reload. The floor now saves itself
              (persistOpenFloor); these say what they actually do. */}
          <button
            className="export-btn"
            onClick={onSave}
            data-testid="save-project"
            title="Download this plan as a .dsource file (⌘S). Your floor is saved automatically."
          >
            <Icon name="download" size={14} /> Download
          </button>
          <button
            className="export-btn"
            onClick={() => projectFileRef.current?.click()}
            data-testid="open-project"
            title="Open a .dsource file from disk"
          >
            Open file…
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
            // Importing swaps the reference drawing under the open floor. That
            // was survivable when nothing wrote back to the floor record; now
            // that a floor autosaves (persistOpenFloor), the next edit would
            // quietly commit a DIFFERENT building into the floor the user
            // opened. Ask first — but only when there is something to lose.
            onClick={() => {
              const hasWork = !docEmpty || !!drawing
              if (currentPlanId && hasWork) {
                const floor = project?.floor ? `“${project.floor}”` : 'this floor'
                const ok = window.confirm(
                  `Import a different plan into ${floor}?\n\n` +
                    `It replaces the CAD drawing behind the current fit-out, and ${floor} ` +
                    `is saved automatically — so this becomes part of it.\n\n` +
                    `To keep the current one, cancel and use Download first.`,
                )
                if (!ok) return
              }
              fileRef.current?.click()
            }}
            disabled={importing}
            aria-label="Import a DWG or DXF plan"
            title="Import a DWG or DXF plan — replaces the drawing behind this floor"
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
          <ExportMenu ec={ec} mode={mode} drawing={drawing} bindings={bindings} candidates={candidates} roomMarkers={roomMarkersRef} project={project} onOpenSheets={() => setSheetsOpen(true)} />
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
          {/* Every tool here draws on the 2D plan. In 3D they were still lit and
              clickable but did nothing, with no explanation — now they say why. */}
          <ToolDock
            tools={dockTools}
            active={tool}
            onPick={pickTool}
            disabled={mode !== '2d'}
            disabledReason={mode === '3d' ? 'Switch to 2D to draw' : 'Switch to 2D to draw'}
          />
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
            {mode === '2d' && ready && ec && !docEmpty && (
              <button
                className={ec.presentation ? 'present-toggle on' : 'present-toggle'}
                onClick={() => ec.setPresentation(!ec.presentation)}
                title="Presentation mode (P)"
                data-testid="presentation-toggle"
              >
                Paper
              </button>
            )}
            {mode === '3d' && ready && ec && <Scene3D state={ec.getState()} zoneAreas={ec.getZoneAreas()} />}
            {mode === 'import' && drawing && (
              <DrawingView
                drawing={drawing}
                onSelect={setSelItem}
                onChange={() => setDrawVer((v) => v + 1)}
                onCanvas={(c) => {
                  drawCanvasRef.current = c
                  // `window.__dc` is owned by DrawingView now (it resolves to the
                  // VISIBLE canvas of however many are mounted), so nothing to set.
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
                onTestFit={() => testFitPlan()}
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
          {mode === '2d' && roomSel && ec && <RoomTools ec={ec} zone={roomSel.zone} box={roomSel.box} />}
        </main>

        <aside className="inspector">
          {mode === 'import' && drawing ? (
            <ImportPanel
              drawing={drawing}
              item={selItem}
              onBind={bindProduct}
              bindings={bindings}
              onPlace={(spec) => drawCanvasRef.current?.beginPlace(spec)}
              onPickItem={(name) => {
                const it = drawing.furniture.find((f) => f.name === name)
                if (!it) return
                // Route through the canvas so highlight/anchor stay in sync.
                if (drawCanvasRef.current) drawCanvasRef.current.select(it)
                else setSelItem(it)
              }}
            />
          ) : selected && ec ? (
            <>
              <ObjectInspector ec={ec} />
              <ReimaginePanel ec={ec} c={selected} onAssign={assignPanelProduct} />
            </>
          ) : ec ? (
            <>
              <div className="stat-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={panelTab === 'plan'}
                  className={panelTab === 'plan' ? 'stat-tab on' : 'stat-tab'}
                  onClick={() => setPanelTab('plan')}
                  data-testid="tab-plan"
                >
                  Plan
                </button>
                <button
                  role="tab"
                  aria-selected={panelTab === 'bom'}
                  className={panelTab === 'bom' ? 'stat-tab on' : 'stat-tab'}
                  onClick={() => setPanelTab('bom')}
                  data-testid="tab-bom"
                >
                  BOM
                </button>
                <button
                  role="tab"
                  aria-selected={panelTab === 'library'}
                  className={panelTab === 'library' ? 'stat-tab on' : 'stat-tab'}
                  onClick={() => setPanelTab('library')}
                  data-testid="tab-library"
                >
                  Library
                </button>
              </div>
              {panelTab === 'bom' ? (
                <BomPanel ec={ec} />
              ) : panelTab === 'library' ? (
                <>
                <LibraryPanel
                  plans={plans}
                  onLoad={openSavedPlan}
                  onCompare={(a, b) =>
                    setCompare({
                      cmp: comparePlans(
                        { snapshot: a.file.snapshot, name: a.name },
                        { snapshot: b.file.snapshot, name: b.name },
                      ),
                      a,
                      b,
                    })
                  }
                  onDelete={(id) => void deletePlan(id).then(refreshLibrary)}
                  onRename={(id, name) => {
                    const p = plans.find((x) => x.id === id)
                    if (!p) return
                    void putPlan({ ...p, name, updatedAt: new Date().toISOString() }).then(
                      refreshLibrary,
                    )
                  }}
                  onSaveCurrent={(name) => void saveCurrentToLibrary(name)}
                  history={history}
                  onRestore={(e) => void restoreHistory(e)}
                  renderHistoryThumb={(e) => snapshotThumb(e.snapshot)}
                  onExport={(p) =>
                    triggerDownload(
                      new Blob([JSON.stringify(p.file)], { type: 'application/json' }),
                      `${p.name.replace(/[^\w.-]+/g, '-')}.dsource`,
                    )
                  }
                  onAssign={(id, name, floor) => void assignPlanToProject(id, name, floor)}
                  current={currentPlanId ? { planId: currentPlanId } : undefined}
                  onSync={() => void syncLibrary(false)}
                  syncState={syncState}
                  syncing={syncing}
                />
                {cloudEnabled() && <CloudSyncPanel onChanged={refreshLibrary} />}
                </>
              ) : mode === '3d' ? (
                // The inspector follows the MODE. It used to show the 2D canvas
                // card in 3D — Units / Grid / Axis / Background / Presentation,
                // all meaningless here — while the real 3D controls live in the
                // toolbar over the viewport. Stats are mode-independent, so they
                // stay; everything 2D-only goes.
                <>
                  <div className="panel-body" data-testid="view-props-3d">
                    <div className="panel-eyebrow">View</div>
                    <p className="inline-note">
                      Camera, lighting, quality and theme are on the toolbar over the model. Switch
                      to <strong>2D</strong> to draw, edit rooms, or bind products.
                    </p>
                  </div>
                  <StatsPanel ec={ec} />
                </>
              ) : (
                <>
                  <ObjectInspector ec={ec} />
                  {tool.startsWith('cad:') && (
                    <>
                      {ec.cad.store.entities.length > 0 && (
                        <button
                          className="cta-ghost"
                          data-testid="commit-sketch"
                          title="Convert drafted lines/polylines/rects into document walls"
                          onClick={() => {
                            const r = commitCadToPlan(ec)
                            setPlateNotice({
                              variant: 'ok',
                              msg: `${r.walls} wall${r.walls === 1 ? '' : 's'} committed to the plan${r.skipped ? ` · ${r.skipped} skipped (curves/annotation)` : ''}`,
                            })
                          }}
                        >
                          Commit sketch to plan
                        </button>
                      )}
                      <LayersCard ec={ec} />
                    </>
                  )}
                  <StatsPanel ec={ec} />
                  <GenerateCard
                    key={programVersion}
                    ec={ec}
                    metrics={metrics}
                    onSaveCandidate={saveCandidateToLibrary}
                    onCandidates={setCandidates}
                  />
                </>
              )}
            </>
          ) : null}
        </aside>
      </div>

      <footer className="statusbar">
        {/* Cursor position and drawing scale are 2D-plan facts. In 3D they were
            still being reported — stale numbers describing a view the user isn't
            looking at. The document totals on the right are mode-independent. */}
        <span className="sb-coord" style={{ visibility: mode === '2d' ? 'visible' : 'hidden' }}>
          <span className="sb-glyph">⌖</span>
          <span ref={coordRef} className="num">
            x —  y —
          </span>
        </span>
        {mode === '2d' && <span className="sb-dot" />}
        <span className="num muted" ref={scaleRef} style={{ visibility: mode === '2d' ? 'visible' : 'hidden' }}>
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
          <AgentPanel
            ec={ec}
            roomRefs={() => buildRoomRefs(ec.getState().zones ?? [], roomMarkersRef.current)}
            onClose={() => setAiOpen(false)}
          />
        </div>
      )}

      {cmdkOpen && (
        <CommandPalette
          commands={commands}
          onRun={runCommand}
          onClose={() => setCmdkOpen(false)}
        />
      )}
      {helpOpen && <ShortcutsOverlay onClose={() => setHelpOpen(false)} />}
      {/* M6 — sheets manager + publish. A thin controller over exportDrawingSet;
          the same export path as the "Drawing set" menu item, with editable
          title-block metadata + a sheet include list. */}
      {sheetsOpen && (
        <SheetsPanel
          ec={ec}
          project={project}
          drawing={drawing}
          bindings={bindings}
          onClose={() => setSheetsOpen(false)}
        />
      )}
      {compare && (
        <CompareView
          cmp={compare.cmp}
          onOpenSide={(side) => {
            openSavedPlan(side === 'a' ? compare.a : compare.b)
            setCompare(null)
          }}
          onClose={() => setCompare(null)}
        />
      )}
    </div>
  )
})

/** Layers card — shown while a CAD drafting tool is active. The store is the
 *  source of truth; interactions repaint the canvas via store.onChange and
 *  bump this card so the React side stays in step. */
function LayersCard({ ec }: { ec: EditorCanvas }) {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const store = ec.cad.store
  const counts = new Map<string, number>()
  for (const e of store.entities) {
    const l = e.layer ?? '0'
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  return (
    <LayersPanel
      layers={store.layers().map((name) => ({
        name,
        count: counts.get(name) ?? 0,
        visible: store.isVisible(name),
        active: name === store.activeLayer,
      }))}
      onToggle={(n) => {
        store.toggleLayer(n)
        bump()
      }}
      onSetActive={(n) => {
        store.setActiveLayer(n)
        bump()
      }}
      onAdd={(n) => {
        // a layer exists once it is active — new entities are stamped with it
        store.setActiveLayer(n)
        bump()
      }}
    />
  )
}

function ExportMenu({
  ec,
  mode,
  drawing,
  bindings,
  candidates,
  roomMarkers,
  project,
  onOpenSheets,
}: {
  ec: EditorCanvas | null
  mode: '2d' | '3d' | 'import'
  drawing: Drawing | null
  bindings: Map<string, BindingInfo>
  candidates: Candidate[]
  /** Editor-coord room markers captured at test-fit (ref → Room ID resolution). */
  roomMarkers: React.RefObject<EditorMarker[]>
  /** Active project — its identity brands the report + takeoff (workflow.md §2/§6). */
  project: ProjectRecord | null
  /** M6 — open the sheets manager (metadata + publish over the same set). */
  onOpenSheets: () => void
}) {
  const [open, setOpen] = useState(false)
  /** "Copy share link" feedback — the action publishes, so it needs a state. */
  const [share, setShare] = useState<{ phase: 'idle' | 'busy' | 'done' | 'saved' | 'error'; text?: string }>({
    phase: 'idle',
  })
  const importMode = mode === 'import' && !!drawing
  // Real project identity → exporter meta; falls back to the legacy placeholder
  // on the dev #/editor route (no project). (workflow.md §2 replaces App.tsx's
  // hard-coded 'Untitled Plan'/'1'.)
  const projectName = project?.name ?? 'Untitled Plan'
  const floorLabel = project?.floor ?? '1'

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
    if (importMode && drawing) {
      // Imported-plan sheet: drawing linework + spec headline (same ₹ math as
      // the sidebar's plan-by-category).
      void exportDrawingPDF(drawing, {
        boundCount: drawing.furniture.filter((f) => f.productId).length,
        specTotalInr: importSpecTotal(buildCategoryGroups(drawing, bindings)),
      })
    } else if (ec) {
      void exportPlanPDF(ec.getState(), ec.getMetrics(), { project: projectName })
    }
    setOpen(false)
  }

  const exportIfc = () => {
    if (!ec) return
    downloadIFC(ec.getState(), 'dsource-plan.ifc', { project: projectName })
    setOpen(false)
  }

  const exportObj = () => {
    if (!ec) return
    downloadOBJ(ec.getState(), 'dsource-plan') // emits .obj + .mtl
    setOpen(false)
  }

  /**
   * Publish the plan as a shareable web 3D link — DSource's answer to qbiq's
   * Autodesk-APS model link, on our own stack. The scene is the render
   * pipeline's own (`buildInteriorScene`), serialized to glTF-binary and PUT on
   * the server's share store; the client opens `/share/<id>` and orbits or walks
   * it. Deployments without a store (Vercel, no disk) hand the designer the
   * .glb itself rather than a link that would 404.
   */
  const copyShareLink = async () => {
    if (!ec || share.phase === 'busy') return
    setShare({ phase: 'busy' })
    try {
      const link = await publishShareLink(ec.getState(), { name: projectName })
      let copied = true
      try {
        await navigator.clipboard.writeText(link.url)
      } catch {
        copied = false // clipboard blocked (insecure origin / permission)
      }
      setShare({ phase: 'done', text: copied ? link.url : `Open ${link.url}` })
    } catch {
      try {
        await downloadPlanGlb(ec.getState(), `${projectName.replace(/\s+/g, '-')}.glb`)
        setShare({ phase: 'saved', text: 'No share server here — .glb downloaded' })
      } catch (e2) {
        setShare({ phase: 'error', text: e2 instanceof Error ? e2.message : String(e2) })
      }
    }
  }

  // qbiq-style multi-page report over the last A/B/C candidates (falls back to
  // the live plan as a single alternative when nothing has been generated).
  const exportReport = () => {
    const best = candidates.slice(0, 3)
    const alts = best.length
      ? best.map((c, i) => ({
          name: `Alternative ${'ABC'[i]} — ${STRATEGY_LABEL[c.strategy]}`,
          snapshot: c.snap as string,
        }))
      : ec
        ? [{ name: 'Alternative A', snapshot: ec.snapshot() }]
        : []
    if (alts.length)
      void exportSpacePlanningReport(alts, {
        project: projectName,
        client: project?.propertyName,
        address: project?.address,
        floor: project?.floor,
        logo: project?.logo,
      })
    setOpen(false)
  }

  // Multi-sheet architectural drawing set (cover · contents · demolition ·
  // construction + door/window schedule). Threads the ProjectRecord into the
  // title block and the imported `drawing` (when in an import session) so the
  // demolition plan can show existing-vs-demolished walls.
  const exportDrawingSetPdf = () => {
    if (!ec) return
    void exportDrawingSet(ec.getState(), {
      meta: {
        project: projectName,
        client: project?.propertyName,
        address: project?.address,
        floor: project?.floor,
        logo: project?.logo,
        studio: 'DSOURCE',
      },
      drawing,
      bindings,
      zoneAreas: ec.getZoneAreas(),
    })
    setOpen(false)
  }

  /**
   * The 12-sheet qbiq-parity Quantity Takeoff. ONE client-side action: the plan
   * graphic, the per-room thumbnails and every formula are produced in the
   * browser — no server round-trip.
   *
   * Wall runs / door counts / room areas come from `Editor.quantities()`, and
   * the plan is coloured from `Editor.wall_types()`, so the drawing and the
   * bill classify each wall identically.
   */
  const exportTakeoff = () => {
    if (!ec) return
    const state = ec.getState()
    // Room markers dropped in the Space step win the Room ID where they sit
    // inside a generated zone (workflow.md §3.2); re-resolved against live zones.
    const roomRefs = buildRoomRefs(state.zones ?? [], roomMarkers.current ?? [])
    void exportQtoWorkbook(state, ec.ed.quantities() as Quantities, qtoOpts(state, roomRefs))
    setOpen(false)
  }

  /** Inputs for the takeoff export. */
  function qtoOpts(state: DocState, roomRefs: Map<number, string>) {
    if (!ec) throw new Error('no editor')
    return {
      bindings,
      floor: floorLabel,
      project: projectName,
      roomRefs,
      // `circulation()` is degenerate with 0 walls (CLAUDE.md) — guard it.
      circulation: state.walls.length > 0 ? ec.circulation() : null,
      wallSpans: classifyWalls(state, ec.ed.wall_types() as never),
    }
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
          {!importMode && (
            <>
              <div
                className="export-item"
                role="menuitem"
                onClick={exportReport}
                data-testid="export-report"
              >
                Space planning report <span className="hint">multi-page PDF</span>
              </div>
              <div
                className="export-item"
                role="menuitem"
                onClick={exportDrawingSetPdf}
                data-testid="export-drawing-set"
              >
                Drawing set <span className="hint">multi-sheet PDF</span>
              </div>
              <div
                className="export-item"
                role="menuitem"
                onClick={() => {
                  onOpenSheets()
                  setOpen(false)
                }}
                data-testid="open-sheets"
              >
                Sheets… <span className="hint">manage + publish</span>
              </div>
              <div
                className="export-item"
                role="menuitem"
                onClick={exportTakeoff}
                data-testid="export-takeoff"
              >
                Quantity Takeoff <span className="hint">Excel · 12 sheets</span>
              </div>
            </>
          )}
          <div className="export-sep" />
          <div className="export-item" role="menuitem" onClick={exportIfc} data-testid="export-ifc">
            IFC model <span className="hint">BIM</span>
          </div>
          <div className="export-item" role="menuitem" onClick={exportObj} data-testid="export-obj">
            OBJ model <span className="hint">3D mesh</span>
          </div>
          <div className="export-item disabled" aria-disabled="true">
            RVT <span className="hint">via IFC</span>
          </div>
          {!importMode && (
            <div
              className={`export-item${share.phase === 'busy' ? ' disabled' : ''}`}
              role="menuitem"
              onClick={() => void copyShareLink()}
              data-testid="export-share-link"
              title={share.text ?? 'Publish this plan to a web 3D viewer and copy the link'}
            >
              {share.phase === 'busy'
                ? 'Publishing 3D model…'
                : share.phase === 'done'
                  ? 'Share link copied ✓'
                  : share.phase === 'saved'
                    ? 'Model downloaded'
                    : share.phase === 'error'
                      ? 'Share failed'
                      : 'Copy share link'}
              <span className="hint">
                {share.phase === 'idle' || share.phase === 'busy' ? 'web 3D viewer' : (share.text ?? '')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
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
            <button className="empty-btn primary ai-action" onClick={props.onTestFit}>
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
      ['⌘ / Ctrl K', 'Command palette'],
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
      ['L R C A', 'Line · Rectangle · Circle · Arc'],
      ['D T M', 'Dimension · Text · Move'],
      ['P', 'Presentation (paper) mode'],
      ['Scroll', 'Zoom · drag empty space to pan'],
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

function GenerateCard({
  ec,
  metrics,
  onSaveCandidate,
  onCandidates,
}: {
  ec: EditorCanvas
  metrics: Metrics | null
  onSaveCandidate?: (c: Candidate) => void
  onCandidates?: (c: Candidate[]) => void
}) {
  const [program, setProgram] = useState<Program>(ec.program)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenResult | null>(null)
  const [activeSeed, setActiveSeed] = useState<number | null>(null)
  const [verdicts, setVerdicts] = useState<Record<number, SoftVerdict> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [refine, setRefine] = useState<RefineOutcome | null>(null)
  const [refineBusy, setRefineBusy] = useState(false)
  const [aiReady, setAiReady] = useState(false)
  // Per-session (per mount) seed cursor: every Generate/Regenerate press advances
  // it so the search explores a genuinely different seed window → real variety,
  // while any exact (strategy, seed) stays deterministic. Window > maxIter (18).
  const SEED_WINDOW = 64
  const regenRef = useRef(0)

  useEffect(() => {
    let live = true
    void evaluatorAvailable().then((ok) => live && setAiReady(ok))
    return () => {
      live = false
    }
  }, [])

  const set = (patch: Partial<Program>) => setProgram((p) => ({ ...p, ...patch }))
  const confirmed = metrics?.confirmed ?? 0

  /** The soft-goal gallery pass (shared by Generate + Refine). */
  const evaluateGallery = (res: GenResult, prog: Program) => {
    setVerdicts(null)
    const gate = Math.min(82, Math.floor(res.best.total))
    void evaluateCandidates(res.candidates, prog, gate).then((ai) => {
      if (!ai) return
      setVerdicts(Object.fromEntries(ai.verdicts.map((v) => [v.seed, v])))
    })
  }

  const run = (keepConfirmed: boolean) => {
    if (ec.getState().walls.length === 0) {
      setNote('Draw a closed room boundary first, then generate.')
      return
    }
    setNote(null)
    setRefine(null)
    setBusy(true)
    const seedOffset = regenRef.current * SEED_WINDOW
    const regenerateRound = regenRef.current
    regenRef.current += 1
    window.setTimeout(() => {
      const t0 = performance.now()
      const res = ec.autoGenerate(program, { maxIter: 18, target: 82, keepConfirmed, seedOffset })
      // ADR 0005's sensor. `maxIter` is an allowance; this records the conduct —
      // and `earlyExitStrategies.length < 3` is the alarm for the plate where the
      // 129 ms search silently becomes a 1.9 s one.
      void logSearch({
        at: new Date().toISOString(),
        calls: res.spend.calls,
        earlyExitStrategies: res.spend.earlyExitStrategies,
        maxIter: res.spend.maxIter,
        target: res.spend.target,
        bestTotal: res.best.total,
        regenerateRound,
        ms: Math.round(performance.now() - t0),
      })
      setResult(res)
      setActiveSeed(res.seed)
      onCandidates?.(res.candidates) // lift to App for the report exporter
      setBusy(false)
      // Claude soft-goal evaluation. Gate = the best achieved score capped at
      // the hard target: when the search hits 82 the gate is vision-strict
      // (only passing plans spend tokens); when the room tops out below it,
      // the best candidates still get judged — junk never reaches the API
      // because the gallery already keeps only the top-K. Silently skipped
      // when no ANTHROPIC_API_KEY is configured.
      evaluateGallery(res, program)
    }, 16)
  }

  /** Autonomous reasoning: Claude SHAPES the plan (adjust program → regenerate →
   *  keep if better), iterating until it converges. No-op without a Claude key. */
  const runRefine = async () => {
    if (ec.getState().walls.length === 0) {
      setNote('Draw a closed room boundary first, then refine.')
      return
    }
    setNote(null)
    setRefineBusy(true)
    const seedOffset = regenRef.current * SEED_WINDOW
    regenRef.current += 1
    try {
      const out = await ec.refineWithAI(program, {
        maxIter: 18,
        target: 82,
        keepConfirmed: confirmed > 0,
        seedOffset,
      })
      setRefine(out)
      setResult(out.result)
      setActiveSeed(out.result.seed)
      setProgram(out.program) // reflect the AI's accepted adjustments in the form
      onCandidates?.(out.result.candidates)
      evaluateGallery(out.result, out.program)
    } finally {
      setRefineBusy(false)
    }
  }

  return (
    <div className="panel-body" style={{ borderTop: '1px solid var(--hairline)' }}>
      <DesignWithAI ec={ec} aiReady={aiReady} hasPlate={(metrics?.wall_count ?? 0) > 0} />

      <div className="panel-eyebrow ai-action" style={{ marginTop: 18 }}>
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
          style={{ accentColor: 'var(--accent)' }}
        />
        Bench desking (back-to-back pairs)
      </label>

      <button
        className="cta"
        onClick={() => run(false)}
        disabled={busy || refineBusy}
        data-testid="generate"
      >
        {busy ? 'Searching layouts…' : 'Generate test-fit'}
      </button>
      <button
        className="cta-refine"
        onClick={() => void runRefine()}
        disabled={busy || refineBusy || !aiReady}
        data-testid="generate-refine"
        title={
          aiReady
            ? 'Let Claude adjust the program and re-generate until it converges'
            : 'Needs an ANTHROPIC_API_KEY on the dev proxy'
        }
      >
        <Icon name="sparkles" size={13} />
        {refineBusy ? 'Refining with AI…' : 'Refine with AI'}
      </button>
      {result ? (
        <button
          className="cta-ghost"
          onClick={() => run(confirmed > 0)}
          disabled={busy || refineBusy}
          data-testid="regenerate"
        >
          {confirmed > 0 ? `Regenerate · keep ${confirmed} frozen` : 'Regenerate · fresh variety'}
        </button>
      ) : (
        <div className="freeze-tip">Confirm a component to freeze it, then regenerate around it.</div>
      )}
      {note && <div className="inline-note">{note}</div>}

      {refine && <RefineTrace out={refine} />}

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
          <ScoreBar label="Program fit" v={result.best.program_fit} />
          <ScoreBar label="Daylight" v={result.best.daylight} />
          <ScoreBar label="Entry" v={result.best.entry_adjacency} />
          <CandidateGallery
            candidates={result.candidates}
            activeSeed={activeSeed}
            verdicts={verdicts ?? undefined}
            onPick={(c) => {
              ec.applyCandidate(c.snap)
              setActiveSeed(c.seed)
              setResult((r) => (r ? { ...r, best: c.score } : r))
            }}
            onSave={onSaveCandidate}
          />
        </div>
      )}
    </div>
  )
}

/** Compact fallback description of a program delta when Claude omits a rationale. */
function describeDelta(d: {
  desks?: number
  meeting_rooms?: number
  target_corridor_m?: number
  cluster_cols?: number
  w_adjacency?: number
  w_circulation?: number
}): string {
  const parts: string[] = []
  if (d.desks !== undefined) parts.push(`desks→${d.desks}`)
  if (d.meeting_rooms !== undefined) parts.push(`meetings→${d.meeting_rooms}`)
  if (d.target_corridor_m !== undefined) parts.push(`corridor→${d.target_corridor_m}m`)
  if (d.cluster_cols !== undefined) parts.push(`cols→${d.cluster_cols}`)
  if (d.w_adjacency !== undefined) parts.push(`adjacency emphasis→${d.w_adjacency}`)
  if (d.w_circulation !== undefined) parts.push(`circulation emphasis→${d.w_circulation}`)
  return parts.join(', ') || 'no change'
}

/** The autonomous-reasoning trace: before→after yardstick + Claude's per-round
 *  rationale. Reuses the ConsequenceCard (cons-*) visual language. */
function RefineTrace({ out }: { out: RefineOutcome }) {
  if (!out.ranAI) {
    return (
      <div className="cons-card refine-trace" data-testid="refine-status">
        <div className="cons-eyebrow">AI refinement — skipped</div>
        <div className="cons-note info">
          Set ANTHROPIC_API_KEY on the dev proxy to let Claude reshape the plan.
        </div>
      </div>
    )
  }
  const delta = out.finalScore - out.baseScore
  const dir = delta > 0.05 ? 'up good' : delta < -0.05 ? 'down bad' : 'same neutral'
  const kept = out.steps.filter((s) => s.accepted).length
  return (
    <div className="cons-card refine-trace" data-testid="refine-status">
      <div className="cons-eyebrow">
        <Icon name="sparkles" size={12} /> AI refinement
      </div>
      <div className="refine-headline num">
        <span className="cons-before">{out.baseScore.toFixed(1)}</span>
        <span className={`cons-arrow ${dir}`}>{delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '='}</span>
        <span className={`cons-after ${out.improved ? 'good' : 'neutral'}`}>{out.finalScore.toFixed(1)}</span>
        <span className="refine-sub">
          {out.improved ? `improved · ${kept} kept` : 'no improvement found'}
        </span>
      </div>
      <div className="cons-notes">
        {out.steps.length === 0 ? (
          <div className="cons-note info">
            Claude judged the initial plan already optimal — no change proposed.
          </div>
        ) : (
          out.steps.map((s, i) => (
            <div key={i} className={`cons-note ${s.accepted ? 'info' : 'warn'}`}>
              <strong>#{s.iteration}</strong> {s.rationale || describeDelta(s.delta)}{' '}
              <span className="num">
                ({s.scoreBefore.toFixed(1)}→{s.scoreAfter.toFixed(1)}
                {s.accepted ? ' ✓' : ' reverted'})
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ------------------------------ Imported plan ----------------------------- */

/**
 * Materio-style "plan by category": group furniture by category, aggregate
 * items by name with bound-product price/image rolled in. Pure — shared by
 * the ImportPanel sidebar and the imported-plan PDF sheet (single source of
 * the ₹ aggregation math).
 */
export function buildCategoryGroups(
  drawing: Drawing,
  bindings: Map<string, BindingInfo>,
): CategoryPlanGroup[] {
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
}

/** Σ of the groups' rolled-up ₹ totals — null when nothing priced is bound. */
function importSpecTotal(groups: CategoryPlanGroup[]): number | null {
  const priced = groups.filter((g) => g.totalInr != null)
  return priced.length ? priced.reduce((s, g) => s + (g.totalInr as number), 0) : null
}

function ImportPanel({
  drawing,
  item,
  onBind,
  bindings,
  onPickItem,
  onPlace,
}: {
  drawing: Drawing
  item: FurnitureItem | null
  onBind: (it: FurnitureItem, p: OfficeProduct) => void
  bindings: Map<string, BindingInfo>
  onPickItem?: (name: string) => void
  onPlace?: (spec: PlaceSpec) => void
}) {
  const w = drawing.bounds[2] - drawing.bounds[0]
  const h = drawing.bounds[3] - drawing.bounds[1]
  const bound = drawing.furniture.filter((f) => f.productId).length
  const groups = buildCategoryGroups(drawing, bindings)

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

      <div className="metric-row" data-testid="import-spec-total">
        <span className="label">Specified furniture</span>
        <span className="value">
          {formatINR(importSpecTotal(groups))} · {bound} of {drawing.furniture.length} items
        </span>
      </div>
      <div className="freeze-tip">
        Click furniture to re-imagine it · drag to move · R rotate · Del delete · ⌘D duplicate · ⌘Z undo
      </div>

      {onPlace && <PlacePalette onPlace={onPlace} />}

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

/** The subset of a bank/mock product ReimaginePanel binds — structural so both
 *  the live `BankProduct` (brand + supplier + image) and the mock `Product`
 *  (brand only) satisfy it without a conversion. */
type PanelProduct = {
  id: string
  vendor: string
  price: number | null
  image?: string | null
  supplier?: string | null
}

function ReimaginePanel({
  ec,
  c,
  onAssign,
}: {
  ec: EditorCanvas
  c: DocComponent
  onAssign: (p: PanelProduct) => void
}) {
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
            onClick={() => {
              ec.assignProduct(c.id, p.id, p.name, p.price)
              onAssign(p)
            }}
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
              onClick={() => {
                ec.assignProduct(c.id, p.id, p.name)
                onAssign(p)
              }}
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
