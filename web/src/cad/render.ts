// Pure CAD drawing helpers — no state. EditorCanvas calls these each frame with
// a RenderCtx (world→screen transform, pxPerM, selection, theme colors).
// See cad/model.ts for the authoritative types and CAD_COLOR palette.

import {
  CAD_COLOR,
  DEFAULT_LAYER,
  type CadEntity,
  type HatchEnt,
  type RenderCtx,
  type SnapResult,
  type Vec2,
} from './model'
import { MONO } from '../ui/type'

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
  hatch: 0.75,
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
    if (rc.hiddenLayers?.has(e.layer ?? DEFAULT_LAYER)) continue
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
    case 'hatch':
      drawHatch(g, e, rc, color)
      break
  }
}

/**
 * Hatch: clip to the boundary polygon, then stroke 45° pattern lines across
 * the screen bbox at `spacing` meters apart ('cross' adds the -45° family;
 * 'solid' is a translucent fill instead). The thin boundary outline is always
 * stroked. NOTE: hatch is intentionally NOT a snap source (see cad/snap.ts —
 * its collectEntity switch simply has no 'hatch' case).
 */
function drawHatch(
  g: CanvasRenderingContext2D,
  e: HatchEnt,
  rc: RenderCtx,
  color: string,
): void {
  if (e.pts.length < 3) return
  const screenPts = e.pts.map((p) => rc.toScreen(p))
  const boundary = (): void => {
    g.beginPath()
    g.moveTo(screenPts[0].x, screenPts[0].y)
    for (let i = 1; i < screenPts.length; i++) g.lineTo(screenPts[i].x, screenPts[i].y)
    g.closePath()
  }

  if (e.pattern === 'solid') {
    boundary()
    const prev = g.fillStyle
    g.fillStyle = withAlpha(color, 0.18)
    g.fill()
    g.fillStyle = prev
  } else {
    g.save()
    boundary()
    g.clip()
    // screen bbox of the boundary
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of screenPts) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    // A line at 45° (slope ±1) is y = ±x + c; perpendicular spacing s means
    // consecutive c values differ by s·√2.
    const stepC = Math.max(e.spacing, 0.01) * rc.pxPerM * Math.SQRT2
    const family = (slope: 1 | -1): void => {
      const cA = minY - slope * minX
      const cB = minY - slope * maxX
      const cC = maxY - slope * minX
      const cD = maxY - slope * maxX
      const c0 = Math.min(cA, cB, cC, cD)
      const c1 = Math.max(cA, cB, cC, cD)
      g.beginPath()
      for (let c = c0 + stepC / 2; c < c1; c += stepC) {
        g.moveTo(minX, slope * minX + c)
        g.lineTo(maxX, slope * maxX + c)
      }
      g.stroke()
    }
    family(1)
    if (e.pattern === 'cross') family(-1)
    g.restore() // drops the clip; stroke state was saved with it, so it survives
  }

  boundary()
  g.stroke()
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
  g.font = `${Math.max(9, 0.11 * rc.pxPerM)}px ${MONO}`
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
  g.font = `${Math.max(6, e.h * rc.pxPerM)}px ${MONO}`
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

/** Short uppercase tag drawn beside each osnap marker (AutoCAD-style). */
const SNAP_LABEL: Record<string, string> = {
  endpoint: 'END',
  midpoint: 'MID',
  center: 'CEN',
  quadrant: 'QUA',
  intersection: 'INT',
  perpendicular: 'PER',
  nearest: 'NEA',
  extension: 'EXT',
  grid: 'GRID',
}

/** Loose snaps (grid / nearest) get a dimmer marker than precise object snaps. */
const LOOSE_SNAP = new Set(['grid', 'nearest'])

/** round to a device-friendly half-pixel so 1px strokes stay crisp */
function crisp(v: number): number {
  return Math.round(v) + 0.5
}

