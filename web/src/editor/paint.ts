// 2D PAINT LAYER for the editor canvas — every `draw*` primitive plus the
// palette and the small geometry/format helpers they share.
//
// Split out of `EditorCanvas.ts` (which stays the public façade): these are pure
// draw functions that take an explicit {@link PaintView} (the viewport + 2D
// context) and the data to paint, so nothing here reads or mutates document
// state. The core stays the source of truth — the façade re-reads `state()` and
// hands the result in. Rendering is TS-side for now and migrates into a
// Rust/WebGL renderer later (docs/adr/0001-rendering-staging.md).

import { drawSymbol, seatsForSize } from './symbols'
import { fmtMeters } from '../cad/dimEdit'
import type { DocComponent, DocState, DocWall, DocZone } from '../types/doc'
import {
  planStyle, strokePx, C, DECISION_DOT, ZONE,
  WHITE, BLACK, THUMB_FILL, THUMB_OTHER, hexToRgba, CHROME, hatchLevel, detailLevel, SERVICE_ROOMS, abbreviate,
} from './planStyle'
import type { FillStyle } from './planStyle'
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
  /** Zone id — so hover/selection can promote this label to a pill. */
  id: number
  name: string
  metrics: string | null
  cx: number
  cy: number
  namePx: number
  color: string
  /** The room's own screen box. Displacement is the FIRST rung of the collision
   *  ladder, and this is what keeps a displaced label inside the room it names —
   *  a label that wanders into the neighbouring room is worse than no label. */
  bounds: { x: number; y: number; w: number; h: number }
  /** m². Placement is largest-room-first, so this is the sort key. */
  area: number
}

/** Screen-space obstacle a room label must not print over — one per drawn
 *  furniture glyph. See {@link drawZoneTags}. */
export interface LabelObstacle {
  x: number
  y: number
  w: number
  h: number
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
  ctx.lineWidth = strokePx('wall', v.scale)
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
  const ctx = v.ctx
  const style = planStyle(v.presentation ? 'paper' : 'editor')
  const el = exterior ? style.wallCut : style.wallInterior
  const width = strokePx(el.tier ?? 'wall', v.scale)
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

  // Fill the thickness polygon per the table, THEN stroke the faces, so the
  // outlines stay crisp on top of whatever texture the profile asked for.
  // Switching this wall between unfilled / solid / hatched is a planStyle edit;
  // nothing here needs to know which one it is.
  const q = [a1, b1, b2, a2].map((pt) => v.toScreen(pt.x, pt.y))
  fillWith(
    v,
    el.fill,
    () => {
      ctx.moveTo(q[0].x, q[0].y)
      for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y)
      ctx.closePath()
    },
    {
      minX: Math.min(...q.map((pt) => pt.x)),
      minY: Math.min(...q.map((pt) => pt.y)),
      maxX: Math.max(...q.map((pt) => pt.x)),
      maxY: Math.max(...q.map((pt) => pt.y)),
    },
    Math.max(w.thickness, 0.1) * v.scale,
  )

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
  // The punch must be at least as wide as the wall it erases.
  const width = Math.max(
    strokePx(style.opening.tier ?? 'openingPunch', v.scale),
    thickness * v.scale,
  )
  drawSegment(v, a, b, width, style.opening.stroke ?? WHITE)
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
/**
 * THE one fill step. Paints an element's interior per its {@link FillStyle} —
 * `none`, `solid`, or a diagonal `hatch` — clipped to `tracePath`.
 *
 * This is 2a''s architecture change, and it is deliberately ONE function shared
 * by walls and zone cores rather than a wall-specific special case. It began as
 * `drawPoche`, which already drew a 45 degree hatch but with its colour,
 * spacing, alpha and angle hardcoded; generalising it was cheaper than adding a
 * second hatch and is what the no-bloat rule asks for.
 *
 * `referencePx` is the element's own thickness in screen px, for fills whose
 * spacing is expressed as a fraction of it (a wall's hatch tracks its width; a
 * zone core's does not).
 */
