// Pure CAD drawing helpers — no state. EditorCanvas calls these each frame with
// a RenderCtx (world→screen transform, pxPerM, selection, theme colors).
// See cad/model.ts for the authoritative types and CAD_COLOR palette.

import {
  CAD_COLOR,
  type CadEntity,
  type RenderCtx,
  type SnapResult,
  type Vec2,
} from './model'

/** Per-kind default line weight (px). Overridable via entity.weight. */
const WEIGHT: Record<string, number> = {
  line: 1.4,
  polyline: 1.4,
  rect: 1.4,
  circle: 1.4,
  arc: 1.4,
  ellipse: 1.4,
  dimension: 1,
  text: 1,
  door: 1.4,
  window: 1.4,
  column: 1.4,
}

const ARC_SEGMENTS = 64

// ---------------------------------------------------------------------------
// small vector helpers (meters, world space)
// ---------------------------------------------------------------------------
function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}
function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}
function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s }
}
function len(a: Vec2): number {
  return Math.hypot(a.x, a.y)
}
function norm(a: Vec2): Vec2 {
  const l = len(a) || 1
  return { x: a.x / l, y: a.y / l }
}
/** left-hand perpendicular */
function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x }
}
function polar(c: Vec2, angle: number, r: number): Vec2 {
  return { x: c.x + Math.cos(angle) * r, y: c.y + Math.sin(angle) * r }
}
/** rotate local offset (lx,ly) by angle, about origin */
function rot(lx: number, ly: number, angle: number): Vec2 {
  const s = Math.sin(angle)
  const co = Math.cos(angle)
  return { x: lx * co - ly * s, y: lx * s + ly * co }
}

/** Screen-space angle for a world angle at a point (robust to any affine toScreen). */
function screenAngle(rc: RenderCtx, at: Vec2, angle: number): number {
  const p0 = rc.toScreen(at)
  const p1 = rc.toScreen(polar(at, angle, 1))
  return Math.atan2(p1.y - p0.y, p1.x - p0.x)
}

/** Sample a world-space arc/circle sweep and return world points. */
function samplePoints(
  c: Vec2,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  rotation = 0,
  segs = ARC_SEGMENTS,
): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i <= segs; i++) {
    const t = a0 + ((a1 - a0) * i) / segs
    const o = rot(Math.cos(t) * rx, Math.sin(t) * ry, rotation)
    out.push({ x: c.x + o.x, y: c.y + o.y })
  }
  return out
}

// ---------------------------------------------------------------------------
// stroke/path primitives (world → screen)
// ---------------------------------------------------------------------------
function strokePoly(
  g: CanvasRenderingContext2D,
  rc: RenderCtx,
  pts: Vec2[],
  closed = false,
): void {
  if (pts.length === 0) return
  g.beginPath()
  const first = rc.toScreen(pts[0])
  g.moveTo(first.x, first.y)
  for (let i = 1; i < pts.length; i++) {
    const p = rc.toScreen(pts[i])
    g.lineTo(p.x, p.y)
  }
  if (closed) g.closePath()
  g.stroke()
}

function fillPoly(g: CanvasRenderingContext2D, rc: RenderCtx, pts: Vec2[]): void {
  if (pts.length === 0) return
  g.beginPath()
  const first = rc.toScreen(pts[0])
  g.moveTo(first.x, first.y)
  for (let i = 1; i < pts.length; i++) {
    const p = rc.toScreen(pts[i])
    g.lineTo(p.x, p.y)
  }
  g.closePath()
  g.fill()
}

/** [minX,minY,maxX,maxY] of world points. */
function bboxOf(pts: Vec2[]): [number, number, number, number] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return [minX, minY, maxX, maxY]
}

