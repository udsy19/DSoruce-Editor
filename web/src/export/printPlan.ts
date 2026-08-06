// The deliverable plan raster: DocState -> clean offscreen canvas -> JPEG.
//
// THIS is the module that owns the print palette — `PRINT_ZONE_FILL` and the
// PRINT inks — and therefore the module the style-gate and bench/export-parity
// anchor on. R1's mode separation is only checkable when the palette-bearing
// code is a file of its own; see pdfDoc.ts for the rest of that reasoning.
//
// Fork of the on-screen pipeline, not a reuse: EditorCanvas.render() draws UI
// chrome (rulers, grips, selection, CAD overlays) that must not print.

import type { DocState } from '../types/doc'
import { drawSymbol, seatsForSize } from '../editor/symbols'
import { ZONE, PRINT, planStyle, strokePx, hexToRgba } from '../editor/planStyle'

// ---------------------------------------------------------------------------
// Offscreen print rendering (plan -> clean canvas -> JPEG)
// ---------------------------------------------------------------------------

// Fork of the on-screen pipeline, not a reuse: EditorCanvas.render() draws UI
// chrome (rulers, grips, selection, CAD overlays) that must not print, and its
// renderThumb is an unexported 200px flat-fill gallery schematic.

const PRINT_STROKE = PRINT.stroke
const PRINT_DETAIL = PRINT.detail
const PRINT_WALL = PRINT.wall
const PRINT_LABEL = PRINT.label
const PRINT_ZONE_LABEL = PRINT.zoneLabel
/**
 * Zone fills for print — THE SAME OBJECT the canvas fills with.
 *
 * This was a hardcoded copy, and its own comment said why: "same Laiout pastels
 * as EditorCanvas's (unexported) ZONE fills". The table is exported now, so the
 * reason is gone. The copy was not harmless while it lasted -- it still held the
 * pre-2e palette, so every PDF was rendering the OLD colours while the canvas
 * rendered the new ones. Export parity starts by not having a second palette.
 */
export const PRINT_ZONE_FILL: Record<string, string> = Object.fromEntries(
  Object.entries(ZONE).map(([k, v]) => [k, v.fill]),
)

