// Top-view CAD symbols — the ONE symbol vocabulary, shared by every surface that
// draws a plan: the editor canvas, the imported-drawing canvas, and the PDF/print
// renderer. Design: docs/design/ui-system.md §3.
//
// This module replaces the old `furniture.ts`, whose geometry was specified in
// SCREEN pixels. That made a symbol's *content* a function of the zoom level:
// fifteen thresholds decided whether to draw a keyboard, how many drawer seams a
// credenza had, how many tiles a ceiling had, whether a table was a rectangle or
// a racetrack — and, worst, how many chairs sat around it. A single real 1.2×0.6 m
// table drew 0 chairs at 20 px/m, 6 at 45, 8 at 70 and 10 at 110, while the room
// tag above it said "9 pax". The drawing contradicted itself at every zoom but one.
//
// THE TWO RULES THAT REPLACE ALL OF THAT
//
//   1. WORLD vs SCREEN — the printed-sheet test. If it would be printed on the
//      drawing at 1:100 it is specified in METRES and scales with zoom: every
//      footprint, every internal detail, every spacing. If it would be printed on
//      the sheet AROUND the drawing (labels, chips, pins, grips) it is screen
//      space — and it does not live in this module at all. The only screen-space
//      quantity here is STROKE WEIGHT, which is a pen, not a thing.
//
//   2. COUNTABLES COME FROM THE OBJECT. Seat count is read from `spec.seats`,
//      resolved once in the core by `model::seats_for` (ui-system.md §3.6) and
//      carried on the component. Drawer, tile and hatch counts derive from world
//      dimensions at fixed real-world pitches. Nothing countable is ever a
//      function of how far the user has scrolled the wheel.
//
// Level of detail is a CONTINUOUS FADE, never a switch: fine detail ramps its
// alpha across a band of projected size, so nothing pops when the user zooms.
// Because it fades rather than toggles, wiggling the wheel at a boundary produces
// a smooth alpha ramp instead of a flicker — the band is the hysteresis.

/** Everything the module needs to know about the view. No component state. */
export interface View {
  /** Pixels per metre — the ONLY thing that converts world to screen. */
  pxPerM: number
  /** Device pixel ratio, so hairlines land on physical pixels. */
  dpr: number
}

/** Canvas ink. A closed, data-driven palette (ui-system.md §4.1.1) — the UI
 *  accent token never appears here; `accent` is the canvas "live" colour. */
export interface Ink {
  /** Primary linework. */
  stroke: string
  /** Secondary linework (seams, glazing centre-lines, keyboard). */
  detail: string
  /** Body fill for worktops/tables. Undefined → outline only, so passive
   *  reference furniture recedes into context. */
  fill?: string
  /** Seat/upholstery fill. Undefined → outline only. */
  seat?: string
  /** Live selection/hover. */
  accent: string
}

/** A symbol to draw, specified entirely in WORLD units. */
export interface SymbolSpec {
  category: string
  /** Centre, in SCREEN pixels — the caller owns the world→screen transform
   *  (and its Y convention), so this module never needs to know about it. */
  cx: number
  cy: number
  /** Footprint in METRES. */
  w: number
  h: number
  /** Radians, in the caller's screen frame. */
  rotation: number
  /** Reflect across the local long axis — a door's hinge handedness. */
  mirror?: boolean
  /** How many people sit at this object. FROM THE MODEL (`Component.seats`),
   *  never derived here. Undefined → fall back to the world-size rule, which is
   *  the same formula the core uses, so an un-migrated snapshot still renders a
   *  zoom-stable count rather than a screen-size guess. */
  seats?: number
  /**
   * Draw the glyph's IMPLIED seating (a desk's tucked task chair, a table's
   * ring of chairs)?
   *
   * True everywhere by default, because on the editor and import canvases the
   * implied seats are the only seating shown — nothing else draws them.
   *
   * FALSE on the print path. There, real `Chair` components are drawn as their
   * own glyphs beside the desk or table they serve, so drawing implied seats too
   * would ink the same chair twice and put seating on a graded sheet that the
   * Furniture Inventory does not bill. This is a fact about the CONSUMER, not
   * about the symbol: `pdf.ts` is the one caller where billed-equals-drawn is a
   * premise, so it is the one caller that turns this off.
   */
  implySeats?: boolean
  selected?: boolean
}

