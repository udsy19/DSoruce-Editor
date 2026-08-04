// 2D PAINT LAYER for the editor canvas — every `draw*` primitive plus the
// palette and the small geometry/format helpers they share.
//
// Split out of `EditorCanvas.ts` (which stays the public façade): these are pure
// draw functions that take an explicit {@link PaintView} (the viewport + 2D
// context) and the data to paint, so nothing here reads or mutates document
// state. The core stays the source of truth — the façade re-reads `state()` and
// hands the result in. Rendering is TS-side for now and migrates into a
// Rust/WebGL renderer later (docs/adr/0001-rendering-staging.md).

import { drawFurnitureSymbol } from './furniture'
import { fmtMeters } from '../cad/dimEdit'
import type { DocComponent, DocState, DocWall, DocZone } from '../types/doc'
import {
  planStyle, strokePx, C, DECISION_DOT, ZONE,
  WHITE, BLACK, THUMB_FILL, THUMB_OTHER, hexToRgba,
} from './planStyle'
import type { Metrics, ZoneStat } from '../types/metrics'

/** A point in screen or world space (the function names say which). */
interface Pt {
  x: number
  y: number
}

/**
 * The live viewport a draw call paints through. `EditorCanvas` implements it as
 * a getter-backed view of itself, so a draw function always sees the current
 * pan/zoom without caching anything.
 */
export interface PaintView {
  readonly ctx: CanvasRenderingContext2D
  /** px per meter. */
  readonly scale: number
  /** screen px of the world origin. */
  readonly offset: Pt
  readonly presentation: boolean
  toScreen(wx: number, wy: number): Pt
  toWorld(sx: number, sy: number): Pt
}

/** A room tag computed by {@link drawZones}, drawn above furniture by
 *  {@link drawZoneTags}. */
export interface ZoneTag {
  name: string
  metrics: string | null
  cx: number
  cy: number
  namePx: number
  color: string
}

/** Screen-space box of a drawn dimension label (a click target for the inline
 *  numeric editor — see EditorCanvas.tryOpenDimEditor). */
export interface DimLabelBox {
  x: number
  y: number
  w: number
  h: number
}

const GRID_M = 1 // 1-meter minor grid
const MAJOR_EVERY = 5 // heavier line every 5 m
const RULER = 22 // px ruler gutter (top + left)

// Light "floor-plate" palette — mirrors styles.css tokens (Laiout aesthetic).



// ---- grid / linework ----

export function drawGrid(v: PaintView, w: number, h: number) {
  const ctx = v.ctx
  const step = GRID_M * v.scale
  if (step >= 6) {
    const originX = v.offset.x
    const originY = v.offset.y
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
  const o = v.toScreen(0, 0)
  ctx.strokeStyle = C.axis
  line(ctx, o.x, 0, o.x, h)
  line(ctx, 0, o.y, w, o.y)
}

export function drawSegment(v: PaintView, a: Pt, b: Pt, widthPx: number, color: string) {
  const ctx = v.ctx
  const pa = v.toScreen(a.x, a.y)
  const pb = v.toScreen(b.x, b.y)
  ctx.strokeStyle = color
  ctx.lineWidth = widthPx
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(pa.x, pa.y)
  ctx.lineTo(pb.x, pb.y)
  ctx.stroke()
}

/** Glazed wall: the drafting triple-line convention (two frame lines with a
 *  lighter center glazing line), visually distinct from solid poché walls. */
export function drawGlazing(v: PaintView, a: Pt, b: Pt) {
  const ctx = v.ctx
  const pa = v.toScreen(a.x, a.y)
  const pb = v.toScreen(b.x, b.y)
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const len = Math.hypot(dx, dy) || 1
  // Frame offset: half the drawn glazing depth, ≥1.5 px so it never collapses.
  const o = Math.max(1.5, 0.05 * v.scale)
  const nx = (-dy / len) * o
  const ny = (dx / len) * o
  ctx.lineCap = 'round'
  ctx.strokeStyle = C.wall
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pa.x + nx, pa.y + ny)
  ctx.lineTo(pb.x + nx, pb.y + ny)
  ctx.moveTo(pa.x - nx, pa.y - ny)
  ctx.lineTo(pb.x - nx, pb.y - ny)
  ctx.stroke()
  ctx.strokeStyle = C.glassCore // glass: light cool center line
  ctx.beginPath()
  ctx.moveTo(pa.x, pa.y)
  ctx.lineTo(pb.x, pb.y)
  ctx.stroke()
}

