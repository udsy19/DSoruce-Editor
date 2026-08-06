// The paint path for the imported-drawing canvas: floor plate, raster backdrop,
// style-batched linework, canonical furniture symbols, text, selection
// highlights and every tool overlay (place ghost, area ring, markers, anchors,
// scale line).
//
// Pure over a {@link DrawingScene} — reads state, writes only to the 2D context.
// It never mutates the drawing; see drawingEdit.ts for that.

import type { Drawing, DrawEntity, FurnitureItem } from './types'
import { CATEGORY_COLOR } from './types'
import { backdropBounds } from './rasterImport'
import { normalizeFurniture } from './normalize'
import { MONO, UI } from '../ui/type'
import { drawSymbol, seatsForSize } from '../editor/symbols'
import {
  ACCENT,
  ACCENT_HALO,
  ANCHOR_COLOR,
  ANCHOR_R_PX,
  AREA_CLOSE_PX,
  AREA_FILL,
  AREA_MASK,
  AREA_VERTEX_PX,
  FURNITURE_DETAIL,
  FURNITURE_FILL,
  FURNITURE_LINE,
  FURNITURE_SEAT,
  FURNITURE_RANK,
  HANDLE_PX,
  HOVER,
  MARKER_R_PX,
  MAT,
  PLACE_FILL,
  SPECIFIED,
  SPECIFIED_DETAIL,
  TEXT_MIN_PX,
  cssSize,
  toScreen,
  type DrawingScene,
} from './drawingScene'
import type { Pt } from './testfit'

/** Repaint the whole canvas, then fire onViewChange for screen-anchored overlays. */
export function renderScene(s: DrawingScene): void {
  const ctx = s.ctx
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
  const { w, h } = cssSize(s)
  if (w === 0 || h === 0) return

  ctx.fillStyle = MAT
  ctx.fillRect(0, 0, w, h)

  const d = s.drawing
  if (!d) return

  // White floor plate over the drawing bounds (Rayon/Revit look).
  const [minX, minY, maxX, maxY] = d.bounds
  const p0 = toScreen(s, minX, maxY) // top-left on screen (maxY = top)
  const p1 = toScreen(s, maxX, minY) // bottom-right
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y)

  drawBackdrop(s)

  // Style-batched linework: architecture buckets, with furniture woven in at
  // its rank so walls/glazing/doors sit on top.
  let furnitureDrawn = false
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const b of s.buckets) {
    if (!furnitureDrawn && b.rank >= FURNITURE_RANK) {
      drawFurniture(s, d)
      furnitureDrawn = true
    }
    ctx.strokeStyle = b.color
    ctx.lineWidth = b.lw
    ctx.beginPath()
    for (const e of b.ents) appendEntity(s, e)
    ctx.stroke()
  }
  if (!furnitureDrawn) drawFurniture(s, d)

  drawTexts(s)
  drawHighlights(s)
  drawPlaceGhost(s)
  drawArea(s)
  drawMarkers(s)
  drawAnchors(s)
  drawScaleLine(s)
  s.ev.onViewChange?.()
}

/** Raster backdrop under the linework: draw the image across its world rect
 *  (image top → world top; no flip since we map top-to-top). Slightly faded so
 *  drawn overlays (area ring, reference line) read clearly over it. */
function drawBackdrop(s: DrawingScene): void {
  if (!s.backdrop) return
  const ctx = s.ctx
  const [bx0, by0, bx1, by1] = backdropBounds(s.backdrop)
  const tl = toScreen(s, bx0, by1)
  const br = toScreen(s, bx1, by0)
  ctx.save()
  ctx.globalAlpha = 0.92
  ctx.imageSmoothingEnabled = true
  try {
    ctx.drawImage(s.backdrop.image, tl.x, tl.y, br.x - tl.x, br.y - tl.y)
  } catch {
    /* image not yet decodable — skip this frame */
  }
  ctx.restore()
}

/** Scale reference line: the placed line (solid amber, endpoint ticks + a live
 *  length label), or the in-progress rubber-band from the first click to the
 *  cursor (dashed). Drawn on top so it reads over the backdrop. */