// ---------------------------------------------------------------------------
// Pens — the only screen-space quantity in this module
// ---------------------------------------------------------------------------

/** Architect's pen set, in DEVICE pixels. A drawing is drawn with a few discrete
 *  weights, not a continuous function of scale. */
export const PEN = { hair: 1, thin: 1.5, med: 2, thick: 3 } as const
export type PenWeight = keyof typeof PEN

/** A pen weight as a CSS-pixel `lineWidth` that lands exactly on the device
 *  pixel grid, so a hairline is one crisp physical pixel at DPR 1 and DPR 2
 *  alike (the old fixed 1.35 / 1.6 straddled the grid at both, which is why
 *  hairlines read as a soft grey smear). */
export function pen(weight: PenWeight, dpr: number): number {
  return Math.max(1, Math.round(PEN[weight] * dpr)) / dpr
}

// ---------------------------------------------------------------------------
// Continuous level of detail
// ---------------------------------------------------------------------------

/** Detail bands, in projected pixels of a symbol's smaller world dimension.
 *  `exit` = fully invisible at or below; `enter` = fully drawn at or above. */
const BAND = {
  /** Chairs, monitor, table-top inset: the things that make it read as furniture. */
  primary: { exit: 9, enter: 20 },
  /** Keyboard, drawer seams, armrests, ceiling tiles: grace notes. */
  fine: { exit: 22, enter: 42 },
} as const

/** 0 → 1 ramp across a band. Linear, so detail dissolves rather than popping. */
export function lod(sizePx: number, band: { exit: number; enter: number }): number {
  if (sizePx <= band.exit) return 0
  if (sizePx >= band.enter) return 1
  return (sizePx - band.exit) / (band.enter - band.exit)
}

// ---------------------------------------------------------------------------
// World-space constants — real dimensions, in metres
// ---------------------------------------------------------------------------

/** Centre-to-centre spacing of seated people. Mirrors `model::SEAT_PITCH_M` —
 *  an UNAVOIDABLE mirror (a canvas frame can't await a wasm call per glyph) and
 *  therefore a GUARDED one: `src/coreParity.test.mjs` parses the value out of
 *  `model.rs` and fails on divergence. Do not edit one side alone. */
const SEAT_PITCH_M = 0.65
/** A table end narrower than this seats nobody across it. Mirrors
 *  `model::HEAD_SEAT_MIN_M`; same guard. */
const HEAD_SEAT_MIN_M = 0.8
/** Chair footprint. */
const SEAT_M = 0.5
/** Clear ring between a table's edge and the footprint, where chairs tuck. */
const CHAIR_RING_M = 0.35
/** Monitor: width and depth on the worktop. */
const MONITOR_W_M = 0.45
const MONITOR_D_M = 0.045
/** Keyboard. */
const KEYBOARD_W_M = 0.42
const KEYBOARD_D_M = 0.14
/** One drawer/door front per this much casework run. */
const DRAWER_PITCH_M = 0.45
/** Suspended-ceiling module. */
const CEILING_TILE_M = 0.6
/** Poché hatch spacing on a column. */
const HATCH_PITCH_M = 0.15
/** A table longer than this, and proportioned like this, gets racetrack ends.
 *  A fact about the table — not about the zoom. */
const STADIUM_MIN_LONG_M = 2.4
const STADIUM_MIN_RATIO = 1.5

/** Seats a table of this WORLD size provides. The exact mirror of the core's
 *  `model::seats_for`, used only when a component predates the `seats` facet. */
