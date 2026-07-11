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
  /** Reflect the symbol across its own long (local-x) axis — a door's hinge
   *  handedness. Only doors set this true; other symbols are left-right symmetric
   *  so the reflection is invisible. Applied after translate+rotate, so it flips
   *  the leaf+swing to the opposite side of the opening. Optional → default no-op. */
  mirror?: boolean
  stroke: string // base line color (e.g. '#8a9099')
  detail: string // secondary line color (e.g. '#b4b9c1')
  /** Body fill for worktops/tables (a solid object reads better than a hollow
   *  outline over a pastel zone). Undefined → no fill (passive reference furniture
   *  stays plate-less so it recedes into context). */
  fill?: string
  /** Seat/upholstery fill for chairs (softer than the body fill). */
  seat?: string
  accent: string // selected color
  selected: boolean
}

// Below this on-screen size (px) a symbol degrades to a filled rounded rect —
// low enough that overview-zoom desks still show a worktop + chair, not a pill.
const MIN_DETAIL = 11

// Categories that keep their symbol at any size: FallCeiling is a grid over a
// large footprint; Door/Window footprints are thin slabs (~0.15 m deep) whose
// symbols (swing arc / glazing lines) must always draw.
const ALWAYS_DETAIL = new Set(['FallCeiling', 'Door', 'Window'])