// ---------------------------------------------------------------------------
// public: render all entities
// ---------------------------------------------------------------------------
export function renderEntities(
  g: CanvasRenderingContext2D,
  entities: CadEntity[],
  rc: RenderCtx,
): void {
  g.save()
  g.lineJoin = 'round'
  g.lineCap = 'round'
  for (const e of entities) {
    const selected = rc.selected.has(e.id)
    const color = selected ? rc.colors.accent : e.color || CAD_COLOR[e.kind] || rc.colors.ink
    const weight = (e.weight ?? WEIGHT[e.kind] ?? 1.4) + (selected ? 0.8 : 0)
    g.strokeStyle = color
    g.fillStyle = color
    g.lineWidth = weight
    g.setLineDash([])
    drawEntity(g, e, rc, color)
  }
  g.restore()
}

function drawEntity(
  g: CanvasRenderingContext2D,
  e: CadEntity,
  rc: RenderCtx,
  color: string,
): void {
  switch (e.kind) {
    case 'line':
      strokePoly(g, rc, [e.a, e.b])
      break
    case 'polyline':
      strokePoly(g, rc, e.pts, e.closed)
      break
    case 'rect':
      strokePoly(g, rc, rectCorners(e.x, e.y, e.w, e.h, e.rotation), true)
      break
    case 'circle':
      strokePoly(g, rc, samplePoints(e.c, e.r, e.r, 0, Math.PI * 2), true)
      break
    case 'arc':
      strokePoly(g, rc, arcSamples(e.c, e.r, e.start, e.end))
      break
    case 'ellipse':
      strokePoly(
        g,
        rc,
        samplePoints(e.c, e.rx, e.ry, 0, Math.PI * 2, e.rotation),
        true,
      )
      break
    case 'dimension':
      drawDimension(g, e, rc, color)
      break
    case 'text':
      drawText(g, e, rc, color)
      break
    case 'door':
      drawDoor(g, e, rc)
      break
    case 'window':
      drawWindow(g, e, rc)
      break
    case 'column':
      drawColumn(g, e, rc, color)
      break
  }
}

/** world corners of a center/size/rotation rect */
function rectCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
): Vec2[] {
  const hw = w / 2
  const hh = h / 2
  return [
    add({ x, y }, rot(-hw, -hh, rotation)),
    add({ x, y }, rot(hw, -hh, rotation)),
    add({ x, y }, rot(hw, hh, rotation)),
    add({ x, y }, rot(-hw, hh, rotation)),
  ]
}

/** CCW-from-start-to-end arc world samples (contract: radians, CCW). */
function arcSamples(c: Vec2, r: number, start: number, end: number): Vec2[] {
  let a1 = end
  while (a1 < start) a1 += Math.PI * 2
  return samplePoints(c, r, r, start, a1)
}

function drawDimension(
  g: CanvasRenderingContext2D,
  e: { a: Vec2; b: Vec2; offset: number; text?: string },
  rc: RenderCtx,
  color: string,
): void {
  const dir = norm(sub(e.b, e.a))
  const n = perp(dir)
  const off = scale(n, e.offset)
  const a2 = add(e.a, off) // dim line start
  const b2 = add(e.b, off) // dim line end

  // extension lines (with a small gap from the measured points, slight overshoot)
  const gap = 0.06
  const over = 0.12
  const ea = add(e.a, scale(n, e.offset >= 0 ? gap : -gap))
  const eb = add(e.b, scale(n, e.offset >= 0 ? gap : -gap))
  const eaEnd = add(a2, scale(n, e.offset >= 0 ? over : -over))
  const ebEnd = add(b2, scale(n, e.offset >= 0 ? over : -over))
  strokePoly(g, rc, [ea, eaEnd])
  strokePoly(g, rc, [eb, ebEnd])

  // dimension line
  strokePoly(g, rc, [a2, b2])

  // arrowheads at both ends, pointing outward along the dim line
  arrowHead(g, rc, a2, sub(a2, b2))
  arrowHead(g, rc, b2, sub(b2, a2))

  // measured distance text, centered, lifted slightly off the dim line
  const dist = len(sub(e.b, e.a))
  const label = e.text ?? `${dist.toFixed(2)} m`
  const mid = scale(add(a2, b2), 0.5)
  const textPos = add(mid, scale(n, e.offset >= 0 ? 0.12 : -0.12))
  const sp = rc.toScreen(textPos)
  let ang = screenAngle(rc, e.a, Math.atan2(dir.y, dir.x))
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI // keep upright
  g.save()
  g.translate(sp.x, sp.y)
  g.rotate(ang)
  g.fillStyle = color
  g.font = `${Math.max(9, 0.11 * rc.pxPerM)}px "IBM Plex Mono", monospace`
  g.textAlign = 'center'
  g.textBaseline = 'bottom'
  g.fillText(label, 0, 0)
  g.restore()
}

