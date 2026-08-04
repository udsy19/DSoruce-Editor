// Annotation drafting tools: dimension (linear/aligned) + text.
// Each returns a fresh CadTool (see cad/model.ts). The host feeds ALREADY-SNAPPED
// world points to onDown/onMove; typed characters arrive via onKey.

import type { CadTool, ToolCtx, Vec2, SnapResult } from './model'
import { CAD_COLOR } from './model'
import { MONO } from '../ui/type'

// ---- local geometry helpers (world = meters, no Y-flip) ----
const sub = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x - q.x, y: p.y - q.y })
const add = (p: Vec2, q: Vec2): Vec2 => ({ x: p.x + q.x, y: p.y + q.y })
const scale = (p: Vec2, s: number): Vec2 => ({ x: p.x * s, y: p.y * s })
const len = (p: Vec2): number => Math.hypot(p.x, p.y)
const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y)
const fmtM = (m: number): string => `${m.toFixed(2)} m`

/** unit vector a→b, and its left normal; safe for degenerate a==b */
function baseline(a: Vec2, b: Vec2): { u: Vec2; n: Vec2 } {
  const d = sub(b, a)
  const l = len(d)
  if (l < 1e-9) return { u: { x: 1, y: 0 }, n: { x: 0, y: 1 } }
  const u = { x: d.x / l, y: d.y / l }
  return { u, n: { x: -u.y, y: u.x } }
}

// ---- dimension ----
// clicks: (1) point a  (2) point b  (3) a point whose perpendicular distance
// from the a→b baseline becomes the signed `offset`.
function dimensionTool(): CadTool {
  let a: Vec2 | null = null
  let b: Vec2 | null = null
  let cursor: Vec2 | null = null

  /** signed perpendicular offset of the cursor from the a→b baseline */
  function liveOffset(): number {
    if (!a || !b || !cursor) return 0
    const { n } = baseline(a, b)
    const rel = sub(cursor, a)
    return rel.x * n.x + rel.y * n.y
  }

  return {
    id: 'dimension',
    onDown(world: Vec2, _snap: SnapResult, ctx: ToolCtx) {
      if (!a) {
        a = world
      } else if (!b) {
        b = world
      } else {
        const { n } = baseline(a, b)
        const rel = sub(world, a)
        const offset = rel.x * n.x + rel.y * n.y
        ctx.store.add({ kind: 'dimension', a, b, offset } as never)
        a = null
        b = null
        cursor = null
        ctx.requestRender()
      }
    },
    onMove(world: Vec2) {
      cursor = world
    },
    onKey() {},
    drawPreview(g: CanvasRenderingContext2D, ctx: ToolCtx) {
      if (!a) return
      const color = CAD_COLOR.dimension
      const dot = (p: Vec2) => {
        const s = ctx.toScreen(p)
        g.beginPath()
        g.arc(s.x, s.y, 3, 0, Math.PI * 2)
        g.fillStyle = color
        g.fill()
      }
      dot(a)

      // Before b: rubber baseline a→cursor.
      if (!b) {
        if (!cursor) return
        const sa = ctx.toScreen(a)
        const sc = ctx.toScreen(cursor)
        g.save()
        g.strokeStyle = color
        g.lineWidth = 1
        g.setLineDash([4, 4])
        g.beginPath()
        g.moveTo(sa.x, sa.y)
        g.lineTo(sc.x, sc.y)
        g.stroke()
        g.restore()
        return
      }

      dot(b)
      const { n } = baseline(a, b)
      const off = liveOffset()
      const oa = add(a, scale(n, off))
      const ob = add(b, scale(n, off))
      const sa = ctx.toScreen(a)
      const sb = ctx.toScreen(b)
      const soa = ctx.toScreen(oa)
      const sob = ctx.toScreen(ob)

      g.save()
      g.strokeStyle = color
      g.fillStyle = color
      g.lineWidth = 1
      // extension lines a→oa, b→ob
      g.beginPath()
      g.moveTo(sa.x, sa.y)
      g.lineTo(soa.x, soa.y)
      g.moveTo(sb.x, sb.y)
      g.lineTo(sob.x, sob.y)
      g.stroke()
      // dimension line oa→ob
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(soa.x, soa.y)
      g.lineTo(sob.x, sob.y)
      g.stroke()
      // measured distance at midpoint
      const mid = { x: (soa.x + sob.x) / 2, y: (soa.y + sob.y) / 2 }
      g.font = `11px ${MONO}`
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(fmtM(dist(a, b)), mid.x, mid.y - 3)
      g.restore()
    },
    hint(): string {
      if (a && b) return fmtM(dist(a, b))
      if (a && cursor) return fmtM(dist(a, cursor))
      return ''
    },
    cancel() {
      a = null
      b = null
      cursor = null
    },
  }
}

// ---- text ----
// click sets the caret; typed keys build the string; Enter commits, Esc cancels.
function textTool(): CadTool {
  let at: Vec2 | null = null
  let text = ''

  const reset = () => {
    at = null
    text = ''
  }

  return {
    id: 'text',
    onDown(world) {
      at = world
      text = ''
    },
    onMove() {},
    onKey(key: string, ctx: ToolCtx) {
      if (!at) return
      if (key === 'Escape') {
        reset()
      } else if (key === 'Enter') {
        if (text.length > 0) {
          ctx.store.add({ kind: 'text', at, text, h: 0.3, rotation: 0 } as never)
        }
        reset()
      } else if (key === 'Backspace') {
        text = text.slice(0, -1)
      } else if (key.length === 1) {
        // single-char keys are printable (incl. ' '); multi-char keys (Shift,
        // Arrow…) are ignored.
        text += key
      }
      ctx.requestRender()
    },
    drawPreview(g: CanvasRenderingContext2D, ctx: ToolCtx) {
      if (!at) return
      const s = ctx.toScreen(at)
      const px = Math.max(9, 0.3 * ctx.pxPerM)
      g.save()
      g.font = `${px}px "Space Grotesk", sans-serif`
      g.textAlign = 'left'
      g.textBaseline = 'alphabetic'
      g.fillStyle = CAD_COLOR.text
      if (text) g.fillText(text, s.x, s.y)
      // caret bar just past the current string
      const w = text ? g.measureText(text).width : 0
      const cx = s.x + w + 1
      g.strokeStyle = CAD_COLOR.text
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, s.y + px * 0.15)
      g.lineTo(cx, s.y - px * 0.85)
      g.stroke()
      g.restore()
    },
    hint(): string {
      return text
    },
    cancel() {
      reset()
    },
  }
}

export const ANNO_TOOLS: Record<string, () => CadTool> = {
  dimension: dimensionTool,
  text: textTool,
}