function drawScaleLine(s: DrawingScene): void {
  const ctx = s.ctx
  let a: Pt | null = null
  let b: Pt | null = null
  if (s.scaleLine) {
    a = s.scaleLine[0]
    b = s.scaleLine[1]
  } else if (s.scaleTool && s.scaleFirst && s.toolCursor) {
    a = s.scaleFirst
    b = s.toolCursor
  } else if (s.scaleTool && s.scaleFirst) {
    const p = toScreen(s, s.scaleFirst[0], s.scaleFirst[1])
    ctx.fillStyle = ACCENT
    ctx.beginPath()
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  if (!a || !b) return
  const pa = toScreen(s, a[0], a[1])
  const pb = toScreen(s, b[0], b[1])
  ctx.save()
  ctx.strokeStyle = ACCENT
  ctx.fillStyle = ACCENT
  ctx.lineWidth = 2
  ctx.setLineDash(s.scaleLine ? [] : [6, 4])
  ctx.beginPath()
  ctx.moveTo(pa.x, pa.y)
  ctx.lineTo(pb.x, pb.y)
  ctx.stroke()
  ctx.setLineDash([])
  // Perpendicular end ticks.
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * 6
  const ny = (dx / len) * 6
  ctx.beginPath()
  ctx.moveTo(pa.x - nx, pa.y - ny)
  ctx.lineTo(pa.x + nx, pa.y + ny)
  ctx.moveTo(pb.x - nx, pb.y - ny)
  ctx.lineTo(pb.x + nx, pb.y + ny)
  ctx.stroke()
  // Length label at the midpoint.
  const lenM = Math.hypot(b[0] - a[0], b[1] - a[1])
  const text = `${lenM.toFixed(2)} m`
  ctx.font = '11px ui-monospace, monospace'
  const tw = ctx.measureText(text).width
  const mx = (pa.x + pb.x) / 2
  const my = (pa.y + pb.y) / 2
  ctx.fillStyle = 'rgba(20,24,33,0.85)'
  ctx.fillRect(mx - tw / 2 - 4, my - 9, tw + 8, 16)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, mx, my)
  ctx.restore()
}

/** Area-select overlay: a committed ring dims everything outside it (even-odd
 *  mask) and draws its outline + editable vertex handles; an in-progress ring
 *  draws the dashed partial polyline with a live preview segment to the
 *  snapped cursor. */