/** small filled arrowhead at tip `p`, pointing along direction `dirWorld`. */
function arrowHead(
  g: CanvasRenderingContext2D,
  rc: RenderCtx,
  p: Vec2,
  dirWorld: Vec2,
): void {
  const tip = rc.toScreen(p)
  const ang = Math.atan2(rc.toScreen(add(p, norm(dirWorld))).y - tip.y, rc.toScreen(add(p, norm(dirWorld))).x - tip.x)
  const size = 8
  const spread = 0.35
  g.beginPath()
  g.moveTo(tip.x, tip.y)
  g.lineTo(tip.x - Math.cos(ang - spread) * size, tip.y - Math.sin(ang - spread) * size)
  g.lineTo(tip.x - Math.cos(ang + spread) * size, tip.y - Math.sin(ang + spread) * size)
  g.closePath()
  g.fill()
}

function drawText(
  g: CanvasRenderingContext2D,
  e: { at: Vec2; text: string; h: number; rotation: number },
  rc: RenderCtx,
  color: string,
): void {
  const sp = rc.toScreen(e.at)
  const ang = screenAngle(rc, e.at, e.rotation)
  g.save()
  g.translate(sp.x, sp.y)
  g.rotate(ang)
  g.fillStyle = color
  g.font = `${Math.max(6, e.h * rc.pxPerM)}px "IBM Plex Mono", monospace`
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  g.fillText(e.text, 0, 0)
  g.restore()
}

function drawDoor(
  g: CanvasRenderingContext2D,
  e: { at: Vec2; width: number; angle: number; hinge: 'left' | 'right'; flip: boolean },
  rc: RenderCtx,
): void {
  const along = e.hinge === 'left' ? e.angle : e.angle + Math.PI
  const swing = e.flip ? -Math.PI / 2 : Math.PI / 2
  const openAngle = along + swing
  const openEnd = polar(e.at, openAngle, e.width)
  // leaf (open panel)
  strokePoly(g, rc, [e.at, openEnd])
  // swing arc from closed (along wall) to open position
  strokePoly(g, rc, samplePoints(e.at, e.width, e.width, along, openAngle, 0, 24))
}

function drawWindow(
  g: CanvasRenderingContext2D,
  e: { at: Vec2; width: number; angle: number; thickness: number },
  rc: RenderCtx,
): void {
  const d = { x: Math.cos(e.angle), y: Math.sin(e.angle) }
  const n = perp(d)
  const half = e.width / 2
  const t = e.thickness / 2
  const p1 = add(e.at, scale(d, -half))
  const p2 = add(e.at, scale(d, half))
  const nA = scale(n, t)
  const nB = scale(n, -t)
  // two parallel rails across the wall break
  strokePoly(g, rc, [add(p1, nA), add(p2, nA)])
  strokePoly(g, rc, [add(p1, nB), add(p2, nB)])
  // jamb caps + center glass line
  strokePoly(g, rc, [add(p1, nA), add(p1, nB)])
  strokePoly(g, rc, [add(p2, nA), add(p2, nB)])
  strokePoly(g, rc, [p1, p2])
}

