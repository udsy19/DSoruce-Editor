// Ties the CAD layer together for EditorCanvas: holds the entity store + the
// active tool, applies snapping to every pointer event, and renders entities +
// tool preview + snap indicator + grips. EditorCanvas routes pointer/keyboard/
// render here when a CAD tool is active.
import { createStore } from './store'
import { renderEntities, renderSnapIndicator, renderGrips } from './render'
import { snap as osnap } from './snap'
import { GEOM_TOOLS } from './geomTools'
import { ANNO_TOOLS } from './annoTools'
import { ARCH_TOOLS } from './archTools'
import { EDIT_TOOLS, selection, deleteSelected } from './editTools'
import type { CadTool, ToolCtx, SnapResult, SnapContext, Vec2, RenderCtx, CadStore } from './model'

const REGISTRY: Record<string, () => CadTool> = {
  ...EDIT_TOOLS,
  ...GEOM_TOOLS,
  ...ANNO_TOOLS,
  ...ARCH_TOOLS,
}
export const CAD_TOOL_IDS = Object.keys(REGISTRY)

export interface CadHost {
  toScreen(w: Vec2): { x: number; y: number }
  toWorld(sx: number, sy: number): Vec2
  pxPerM(): number
  requestRender(): void
  snapContext(): Omit<SnapContext, 'from'>
}

export class CadController {
  store: CadStore = createStore()
  /** Shared selection set (owned by the select/modify tools). */
  get selected(): Set<number> {
    return selection.ids
  }
  private tool: CadTool | null = null
  private toolId: string | null = null
  private lastSnap: SnapResult | null = null

  constructor(private host: CadHost) {
    this.store.onChange = () => this.host.requestRender()
  }

  get active(): boolean {
    return this.tool !== null
  }
  get currentId(): string | null {
    return this.toolId
  }

  /** `id` is a bare tool key ('line', 'rect', 'door', …) or null to deactivate. */
  setTool(id: string | null): void {
    this.tool?.cancel()
    if (id && REGISTRY[id]) {
      this.toolId = id
      this.tool = REGISTRY[id]()
    } else {
      this.toolId = null
      this.tool = null
    }
    this.lastSnap = null
    this.host.requestRender()
  }

  private ctx(): ToolCtx {
    return {
      store: this.store,
      snap: (c) => this.snap(c),
      toScreen: (w) => this.host.toScreen(w),
      toWorld: (sx, sy) => this.host.toWorld(sx, sy),
      pxPerM: this.host.pxPerM(),
      requestRender: () => this.host.requestRender(),
      layer: '0',
    }
  }

  snap(cursor: Vec2): SnapResult {
    return osnap(cursor, this.host.snapContext())
  }

  down(sx: number, sy: number, ev: MouseEvent): void {
    if (!this.tool) return
    const s = this.snap(this.host.toWorld(sx, sy))
    this.lastSnap = s
    this.tool.onDown(s.point, s, this.ctx(), ev)
    this.host.requestRender()
  }

  move(sx: number, sy: number): void {
    if (!this.tool) return
    const s = this.snap(this.host.toWorld(sx, sy))
    this.lastSnap = s
    this.tool.onMove(s.point, s, this.ctx())
    this.host.requestRender()
  }

  up(sx: number, sy: number): void {
    if (!this.tool || !this.tool.onUp) return
    const s = this.snap(this.host.toWorld(sx, sy))
    this.tool.onUp(s.point, s, this.ctx())
    this.host.requestRender()
  }

  /** Returns true if the key was consumed by the active tool. */
  key(k: string): boolean {
    if (!this.tool) return false
    if (k === 'Escape') {
      this.tool.cancel()
      this.lastSnap = null
      this.host.requestRender()
      return true
    }
    // Delete removes the current selection (but let the text tool keep Backspace).
    if (k === 'Delete' && this.selected.size > 0) {
      deleteSelected(this.store)
      this.host.requestRender()
      return true
    }
    this.tool.onKey?.(k, this.ctx())
    this.host.requestRender()
    return true
  }

  render(g: CanvasRenderingContext2D, rc: RenderCtx): void {
    renderEntities(g, this.store.entities, rc)
    if (this.tool) {
      this.tool.drawPreview?.(g, this.ctx())
      if (this.lastSnap) renderSnapIndicator(g, this.lastSnap, rc)
    }
    if (this.selected.size) renderGrips(g, this.store.entities, this.selected, rc)
  }

  hint(): string {
    return this.tool?.hint?.() ?? ''
  }
}
