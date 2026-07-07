// Architectural / BIM drafting tools: door (swing symbol), window (in-wall
// break), column. Each returns a fresh CadTool (see cad/model.ts). The host
// feeds ALREADY-SNAPPED world points to onDown/onMove — snapped points ideally
// land on a wall segment, which is how these objects become "wall-hosted".

import type { CadTool, ToolCtx, Vec2, SnapResult } from './model'
import { CAD_COLOR } from './model'

// ---- local geometry helpers (world = meters, no Y-flip) ----
const dist = (p: Vec2, q: Vec2): number => Math.hypot(p.x - q.x, p.y - q.y)
const angleOf = (from: Vec2, to: Vec2): number => Math.atan2(to.y - from.y, to.x - from.x)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const fmtM = (m: number): string => `${m.toFixed(2)} m`
const along = (o: Vec2, ang: number, d: number): Vec2 => ({
  x: o.x + Math.cos(ang) * d,
  y: o.y + Math.sin(ang) * d,
})

/** draw a world polyline in screen space, transform-agnostic (handles Y-flip) */
function strokeWorld(g: CanvasRenderingContext2D, ctx: ToolCtx, pts: Vec2[], closed = false) {
  if (pts.length < 2) return
  g.beginPath()
  const s0 = ctx.toScreen(pts[0])
  g.moveTo(s0.x, s0.y)
  for (let i = 1; i < pts.length; i++) {
    const s = ctx.toScreen(pts[i])
    g.lineTo(s.x, s.y)
  }
  if (closed) g.closePath()
  g.stroke()
}

/** sample a world-space arc into a polyline (robust to any screen transform) */
function arcPts(center: Vec2, radius: number, a0: number, a1: number, steps = 24): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps
    out.push(along(center, t, radius))
  }
  return out
}

// ---- door ----
// clicks: (1) hinge `at` (snapped onto a wall)  (2) swing direction + leaf width.
// 'f' toggles the flip applied to the NEXT placed door.
const DOOR_MIN = 0.6
const DOOR_MAX = 1.2
const DOOR_DEFAULT = 0.9

function doorTool(): CadTool {
  let at: Vec2 | null = null
  let cursor: Vec2 | null = null
  let nextFlip = false

  /** leaf width from the current cursor, clamped; default when barely moved */
  function liveWidth(): number {
    if (!at || !cursor) return DOOR_DEFAULT
    const d = dist(at, cursor)
    return d < 0.05 ? DOOR_DEFAULT : clamp(d, DOOR_MIN, DOOR_MAX)
  }
  function liveAngle(): number {
    if (!at || !cursor) return 0
    return angleOf(at, cursor)
  }

  function drawDoor(g: CanvasRenderingContext2D, ctx: ToolCtx, o: Vec2, width: number, ang: number, flip: boolean) {
    const sweep = flip ? -Math.PI / 2 : Math.PI / 2
    // leaf line: hinge → open leaf tip along the swing direction
    strokeWorld(g, ctx, [o, along(o, ang, width)])
    // 90° swing arc from the leaf tip back toward the wall
    strokeWorld(g, ctx, arcPts(o, width, ang, ang - sweep))
  }

  return {
    id: 'door',
    onDown(world: Vec2, _snap: SnapResult, ctx: ToolCtx) {
      if (!at) {
        at = world
        cursor = world
      } else {
        const width = liveWidth()
        const angle = liveAngle()
        ctx.store.add({ kind: 'door', at, width, angle, hinge: 'left', flip: nextFlip } as never)
        at = null
        cursor = null
        ctx.requestRender()
      }
    },
    onMove(world: Vec2) {
      cursor = world
    },
    onKey(key: string, ctx: ToolCtx) {
      if (key === 'Escape') {
        at = null
        cursor = null
        ctx.requestRender()
      } else if (key === 'f' || key === 'F') {
        nextFlip = !nextFlip
        ctx.requestRender()
      }
    },
    drawPreview(g: CanvasRenderingContext2D, ctx: ToolCtx) {
      if (!at) return
      g.save()
      g.strokeStyle = CAD_COLOR.door
      g.lineWidth = 1.5
      // hinge marker
      const s = ctx.toScreen(at)
      g.beginPath()
      g.arc(s.x, s.y, 3, 0, Math.PI * 2)
      g.fillStyle = CAD_COLOR.door
      g.fill()
      drawDoor(g, ctx, at, liveWidth(), liveAngle(), nextFlip)
      g.restore()
    },
    hint(): string {
      const f = nextFlip ? '  flip' : ''
      return `${fmtM(liveWidth())}${f}`
    },
    cancel() {
      at = null
      cursor = null
    },
  }
}

// ---- window ----
// clicks: (1) start `at` on a wall  (2) other end → width + angle; the entity
// stores the START as `at`. thickness defaults to a typical wall depth.
const WIN_DEFAULT = 1.2
const WIN_THICK = 0.1