/**
 * Lineweight hierarchy (architect's sheet convention, cf. DrawingCanvas
 * LINE_WEIGHT): exterior/plate walls heaviest in the darkest ink, interior
 * user walls medium, generated partitions lightest. Stroke is proportional
 * to true thickness with min/max clamps so hierarchy survives any zoom.
 */
/**
 * Draw a wall the way the reference actually draws one (ADR: Phase 2a).
 *
 * MEASURED, not assumed: the qbiq reference has NO dark poché anywhere. Walls
 * are thin DOUBLE LINES with an unfilled interior — 463 paths per page at the
 * 2× tier carrying `fill=None`. The brief called filled poché "the single
 * highest-leverage change"; Phase 0 falsified that, and implementing it would
 * have moved us away from the reference. What carries the drawing is the
 * WEIGHT LADDER (furniture 1× → wall 2× → room enclosure 7×), not fill.
 *
 * So: offset the centreline by ±thickness/2, stroke both faces at the wall
 * tier, cap the ends. The interior stays empty and the background shows
 * through — which is exactly what makes furniture and zone fill read as the
 * content rather than competing with a black slab.
 */
export function drawWall(v: PaintView, w: DocWall, exterior: boolean) {
  const style = planStyle(v.presentation ? 'paper' : 'editor')
  const el = exterior ? style.wallCut : style.wallInterior
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  const width = strokePx(el.tier ?? 'wall', v.scale, dpr)
  const color = el.stroke ?? BLACK

  const dx = w.b.x - w.a.x
  const dy = w.b.y - w.a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return
  // Half-thickness perpendicular, in WORLD units so the two faces track the
  // real wall as the view zooms — the faces are geometry, the strokes are not.
  const h = (w.thickness > 0 ? w.thickness : 0.1) / 2
  const nx = (-dy / len) * h
  const ny = (dx / len) * h

  const a1 = { x: w.a.x + nx, y: w.a.y + ny }
  const b1 = { x: w.b.x + nx, y: w.b.y + ny }
  const a2 = { x: w.a.x - nx, y: w.a.y - ny }
  const b2 = { x: w.b.x - nx, y: w.b.y - ny }
  drawSegment(v, a1, b1, width, color)
  drawSegment(v, a2, b2, width, color)
  // End caps close the wall so it reads as a solid element rather than two
  // stray parallel lines.
  drawSegment(v, a1, a2, width, color)
  drawSegment(v, b1, b2, width, color)
}

/**
 * Punch an opening through a wall by overdrawing in WHITE — the reference's own
 * mechanism (31 white strokes per page at the 8.5× tier). Called after walls so
 * the punch lands on top; this is how a wall line breaks at a door.
 */
export function punchOpening(v: PaintView, a: Pt, b: Pt, thickness: number) {
  const style = planStyle(v.presentation ? 'paper' : 'editor')
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  // The punch must be at least as wide as the wall it erases.
  const width = Math.max(
    strokePx(style.opening.tier ?? 'openingPunch', v.scale, dpr),
    thickness * v.scale,
  )
  drawSegment(v, a, b, width, style.opening.stroke ?? WHITE)
}

export function wallStyle(
  v: PaintView,
  w: DocWall,
  exteriorIds: Set<number>,
): { color: string; width: number } {
  const t = w.thickness * v.scale
  if (w.generated ?? false) {
    // Lightest tier: room partitions the generator drew.
    return { color: C.wallGen, width: clampN(t * 0.85, 1.3, 3.2) }
  }
  if (exteriorIds.has(w.id)) {
    // Heaviest tier — but capped tight so the boundary reads as a crisp
    // architectural line, not the fat black marker it was before.
    return { color: C.wallExt, width: clampN(t, 2.4, 5) }
  }
  // Medium tier: interior/user walls.
  return { color: C.wall, width: clampN(t, 1.7, 3.8) }
}

// ---- zones ----

/**
 * Fine 45° architectural poché hatch, clipped to a zone's screen path. The
 * standard drawing convention for a solid service core (shafts / stairs / WC /
 * MEP) so a `Core` zone reads as built poché instead of an unfinished gray
 * block. Deliberately restrained (Laiout/qbiq): thin light lines in the zone's
 * own ink over its pale fill. `tracePath` re-lays the fill path (we begin it)
 * so the hatch is clipped to Rect AND Poly cores identically.
 */
