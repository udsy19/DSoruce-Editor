// Top-view CAD furniture line-symbols for the 2D generative canvas.
//
// Each symbol is drawn in LOCAL coordinates centered at (0,0) spanning
// ±w/2 × ±h/2, after we translate to the component's screen center and
// rotate. Symbols are thin single-weight line-work (no heavy fills) so they
// read like a Rayon/Revit/Laiout plan rather than solid blocks.
//
// Level-of-detail scales with on-screen size: below MIN_DETAIL px on either
// axis a component is just a crisp rounded rect (too small for legible detail).

export interface FurnitureOpts {
  category: string
  cx: number // SCREEN coords of the component center
  cy: number
  w: number // SCREEN size (already × scale)
  h: number
  rotation: number // radians
  stroke: string // base line color (e.g. '#8a9099')
  detail: string // secondary line color (e.g. '#b4b9c1')
  accent: string // selected color
  selected: boolean
}

// Below this on-screen size (px) a symbol degrades to a plain rounded rect.
const MIN_DETAIL = 18

export function drawFurnitureSymbol(ctx: CanvasRenderingContext2D, o: FurnitureOpts): void {
  const { cx, cy, w, h, rotation } = o
  const line = o.selected ? o.accent : o.stroke
  const lw = o.selected ? 1.6 : 1.15
  const small = Math.min(w, h) < MIN_DETAIL

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rotation)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (small && o.category !== 'FallCeiling') {
    // Too small to read as a real symbol — a clean rounded outline.
    strokeRoundRect(ctx, -w / 2, -h / 2, w, h, Math.min(3, Math.min(w, h) * 0.2), line, lw)
    ctx.restore()
    return
  }

  switch (o.category) {
    case 'Desk':
      drawDesk(ctx, w, h, line, o.detail, lw)
      break
    case 'Chair':
      drawChair(ctx, w, h, line, o.detail, lw)
      break
    case 'Table':
      drawTable(ctx, w, h, line, o.detail, lw)
      break
    case 'MeetingRoom':
      drawMeetingRoom(ctx, w, h, line, o.detail, lw)
      break
    case 'FallCeiling':
      drawFallCeiling(ctx, w, h, line, o.detail, lw, o.selected)
      break
    default:
      strokeRoundRect(ctx, -w / 2, -h / 2, w, h, Math.min(4, Math.min(w, h) * 0.14), line, lw)
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

// Desk workstation: worktop + monitor on the back edge + a task chair arc in
// front. "Back" is -y (top in local space), the user sits toward +y.
function drawDesk(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const L = -w / 2
  const R = w / 2
  const T = -h / 2
  const B = h / 2

  // The chair sits in front and overhangs the worktop slightly, so the desk
  // occupies the back ~72% of the footprint.
  const deskB = T + h * 0.72
  strokeRoundRect(ctx, L, T, w, deskB - T, Math.min(3, h * 0.08), line, lw)

  // Monitor: a short bar centered on the back edge, with a stand tick.
  const monW = Math.min(w * 0.34, 26)
  const monH = Math.max(2.2, h * 0.09)
  ctx.strokeStyle = detail
  ctx.lineWidth = lw
  ctx.strokeRect(-monW / 2, T + h * 0.06, monW, monH)
  ctx.beginPath()
  ctx.moveTo(0, T + h * 0.06 + monH)
  ctx.lineTo(0, T + h * 0.06 + monH + Math.min(3, h * 0.06))
  ctx.stroke()

  // Task chair in front: seat square + curved backrest hugging the desk edge.
  const seat = Math.min(w * 0.4, (B - deskB) * 1.35, h * 0.42)
  if (seat > 6) {
    const seatT = B - seat
    // seat
    strokeRoundRect(ctx, -seat / 2, seatT, seat, seat, seat * 0.22, detail, lw)
    // backrest arc between the seat and the desk (opens toward the desk, -y)
    ctx.strokeStyle = detail
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.arc(0, seatT + seat * 0.08, seat * 0.6, Math.PI * 1.15, Math.PI * 1.85)
    ctx.stroke()
  }
}

// Task chair top view: rounded seat + curved backrest (top) + two armrests.
function drawChair(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const sw = w * 0.68
  const sh = h * 0.62
  const T = -h / 2
  const seatT = T + h * 0.26
  // seat
  strokeRoundRect(ctx, -sw / 2, seatT, sw, sh, Math.min(sw, sh) * 0.22, line, lw)
  // backrest arc across the top
  ctx.strokeStyle = line
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.arc(0, seatT + sh * 0.1, sw * 0.55, Math.PI * 1.18, Math.PI * 1.82)
  ctx.stroke()
  // armrests: two short side bars
  ctx.strokeStyle = detail
  ctx.beginPath()
  ctx.moveTo(-sw / 2 - w * 0.04, seatT + sh * 0.28)
  ctx.lineTo(-sw / 2 - w * 0.04, seatT + sh * 0.78)
  ctx.moveTo(sw / 2 + w * 0.04, seatT + sh * 0.28)
  ctx.lineTo(sw / 2 + w * 0.04, seatT + sh * 0.78)
  ctx.stroke()
}

// Meeting table: rounded-rect top + small chair rects around the perimeter.
// Chair count scales with the long side.
function drawTable(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const inset = Math.min(w, h) * 0.2
  const tw = w - inset * 2
  const th = h - inset * 2
  strokeRoundRect(ctx, -tw / 2, -th / 2, tw, th, Math.min(tw, th) * 0.18, line, lw)

  // chairs along the two long edges — count from long-side length
  const longIsW = w >= h
  const longLen = longIsW ? tw : th
  const perSide = clampInt(Math.round(longLen / 22), 2, 3)
  const chair = Math.min(inset * 0.85, (longLen / perSide) * 0.6)
  ctx.strokeStyle = detail
  ctx.lineWidth = lw
  if (chair > 4) {
    for (let i = 0; i < perSide; i++) {
      const t = (i + 0.5) / perSide - 0.5 // -0.5..0.5
      if (longIsW) {
        chairRect(ctx, t * tw, -h / 2 + inset * 0.42, chair, inset * 0.7, detail, lw)
        chairRect(ctx, t * tw, h / 2 - inset * 0.42, chair, inset * 0.7, detail, lw)
      } else {
        chairRect(ctx, -w / 2 + inset * 0.42, t * th, inset * 0.7, chair, detail, lw)
        chairRect(ctx, w / 2 - inset * 0.42, t * th, inset * 0.7, chair, detail, lw)
      }
    }
    // one chair at each short end for a 4–6 total on larger tables
    if (Math.min(w, h) > 40) {
      if (longIsW) {
        chairRect(ctx, -w / 2 + inset * 0.42, 0, inset * 0.7, chair, detail, lw)
        chairRect(ctx, w / 2 - inset * 0.42, 0, inset * 0.7, chair, detail, lw)
      } else {
        chairRect(ctx, 0, -h / 2 + inset * 0.42, chair, inset * 0.7, detail, lw)
        chairRect(ctx, 0, h / 2 - inset * 0.42, chair, inset * 0.7, detail, lw)
      }
    }
  }
}

// Meeting room marker: a centered conference table + chairs, smaller than the
// footprint (the zone fill already colors the room). Reuses the table symbol.
function drawMeetingRoom(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const iw = w * 0.5
  const ih = h * 0.5
  drawTable(ctx, iw, ih, line, detail, lw)
}

// Fall-ceiling: an evenly spaced ceiling tile grid filling the footprint.
function drawFallCeiling(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  selected: boolean,
): void {
  const L = -w / 2
  const R = w / 2
  const T = -h / 2
  const B = h / 2
  // outer frame
  strokeRoundRect(ctx, L, T, w, h, 2, line, lw)
  // grid: aim for ~one line every ~20px, clamped so tiny tiles stay clean
  ctx.strokeStyle = selected ? line : detail
  ctx.lineWidth = 0.8
  const cols = clampInt(Math.round(w / 20), 1, 8)
  const rows = clampInt(Math.round(h / 20), 1, 8)
  ctx.beginPath()
  for (let i = 1; i < cols; i++) {
    const x = L + (w * i) / cols
    ctx.moveTo(x, T)
    ctx.lineTo(x, B)
  }
  for (let j = 1; j < rows; j++) {
    const y = T + (h * j) / rows
    ctx.moveTo(L, y)
    ctx.lineTo(R, y)
  }
  ctx.stroke()
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  stroke: string,
  lw: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.strokeStyle = stroke
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
  ctx.stroke()
}

// A small chair rectangle centered at (cx,cy).
function chairRect(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  stroke: string,
  lw: number,
): void {
  strokeRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.25, stroke, lw)
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
