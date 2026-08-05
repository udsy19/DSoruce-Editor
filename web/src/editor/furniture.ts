import { strokePx, detailLevel } from './planStyle'
// Top-view CAD furniture line-symbols for the 2D generative canvas.
//
// Each symbol is drawn in LOCAL coordinates centered at (0,0) spanning
// ±w/2 × ±h/2, after we translate to the component's screen center and
// rotate. Symbols are thin single-weight line-work (no heavy fills) so they
// read like a Rayon/Revit/Laiout plan rather than solid blocks.
//
// Level-of-detail is CONTINUOUS (see planStyle `LOD`): a symbol crossfades from
// a chip to full detail across a size band, rather than snapping at one
// threshold where every symbol in the plan popped at the same instant.

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

// Categories that keep their symbol at any size: FallCeiling is a grid over a
// large footprint; Door/Window footprints are thin slabs (~0.15 m deep) whose
// symbols (swing arc / glazing lines) must always draw.
const ALWAYS_DETAIL = new Set(['FallCeiling', 'Door', 'Window'])

export function drawFurnitureSymbol(ctx: CanvasRenderingContext2D, o: FurnitureOpts): void {
  const { cx, cy, w, h, rotation } = o
  const line = o.selected ? o.accent : o.stroke
  // The ladder's base tier. These were 1.35 / 1.8 hand-set, which put furniture
  // ABOVE the wall tier (0.8) — the hierarchy inverted, the densest mark on the
  // page also the heaviest. Selection steps one tier, not off the ladder.
  const lw = o.selected ? strokePx('detail', 0) : strokePx('furniture', 0)
  const detail = detailLevel(Math.min(w, h))

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rotation)
  // Hinge handedness: reflect across the local long (x) axis. A door's leaf+arc
  // flip to the other side of the opening; symmetric symbols are unaffected.
  if (o.mirror) ctx.scale(1, -1)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const always = ALWAYS_DETAIL.has(o.category)
  // CROSSFADE. Below the band it is a chip; above it, a symbol; between, both
  // are drawn with complementary alpha so no frame ever jumps. Symbols cross the
  // band at different zooms because they differ in size, which is what stops the
  // whole canvas changing at once.
  if (!always && detail < 1) {
    const r = Math.min(3, Math.min(w, h) * 0.2)
    ctx.save()
    ctx.globalAlpha = 1 - detail
    if (o.fill) fillRoundRect(ctx, -w / 2, -h / 2, w, h, r, o.fill)
    strokeRoundRect(ctx, -w / 2, -h / 2, w, h, r, line, lw)
    ctx.restore()
    if (detail <= 0.001) {
      ctx.restore()
      return
    }
    ctx.globalAlpha = detail
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
    case 'Furniture':
      drawCasework(ctx, w, h, line, o.detail, lw, o.fill)
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

  // Task chair in front, tucked under the worktop edge. Its backrest sits toward
  // -y (against the desk), so it reads as "someone seated at this desk". The same
  // contoured primitive as the standalone Chair keeps the plan coherent.
  const seat = Math.min(w * 0.46, (B - deskB) * 1.5, h * 0.44)
  if (seat > 4) {
    // Centre the chair in the front band; a small overlap tucks its back under
    // the worktop rather than floating a gap.
    const cy = deskB + seat * 0.5 - seat * 0.12
    taskChair(ctx, 0, cy, seat, line, detail, lw, seatFill, minDim > 22)
  }
}

// Task chair top view: a contoured, oriented seat + backrest cushion (+ arms
// where scale allows). Drawn via the shared `taskChair` primitive so a standalone
// chair, a desk's tucked chair, and every seat around a conference table all read
// as the same recognisable object. Backrest sits toward local -y ("faces" +y).
function drawChair(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  seatFill?: string,
): void {
  const s = Math.min(w, h)
  taskChair(ctx, 0, 0, s, line, detail, lw, seatFill, s > 24)
}