function drawPoche(
  ctx: CanvasRenderingContext2D,
  tracePath: () => void,
  bb: { minX: number; minY: number; maxX: number; maxY: number },
  lineColor: string,
  evenOdd = false,
) {
  ctx.save()
  ctx.beginPath()
  tracePath()
  ctx.clip(evenOdd ? 'evenodd' : 'nonzero')
  ctx.strokeStyle = hexToRgba(lineColor, 0.34)
  ctx.lineWidth = 0.6
  const step = 6 // px between hatch lines (screen space; fixed density, not zoom-scaled)
  const span = bb.maxY - bb.minY
  ctx.beginPath()
  // Parallel 45° lines (slope +1): start far enough left that down-right
  // diagonals cover the whole clip rect.
  for (let x = bb.minX - span; x <= bb.maxX; x += step) {
    ctx.moveTo(x, bb.minY)
    ctx.lineTo(x + span, bb.maxY)
  }
  ctx.stroke()
  ctx.restore()
}

/** Paint the zone tints (fills, hairlines, core poché) and collect the room tags
 *  the caller draws afterwards, above furniture. `zoneStats` is the core's
 *  plate-clipped truth (area/capacity), cached by the caller. */
export function drawZones(
  v: PaintView,
  zones: DocZone[],
  platePoly: [number, number][] | null,
  zoneStats: Map<number, ZoneStat>,
): ZoneTag[] {
  if (zones.length === 0) return []
  const ctx = v.ctx

  // Zone shapes are rectangles even on an L-shaped plate; clip their fills to
  // the plate polygon so tints never spill past the building boundary.
  // Labels draw after restore so they stay legible near clipped corners.
  const clipped = platePoly && platePoly.length >= 3
  if (clipped) {
    ctx.save()
    ctx.beginPath()
    const poly = platePoly!
    const p0 = v.toScreen(poly[0][0], poly[0][1])
    ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < poly.length; i++) {
      const p = v.toScreen(poly[i][0], poly[i][1])
      ctx.lineTo(p.x, p.y)
    }
    ctx.closePath()
    ctx.clip()
  }

  const tags: ZoneTag[] = []
  for (const z of zones) {
    const pal = ZONE[z.zone_type] ?? ZONE.Core
    ctx.fillStyle = v.presentation ? lighten(pal.fill, 0.4) : pal.fill
    if (z.shape.kind === 'Poly') {
      // Boundary-conforming polygon: trace + fill + hairline; label at the
      // area-weighted centroid.
      const pts = z.shape.pts
      if (pts.length < 3) continue
      ctx.beginPath()
      const s0 = v.toScreen(pts[0][0], pts[0][1])
      ctx.moveTo(s0.x, s0.y)
      for (let i = 1; i < pts.length; i++) {
        const p = v.toScreen(pts[i][0], pts[i][1])
        ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = hexToRgba(pal.line, 0.45)
      ctx.lineWidth = 1
      ctx.stroke()
      if (z.zone_type === 'Core') {
        let bminX = Infinity
        let bminY = Infinity
        let bmaxX = -Infinity
        let bmaxY = -Infinity
        const sp = pts.map((pt) => v.toScreen(pt[0], pt[1]))
        for (const q of sp) {
          bminX = Math.min(bminX, q.x)
          bminY = Math.min(bminY, q.y)
          bmaxX = Math.max(bmaxX, q.x)
          bmaxY = Math.max(bmaxY, q.y)
        }
        drawPoche(
          ctx,
          () => {
            ctx.moveTo(sp[0].x, sp[0].y)
            for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y)
            ctx.closePath()
          },
          { minX: bminX, minY: bminY, maxX: bmaxX, maxY: bmaxY },
          pal.line,
        )
      }
      // Area-weighted centroid (world), then screen, for the room tag.
      let a2 = 0
      let cx = 0
      let cy = 0
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i]
        const [x1, y1] = pts[(i + 1) % pts.length]
        const cross = x0 * y1 - x1 * y0
        a2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
      }
      const stat = zoneStats.get(z.id)
      const area = stat?.area ?? Math.abs(a2) / 2
      if (area < 6 || Math.abs(a2) < 1e-6) continue
      const wcx = cx / (3 * a2)
      const wcy = cy / (3 * a2)
      const c = v.toScreen(wcx, wcy)
      const name = z.label.toUpperCase()
      ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
      const cap = stat?.capacity ?? 0
      const metrics: string | null =
        area >= 12 ? `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}` : null
      tags.push({ name, metrics, cx: c.x, cy: c.y, namePx: 10, color: pal.line })
    } else if (z.shape.kind === 'RectRing') {
      const s = z.shape
      const o = v.toScreen(s.x - s.w / 2, s.y - s.h / 2)
      const io = v.toScreen(s.x - s.in_w / 2, s.y - s.in_h / 2)
      ctx.beginPath()
      ctx.rect(o.x, o.y, s.w * v.scale, s.h * v.scale)
      ctx.rect(io.x, io.y, s.in_w * v.scale, s.in_h * v.scale)
      ctx.fill('evenodd')
      if (z.zone_type === 'Core') {
        drawPoche(
          ctx,
          () => {
            ctx.rect(o.x, o.y, s.w * v.scale, s.h * v.scale)
            ctx.rect(io.x, io.y, s.in_w * v.scale, s.in_h * v.scale)
          },
          { minX: o.x, minY: o.y, maxX: o.x + s.w * v.scale, maxY: o.y + s.h * v.scale },
          pal.line,
          true,
        )
      }
    } else {
      const s = z.shape
      const p = v.toScreen(s.x - s.w / 2, s.y - s.h / 2)
      const w = s.w * v.scale
      const h = s.h * v.scale
      ctx.fillRect(p.x, p.y, w, h)
      // Soft inset border (secondary to walls) — a refined architectural edge,
      // not a saturated toy outline.
      ctx.strokeStyle = hexToRgba(pal.line, 0.45)
      ctx.lineWidth = 1
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1)
      if (z.zone_type === 'Core') {
        drawPoche(
          ctx,
          () => ctx.rect(p.x, p.y, w, h),
          { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + h },
          pal.line,
        )
      }

      // Centered room tag: NAME over "area m² · N pax" (architect's sheet
      // style). Skip when the zone is tiny (< 6 m²) or the tag can't fit;
      // shrink the name one step before giving up.
      const stat = zoneStats.get(z.id)
      const area = stat?.area ?? s.w * s.h
      if (area < 6 || h < 18) continue
      const name = z.label.toUpperCase()
      const maxW = w - 10
      ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
      let namePx = 10
      if (ctx.measureText(name).width > maxW) {
        ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
        namePx = 8
        if (ctx.measureText(name).width > maxW) continue
      }
      const cap = stat?.capacity ?? 0
      let metrics: string | null = `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}`
      ctx.font = '500 9.5px "Hanken Grotesk", system-ui, sans-serif'
      if (h < 34 || ctx.measureText(metrics).width > maxW) metrics = null
      const c = v.toScreen(s.x, s.y)
      tags.push({ name, metrics, cx: c.x, cy: c.y, namePx, color: pal.line })
    }
  }
  if (clipped) ctx.restore()
  return tags
}