export function seatsForSize(category: string, w: number, h: number): number {
  if (category === 'Desk' || category === 'Chair') return 1
  if (category !== 'Table' && category !== 'MeetingRoom') return 0
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (!(long > 0) || !(short > 0)) return 0
  return Math.floor(long / SEAT_PITCH_M) * 2 + (short >= HEAD_SEAT_MIN_M ? 2 : 0)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function drawSymbol(ctx: CanvasRenderingContext2D, s: SymbolSpec, ink: Ink, v: View): void {
  const W = s.w * v.pxPerM
  const H = s.h * v.pxPerM
  if (!(W > 0) || !(H > 0)) return
  const line = s.selected ? ink.accent : ink.stroke
  // Selected draws one pen heavier — a weight step, not an arbitrary bump.
  const lw = pen(s.selected ? 'med' : 'thin', v.dpr)
  const hair = pen('hair', v.dpr)
  const minPx = Math.min(W, H)
  const a1 = lod(minPx, BAND.primary)
  const a2 = lod(minPx, BAND.fine)

  ctx.save()
  ctx.translate(s.cx, s.cy)
  ctx.rotate(s.rotation)
  if (s.mirror) ctx.scale(1, -1)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  const g: G = { ctx, v, ink, line, lw, hair, a1, a2, implySeats: s.implySeats !== false }

  switch (s.category) {
    case 'Desk':
      desk(g, s.w, s.h)
      break
    case 'Chair':
      chairSymbol(g, s.w, s.h)
      break
    case 'Table':
    case 'MeetingRoom':
      table(g, s.w, s.h, s.seats ?? seatsForSize(s.category, s.w, s.h))
      break
    case 'Furniture':
      casework(g, s.w, s.h)
      break
    case 'FallCeiling':
      fallCeiling(g, s.w, s.h)
      break
    case 'Door':
      door(g, s.w, s.h)
      break
    case 'Window':
      windowSymbol(g, s.w, s.h)
      break
    case 'Column':
      column(g, s.w, s.h)
      break
    default:
      body(g, s.w, s.h)
  }

  ctx.restore()
}

/** Draw context threaded through the symbol functions. All symbol geometry is
 *  authored in METRES and converted with `g.v.pxPerM` at the last moment. */
interface G {
  ctx: CanvasRenderingContext2D
  v: View
  ink: Ink
  line: string
  lw: number
  hair: number
  /** Primary-detail alpha (chairs, monitor). */
  a1: number
  /** Fine-detail alpha (keyboard, seams, tiles). */
  a2: number
  /** Draw implied seating? See {@link SymbolSpec.implySeats}. */
  implySeats: boolean
}

const px = (g: G, m: number) => m * g.v.pxPerM

// ---------------------------------------------------------------------------
// Symbols — every dimension below is in METRES
// ---------------------------------------------------------------------------

/** Neutral body: a soft-cornered footprint. The floor every symbol stands on,
 *  and the whole symbol for an unrecognised category. */
function body(g: G, w: number, h: number): void {
  const r = Math.min(0.04, Math.min(w, h) * 0.14)
  roundRect(g, -w / 2, -h / 2, w, h, r)
  if (g.ink.fill) {
    g.ctx.fillStyle = g.ink.fill
    g.ctx.fill()
  }
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()
}

/** Workstation: worktop across the back, monitor + keyboard on it, task chair in
 *  front. "Back" is local −y; the user sits toward +y. */
function desk(g: G, w: number, h: number): void {
  const T = -h / 2
  const B = h / 2
  // The chair occupies the front band, so the worktop takes the back ~68%.
  const deskD = h * 0.68
  const r = Math.min(0.03, deskD * 0.12)
  roundRect(g, -w / 2, T, w, deskD, r)
  if (g.ink.fill) {
    g.ctx.fillStyle = g.ink.fill
    g.ctx.fill()
  }
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()

  // Monitor — a real 0.45 m screen on the back edge, not a px-clamped bar.
  if (g.a1 > 0) {
    g.ctx.save()
    g.ctx.globalAlpha = g.a1
    const mw = Math.min(MONITOR_W_M, w * 0.6)
    const my = T + h * 0.06
    roundRect(g, -mw / 2, my, mw, MONITOR_D_M, MONITOR_D_M * 0.4)
    g.ctx.fillStyle = g.line
    g.ctx.fill()
    g.ctx.strokeStyle = g.line
    g.ctx.lineWidth = g.hair
    g.ctx.beginPath()
    g.ctx.moveTo(0, px(g, my + MONITOR_D_M))
    g.ctx.lineTo(0, px(g, my + MONITOR_D_M + 0.06))
    g.ctx.stroke()
    g.ctx.restore()
  }

  // Keyboard — fine detail.
  if (g.a2 > 0) {
    g.ctx.save()
    g.ctx.globalAlpha = g.a2
    const kw = Math.min(KEYBOARD_W_M, w * 0.7)
    roundRect(g, -kw / 2, T + deskD - KEYBOARD_D_M - h * 0.05, kw, KEYBOARD_D_M, KEYBOARD_D_M * 0.35)
    g.ctx.strokeStyle = g.ink.detail
    g.ctx.lineWidth = g.hair
    g.ctx.stroke()
    g.ctx.restore()
  }

  // Task chair, tucked under the worktop edge, facing the desk.
  // NOT gated on `seats` — a desk's chair is part of the desk glyph, which is
  // why passing seats: 0 would not have suppressed it.
  if (g.a1 > 0 && g.implySeats) {
    const seat = Math.min(SEAT_M, w * 0.62, (B - (T + deskD)) * 1.5)
    if (seat > 0.1) {
      g.ctx.save()
      g.ctx.globalAlpha = g.a1
      taskChair(g, 0, T + deskD + seat * 0.38, seat)
      g.ctx.restore()
    }
  }
}

function chairSymbol(g: G, w: number, h: number): void {
  taskChair(g, 0, 0, Math.min(w, h))
}

/**
 * Conference / meeting table: a top with a chair ring.
 *
 * `seats` is the model's count. This function decides only WHERE those seats go,
 * from the table's world proportions — so both the number and the arrangement are
 * identical at every zoom level. Long sides fill first at the real seat pitch;
 * whatever is left goes to the ends.
 */
function table(g: G, w: number, h: number, seats: number): void {
  // Top, inset by the ring the chairs tuck into.
  const ring = Math.min(CHAIR_RING_M, Math.min(w, h) * 0.22)
  const tw = Math.max(w - ring * 2, w * 0.4)
  const th = Math.max(h - ring * 2, h * 0.4)
  const longIsW = tw >= th
  const longLen = longIsW ? tw : th
  const shortLen = longIsW ? th : tw
  // Racetrack ends are a fact about the TABLE's real proportions.
  const stadium = longLen >= STADIUM_MIN_LONG_M && longLen / shortLen > STADIUM_MIN_RATIO
  const r = stadium ? shortLen / 2 : Math.min(tw, th) * 0.2
  roundRect(g, -tw / 2, -th / 2, tw, th, r)
  if (g.ink.fill) {
    g.ctx.fillStyle = g.ink.fill
    g.ctx.fill()
  }
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()

  if (g.a1 <= 0 || seats <= 0 || !g.implySeats) return

  // Place EXACTLY `seats` chairs — the model's number, not a second opinion.
  // This function decides only WHERE they go: ends first (if the table is deep
  // enough to seat across), then the balance split between the two long sides,
  // packed tighter if the count demands it. Never capped by a pitch rule, because
  // a cap would silently make the drawing disagree with the model again — the
  // exact bug this whole design exists to prevent.
  const heads = shortLen >= HEAD_SEAT_MIN_M ? Math.min(2, Math.max(0, seats - 2)) : 0
  const alongTotal = seats - heads
  const sideA = Math.ceil(alongTotal / 2)
  const sideB = alongTotal - sideA
  // Shrink the seat if the long side is crowded, so chairs never overlap.
  const densest = Math.max(sideA, sideB, 1)
  const seatSize = Math.min(SEAT_M, ring * 1.3, (longLen / densest) * 0.92)
  const longOff = shortLen / 2 + seatSize * 0.42
  const endOff = longLen / 2 + seatSize * 0.42

  const alongSide = (n: number, sign: number, rot: number) => {
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n - 0.5) * longLen
      if (longIsW) seatAt(g, t, sign * longOff, seatSize, rot)
      else seatAt(g, sign * longOff, t, seatSize, rot)
    }
  }

  g.ctx.save()
  g.ctx.globalAlpha = g.a1
  alongSide(sideA, -1, longIsW ? 0 : -Math.PI / 2)
  alongSide(sideB, 1, longIsW ? Math.PI : Math.PI / 2)
  if (heads >= 1) {
    if (longIsW) seatAt(g, -endOff, 0, seatSize, -Math.PI / 2)
    else seatAt(g, 0, -endOff, seatSize, 0)
  }
  if (heads >= 2) {
    if (longIsW) seatAt(g, endOff, 0, seatSize, Math.PI / 2)
    else seatAt(g, 0, endOff, seatSize, Math.PI)
  }
  g.ctx.restore()
}