// Rotation-aware world bbox of everything printable in the state.
function stateBbox(
  state: DocState,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const pt = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const w of state.walls) {
    pt(w.a.x, w.a.y)
    pt(w.b.x, w.b.y)
  }
  for (const c of state.components) {
    const cos = Math.cos(c.rotation)
    const sin = Math.sin(c.rotation)
    for (const [lx, ly] of [
      [-c.w / 2, -c.h / 2],
      [c.w / 2, -c.h / 2],
      [c.w / 2, c.h / 2],
      [-c.w / 2, c.h / 2],
    ]) {
      pt(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos)
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/** New (generated) partition highlight + demolition hatch colors, keyed to the
 *  drawing-set plan family (docs/design/drawing-set-generator.md §1.3). */
/**
 * The sheet is rendered at a much larger pixel size than the screen canvas and
 * then scaled into the page, so a screen-px ladder value would come out
 * hairline. One scalar, applied to every tier, keeps the measured RATIOS intact
 * while making the absolute weights readable on paper — the ladder is the
 * ratios, so a uniform scale is the one transform that does not corrupt it.
 */
const PRINT_WEIGHT_SCALE = 3

const PRINT_NEW_WALL = PRINT.newWall // generated:true partitions (construction plan)
const PRINT_DEMOLISH = PRINT.demolish // removed/existing-to-demolish cross-hatch

/** A wall segment in editor (m) coords — used to pass a caller-derived
 *  "demolished" set (imported originals no longer in the doc) to the renderer. */
export interface WallSeg {
  ax: number
  ay: number
  bx: number
  by: number
  thickness: number
}

/**
 * Which layers of the plan draw. Every flag defaults to the historical
 * behaviour (all zones/furniture/labels/walls on, no highlight, no hatch) so
 * `renderPrintCanvas(state, w, h)` with no opts is byte-identical to before —
 * the report and single-sheet PDF exports are unchanged. The drawing-set
 * generator flips these to render ONE plan as demolition vs construction vs the
 * default colored view (the core "one plan, many sheets" win).
 */
export interface PlanLayers {
  zoneFill?: boolean
  furniture?: boolean
  roomLabels?: boolean
  /** existing (generated:false) walls in grey poché */
  existingWalls?: boolean
  /** generated (generated:true) partitions drawn at all */
  generatedWalls?: boolean
  /** over-stroke generated:true walls in blue (construction plan) */
  newWallHighlight?: boolean
  /** red cross-hatch on the caller-supplied `demolished` set (demolition plan) */
  demolishHatch?: boolean
}

export interface RenderPlanOpts {
  layers?: PlanLayers
  /** Demolished wall segments (editor coords) drawn as red cross-hatch. */
  demolished?: WallSeg[]
}

/** Fill a wall-thickness rect along a→b with a diagonal cross-hatch + outline. */
function crossHatchSeg(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  halfW: number,
  color: string,
): void {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy * halfW
  const ny = ux * halfW
  const c = [
    [ax + nx, ay + ny],
    [bx + nx, by + ny],
    [bx - nx, by - ny],
    [ax - nx, ay - ny],
  ]
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(c[0][0], c[0][1])
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1])
  ctx.closePath()
  ctx.clip()
  // Diagonal hatch across the segment's bbox, both directions.
  const minX = Math.min(...c.map((p) => p[0]))
  const maxX = Math.max(...c.map((p) => p[0]))
  const minY = Math.min(...c.map((p) => p[1]))
  const maxY = Math.max(...c.map((p) => p[1]))
  const span = maxX - minX + maxY - minY
  const step = 6
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let d = -span; d <= span; d += step) {
    ctx.moveTo(minX + d, minY)
    ctx.lineTo(minX + d + (maxY - minY), maxY)
    ctx.moveTo(minX + d, maxY)
    ctx.lineTo(minX + d + (maxY - minY), minY)
  }
  ctx.stroke()
  ctx.restore()
  // Solid red outline of the wall footprint.
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(c[0][0], c[0][1])
  for (let i = 1; i < 4; i++) ctx.lineTo(c[i][0], c[i][1])
  ctx.closePath()
  ctx.stroke()
}

/**
 * Render a clean print view of the plan to an offscreen canvas: white
 * background, light zone tints, CAD furniture symbols, walls on top. Returns
 * `metersPerPx` (for the true plot scale, 0 = empty plan) plus the world→canvas
 * transform (`k`, `ox`, `oy`; canvasPx = m·k + o) so callers can overlay crisp
 * vector tags/labels on the embedded raster. The optional `opts` toggles which
 * layers draw — default = all on, byte-identical to the legacy signature.
 */