export function renderSnapIndicator(
  g: CanvasRenderingContext2D,
  snap: SnapResult,
  rc: RenderCtx,
): void {
  if (snap.type === 'none') return
  const raw = rc.toScreen(snap.point)
  const cx = crisp(raw.x)
  const cy = crisp(raw.y)
  const r = 5
  const loose = LOOSE_SNAP.has(snap.type)
  const accent = rc.colors.accent

  g.save()
  g.setLineDash([])
  g.lineJoin = 'miter'
  g.lineCap = 'butt'

  // Soft highlight halo so the pick point pops against busy linework.
  g.fillStyle = withAlpha(accent, loose ? 0.1 : 0.16)
  g.beginPath()
  g.arc(cx, cy, r + 3, 0, Math.PI * 2)
  g.fill()

  g.strokeStyle = accent
  g.fillStyle = accent
  g.lineWidth = loose ? 1.25 : 1.6
  g.beginPath()
  switch (snap.type) {
    case 'endpoint':
      g.rect(cx - r, cy - r, r * 2, r * 2)
      g.stroke()
      break
    case 'midpoint':
      // upright triangle
      g.moveTo(cx, cy - r)
      g.lineTo(cx + r, cy + r)
      g.lineTo(cx - r, cy + r)
      g.closePath()
      g.stroke()
      break
    case 'center':
      g.arc(cx, cy, r, 0, Math.PI * 2)
      g.stroke()
      break
    case 'quadrant':
      // diamond
      g.moveTo(cx, cy - r)
      g.lineTo(cx + r, cy)
      g.lineTo(cx, cy + r)
      g.lineTo(cx - r, cy)
      g.closePath()
      g.stroke()
      break
    case 'intersection':
      g.moveTo(cx - r, cy - r)
      g.lineTo(cx + r, cy + r)
      g.moveTo(cx + r, cy - r)
      g.lineTo(cx - r, cy + r)
      g.stroke()
      break
    case 'perpendicular':
      // right-angle mark: left + bottom leg with an inner corner tick
      g.moveTo(cx - r, cy - r)
      g.lineTo(cx - r, cy + r)
      g.lineTo(cx + r, cy + r)
      g.moveTo(cx - r, cy + r - r * 0.55)
      g.lineTo(cx - r + r * 0.55, cy + r - r * 0.55)
      g.lineTo(cx - r + r * 0.55, cy + r)
      g.stroke()
      break
    case 'nearest':
      // bowtie / hourglass
      g.moveTo(cx - r, cy - r)
      g.lineTo(cx + r, cy - r)
      g.lineTo(cx - r, cy + r)
      g.lineTo(cx + r, cy + r)
      g.closePath()
      g.stroke()
      break
    case 'extension':
      // dashed cross-hair suggesting an inferred line
      g.setLineDash([2, 2])
      g.moveTo(cx - r - 1, cy)
      g.lineTo(cx + r + 1, cy)
      g.moveTo(cx, cy - r - 1)
      g.lineTo(cx, cy + r + 1)
      g.stroke()
      g.setLineDash([])
      break
    case 'grid':
    default:
      // small plus
      g.moveTo(cx - r, cy)
      g.lineTo(cx + r, cy)
      g.moveTo(cx, cy - r)
      g.lineTo(cx, cy + r)
      g.stroke()
      break
  }

  // Type label, offset up-right of the marker (dimension typeface).
  const label = SNAP_LABEL[snap.type]
  if (label) {
    g.font = `9px ${MONO}`
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    const tx = cx + r + 4
    const ty = cy - r - 2
    // subtle backing so the tag stays legible over dark linework
    const tw = g.measureText(label).width
    g.fillStyle = withAlpha(rc.colors.faint, 0.85)
    g.fillRect(tx - 1, ty - 8, tw + 2, 10)
    g.fillStyle = accent
    g.fillText(label, tx, ty)
  }
  g.restore()
}

/** Blend an #rrggbb (or shorthand) color toward a given alpha; passthrough otherwise. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    let hex = color.slice(1)
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    const n = parseInt(hex, 16)
    const rC = (n >> 16) & 255
    const gC = (n >> 8) & 255
    const bC = n & 255
    return `rgba(${rC},${gC},${bC},${alpha})`
  }
  return color
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
  const accent = rc.colors.accent
  g.save()
  g.setLineDash([])

  // Pass 1: a faint dashed selection halo around each entity's bbox so the whole
  // object reads as "picked" (not just the little corner handles).
  g.lineWidth = 1
  g.strokeStyle = withAlpha(accent, 0.5)
  for (const e of entities) {
    if (!selectedIds.has(e.id)) continue
    // A bare line/polyline has no meaningful box outline — its grips say enough.
    if (e.kind === 'line' || e.kind === 'polyline') continue
    const [minX, minY, maxX, maxY] = entityBBox(e)
    const a = rc.toScreen({ x: minX, y: minY })
    const b = rc.toScreen({ x: maxX, y: maxY })
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x)
    const h = Math.abs(b.y - a.y)
    const pad = 3
    g.setLineDash([4, 3])
    g.strokeRect(crisp(x - pad), crisp(y - pad), w + pad * 2, h + pad * 2)
  }
  g.setLineDash([])

  // Pass 2: crisp square grips at each control point (white fill, amber edge).
  g.lineWidth = 1.25
  g.strokeStyle = accent
  g.fillStyle = '#ffffff'
  for (const e of entities) {
    if (!selectedIds.has(e.id)) continue
    for (const gp of entityGrips(e)) {
      const p = rc.toScreen(gp)
      const px = crisp(p.x)
      const py = crisp(p.y)
      g.beginPath()
      g.rect(px - s, py - s, s * 2, s * 2)
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
    case 'hatch':
      return e.pts.slice()
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
    case 'hatch':
      return bboxOf(e.pts)
  }
}