function drawColumn(
  g: CanvasRenderingContext2D,
  e: { at: Vec2; w: number; h: number; shape: 'rect' | 'round'; rotation: number },
  rc: RenderCtx,
  color: string,
): void {
  g.save()
  g.fillStyle = color
  if (e.shape === 'round') {
    const pts = samplePoints(e.at, e.w / 2, e.h / 2, 0, Math.PI * 2, e.rotation)
    fillPoly(g, rc, pts)
    strokePoly(g, rc, pts, true)
  } else {
    const corners = rectCorners(e.at.x, e.at.y, e.w, e.h, e.rotation)
    fillPoly(g, rc, corners)
    strokePoly(g, rc, corners, true)
  }
  g.restore()
}

// ---------------------------------------------------------------------------
// public: snap indicator glyph
// ---------------------------------------------------------------------------
export function renderSnapIndicator(
  g: CanvasRenderingContext2D,
  snap: SnapResult,
  rc: RenderCtx,
): void {
  if (snap.type === 'none') return
  const p = rc.toScreen(snap.point)
  const r = 4.5
  g.save()
  g.strokeStyle = rc.colors.accent
  g.fillStyle = rc.colors.accent
  g.lineWidth = 1.5
  g.setLineDash([])
  g.beginPath()
  switch (snap.type) {
    case 'endpoint':
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2)
      break
    case 'midpoint':
      g.moveTo(p.x, p.y - r)
      g.lineTo(p.x + r, p.y + r)
      g.lineTo(p.x - r, p.y + r)
      g.closePath()
      g.stroke()
      break
    case 'center':
    case 'quadrant':
      g.arc(p.x, p.y, r, 0, Math.PI * 2)
      g.stroke()
      break
    case 'intersection':
      g.moveTo(p.x - r, p.y - r)
      g.lineTo(p.x + r, p.y + r)
      g.moveTo(p.x + r, p.y - r)
      g.lineTo(p.x - r, p.y + r)
      g.stroke()
      break
    case 'perpendicular':
      // right-angle mark
      g.moveTo(p.x - r, p.y - r)
      g.lineTo(p.x - r, p.y + r)
      g.lineTo(p.x + r, p.y + r)
      g.moveTo(p.x - r, p.y)
      g.lineTo(p.x, p.y)
      g.lineTo(p.x, p.y + r)
      g.stroke()
      break
    case 'nearest':
      // hourglass
      g.moveTo(p.x - r, p.y - r)
      g.lineTo(p.x + r, p.y - r)
      g.lineTo(p.x - r, p.y + r)
      g.lineTo(p.x + r, p.y + r)
      g.closePath()
      g.stroke()
      break
    case 'grid':
    case 'extension':
    default:
      // small plus
      g.moveTo(p.x - r, p.y)
      g.lineTo(p.x + r, p.y)
      g.moveTo(p.x, p.y - r)
      g.lineTo(p.x, p.y + r)
      g.stroke()
      break
  }
  g.restore()
}

// ---------------------------------------------------------------------------
// public: grips on selected entities
// ---------------------------------------------------------------------------
export function renderGrips(
  g: CanvasRenderingContext2D,
  entities: CadEntity[],
  selectedIds: Set<number>,
  rc: RenderCtx,
): void {
  const s = 3.5
  g.save()
  g.lineWidth = 1.25
  g.strokeStyle = rc.colors.accent
  g.fillStyle = '#ffffff'
  g.setLineDash([])
  for (const e of entities) {
    if (!selectedIds.has(e.id)) continue
    for (const gp of entityGrips(e)) {
      const p = rc.toScreen(gp)
      g.beginPath()
      g.rect(p.x - s, p.y - s, s * 2, s * 2)
      g.fill()
      g.stroke()
    }
  }
  g.restore()
}

