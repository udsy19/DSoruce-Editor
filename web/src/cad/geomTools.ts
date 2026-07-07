// CAD geometry DRAW tools — line, polyline, rect, circle, arc, ellipse.
//
// Each factory in GEOM_TOOLS returns a FRESH CadTool implementing the contract in
// model.ts. The host (EditorCanvas) is responsible for snapping: the `world` point
// passed to onDown/onMove is ALREADY the snap point (snap.point); `snap` only carries
// the snap type/ref. So these tools simply consume world points (meters, no Y-flip).
//
// Integration contract for EditorCanvas:
//  - pointer down  -> tool.onDown(snappedWorld, snap, ctx, mouseEvent)
//  - pointer move  -> tool.onMove(snappedWorld, snap, ctx)   (drives ghost + hint)
//  - each frame    -> tool.drawPreview?.(g2d, ctx)           (dashed accent ghost)
//  - status bar    -> tool.hint?.()                          (live length/angle readout)
//  - Escape/Enter  -> tool.onKey?.(key, ctx)                 (cancel / finish chain)
//  - tool switch   -> tool.cancel()                          (drop in-progress state)
// Multi-vertex tools (polyline) also read mouseEvent.detail>=2 in onDown for double-click.

import type {
  CadTool,
  ToolCtx,
  Vec2,
  SnapResult,
  LineEnt,
  PolylineEnt,
  RectEnt,
  CircleEnt,
  ArcEnt,
  EllipseEnt,
} from './model'

// ---- shared helpers -------------------------------------------------------

/** Ghost stroke color (matches the accent used by dimensions in model.ts). */
const GHOST = '#2d5bd6'

const dist = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y)

/** Segment bearing a→b in degrees, normalized to [0, 360). */
function bearing(a: Vec2, b: Vec2): number {
  let d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  if (d < 0) d += 360
  return d
}

/** CCW (increasing-angle) sweep from one angle to another, in [0, 2π). */
function ccwSpan(from: number, to: number): number {
  const T = Math.PI * 2
  let x = (to - from) % T
  if (x < 0) x += T
  return x
}

function beginGhost(g: CanvasRenderingContext2D) {
  g.save()
  g.strokeStyle = GHOST
  g.lineWidth = 1
  g.setLineDash([4, 3])
}

/** Move/line a screen-space polyline from world points. */
function ghostPath(g: CanvasRenderingContext2D, ctx: ToolCtx, pts: Vec2[]) {
  if (pts.length === 0) return
  const p0 = ctx.toScreen(pts[0])
  g.moveTo(p0.x, p0.y)
  for (let i = 1; i < pts.length; i++) {
    const p = ctx.toScreen(pts[i])
    g.lineTo(p.x, p.y)
  }
}

/**
 * 3-point arc solver. ORDER: p1 = arc START, p2 = arc END, p3 = a point ON the arc
 * (it selects which side / how much the arc bulges). Returns the circumscribed
 * center+radius and start/end angles oriented CCW (increasing angle) so the swept
 * arc passes through p3. Returns null when the three points are collinear.
 */
function arc3(p1: Vec2, p2: Vec2, p3: Vec2): { c: Vec2; r: number; start: number; end: number } | null {
  const { x: ax, y: ay } = p1
  const { x: bx, y: by } = p2
  const { x: gx, y: gy } = p3
  const d = 2 * (ax * (by - gy) + bx * (gy - ay) + gx * (ay - by))
  if (Math.abs(d) < 1e-9) return null // collinear -> no unique circle
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const g2 = gx * gx + gy * gy
  const ux = (a2 * (by - gy) + b2 * (gy - ay) + g2 * (ay - by)) / d
  const uy = (a2 * (gx - bx) + b2 * (ax - gx) + g2 * (bx - ax)) / d
  const c = { x: ux, y: uy }
  const r = Math.hypot(ax - ux, ay - uy)
  let start = Math.atan2(ay - uy, ax - ux)
  let end = Math.atan2(by - uy, bx - ux)
  const mid = Math.atan2(gy - uy, gx - ux)
  // Ensure the CCW sweep start->end actually contains p3; else swap endpoints.
  if (ccwSpan(start, mid) > ccwSpan(start, end)) {
    const t = start
    start = end
    end = t
  }
  return { c, r, start, end }
}

// ---- LINE (continuous chain, AutoCAD-style) -------------------------------