/** Casework / credenza: a body with one drawer front per DRAWER_PITCH_M of run. */
function casework(g: G, w: number, h: number): void {
  body(g, w, h)
  if (g.a2 <= 0) return
  const long = Math.max(w, h)
  const n = Math.max(1, Math.round(long / DRAWER_PITCH_M))
  if (n < 2) return
  g.ctx.save()
  g.ctx.globalAlpha = g.a2
  g.ctx.strokeStyle = g.ink.detail
  g.ctx.lineWidth = g.hair
  g.ctx.beginPath()
  if (w >= h) {
    for (let i = 1; i < n; i++) {
      const x = -w / 2 + (w * i) / n
      g.ctx.moveTo(px(g, x), px(g, -h / 2 + h * 0.16))
      g.ctx.lineTo(px(g, x), px(g, -h / 2 + h * 0.84))
    }
  } else {
    for (let i = 1; i < n; i++) {
      const y = -h / 2 + (h * i) / n
      g.ctx.moveTo(px(g, -w / 2 + w * 0.16), px(g, y))
      g.ctx.lineTo(px(g, -w / 2 + w * 0.84), px(g, y))
    }
  }
  g.ctx.stroke()
  g.ctx.restore()
}

/** Suspended ceiling: a real 600 mm tile grid. */
function fallCeiling(g: G, w: number, h: number): void {
  roundRect(g, -w / 2, -h / 2, w, h, 0.02)
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()
  if (g.a2 <= 0) return
  const cols = Math.max(1, Math.round(w / CEILING_TILE_M))
  const rows = Math.max(1, Math.round(h / CEILING_TILE_M))
  g.ctx.save()
  g.ctx.globalAlpha = g.a2
  g.ctx.strokeStyle = g.ink.detail
  g.ctx.lineWidth = g.hair
  g.ctx.beginPath()
  for (let i = 1; i < cols; i++) {
    const x = -w / 2 + (w * i) / cols
    g.ctx.moveTo(px(g, x), px(g, -h / 2))
    g.ctx.lineTo(px(g, x), px(g, h / 2))
  }
  for (let j = 1; j < rows; j++) {
    const y = -h / 2 + (h * j) / rows
    g.ctx.moveTo(px(g, -w / 2), px(g, y))
    g.ctx.lineTo(px(g, w / 2), px(g, y))
  }
  g.ctx.stroke()
  g.ctx.restore()
}

