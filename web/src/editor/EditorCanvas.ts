import init, { Editor } from '../wasm/ds_core'
import { catByCategory } from './catalog'
import { drawFurnitureSymbol } from './furniture'
import { CadController } from '../cad/controller'
import type { CadEntity, SnapContext } from '../cad/model'

// Types mirroring the Rust core's serialized document (serde field names).
export interface DocWall {
  id: number
  a: { x: number; y: number }
  b: { x: number; y: number }
  thickness: number
}
export interface DocComponent {
  id: number
  category: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  label: string
  product_id: string | null
  decision: 'Open' | 'InReview' | 'Confirmed'
}
export type ZoneType =
  | 'Circulation'
  | 'Workspace'
  | 'Meeting'
  | 'Collaboration'
  | 'Core'
  | 'ClosedOffice'
  | 'Amenity'
export type ZoneShape =
  | { kind: 'Rect'; x: number; y: number; w: number; h: number }
  | { kind: 'RectRing'; x: number; y: number; w: number; h: number; in_w: number; in_h: number }
export interface DocZone {
  id: number
  zone_type: ZoneType
  shape: ZoneShape
  label: string
  component_ids: number[]
}
export interface DocState {
  walls: DocWall[]
  components: DocComponent[]
  zones?: DocZone[]
  selection: number | null
}
export interface Metrics {
  floor_area: number
  wall_count: number
  component_count: number
  confirmed: number
  // Slice 2 additive Statistics-panel fields (optional for backward-compat).
  gross_external_area?: number
  net_internal_area?: number
  workstations?: number
  area_per_workstation?: number
  efficiency_pct?: number
  indicative_cost?: number
  /** Σ observed ₹ prices of bank-bound components (specified furniture capex). */
  specified_cost?: number
  indicative_carbon?: number
}
export interface ZoneStat {
  id: number
  zone_type: ZoneType
  label: string
  area: number
  capacity: number
  seated: number
  pct_of_nia: number
}

export type ToolId = string // 'select' | 'wall' | 'place:<Category>'

/** Test-fit program + objective weights (mirrors Rust `layout::Program`). */
export interface Program {
  desks: number
  meeting_rooms: number
  desk_w: number
  desk_h: number
  meeting_w: number
  meeting_h: number
  cluster_cols: number
  target_corridor_m: number
  desk_clearance_m: number
  /** Back-to-back paired desk rows (real-world bench desking). */
  bench_pairs: boolean
  w_capacity: number
  w_adjacency: number
  w_circulation: number
  w_density: number
}
export interface LayoutScore {
  capacity: number
  adjacency: number
  circulation: number
  density: number
  total: number
  placed_desks: number
}
export interface CirculationScore {
  score: number
  reachable_free_area: number
  floor_area: number
  circulation_ratio: number
  min_corridor_width: number
  mean_clearance: number
  pct_corridors_below_min: number
  largest_connected_free_region: number
  enclosed: boolean
  grid_cols: number
  grid_rows: number
  cell_size: number
}
/** One retained test-fit option from the autonomous search (Laiout-style gallery). */
export interface Candidate {
  seed: number
  score: LayoutScore
  /** Opaque document snapshot — pass to `applyCandidate` to make it live. */
  snap: unknown
  /** Small plan-schematic dataURL for the gallery card. */
  thumb: string
}
export interface GenResult {
  best: LayoutScore
  iterations: number
  seed: number
  /** Top-K distinct candidates, best first. */
  candidates: Candidate[]
}

/** Default program — the single source used by the generate card and the AI. */
export const DEFAULT_PROGRAM: Program = {
  desks: 20,
  meeting_rooms: 2,
  desk_w: 1.6,
  desk_h: 0.8,
  meeting_w: 3,
  meeting_h: 3,
  cluster_cols: 4,
  target_corridor_m: 1.2,
  desk_clearance_m: 0.9,
  bench_pairs: true,
  w_capacity: 0.35,
  w_adjacency: 0.2,
  w_circulation: 0.25,
  w_density: 0.2,
}