function fillWith(
  v: PaintView,
  fill: FillStyle | undefined,
  tracePath: () => void,
  bb: { minX: number; minY: number; maxX: number; maxY: number },
  referencePx: number,
  evenOdd = false,
) {
  if (!fill || fill.kind === 'none') return
  const ctx = v.ctx
  ctx.save()
  ctx.beginPath()
  tracePath()
  ctx.clip(evenOdd ? 'evenodd' : 'nonzero')

  if (fill.kind === 'solid') {
    ctx.fillStyle = fill.color
    ctx.fillRect(bb.minX, bb.minY, bb.maxX - bb.minX, bb.maxY - bb.minY)
    ctx.restore()
    return
  }

  const step = Math.max(
    1.5, // below this the hatch reads as a grey smear, not a texture
    'px' in fill.spacing ? fill.spacing.px : referencePx * fill.spacing.ofThickness,
  )
  // 2a' finding, landed continuously: a hatch inside a 4 px wall is a smear,
  // not a texture. Fade it with thickness instead of cutting it off, so the
  // wall degrades into a plain double line — qbiq's grammar — with no pop.
  const level = hatchLevel(referencePx)
  if (level <= 0.001) { ctx.restore(); return }
  ctx.strokeStyle = hexToRgba(fill.color, fill.alpha * level)
  ctx.lineWidth = strokePx(fill.tier, v.scale)
  const rad = (fill.angleDeg * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  // Sweep the line family along the perpendicular so any angle is covered.
  const w = bb.maxX - bb.minX
  const h = bb.maxY - bb.minY
  const diag = Math.hypot(w, h)
  const cx = (bb.minX + bb.maxX) / 2
  const cy = (bb.minY + bb.maxY) / 2
  ctx.beginPath()
  for (let o = -diag / 2; o <= diag / 2; o += step) {
    const px = cx - dy * o
    const py = cy + dx * o
    ctx.moveTo(px - (dx * diag) / 2, py - (dy * diag) / 2)
    ctx.lineTo(px + (dx * diag) / 2, py + (dy * diag) / 2)
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
  /** Selected/hovered zone ids — the same set `drawZoneTags` promotes to pills.
   *  A ground zone in this set keeps its tag; see `suppressTag` below. */
  highlight?: ReadonlySet<number>,
): ZoneTag[] {
  if (zones.length === 0) return []
  const style = planStyle(v.presentation ? 'paper' : 'editor')
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
    // Ground zones are the surface the plan sits on, not content on it.
    const ground = style.groundZones.includes(z.zone_type)
    if (ground && style.groundTint === null) continue
    // GROUND CARRIES NO NAME. Circulation and unassigned floor are the surface
    // the plan sits on, and a surface is not labelled — it is identified by the
    // legend, which is why the legend is a required feature of this phase and
    // not a nicety (spec `required_new_feature`).
    //
    // Measured before this line existed: 17 of the 24 zone tags drawn at rest
    // were ground — 9 reading CIRCULATION, 8 reading CORRIDOR — so 71% of all
    // in-plan text named the floor rather than the rooms. The reference prints
    // eight tiny service-room abbreviations and nothing else.
    //
    // The paper profile already achieved this by accident: its `continue` above
    // skips fill AND tag together. The editor kept a non-null tint, fell
    // through, and pushed a tag. So this is the editor catching up to a rule the
    // sheet has always followed, not a new rule.
    //
    // EXCEPTION, deliberate: a SELECTED ground zone still gets its tag, because
    // interaction states are never part of the resting drawing and you cannot
    // edit a corridor you cannot name. `drawZoneTags` draws the selected tag as
    // the interactive pill; suppressing it here would make corridors unnameable.
    const suppressTag = ground && !highlight?.has(z.id)
    ctx.fillStyle = ground
      ? style.groundTint!
      : v.presentation
        ? lighten(pal.fill, 0.4)
        : pal.fill
    // `fillWith`'s last argument is the REFERENCE SIZE its LOD ramp fades the
    // hatch against (`hatchLevel` = smoothstep 5..13 px). It exists because a
    // hatch inside a 4 px wall is a smear, so a thin wall degrades to a plain
    // double line instead of popping.
    //
    // All three zone sites passed 0. `smoothstep(5, 13, 0)` is 0, so `fillWith`
    // returned before drawing anything — which means the Unassigned hatch never
    // rendered at any alpha, AND **the Core poché has never rendered either**:
    // declared, documented, wired, and dead. It was invisible because the thing
    // it was hiding behind is a legitimate feature working correctly on the
    // input it was given.
    //
    // A zone has no thickness, so its reference size is its smaller on-screen
    // dimension: a large room shows its texture, a sliver fades it out, which is
    // the ramp's intent applied to the right quantity.
    //
    // TEXTURE over the fill, computed once for all three shape branches: the
    // Core's poché, or the editor-only hatch that marks unassigned floor. Both
    // are the same operation on the same three call sites, so they share one
    // decision rather than three copies of `if (kind === X)`.
    const texture: FillStyle | null =
      z.zone_type === 'Core'
        ? style.corePoche
          ? { ...(style.corePoche as Extract<FillStyle, { kind: 'hatch' }>), color: pal.line }
          : null
        : z.zone_type === 'Unassigned'
          ? style.unassignedHatch
          : null
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
      // Unassigned ground gets a DASHED hairline instead of the room enclosure:
      // on a 19-40 px ribbon the edge is most of what there is to see, so this
      // carries the "nobody uses this" signal that a 9 px hatch pitch cannot.
      const outline = z.zone_type === 'Unassigned' ? style.unassignedOutline : null
      if (outline) {
        ctx.save()
        ctx.setLineDash(outline.dash ?? [])
        ctx.strokeStyle = outline.stroke!
        ctx.lineWidth = strokePx(outline.tier ?? 'furniture', v.scale)
        ctx.stroke()
        ctx.restore()
      } else {
        ctx.strokeStyle = hexToRgba(pal.line, 0.45)
        ctx.lineWidth = strokePx('roomEnclosure', v.scale)
        ctx.stroke()
      }
      // Screen-space ring, computed ONCE: the texture bbox, the pole of
      // inaccessibility and the tag's own bounds are all derived from it.
      const sp = pts.map((pt) => v.toScreen(pt[0], pt[1]))
      let bminX = Infinity
      let bminY = Infinity
      let bmaxX = -Infinity
      let bmaxY = -Infinity
      for (const q of sp) {
        bminX = Math.min(bminX, q.x)
        bminY = Math.min(bminY, q.y)
        bmaxX = Math.max(bmaxX, q.x)
        bmaxY = Math.max(bmaxY, q.y)
      }
      if (texture) {
        fillWith(
          v,
                    texture,
          () => {
            ctx.moveTo(sp[0].x, sp[0].y)
            for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y)
            ctx.closePath()
          },
          { minX: bminX, minY: bminY, maxX: bmaxX, maxY: bmaxY },
          Math.min(bmaxX - bminX, bmaxY - bminY),
        )
      }
      // Shoelace, for AREA only. The label anchor is the pole of
      // inaccessibility, not this centroid: on an L-shaped or notched zone the
      // centroid can sit in the notch, outside the room it is meant to name.
      let a2 = 0
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i]
        const [x1, y1] = pts[(i + 1) % pts.length]
        a2 += x0 * y1 - x1 * y0
      }
      const stat = zoneStats.get(z.id)
      const area = stat?.area ?? Math.abs(a2) / 2
      if (area < 6 || Math.abs(a2) < 1e-6) continue
      const c = poleOfInaccessibility(sp)
      const name = z.label.toUpperCase()
      ctx.font = '600 10px "Hanken Grotesk", system-ui, sans-serif'
      const cap = stat?.capacity ?? 0
      const metrics: string | null =
        area >= 12 ? `${fmtArea(area)} m²${cap > 0 ? ` · ${cap} pax` : ''}` : null
      if (!suppressTag)
        tags.push({
          id: z.id,
          name,
          metrics,
          cx: c.x,
          cy: c.y,
          namePx: 10,
          color: pal.line,
          bounds: { x: bminX, y: bminY, w: bmaxX - bminX, h: bmaxY - bminY },
          area,
        })
    } else if (z.shape.kind === 'RectRing') {
      const s = z.shape
      const o = v.toScreen(s.x - s.w / 2, s.y - s.h / 2)
      const io = v.toScreen(s.x - s.in_w / 2, s.y - s.in_h / 2)
      ctx.beginPath()
      ctx.rect(o.x, o.y, s.w * v.scale, s.h * v.scale)
      ctx.rect(io.x, io.y, s.in_w * v.scale, s.in_h * v.scale)
      ctx.fill('evenodd')
      if (texture) {
        fillWith(
          v,
                    texture,
          () => {
            ctx.rect(o.x, o.y, s.w * v.scale, s.h * v.scale)
            ctx.rect(io.x, io.y, s.in_w * v.scale, s.in_h * v.scale)
          },
          { minX: o.x, minY: o.y, maxX: o.x + s.w * v.scale, maxY: o.y + s.h * v.scale },
          Math.min(s.w, s.h) * v.scale,
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
      const rectOutline = z.zone_type === 'Unassigned' ? style.unassignedOutline : null
      ctx.save()
      if (rectOutline) {
        ctx.setLineDash(rectOutline.dash ?? [])
        ctx.strokeStyle = rectOutline.stroke!
        ctx.lineWidth = strokePx(rectOutline.tier ?? 'furniture', v.scale)
      } else {
        ctx.strokeStyle = hexToRgba(pal.line, 0.45)
        ctx.lineWidth = strokePx('roomEnclosure', v.scale)
      }
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, w - 1, h - 1)
      ctx.restore()
      if (texture) {
        fillWith(
          v,
                    texture,
          () => ctx.rect(p.x, p.y, w, h),
          { minX: p.x, minY: p.y, maxX: p.x + w, maxY: p.y + h },
          Math.min(w, h),
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
      if (!suppressTag)
        tags.push({
          id: z.id,
          name,
          metrics,
          cx: c.x,
          cy: c.y,
          namePx,
          color: pal.line,
          bounds: { x: p.x, y: p.y, w, h },
          area,
        })
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
/**
 * POLE OF INACCESSIBILITY — the interior point farthest from any edge.
 *
 * The centroid is the wrong anchor for a room label: on an L-shaped or notched
 * zone it can land in the notch, outside the room entirely, and on a concave
 * plate that is the common case rather than the exception. This finds the
 * centre of the largest inscribed circle instead, so a label sits in the
 * roomiest part of whatever shape the room actually is.
 *
 * Grid-refinement rather than the full priority-queue polylabel: sample a
 * coarse grid, keep the best cell, refine around it. Cheap, and the precision
 * that matters here is "well inside the room", not sub-pixel.
 */
function poleOfInaccessibility(
  poly: Array<{ x: number; y: number }>,
  iterations = 4,
): { x: number; y: number } {
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  let minX = Math.min(...xs)
  let maxX = Math.max(...xs)
  let minY = Math.min(...ys)
  let maxY = Math.max(...ys)

  const distToEdges = (px: number, py: number) => {
    let inside = false
    let best = Infinity
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]
      const b = poly[j]
      if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside
      }
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0
      best = Math.min(best, Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)))
    }
    return inside ? best : -best
  }

  let best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, d: -Infinity }
  for (let it = 0; it < iterations; it++) {
    const stepX = (maxX - minX) / 8
    const stepY = (maxY - minY) / 8
    for (let gx = 0; gx <= 8; gx++) {
      for (let gy = 0; gy <= 8; gy++) {
        const x = minX + gx * stepX
        const y = minY + gy * stepY
        const d = distToEdges(x, y)
        if (d > best.d) best = { x, y, d }
      }
    }
    minX = best.x - stepX
    maxX = best.x + stepX
    minY = best.y - stepY
    maxY = best.y + stepY
  }
  return { x: best.x, y: best.y }
}