// ---------------------------------------------------------------------------
// public: control points per kind (world meters)
// ---------------------------------------------------------------------------
export function entityGrips(e: CadEntity): Vec2[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b]
    case 'polyline':
      return e.pts.slice()
    case 'rect':
      return [...rectCorners(e.x, e.y, e.w, e.h, e.rotation), { x: e.x, y: e.y }]
    case 'circle':
      return [e.c, polar(e.c, 0, e.r)]
    case 'arc':
      return [e.c, polar(e.c, e.start, e.r), polar(e.c, e.end, e.r)]
    case 'ellipse':
      return [
        e.c,
        add(e.c, rot(e.rx, 0, e.rotation)),
        add(e.c, rot(0, e.ry, e.rotation)),
      ]
    case 'dimension': {
      const n = perp(norm(sub(e.b, e.a)))
      const off = scale(n, e.offset)
      return [e.a, e.b, scale(add(add(e.a, off), add(e.b, off)), 0.5)]
    }
    case 'text':
      return [e.at]
    case 'door':
      return [e.at]
    case 'window': {
      const d = { x: Math.cos(e.angle), y: Math.sin(e.angle) }
      return [
        e.at,
        add(e.at, scale(d, -e.width / 2)),
        add(e.at, scale(d, e.width / 2)),
      ]
    }
    case 'column':
      return [e.at]
  }
}

// ---------------------------------------------------------------------------
// public: world bounding box [minX,minY,maxX,maxY]
// ---------------------------------------------------------------------------
export function entityBBox(e: CadEntity): [number, number, number, number] {
  switch (e.kind) {
    case 'line':
      return bboxOf([e.a, e.b])
    case 'polyline':
      return bboxOf(e.pts)
    case 'rect':
      return bboxOf(rectCorners(e.x, e.y, e.w, e.h, e.rotation))
    case 'circle':
      return [e.c.x - e.r, e.c.y - e.r, e.c.x + e.r, e.c.y + e.r]
    case 'arc':
      return bboxOf(arcSamples(e.c, e.r, e.start, e.end))
    case 'ellipse': {
      // exact extent of a rotated ellipse
      const ex = Math.hypot(e.rx * Math.cos(e.rotation), e.ry * Math.sin(e.rotation))
      const ey = Math.hypot(e.rx * Math.sin(e.rotation), e.ry * Math.cos(e.rotation))
      return [e.c.x - ex, e.c.y - ey, e.c.x + ex, e.c.y + ey]
    }
    case 'dimension': {
      const n = perp(norm(sub(e.b, e.a)))
      const off = scale(n, e.offset)
      return bboxOf([e.a, e.b, add(e.a, off), add(e.b, off)])
    }
    case 'text': {
      // approximate box: width ≈ 0.6·h per char, height ≈ h, at baseline `at`
      const w = e.text.length * e.h * 0.6
      return bboxOf([
        e.at,
        add(e.at, rot(w, 0, e.rotation)),
        add(e.at, rot(0, -e.h, e.rotation)),
        add(e.at, rot(w, -e.h, e.rotation)),
      ])
    }
    case 'door': {
      const along = e.hinge === 'left' ? e.angle : e.angle + Math.PI
      const openAngle = along + (e.flip ? -Math.PI / 2 : Math.PI / 2)
      return bboxOf([
        e.at,
        polar(e.at, along, e.width),
        ...samplePoints(e.at, e.width, e.width, along, openAngle, 0, 12),
      ])
    }
    case 'window': {
      const d = { x: Math.cos(e.angle), y: Math.sin(e.angle) }
      const n = perp(d)
      const half = e.width / 2
      const t = e.thickness / 2
      const p1 = add(e.at, scale(d, -half))
      const p2 = add(e.at, scale(d, half))
      return bboxOf([
        add(p1, scale(n, t)),
        add(p1, scale(n, -t)),
        add(p2, scale(n, t)),
        add(p2, scale(n, -t)),
      ])
    }
    case 'column':
      return bboxOf(rectCorners(e.at.x, e.at.y, e.w, e.h, e.rotation))
  }
}