/** Door: jambs + leaf open 90° + quarter swing arc. Always drawn — a door's
 *  slab is only ~0.15 m deep, so a size-based fade would erase it entirely. */
function door(g: G, w: number, h: number): void {
  const hx = px(g, -w / 2)
  const W = px(g, w)
  const Hh = px(g, h / 2)
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.beginPath()
  g.ctx.moveTo(hx, -Hh)
  g.ctx.lineTo(hx, Hh)
  g.ctx.moveTo(px(g, w / 2), -Hh)
  g.ctx.lineTo(px(g, w / 2), Hh)
  g.ctx.stroke()
  g.ctx.beginPath()
  g.ctx.moveTo(hx, 0)
  g.ctx.lineTo(hx, -W)
  g.ctx.stroke()
  g.ctx.strokeStyle = g.ink.detail
  g.ctx.lineWidth = g.hair
  g.ctx.beginPath()
  g.ctx.arc(hx, 0, W, -Math.PI / 2, 0)
  g.ctx.stroke()
}

/** Window: the frame–glass–frame triple-line convention. Always drawn. */
function windowSymbol(g: G, w: number, h: number): void {
  const L = px(g, -w / 2)
  const R = px(g, w / 2)
  const T = px(g, -h / 2)
  const B = px(g, h / 2)
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.beginPath()
  g.ctx.moveTo(L, T)
  g.ctx.lineTo(R, T)
  g.ctx.moveTo(L, B)
  g.ctx.lineTo(R, B)
  g.ctx.moveTo(L, T)
  g.ctx.lineTo(L, B)
  g.ctx.moveTo(R, T)
  g.ctx.lineTo(R, B)
  g.ctx.stroke()
  g.ctx.strokeStyle = g.ink.detail
  g.ctx.lineWidth = g.hair
  g.ctx.beginPath()
  g.ctx.moveTo(L, 0)
  g.ctx.lineTo(R, 0)
  g.ctx.stroke()
}