/** Draw collected room tags (after furniture) as clean soft-rounded label
 *  pills — white with a subtle drop shadow and a hairline in the zone color —
 *  so a room name reads over desks/linework without the cheap hard white box.
 *  Numbers set in the UI sans (Hanken, tabular) to match the rest of the sheet;
 *  see the CLAUDE.md typography note in the visual overhaul. */
export function drawZoneTags(v: PaintView, tags: ZoneTag[]) {
  const ctx = v.ctx
  const NAME_FONT = (px: number) => `600 ${px}px "Hanken Grotesk", system-ui, sans-serif`
  const MET_FONT = '500 9.5px "Hanken Grotesk", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const t of tags) {
    ctx.font = NAME_FONT(t.namePx)
    const nameW = ctx.measureText(t.name).width
    ctx.font = MET_FONT
    const metW = t.metrics ? ctx.measureText(t.metrics).width : 0
    const padX = 8
    const pillW = Math.max(nameW, metW) + padX * 2
    const pillH = t.metrics ? 32 : 19
    const px = t.cx - pillW / 2
    const py = t.cy - pillH / 2

    // Soft pill: drop shadow + near-white fill + hairline border in zone color.
    ctx.save()
    ctx.shadowColor = C.pillShadow
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 1
    ctx.fillStyle = C.pillFill
    roundRect(ctx, px, py, pillW, pillH, pillH / 2)
    ctx.fill()
    ctx.restore()
    ctx.strokeStyle = hexToRgba(t.color, 0.28)
    ctx.lineWidth = 1
    roundRect(ctx, px + 0.5, py + 0.5, pillW - 1, pillH - 1, (pillH - 1) / 2)
    ctx.stroke()

    // Name (zone-line color) over metrics (muted).
    ctx.fillStyle = t.color
    ctx.font = NAME_FONT(t.namePx)
    ctx.fillText(t.name, t.cx, t.metrics ? t.cy - 6 : t.cy)
    if (t.metrics) {
      ctx.fillStyle = C.labelSub
      ctx.font = MET_FONT
      ctx.fillText(t.metrics, t.cx, t.cy + 7.5)
    }
  }
}

