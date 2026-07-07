import type { Drawing, DrawEntity, FurnitureItem, Category } from './types'
import { CATEGORY_COLOR } from './types'

/**
 * Framework-agnostic CAD renderer for an imported {@link Drawing}. Renders
 * real architectural linework (walls, glazing, doors, casework, annotation) at
 * CAD fidelity plus selectable furniture blocks. Mirrors the light "floor-plate"
 * aesthetic of {@link ../editor/EditorCanvas} (white plate on #f2f4f7 mat, thin
 * dark walls) with pan/zoom/DPR handling.
 *
 * ── Coordinates ───────────────────────────────────────────────────────────
 * The Drawing is in METERS, world-space, Y-UP (DXF/CAD convention). This
 * renderer flips Y for the screen: screenX = wx·scale + ox, screenY = −wy·scale
 * + oy. Arc/text angles (radians, CCW in world) become clockwise on screen, so
 * we negate them when drawing.
 */

// Mat behind the plate — matches EditorCanvas C.mat.
const MAT = '#f2f4f7'
// Furniture linework (gray).
const FURNITURE_LINE = '#5c6670'
// Selection = warm amber accent; hover = a lighter amber wash. Kept distinct
// from the blue used for product-bound items so the two never read the same.
const ACCENT = '#E8A13C'
const ACCENT_HALO = 'rgba(232,161,60,0.28)'
const HOVER = 'rgba(232,161,60,0.55)'
// Bound ("specified"/re-imagined) furniture — solid data-blue so a decided item
// reads distinctly from both unbound gray linework and the amber selection.
const SPECIFIED = '#2d5bd6'

const MIN_SCALE = 2
const MAX_SCALE = 4000
const FIT_PADDING = 40 // px padding around bounds in fitToView
const TEXT_MIN_PX = 6.5 // hide text glyphs smaller than this on screen
const DRAG_THRESHOLD = 4 // px movement below which a mouse-up is a click
const ROTATE_STEP = Math.PI / 12 // 15° per keypress
const DUP_OFFSET = 0.3 // meters — nudge for a duplicated item
const HANDLE_PX = 3 // half-size of selection corner handles, screen px
const UNDO_CAP = 50 // max snapshots kept

/** Per-category screen lineweight (CSS px), independent of zoom. */
const LINE_WEIGHT: Record<Category, number> = {
  wall: 1.6,
  glazing: 1,
  door: 1,
  furniture: 1,
  casework: 1,
  fixture: 1,
  annotation: 0.75,
  dimension: 0.75,
  other: 1,
}

/** Draw order rank — faint annotation underneath, architecture on top. */
const RANK: Record<Category, number> = {
  dimension: 0,
  annotation: 1,
  other: 2,
  fixture: 3,
  casework: 4,
  door: 6,
  glazing: 7,
  wall: 8,
  furniture: 5, // furniture is drawn in its own pass; kept for completeness
}
const FURNITURE_RANK = 5

interface StyleBucket {
  color: string
  lw: number
  rank: number
  ents: DrawEntity[]
}