function windowTool(): CadTool {
  let at: Vec2 | null = null
  let cursor: Vec2 | null = null

  const liveWidth = (): number => {
    if (!at || !cursor) return WIN_DEFAULT
    const d = dist(at, cursor)
    return d < 0.05 ? WIN_DEFAULT : d
  }
  const liveAngle = (): number => (at && cursor ? angleOf(at, cursor) : 0)

  function drawWindow(g: CanvasRenderingContext2D, ctx: ToolCtx, o: Vec2, width: number, ang: number, th: number) {
    const nx = -Math.sin(ang)
    const ny = Math.cos(ang)
    const end = along(o, ang, width)
    const half = th / 2
    const a1 = { x: o.x + nx * half, y: o.y + ny * half }
    const b1 = { x: end.x + nx * half, y: end.y + ny * half }
    const a2 = { x: o.x - nx * half, y: o.y - ny * half }
    const b2 = { x: end.x - nx * half, y: end.y - ny * half }
    // two parallel glass lines
    strokeWorld(g, ctx, [a1, b1])
    strokeWorld(g, ctx, [a2, b2])
    // end caps close the in-wall break
    strokeWorld(g, ctx, [a1, a2])
    strokeWorld(g, ctx, [b1, b2])
  }

  return {
    id: 'window',
    onDown(world: Vec2, _snap: SnapResult, ctx: ToolCtx) {
      if (!at) {
        at = world
        cursor = world
      } else {
        const width = liveWidth()
        const angle = liveAngle()
        ctx.store.add({ kind: 'window', at, width, angle, thickness: WIN_THICK } as never)
        at = null
        cursor = null
        ctx.requestRender()
      }
    },
    onMove(world: Vec2) {
      cursor = world
    },
    onKey(key: string, ctx: ToolCtx) {
      if (key === 'Escape') {
        at = null
        cursor = null
        ctx.requestRender()
      }
    },
    drawPreview(g: CanvasRenderingContext2D, ctx: ToolCtx) {
      if (!at) return
      g.save()
      g.strokeStyle = CAD_COLOR.window
      g.lineWidth = 1.5
      const s = ctx.toScreen(at)
      g.beginPath()
      g.arc(s.x, s.y, 3, 0, Math.PI * 2)
      g.fillStyle = CAD_COLOR.window
      g.fill()
      drawWindow(g, ctx, at, liveWidth(), liveAngle(), WIN_THICK)
      g.restore()
    },
    hint(): string {
      return fmtM(liveWidth())
    },
    cancel() {
      at = null
      cursor = null
    },
  }
}

// ---- column ----
// single click places a column; 'r' toggles rect/round for the NEXT one.
const COL_SIZE = 0.4

function columnTool(): CadTool {
  let cursor: Vec2 | null = null
  let shape: 'rect' | 'round' = 'rect'

  return {
    id: 'column',
    onDown(world: Vec2, _snap: SnapResult, ctx: ToolCtx) {
      ctx.store.add({
        kind: 'column',
        at: world,
        w: COL_SIZE,
        h: COL_SIZE,
        shape,
        rotation: 0,
      } as never)
      ctx.requestRender()
    },
    onMove(world: Vec2) {
      cursor = world
    },
    onKey(key: string, ctx: ToolCtx) {
      if (key === 'r' || key === 'R') {
        shape = shape === 'rect' ? 'round' : 'rect'
        ctx.requestRender()
      }
    },
    drawPreview(g: CanvasRenderingContext2D, ctx: ToolCtx) {
      if (!cursor) return
      g.save()
      g.strokeStyle = CAD_COLOR.column
      g.fillStyle = 'rgba(58,64,72,0.15)'
      g.lineWidth = 1.5
      const half = COL_SIZE / 2
      if (shape === 'round') {
        const s = ctx.toScreen(cursor)
        const r = half * ctx.pxPerM
        g.beginPath()
        g.arc(s.x, s.y, r, 0, Math.PI * 2)
        g.fill()
        g.stroke()
      } else {
        const c = cursor
        const corners: Vec2[] = [
          { x: c.x - half, y: c.y - half },
          { x: c.x + half, y: c.y - half },
          { x: c.x + half, y: c.y + half },
          { x: c.x - half, y: c.y + half },
        ]
        strokeWorld(g, ctx, corners, true)
        g.fill()
      }
      g.restore()
    },
    hint(): string {
      return `${fmtM(COL_SIZE)} × ${fmtM(COL_SIZE)}  ${shape}`
    },
    cancel() {
      cursor = null
    },
  }
}

export const ARCH_TOOLS: Record<string, () => CadTool> = {
  door: doorTool,
  window: windowTool,
  column: columnTool,
}