// ---- selection / furniture ----

/** Selected-room outline, 8 resize handles, and a live W×H dimension badge.
 *  `box` is the room's screen box (see RoomInteraction.screenBox). */
export function drawRoomSelection(
  v: PaintView,
  z: DocZone,
  box: { x: number; y: number; w: number; h: number },
) {
  const ctx = v.ctx
  const ring = z.shape.kind !== 'Rect'

  ctx.save()
  ctx.strokeStyle = C.accent
  ctx.lineWidth = 2
  ctx.setLineDash(ring ? [6, 4] : [])
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
  ctx.setLineDash([])
  ctx.restore()

  if (z.shape.kind !== 'Rect') return // no handles / dims for non-rect (ring/poly) zones

  // Live dimension badge (accent pill) centered under the room.
  const label = `${z.shape.w.toFixed(2)} × ${z.shape.h.toFixed(2)} m`
  ctx.font = '600 11px "Hanken Grotesk", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(label).width
  const cx = box.x + box.w / 2
  const by = box.y + box.h + 14
  ctx.fillStyle = C.accent
  roundRect(ctx, cx - tw / 2 - 7, by - 9, tw + 14, 18, 9)
  ctx.fill()
  ctx.fillStyle = WHITE
  ctx.fillText(label, cx, by + 1)

  // 8 white square handles with an accent border.
  ctx.fillStyle = WHITE
  ctx.strokeStyle = C.accent
  ctx.lineWidth = 1.5
  for (const p of handlePoints(box)) {
    ctx.beginPath()
    ctx.rect(p.x - 4, p.y - 4, 8, 8)
    ctx.fill()
    ctx.stroke()
  }
}