/**
 * Draw the room labels.
 *
 * THREE CHANGES FROM THE PILL-PER-ROOM VERSION, all from Phase 0's measurement:
 *
 * 1. NO PILL AT REST. The reference draws text on the drawing, not chips over
 *    it; at overview zoom our plan was mostly pills. The pill is now an
 *    INTERACTIVE state — `highlight` (hover/selection) only — which keeps the
 *    rule that interactive states are never part of the resting drawing.
 * 2. COLLISION LADDER, ORDERED BY DAMAGE. Labels are placed largest-room-first
 *    and each takes the best form that clears both the labels already placed
 *    AND the furniture underneath it:
 *      (name + metrics) -> name only -> smaller name -> abbreviation -> hide,
 *    and WITHIN each form, DISPLACEMENT inside the room is tried before the
 *    form is degraded. Moving a label costs nothing; shortening it destroys
 *    information, so the cheap rung goes first. Hiding is a legitimate last
 *    rung, not a failure: an unreadable pile of overlapping text identifies
 *    nothing, and the legend still does.
 * 3. PROFILE POLICY. `paper` names only service rooms, abbreviated, and lets
 *    the legend identify everything else — which is what the reference does.
 *
 * `obstacles` is what makes rung 2 mean anything on a furnished plan. Without
 * it the ladder de-collides labels against LABELS only, which is why
 * "MEETING ROOM 2 / 10 m² · 10 pax" printed across its own chairs while every
 * rung reported a clean fit — the chairs were never in the occupancy at all.
 */