const GRID_M = 1 // 1-meter minor grid
const MAJOR_EVERY = 5 // heavier line every 5 m
const SNAP_M = 0.1 // 10 cm snap
const RULER = 22 // px ruler gutter (top + left)

// Light "floor-plate" palette — mirrors styles.css tokens (Laiout aesthetic).
const C = {
  surface: '#ffffff', // floor plate
  mat: '#f2f4f7', // outside the building footprint
  gridMinor: 'rgba(23,26,30,0.035)',
  gridMajor: 'rgba(23,26,30,0.075)',
  axis: 'rgba(45,91,214,0.20)',
  wall: '#2e343b',
  wallExt: '#1e2329',
  furniture: '#8a9099',
  preview: 'rgba(45,91,214,0.70)',
  accent: '#2d5bd6',
  label: '#1a1d21',
  rulerBg: '#ffffff',
  rulerCorner: '#f7f8fa',
  rulerText: '#9aa2ad',
  rulerTick: 'rgba(23,26,30,0.18)',
}

const DECISION_DOT: Record<string, string> = {
  Confirmed: '#2fa36b',
  InReview: '#e0952b',
  Open: '#9aa2ad',
}

// Zone fills keyed by ZoneType serde tag → { fill, line } (Laiout pastels).
const ZONE: Record<string, { fill: string; line: string }> = {
  Circulation: { fill: '#dcebfb', line: '#4a82c4' },
  Workspace: { fill: '#fbf3d6', line: '#b99527' },
  Meeting: { fill: '#e9e3f7', line: '#7e63c0' },
  Collaboration: { fill: '#def1e2', line: '#4b9e66' },
  Core: { fill: '#eceef1', line: '#8b939e' },
  ClosedOffice: { fill: '#fce6d6', line: '#cb8150' },
  Amenity: { fill: '#d9f0ef', line: '#3f9c95' },
}

/**
 * Owns the canvas: transforms, input, and 2D rendering. All document mutations
 * go through the Rust `Editor`; this class re-reads `state()` to draw. Rendering
 * is TS-side for now and migrates into a Rust/WebGL renderer later
 * (docs/adr/0001-rendering-staging.md).
 */
export class EditorCanvas {
  ed: Editor
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = Math.max(1, window.devicePixelRatio || 1)

  scale = 46 // px per meter
  offset = { x: 120, y: 96 } // screen px of world origin
  tool: ToolId = 'select'

  // Optional status-bar readouts updated by direct DOM writes (no React churn).
  coordEl: HTMLElement | null = null
  scaleEl: HTMLElement | null = null

  private wallStart: { x: number; y: number } | null = null
  private mouseWorld = { x: 0, y: 0 }
  private hasCursor = false
  private dragging = false
  private panning = false
  private lastScreen = { x: 0, y: 0 }

  onChange: (() => void) | null = null
  /** Last program used to generate — shared source for the generate card + AI. */
  program: Program = { ...DEFAULT_PROGRAM }
  /** CAD drafting layer (line/rect/arc/dimension/door/… + snapping). */
  cad!: CadController
  /** True while store.load() replays doc-owned cad_json (skip the write-back). */
  private cadHydrating = false

  private constructor(canvas: HTMLCanvasElement, ed: Editor) {
    this.canvas = canvas
    this.ed = ed
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.cad = new CadController({
      toScreen: (p) => this.toScreen(p.x, p.y),
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      pxPerM: () => this.scale,
      requestRender: () => this.render(),
      snapContext: () => this.buildSnapContext(),
      addComponent: (category, x, y, w, h, rotation) => {
        const id = this.ed.add_component(category, x, y, w, h)
        if (rotation) this.ed.set_component_rotation(id, rotation)
        this.commit()
      },
    })
    // The CAD layer rides the document as an opaque blob so snapshot()/restore()
    // (AI undo, candidate gallery) round-trip drafting geometry. The controller
    // hooked onChange → render; wrap it to also persist into the core.
    const cadRender = this.cad.store.onChange
    this.cad.store.onChange = () => {
      if (!this.cadHydrating) this.ed.set_cad_json(JSON.stringify(this.cad.store.entities))
      cadRender?.()
    }
    this.attach()
    this.resize()
    this.render()
  }

