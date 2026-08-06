import init, { Editor, open_share } from '../wasm/ds_core'
import { MONO } from '../ui/type'
import { catByCategory } from './catalog'
import { CadController } from '../cad/controller'
import { entityBBox } from '../cad/render'
import type { CadEntity, SnapContext, Vec2, SnapResult } from '../cad/model'
import {
  emptyDyn,
  dynEmpty,
  parseTyped,
  polarSnap,
  resolvePoint,
  bearingDeg,
  norm360,
  type DynState,
  type PolarOpts,
} from '../cad/dynamicInput'
import { fmtMeters, parseDim, endpointForLength } from '../cad/dimEdit'
// The 2D paint layer, the direct-manipulation editing layer, and the autonomous
// search loop each live in their own module; this class is the façade that owns
// the canvas, routes input, and delegates to them (see the file docs there).
import {
  clampN,
  distToPoly,
  drawComponent,
  drawDimChip,
  drawDimLabel,
  drawGlazing,
  drawGrid,
  drawRoomSelection,
  drawRulers,
  drawSegment,
  drawSummary,
  drawZones,
  drawZoneTags,
  wallBbox,
  drawWall,
  type PaintView,
  type ZoneTag,
} from './paint'
import { C } from './planStyle'
import { RoomInteraction, SNAP_M, updateSelectedComponent, type RoomHost } from './interaction'
import {
  autoGenerate,
  designOptions,
  designWithAI,
  refineWithAI,
  type DesignOptionResult,
  type RefineOutcome,
  type SearchHost,
} from './search'
import type { DesignSpec } from '../ai/designer'

// The document/metrics/program vocabulary lives in `web/src/types/` and the
// extracted canvas modules own their own exports — import from those directly
// (`../types/doc`, `./paint`, `./search`). This file exports the canvas and
// nothing it does not own.

import type {
  DocComponent,
  DocState,
  DocWall,
  DocZone,
  RoomSelection,
  SelectedInfo,
  SelectedPatch,
  ZoneType,
} from '../types/doc'
import type { CirculationScore, LayoutScore, Metrics, ZoneStat } from '../types/metrics'
import type { PlateProvenance } from '../import/plateQuality'
import type { CostSchedule } from '../types/qto'
import type { GenResult, Program } from '../types/program'
import { DEFAULT_PROGRAM } from '../types/program'

export type ToolId = string // 'select' | 'wall' | 'place:<Category>'

// Space-planning strategies live in a dependency-free module (unit-testable in
// node); re-exported here so existing importers keep the single `EditorCanvas`
// entry point.
export type { Strategy } from './strategy'
export { STRATEGIES, STRATEGY_LABEL, STRATEGY_BLURB } from './strategy'

/** Everything the extracted paint / interaction / search modules read back from
 *  the canvas. The class hands them a getter-backed live view of itself, so they
 *  always see the current core + viewport and never cache document state. */
type CanvasHost = PaintView & RoomHost & SearchHost

/** Resolved dynamic-input candidate for the current frame (see dynResolve). */
interface DynResolved {
  point: Vec2
  /** osnap indicator to draw (real object snap) or a synthetic 'none'. */
  snap: SnapResult
  dist: number
  angleDeg: number
  /** a typed distance/angle constrained the point */
  locked: boolean
  /** the free direction was polar/ortho-snapped */
  snapped: boolean
}

// frameContent tuning (see the method for rationale):
const FRAME_MIN_VIEWPORT_PX = 40 // below this the canvas isn't really laid out → retry
const FRAME_MAX_RETRIES = 30 // ~0.5 s of rAF before giving up (canvas genuinely hidden)
const FRAME_ENTITY_MARGIN = 1.0 // admit CAD entities within 1× the shell span of it

/**
 * Owns the canvas: transforms, input, and the render pass. All document
 * mutations go through the Rust `Editor`; this class re-reads `state()` to draw.
 * It is the PUBLIC FAÇADE of the editor — the draw primitives (`./paint`), the
 * direct-manipulation editing (`./interaction`) and the autonomous search
 * (`./search`) live in their own modules and are delegated to from here.
 * Rendering is TS-side for now and migrates into a Rust/WebGL renderer later
 * (docs/adr/0001-rendering-staging.md).
 */
export class EditorCanvas {
  ed: Editor
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = Math.max(1, window.devicePixelRatio || 1)

  scale = 46 // px per meter
  offset = { x: 120, y: 96 } // screen px of world origin
  /** Cold-reload guard: frameContent retries via rAF until the canvas has a real
   *  measured viewport (a saved plan can open before layout has sized the canvas). */
  private frameRetries = 0
  /** Set when frameContent bails because the container isn't laid out yet. The
   *  ResizeObserver completes the frame the instant the container reaches a real
   *  size — robust even if the rAF retry budget expires first (e.g. a candidate
   *  opened straight from the wizard route, where layout settles a beat late). */
  private frameOnLayout = false
  private containerObserver: ResizeObserver | null = null
  tool: ToolId = 'select'
  /** Presentation ("paper") mode: white full-bleed sheet — no grid, no axis,
   *  no rulers — lightened zone tints and a bottom-right plan-summary block.
   *  Toggle via {@link setPresentation} or the 'p' shortcut. */
  presentation = false

  // Optional status-bar readouts updated by direct DOM writes (no React churn).
  coordEl: HTMLElement | null = null
  scaleEl: HTMLElement | null = null

  private wallStart: { x: number; y: number } | null = null
  private mouseWorld = { x: 0, y: 0 }
  private hasCursor = false
  private dragging = false
  private panning = false
  /** Space held → left-drag pans (universal design-tool convention). */
  private spaceDown = false
  private lastScreen = { x: 0, y: 0 }

  // ---- direct room manipulation (Laiout-style) ----
  /** Currently selected room (zone id), independent of component selection. */
  selectedZoneId: number | null = null
  /** Notified when the selected room (or its screen box) changes; null on deselect. */
  onRoom: ((sel: RoomSelection | null) => void) | null = null
  /** Room select/drag/resize + the contextual room ops (see ./interaction). */
  private rooms!: RoomInteraction
  /** Live view of this canvas handed to paint / interaction / search. */
  private host!: CanvasHost

  // ---- dynamic input (cursor-first typed Distance/Angle, M1) ----
  /** Typed Distance/Angle buffers for the in-progress Line/Wall segment. */
  private dyn: DynState = emptyDyn()
  /** Shift → force ortho, Alt → 45° polar (tracked off pointer/key events). */
  private shiftDown = false
  private altDown = false
  /** Floating dynamic-input widget (created once, positioned each frame). */
  private dynEl: HTMLDivElement | null = null
  private dynDistEl: HTMLElement | null = null
  private dynAngEl: HTMLElement | null = null
  private dynDistField: HTMLElement | null = null
  private dynAngField: HTMLElement | null = null
  /** Per-frame cache of the resolved candidate point (avoids re-snapping). */
  private dynResolved: DynResolved | null = null