export function drawFurnitureSymbol(ctx: CanvasRenderingContext2D, o: FurnitureOpts): void {
  const { cx, cy, w, h, rotation } = o
  const line = o.selected ? o.accent : o.stroke
  // Confident single-weight linework (was 1.15) — the biggest lever on the
  // "faint / robotic" read. Selected bumps another notch.
  const lw = o.selected ? 1.8 : 1.35
  const small = Math.min(w, h) < MIN_DETAIL

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rotation)
  // Hinge handedness: reflect across the local long (x) axis. A door's leaf+arc
  // flip to the other side of the opening; symmetric symbols are unaffected.
  if (o.mirror) ctx.scale(1, -1)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (small && !ALWAYS_DETAIL.has(o.category)) {
    // Too small to read as a real symbol — a FILLED rounded rect (a solid chip
    // reads as furniture; a hollow outline read as faint clutter at overview zoom).
    const r = Math.min(3, Math.min(w, h) * 0.2)
    if (o.fill) fillRoundRect(ctx, -w / 2, -h / 2, w, h, r, o.fill)
    strokeRoundRect(ctx, -w / 2, -h / 2, w, h, r, line, lw)
    ctx.restore()
    return
  }

  switch (o.category) {
    case 'Desk':
      drawDesk(ctx, w, h, line, o.detail, lw, o.fill, o.seat)
      break
    case 'Chair':
      drawChair(ctx, w, h, line, o.detail, lw, o.seat)
      break
    case 'Table':
    // A user-placed catalog meeting pod draws as its conference table at full
    // footprint. Generated rooms stopped using this category in M1 — they are
    // real walls + Door + Table now (docs/design/testfit-pro-quality.md §2).
    case 'MeetingRoom':
      drawTable(ctx, w, h, line, o.detail, lw, o.fill, o.seat)
      break
    case 'FallCeiling':
      drawFallCeiling(ctx, w, h, line, o.detail, lw, o.selected)
      break
    case 'Door':
      drawDoor(ctx, w, h, line, o.detail, lw)
      break
    case 'Window':
      drawWindow(ctx, w, h, line, o.detail, lw)
      break
    case 'Column':
      drawColumn(ctx, w, h, line, lw)
      break
    default:
      if (o.fill) fillRoundRect(ctx, -w / 2, -h / 2, w, h, Math.min(4, Math.min(w, h) * 0.14), o.fill)
      strokeRoundRect(ctx, -w / 2, -h / 2, w, h, Math.min(4, Math.min(w, h) * 0.14), line, lw)
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

// Desk workstation: a solid worktop + monitor on the back edge + keyboard + a
// task chair in front. "Back" is -y (top in local space), the user sits toward
// +y. Detail scales with size so an overview-zoom desk still reads (worktop +
// chair) instead of degrading to a hollow pill.
function drawDesk(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  fill?: string,
  seatFill?: string,
): void {
  const L = -w / 2
  const T = -h / 2
  const B = h / 2

  // The chair sits in front and overhangs the worktop slightly, so the desk
  // occupies the back ~68% of the footprint.
  const deskB = T + h * 0.68
  const dR = Math.min(3, h * 0.08)
  if (fill) fillRoundRect(ctx, L, T, w, deskB - T, dR, fill)
  strokeRoundRect(ctx, L, T, w, deskB - T, dR, line, lw)

  const minDim = Math.min(w, h)

  // Monitor: a solid dark bar centered on the back edge reads as a screen at a
  // glance; a tiny stand tick joins it to the worktop.
  const monW = Math.min(w * 0.4, 34)
  const monH = Math.max(2.4, h * 0.1)
  const monY = T + h * 0.06
  ctx.fillStyle = line
  ctx.strokeStyle = line
  ctx.lineWidth = lw
  fillRoundRect(ctx, -monW / 2, monY, monW, monH, Math.min(1.5, monH * 0.4), line)
  ctx.beginPath()
  ctx.moveTo(0, monY + monH)
  ctx.lineTo(0, monY + monH + Math.min(3, h * 0.05))
  ctx.stroke()

  // Keyboard: a thin rounded rect on the worktop in front of the monitor (only
  // when the desk is large enough to carry the extra line without clutter).
  const kbW = Math.min(w * 0.46, 36)
  const kbH = Math.max(2, h * 0.06)
  if (kbW > 12 && minDim > 22) {
    strokeRoundRect(ctx, -kbW / 2, deskB - kbH - h * 0.07, kbW, kbH, kbH * 0.4, detail, lw * 0.9)
  }

  // Task chair in front: filled seat + curved backrest hugging the desk edge.
  const seat = Math.min(w * 0.46, (B - deskB) * 1.5, h * 0.44)
  if (seat > 4) {
    const seatT = B - seat
    const sR = seat * 0.24
    if (seatFill) fillRoundRect(ctx, -seat / 2, seatT, seat, seat, sR, seatFill)
    strokeRoundRect(ctx, -seat / 2, seatT, seat, seat, sR, line, lw)
    ctx.strokeStyle = line
    ctx.lineWidth = lw
    // backrest arc between the seat and the desk (opens toward the desk, -y)
    ctx.beginPath()
    ctx.arc(0, seatT + seat * 0.08, seat * 0.6, Math.PI * 1.15, Math.PI * 1.85)
    ctx.stroke()
    // short armrests down each side of the seat (skip on small desks)
    if (minDim > 22) {
      const ax = seat * 0.5 + seat * 0.08
      ctx.strokeStyle = detail
      ctx.beginPath()
      ctx.moveTo(-ax, seatT + seat * 0.28)
      ctx.lineTo(-ax, seatT + seat * 0.78)
      ctx.moveTo(ax, seatT + seat * 0.28)
      ctx.lineTo(ax, seatT + seat * 0.78)
      ctx.stroke()
    }
  }
}

// Task chair top view: filled rounded seat + curved backrest (top) + armrests.
function drawChair(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  seatFill?: string,
): void {
  const sw = w * 0.7
  const sh = h * 0.64
  const T = -h / 2
  const seatT = T + h * 0.26
  const sR = Math.min(sw, sh) * 0.24
  // seat (filled so it reads as an object, not a wire outline)
  if (seatFill) fillRoundRect(ctx, -sw / 2, seatT, sw, sh, sR, seatFill)
  strokeRoundRect(ctx, -sw / 2, seatT, sw, sh, sR, line, lw)
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

// Meeting table: a solid rounded-rect top + small filled chair rects around the
// perimeter. Chair count scales with the long side.
function drawTable(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  fill?: string,
  seatFill?: string,
): void {
  const inset = Math.min(w, h) * 0.2
  const tw = w - inset * 2
  const th = h - inset * 2
  const tR = Math.min(tw, th) * 0.18
  if (fill) fillRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, fill)
  strokeRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, line, lw)

  // chairs along the two long edges — count from long-side length
  const longIsW = w >= h
  const longLen = longIsW ? tw : th
  const perSide = clampInt(Math.round(longLen / 22), 2, 3)
  const chair = Math.min(inset * 0.85, (longLen / perSide) * 0.6)
  const chSeat = seatFill ?? detail
  if (chair > 4) {
    for (let i = 0; i < perSide; i++) {
      const t = (i + 0.5) / perSide - 0.5 // -0.5..0.5
      if (longIsW) {
        chairRect(ctx, t * tw, -h / 2 + inset * 0.42, chair, inset * 0.7, line, lw, chSeat)
        chairRect(ctx, t * tw, h / 2 - inset * 0.42, chair, inset * 0.7, line, lw, chSeat)
      } else {
        chairRect(ctx, -w / 2 + inset * 0.42, t * th, inset * 0.7, chair, line, lw, chSeat)
        chairRect(ctx, w / 2 - inset * 0.42, t * th, inset * 0.7, chair, line, lw, chSeat)
      }
    }
    // one chair at each short end for a 4–6 total on larger tables
    if (Math.min(w, h) > 40) {
      if (longIsW) {
        chairRect(ctx, -w / 2 + inset * 0.42, 0, inset * 0.7, chair, line, lw, chSeat)
        chairRect(ctx, w / 2 - inset * 0.42, 0, inset * 0.7, chair, line, lw, chSeat)
      } else {
        chairRect(ctx, 0, -h / 2 + inset * 0.42, chair, inset * 0.7, line, lw, chSeat)
        chairRect(ctx, 0, h / 2 - inset * 0.42, chair, inset * 0.7, line, lw, chSeat)
      }
    }
  }
}