export function drawZoneTags(
  v: PaintView,
  tags: ZoneTag[],
  highlight?: Set<number>,
  obstacles: readonly LabelObstacle[] = [],
) {
  const ctx = v.ctx
  const style = planStyle(v.presentation ? 'paper' : 'editor')
  const policy = style.labelPolicy
  const NAME_FONT = (px: number) => `600 ${px}px "Hanken Grotesk", system-ui, sans-serif`
  const MET_FONT = '500 9.5px "Hanken Grotesk", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Largest first: a big room losing its name to a small one is the wrong
  // trade, and placement order is what decides that. Sorting by AREA — the
  // previous key was `metrics ? 1 : 0`, which only separated rooms that carry
  // metrics from those that do not and left every large room unordered against
  // every other large room.
  const ordered = [...tags].sort((a, b) => b.area - a.area)
  const placed: Array<{ x: number; y: number; w: number; h: number }> = []

  // Two populations, two strengths — and the difference is the whole design.
  //
  // Another LABEL is a HARD blocker: two names on one spot identify neither.
  // FURNITURE is a soft COST: an architect's plan does print a room name across
  // the table in the middle of that room, and the halo keeps it legible. Making
  // furniture hard was measurably worse than the overlap it fixed — a 12-seat
  // meeting room lost its name entirely, because on a furnished plan there is
  // often no furniture-free spot anywhere inside the room.
  const clearOfLabels = (x: number, y: number, w: number, h: number): boolean => {
    for (const r of placed) {
      if (Math.abs(r.x - x) * 2 < r.w + w && Math.abs(r.y - y) * 2 < r.h + h) return false
    }
    return true
  }
  /** Fraction of the label box covered by furniture. 0 = free of it. */
  const inkCost = (x: number, y: number, w: number, h: number): number => {
    let covered = 0
    for (const o of obstacles) {
      const ox = Math.min(o.x + o.w / 2, x + w / 2) - Math.max(o.x - o.w / 2, x - w / 2)
      const oy = Math.min(o.y + o.h / 2, y + h / 2) - Math.max(o.y - o.h / 2, y - h / 2)
      if (ox > 0 && oy > 0) covered += ox * oy
    }
    return covered / (w * h)
  }
  // Below this, the halo carries it and the label stays where it reads best.
  const ACCEPTABLE_COVER = 0.12

  for (const t of ordered) {
    const isHot = highlight?.has(t.id) ?? false
    const service = SERVICE_ROOMS.some((r) => t.name.toUpperCase().startsWith(r))
    if (policy.names === 'service' && !service && !isHot) continue

    // Forms, most informative first. Each is a smaller claim on the drawing.
    const forms: Array<{ name: string; px: number; metrics: string | null }> = [
      { name: t.name, px: t.namePx, metrics: policy.metrics ? t.metrics : null },
      { name: t.name, px: t.namePx, metrics: null },
      { name: t.name, px: Math.max(8, t.namePx - 2), metrics: null },
      { name: abbreviate(t.name), px: Math.max(8, t.namePx - 2), metrics: null },
    ]

    type Placement = {
      name: string
      px: number
      metrics: string | null
      w: number
      h: number
      x: number
      y: number
    }
    let chosen: Placement | null = null
    /** Best-effort winner when no position clears ACCEPTABLE_COVER. */
    let fallback: (Placement & { cost: number }) | null = null

    for (const f of forms) {
      ctx.font = NAME_FONT(f.px)
      const nameW = ctx.measureText(f.name).width
      ctx.font = MET_FONT
      const metW = f.metrics ? ctx.measureText(f.metrics).width : 0
      const w = Math.max(nameW, metW) + 10
      const h = f.metrics ? 30 : 16

      // Candidate positions: the anchor (pole of inaccessibility) first, then a
      // sweep of the room's own box, nearest-to-anchor first — so a label only
      // moves as far as it has to, and never outside the room it names.
      for (const pos of labelPositions(t, w, h)) {
        if (!clearOfLabels(pos.x, pos.y, w, h)) continue
        const cost = inkCost(pos.x, pos.y, w, h)
        if (!fallback || cost < fallback.cost) fallback = { ...f, w, h, x: pos.x, y: pos.y, cost }
        if (cost <= ACCEPTABLE_COVER) {
          chosen = { ...f, w, h, x: pos.x, y: pos.y }
          break
        }
      }
      if (chosen) break
    }
    // Nothing cleared the furniture threshold, so take the least-covered spot
    // found across every form rather than dropping the name: a room the reader
    // cannot name is a worse drawing than a name with a table under it.
    if (!chosen && fallback) chosen = fallback
    if (!chosen) continue // every form collided with another LABEL everywhere
    placed.push({ x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h })

    // Pill ONLY when hot. At rest the label is text on the drawing.
    if (isHot || policy.pillAtRest) {
      const pillH = chosen.h + 3
      ctx.save()
      ctx.shadowColor = C.pillShadow
      ctx.shadowBlur = 6
      ctx.shadowOffsetY = 1
      ctx.fillStyle = C.pillFill
      roundRect(ctx, chosen.x - chosen.w / 2 - 4, chosen.y - pillH / 2, chosen.w + 8, pillH, pillH / 2)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = hexToRgba(t.color, 0.28)
      ctx.lineWidth = CHROME.hairline
      roundRect(ctx, chosen.x - chosen.w / 2 - 4, chosen.y - pillH / 2, chosen.w + 8, pillH, pillH / 2)
      ctx.stroke()
    }

    // A halo that follows the GLYPHS, not a rect: the plan's own linework runs
    // under these labels and a rectangular knockout would punch a visible hole
    // in it. Only drawn at rest — the pill already provides the ground when hot.
    const nameY = chosen.metrics ? chosen.y - 6 : chosen.y
    const halo = !(isHot || policy.pillAtRest)
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2

    ctx.font = NAME_FONT(chosen.px)
    if (halo) {
      ctx.strokeStyle = C.surface
      ctx.lineWidth = CHROME.labelHalo
      ctx.strokeText(chosen.name, chosen.x, nameY)
    }
    ctx.fillStyle = t.color
    ctx.fillText(chosen.name, chosen.x, nameY)

    if (chosen.metrics) {
      ctx.font = MET_FONT
      if (halo) {
        ctx.strokeStyle = C.surface
        ctx.lineWidth = CHROME.labelHalo
        ctx.strokeText(chosen.metrics, chosen.x, chosen.y + 7.5)
      }
      ctx.fillStyle = C.labelSub
      ctx.fillText(chosen.metrics, chosen.x, chosen.y + 7.5)
    }
  }
}

