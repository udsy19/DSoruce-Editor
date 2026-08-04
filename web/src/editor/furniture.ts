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
      drawDesk(ctx, w, h, line, o.detail, lw, o.fill)
      break
    case 'Chair':
      drawChair(ctx, w, h, line, o.detail, lw, o.seat)
      break
    case 'Table':
    // A user-placed catalog meeting pod draws as its conference table at full
    // footprint. Generated rooms stopped using this category in M1 — they are
    // real walls + Door + Table now (docs/design/testfit-pro-quality.md §2).
    case 'MeetingRoom':
      drawTable(ctx, w, h, line, lw, o.fill)
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

// Desk workstation: a solid worktop + monitor on the back edge + keyboard.
// "Back" is -y (top in local space), the user sits toward +y — which is the side
// `layout::seat_desk_chairs` puts the desk's REAL `Chair` component on.
//
// NO IMPLIED SEAT. Every generated desk carries its own task chair as a real
// component, drawn by `drawChair` and billed in the Furniture Inventory, so
// drawing one here too would ink the same chair twice and — worse — make the
// plan show seating the takeoff does not bill.
function drawDesk(
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

  // The seated user's chair overhangs the worktop, so the desk itself occupies
  // the back ~68% of the footprint (the chair component tucks into the rest).
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
}

// Task chair top view: a contoured, oriented seat + backrest cushion (+ arms
// where scale allows). THE ONLY seat symbol in the plan — a workstation's chair,
// a cabin's chair and every seat around a meeting table are all real `Chair`
// components and all arrive here, so every seat you can see is a seat the
// Furniture Inventory bills. Backrest sits toward local -y ("faces" +y), which
// is the convention `layout.rs` orients every chair it emits to.
// Layered — arms under the seat, seat cushion, then the backrest cushion on top
// — so it reads as a real chair, not a wire outline. `seatFill` undefined
// (passive reference furniture) draws outline-only so the piece recedes.
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
  const arms = s > 24
  const top = -s / 2
  // Armrests: slim cushions flanking the seat (drawn first, so the seat overlaps).
  if (arms) {
    const armW = s * 0.13
    const armH = s * 0.5
    const armY = top + s * 0.24
    const ax = s * 0.4 + armW * 0.5
    for (const sgn of [-1, 1]) {
      const x = sgn * ax - armW / 2
      if (seatFill) fillRoundRect(ctx, x, armY, armW, armH, armW * 0.45, seatFill)
      strokeRoundRect(ctx, x, armY, armW, armH, armW * 0.45, detail, lw * 0.9)
    }
  }
  // Seat cushion — the rounded body the sitter rests on.
  const seatW = s * 0.8
  const seatH = s * 0.62
  const seatY = top + s * 0.26
  if (seatFill) fillRoundRect(ctx, -seatW / 2, seatY, seatW, seatH, seatH * 0.32, seatFill)
  strokeRoundRect(ctx, -seatW / 2, seatY, seatW, seatH, seatH * 0.32, line, lw)
  // Backrest cushion — a wider pill across the back, over the seat's top edge.
  const brW = s * 0.92
  const brH = s * 0.26
  if (seatFill) fillRoundRect(ctx, -brW / 2, top, brW, brH, brH * 0.5, seatFill)
  strokeRoundRect(ctx, -brW / 2, top, brW, brH, brH * 0.5, line, lw)
}

// Conference / meeting table: the table TOP alone — a racetrack/stadium for
// larger elongated boardroom tables, a soft rounded-rect for small square ones.
//
// NO IMPLIED SEATING. This symbol used to ring itself with chairs pitched in
// SCREEN pixels, which meant the plan and the room thumbnails drew ~8 chairs per
// meeting room that no sheet could bill (the count existed only in the
// renderer's transform, and nothing in the model matched it). Meeting, team,
// boardroom and collaboration tables are now seated by real `Chair` components
// from `layout::seat_around_table`, drawn by `drawChair` — so the seats on the
// plan, the seats in the Furniture Inventory and the room's `Headcount` are the
// same seats.
function drawTable(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  line: string,
  lw: number,
  fill?: string,
): void {
  // The top is drawn at the component's TRUE footprint. It used to be inset 17%
  // to leave a ring for the implied chairs; with the seats gone that inset only
  // under-drew the table and left the real chairs looking detached from it.
  const tw = w
  const th = h
  const longLen = Math.max(tw, th)
  const shortLen = Math.min(tw, th)
  // Racetrack ends when the table is large and clearly elongated (boardroom);
  // otherwise a gently rounded rectangle (small huddle / meeting table).
  const stadium = Math.min(w, h) > 34 && longLen / shortLen > 1.5
  const tR = stadium ? shortLen / 2 : Math.min(tw, th) * 0.22
  if (fill) fillRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, fill)
  strokeRoundRect(ctx, -tw / 2, -th / 2, tw, th, tR, line, lw)
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