// Door plan symbol: opening jambs + leaf shown open 90° + quarter swing arc.
// Local frame: the footprint spans the opening along x (hinge at -w/2), the
// thin h is the leaf slab in the wall; the swing draws toward -y.
function drawDoor(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const hx = -w / 2 // hinge
  ctx.strokeStyle = line
  ctx.lineWidth = lw
  // jamb ticks at both ends of the opening
  ctx.beginPath()
  ctx.moveTo(hx, -h / 2)
  ctx.lineTo(hx, h / 2)
  ctx.moveTo(w / 2, -h / 2)
  ctx.lineTo(w / 2, h / 2)
  ctx.stroke()
  // leaf line: hinge → open position (perpendicular to the wall)
  ctx.beginPath()
  ctx.moveTo(hx, 0)
  ctx.lineTo(hx, -w)
  ctx.stroke()
  // quarter-circle swing arc from the leaf tip back to the far jamb
  ctx.strokeStyle = detail
  ctx.beginPath()
  ctx.arc(hx, 0, w, -Math.PI / 2, 0)
  ctx.stroke()
}

// Window plan symbol: triple parallel lines (frame–glass–frame) across the
// footprint with end caps closing the in-wall break.
function drawWindow(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
): void {
  const L = -w / 2
  const R = w / 2
  ctx.strokeStyle = line
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.moveTo(L, -h / 2)
  ctx.lineTo(R, -h / 2)
  ctx.moveTo(L, h / 2)
  ctx.lineTo(R, h / 2)
  ctx.moveTo(L, -h / 2)
  ctx.lineTo(L, h / 2)
  ctx.moveTo(R, -h / 2)
  ctx.lineTo(R, h / 2)
  ctx.stroke()
  // center glazing line
  ctx.strokeStyle = detail
  ctx.beginPath()
  ctx.moveTo(L, 0)
  ctx.lineTo(R, 0)
  ctx.stroke()
}

// Structural column: outlined rect with 45° hatch poché.
function drawColumn(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  lw: number,
): void {
  const L = -w / 2
  const T = -h / 2
  ctx.strokeStyle = line
  ctx.lineWidth = lw
  ctx.strokeRect(L, T, w, h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(L, T, w, h)
  ctx.clip()
  ctx.lineWidth = lw * 0.7
  ctx.beginPath()
  const step = Math.max(3, Math.min(w, h) / 4)
  for (let x = L - h; x < L + w; x += step) {
    ctx.moveTo(x, T + h)
    ctx.lineTo(x + h, T)
  }
  ctx.stroke()
  ctx.restore()
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

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

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
  roundRectPath(ctx, x, y, w, h, r)
  ctx.strokeStyle = stroke
  ctx.lineWidth = lw
  ctx.stroke()
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
): void {
  roundRectPath(ctx, x, y, w, h, r)
  ctx.fillStyle = fill
  ctx.fill()
}

// A small chair rectangle centered at (cx,cy) — filled seat + outline.
function chairRect(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  stroke: string,
  lw: number,
  fill?: string,
): void {
  const r = Math.min(w, h) * 0.25
  if (fill) fillRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, r, fill)
  strokeRoundRect(ctx, cx - w / 2, cy - h / 2, w, h, r, stroke, lw)
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