function lineTool(): CadTool {
  let start: Vec2 | null = null
  let cur: Vec2 | null = null

  return {
    id: 'line',
    onDown(world, _snap, ctx) {
      cur = world
      if (!start) {
        start = world
      } else {
        const ent: Omit<LineEnt, 'id'> = { kind: 'line', a: start, b: world, layer: ctx.layer }
        ctx.store.add(ent)
        start = world // continue: next segment starts at this end
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (start) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape' || key === 'Enter') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!start || !cur) return
      beginGhost(g)
      g.beginPath()
      ghostPath(g, ctx, [start, cur])
      g.stroke()
      g.restore()
    },
    hint() {
      if (!start || !cur) return ''
      return `L ${dist(start, cur).toFixed(2)} m  ${bearing(start, cur).toFixed(0)}°`
    },
    cancel() {
      start = null
      cur = null
    },
  }
}

// ---- POLYLINE (multi-vertex; Enter/dbl-click commits, click-first closes) --

function polylineTool(): CadTool {
  let pts: Vec2[] = []
  let cur: Vec2 | null = null

  function commit(ctx: ToolCtx, closed: boolean) {
    if (pts.length >= 2) {
      const ent: Omit<PolylineEnt, 'id'> = {
        kind: 'polyline',
        pts: pts.slice(),
        closed,
        layer: ctx.layer,
      }
      ctx.store.add(ent)
    }
    pts = []
    cur = null
  }

  return {
    id: 'polyline',
    onDown(world, _snap, ctx, ev) {
      cur = world
      // Double-click commits the open polyline (first click already added the vertex).
      if (ev && ev.detail >= 2) {
        commit(ctx, false)
        ctx.requestRender()
        return
      }
      // Click within snap tolerance of the first vertex closes the loop.
      if (pts.length >= 2) {
        const tolW = 12 / ctx.pxPerM
        if (dist(world, pts[0]) <= tolW) {
          commit(ctx, true)
          ctx.requestRender()
          return
        }
      }
      pts.push(world)
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (pts.length > 0) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Enter') {
        commit(ctx, false)
        ctx.requestRender()
      } else if (key === 'c' || key === 'C') {
        commit(ctx, true)
        ctx.requestRender()
      } else if (key === 'Escape') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (pts.length === 0) return
      beginGhost(g)
      g.beginPath()
      const chain = cur ? [...pts, cur] : pts
      ghostPath(g, ctx, chain)
      g.stroke()
      g.restore()
    },
    hint() {
      if (pts.length === 0 || !cur) return ''
      const last = pts[pts.length - 1]
      return `L ${dist(last, cur).toFixed(2)} m  ${bearing(last, cur).toFixed(0)}°`
    },
    cancel() {
      pts = []
      cur = null
    },
  }
}

// ---- RECT (two opposite corners) ------------------------------------------

function rectTool(): CadTool {
  let c1: Vec2 | null = null
  let cur: Vec2 | null = null

  return {
    id: 'rect',
    onDown(world, _snap, ctx) {
      cur = world
      if (!c1) {
        c1 = world
      } else {
        const ent: Omit<RectEnt, 'id'> = {
          kind: 'rect',
          x: (c1.x + world.x) / 2,
          y: (c1.y + world.y) / 2,
          w: Math.abs(world.x - c1.x),
          h: Math.abs(world.y - c1.y),
          rotation: 0,
          layer: ctx.layer,
        }
        ctx.store.add(ent)
        this.cancel()
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (c1) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!c1 || !cur) return
      const a = ctx.toScreen(c1)
      const b = ctx.toScreen(cur)
      beginGhost(g)
      g.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      g.restore()
    },
    hint() {
      if (!c1 || !cur) return ''
      const w = Math.abs(cur.x - c1.x)
      const h = Math.abs(cur.y - c1.y)
      return `${w.toFixed(1)} × ${h.toFixed(1)} m`
    },
    cancel() {
      c1 = null
      cur = null
    },
  }
}

// ---- CIRCLE (center + radius) ---------------------------------------------

function circleTool(): CadTool {
  let c: Vec2 | null = null
  let cur: Vec2 | null = null

  return {
    id: 'circle',
    onDown(world, _snap, ctx) {
      cur = world
      if (!c) {
        c = world
      } else {
        const ent: Omit<CircleEnt, 'id'> = { kind: 'circle', c, r: dist(c, world), layer: ctx.layer }
        ctx.store.add(ent)
        this.cancel()
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (c) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!c || !cur) return
      const s = ctx.toScreen(c)
      const r = dist(c, cur) * ctx.pxPerM
      beginGhost(g)
      g.beginPath()
      g.arc(s.x, s.y, r, 0, Math.PI * 2)
      g.stroke()
      g.restore()
    },
    hint() {
      if (!c || !cur) return ''
      return `R ${dist(c, cur).toFixed(1)} m`
    },
    cancel() {
      c = null
      cur = null
    },
  }
}