export function drawComponent(v: PaintView, c: DocComponent, selected: boolean) {
  const ctx = v.ctx
  const p = v.toScreen(c.x, c.y)
  const w = c.w * v.scale
  const h = c.h * v.scale
  const frozen = c.decision === 'Confirmed'
  // Passive as-drawn reference (imported furniture that isn't counted): draw it
  // muted and plate-less so the generated fit stays the primary read. No decision
  // dot / frozen styling — it carries no decision state.
  const ref = c.reference === true && !selected

  // Recognizable top-view CAD furniture line-symbol. The symbol carries its own
  // solid worktop/seat fill (a filled object reads as furniture, where a hollow
  // white plate under a hollow outline read as faint clutter over the pastel
  // zone). Reference furniture gets no fill so it recedes into context.
  drawFurnitureSymbol(ctx, {
    category: c.category,
    cx: p.x,
    cy: p.y,
    w,
    h,
    rotation: c.rotation,
    mirror: c.mirror,
    stroke: ref ? C.furnitureRef : frozen ? DECISION_DOT.Confirmed : C.furniture,
    detail: ref ? C.furnitureRef : C.furnitureDetail,
    fill: ref ? undefined : frozen ? hexToRgba(DECISION_DOT.Confirmed, 0.1) : C.furnitureFill,
    seat: ref ? undefined : frozen ? hexToRgba(DECISION_DOT.Confirmed, 0.16) : C.furnitureSeat,
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
  // (reference furniture carries no decision state, so never dot it).
  if (c.decision !== 'Open' && !ref) {
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

// ---- dimension chips + labels (M1 / M4 chip visual language) ----

/** One per-segment length chip. `live` = the in-progress segment (filled accent
 *  pill); committed segments get the quiet accent-on-paper label. */
export function drawDimChip(
  v: PaintView,
  a: Pt,
  b: Pt,
  angleDeg?: number,
  live = false,
  snapped = false,
) {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < 0.02) return
  const ctx = v.ctx
  const mid = v.toScreen((a.x + b.x) / 2, (a.y + b.y) / 2)
  const label = angleDeg != null ? `${fmtMeters(len)}  ${Math.round(angleDeg)}°` : fmtMeters(len)
  ctx.save()
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(label).width
  // Live (in-progress) chip reads as a filled accent pill; committed chips are
  // quiet accent-on-paper labels (dimension-label style from render.ts).
  ctx.fillStyle = live ? (snapped ? C.accentDeep : hexToRgba(C.accent, 0.92)) : C.chipPaper
  roundRect(ctx, mid.x - w / 2 - 5, mid.y - 8.5, w + 10, 17, 4)
  ctx.fill()
  ctx.fillStyle = live ? WHITE : C.accent
  ctx.fillText(label, mid.x, mid.y)
  ctx.restore()
}

/** Draw one selection-dimension pill (M1 chip visual language: editable →
 *  filled accent, informational → quiet paper) and return its screen box so the
 *  caller can register it as a click target. `hidden` skips the paint (the
 *  inline editor is covering it) while still yielding the box. */
export function drawDimLabel(
  v: PaintView,
  cx: number,
  cy: number,
  text: string,
  editable: boolean,
  hidden = false,
): DimLabelBox {
  const ctx = v.ctx
  ctx.save()
  ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(text).width
  const w = tw + 12
  const h = 17
  const x = cx - w / 2
  const y = cy - h / 2
  if (!hidden) {
    ctx.fillStyle = editable ? C.accent : C.chipPaper
    roundRect(ctx, x, y, w, h, 4)
    ctx.fill()
    if (!editable) {
      ctx.strokeStyle = hexToRgba(C.accent, 0.28)
      ctx.lineWidth = 1
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4)
      ctx.stroke()
    }
    ctx.fillStyle = editable ? WHITE : C.accent
    ctx.fillText(text, cx, cy)
  }
  ctx.restore()
  return { x, y, w, h }
}

// ---- sheet furniture: rulers + presentation summary ----

/** Presentation-mode plan summary block (bottom-right): the test-fit
 *  deliverable card — name, NIA, workstations, m²/ws, efficiency. */
export function drawSummary(v: PaintView, w: number, h: number, m: Metrics) {
  const rows: [string, string][] = [
    ['AREA (NIA)', `${fmtArea(m.net_internal_area ?? m.floor_area)} m²`],
    ['WORKSTATIONS', `${m.workstations ?? 0}`],
    ['M² / WS', m.area_per_workstation ? m.area_per_workstation.toFixed(1) : '—'],
    ['EFFICIENCY', m.efficiency_pct != null ? `${Math.round(m.efficiency_pct)} %` : '—'],
  ]
  const ctx = v.ctx
  const W = 196
  const pad = 12
  const rowH = 17
  const H = 30 + rows.length * rowH + pad - 4
  const x = w - W - 16
  const y = h - H - 16
  ctx.fillStyle = C.surface
  ctx.fillRect(x, y, W, H)
  ctx.strokeStyle = C.thumbBorder
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.label
  ctx.font = '700 10px "Hanken Grotesk", system-ui, sans-serif'
  ctx.fillText('TEST FIT', x + pad, y + 18)
  ctx.strokeStyle = C.thumbRule
  line(ctx, x + pad, y + 24.5, x + W - pad, y + 24.5)

  let ry = y + 24 + rowH - 4
  for (const [label, value] of rows) {
    ctx.fillStyle = C.labelSub
    ctx.font = '600 8px "Hanken Grotesk", system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(label, x + pad, ry)
    ctx.fillStyle = C.label
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace'
    ctx.textAlign = 'right'
    ctx.fillText(value, x + W - pad, ry)
    ry += rowH
  }
  ctx.textAlign = 'left'
}

/** Top + left rulers with amber cursor ticks (`cursor` = world point, or null
 *  when the pointer is off-canvas). */
export function drawRulers(v: PaintView, w: number, h: number, cursor: Pt | null) {
  const ctx = v.ctx
  // strips
  ctx.fillStyle = C.rulerBg
  ctx.fillRect(0, 0, w, RULER)
  ctx.fillRect(0, 0, RULER, h)
  ctx.fillStyle = C.rulerCorner
  ctx.fillRect(0, 0, RULER, RULER)

  const stepM = niceStep(v.scale)
  ctx.font = '9px "Hanken Grotesk", system-ui, sans-serif'
  ctx.fillStyle = C.rulerText
  ctx.strokeStyle = C.rulerTick
  ctx.lineWidth = 1

  // top ruler (world X)
  const xStart = Math.ceil(v.toWorld(RULER, 0).x / stepM) * stepM
  const xEnd = v.toWorld(w, 0).x
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.beginPath()
  for (let m = xStart; m <= xEnd; m += stepM) {
    const sx = v.toScreen(m, 0).x
    if (sx < RULER) continue
    ctx.moveTo(sx + 0.5, RULER - 6)
    ctx.lineTo(sx + 0.5, RULER)
    ctx.fillText(fmtM(m), sx + 3, 10)
  }
  ctx.stroke()

  // left ruler (world Y)
  const yStart = Math.ceil(v.toWorld(0, RULER).y / stepM) * stepM
  const yEnd = v.toWorld(0, h).y
  ctx.textAlign = 'center'
  ctx.beginPath()
  for (let m = yStart; m <= yEnd; m += stepM) {
    const sy = v.toScreen(0, m).y
    if (sy < RULER) continue
    ctx.moveTo(RULER - 6, sy + 0.5)
    ctx.lineTo(RULER, sy + 0.5)
    ctx.fillText(fmtM(m), RULER / 2, sy - 3)
  }
  ctx.stroke()

  // amber cursor ticks
  if (cursor) {
    const cs = v.toScreen(cursor.x, cursor.y)
    ctx.strokeStyle = C.accent
    ctx.lineWidth = 1
    if (cs.x >= RULER) line(ctx, cs.x + 0.5, 0, cs.x + 0.5, RULER)
    if (cs.y >= RULER) line(ctx, 0, cs.y + 0.5, RULER, cs.y + 0.5)
  }
}

// ---- thumbnails ----


/**
 * Minimal plan schematic of a document state → dataURL, for gallery cards.
 * Deliberately NOT the interactive render() pipeline: render() draws to the
 * live canvas with pan/zoom transforms, rulers, and CAD overlays; thumbnails
 * need an isolated fit-to-frame offscreen scene.
 */
export function renderThumb(st: DocState, w = 200, h = 140): string {
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
  ctx.fillStyle = WHITE
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
    if (s.kind === 'Poly') {
      if (s.pts.length < 3) continue
      ctx.beginPath()
      ctx.moveTo(X(s.pts[0][0]), Y(s.pts[0][1]))
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(X(s.pts[i][0]), Y(s.pts[i][1]))
      ctx.closePath()
      ctx.fill()
    } else if (s.kind === 'RectRing') {
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
  ctx.strokeStyle = C.thumbWall
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

// ---- shared geometry / format helpers ----

export function wallBbox(
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

/** The 8 resize-handle screen points of a room box, ordered TL,T,TR,R,BR,B,BL,L. */
export function handlePoints(box: { x: number; y: number; w: number; h: number }) {
  const { x, y, w, h } = box
  const mx = x + w / 2
  const my = y + h / 2
  return [
    { x, y },
    { x: mx, y },
    { x: x + w, y },
    { x: x + w, y: my },
    { x: x + w, y: y + h },
    { x: mx, y: y + h },
    { x, y: y + h },
    { x, y: my },
  ]
}

export function inScreenBox(
  box: { x: number; y: number; w: number; h: number },
  s: { x: number; y: number },
) {
  return s.x >= box.x && s.x <= box.x + box.w && s.y >= box.y && s.y <= box.y + box.h
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

export function clampN(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Min distance (m) from point `p` to the polygon's boundary edges. */
export function distToPoly(poly: [number, number][], p: { x: number; y: number }): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? clampN(((p.x - ax) * dx + (p.y - ay) * dy) / len2, 0, 1) : 0
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)))
  }
  return best
}

/** Blend a #rrggbb color toward white by `amt` (0..1) — presentation tints. */
function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (c: number) => Math.round(c + (255 - c) * amt)
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`
}

/** Area readout: whole m² from 10 up, one decimal below ("42 m²", "7.5 m²"). */
function fmtArea(a: number): string {
  return a >= 10 ? String(Math.round(a)) : a.toFixed(1)
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