export class DrawingCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr = Math.max(1, window.devicePixelRatio || 1)

  private drawing: Drawing | null = null
  private buckets: StyleBucket[] = []
  private texts: DrawEntity[] = []

  private scale = 40 // px per meter
  private offset = { x: 0, y: 0 } // screen px of world origin

  private selected: FurnitureItem | null = null
  private hovered: FurnitureItem | null = null

  // pan / click / move bookkeeping
  private pointerDown = false
  private didPan = false
  private movingActive = false
  private moveCandidate: FurnitureItem | null = null
  private lastScreen = { x: 0, y: 0 }
  private downScreen = { x: 0, y: 0 }
  private lastWorld = { x: 0, y: 0 }

  // undo: snapshots of drawing.furniture taken before each mutation.
  private undoStack: FurnitureItem[][] = []

  private ro: ResizeObserver | null = null

  /** Fired on click: the furniture item under the cursor, or null on empty space. */
  onSelect: ((item: FurnitureItem | null) => void) | null = null
  /** Fired when the hovered furniture item changes (optional). */
  onHover: ((item: FurnitureItem | null) => void) | null = null
  /** Fired after any edit (move/rotate/delete/duplicate/undo) with the mutated drawing. */
  onChange: ((d: Drawing) => void) | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.attach()
    this.resize()
    this.render()
  }

  // ---- public API ----

  /** Store a drawing, precompute style buckets, frame it, and render. */
  setDrawing(d: Drawing): void {
    this.drawing = d
    this.selected = null
    this.hovered = null
    this.undoStack = []
    this.buildBuckets(d)
    this.fitToView() // also renders
  }

  /** Force a re-render without touching pan/zoom — used after an external edit
   *  (e.g. the inspector binds a product to the selected item). */
  refresh(): void {
    this.render()
  }

  /** Restore the last pre-edit snapshot of the furniture. No-op if nothing to undo. */
  undo(): void {
    const d = this.drawing
    if (!d || this.undoStack.length === 0) return
    d.furniture = this.undoStack.pop() as FurnitureItem[]
    this.selected = null
    this.hovered = null
    this.onSelect?.(null)
    this.render()
    this.emitChange()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /** Frame `drawing.bounds` in the viewport with padding. */
  fitToView(): void {
    const d = this.drawing
    const { w, h } = this.cssSize()
    if (!d || w === 0 || h === 0) {
      this.render()
      return
    }
    const [minX, minY, maxX, maxY] = d.bounds
    const worldW = Math.max(1e-3, maxX - minX)
    const worldH = Math.max(1e-3, maxY - minY)
    const sx = (w - 2 * FIT_PADDING) / worldW
    const sy = (h - 2 * FIT_PADDING) / worldH
    this.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE)
    // Center the world bbox center at the viewport center (Y flipped).
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    this.offset.x = w / 2 - cx * this.scale
    this.offset.y = h / 2 + cy * this.scale
    this.render()
  }

  dispose(): void {
    this.ro?.disconnect()
    this.ro = null
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('mouseleave', this.onLeave)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
  }

  // ---- transforms ----
  private toScreen(wx: number, wy: number) {
    return { x: wx * this.scale + this.offset.x, y: -wy * this.scale + this.offset.y }
  }
  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.offset.x) / this.scale, y: -(sy - this.offset.y) / this.scale }
  }

  private cssSize() {
    return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr }
  }

  // ---- setup: precompute style buckets so pan/zoom stay cheap ----
  private buildBuckets(d: Drawing) {
    const byKey = new Map<string, StyleBucket>()
    this.texts = []
    for (const e of d.entities) {
      if (e.kind === 'text') {
        this.texts.push(e)
        continue
      }
      const color = e.color ?? CATEGORY_COLOR[e.category] ?? CATEGORY_COLOR.other
      const lw = LINE_WEIGHT[e.category] ?? 1
      const key = `${color}|${lw}`
      let b = byKey.get(key)
      if (!b) {
        b = { color, lw, rank: RANK[e.category] ?? 2, ents: [] }
        byKey.set(key, b)
      }
      b.ents.push(e)
    }
    this.buckets = [...byKey.values()].sort((a, b) => a.rank - b.rank)
  }

  // ---- events ----
  private attach() {
    this.canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('mouseleave', this.onLeave)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('keydown', this.onKey)
    // DPR-aware container resize.
    if (typeof ResizeObserver !== 'undefined' && this.canvas.parentElement) {
      this.ro = new ResizeObserver(() => {
        this.resize()
        this.render()
      })
      this.ro.observe(this.canvas.parentElement)
    }
  }

  private screenFromEvent(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onDown = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    this.pointerDown = true
    this.didPan = false
    this.movingActive = false
    this.lastScreen = s
    this.downScreen = s
    // Hitting a furniture item selects it and arms a MOVE (started once we drag
    // past the threshold). Empty space stays a pan.
    const hit = this.pickFurniture(s.x, s.y)
    this.moveCandidate = hit
    if (hit) {
      if (this.selected !== hit) {
        this.selected = hit
        this.onSelect?.(hit)
      }
      this.lastWorld = this.toWorld(s.x, s.y)
      this.render()
    }
  }

  private onMove = (e: MouseEvent) => {
    const s = this.screenFromEvent(e)
    if (this.pointerDown) {
      if (
        !this.didPan &&
        !this.movingActive &&
        Math.hypot(s.x - this.downScreen.x, s.y - this.downScreen.y) > DRAG_THRESHOLD
      ) {
        if (this.moveCandidate) {
          this.movingActive = true
          this.pushUndo()
          this.canvas.style.cursor = 'grabbing'
        } else {
          this.didPan = true
        }
      }
      if (this.movingActive && this.moveCandidate) {
        const w = this.toWorld(s.x, s.y)
        this.translateItem(this.moveCandidate, w.x - this.lastWorld.x, w.y - this.lastWorld.y)
        this.lastWorld = w
        this.render()
      } else if (this.didPan) {
        this.offset.x += s.x - this.lastScreen.x
        this.offset.y += s.y - this.lastScreen.y
        this.render()
      }
      this.lastScreen = s
      return
    }
    // Hover hit-test only when not dragging.
    const within = s.x >= 0 && s.y >= 0 && s.x <= this.cssSize().w && s.y <= this.cssSize().h
    const hit = within ? this.pickFurniture(s.x, s.y) : null
    this.canvas.style.cursor = hit ? 'move' : 'default'
    if (hit !== this.hovered) {
      this.hovered = hit
      this.onHover?.(hit)
      this.render()
    }
  }

  private onUp = (e: MouseEvent) => {
    if (!this.pointerDown) return
    this.pointerDown = false
    const wasPan = this.didPan
    const wasMoving = this.movingActive
    this.movingActive = false
    this.moveCandidate = null
    this.canvas.style.cursor = 'default'
    if (wasMoving) {
      this.emitChange() // a drag-move committed
      return
    }
    if (wasPan) return // was a pan, not a click
    // Plain click: (de)select the item under the cursor.
    const s = this.screenFromEvent(e)
    const hit = this.pickFurniture(s.x, s.y)
    if (hit !== this.selected) {
      this.selected = hit
      this.onSelect?.(hit)
    }
    this.render()
  }

  private onLeave = () => {
    if (this.hovered) {
      this.hovered = null
      this.onHover?.(null)
      this.render()
    }
  }

  // ---- keyboard: rotate / delete / duplicate / undo ----
  private onKey = (e: KeyboardEvent) => {
    if (!this.drawing) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      e.preventDefault()
      this.undo()
      return
    }
    if (mod && key === 'd') {
      e.preventDefault()
      this.duplicateSelected()
      return
    }
    if (mod) return // leave other browser shortcuts alone
    if (!this.selected) return
    if (key === 'r') {
      e.preventDefault()
      this.rotateSelected(e.shiftKey ? -ROTATE_STEP : ROTATE_STEP)
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault()
      this.deleteSelected()
    }
  }

  // ---- edit operations (each snapshots for undo, mutates, re-renders, onChange) ----
  private rotateSelected(angle: number) {
    if (!this.selected) return
    this.pushUndo()
    this.rotateItem(this.selected, angle)
    this.render()
    this.emitChange()
  }

  private deleteSelected() {
    const d = this.drawing
    if (!d || !this.selected) return
    this.pushUndo()
    const i = d.furniture.indexOf(this.selected)
    if (i >= 0) d.furniture.splice(i, 1)
    this.selected = null
    this.hovered = null
    this.onSelect?.(null)
    this.render()
    this.emitChange()
  }

  private duplicateSelected() {
    const d = this.drawing
    if (!d || !this.selected) return
    this.pushUndo()
    const clone = structuredClone(this.selected)
    clone.id = d.furniture.reduce((m, f) => Math.max(m, f.id), 0) + 1
    this.translateItem(clone, DUP_OFFSET, -DUP_OFFSET)
    d.furniture.push(clone)
    this.selected = clone
    this.onSelect?.(clone)
    this.render()
    this.emitChange()
  }

  /** Translate one item (origin, all entity geometry, and bbox) by a world delta. */
  private translateItem(it: FurnitureItem, dx: number, dy: number) {
    it.origin[0] += dx
    it.origin[1] += dy
    for (const e of it.entities) {
      if (e.pts) for (const p of e.pts) ((p[0] += dx), (p[1] += dy))
      if (e.cx !== undefined) e.cx += dx
      if (e.cy !== undefined) e.cy += dy
      if (e.tx !== undefined) e.tx += dx
      if (e.ty !== undefined) e.ty += dy
    }
    const [minX, minY, maxX, maxY] = it.bbox
    it.bbox = [minX + dx, minY + dy, maxX + dx, maxY + dy]
  }

  /** Rotate one item about its bbox center by `angle` (radians, CCW world). */
  private rotateItem(it: FurnitureItem, angle: number) {
    const [minX, minY, maxX, maxY] = it.bbox
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const rot = (x: number, y: number): [number, number] => {
      const px = x - cx
      const py = y - cy
      return [cx + px * cos - py * sin, cy + px * sin + py * cos]
    }
    ;[it.origin[0], it.origin[1]] = rot(it.origin[0], it.origin[1])
    for (const e of it.entities) {
      if (e.pts) for (const p of e.pts) [p[0], p[1]] = rot(p[0], p[1])
      if (e.cx !== undefined && e.cy !== undefined) [e.cx, e.cy] = rot(e.cx, e.cy)
      if (e.kind === 'arc') {
        if (e.start !== undefined) e.start += angle
        if (e.end !== undefined) e.end += angle
      }
      if (e.tx !== undefined && e.ty !== undefined) {
        ;[e.tx, e.ty] = rot(e.tx, e.ty)
        e.rot = (e.rot ?? 0) + angle
      }
    }
    it.rotation += angle
    this.recomputeBbox(it)
  }

  /** Recompute an item's axis-aligned bbox from its (already-transformed) geometry. */
  private recomputeBbox(it: FurnitureItem) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const ext = (x: number, y: number) => {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    for (const e of it.entities) {
      if (e.pts) for (const p of e.pts) ext(p[0], p[1])
      if (e.cx !== undefined && e.cy !== undefined && e.r !== undefined) {
        ext(e.cx - e.r, e.cy - e.r)
        ext(e.cx + e.r, e.cy + e.r)
      }
      if (e.tx !== undefined && e.ty !== undefined) ext(e.tx, e.ty)
    }
    if (minX <= maxX && minY <= maxY) it.bbox = [minX, minY, maxX, maxY]
  }

  private pushUndo() {
    if (!this.drawing) return
    this.undoStack.push(structuredClone(this.drawing.furniture))
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift()
  }

  private emitChange() {
    if (this.drawing) this.onChange?.(this.drawing)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const s = this.screenFromEvent(e)
    const before = this.toWorld(s.x, s.y)
    const factor = Math.exp(-e.deltaY * 0.0015)
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE)
    // Keep the world point under the cursor fixed (Y flipped).
    this.offset.x = s.x - before.x * this.scale
    this.offset.y = s.y + before.y * this.scale
    this.render()
  }

  private onResize = () => {
    this.resize()
    this.render()
  }

  private resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return // hidden
    this.dpr = Math.max(1, window.devicePixelRatio || 1)
    this.canvas.width = Math.floor(rect.width * this.dpr)
    this.canvas.height = Math.floor(rect.height * this.dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
  }

  // ---- furniture hit-test (topmost by draw order) ----
  private pickFurniture(sx: number, sy: number): FurnitureItem | null {
    const d = this.drawing
    if (!d) return null
    const w = this.toWorld(sx, sy)
    for (let i = d.furniture.length - 1; i >= 0; i--) {
      const it = d.furniture[i]
      const [minX, minY, maxX, maxY] = it.bbox
      if (w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY) return it
    }
    return null
  }

  // ---- rendering ----
  private render() {
    const ctx = this.ctx
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const { w, h } = this.cssSize()
    if (w === 0 || h === 0) return

    ctx.fillStyle = MAT
    ctx.fillRect(0, 0, w, h)

    const d = this.drawing
    if (!d) return

    // White floor plate over the drawing bounds (Rayon/Revit look).
    const [minX, minY, maxX, maxY] = d.bounds
    const p0 = this.toScreen(minX, maxY) // top-left on screen (maxY = top)
    const p1 = this.toScreen(maxX, minY) // bottom-right
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)

    // Style-batched linework: architecture buckets, with furniture woven in at
    // its rank so walls/glazing/doors sit on top.
    let furnitureDrawn = false
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const b of this.buckets) {
      if (!furnitureDrawn && b.rank >= FURNITURE_RANK) {
        this.drawFurniture(d)
        furnitureDrawn = true
      }
      ctx.strokeStyle = b.color
      ctx.lineWidth = b.lw
      ctx.beginPath()
      for (const e of b.ents) this.appendEntity(e)
      ctx.stroke()
    }
    if (!furnitureDrawn) this.drawFurniture(d)

    this.drawTexts(d)
    this.drawHighlights()
  }

  /** Furniture linework: unbound in gray, bound ("specified") in a muted accent —
   *  two batched strokes so a re-imagined item reads distinctly. */
  private drawFurniture(d: Drawing) {
    if (d.furniture.length === 0) return
    const ctx = this.ctx
    let hasBound = false
    ctx.strokeStyle = FURNITURE_LINE
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const it of d.furniture) {
      if (it.productId) {
        hasBound = true
        continue
      }
      for (const e of it.entities) this.appendEntity(e)
    }
    ctx.stroke()
    if (!hasBound) return
    ctx.strokeStyle = SPECIFIED
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const it of d.furniture) {
      if (!it.productId) continue
      for (const e of it.entities) this.appendEntity(e)
    }
    ctx.stroke()
  }

  private drawTexts(d: Drawing) {
    const ctx = this.ctx
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    for (const e of this.texts) {
      if (!e.text || e.tx === undefined || e.ty === undefined) continue
      const px = (e.h ?? 0.2) * this.scale
      if (px < TEXT_MIN_PX) continue // too small to be legible; skip for clarity + perf
      const p = this.toScreen(e.tx, e.ty)
      ctx.save()
      ctx.translate(p.x, p.y)
      if (e.rot) ctx.rotate(-e.rot) // world CCW → screen CW
      ctx.fillStyle = e.color ?? CATEGORY_COLOR[e.category] ?? '#9aa2ad'
      ctx.font = `${px.toFixed(1)}px "IBM Plex Mono", ui-monospace, monospace`
      ctx.fillText(e.text, 0, 0)
      ctx.restore()
    }
    void d
  }

  /** Hovered (soft amber wash) + selected (amber halo + crisp outline + bbox). */
  private drawHighlights() {
    const ctx = this.ctx
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (this.hovered && this.hovered !== this.selected) {
      // soft thick wash so a hovered item reads as "pickable" without hiding its linework
      ctx.strokeStyle = HOVER
      ctx.lineWidth = 3
      ctx.beginPath()
      for (const e of this.hovered.entities) this.appendEntity(e)
      ctx.stroke()
    }
    if (this.selected) {
      // 1) translucent halo underneath — makes the selection glow over dense plans
      ctx.strokeStyle = ACCENT_HALO
      ctx.lineWidth = 4
      ctx.beginPath()
      for (const e of this.selected.entities) this.appendEntity(e)
      ctx.stroke()
      // 2) crisp amber outline on top
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1.6
      ctx.beginPath()
      for (const e of this.selected.entities) this.appendEntity(e)
      ctx.stroke()
      // 3) dashed bbox + solid corner handles
      const [minX, minY, maxX, maxY] = this.selected.bbox
      const a = this.toScreen(minX, maxY)
      const b = this.toScreen(maxX, minY)
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1)
      ctx.setLineDash([])
      ctx.fillStyle = ACCENT
      for (const [hx, hy] of [
        [a.x, a.y],
        [b.x, a.y],
        [a.x, b.y],
        [b.x, b.y],
      ]) {
        ctx.fillRect(
          Math.round(hx) - HANDLE_PX,
          Math.round(hy) - HANDLE_PX,
          HANDLE_PX * 2,
          HANDLE_PX * 2,
        )
      }
    }
  }

  /**
   * Append one entity's geometry to the CURRENT path (caller sets style +
   * begins/strokes the path). Each subpath is self-contained (moveTo first) so
   * many entities batch into a single stroke().
   */
  private appendEntity(e: DrawEntity) {
    const ctx = this.ctx
    if (e.kind === 'polyline') {
      const pts = e.pts
      if (!pts || pts.length === 0) return
      const first = this.toScreen(pts[0][0], pts[0][1])
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < pts.length; i++) {
        const p = this.toScreen(pts[i][0], pts[i][1])
        ctx.lineTo(p.x, p.y)
      }
      if (e.closed) ctx.lineTo(first.x, first.y)
    } else if (e.kind === 'circle') {
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
      const c = this.toScreen(e.cx, e.cy)
      const rPx = e.r * this.scale
      ctx.moveTo(c.x + rPx, c.y)
      ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2)
    } else if (e.kind === 'arc') {
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
      const c = this.toScreen(e.cx, e.cy)
      const rPx = e.r * this.scale
      const a0 = -(e.start ?? 0) // world CCW → screen (Y flipped)
      const a1 = -(e.end ?? Math.PI * 2)
      ctx.moveTo(c.x + rPx * Math.cos(a0), c.y + rPx * Math.sin(a0))
      ctx.arc(c.x, c.y, rPx, a0, a1, true)
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