  static async create(canvas: HTMLCanvasElement): Promise<EditorCanvas> {
    await init()
    return new EditorCanvas(canvas, new Editor())
  }

  // ---- coordinate transforms ----
  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.offset.x) / this.scale, y: (sy - this.offset.y) / this.scale }
  }
  private toScreen(wx: number, wy: number) {
    return { x: wx * this.scale + this.offset.x, y: wy * this.scale + this.offset.y }
  }
  private snap(w: { x: number; y: number }) {
    return { x: Math.round(w.x / SNAP_M) * SNAP_M, y: Math.round(w.y / SNAP_M) * SNAP_M }
  }
  private buildSnapContext(): Omit<SnapContext, 'from'> {
    const st = this.getState()
    return {
      entities: this.cad.store.entities,
      walls: st.walls.map((wl) => ({ a: { x: wl.a.x, y: wl.a.y }, b: { x: wl.b.x, y: wl.b.y } })),
      components: st.components.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, rotation: c.rotation })),
      grid: 0.1,
      pxPerM: this.scale,
      tolPx: 10,
    }
  }

  // ---- API consumed by React ----
  getState(): DocState {
    return this.ed.state() as DocState
  }
  getMetrics(): Metrics {
    return this.ed.metrics() as Metrics
  }
  getZoneStats(): ZoneStat[] {
    const ed = this.ed as unknown as { zone_stats?: () => unknown }
    if (typeof ed.zone_stats !== 'function') return []
    return (ed.zone_stats() as ZoneStat[]) ?? []
  }
  getSelected(): DocComponent | null {
    const s = this.getState()
    if (s.selection == null) return null
    return s.components.find((c) => c.id === s.selection) ?? null
  }
  setTool(t: ToolId) {
    this.tool = t
    this.wallStart = null
    this.cad.setTool(t.startsWith('cad:') ? t.slice(4) : null)
    this.render()
  }
  assignProduct(id: number, productId: string, name: string, priceInr?: number | null) {
    this.ed.assign_product(id, productId, name, priceInr ?? undefined)
    this.commit()
  }
  setDecision(id: number, state: string) {
    this.ed.set_decision(id, state)
    this.commit()
  }
  deleteSelected() {
    this.ed.delete_selected()
    this.commit()
  }

  /** One deterministic test-fit for `seed`; mutates the document. */
  generateOnce(program: Program, seed: number, keepConfirmed = false): LayoutScore {
    return this.ed.generate(program, BigInt(seed), keepConfirmed) as LayoutScore
  }

  /**
   * Autonomous test-fit search: generate candidates across seeds, keep the
   * best-scoring one, early-stop once `target` total is met. Because the Rust
   * generator is deterministic per seed, we re-generate the winning seed at the
   * end so the document reflects the best candidate. This is the "recursive
   * until criteria met" loop on top of the deterministic engine.
   *
   * When `keepConfirmed` is set, Confirmed components are frozen and every
   * candidate packs around them (Freeze/Regenerate).
   */
  autoGenerate(
    program: Program,
    opts: { maxIter: number; target: number; keepConfirmed?: boolean; candidates?: number },
  ): GenResult {
    const keep = opts.keepConfirmed ?? false
    const topK = Math.max(1, opts.candidates ?? 4)
    this.program = { ...program }
    let best: LayoutScore | null = null
    let bestSeed = 1
    let iterations = 0
    const kept: Candidate[] = []
    for (let seed = 1; seed <= opts.maxIter; seed++) {
      iterations = seed
      const sc = this.ed.generate(program, BigInt(seed), keep) as LayoutScore
      if (!best || sc.total > best.total) {
        best = sc
        bestSeed = seed
      }
      // Cheap near-duplicate filter: same workstation count and ~equal total
      // means the same layout family — keep only the better of the pair.
      const dup = kept.findIndex(
        (k) =>
          Math.abs(k.score.total - sc.total) < 0.5 && k.score.placed_desks === sc.placed_desks,
      )
      if (dup >= 0 && kept[dup].score.total >= sc.total) continue
      const cand: Candidate = {
        seed,
        score: sc,
        snap: this.ed.snapshot(),
        thumb: renderThumb(this.getState()),
      }
      if (dup >= 0) kept[dup] = cand
      else kept.push(cand)
      kept.sort((a, b) => b.score.total - a.score.total)
      if (kept.length > topK) kept.length = topK
      if (best.total >= opts.target) break
    }
    const finalScore = this.ed.generate(program, BigInt(bestSeed), keep) as LayoutScore
    this.ed.clear_selection()
    this.commit()
    return { best: finalScore, iterations, seed: bestSeed, candidates: kept }
  }

  /** Make a gallery candidate live: restore its snapshot, repaint, notify React.
   *  The user's CAD drafting layer is preserved across the switch — layout
   *  options differ in layout, not in drafting; `restore()` (undo) keeps true
   *  time-travel semantics instead. */
  applyCandidate(snap: unknown): void {
    const cad = this.ed.get_cad_json()
    this.ed.restore(snap as string)
    this.ed.set_cad_json(cad)
    this.ed.clear_selection()
    this.hydrateCad()
    this.refresh()
    this.onChange?.()
  }

  /** Circulation / "walking place" evaluation of the current document. */
  circulation(): CirculationScore {
    return this.ed.circulation() as CirculationScore
  }
  /** Re-measure + repaint. Call after the canvas becomes visible again (2D/3D toggle). */
  refresh() {
    this.resize()
    this.render()
    this.updateScaleReadout()
  }

  /** Repaint + notify React. Call after mutating the doc directly (e.g. the AI). */
  sync() {
    this.render()
    this.onChange?.()
  }

  /** Opaque lossless snapshot of the whole document (undo + dry-run source). */
  snapshot(): string {
    return this.ed.snapshot() as string
  }
  restore(snap: string) {
    this.ed.restore(snap)
    this.hydrateCad()
    this.sync()
  }

  /** Wipe the document to a fresh empty doc (import→test-fit bridge). */
  clearAll() {
    this.ed = new Editor()
    this.hydrateCad()
    this.sync()
  }

  /** The CAD drafting entities (live store array) — export/orchestration reads. */
  cadEntities(): CadEntity[] {
    return this.cad.store.entities
  }

  /** Replace the CAD store from the document's cad_json blob (after restore/clear). */
  private hydrateCad() {
    this.cadHydrating = true
    try {
      const json = this.ed.get_cad_json()
      this.cad.store.load(json ? (JSON.parse(json) as CadEntity[]) : [])
    } finally {
      this.cadHydrating = false
    }
  }

  private commit() {
    this.render()
    this.onChange?.()
  }

  // ---- events ----
  private attach() {
    this.canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    this.canvas.addEventListener('mouseleave', this.onLeave)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onCtx)
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('resize', this.onResize)
  }
  dispose() {
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onCtx)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private screenFromEvent(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onCtx = (e: Event) => e.preventDefault()

  private onDown = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.lastScreen = s
    if (e.button === 1 || e.button === 2) {
      this.panning = true
      return
    }
    if (this.cad.active) {
      this.cad.down(s.x, s.y, e)
      return
    }
    const w = this.toWorld(s.x, s.y)
    if (this.tool === 'select') {
      const hit = this.ed.select_at(w.x, w.y)
      this.dragging = hit !== undefined
      this.commit()
    } else if (this.tool === 'wall') {
      const sp = this.snap(w)
      if (!this.wallStart) {
        this.wallStart = sp
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, sp.x, sp.y, 0.1)
        this.wallStart = sp // chain walls
        this.commit()
      }
    } else if (this.tool.startsWith('place:')) {
      const cat = this.tool.slice('place:'.length)
      const item = catByCategory(cat)
      if (item) {
        const sp = this.snap(w)
        this.ed.add_component(cat, sp.x, sp.y, item.w, item.h)
        this.commit()
      }
    }
  }

  private onMove = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.mouseWorld = this.toWorld(s.x, s.y)
    this.hasCursor = true
    this.updateCoordReadout()
    if (this.panning) {
      this.offset.x += s.x - this.lastScreen.x
      this.offset.y += s.y - this.lastScreen.y
      this.lastScreen = s
      this.render()
      return
    }
    if (this.cad.active) {
      this.cad.move(s.x, s.y)
      const hint = this.cad.hint()
      if (hint && this.coordEl) this.coordEl.textContent = hint
      return
    }
    if (this.dragging && this.tool === 'select') {
      const dxw = (s.x - this.lastScreen.x) / this.scale
      const dyw = (s.y - this.lastScreen.y) / this.scale
      this.ed.move_selected(dxw, dyw)
      this.lastScreen = s
      this.commit()
      return
    }
    if (this.tool === 'wall' && this.wallStart) this.render()
    else if (this.hasCursor) this.render() // keep ruler cursor ticks live
  }

  private onLeave = () => {
    this.hasCursor = false
    if (this.coordEl) this.coordEl.textContent = 'x —  y —'
    this.render()
  }

  private onUp = (e: MouseEvent) => {
    if (this.cad.active && !this.panning) {
      const s = this.screenFromEvent(e)
      this.cad.up(s.x, s.y)
    }
    this.panning = false
    this.dragging = false
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const s = this.screenFromEvent(e)
    const before = this.toWorld(s.x, s.y)
    const factor = Math.exp(-e.deltaY * 0.0015)
    this.scale = Math.min(300, Math.max(8, this.scale * factor))
    this.offset.x = s.x - before.x * this.scale
    this.offset.y = s.y - before.y * this.scale
    this.updateScaleReadout()
    this.render()
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.cad.active) {
      // CAD tools consume typing (text) + shortcuts (door 'f', column 'r', Esc).
      if (e.key === 'Backspace') e.preventDefault()
      this.cad.key(e.key)
      return
    }
    if (e.key === 'Escape') {
      this.wallStart = null
      this.ed.clear_selection()
      this.commit()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.getState().selection != null) {
        e.preventDefault()
        this.ed.delete_selected()
        this.commit()
      }
    }
  }

  private onResize = () => {
    this.resize()
    this.render()
  }

  private updateCoordReadout() {
    if (this.coordEl) {
      this.coordEl.textContent = `x ${this.mouseWorld.x.toFixed(2)}  y ${this.mouseWorld.y.toFixed(2)}`
    }
  }
  private updateScaleReadout() {
    if (this.scaleEl) this.scaleEl.textContent = `${Math.round(this.scale)} px/m`
  }

  private resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return // hidden (e.g. 3D mode)
    this.canvas.width = Math.floor(rect.width * this.dpr)
    this.canvas.height = Math.floor(rect.height * this.dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
  }

  // ---- rendering ----
  private render() {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const w = this.canvas.width / this.dpr
    const h = this.canvas.height / this.dpr
    if (w === 0 || h === 0) return

    const st = this.getState()

    // Gray mat everywhere, white floor plate over the building footprint.
    ctx.fillStyle = C.mat
    ctx.fillRect(0, 0, w, h)
    const bb = wallBbox(st.walls)
    if (bb) {
      const p0 = this.toScreen(bb.minX, bb.minY)
      const p1 = this.toScreen(bb.maxX, bb.maxY)
      ctx.fillStyle = C.surface
      ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)
    } else {
      ctx.fillStyle = C.surface
      ctx.fillRect(0, 0, w, h)
    }
    this.drawGrid(w, h)
    this.updatePlate(st.walls)
    this.drawZones(st.zones)

    for (const wall of st.walls) this.drawSegment(wall.a, wall.b, wall.thickness, C.wall)
    if (this.tool === 'wall' && this.wallStart) {
      this.drawSegment(this.wallStart, this.snap(this.mouseWorld), 0.1, C.preview)
    }
    for (const c of st.components) this.drawComponent(c, c.id === st.selection)

    // CAD layer: entities + tool preview + snap indicator + grips.
    this.cad.render(ctx, {
      toScreen: (p) => this.toScreen(p.x, p.y),
      pxPerM: this.scale,
      selected: this.cad.selected,
      colors: { wall: C.wall, ink: C.label, accent: C.accent, dim: '#2d5bd6', faint: C.rulerText },
    })

    this.drawRulers(w, h)
  }

  /** Floor-plate polygon for zone clipping, cached on a cheap wall fingerprint
   *  (walls change rarely; `ed.plate()` re-traces + serializes on every call). */
  private platePoly: [number, number][] | null = null
  private plateKey = ''

  private updatePlate(walls: DocWall[]) {
    let sum = 0
    for (const w of walls) sum += w.a.x + w.a.y * 7 + w.b.x * 13 + w.b.y * 31
    const key = `${walls.length}:${sum.toFixed(4)}`
    if (key === this.plateKey) return
    this.plateKey = key
    this.platePoly = (this.ed.plate() as [number, number][] | null | undefined) ?? null
  }

  private drawZones(zones?: DocZone[]) {
    if (!zones || zones.length === 0) return
    const ctx = this.ctx

    // Zone shapes are rectangles even on an L-shaped plate; clip their fills to
    // the plate polygon so tints never spill past the building boundary.
    // Labels draw after restore so they stay legible near clipped corners.
    const clipped = this.platePoly && this.platePoly.length >= 3
    if (clipped) {
      ctx.save()
      ctx.beginPath()
      const poly = this.platePoly!
      const p0 = this.toScreen(poly[0][0], poly[0][1])
      ctx.moveTo(p0.x, p0.y)
      for (let i = 1; i < poly.length; i++) {
        const p = this.toScreen(poly[i][0], poly[i][1])
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.clip()
    }

    const labels: { text: string; x: number; y: number; color: string }[] = []
    for (const z of zones) {
      const pal = ZONE[z.zone_type] ?? ZONE.Core
      ctx.fillStyle = pal.fill
      if (z.shape.kind === 'RectRing') {
        const s = z.shape
        const o = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const io = this.toScreen(s.x - s.in_w / 2, s.y - s.in_h / 2)
        ctx.beginPath()
        ctx.rect(o.x, o.y, s.w * this.scale, s.h * this.scale)
        ctx.rect(io.x, io.y, s.in_w * this.scale, s.in_h * this.scale)
        ctx.fill('evenodd')
      } else {
        const s = z.shape
        const p = this.toScreen(s.x - s.w / 2, s.y - s.h / 2)
        const w = s.w * this.scale
        const h = s.h * this.scale
        ctx.fillRect(p.x, p.y, w, h)
        ctx.strokeStyle = pal.line
        ctx.lineWidth = 1
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1)
        if (w > 60 && h > 26) {
          labels.push({ text: z.label.toUpperCase(), x: p.x + 6, y: p.y + 5, color: pal.line })
        }
      }
    }
    if (clipped) ctx.restore()

    ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    for (const l of labels) {
      ctx.fillStyle = l.color
      ctx.fillText(l.text, l.x, l.y)
    }
  }

  private drawGrid(w: number, h: number) {
    const ctx = this.ctx
    const step = GRID_M * this.scale
    if (step >= 6) {
      const originX = this.offset.x
      const originY = this.offset.y
      for (let i = 0, x = originX % step; x < w; x += step, i++) {
        const worldM = Math.round((x - originX) / step) * GRID_M
        ctx.strokeStyle = worldM % MAJOR_EVERY === 0 ? C.gridMajor : C.gridMinor
        line(ctx, x, 0, x, h)
      }
      for (let y = originY % step; y < h; y += step) {
        const worldM = Math.round((y - originY) / step) * GRID_M
        ctx.strokeStyle = worldM % MAJOR_EVERY === 0 ? C.gridMajor : C.gridMinor
        line(ctx, 0, y, w, y)
      }
    }
    const o = this.toScreen(0, 0)
    ctx.strokeStyle = C.axis
    line(ctx, o.x, 0, o.x, h)
    line(ctx, 0, o.y, w, o.y)
  }

  private drawSegment(
    a: { x: number; y: number },
    b: { x: number; y: number },
    thick: number,
    color: string,
  ) {
    const ctx = this.ctx
    const pa = this.toScreen(a.x, a.y)
    const pb = this.toScreen(b.x, b.y)
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, thick * this.scale)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.stroke()
  }

  private drawComponent(c: DocComponent, selected: boolean) {
    const ctx = this.ctx
    const p = this.toScreen(c.x, c.y)
    const w = c.w * this.scale
    const h = c.h * this.scale
    const frozen = c.decision === 'Confirmed'

    // Very-light plate so the glyph sits cleanly on the pastel zone.
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(c.rotation)
    ctx.fillStyle = frozen ? hexA(DECISION_DOT.Confirmed, 0.12) : 'rgba(255,255,255,0.5)'
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(4, Math.min(w, h) * 0.14))
    ctx.fill()
    ctx.restore()

    // Recognizable top-view CAD furniture line-symbol.
    drawFurnitureSymbol(ctx, {
      category: c.category,
      cx: p.x,
      cy: p.y,
      w,
      h,
      rotation: c.rotation,
      stroke: frozen ? DECISION_DOT.Confirmed : C.furniture,
      detail: '#b4b9c1',
      accent: C.accent,
      selected,
    })

    // Label only for the selected item — zone labels carry the room names, so the
    // plan stays clean.
    if (selected) {
      ctx.fillStyle = C.label
      ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(clip(c.label, Math.max(w, 64)), p.x, p.y - h / 2 - 9)
    }

    // decision dot (top-right) — only for non-Open, to keep the plate clean
    if (c.decision !== 'Open') {
      ctx.fillStyle = DECISION_DOT[c.decision]
      ctx.beginPath()
      ctx.arc(p.x + w / 2 - 5.5, p.y - h / 2 + 5.5, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // selection corner ticks (CAD handles)
    if (selected) {
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 1.5
      const t = 6
      const L = -w / 2
      const R = w / 2
      const T = -h / 2
      const B = h / 2
      ctx.save()
      ctx.translate(p.x, p.y)
      for (const [cx, cy, sx, sy] of [
        [L, T, 1, 1],
        [R, T, -1, 1],
        [L, B, 1, -1],
        [R, B, -1, -1],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(cx + sx * t, cy)
        ctx.lineTo(cx, cy)
        ctx.lineTo(cx, cy + sy * t)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  private drawRulers(w: number, h: number) {
    const ctx = this.ctx
    // strips
    ctx.fillStyle = C.rulerBg
    ctx.fillRect(0, 0, w, RULER)
    ctx.fillRect(0, 0, RULER, h)
    ctx.fillStyle = C.rulerCorner
    ctx.fillRect(0, 0, RULER, RULER)

    const stepM = niceStep(this.scale)
    ctx.font = '9px "Hanken Grotesk", system-ui, sans-serif'
    ctx.fillStyle = C.rulerText
    ctx.strokeStyle = C.rulerTick
    ctx.lineWidth = 1

    // top ruler (world X)
    const xStart = Math.ceil(this.toWorld(RULER, 0).x / stepM) * stepM
    const xEnd = this.toWorld(w, 0).x
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.beginPath()
    for (let m = xStart; m <= xEnd; m += stepM) {
      const sx = this.toScreen(m, 0).x
      if (sx < RULER) continue
      ctx.moveTo(sx + 0.5, RULER - 6)
      ctx.lineTo(sx + 0.5, RULER)
      ctx.fillText(fmtM(m), sx + 3, 10)
    }
    ctx.stroke()

    // left ruler (world Y)
    const yStart = Math.ceil(this.toWorld(0, RULER).y / stepM) * stepM
    const yEnd = this.toWorld(0, h).y
    ctx.textAlign = 'center'
    ctx.beginPath()
    for (let m = yStart; m <= yEnd; m += stepM) {
      const sy = this.toScreen(0, m).y
      if (sy < RULER) continue
      ctx.moveTo(RULER - 6, sy + 0.5)
      ctx.lineTo(RULER, sy + 0.5)
      ctx.fillText(fmtM(m), RULER / 2, sy - 3)
    }
    ctx.stroke()

    // amber cursor ticks
    if (this.hasCursor) {
      const cs = this.toScreen(this.mouseWorld.x, this.mouseWorld.y)
      ctx.strokeStyle = C.accent
      ctx.lineWidth = 1
      if (cs.x >= RULER) line(ctx, cs.x + 0.5, 0, cs.x + 0.5, RULER)
      if (cs.y >= RULER) line(ctx, 0, cs.y + 0.5, RULER, cs.y + 0.5)
    }
  }
}

// ---- module helpers ----

// Thumbnail fills by category — desks cool blue, meeting rooms translucent teal.
const THUMB_FILL: Record<string, string> = {
  Desk: 'rgba(91, 141, 239, 0.85)',
  MeetingRoom: 'rgba(70, 179, 166, 0.35)',
}
const THUMB_OTHER = 'rgba(138, 144, 153, 0.55)'

/**
 * Minimal plan schematic of a document state → dataURL, for gallery cards.
 * Deliberately NOT the interactive render() pipeline: render() draws to the
 * live canvas with pan/zoom transforms, rulers, and CAD overlays; thumbnails
 * need an isolated fit-to-frame offscreen scene.
 */
function renderThumb(st: DocState, w = 200, h = 140): string {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return ''

  // Fit the wall bbox (fall back to component extents) into the frame.
  let bb = wallBbox(st.walls)
  if (!bb && st.components.length) {
    bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    for (const c of st.components) {
      bb.minX = Math.min(bb.minX, c.x - c.w / 2)
      bb.minY = Math.min(bb.minY, c.y - c.h / 2)
      bb.maxX = Math.max(bb.maxX, c.x + c.w / 2)
      bb.maxY = Math.max(bb.maxY, c.y + c.h / 2)
    }
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  if (!bb) return cv.toDataURL()

  const pad = 8
  const spanX = Math.max(bb.maxX - bb.minX, 0.001)
  const spanY = Math.max(bb.maxY - bb.minY, 0.001)
  const k = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)
  const ox = (w - spanX * k) / 2 - bb.minX * k
  const oy = (h - spanY * k) / 2 - bb.minY * k
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  // Zone tints (rect + ring), same pastels as the main canvas.
  for (const z of st.zones ?? []) {
    const pal = ZONE[z.zone_type] ?? ZONE.Core
    ctx.fillStyle = pal.fill
    const s = z.shape
    if (s.kind === 'RectRing') {
      ctx.beginPath()
      ctx.rect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
      ctx.rect(X(s.x - s.in_w / 2), Y(s.y - s.in_h / 2), s.in_w * k, s.in_h * k)
      ctx.fill('evenodd')
    } else {
      ctx.fillRect(X(s.x - s.w / 2), Y(s.y - s.h / 2), s.w * k, s.h * k)
    }
  }

  // Components as flat category-colored rects (no symbols at this size).
  for (const c of st.components) {
    ctx.fillStyle = THUMB_FILL[c.category] ?? THUMB_OTHER
    ctx.save()
    ctx.translate(X(c.x), Y(c.y))
    ctx.rotate(c.rotation)
    ctx.fillRect((-c.w / 2) * k, (-c.h / 2) * k, c.w * k, c.h * k)
    ctx.restore()
  }

  // Wall outlines on top.
  ctx.strokeStyle = '#2e343b'
  ctx.lineCap = 'round'
  for (const wl of st.walls) {
    ctx.lineWidth = Math.max(1, wl.thickness * k)
    ctx.beginPath()
    ctx.moveTo(X(wl.a.x), Y(wl.a.y))
    ctx.lineTo(X(wl.b.x), Y(wl.b.y))
    ctx.stroke()
  }
  return cv.toDataURL()
}

function wallBbox(
  walls: DocWall[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!walls.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const wl of walls) {
    for (const pt of [wl.a, wl.b]) {
      minX = Math.min(minX, pt.x)
      minY = Math.min(minY, pt.y)
      maxX = Math.max(maxX, pt.x)
      maxY = Math.max(maxY, pt.y)
    }
  }
  return { minX, minY, maxX, maxY }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function niceStep(pxPerM: number): number {
  const minPx = 46
  for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100]) if (s * pxPerM >= minPx) return s
  return 100
}

function fmtM(m: number): string {
  const r = Math.round(m * 100) / 100
  return Number.isInteger(r) ? String(r) : String(r)
}

function clip(text: string, boxW: number): string {
  const max = Math.max(3, Math.floor(boxW / 7))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