// Conference / meeting table: a solid table top (a racetrack/stadium for larger
// elongated boardroom tables, a soft rounded-rect for small square ones) with
// contoured task chairs evenly arranged around the perimeter, each facing the
// table. Seat count scales with the table's dimensions.
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
  // A chairs-gap ring around the top so seats sit clear of the footprint edge.
  const inset = Math.min(w, h) * 0.17
  const tw = w - inset * 2
  const th = h - inset * 2
  const longIsW = tw >= th
  const longLen = longIsW ? tw : th
  const shortLen = longIsW ? th : tw
  // Racetrack ends when the table is large and clearly elongated (boardroom);
  // otherwise a gently rounded rectangle (small huddle / meeting table).
  const stadium = Math.min(w, h) > 34 && longLen / shortLen > 1.5
  const tR = stadium ? shortLen / 2 : Math.min(tw, th) * 0.22
  if (fill) fillRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, fill)
  strokeRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, line, lw)

  // Seat size + count: pitch the long-side chairs ~26px apart, seat sized to the
  // gap ring so it tucks against the table without overrunning the footprint.
  const perSide = clampInt(Math.round(longLen / 26), 2, 4)
  const cs = Math.min(inset * 1.2, (longLen / perSide) * 0.66)
  if (cs <= 4) return
  const arms = cs > 26
  // Seat-centre distance from the table centre-line on each long edge (tucked in).
  const longOff = shortLen / 2 + cs * 0.3
  const endOff = longLen / 2 + cs * 0.3

  for (let i = 0; i < perSide; i++) {
    const t = ((i + 0.5) / perSide - 0.5) * longLen // position along the long axis
    if (longIsW) {
      seatAt(ctx, t, -longOff, cs, 0, line, detail, lw, seatFill, arms) // top edge
      seatAt(ctx, t, longOff, cs, Math.PI, line, detail, lw, seatFill, arms) // bottom
    } else {
      seatAt(ctx, -longOff, t, cs, -Math.PI / 2, line, detail, lw, seatFill, arms) // left
      seatAt(ctx, longOff, t, cs, Math.PI / 2, line, detail, lw, seatFill, arms) // right
    }
  }
  // A head chair at each short end once the table is big enough to seat one.
  if (shortLen > cs * 1.3) {
    if (longIsW) {
      seatAt(ctx, -endOff, 0, cs, -Math.PI / 2, line, detail, lw, seatFill, arms)
      seatAt(ctx, endOff, 0, cs, Math.PI / 2, line, detail, lw, seatFill, arms)
    } else {
      seatAt(ctx, 0, -endOff, cs, 0, line, detail, lw, seatFill, arms)
      seatAt(ctx, 0, endOff, cs, Math.PI, line, detail, lw, seatFill, arms)
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
  ctx.lineWidth = strokePx('furniture', 0)
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

// A contoured top-view task chair centred at (cx,cy) in the CURRENT transform,
// sized `s` (seat footprint), with the backrest toward local -y (so it "faces"
// +y). Layered — arms under the seat, seat cushion, then the backrest cushion on
// top — so it reads as a real chair, not a wire outline. `seatFill` undefined
// (passive reference furniture) draws outline-only so the piece recedes.
function taskChair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  line: string,
  detail: string,
  lw: number,
  seatFill: string | undefined,
  arms: boolean,
): void {
  const top = cy - s / 2
  // Armrests: slim cushions flanking the seat (drawn first, so the seat overlaps).
  if (arms) {
    const armW = s * 0.13
    const armH = s * 0.5
    const armY = top + s * 0.24
    const ax = s * 0.4 + armW * 0.5
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * ax - armW / 2
      if (seatFill) fillRoundRect(ctx, x, armY, armW, armH, armW * 0.45, seatFill)
      strokeRoundRect(ctx, x, armY, armW, armH, armW * 0.45, detail, lw * 0.9)
    }
  }
  // Seat cushion — the rounded body the sitter rests on.
  const seatW = s * 0.8
  const seatH = s * 0.62
  const seatY = top + s * 0.26
  if (seatFill) fillRoundRect(ctx, cx - seatW / 2, seatY, seatW, seatH, seatH * 0.32, seatFill)
  strokeRoundRect(ctx, cx - seatW / 2, seatY, seatW, seatH, seatH * 0.32, line, lw)
  // Backrest cushion — a wider pill across the back, over the seat's top edge.
  const brW = s * 0.92
  const brH = s * 0.26
  if (seatFill) fillRoundRect(ctx, cx - brW / 2, top, brW, brH, brH * 0.5, seatFill)
  strokeRoundRect(ctx, cx - brW / 2, top, brW, brH, brH * 0.5, line, lw)
}

// Place a task chair at (x,y) rotated by `angle` (so its backrest points outward,
// away from a table). Kept cheap — a single save/rotate per seat, and tables are
// few, so the whole plan still redraws in one frame.
function seatAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  angle: number,
  line: string,
  detail: string,
  lw: number,
  seatFill: string | undefined,
  arms: boolean,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  taskChair(ctx, 0, 0, s, line, detail, lw, seatFill, arms)
  ctx.restore()
}

// Casework / credenza / storage (the neutral 'Furniture' catch-all): a tidy body
// with evenly divided drawer/door fronts + a front-lip line for depth. Reads as
// architectural casework rather than a blank box. `fill` undefined → outline-only
// so passive reference casework recedes.
function drawCasework(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  detail: string,
  lw: number,
  fill?: string,
): void {
  const L = -w / 2
  const T = -h / 2
  const r = Math.min(3, Math.min(w, h) * 0.12)
  if (fill) fillRoundRect(ctx, L, T, w, h, r, fill)
  strokeRoundRect(ctx, L, T, w, h, r, line, lw)

  // Compartment seams divide the long axis into drawer/door fronts.
  const long = Math.max(w, h)
  const n = clampInt(Math.round(long / 20), 1, 5)
  ctx.strokeStyle = detail
  ctx.lineWidth = lw * 0.85
  ctx.beginPath()
  if (w >= h) {
    for (let i = 1; i < n; i++) {
      const x = L + (w * i) / n
      ctx.moveTo(x, T + h * 0.16)
      ctx.lineTo(x, T + h * 0.84)
    }
    // front-lip line along the near (bottom) edge
    ctx.moveTo(L + w * 0.06, T + h * 0.84)
    ctx.lineTo(L + w * 0.94, T + h * 0.84)
  } else {
    for (let i = 1; i < n; i++) {
      const y = T + (h * i) / n
      ctx.moveTo(L + w * 0.16, y)
      ctx.lineTo(L + w * 0.84, y)
    }
    ctx.moveTo(L + w * 0.84, T + h * 0.06)
    ctx.lineTo(L + w * 0.84, T + h * 0.94)
  }
  ctx.stroke()
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