  // ---- selection dimensions + click-to-edit (M4) ----
  /** Inline numeric editor (an <input> over the canvas) for a clicked dimension. */
  private dimEditEl: HTMLInputElement | null = null
  /** What the open inline editor is editing, or null when closed. */
  private dimEditing: { kind: 'compX' | 'compY' | 'lineLen'; targetId: number } | null = null
  /** Screen-space click targets for the editable selection dimensions, rebuilt
   *  each frame in {@link drawSelectionDims}. */
  private dimHits: { x: number; y: number; w: number; h: number; kind: 'compX' | 'compY' | 'lineLen'; targetId: number }[] = []

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
    // One live, getter-backed view of this canvas for every extracted module —
    // `ed` (swapped by clearAll), the viewport and the room selection are always
    // read through, never snapshotted, so nothing can drift from the core.
    const self = this
    this.host = {
      get ed() {
        return self.ed
      },
      get ctx() {
        return self.ctx
      },
      get scale() {
        return self.scale
      },
      get offset() {
        return self.offset
      },
      get presentation() {
        return self.presentation
      },
      get selectedZoneId() {
        return self.selectedZoneId
      },
      set selectedZoneId(id: number | null) {
        self.selectedZoneId = id
      },
      get onRoom() {
        return self.onRoom
      },
      get program() {
        return self.program
      },
      set program(p: Program) {
        self.program = p
      },
      toScreen: (wx, wy) => this.toScreen(wx, wy),
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      getState: () => this.getState(),
      getMetrics: () => this.getMetrics(),
      getZoneStats: () => this.getZoneStats(),
      snapshot: () => this.snapshot(),
      restore: (snap) => this.restore(snap),
      hydrateCad: () => this.hydrateCad(),
      commit: () => this.commit(),
      generateOnce: (program, seed, keepConfirmed) => this.generateOnce(program, seed, keepConfirmed),
      setCursor: (cursor) => {
        this.canvas.style.cursor = cursor
      },
    }
    this.rooms = new RoomInteraction(this.host)
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
      // React side re-derives from the store (empty-state overlay, layers card).
      this.onChange?.()
    }
    this.attach()
    this.createDynWidget()
    this.createDimEditor()
    // Observe the CONTAINER (not just window resize): the canvas parent can go
    // from 0 → real size a frame or two after a route mount (opening a candidate
    // from the wizard), which window 'resize' never fires for. This is what
    // reliably finishes a frame that bailed while the container was collapsed.
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.containerObserver = new ResizeObserver(this.onContainerResize)
      this.containerObserver.observe(this.canvas.parentElement)
    }
    this.resize()
    this.render()
    // Dev-only test seam: expose the live instance so E2E / debugging can drive
    // the core directly. Guarded by Vite's DEV flag — never present in a build.
    if (import.meta.env.DEV) (window as unknown as { __ec?: EditorCanvas }).__ec = this
  }

  static async create(canvas: HTMLCanvasElement): Promise<EditorCanvas> {
    await init()
    const ec = new EditorCanvas(canvas, new Editor())
    // Dev-only seam: expose the live instance for console tooling + browser
    // E2E (there is no other path to the editor from outside React).
    if (import.meta.env.DEV) (window as unknown as { __ec?: EditorCanvas }).__ec = ec
    return ec
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

  // ---- dynamic input (cursor-first typed Distance/Angle + polar snap, M1) ----

  /** The point the in-progress segment extends from (wall = wallStart, CAD draw
   *  = the tool's anchor), or null when no draw chain is live. */
  private dynAnchor(): Vec2 | null {
    if (this.tool === 'wall') return this.wallStart
    if (this.cad.active) return this.cad.anchor()
    return null
  }
  /** A draw chain is live and can receive typed Distance/Angle. */
  private dynArmed(): boolean {
    return this.dynAnchor() !== null
  }
  /** Polar/ortho constraint for the current modifiers: Shift forces ortho,
   *  Alt switches to 45° polar, else a subtle 90° assist. Documented in §6.5. */
  private polarOpts(): PolarOpts {
    if (this.shiftDown) return { stepDeg: 90, tolDeg: 45, enabled: true } // force ortho
    if (this.altDown) return { stepDeg: 45, tolDeg: 8, enabled: true } // polar 45°
    return { stepDeg: 90, tolDeg: 8, enabled: true } // subtle ortho assist
  }

  /**
   * Resolve the candidate next point from the anchor + cursor, honoring OSNAP
   * (a grabbed object point wins), then any typed Distance/Angle, then ortho/
   * polar snap; falls back to the classic grid snap for a purely free cursor so
   * the plain click-to-place feel is preserved. Returns null when not drawing.
   */
  private dynResolve(cursor: Vec2): DynResolved | null {
    const anchor = this.dynAnchor()
    if (!anchor) return null

    // OSNAP-first (CAD tools only): a real object snap overrides polar/typed dir.
    if (this.cad.active) {
      const s = this.cad.snap(cursor)
      if (s.type !== 'none' && s.type !== 'grid') {
        return {
          point: s.point,
          snap: s,
          dist: Math.hypot(s.point.x - anchor.x, s.point.y - anchor.y),
          angleDeg: bearingDeg(anchor, s.point),
          locked: false,
          snapped: false,
        }
      }
    }

    const typed = parseTyped(this.dyn)
    const polar = this.polarOpts()
    const ps = polarSnap(anchor, cursor, polar)
    // Feed the (already polar-snapped) cursor into resolvePoint; typed values win.
    const r = resolvePoint(anchor, ps.point, typed)
    let point = r.point
    // Preserve the classic grid feel only when the point is purely cursor-driven.
    if (!r.locked && !ps.snapped) point = this.snap(point)
    return {
      point,
      snap: { point, type: 'none' },
      dist: Math.hypot(point.x - anchor.x, point.y - anchor.y),
      angleDeg: bearingDeg(anchor, point),
      locked: r.locked,
      snapped: ps.snapped,
    }
  }

  private resetDyn() {
    this.dyn = emptyDyn()
  }

  /** Route a keystroke into the dynamic-input buffer while drawing. Returns true
   *  when consumed (digits/Tab/Enter/Backspace/first-Esc). */
  private handleDynKey(e: KeyboardEvent): boolean {
    const k = e.key
    if (k === 'Tab') {
      e.preventDefault()
      this.dyn.active = this.dyn.active === 'distance' ? 'angle' : 'distance'
      this.render()
      return true
    }
    if (/^[0-9]$/.test(k) || k === '.' || (k === '-' && this.dyn[this.dyn.active] === '')) {
      // Digits flow to Distance by default (fresh state starts there); an explicit
      // Tab is respected so you can type Angle first (matches AutoCAD Dynamic Input).
      e.preventDefault()
      this.dyn[this.dyn.active] += k
      this.render()
      return true
    }
    if (k === 'Backspace') {
      const f = this.dyn.active
      if (this.dyn[f].length) {
        e.preventDefault()
        this.dyn[f] = this.dyn[f].slice(0, -1)
        this.render()
        return true
      }
      return false
    }
    if (k === 'Enter') {
      e.preventDefault()
      if (!dynEmpty(this.dyn)) this.commitDyn()
      else this.finishDraw()
      return true
    }
    if (k === 'Escape' && !dynEmpty(this.dyn)) {
      // First Esc clears the typed lock; a second Esc (buffer empty) cancels the
      // chain via the normal handlers below.
      this.resetDyn()
      this.render()
      return true
    }
    return false
  }

  /** Commit the typed point through the tool's normal placement path. */
  private commitDyn() {
    const r = this.dynResolve(this.mouseWorld)
    if (!r) {
      this.resetDyn()
      return
    }
    if (this.tool === 'wall') {
      if (!this.wallStart) {
        this.wallStart = r.point
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, r.point.x, r.point.y, 0.1)
        this.wallStart = r.point
        this.commit()
      }
    } else if (this.cad.active) {
      this.cad.commitTypedPoint(r.point)
    }
    this.resetDyn()
    this.render()
  }

  /** Empty-Enter finishes the current chain (wall = drop start, CAD = tool end). */
  private finishDraw() {
    if (this.tool === 'wall') this.wallStart = null
    else if (this.cad.active) this.cad.key('Enter')
    this.resetDyn()
    this.render()
  }

  private createDynWidget() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const el = document.createElement('div')
    el.className = 'dyn-input'
    el.setAttribute('data-testid', 'dyn-input')
    el.style.display = 'none'
    const field = (label: string, unit: string, testid: string) => {
      const f = document.createElement('div')
      f.className = 'dyn-field'
      const l = document.createElement('span')
      l.className = 'dyn-label'
      l.textContent = label
      const v = document.createElement('span')
      v.className = 'dyn-val'
      v.setAttribute('data-testid', testid)
      v.textContent = '0'
      const u = document.createElement('span')
      u.className = 'dyn-unit'
      u.textContent = unit
      f.append(l, v, u)
      return { f, v }
    }
    const d = field('Dist', 'm', 'dyn-distance')
    const a = field('Angle', '°', 'dyn-angle')
    const prompt = document.createElement('div')
    prompt.className = 'dyn-prompt'
    prompt.textContent = 'Set another point or type a distance'
    el.append(d.f, a.f, prompt)
    parent.appendChild(el)
    this.dynEl = el
    this.dynDistField = d.f
    this.dynDistEl = d.v
    this.dynAngField = a.f
    this.dynAngEl = a.v
  }

  /** Position + fill the floating widget from the cached resolved point. */
  private syncDynWidget() {
    if (!this.dynEl) return
    const r = this.dynResolved
    const show = !!r && this.dynArmed() && this.hasCursor && !this.presentation && !this.panning
    if (!show || !r) {
      this.dynEl.style.display = 'none'
      return
    }
    const typed = parseTyped(this.dyn)
    if (this.dynDistEl) {
      this.dynDistEl.textContent = (typed.distance != null ? typed.distance : r.dist).toFixed(2)
    }
    if (this.dynAngEl) {
      const ang = typed.angleDeg != null ? norm360(typed.angleDeg) : r.angleDeg
      this.dynAngEl.textContent = String(Math.round(ang))
    }
    this.dynDistField?.classList.toggle('active', this.dyn.active === 'distance')
    this.dynAngField?.classList.toggle('active', this.dyn.active === 'angle')
    this.dynDistField?.classList.toggle('typed', this.dyn.distance !== '')
    this.dynAngField?.classList.toggle('typed', this.dyn.angle !== '')
    const sp = this.toScreen(r.point.x, r.point.y)
    this.dynEl.style.inset = 'auto'
    this.dynEl.style.left = `${Math.round(sp.x + 16)}px`
    this.dynEl.style.top = `${Math.round(sp.y - 14)}px`
    this.dynEl.style.display = 'flex'
  }

  /** Per-segment length chips (committed + in-progress) while a draw tool is
   *  active — Rayon's live "helper dimensions" (doc §6.6). */
  private drawDimChips() {
    if (this.presentation) return
    if (this.tool === 'wall') {
      for (const w of this.getState().walls) drawDimChip(this.host, w.a, w.b)
      const r = this.dynResolved
      if (this.wallStart && r) drawDimChip(this.host, this.wallStart, r.point, r.angleDeg, true, r.snapped)
    } else if (this.cad.active && this.cad.currentId === 'line') {
      for (const e of this.cad.store.entities) if (e.kind === 'line') drawDimChip(this.host, e.a, e.b)
      const anchor = this.cad.anchor()
      const r = this.dynResolved
      if (anchor && r) drawDimChip(this.host, anchor, r.point, r.angleDeg, true, r.snapped)
    }
  }

  // ---- selection dimensions + click-to-edit (M4, Rayon "the dimension IS the
  //      input"). Purely additive to render/input; guarded to exactly-one
  //      selection and disabled while drawing a chain or in presentation. ----

  /** The single selected CAD line (the app's only length-editable segment
   *  primitive — doc walls are immutable in the wasm surface), or null. */
  private selectedLine(): (CadEntity & { kind: 'line' }) | null {
    const ids = this.cad.selected
    if (ids.size !== 1) return null
    const e = this.cad.store.get([...ids][0])
    return e && e.kind === 'line' ? (e as CadEntity & { kind: 'line' }) : null
  }

  /**
   * Draw the measured dimensions of the current selection and register the
   * editable labels as click targets:
   *  - component → W (top) + H (right) informational size dims, plus editable
   *    X / Y position chips. The wasm Editor exposes no component-resize mutator
   *    (only move_component + set_component_rotation), so click-to-edit is scoped
   *    to POSITION per the editor-UX plan's fallback — clicking X/Y repositions.
   *  - CAD line → an editable length chip at its midpoint (Enter re-lengths the
   *    segment along its current bearing, anchoring endpoint a).
   * Nothing is drawn when nothing is selected (obviously non-destructive).
   */
  private drawSelectionDims() {
    this.dimHits = []
    if (this.presentation || this.dynArmed()) return

    const c = this.getSelected()
    if (c && this.tool === 'select') {
      const ctr = this.toScreen(c.x, c.y)
      const cos = Math.cos(c.rotation)
      const sin = Math.sin(c.rotation)
      // World point from a local (meters) offset, honoring rotation.
      const lp = (lx: number, ly: number) =>
        this.toScreen(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos)
      // Place a label just outside an edge midpoint, offset in screen px along
      // the outward normal so the gap is zoom-independent and rotation-correct.
      const edge = (lx: number, ly: number, gap = 15) => {
        const p = lp(lx, ly)
        const dx = p.x - ctr.x
        const dy = p.y - ctr.y
        const d = Math.hypot(dx, dy) || 1
        return { x: p.x + (dx / d) * gap, y: p.y + (dy / d) * gap }
      }
      const hw = c.w / 2
      const hh = c.h / 2
      const wp = edge(0, -hh) // top
      const hp = edge(hw, 0) // right
      const xp = edge(0, hh) // bottom
      const yp = edge(-hw, 0) // left
      this.dimLabel(wp.x, wp.y, fmtMeters(c.w), false)
      this.dimLabel(hp.x, hp.y, fmtMeters(c.h), false)
      this.dimLabel(xp.x, xp.y, `X ${c.x.toFixed(2)}`, true, 'compX', c.id)
      this.dimLabel(yp.x, yp.y, `Y ${c.y.toFixed(2)}`, true, 'compY', c.id)
      return
    }

    const ln = this.selectedLine()
    if (ln && this.cad.active) {
      const len = Math.hypot(ln.b.x - ln.a.x, ln.b.y - ln.a.y)
      const mid = this.toScreen((ln.a.x + ln.b.x) / 2, (ln.a.y + ln.b.y) / 2)
      this.dimLabel(mid.x, mid.y, fmtMeters(len), true, 'lineLen', ln.id)
    }
  }

  /** Paint one selection-dimension pill and, when it is editable, record its box
   *  as a click target so {@link tryOpenDimEditor} can route a click to the
   *  inline editor. The pill the open editor covers is skipped. */
  private dimLabel(
    cx: number,
    cy: number,
    text: string,
    editable: boolean,
    kind?: 'compX' | 'compY' | 'lineLen',
    targetId?: number,
  ) {
    const hidden = editable && this.dimEditing?.kind === kind && this.dimEditing?.targetId === targetId
    const box = drawDimLabel(this.host, cx, cy, text, editable, hidden)
    if (editable && kind && targetId != null) {
      this.dimHits.push({ ...box, kind, targetId })
    }
  }

  private createDimEditor() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const el = document.createElement('input')
    el.type = 'text'
    el.inputMode = 'decimal'
    el.className = 'dim-edit'
    el.setAttribute('data-testid', 'dim-edit')
    // Inline styles keep this self-contained in EditorCanvas (no styles.css edit),
    // while matching the M1 dyn-input look (IBM Plex Mono, accent focus ring).
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '7',
      display: 'none',
      width: '64px',
      padding: '2px 6px',
      textAlign: 'center',
      font: `12.5px ${MONO}`,
      color: '#1a1d21',
      background: 'rgba(255,255,255,0.98)',
      border: `1.5px solid ${C.accent}`,
      borderRadius: '5px',
      boxShadow: '0 1px 4px rgba(23,26,30,0.18)',
      outline: 'none',
    } as CSSStyleDeclaration)
    el.addEventListener('keydown', (e) => {
      e.stopPropagation() // never leak digits/Enter to the canvas key handlers
      if (e.key === 'Enter') {
        e.preventDefault()
        this.commitDimEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancelDimEdit()
      }
    })
    // Committing on blur would fight the Escape path; blur just cancels.
    el.addEventListener('blur', () => this.cancelDimEdit())
    parent.appendChild(el)
    this.dimEditEl = el
  }

  /** Route a canvas click to the inline dimension editor when it lands on an
   *  editable label. Returns true when consumed (so selection/placement is
   *  skipped). Guarded to exactly-one selection via {@link drawSelectionDims}. */
  private tryOpenDimEditor(s: { x: number; y: number }): boolean {
    for (const hb of this.dimHits) {
      if (s.x >= hb.x && s.x <= hb.x + hb.w && s.y >= hb.y && s.y <= hb.y + hb.h) {
        this.openDimEditor(hb)
        return true
      }
    }
    return false
  }

  private openDimEditor(hb: { x: number; y: number; w: number; h: number; kind: 'compX' | 'compY' | 'lineLen'; targetId: number }) {
    const el = this.dimEditEl
    if (!el) return
    let value = ''
    if (hb.kind === 'lineLen') {
      const ln = this.selectedLine()
      if (!ln) return
      value = Math.hypot(ln.b.x - ln.a.x, ln.b.y - ln.a.y).toFixed(2)
    } else {
      const c = this.getSelected()
      if (!c) return
      value = (hb.kind === 'compX' ? c.x : c.y).toFixed(2)
    }
    this.dimEditing = { kind: hb.kind, targetId: hb.targetId }
    el.value = value
    el.style.left = `${Math.round(hb.x + hb.w / 2 - 32)}px`
    el.style.top = `${Math.round(hb.y + hb.h / 2 - 11)}px`
    el.style.display = 'block'
    this.render()
    el.focus()
    el.select()
  }

  private commitDimEdit() {
    const ed = this.dimEditing
    const el = this.dimEditEl
    if (!ed || !el) return this.cancelDimEdit()
    const v = parseDim(el.value)
    if (v == null) return this.cancelDimEdit()
    if (ed.kind === 'lineLen') {
      const ln = this.selectedLine()
      if (ln && ln.id === ed.targetId) {
        this.cad.store.snapshot()
        this.cad.store.update(ln.id, { b: endpointForLength(ln.a, ln.b, v) })
      }
    } else {
      const c = this.getSelected()
      if (c && c.id === ed.targetId) {
        const x = ed.kind === 'compX' ? v : c.x
        const y = ed.kind === 'compY' ? v : c.y
        this.ed.move_component(c.id, x, y)
        this.commit()
      }
    }
    this.closeDimEditor()
  }

  private cancelDimEdit() {
    this.closeDimEditor()
  }

  private closeDimEditor() {
    this.dimEditing = null
    if (this.dimEditEl) this.dimEditEl.style.display = 'none'
    this.render()
  }

  // ---- API consumed by React ----
  /**
   * Memoised `state()`. Every read crosses the wasm boundary and serializes the
   * WHOLE document, and a single frame does it many times — render() plus every
   * derived helper (getSelected, selectedInfo, zones, roomAt, …) and every React
   * consumer. The core's `revision()` is a u64 bumped by every mutator (and by
   * nothing else), so an unchanged revision means the previous object is still
   * exactly what `state()` would return.
   *
   * Keyed on the `Editor` INSTANCE as well as the revision: `clearAll` swaps in
   * a fresh `Editor` whose revision restarts at 0, which would otherwise look
   * like "unchanged" and serve the cleared document's predecessor.
   *
   * Safe because the result is treated as read-only everywhere (verified across
   * all call sites) — callers derive from it, never mutate it. If that ever
   * stops being true, this must return a copy instead.
   */
  getState(): DocState {
    const ed = this.ed
    const rev = ed.revision()
    const cached = this.stateCache
    if (cached && cached.ed === ed && cached.rev === rev) return cached.state
    const state = ed.state() as DocState
    this.stateCache = { ed, rev, state }
    return state
  }
  private stateCache: { ed: Editor; rev: bigint; state: DocState } | null = null

  /**
   * How the floor plate under this document was derived, and how far it can be
   * trusted (ADR 0002/0003). Set when a plate is pushed, restored on open, and
   * written into the `.dsource` file, so a low-confidence plate still presents
   * as approximate after a save/open round-trip instead of silently becoming a
   * hard number — the exact bug class the plate branch removed on the import
   * path, which would otherwise reappear through persistence.
   *
   * Held here rather than in the Rust `Document` because the snapshot shape is
   * frozen; this is import metadata, not document geometry.
   */
  plateProvenance: PlateProvenance | null = null
  getMetrics(): Metrics {
    return this.ed.metrics() as Metrics
  }
  /**
   * Hierarchical quantity schedule (level → room → category → item) from the
   * core — the ADR 0004 winner. Prices are read from the core's `price_inr`, so
   * this needs no App-layer bindings map.
   */
  getQtoSchedule(): CostSchedule | null {
    const ed = this.ed as unknown as { qto_schedule?: () => unknown }
    if (typeof ed.qto_schedule !== 'function') return null
    return (ed.qto_schedule() as CostSchedule) ?? null
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
  /**
   * Read-only geometry facet of the current selection, for the object inspector.
   * Returns the selected document component (category + x/y/w/h/rotation +
   * binding/decision) or, if the selection points at a wall, its length /
   * thickness / endpoints — else null. Purely derived from `getState()`.
   */
  selectedInfo(): SelectedInfo | null {
    const s = this.getState()
    if (s.selection == null) return null
    const c = s.components.find((x) => x.id === s.selection)
    if (c) {
      return {
        kind: 'component',
        id: c.id,
        category: c.category,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        rotation: c.rotation,
        label: c.label,
        product_id: c.product_id,
        decision: c.decision,
      }
    }
    const wl = s.walls.find((x) => x.id === s.selection)
    if (wl) {
      return {
        kind: 'wall',
        id: wl.id,
        length: Math.hypot(wl.b.x - wl.a.x, wl.b.y - wl.a.y),
        thickness: wl.thickness,
        a: { x: wl.a.x, y: wl.a.y },
        b: { x: wl.b.x, y: wl.b.y },
      }
    }
    return null
  }
  /**
   * Apply an edit to the current selection from the object inspector. Maps a
   * partial patch to the matching `Editor` primitive(s) and commits once. Only
   * component geometry/binding is editable today (walls are not select-hit).
   */
  updateSelected(patch: SelectedPatch) {
    updateSelectedComponent(this.host, patch)
  }
  /** Enter/leave presentation ("paper") mode; repaints and notifies React so
   *  any toggle button can reflect the state. */
  setPresentation(on: boolean) {
    if (this.presentation === on) return
    this.presentation = on
    this.render()
    this.onChange?.()
  }
  setTool(t: ToolId) {
    this.tool = t
    this.wallStart = null
    this.resetDyn()
    if (this.dimEditing) this.closeDimEditor()
    if (t !== 'select' && this.selectedZoneId != null) {
      this.selectedZoneId = null
      this.emitRoom()
    }
    this.canvas.style.cursor = t === 'select' ? '' : 'crosshair'
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

  // ---- rooms: selection + contextual ops (delegated to ./interaction) ----
  getSelectedZone(): DocZone | null {
    return this.rooms.selectedZone()
  }

  /** Select a room by zone id (clears component selection); null to deselect. */
  selectRoom(id: number | null) {
    this.rooms.selectRoom(id)
  }

  /** Reclassify a room's type and rename it to that type's default label. */
  setZoneTypeRoom(id: number, type: ZoneType) {
    this.rooms.setZoneType(id, type)
  }

  /** Delete a room (its zone + the furniture inside it). */
  deleteRoom(id: number) {
    this.rooms.deleteRoom(id)
  }

  /** Split a rectangular room in half along its longer axis. */
  splitRoom(id: number) {
    this.rooms.splitRoom(id)
  }

  /** Duplicate a rectangular room + its furniture, offset into free space. */
  duplicateRoom(id: number) {
    this.rooms.duplicateRoom(id)
  }

  /** Rotate a rectangular room 90° clockwise about its center (members turn
   *  with it). Four calls return to the original orientation. */
  rotateRoom(id: number, deg = 90) {
    this.rooms.rotateRoom(id, deg)
  }

  /** Push the current room selection + its screen box to the floating toolbar. */
  private emitRoom(force = false) {
    this.rooms.emitRoom(force)
  }

  /** One deterministic test-fit for `seed`; mutates the document. */
  generateOnce(program: Program, seed: number, keepConfirmed = false): LayoutScore {
    return this.ed.generate(program, BigInt(seed), keepConfirmed) as LayoutScore
  }

  /**
   * Autonomous test-fit search across the three STRATEGIES (M7) — see
   * {@link autoGenerate} in ./search for the full contract (per-strategy seed
   * windows, determinism, `keepConfirmed`).
   */
  autoGenerate(
    program: Program,
    opts: { maxIter: number; target: number; keepConfirmed?: boolean; seedOffset?: number },
  ): GenResult {
    return autoGenerate(this.host, program, opts)
  }

  /**
   * Autonomous REASONING loop (generate→evaluate→optimize): an initial
   * {@link autoGenerate}, then Claude-shaped program deltas kept only when a
   * fixed-weight yardstick rises. Clean no-op without a Claude key. Full
   * contract: {@link refineWithAI} in ./search.
   */
  async refineWithAI(
    program: Program,
    opts: {
      maxIter: number
      target: number
      keepConfirmed?: boolean
      seedOffset?: number
      refineIters?: number
      softGoals?: string
    },
  ): Promise<RefineOutcome> {
    return refineWithAI(this.host, program, opts)
  }

  /**
   * AGENTIC SENIOR DESIGNER: Claude designs the program from a brief and applies
   * it to `this.program`; the caller then generates. Returns null without a
   * Claude key / plate. Full contract: {@link designWithAI} in ./search.
   */
  async designWithAI(brief: string, signal?: AbortSignal): Promise<DesignSpec | null> {
    return designWithAI(this.host, brief, signal)
  }

  /**
   * MULTI-OBJECTIVE designer (Laiout-style option set): one realised,
   * snapshot-backed option per objective. Leaves the program unchanged. Full
   * contract: {@link designOptions} in ./search.
   */
  async designOptions(brief: string, seed = 1, signal?: AbortSignal): Promise<DesignOptionResult[]> {
    return designOptions(this.host, brief, seed, signal)
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

  /** Frame the document so the PLATE/SHELL sits centered and fully visible in the
   *  current viewport. `padding` is the fraction of the viewport kept clear on
   *  each side. No-op when the document is empty.
   *
   *  Robustness — two failure modes this guards against (see
   *  docs/design/laiout-deep-research.md §2.4):
   *  1. **Outlier CAD entities.** Imported DXFs carry stray geometry far from the
   *     plate (leaders, site lines, title blocks). Framing to the raw entity set
   *     blows the span up and clamps scale to the 8 px/m floor, cornering the
   *     plan. So we anchor to the walls+components bbox (the real shell) and admit
   *     a CAD entity only when it overlaps a generous margin of that anchor. A
   *     pure CAD doc (no walls/components) still frames to all its entities.
   *  2. **Viewport not yet measured on open.** A saved plan can open before layout
   *     has sized the canvas; a zero/tiny measurement would mis-frame. We retry on
   *     the next frame (capped) until the canvas has a real size. */
  frameContent(padding = 0.08, isRetry = false) {
    // A fresh (non-retry) request must start with a full retry budget. The counter
    // is instance state shared across every frame attempt and is only cleared on a
    // SUCCESSFUL frame — so if a prior sequence exhausted it against a hidden canvas
    // and never succeeded, it would stay saturated and make THIS open give up on its
    // first tiny measurement and never frame (a permanent cripple). Reset on entry.
    if (!isRetry) this.frameRetries = 0
    // Ensure the canvas is measured (may be freshly un-hidden from 3D/route change).
    this.resize()
    // Gate on the CONTAINER, never the canvas. resize() bails on a collapsed
    // container (0-size, mid-route-mount) leaving the canvas at its 300×150
    // intrinsic default — a canvas-based guard would pass that and frame the plan
    // into a tiny corner at the 8 px/m floor (the "opens tiny" bug). Not laid out
    // yet → mark the frame pending (the ResizeObserver finishes it when layout
    // settles) and retry on rAF, capped so a genuinely hidden canvas doesn't spin.
    const vp = this.viewportReady()
    if (!vp) {
      this.frameOnLayout = true
      if (this.frameRetries < FRAME_MAX_RETRIES) {
        this.frameRetries++
        requestAnimationFrame(() => this.frameContent(padding, true))
      }
      return
    }
    const w = vp.w
    const h = vp.h
    this.frameRetries = 0
    this.frameOnLayout = false

    const st = this.getState()
    // Anchor to the shell: walls + placed/generated components. This is the clean
    // extent a user expects to see, free of stray CAD outliers.
    let aMinX = Infinity
    let aMinY = Infinity
    let aMaxX = -Infinity
    let aMaxY = -Infinity
    const anchor = (ax: number, ay: number, bx: number, by: number) => {
      aMinX = Math.min(aMinX, ax)
      aMinY = Math.min(aMinY, ay)
      aMaxX = Math.max(aMaxX, bx)
      aMaxY = Math.max(aMaxY, by)
    }
    const wb = wallBbox(st.walls)
    if (wb) anchor(wb.minX, wb.minY, wb.maxX, wb.maxY)
    for (const c of st.components) anchor(c.x - c.w / 2, c.y - c.h / 2, c.x + c.w / 2, c.y + c.h / 2)
    const hasAnchor = isFinite(aMinX)

    let minX = aMinX
    let minY = aMinY
    let maxX = aMaxX
    let maxY = aMaxY
    const acc = (ax: number, ay: number, bx: number, by: number) => {
      minX = Math.min(minX, ax)
      minY = Math.min(minY, ay)
      maxX = Math.max(maxX, bx)
      maxY = Math.max(maxY, by)
    }
    if (hasAnchor) {
      // Admit only CAD entities that overlap the anchor grown by a generous margin
      // (one full plan-span on each side). Doors/windows/dims drawn on the shell
      // stay in frame; a leader 1000 m away is dropped so it can't force 8 px/m.
      const margin = FRAME_ENTITY_MARGIN * Math.max(aMaxX - aMinX, aMaxY - aMinY, 1)
      const gMinX = aMinX - margin
      const gMinY = aMinY - margin
      const gMaxX = aMaxX + margin
      const gMaxY = aMaxY + margin
      for (const e of this.cad.store.entities) {
        const [ex0, ey0, ex1, ey1] = entityBBox(e)
        if (ex1 < gMinX || ex0 > gMaxX || ey1 < gMinY || ey0 > gMaxY) continue // outlier: no overlap
        // Clip the admitted entity to the grown-anchor window before accumulating.
        // Rejecting only entities that are ENTIRELY outside isn't enough: a single
        // entity that OVERLAPS or ENCLOSES the shell — a title-block border around the
        // whole sheet, a grid/match/construction line that starts on the plate and runs
        // out to 900 m (both routine in imported DXFs) — passes the overlap test and,
        // taken at full extent, re-inflates the span straight back to the 8 px/m floor
        // and corners the plan (the very symptom this method guards against). Clipping
        // caps each entity's contribution to shell + one span-margin: bounded and sane.
        acc(Math.max(ex0, gMinX), Math.max(ey0, gMinY), Math.min(ex1, gMaxX), Math.min(ey1, gMaxY))
      }
    } else {
      // No shell — a hand-drawn CAD-only doc: frame to all its entities.
      for (const e of this.cad.store.entities) {
        const [ex0, ey0, ex1, ey1] = entityBBox(e)
        acc(ex0, ey0, ex1, ey1)
      }
    }
    if (!isFinite(minX)) return // no content

    const spanX = Math.max(maxX - minX, 0.001)
    const spanY = Math.max(maxY - minY, 0.001)
    const availW = w * (1 - 2 * padding)
    const availH = h * (1 - 2 * padding)
    const k = clampN(Math.min(availW / spanX, availH / spanY), 8, 300)
    this.scale = k
    // Map the content center onto the viewport center under screenX = wx*k + off.x.
    this.offset.x = w / 2 - ((minX + maxX) / 2) * k
    this.offset.y = h / 2 - ((minY + maxY) / 2) * k

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
    window.addEventListener('resize', this.onResize)
    this.setActive(true)
  }

  /** Whether the window-level KEY listeners are currently bound. */
  private keysBound = false

  /**
   * Bind or unbind this canvas's window-level keyboard listeners.
   *
   * These are on `window` (not the canvas) because the canvas isn't focusable and
   * shortcuts must work with the pointer anywhere over the editor. The cost is
   * that they keep firing when the editor is merely HIDDEN — and EditorView is
   * deliberately never unmounted, so it is hidden behind every wizard step. That
   * let `Delete` remove a component from a document the user could not see
   * (133 → 132, no click, no feedback), `p` toggle Presentation, and `Escape`
   * clear the selection, all from the upload screen.
   *
   * The fix is structural rather than a check inside each handler: when the
   * editor is not the active surface the listeners are NOT BOUND, so a handler
   * added later inherits the behaviour instead of having to remember a guard.
   * Mouse and resize listeners stay — the canvas has no pointer events while
   * `display:none`, and resize must keep the backing store correct so the view
   * is right the moment it is shown again.
   */
  setActive(on: boolean): void {
    if (on === this.keysBound) return
    this.keysBound = on
    if (on) {
      window.addEventListener('keydown', this.onKey)
      window.addEventListener('keyup', this.onKeyUp)
    } else {
      window.removeEventListener('keydown', this.onKey)
      window.removeEventListener('keyup', this.onKeyUp)
      // Drop transient modifier state so returning to the editor doesn't resume
      // mid-gesture (a Space-pan armed before navigating away, say).
      this.shiftDown = false
      this.altDown = false
      this.spaceDown = false
    }
  }
  dispose() {
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onCtx)
    this.setActive(false)
    window.removeEventListener('resize', this.onResize)
    this.containerObserver?.disconnect()
    this.dynEl?.remove()
    this.dimEditEl?.remove()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    if (e.code === 'Space') {
      this.spaceDown = false
      if (!this.panning) this.canvas.style.cursor = ''
    }
    // Releasing Shift/Alt changes the polar constraint → repaint the ghost.
    if (e.key === 'Shift' || e.key === 'Alt') this.render()
  }

  private screenFromEvent(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onCtx = (e: Event) => e.preventDefault()

  private onDown = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.lastScreen = s
    // Pan on middle/right button, or left-drag while Space is held (so a laptop
    // trackpad user without a middle button can always pan).
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.panning = true
      this.canvas.style.cursor = 'grabbing'
      return
    }
    // M4: a click on an editable selection-dimension label opens the inline
    // numeric editor (single selection, not while drawing). A miss dismisses any
    // open editor. Runs before tool routing so it wins over select/grip hits.
    if (e.button === 0 && !this.dynArmed()) {
      if (this.tryOpenDimEditor(s)) return
      if (this.dimEditing) this.cancelDimEdit()
    }
    const w = this.toWorld(s.x, s.y)
    if (this.cad.active) {
      // Route the click through the resolved (osnap + polar + typed) point when a
      // chain is live, so a plain click lands where the ghost previews; the real
      // event still flows so polyline double-click-to-commit keeps working.
      const r = this.dynResolve(w)
      if (r) {
        this.cad.downAt(r.point, e)
        this.resetDyn()
      } else {
        this.cad.down(s.x, s.y, e)
      }
      return
    }
    if (this.tool === 'select') {
      // 1. Grabbing a resize handle of the already-selected room?
      const hi = this.rooms.handleAt(s)
      if (hi != null && this.selectedZoneId != null) {
        this.rooms.beginResize(hi, this.selectedZoneId)
        return
      }
      // ROOM-FIRST selection (Laiout/Canva model). A room is furnished, so
      // furniture-first hit-testing made rooms impossible to grab — every click
      // landed on a desk, never the room (the reported "can't drag rooms"). Now a
      // click inside a room selects and drags the ROOM, even over furniture.
      // DRILL-IN: once that room is already selected, a click on its furniture
      // selects the component (Materio re-imagine); a click on its empty floor
      // re-grabs the room to drag.
      const zid = this.ed.zone_at(w.x, w.y)
      if (zid != null) {
        if (zid === this.selectedZoneId) {
          const furn = this.rooms.topFurnitureAt(w)
          if (furn) {
            this.ed.select_at(w.x, w.y) // drill into the piece under the cursor
            this.dragging = true
            this.commit()
            return
          }
          this.ed.clear_selection() // empty floor of the selected room → drag it
          this.rooms.beginDrag(zid, w)
          this.commit()
          return
        }
        this.selectedZoneId = zid
        this.ed.clear_selection()
        this.rooms.beginDrag(zid, w)
        this.emitRoom(true)
        this.commit()
        return
      }
      // 3. Outside any room → a loose component (e.g. passive reference furniture),
      //    else clear everything.
      const furn = this.rooms.topFurnitureAt(w)
      if (furn) {
        this.selectedZoneId = null
        this.emitRoom()
        this.ed.select_at(w.x, w.y)
        this.dragging = true
        this.commit()
        return
      }
      this.selectedZoneId = null
      this.emitRoom()
      this.ed.clear_selection()
      this.dragging = false
      this.commit()
    } else if (this.tool === 'wall') {
      // First point: classic grid snap. Chained points: honor typed/polar input.
      const r = this.wallStart ? this.dynResolve(w) : null
      const sp = r ? r.point : this.snap(w)
      if (!this.wallStart) {
        this.wallStart = sp
      } else {
        this.ed.add_wall(this.wallStart.x, this.wallStart.y, sp.x, sp.y, 0.1)
        this.wallStart = sp // chain walls
        this.commit()
      }
      this.resetDyn()
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
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    this.updateCoordReadout()
    if (this.panning) {
      this.offset.x += s.x - this.lastScreen.x
      this.offset.y += s.y - this.lastScreen.y
      this.lastScreen = s
      this.render()
      return
    }
    if (this.cad.active) {
      // Steer the preview through the resolved point when a chain is live; else
      // fall back to the tool's own osnap (first-point pick, non-draw tools).
      const r = this.dynResolve(this.mouseWorld)
      if (r) this.cad.moveSnap(r.snap)
      else this.cad.move(s.x, s.y)
      const hint = this.cad.hint()
      if (hint && this.coordEl) this.coordEl.textContent = hint
      return
    }
    // Room manipulation takes priority over component drag.
    if (this.rooms.updateGesture(s)) return
    if (this.dragging && this.tool === 'select') {
      const dxw = (s.x - this.lastScreen.x) / this.scale
      const dyw = (s.y - this.lastScreen.y) / this.scale
      this.ed.move_selected(dxw, dyw)
      this.lastScreen = s
      this.commit()
      return
    }
    if (this.tool === 'select') this.rooms.updateHoverCursor(s)
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
    if (this.rooms.endGesture()) {
      this.emitRoom(true)
      this.commit()
    }
    this.panning = false
    this.dragging = false
    this.canvas.style.cursor = this.spaceDown ? 'grab' : ''
  }

  /** Wheel: pinch-zoom (trackpad emits ctrlKey) and true mouse wheels zoom to
   *  the cursor; a two-finger trackpad scroll pans. This makes the plan
   *  navigable on a laptop trackpad, where there is no middle button and a
   *  plain two-finger scroll should move the map, not zoom it. */
  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const pinch = e.ctrlKey || e.metaKey
    // A real mouse wheel reports line-mode deltas, or a chunky integer,
    // vertical-only step; a trackpad reports smaller/fractional pixel deltas
    // (often with a horizontal component).
    const mouseWheel =
      e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40)
    if (pinch || mouseWheel) {
      const s = this.screenFromEvent(e)
      const before = this.toWorld(s.x, s.y)
      const factor = Math.exp(-e.deltaY * (pinch ? 0.01 : 0.0015))
      this.scale = Math.min(300, Math.max(8, this.scale * factor))
      this.offset.x = s.x - before.x * this.scale
      this.offset.y = s.y - before.y * this.scale
      this.updateScaleReadout()
      this.render()
    } else {
      this.offset.x -= e.deltaX
      this.offset.y -= e.deltaY
      this.render()
    }
  }

  private onKey = (e: KeyboardEvent) => {
    // Space (when not typing) arms hold-to-pan in every tool, incl. CAD.
    const tgt = e.target as HTMLElement | null
    const typingNow =
      !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)
    this.shiftDown = e.shiftKey
    this.altDown = e.altKey
    if (e.code === 'Space' && !typingNow) {
      if (!this.spaceDown) {
        this.spaceDown = true
        if (!this.panning) this.canvas.style.cursor = 'grab'
      }
      e.preventDefault() // don't scroll the page
      return
    }
    // Dynamic input: while a Line/Wall chain is live, digits/Tab/Enter/Backspace
    // and the first Esc drive the typed Distance/Angle (before tool/mode keys).
    if (!typingNow && this.dynArmed() && this.handleDynKey(e)) return
    if (this.cad.active) {
      // ⌘Z / Ctrl+Z pops the CAD undo stack (grip drags, trims, fillets, …).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        this.cad.store.undo()
        this.render()
        return
      }
      // CAD tools consume typing (text) + shortcuts (door 'f', column 'r', Esc).
      if (e.key === 'Backspace') e.preventDefault()
      this.cad.key(e.key)
      return
    }
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (e.key.toLowerCase() === 'p' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      this.setPresentation(!this.presentation)
    } else if (e.key === 'Escape') {
      this.wallStart = null
      this.resetDyn()
      if (this.dimEditing) this.closeDimEditor()
      this.selectedZoneId = null
      this.emitRoom()
      this.ed.clear_selection()
      this.commit()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedZoneId != null) {
        e.preventDefault()
        this.deleteRoom(this.selectedZoneId)
      } else if (this.getState().selection != null) {
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

  /** Container-size changes (route mount, panel show/hide, split-pane drag). If a
   *  frame was left pending because the container was collapsed, complete it the
   *  moment the container becomes real — otherwise just resize+repaint, preserving
   *  the user's pan/zoom (no `frameOnLayout` → never fights a deliberate view). */
  private onContainerResize = () => {
    this.resize()
    if (this.frameOnLayout && this.viewportReady()) {
      this.frameOnLayout = false
      this.frameContent()
      return
    }
    this.render()
  }

  /** True when the canvas container is laid out to a real, usable size. Framing
   *  gates on THIS (the container), never on the canvas — resize() bails on a
   *  collapsed container, leaving the canvas at its 300×150 intrinsic default,
   *  which would otherwise sail past a canvas-based guard and frame into a corner. */
  private viewportReady(): { w: number; h: number } | null {
    const r = this.canvas.parentElement?.getBoundingClientRect()
    if (!r || r.width < FRAME_MIN_VIEWPORT_PX || r.height < FRAME_MIN_VIEWPORT_PX) return null
    return { w: r.width, h: r.height }
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
    // Re-read the DPR on every resize. It was a field initialiser read ONCE at
    // construction, so moving the window to a display with a different DPI (or
    // changing browser zoom) left the backing store sized with the stale ratio —
    // a blurry or over-sharp canvas with no way to recover short of a reload.
    // DrawingCanvas already did this; the two now agree.
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
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

    // Presentation: full-bleed paper white. Normal: gray mat everywhere with a
    // white floor plate over the building footprint, plus grid + axis.
    if (this.presentation) {
      ctx.fillStyle = C.surface
      ctx.fillRect(0, 0, w, h)
    } else {
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
      drawGrid(this.host, w, h)
    }
    this.updatePlate(st.walls)
    const tags = this.paintZones(st.zones)

    // Resolve the dynamic-input candidate once per frame (wall preview + chips +
    // widget all read it) so OSNAP/getState isn't recomputed three times.
    this.dynResolved =
      this.hasCursor && !this.presentation && this.dynArmed()
        ? this.dynResolve(this.mouseWorld)
        : null

    for (const wall of st.walls) {
      // Glass fronts get the triple-line convention; everything else draws in
      // the lineweight hierarchy (exterior > interior > generated partition).
      if (wall.glazing) {
        drawGlazing(this.host, wall.a, wall.b)
      } else {
        // Phase 2a: the MEASURED wall treatment — thin double lines at the wall
        // tier, unfilled interior. Replaces the single fat stroked centreline.
        drawWall(this.host, wall, this.exteriorIds.has(wall.id))
      }
    }
    if (this.tool === 'wall' && this.wallStart) {
      drawSegment(
        this.host,
        this.wallStart,
        this.dynResolved?.point ?? this.snap(this.mouseWorld),
        Math.max(2, 0.1 * this.scale),
        C.preview,
      )
    }
    for (const c of st.components) drawComponent(this.host, c, c.id === st.selection)
    this.paintRoomSelection()
    // Room tags sit ABOVE furniture (architect's sheet convention) with a soft
    // paper halo so they stay legible over desks and linework.
    drawZoneTags(
      this.host,
      tags,
      // Hover/selection promotes a label to a pill — the only place pills appear.
      new Set(this.selectedZoneId != null ? [this.selectedZoneId] : []),
    )

    // CAD layer: entities + tool preview + snap indicator + grips.
    this.cad.render(ctx, {
      toScreen: (p) => this.toScreen(p.x, p.y),
      pxPerM: this.scale,
      selected: this.cad.selected,
      hiddenLayers: this.cad.store.hiddenLayers,
      colors: { wall: C.wall, ink: C.label, accent: C.accent, dim: C.accent, faint: C.rulerText },
    })

    // Live per-segment dimension chips (Rayon helper-dimensions) above linework.
    this.drawDimChips()

    // Measured dimensions of the current selection + click-to-edit targets (M4).
    this.drawSelectionDims()

    if (this.presentation) {
      if (st.walls.length || st.components.length) drawSummary(this.host, w, h, this.getMetrics())
    } else {
      drawRulers(this.host, w, h, this.hasCursor ? this.mouseWorld : null)
    }

    // Floating typed Distance/Angle widget at the cursor.
    this.syncDynWidget()

    if (this.selectedZoneId != null) this.emitRoom()
  }

  /** Zone tints + the room tags they yield. Refreshes the core-truth zone stats
   *  first (cached on a zone fingerprint) so the tags carry plate-clipped area. */
  private paintZones(zones?: DocZone[]): ZoneTag[] {
    if (!zones || zones.length === 0) return []
    this.updateZoneStats(zones)
    return drawZones(this.host, zones, this.platePoly, this.zoneStats)
  }

  /** Outline + handles for the selected room (nothing when none is selected). */
  private paintRoomSelection() {
    const z = this.rooms.selectedZone()
    if (!z) return
    drawRoomSelection(this.host, z, this.rooms.screenBox(z))
  }

  /** Floor-plate polygon for zone clipping, cached on a cheap wall fingerprint
   *  (walls change rarely; `ed.plate()` re-traces + serializes on every call).
   *  Also classifies which walls lie ON the plate boundary (exterior ink). */
  private platePoly: [number, number][] | null = null
  private plateKey = ''
  private exteriorIds = new Set<number>()

  private updatePlate(walls: DocWall[]) {
    let sum = 0
    for (const w of walls) sum += w.a.x + w.a.y * 7 + w.b.x * 13 + w.b.y * 31
    const key = `${walls.length}:${sum.toFixed(4)}`
    if (key === this.plateKey) return
    this.plateKey = key
    this.platePoly = (this.ed.plate() as [number, number][] | null | undefined) ?? null
    // Exterior = both endpoints sit on the traced plate boundary (within 8 cm).
    this.exteriorIds.clear()
    const poly = this.platePoly
    if (poly && poly.length >= 3) {
      for (const w of walls) {
        if (w.generated ?? false) continue
        if (distToPoly(poly, w.a) < 0.08 && distToPoly(poly, w.b) < 0.08) {
          this.exteriorIds.add(w.id)
        }
      }
    }
  }

  /** Per-zone Rust-truth stats (plate-clipped area, capacity), cached on a
   *  zone fingerprint — `zone_stats()` re-clips + serializes on every call. */
  private zoneStats = new Map<number, ZoneStat>()
  private zoneStatsKey = ''

  private updateZoneStats(zones: DocZone[]) {
    let sum = 0
    for (const z of zones) {
      const s = z.shape
      if (s.kind === 'Poly') {
        sum += z.id * 3
        for (const [px, py] of s.pts) sum += px * 13 + py * 31
      } else {
        sum += z.id * 3 + s.x + s.y * 7 + s.w * 13 + s.h * 31
      }
    }
    const key = `${zones.length}:${sum.toFixed(4)}:${this.plateKey}`
    if (key === this.zoneStatsKey) return
    this.zoneStatsKey = key
    this.zoneStats = new Map(this.getZoneStats().map((s) => [s.id, s]))
  }
}

/** The core's open-plan share of headcount seated at open workstations.
 *  THE one owner is `layout::OPEN_SHARE`; this is the boundary read, so the
 *  frontend never keeps its own copy (two had already drifted — 0.85 vs 0.90).
 *  Requires wasm to be initialised, so pure/node-testable modules take the value
 *  as a parameter instead of importing this. */
export function openShare(): number | null {
  try {
    return open_share()
  } catch {
    // wasm not initialised yet. Returning null — never a hardcoded stand-in: a
    // fallback constant here is precisely how the 0.85 / 0.90 split happened.
    // Callers show "—" until the core can answer.
    return null
  }
}