function drawArea(s: DrawingScene): void {
  const ctx = s.ctx
  const pts = s.area
  if (pts.length === 0 && !(s.areaTool && s.toolCursor)) return
  const scr = pts.map((p) => toScreen(s, p[0], p[1]))

  if (s.areaClosed && scr.length >= 3) {
    const { w, h } = cssSize(s)
    // Dim OUTSIDE the ring: full-canvas rect with the polygon as an even-odd hole.
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.moveTo(scr[0].x, scr[0].y)
    for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
    ctx.closePath()
    ctx.fillStyle = AREA_MASK
    ctx.fill('evenodd')
    ctx.restore()
    // Ring outline + faint inside wash.
    ctx.beginPath()
    ctx.moveTo(scr[0].x, scr[0].y)
    for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
    ctx.closePath()
    ctx.fillStyle = AREA_FILL
    ctx.fill()
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.6
    ctx.stroke()
    if (s.areaTool) drawAreaHandles(s, scr)
    return
  }

  if (s.areaTool && scr.length > 0) {
    ctx.beginPath()
    ctx.moveTo(scr[0].x, scr[0].y)
    for (let i = 1; i < scr.length; i++) ctx.lineTo(scr[i].x, scr[i].y)
    if (s.toolCursor) {
      const c = toScreen(s, s.toolCursor[0], s.toolCursor[1])
      ctx.lineTo(c.x, c.y)
    }
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.6
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])
    drawAreaHandles(s, scr)
  } else if (s.areaTool && s.toolCursor) {
    // No vertices yet — just show the snapped crosshair dot.
    const c = toScreen(s, s.toolCursor[0], s.toolCursor[1])
    ctx.fillStyle = s.toolSnapped ? ACCENT : HOVER
    ctx.beginPath()
    ctx.arc(c.x, c.y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Draw the area vertex handles; the first vertex gets a ring (close target). */
function drawAreaHandles(s: DrawingScene, scr: { x: number; y: number }[]): void {
  const ctx = s.ctx
  ctx.fillStyle = ACCENT
  for (let i = 0; i < scr.length; i++) {
    ctx.fillRect(
      Math.round(scr[i].x) - AREA_VERTEX_PX,
      Math.round(scr[i].y) - AREA_VERTEX_PX,
      AREA_VERTEX_PX * 2,
      AREA_VERTEX_PX * 2,
    )
  }
  if (!s.areaClosed && scr.length >= 3) {
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(scr[0].x, scr[0].y, AREA_CLOSE_PX, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** Room markers: a numbered pin per marker, plus a ghost pin for the armed
 *  (not-yet-dropped) marker under the cursor. */
function drawMarkers(s: DrawingScene): void {
  if (s.markerArm && s.toolCursor) {
    drawPin(s, toScreen(s, s.toolCursor[0], s.toolCursor[1]), s.markerArm.ref, true)
  }
  for (const m of s.markers) {
    drawPin(s, toScreen(s, m.x, m.y), m.ref, false)
  }
}

/** Anchor pins: a blue diamond per pin, plus a ghost diamond under the cursor
 *  while the tool is armed — visually distinct from the round §3.2 markers. */
function drawAnchors(s: DrawingScene): void {
  if (s.anchorArm && s.toolCursor) {
    drawAnchorPin(s, toScreen(s, s.toolCursor[0], s.toolCursor[1]), s.anchorArm.label, true)
  }
  for (const a of s.anchors) {
    drawAnchorPin(s, toScreen(s, a.x, a.y), a.label, false)
  }
}

/** One anchor pin: a blue diamond + a short room-kind label to its right. */
function drawAnchorPin(
  s: DrawingScene,
  p: { x: number; y: number },
  label: string,
  ghost: boolean,
): void {
  const ctx = s.ctx
  const r = ANCHOR_R_PX
  ctx.save()
  ctx.globalAlpha = ghost ? 0.55 : 1
  ctx.beginPath()
  ctx.moveTo(p.x, p.y - r)
  ctx.lineTo(p.x + r, p.y)
  ctx.lineTo(p.x, p.y + r)
  ctx.lineTo(p.x - r, p.y)
  ctx.closePath()
  ctx.fillStyle = ANCHOR_COLOR
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  // A short label beside the pin so the plan reads which room is forced where.
  ctx.fillStyle = '#e8edf2'
  ctx.font = `600 10px ${UI}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, p.x + r + 3, p.y)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** One pin: an amber disc with the ref number, optionally translucent (ghost). */
function drawPin(s: DrawingScene, p: { x: number; y: number }, ref: string, ghost: boolean): void {
  const ctx = s.ctx
  ctx.save()
  ctx.globalAlpha = ghost ? 0.55 : 1
  ctx.beginPath()
  ctx.arc(p.x, p.y, MARKER_R_PX, 0, Math.PI * 2)
  ctx.fillStyle = ACCENT
  ctx.fill()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.fillStyle = '#1a1d21'
  ctx.font = `600 10px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(ref.slice(0, 4), p.x, p.y + 0.5)
  ctx.restore()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** Placement ghost: dashed amber footprint (rotated), soft wash, center cross,
 *  and a mono dims label — follows the snapped cursor. */
function drawPlaceGhost(s: DrawingScene): void {
  const spec = s.placing
  const c = s.placeCursor
  if (!spec || !c) return
  const ctx = s.ctx
  const hw = spec.w / 2
  const hh = spec.h / 2
  const cos = Math.cos(s.placeRotation)
  const sin = Math.sin(s.placeRotation)
  const corner = (dx: number, dy: number) =>
    toScreen(s, c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos)
  const pts = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)]
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fillStyle = PLACE_FILL
  ctx.fill()
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1.4
  ctx.setLineDash([5, 4])
  ctx.stroke()
  ctx.setLineDash([])
  // center cross
  const p = toScreen(s, c.x, c.y)
  ctx.beginPath()
  ctx.moveTo(p.x - 5, p.y)
  ctx.lineTo(p.x + 5, p.y)
  ctx.moveTo(p.x, p.y - 5)
  ctx.lineTo(p.x, p.y + 5)
  ctx.lineWidth = 1
  ctx.stroke()
  // dims label under the footprint
  const bottom = Math.max(...pts.map((q) => q.y))
  ctx.fillStyle = ACCENT
  ctx.font = `11px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${spec.w.toFixed(2)} × ${spec.h.toFixed(2)} m`, p.x, bottom + 6)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** Imported furniture, rendered as CANONICAL top-view symbols (the same
 *  `drawFurnitureSymbol` vocabulary the generator emits) instead of raw DWG
 *  linework — so a freshly imported plan reads identically to a generated or
 *  merged fit: clean Desk/Chair/Table/Door/Window glyphs, no vendor-block
 *  clutter. Unbound pieces are gray; bound ("specified") pieces are data-blue
 *  so a re-imagined item still reads distinctly. */
function drawFurniture(s: DrawingScene, d: Drawing): void {
  for (const it of d.furniture) {
    if (it.productId) drawItemSymbol(s, it, SPECIFIED, SPECIFIED_DETAIL, false)
    else drawItemSymbol(s, it, FURNITURE_LINE, FURNITURE_DETAIL, false)
  }
}

/** Draw one imported furniture item as its canonical symbol. Reuses the exact
 *  `normalizeFurniture` mapping the merge path uses (mergeFit.ts) so the imported
 *  view and the merged result share one vocabulary: the piece is stamped at its
 *  bbox center. A DIRECTIONAL symbol (a Desk's monitor/chair, a Chair's backrest)
 *  must FACE the way the source block did — but normalize's axis-aligned `w/h`
 *  only carries landscape-vs-portrait, not the flip/turn, so drawing every symbol
 *  upright pointed ~35% of the sample's desks the wrong way. We fix that with
 *  `norm.rotation` (cardinal, world-CCW): un-swap `w/h` back to the block's NATURAL
 *  (pre-rotation) footprint — `odd ? [h,w] : [w,h]` — then rotate by −rotation
 *  (world CCW → screen CW under the Y-flip). This reproduces the same on-screen
 *  extent as the bbox while facing correctly, and it does NOT double-rotate: the
 *  un-swap removes the aspect the rotation re-applies. An unknown category falls
 *  to `drawFurnitureSymbol`'s neutral rounded outline, never raw linework. */
function drawItemSymbol(
  s: DrawingScene,
  it: FurnitureItem,
  stroke: string,
  detail: string,
  selected: boolean,
): void {
  const norm = normalizeFurniture(it)
  // Skip degenerate/NaN footprints so we never emit NaN paths or 0-size garbage.
  if (!(norm.w > 0) || !(norm.h > 0)) return
  const c = toScreen(s, (it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2)
  // Un-swap the aspect-baked footprint back to natural, then let the rotation
  // orient both footprint and symbol together (see normalize's rotation contract).
  const odd = Math.round(norm.rotation / (Math.PI / 2)) % 2 !== 0
  const nw = odd ? norm.h : norm.w
  const nh = odd ? norm.w : norm.h
  drawSymbol(
    s.ctx,
    {
      category: norm.category,
      cx: c.x,
      cy: c.y,
      w: nw, // METRES — the symbol module owns the world→screen conversion
      h: nh,
      rotation: -norm.rotation, // world CCW → screen CW (Y-flip)
      mirror: norm.mirror, // door hinge hand (recovered from the swing arc)
      // Seat count from the object's WORLD size, the same rule the core uses —
      // never from its size on screen. Countables are not LOD'd (R2).
      seats: seatsForSize(norm.category, nw, nh),
      // NO IMPLIED SEATING HERE EITHER (R6). `normalize` classifies imported
      // blocks as real `Chair` components, and this loop draws every imported
      // item, so leaving the flag at its default drew a seat ring around an
      // imported table ON TOP of the chairs the DXF actually contains. Worse on
      // an import view than anywhere else: it shows the customer furniture their
      // own drawing does not have.
      implySeats: false,
      selected,
    },
    { stroke, detail, fill: FURNITURE_FILL, seat: FURNITURE_SEAT, accent: ACCENT },
    { pxPerM: s.scale, dpr: s.dpr },
  )
}

function drawTexts(s: DrawingScene): void {
  const ctx = s.ctx
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  for (const e of s.texts) {
    if (!e.text || e.tx === undefined || e.ty === undefined) continue
    const px = (e.h ?? 0.2) * s.scale
    if (px < TEXT_MIN_PX) continue // too small to be legible; skip for clarity + perf
    const p = toScreen(s, e.tx, e.ty)
    ctx.save()
    ctx.translate(p.x, p.y)
    if (e.rot) ctx.rotate(-e.rot) // world CCW → screen CW
    ctx.fillStyle = e.color ?? CATEGORY_COLOR[e.category] ?? '#9aa2ad'
    ctx.font = `${px.toFixed(1)}px ${MONO}`
    ctx.fillText(e.text, 0, 0)
    ctx.restore()
  }
}

/** Hovered (soft amber wash) + selected (amber halo + crisp outline + bbox). */
function drawHighlights(s: DrawingScene): void {
  const ctx = s.ctx
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.hovered && s.hovered !== s.selected) {
    // soft amber wash over the canonical symbol so a hovered item reads as
    // "pickable" (redrawn as its symbol, not raw linework — the body is a
    // clean glyph now).
    drawItemSymbol(s, s.hovered, HOVER, HOVER, false)
  }
  if (s.selected) {
    const [minX, minY, maxX, maxY] = s.selected.bbox
    const a = toScreen(s, minX, maxY) // top-left (maxY = top)
    const b = toScreen(s, maxX, minY) // bottom-right
    // 1) translucent halo over the footprint — makes the selection glow over
    //    dense plans (the raw bbox extent, so it hugs the true footprint).
    ctx.strokeStyle = ACCENT_HALO
    ctx.lineWidth = 4
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
    // 2) the canonical symbol redrawn in crisp amber
    drawItemSymbol(s, s.selected, ACCENT, ACCENT, true)
    // 3) dashed bbox + solid corner handles
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
      ctx.fillRect(Math.round(hx) - HANDLE_PX, Math.round(hy) - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2)
    }
  }
}

/**
 * Append one entity's geometry to the CURRENT path (caller sets style +
 * begins/strokes the path). Each subpath is self-contained (moveTo first) so
 * many entities batch into a single stroke().
 */
function appendEntity(s: DrawingScene, e: DrawEntity): void {
  const ctx = s.ctx
  if (e.kind === 'polyline') {
    const pts = e.pts
    if (!pts || pts.length === 0) return
    const first = toScreen(s, pts[0][0], pts[0][1])
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < pts.length; i++) {
      const p = toScreen(s, pts[i][0], pts[i][1])
      ctx.lineTo(p.x, p.y)
    }
    if (e.closed) ctx.lineTo(first.x, first.y)
  } else if (e.kind === 'circle') {
    if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
    const c = toScreen(s, e.cx, e.cy)
    const rPx = e.r * s.scale
    ctx.moveTo(c.x + rPx, c.y)
    ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2)
  } else if (e.kind === 'arc') {
    if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
    const c = toScreen(s, e.cx, e.cy)
    const rPx = e.r * s.scale
    const a0 = -(e.start ?? 0) // world CCW → screen (Y flipped)
    const a1 = -(e.end ?? Math.PI * 2)
    ctx.moveTo(c.x + rPx * Math.cos(a0), c.y + rPx * Math.sin(a0))
    ctx.arc(c.x, c.y, rPx, a0, a1, true)
  }
}