export function renderPrintCanvas(
  state: DocState,
  wPx: number,
  hPx: number,
  opts?: RenderPlanOpts,
): { canvas: HTMLCanvasElement; metersPerPx: number; k: number; ox: number; oy: number } {
  const L = opts?.layers
  const zoneFill = L?.zoneFill ?? true
  const furniture = L?.furniture ?? true
  const roomLabels = L?.roomLabels ?? true
  const existingWalls = L?.existingWalls ?? true
  const generatedWalls = L?.generatedWalls ?? true
  const newWallHighlight = L?.newWallHighlight ?? false
  const demolishHatch = L?.demolishHatch ?? false

  const canvas = document.createElement('canvas')
  canvas.width = wPx
  canvas.height = hPx
  const ctx = canvas.getContext('2d')
  if (!ctx) return { canvas, metersPerPx: 0, k: 0, ox: 0, oy: 0 }

  ctx.fillStyle = PRINT.paper
  ctx.fillRect(0, 0, wPx, hPx) // JPEG has no alpha — must paint the background.

  const bb = stateBbox(state)
  if (!bb) return { canvas, metersPerPx: 0, k: 0, ox: 0, oy: 0 }

  const paperProfile = planStyle('paper')
  const pad = 48
  const spanX = Math.max(bb.maxX - bb.minX, 0.001)
  const spanY = Math.max(bb.maxY - bb.minY, 0.001)
  const k = Math.min((wPx - pad * 2) / spanX, (hPx - pad * 2) / spanY)
  const ox = (wPx - spanX * k) / 2 - bb.minX * k
  const oy = (hPx - spanY * k) / 2 - bb.minY * k
  const X = (m: number) => m * k + ox
  const Y = (m: number) => m * k + oy

  // Zone tints (+ labels on rect zones large enough to carry one).
  if (zoneFill) {
    ctx.globalAlpha = 0.55
    const paper = planStyle('paper')
    for (const z of state.zones ?? []) {
      // Ground zones are the sheet's paper, exactly as on the paper-profile
      // canvas. Filling circulation here and not there would be the parity bug
      // this phase exists to close.
      if (paper.groundZones.includes(z.zone_type)) continue
      ctx.fillStyle = PRINT_ZONE_FILL[z.zone_type] ?? PRINT_ZONE_FILL.Core
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
    ctx.globalAlpha = 1
  }
  if (roomLabels) {
    ctx.font = '600 13px Helvetica, Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = PRINT_ZONE_LABEL
    for (const z of state.zones ?? []) {
      const s = z.shape
      if (s.kind === 'Rect' && z.label && s.w * k > 140 && s.h * k > 50) {
        ctx.fillText(z.label.toUpperCase(), X(s.x - s.w / 2) + 10, Y(s.y - s.h / 2) + 22)
      }
    }
  }

  // Components as CAD line symbols (same renderer the live canvas uses).
  if (furniture) {
    for (const c of state.components) {
      drawSymbol(
        ctx,
        {
          category: c.category,
          cx: X(c.x),
          cy: Y(c.y),
          w: c.w, // METRES — `k` is the print scale, passed as the view below
          h: c.h,
          rotation: c.rotation,
          mirror: c.mirror,
          seats: c.seats || seatsForSize(c.category, c.w, c.h),
          // NO IMPLIED SEATING ON PAPER (R6). Real `Chair` components are drawn
          // as their own glyphs beside the desk or table they serve, so an
          // implied chair here would ink the same seat twice and put seating on
          // a deliverable the Furniture Inventory does not bill.
          implySeats: false,
          selected: false,
        },
        { stroke: PRINT_STROKE, detail: PRINT_DETAIL, accent: PRINT_STROKE },
        // Print is a 1:1 pixel surface, so DPR 1 — pens land on output pixels.
        { pxPerM: k, dpr: 1 },
      )
    }

    // Labels on components large enough to read one (rooms, not chairs); kept
    // horizontal for legibility, with a white halo over the line-work.
    ctx.font = '600 14px Helvetica, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const c of state.components) {
      if (!c.label || Math.min(c.w, c.h) * k < 70) continue
      ctx.strokeStyle = PRINT.paper
      ctx.lineWidth = 4
      ctx.strokeText(c.label, X(c.x), Y(c.y))
      ctx.fillStyle = PRINT_LABEL
      ctx.fillText(c.label, X(c.x), Y(c.y))
    }
  }

  // Walls on top, at true scaled thickness. `existingWalls`/`generatedWalls`
  // gate which of the two poché classes draw (demolition hides the new
  // partitions; construction shows both + highlights the new).
  // TWO-FACE WALLS, matching the canvas grammar (2a): a wall is a thickness
  // polygon with both faces stroked, not one fat centreline. The sheet drew a
  // single stroke at scaled thickness, which produced a heavy black outline
  // where the canvas shows a crisp double line — the same document reading as a
  // different drawing depending on which renderer you asked. Faces are stroked
  // at the ladder's wall tier, and the interior takes the profile's fill, so the
  // Rayon hatch reaches the sheet too.
  ctx.lineCap = 'round'
  const wallFill = paperProfile.wallCut.fill
  for (const w of state.walls) {
    const gen = w.generated === true
    if (gen && !generatedWalls) continue
    if (!gen && !existingWalls) continue

    const dx = w.b.x - w.a.x
    const dy = w.b.y - w.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    const hw = (w.thickness > 0 ? w.thickness : 0.1) / 2
    const nx = (-dy / len) * hw
    const ny = (dx / len) * hw
    const q = [
      { x: X(w.a.x + nx), y: Y(w.a.y + ny) },
      { x: X(w.b.x + nx), y: Y(w.b.y + ny) },
      { x: X(w.b.x - nx), y: Y(w.b.y - ny) },
      { x: X(w.a.x - nx), y: Y(w.a.y - ny) },
    ]

    if (wallFill && wallFill.kind === 'hatch') {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(q[0].x, q[0].y)
      for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y)
      ctx.closePath()
      ctx.clip()
      ctx.strokeStyle = hexToRgba(wallFill.color, wallFill.alpha)
      ctx.lineWidth = strokePx(wallFill.tier, k) * PRINT_WEIGHT_SCALE
      const spacing = Math.max(
        2,
        'px' in wallFill.spacing
          ? wallFill.spacing.px
          : w.thickness * k * wallFill.spacing.ofThickness,
      )
      const diag = Math.hypot(
        Math.max(...q.map((p) => p.x)) - Math.min(...q.map((p) => p.x)),
        Math.max(...q.map((p) => p.y)) - Math.min(...q.map((p) => p.y)),
      )
      const cx0 = (Math.min(...q.map((p) => p.x)) + Math.max(...q.map((p) => p.x))) / 2
      const cy0 = (Math.min(...q.map((p) => p.y)) + Math.max(...q.map((p) => p.y))) / 2
      const rad = (wallFill.angleDeg * Math.PI) / 180
      const ux = Math.cos(rad)
      const uy = Math.sin(rad)
      ctx.beginPath()
      for (let o = -diag / 2; o <= diag / 2; o += spacing) {
        const bx = cx0 - uy * o
        const by = cy0 + ux * o
        ctx.moveTo(bx - (ux * diag) / 2, by - (uy * diag) / 2)
        ctx.lineTo(bx + (ux * diag) / 2, by + (uy * diag) / 2)
      }
      ctx.stroke()
      ctx.restore()
    }

    ctx.strokeStyle = PRINT_WALL
    ctx.lineWidth = strokePx('wall', k) * PRINT_WEIGHT_SCALE
    ctx.beginPath()
    ctx.moveTo(q[0].x, q[0].y)
    for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y)
    ctx.closePath()
    ctx.stroke()
  }

  // New-wall highlight — over-stroke generated partitions in blue.
  if (newWallHighlight) {
    ctx.strokeStyle = PRINT_NEW_WALL
    for (const w of state.walls) {
      if (w.generated !== true) continue
      ctx.lineWidth = Math.max(strokePx('wall', k) * PRINT_WEIGHT_SCALE, w.thickness * k)
      ctx.beginPath()
      ctx.moveTo(X(w.a.x), Y(w.a.y))
      ctx.lineTo(X(w.b.x), Y(w.b.y))
      ctx.stroke()
    }
  }

  // Demolition cross-hatch — red over the caller-supplied removed segments.
  if (demolishHatch && opts?.demolished) {
    for (const d of opts.demolished) {
      crossHatchSeg(ctx, X(d.ax), Y(d.ay), X(d.bx), Y(d.by), Math.max(3, (d.thickness * k) / 2), PRINT_DEMOLISH)
    }
  }

  return { canvas, metersPerPx: k > 0 ? 1 / k : 0, k, ox, oy }
}

/** Plot-scale denominator N (as in 1:N) for a raster placed `imgW` pt wide from
 *  a `wPx`-px canvas at `metersPerPx`; rounded to a tidy multiple of 5. 0 when
 *  the plan is degenerate. Shared by the single sheet + the drawing set. */
export function planScaleN(metersPerPx: number, wPx: number, imgW: number): number {
  if (metersPerPx <= 0) return 0
  const metersPerPt = metersPerPx * (wPx / imgW)
  const scaleN = metersPerPt * 1000 * (72 / 25.4)
  return Math.max(1, Math.round(scaleN / 5) * 5)
}

/** Encode an offscreen canvas as raw JPEG bytes for the /DCTDecode image XObject. */
export function canvasToJpeg(canvas: HTMLCanvasElement): Uint8Array {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