/** Structural column: outline + 45° poché at a real 150 mm hatch pitch. */
function column(g: G, w: number, h: number): void {
  const L = px(g, -w / 2)
  const T = px(g, -h / 2)
  const W = px(g, w)
  const H = px(g, h)
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.strokeRect(L, T, W, H)
  if (g.a1 <= 0) return
  g.ctx.save()
  g.ctx.globalAlpha = g.a1
  g.ctx.beginPath()
  g.ctx.rect(L, T, W, H)
  g.ctx.clip()
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.hair
  g.ctx.beginPath()
  const step = px(g, HATCH_PITCH_M)
  for (let x = L - H; x < L + W; x += step) {
    g.ctx.moveTo(x, T + H)
    g.ctx.lineTo(x + H, T)
  }
  g.ctx.stroke()
  g.ctx.restore()
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Contoured top-view task chair centred at (cx,cy) METRES, footprint `s` metres,
 *  backrest toward local −y. Arms are fine detail. */
function taskChair(g: G, cx: number, cy: number, s: number): void {
  const top = cy - s / 2
  if (g.a2 > 0) {
    const armW = s * 0.13
    const armH = s * 0.5
    const armY = top + s * 0.24
    g.ctx.save()
    g.ctx.globalAlpha = g.ctx.globalAlpha * g.a2
    for (const sgn of [-1, 1]) {
      const x = cx + sgn * (s * 0.4 + armW * 0.5) - armW / 2
      roundRect(g, x, armY, armW, armH, armW * 0.45)
      if (g.ink.seat) {
        g.ctx.fillStyle = g.ink.seat
        g.ctx.fill()
      }
      g.ctx.strokeStyle = g.ink.detail
      g.ctx.lineWidth = g.hair
      g.ctx.stroke()
    }
    g.ctx.restore()
  }
  // Seat cushion.
  const seatW = s * 0.8
  const seatH = s * 0.62
  roundRect(g, cx - seatW / 2, top + s * 0.26, seatW, seatH, seatH * 0.32)
  if (g.ink.seat) {
    g.ctx.fillStyle = g.ink.seat
    g.ctx.fill()
  }
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()
  // Backrest.
  const brW = s * 0.92
  const brH = s * 0.26
  roundRect(g, cx - brW / 2, top, brW, brH, brH * 0.5)
  if (g.ink.seat) {
    g.ctx.fillStyle = g.ink.seat
    g.ctx.fill()
  }
  g.ctx.strokeStyle = g.line
  g.ctx.lineWidth = g.lw
  g.ctx.stroke()
}

/** A task chair at (x,y) METRES rotated by `angle`, backrest outward. */
function seatAt(g: G, x: number, y: number, s: number, angle: number): void {
  g.ctx.save()
  g.ctx.translate(px(g, x), px(g, y))
  g.ctx.rotate(angle)
  taskChair(g, 0, 0, s)
  g.ctx.restore()
}

/** Round-rect PATH from METRE coordinates. Leaves the path current so the caller
 *  chooses fill and/or stroke. */
function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  const X = px(g, x)
  const Y = px(g, y)
  const W = px(g, w)
  const H = px(g, h)
  const R = Math.max(0, Math.min(px(g, r), W / 2, H / 2))
  const c = g.ctx
  c.beginPath()
  c.moveTo(X + R, Y)
  c.arcTo(X + W, Y, X + W, Y + H, R)
  c.arcTo(X + W, Y + H, X, Y + H, R)
  c.arcTo(X, Y + H, X, Y, R)
  c.arcTo(X, Y, X + W, Y, R)
  c.closePath()
}