/**
 * Candidate anchors for one room label, nearest-first: the pole of
 * inaccessibility, then a sweep of the room's own box.
 *
 * Every candidate is clamped so the whole label box sits inside `t.bounds`.
 * A label that escapes its room to find clear space is worse than one that
 * shrinks — it names the wrong room — so displacement is bounded, and when the
 * box simply cannot fit the room the anchor is the only candidate and the
 * caller degrades the form instead.
 */
function labelPositions(t: ZoneTag, w: number, h: number): Array<{ x: number; y: number }> {
  const out = [{ x: t.cx, y: t.cy }]
  const b = t.bounds
  const padX = w / 2 + 2
  const padY = h / 2 + 2
  const minX = b.x + padX
  const maxX = b.x + b.w - padX
  const minY = b.y + padY
  const maxY = b.y + b.h - padY
  if (minX > maxX || minY > maxY) return out // the room cannot hold this form

  const STEPS = 5
  for (let iy = 0; iy < STEPS; iy++) {
    for (let ix = 0; ix < STEPS; ix++) {
      out.push({
        x: minX + ((maxX - minX) * ix) / (STEPS - 1),
        y: minY + ((maxY - minY) * iy) / (STEPS - 1),
      })
    }
  }
  // Nearest to the anchor first: move as little as possible.
  const ax = t.cx
  const ay = t.cy
  return out.sort((p, q) => (p.x - ax) ** 2 + (p.y - ay) ** 2 - ((q.x - ax) ** 2 + (q.y - ay) ** 2))
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
  ctx.lineWidth = CHROME.selection
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
  ctx.lineWidth = CHROME.handle
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
  // R2: symbols.ts owns symbol geometry. Dimensions cross in METRES — the symbol
  // module owns world→screen — and the seat count comes from the MODEL, falling
  // back to the same world-size rule the core uses. Never from `w`/`h` on screen:
  // countables are not LOD'd at any zoom, on any surface.
  drawSymbol(
    ctx,
    {
      category: c.category,
      cx: p.x,
      cy: p.y,
      w: c.w,
      h: c.h,
      rotation: c.rotation,
      mirror: c.mirror,
      seats: c.seats ?? seatsForSize(c.category, c.w, c.h),
      // NO IMPLIED SEATING ON THE CANVAS EITHER (R6, extended to this consumer).
      // The generator emits real `Chair` components now, and this loop draws
      // every one of them as its own glyph. Leaving the flag at its default put
      // a second, implied chair under each desk and a full implied ring around
      // each table — 63 desks drew 126 chairs, and a 10-seat table drew its ring
      // on top of the 8 chairs that actually fit. R6 ruled the print path with
      // exactly this reasoning; the canvas is the same consumer error, and the
      // shared module keeps its default so symbols.test.mjs still pins that the
      // glyph reads its seat count from the MODEL.
      implySeats: false,
      selected,
    },
    {
      stroke: ref ? C.furnitureRef : frozen ? DECISION_DOT.Confirmed : C.furniture,
      detail: ref ? C.furnitureRef : C.furnitureDetail,
      fill: ref ? undefined : frozen ? hexToRgba(DECISION_DOT.Confirmed, 0.1) : C.furnitureFill,
      seat: ref ? undefined : frozen ? hexToRgba(DECISION_DOT.Confirmed, 0.16) : C.furnitureSeat,
      accent: C.accent,
    },
    // Face 9 stays law through the conversion: NO dpr arithmetic here. The view
    // carries dpr and the symbol module owns every device-pixel decision.
    { pxPerM: v.scale, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 },
  )

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
    ctx.lineWidth = CHROME.handle
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
      ctx.lineWidth = CHROME.hairline
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
  ctx.lineWidth = CHROME.hairline
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
  ctx.lineWidth = CHROME.hairline

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
    ctx.lineWidth = CHROME.hairline
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

  // Zone tints (rect + ring), same pastels as the main canvas — and the same
  // FIGURE/GROUND RULE. A thumbnail is a plan at 180 px: if ground is filled
  // here it is filled in the one view a user compares alternatives in.
  //
  // Measured on the Phase 0 candidate cards: 1 226 px of the Circulation fill
  // per card, flooding the perimeter and the whole upper-left wing so the plan
  // read as "grey blob with a blue desk field". The card is the FIRST thing
  // anyone sees, and it was the one surface still contradicting the rule.
  // (The hex is deliberately NOT written here — `bench/style-gate.mjs` bans the
  // palette by VALUE, comments included, and it is right to.)
  //
  // Reads the paper profile deliberately: a card is a miniature sheet, not a
  // working surface, so it gets no editor affordances (no ground tint, no
  // hatch) — ground is simply the paper.
  const thumbGround = planStyle('paper').groundZones
  for (const z of st.zones ?? []) {
    if (thumbGround.includes(z.zone_type)) continue
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
    ctx.lineWidth = Math.max(CHROME.hairline, wl.thickness * k)
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
