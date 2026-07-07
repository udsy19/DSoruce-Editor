import init, { Editor } from '../wasm/ds_core'
import { catByCategory } from './catalog'

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
export interface DocState {
  walls: DocWall[]
  components: DocComponent[]
  selection: number | null
}
export interface Metrics {
  floor_area: number
  wall_count: number
  component_count: number
  confirmed: number
}

export type ToolId = string // 'select' | 'wall' | 'place:<Category>'

const GRID_M = 1 // 1-meter grid
const SNAP_M = 0.1 // 10 cm snap

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

  scale = 48 // px per meter
  offset = { x: 90, y: 90 } // screen px of world origin
  tool: ToolId = 'select'

  private wallStart: { x: number; y: number } | null = null
  private mouseWorld = { x: 0, y: 0 }
  private dragging = false
  private panning = false
  private lastScreen = { x: 0, y: 0 }

  onChange: (() => void) | null = null

  private constructor(canvas: HTMLCanvasElement, ed: Editor) {
    this.canvas = canvas
    this.ed = ed
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
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

  // ---- API consumed by React ----
  getState(): DocState {
    return this.ed.state() as DocState
  }
  getMetrics(): Metrics {
    return this.ed.metrics() as Metrics
  }
  getSelected(): DocComponent | null {
    const s = this.getState()
    if (s.selection == null) return null
    return s.components.find((c) => c.id === s.selection) ?? null
  }
  setTool(t: ToolId) {
    this.tool = t
    this.wallStart = null
    this.render()
  }
  assignProduct(id: number, productId: string, name: string) {
    this.ed.assign_product(id, productId, name)
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

  private commit() {
    this.render()
    this.onChange?.()
  }

  // ---- events ----
  private attach() {
    this.canvas.addEventListener('mousedown', this.onDown)
    window.addEventListener('mousemove', this.onMove)
    window.addEventListener('mouseup', this.onUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onCtx)
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('resize', this.onResize)
  }
  dispose() {
    this.canvas.removeEventListener('mousedown', this.onDown)
    window.removeEventListener('mousemove', this.onMove)
    window.removeEventListener('mouseup', this.onUp)
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
    if (this.panning) {
      this.offset.x += s.x - this.lastScreen.x
      this.offset.y += s.y - this.lastScreen.y
      this.lastScreen = s
      this.render()
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
  }

  private onUp = () => {
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
    this.render()
  }

  private onKey = (e: KeyboardEvent) => {
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

  private resize() {
    const parent = this.canvas.parentElement
    if (!parent) return
    const rect = parent.getBoundingClientRect()
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

    ctx.fillStyle = '#0f1420'
    ctx.fillRect(0, 0, w, h)
    this.drawGrid(w, h)

    const st = this.getState()
    for (const wall of st.walls) this.drawSegment(wall.a, wall.b, wall.thickness, '#cdd6e4')

    if (this.tool === 'wall' && this.wallStart) {
      this.drawSegment(this.wallStart, this.snap(this.mouseWorld), 0.1, 'rgba(120,170,255,0.6)')
    }
    for (const c of st.components) this.drawComponent(c, c.id === st.selection)
  }

  private drawGrid(w: number, h: number) {
    const ctx = this.ctx
    const step = GRID_M * this.scale
    if (step >= 6) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.beginPath()
      for (let x = this.offset.x % step; x < w; x += step) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
      for (let y = this.offset.y % step; y < h; y += step) {
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
      }
      ctx.stroke()
    }
    const o = this.toScreen(0, 0)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.moveTo(o.x, 0)
    ctx.lineTo(o.x, h)
    ctx.moveTo(0, o.y)
    ctx.lineTo(w, o.y)
    ctx.stroke()
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
    const item = catByCategory(c.category)
    const color = item?.color ?? '#4f8cff'
    const p = this.toScreen(c.x, c.y)
    const w = c.w * this.scale
    const h = c.h * this.scale

    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(c.rotation)
    ctx.fillStyle = hexA(color, c.decision === 'Confirmed' ? 0.85 : 0.35)
    ctx.strokeStyle = selected ? '#ffffff' : color
    ctx.lineWidth = selected ? 2.5 : 1.5
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(6, Math.min(w, h) * 0.15))
    ctx.fill()
    ctx.stroke()
    ctx.restore()

    if (this.scale > 22) {
      ctx.fillStyle = '#e6edf7'
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(c.label, p.x, p.y)
    }

    const dot =
      c.decision === 'Confirmed' ? '#22c55e' : c.decision === 'InReview' ? '#f59e0b' : '#64748b'
    ctx.fillStyle = dot
    ctx.beginPath()
    ctx.arc(p.x + w / 2 - 6, p.y - h / 2 + 6, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
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