// ---- ARC (3-point: start, end, point-on-arc) ------------------------------

function arcTool(): CadTool {
  // Click order: #1 = start, #2 = end, #3 = a point the arc passes through.
  let p1: Vec2 | null = null
  let p2: Vec2 | null = null
  let cur: Vec2 | null = null

  return {
    id: 'arc',
    onDown(world, _snap, ctx) {
      cur = world
      if (!p1) {
        p1 = world
      } else if (!p2) {
        p2 = world
      } else {
        const sol = arc3(p1, p2, world)
        if (sol) {
          const ent: Omit<ArcEnt, 'id'> = {
            kind: 'arc',
            c: sol.c,
            r: sol.r,
            start: sol.start,
            end: sol.end,
            layer: ctx.layer,
          }
          ctx.store.add(ent)
        }
        // Collinear -> skip commit; either way reset for the next arc.
        this.cancel()
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (p1) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!p1 || !cur) return
      beginGhost(g)
      if (!p2) {
        // Rubber-band the start->end chord.
        g.beginPath()
        ghostPath(g, ctx, [p1, cur])
        g.stroke()
      } else {
        const sol = arc3(p1, p2, cur)
        if (sol) {
          const s = ctx.toScreen(sol.c)
          g.beginPath()
          g.arc(s.x, s.y, sol.r * ctx.pxPerM, sol.start, sol.end, false)
          g.stroke()
        } else {
          g.beginPath()
          ghostPath(g, ctx, [p1, p2])
          g.stroke()
        }
      }
      g.restore()
    },
    hint() {
      if (!p1 || !cur) return ''
      if (!p2) return `L ${dist(p1, cur).toFixed(2)} m  ${bearing(p1, cur).toFixed(0)}°`
      const sol = arc3(p1, p2, cur)
      if (!sol) return 'collinear — pick a bulge point'
      const span = (ccwSpan(sol.start, sol.end) * 180) / Math.PI
      return `R ${sol.r.toFixed(1)} m  ${span.toFixed(0)}°`
    },
    cancel() {
      p1 = null
      p2 = null
      cur = null
    },
  }
}

// ---- ELLIPSE (axis-aligned: center, rx, ry) -------------------------------

function ellipseTool(): CadTool {
  // Click order: #1 = center, #2 = major radius rx (along X), #3 = minor radius ry (along Y).
  let c: Vec2 | null = null
  let rx: number | null = null
  let cur: Vec2 | null = null

  return {
    id: 'ellipse',
    onDown(world, _snap, ctx) {
      cur = world
      if (!c) {
        c = world
      } else if (rx === null) {
        rx = Math.abs(world.x - c.x)
      } else {
        const ry = Math.abs(world.y - c.y)
        const ent: Omit<EllipseEnt, 'id'> = { kind: 'ellipse', c, rx, ry, rotation: 0, layer: ctx.layer }
        ctx.store.add(ent)
        this.cancel()
      }
      ctx.requestRender()
    },
    onMove(world, _snap, ctx) {
      cur = world
      if (c) ctx.requestRender()
    },
    onKey(key, ctx) {
      if (key === 'Escape') {
        this.cancel()
        ctx.requestRender()
      }
    },
    drawPreview(g, ctx) {
      if (!c || !cur) return
      const s = ctx.toScreen(c)
      const drawRx = (rx ?? Math.abs(cur.x - c.x)) * ctx.pxPerM
      const drawRy = (rx === null ? Math.abs(cur.x - c.x) : Math.abs(cur.y - c.y)) * ctx.pxPerM
      beginGhost(g)
      g.beginPath()
      g.ellipse(s.x, s.y, Math.max(drawRx, 0.01), Math.max(drawRy, 0.01), 0, 0, Math.PI * 2)
      g.stroke()
      g.restore()
    },
    hint() {
      if (!c || !cur) return ''
      if (rx === null) return `RX ${Math.abs(cur.x - c.x).toFixed(1)} m`
      return `RX ${rx.toFixed(1)}  RY ${Math.abs(cur.y - c.y).toFixed(1)} m`
    },
    cancel() {
      c = null
      rx = null
      cur = null
    },
  }
}

// ---- registry -------------------------------------------------------------

export const GEOM_TOOLS: Record<string, () => CadTool> = {
  line: lineTool,
  polyline: polylineTool,
  rect: rectTool,
  circle: circleTool,
  arc: arcTool,
  ellipse: ellipseTool,
}
