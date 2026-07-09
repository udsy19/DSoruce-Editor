// Print export: DocState + Metrics -> single-page PDF 1.4 drawing sheet.
//
// A3 landscape sheet, hand-written like our DXF R12 exporter (no jsPDF/pdf-lib):
//   - the plan is rendered to an offscreen canvas and embedded as a JPEG image
//     XObject (/Filter /DCTDecode — PDF ingests JPEG streams natively; PNG
//     would require zlib/predictor decoding on our side). White background
//     makes JPEG artifacts negligible on line-work.
//   - title block, key metrics, and the furniture schedule are vector text in
//     the built-in /Helvetica (+/Helvetica-Bold), so they stay crisp and
//     selectable at any zoom. No font embedding needed.
//
// The byte-level writer (`buildPdfBytes`) is deliberately DOM-free: it takes
// pre-encoded JPEG bytes + a flat list of content ops, so it can be unit-tested
// in node where canvas APIs don't exist.

import type { DocState, DocComponent, Metrics } from '../editor/EditorCanvas'
import { drawFurnitureSymbol } from '../editor/furniture'
import type { Drawing, DrawEntity } from '../import/types'
import { CATEGORY_COLOR } from '../import/types'
import { triggerDownload } from './png'

export interface PdfMeta {
  title?: string
  project?: string
}

// ---------------------------------------------------------------------------
// PDF byte writer (DOM-free, node-testable)
// ---------------------------------------------------------------------------

/** A3 landscape in PostScript points (420 × 297 mm at 72 pt/in). */
export const PAGE_W = 1190.55
export const PAGE_H = 841.89

/** Raw JPEG bytes plus pixel dimensions (needed for /Width /Height). */
export interface PdfJpeg {
  bytes: Uint8Array
  width: number
  height: number
}

/**
 * Flat page-content operations, all in PDF user space (origin bottom-left,
 * units = points). `gray` is 0 (black) … 1 (white); default 0. `rgb` (each
 * channel 0…1) overrides `gray` when present, for the report's colored bars,
 * legend swatches, radar, and stacked bars.
 */
export type Rgb = [number, number, number]
export type ContentOp =
  | { op: 'text'; x: number; y: number; size: number; text: string; bold?: boolean; gray?: number; rgb?: Rgb }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number; gray?: number; rgb?: Rgb }
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: boolean; gray?: number; width?: number; rgb?: Rgb }
  /** Draws an embedded JPEG scaled into the given rect. `img` selects which
   *  page image (/Im0, /Im1, …); defaults to 0 for the single-image sheets. */
  | { op: 'image'; x: number; y: number; w: number; h: number; img?: number }

/**
 * Make a string safe for a latin1-encoded PDF text literal with WinAnsi
 * Helvetica: ₹ (absent from WinAnsi) becomes "Rs.", common punctuation is
 * ASCII-folded, and anything else outside latin1 becomes '?'.
 * Note "m²" survives: ² is 0xB2 in WinAnsi.
 */
export function pdfSafeText(s: string): string {
  return s
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
}

// Escape a (sanitized) string for a PDF ( ... ) literal.
function escLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

// Compact number for the content stream (no float noise, no trailing zeros).
function num(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/**
 * Approximate Helvetica advance width in points. A coarse per-character-class
 * table (digits are exactly 0.556 em in Helvetica; the rest is close enough
 * for right-aligning table columns — not for justified paragraphs).
 */
export function textWidth(s: string, size: number, bold = false): number {
  let em = 0
  for (const ch of s) {
    if ('iljI.,:;!|()[]\' '.includes(ch)) em += 0.3
    else if ('ft'.includes(ch)) em += 0.36
    else if ('mMW@'.includes(ch)) em += 0.92
    else if (ch >= 'A' && ch <= 'Z') em += 0.7
    else em += 0.56
  }
  return em * size * (bold ? 1.06 : 1)
}

// latin1-encode a string to bytes (1 char = 1 byte; input must be sanitized).
function enc(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

// Set fill (stroke=false → rg/g) or stroke (stroke=true → RG/G) color: RGB when
// given, else grayscale.
function col(rgb: Rgb | undefined, gray: number | undefined, stroke: boolean): string {
  if (rgb) return `${num(rgb[0])} ${num(rgb[1])} ${num(rgb[2])} ${stroke ? 'RG' : 'rg'}`
  return `${num(gray ?? 0)} ${stroke ? 'G' : 'g'}`
}

function opToStream(o: ContentOp): string {
  switch (o.op) {
    case 'text':
      return (
        `BT /${o.bold ? 'F2' : 'F1'} ${num(o.size)} Tf ${col(o.rgb, o.gray, false)} ` +
        `${num(o.x)} ${num(o.y)} Td (${escLiteral(pdfSafeText(o.text))}) Tj ET`
      )
    case 'line':
      return (
        `${col(o.rgb, o.gray, true)} ${num(o.width ?? 1)} w ` +
        `${num(o.x1)} ${num(o.y1)} m ${num(o.x2)} ${num(o.y2)} l S`
      )
    case 'rect': {
      const r = `${num(o.x)} ${num(o.y)} ${num(o.w)} ${num(o.h)} re`
      return o.fill
        ? `${col(o.rgb, o.gray, false)} ${r} f`
        : `${col(o.rgb, o.gray, true)} ${num(o.width ?? 1)} w ${r} S`
    }
    case 'image':
      return `q ${num(o.w)} 0 0 ${num(o.h)} ${num(o.x)} ${num(o.y)} cm /Im${o.img ?? 0} Do Q`
  }
}

const FONT = (base: string) =>
  `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`

/**
 * Serialize an ordered list of PDF objects (each a list of byte chunks so image
 * streams stay binary) into a complete PDF 1.4 file: header, the objects in
 * numeric order, then an xref table + trailer with byte-accurate offsets.
 * Objects must be pushed in ascending object-number order (obj 1 first); the
 * trailer's /Root is always object 1.
 */
function assemblePdf(objects: Uint8Array[][]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = []
  let pos = 0
  const push = (b: Uint8Array) => {
    chunks.push(b)
    pos += b.length
  }

  // Header: version + the conventional binary-content marker comment.
  push(enc('%PDF-1.4\n%âãÏÓ\n'))

  const offsets: number[] = []
  for (const parts of objects) {
    offsets.push(pos)
    for (const p of parts) push(p)
  }

  const xrefPos = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${off.toString().padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  push(enc(xref))

  const out = new Uint8Array(pos)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** One page of a multi-page PDF: content ops + any embedded JPEGs (/Im0…). */
export interface PdfPage {
  ops: ContentOp[]
  images: PdfJpeg[]
}

/**
 * Assemble a multi-page PDF 1.4 file. Shared fonts are objects 3 (/F1
 * Helvetica) and 4 (/F2 Helvetica-Bold); each page contributes a content
 * stream, its image XObjects (/Im0, /Im1, …, DeviceRGB /DCTDecode), and a Page
 * object, in that order so object numbers stay ascending. All pages are A3
 * landscape. `image` ops whose `img` index exceeds a page's image count are
 * dropped (matches the single-image sheet's "no image → skip" behavior).
 */
export function buildMultiPagePdfBytes(pages: PdfPage[]): Uint8Array<ArrayBuffer> {
  // Pre-assign object numbers: fixed 1–4, then per page content/images/page.
  let next = 5
  const meta = pages.map((p) => {
    const contentNum = next++
    const imageNums = p.images.map(() => next++)
    const pageNum = next++
    return { contentNum, imageNums, pageNum }
  })

  const objects: Uint8Array[][] = [
    [enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')],
    [
      enc(
        `2 0 obj\n<< /Type /Pages /Kids [${meta.map((m) => `${m.pageNum} 0 R`).join(' ')}] ` +
          `/Count ${pages.length} >>\nendobj\n`,
      ),
    ],
    [enc(`3 0 obj\n${FONT('Helvetica')}\nendobj\n`)],
    [enc(`4 0 obj\n${FONT('Helvetica-Bold')}\nendobj\n`)],
  ]

  pages.forEach((p, i) => {
    const m = meta[i]
    const drawable = p.ops.filter((o) => o.op !== 'image' || (o.img ?? 0) < p.images.length)
    const contentBytes = enc(drawable.map(opToStream).join('\n'))
    objects.push([
      enc(`${m.contentNum} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      enc('\nendstream\nendobj\n'),
    ])
    p.images.forEach((img, j) => {
      objects.push([
        enc(
          `${m.imageNums[j]} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} ` +
            `/Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
            `/Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
        ),
        img.bytes,
        enc('\nendstream\nendobj\n'),
      ])
    })
    const xobject = p.images.length
      ? ` /XObject << ${p.images.map((_, j) => `/Im${j} ${m.imageNums[j]} 0 R`).join(' ')} >>`
      : ''
    objects.push([
      enc(
        `${m.pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${m.contentNum} 0 R >>\nendobj\n`,
      ),
    ])
  })

  return assemblePdf(objects)
}

/**
 * Single-page PDF 1.4 file (A3 landscape) — a thin wrapper over
 * {@link buildMultiPagePdfBytes} for the one-off drawing sheets.
 */
export function buildPdfBytes(ops: ContentOp[], image: PdfJpeg | null): Uint8Array<ArrayBuffer> {
  return buildMultiPagePdfBytes([{ ops, images: image ? [image] : [] }])
}

// ---------------------------------------------------------------------------
// Offscreen print rendering (plan -> clean canvas -> JPEG)
// ---------------------------------------------------------------------------

// Fork of the on-screen pipeline, not a reuse: EditorCanvas.render() draws UI
// chrome (rulers, grips, selection, CAD overlays) that must not print, and its
// renderThumb is an unexported 200px flat-fill gallery schematic.

const PRINT_STROKE = '#2e343b'
const PRINT_DETAIL = '#7c848e'
const PRINT_WALL = '#14181d'
const PRINT_LABEL = '#4a515a'
const PRINT_ZONE_LABEL = '#8b939e'
// Same Laiout pastels as EditorCanvas's (unexported) ZONE fills, drawn at
// reduced alpha so tints stay light on paper.
export const PRINT_ZONE_FILL: Record<string, string> = {
  Circulation: '#dcebfb',
  Workspace: '#fbf3d6',
  Meeting: '#e9e3f7',
  Collaboration: '#def1e2',
  Core: '#eceef1',
  ClosedOffice: '#fce6d6',
  Amenity: '#d9f0ef',
}

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
const PRINT_NEW_WALL = '#3b6fd4' // generated:true partitions (construction plan)
const PRINT_DEMOLISH = '#d6336c' // removed/existing-to-demolish cross-hatch

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

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, wPx, hPx) // JPEG has no alpha — must paint the background.

  const bb = stateBbox(state)
  if (!bb) return { canvas, metersPerPx: 0, k: 0, ox: 0, oy: 0 }

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
    for (const z of state.zones ?? []) {
      ctx.fillStyle = PRINT_ZONE_FILL[z.zone_type] ?? PRINT_ZONE_FILL.Core
      const s = z.shape
      if (s.kind === 'RectRing') {
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
      drawFurnitureSymbol(ctx, {
        category: c.category,
        cx: X(c.x),
        cy: Y(c.y),
        w: c.w * k,
        h: c.h * k,
        rotation: c.rotation,
        stroke: PRINT_STROKE,
        detail: PRINT_DETAIL,
        accent: PRINT_STROKE,
        selected: false,
      })
    }

    // Labels on components large enough to read one (rooms, not chairs); kept
    // horizontal for legibility, with a white halo over the line-work.
    ctx.font = '600 14px Helvetica, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const c of state.components) {
      if (!c.label || Math.min(c.w, c.h) * k < 70) continue
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 4
      ctx.strokeText(c.label, X(c.x), Y(c.y))
      ctx.fillStyle = PRINT_LABEL
      ctx.fillText(c.label, X(c.x), Y(c.y))
    }
  }

  // Walls on top, at true scaled thickness. `existingWalls`/`generatedWalls`
  // gate which of the two poché classes draw (demolition hides the new
  // partitions; construction shows both + highlights the new).
  ctx.strokeStyle = PRINT_WALL
  ctx.lineCap = 'round'
  for (const w of state.walls) {
    const gen = w.generated === true
    if (gen && !generatedWalls) continue
    if (!gen && !existingWalls) continue
    ctx.strokeStyle = PRINT_WALL
    ctx.lineWidth = Math.max(1.5, w.thickness * k)
    ctx.beginPath()
    ctx.moveTo(X(w.a.x), Y(w.a.y))
    ctx.lineTo(X(w.b.x), Y(w.b.y))
    ctx.stroke()
  }

  // New-wall highlight — over-stroke generated partitions in blue.
  if (newWallHighlight) {
    ctx.strokeStyle = PRINT_NEW_WALL
    for (const w of state.walls) {
      if (w.generated !== true) continue
      ctx.lineWidth = Math.max(2, w.thickness * k)
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

// ---------------------------------------------------------------------------
// Sheet composition
// ---------------------------------------------------------------------------

const MARGIN = 24
const PANEL_W = 300
const PAD = 12

// Truncate with "..." to fit a width (Helvetica estimate).
function clipText(s: string, size: number, bold: boolean, maxW: number): string {
  if (textWidth(s, size, bold) <= maxW) return s
  let t = s
  while (t.length > 1 && textWidth(t + '...', size, bold) > maxW) t = t.slice(0, -1)
  return t + '...'
}

// "MeetingRoom" -> "MEETING ROOM" for schedule rows.
function categoryName(category: string): string {
  return category.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toUpperCase()
}

function fmt(v: number | undefined, f: (n: number) => string): string {
  return v === undefined ? '-' : f(v)
}

const RES = 2.6 // px per pt: ~187 dpi on paper, crisp for line-work

/** Plan-image placement (left of the panel divider) + raster size, shared by both sheets. */
function planImageRect() {
  const dividerX = PAGE_W - MARGIN - PANEL_W
  const img = {
    x: MARGIN + PAD,
    yTop: MARGIN + PAD, // top-down; converted to PDF space at the image op
    w: dividerX - MARGIN - PAD * 2,
    h: PAGE_H - (MARGIN + PAD) * 2,
  }
  return { img, wPx: Math.round(img.w * RES), hPx: Math.round(img.h * RES) }
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

/** True plot scale "1 : N @ A3" — meters per point on paper vs. meters per mm real. */
function scaleNote(metersPerPx: number, wPx: number, imgW: number): string {
  const n = planScaleN(metersPerPx, wPx, imgW)
  return n === 0 ? 'N.T.S.' : `1 : ${n} @ A3`
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

/**
 * Shared A3 sheet chrome: outer frame, right-panel divider, top-down `text`/
 * `hr` helpers scoped to the panel, and the standard footer. Both sheet
 * exports (generated doc + imported drawing) compose their panels on this.
 */
function sheetChrome(ops: ContentOp[]) {
  const dividerX = PAGE_W - MARGIN - PANEL_W
  const Y = (yTop: number) => PAGE_H - yTop
  const px0 = dividerX + 18
  const px1 = PAGE_W - MARGIN - 18

  ops.push({
    op: 'rect',
    x: MARGIN,
    y: MARGIN,
    w: PAGE_W - MARGIN * 2,
    h: PAGE_H - MARGIN * 2,
    fill: false,
    gray: 0.25,
    width: 1.2,
  })
  ops.push({ op: 'line', x1: dividerX, y1: Y(MARGIN), x2: dividerX, y2: MARGIN, width: 1.2, gray: 0.25 })

  const text = (
    x: number,
    yTop: number,
    size: number,
    s: string,
    o?: { bold?: boolean; gray?: number; align?: 'left' | 'right' },
  ) => {
    const w = textWidth(pdfSafeText(s), size, o?.bold)
    ops.push({
      op: 'text',
      x: o?.align === 'right' ? x - w : x,
      y: Y(yTop),
      size,
      text: s,
      bold: o?.bold,
      gray: o?.gray,
    })
  }
  const hr = (yTop: number, gray = 0.75) =>
    ops.push({ op: 'line', x1: px0, y1: Y(yTop), x2: px1, y2: Y(yTop), width: 0.7, gray })

  const footTop = PAGE_H - MARGIN - 24 // footer band top (top-down y)
  const footer = () => {
    hr(footTop)
    text(px0, footTop + 14, 6.5, 'GENERATED BY DSOURCE EDITOR', { gray: 0.55 })
    text(
      px1,
      footTop + 14,
      6.5,
      new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      { align: 'right', gray: 0.55 },
    )
  }

  return { Y, px0, px1, panelW: px1 - px0, text, hr, footTop, footer }
}

/**
 * Export the current plan as a print-ready A3 landscape PDF drawing sheet:
 * plan image on the left, title block + key metrics + furniture schedule in a
 * right-hand panel. Downloads via the shared blob plumbing.
 */
export async function exportPlanPDF(
  state: DocState,
  metrics: Metrics,
  meta?: PdfMeta,
  filename = 'dsource-plan.pdf',
): Promise<void> {
  // --- plan image ------------------------------------------------------
  const { img, wPx, hPx } = planImageRect()
  const { canvas, metersPerPx } = renderPrintCanvas(state, wPx, hPx)
  const jpegBytes = canvasToJpeg(canvas)

  // --- content ops (built top-down, converted to PDF space) -------------
  const ops: ContentOp[] = []
  ops.push({ op: 'image', x: img.x, y: PAGE_H - (img.yTop + img.h), w: img.w, h: img.h })
  const { Y, px0, px1, panelW, text, hr, footTop, footer } = sheetChrome(ops)

  // --- title block -------------------------------------------------------
  let y = MARGIN + 32
  text(px0, y, 8, 'DSOURCE EDITOR', { gray: 0.45 })
  y += 24
  text(px0, y, 16, clipText(pdfSafeText(meta?.project ?? 'Untitled Project'), 16, true, panelW), {
    bold: true,
    gray: 0.05,
  })
  y += 20
  text(px0, y, 11, meta?.title ?? 'FURNITURE PLAN', { gray: 0.3 })
  y += 14
  hr(y)

  const metaRow = (label: string, value: string) => {
    y += 17
    text(px0, y, 7.5, label, { gray: 0.5 })
    text(px1, y, 9, value, { align: 'right', gray: 0.1 })
  }
  metaRow(
    'DATE',
    new Date()
      .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      .toUpperCase(),
  )
  metaRow('SCALE', scaleNote(metersPerPx, wPx, img.w))
  metaRow('SHEET', 'A-101')
  y += 12
  hr(y)

  // --- key metrics ---------------------------------------------------------
  const gea = metrics.gross_external_area ?? metrics.floor_area
  const nia = metrics.net_internal_area
  const workstations =
    metrics.workstations ?? state.components.filter((c) => c.category === 'Desk').length
  const areaPerWs =
    metrics.area_per_workstation ??
    (nia !== undefined && workstations > 0 ? nia / workstations : undefined)
  const efficiency =
    metrics.efficiency_pct ?? (nia !== undefined && gea > 0 ? (nia / gea) * 100 : undefined)
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

  y += 20
  text(px0, y, 9, 'KEY METRICS', { bold: true, gray: 0.3 })
  const metricRow = (label: string, value: string) => {
    y += 16.5
    text(px0, y, 8.5, label, { gray: 0.45 })
    text(px1, y, 9.5, value, { bold: true, align: 'right', gray: 0.08 })
  }
  const area = (n: number) => `${n.toFixed(1)} m²`
  metricRow('GROSS EXTERNAL AREA', fmt(gea, area))
  metricRow('NET INTERNAL AREA', fmt(nia, area))
  metricRow('WORKSTATIONS', `${workstations}`)
  metricRow('AREA / WORKSTATION', fmt(areaPerWs, area))
  metricRow('EFFICIENCY', fmt(efficiency, (n) => `${n.toFixed(0)}%`))
  // ₹ is not in WinAnsi/Helvetica, so cost prints as "Rs." with en-IN grouping.
  metricRow('FIT-OUT COST (INDICATIVE)', fmt(metrics.indicative_cost, (n) => `Rs. ${inr.format(n)}`))
  y += 12
  hr(y)

  // --- furniture schedule --------------------------------------------------
  const counts = new Map<string, number>()
  for (const c of state.components as DocComponent[]) {
    counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
  }
  const schedule = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  y += 20
  text(px0, y, 9, 'FURNITURE SCHEDULE', { bold: true, gray: 0.3 })
  y += 10
  ops.push({ op: 'rect', x: px0, y: Y(y + 13), w: panelW, h: 14, fill: true, gray: 0.93 })
  y += 10.5
  text(px0 + 5, y, 7.5, 'ITEM', { bold: true, gray: 0.35 })
  text(px1 - 5, y, 7.5, 'QTY', { bold: true, align: 'right', gray: 0.35 })
  y += 2.5

  const rowH = 14.5
  const maxRows = Math.max(0, Math.floor((footTop - 12 - (y + rowH * 2)) / rowH))
  const shown = schedule.length > maxRows ? schedule.slice(0, Math.max(0, maxRows - 1)) : schedule
  for (const [category, count] of shown) {
    y += rowH
    text(px0 + 5, y, 9, clipText(categoryName(category), 9, false, panelW - 60), { gray: 0.2 })
    text(px1 - 5, y, 9, `${count}`, { align: 'right', gray: 0.1 })
    hr(y + 4, 0.88)
  }
  if (shown.length < schedule.length) {
    const rest = schedule.slice(shown.length)
    y += rowH
    text(px0 + 5, y, 9, `+ ${rest.length} MORE CATEGORIES`, { gray: 0.5 })
    text(px1 - 5, y, 9, `${rest.reduce((s, [, n]) => s + n, 0)}`, { align: 'right', gray: 0.35 })
    hr(y + 4, 0.88)
  }
  y += rowH
  text(px0 + 5, y, 9, 'TOTAL', { bold: true, gray: 0.15 })
  text(px1 - 5, y, 9.5, `${state.components.length}`, { bold: true, align: 'right', gray: 0.05 })

  footer()

  const pdf = buildPdfBytes(ops, { bytes: jpegBytes, width: wPx, height: hPx })
  triggerDownload(new Blob([pdf], { type: 'application/pdf' }), filename)
}

// ---------------------------------------------------------------------------
// Imported-plan sheet (CAD Drawing -> same A3 sheet)
// ---------------------------------------------------------------------------

// Fork of DrawingCanvas's on-screen pipeline, not a reuse: the live canvas is
// an interactive class (DPR viewport, pan/zoom state, hover/selection chrome,
// bound-item accenting) — print needs a one-shot clean raster on white.

/**
 * Render an imported drawing to an offscreen canvas: architecture linework
 * (walls/glazing/doors/…) stroked by category color, furniture as light bbox
 * outlines. CAD world is Y-up, so Y is flipped. Returns `metersPerPx` for the
 * plot-scale note (0 = degenerate bounds).
 */
function renderDrawingPrintCanvas(
  drawing: Drawing,
  wPx: number,
  hPx: number,
): { canvas: HTMLCanvasElement; metersPerPx: number } {
  const canvas = document.createElement('canvas')
  canvas.width = wPx
  canvas.height = hPx
  const ctx = canvas.getContext('2d')
  if (!ctx) return { canvas, metersPerPx: 0 }

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, wPx, hPx) // JPEG has no alpha — must paint the background.

  const [minX, minY, maxX, maxY] = drawing.bounds
  const pad = 48
  const spanX = Math.max(maxX - minX, 0.001)
  const spanY = Math.max(maxY - minY, 0.001)
  const k = Math.min((wPx - pad * 2) / spanX, (hPx - pad * 2) / spanY)
  const X = (m: number) => m * k + (wPx - spanX * k) / 2 - minX * k
  const Yc = (m: number) => -m * k + (hPx + spanY * k) / 2 + minY * k // Y-up -> Y-down

  // Same subpath math as DrawingCanvas.appendEntity (angles negate on Y flip).
  const path = (e: DrawEntity) => {
    if (e.kind === 'polyline') {
      const pts = e.pts
      if (!pts || pts.length === 0) return
      ctx.moveTo(X(pts[0][0]), Yc(pts[0][1]))
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Yc(pts[i][1]))
      if (e.closed) ctx.lineTo(X(pts[0][0]), Yc(pts[0][1]))
    } else if (e.kind === 'circle' || e.kind === 'arc') {
      if (e.cx === undefined || e.cy === undefined || e.r === undefined) return
      const rPx = e.r * k
      const a0 = e.kind === 'circle' ? 0 : -(e.start ?? 0)
      const a1 = e.kind === 'circle' ? Math.PI * 2 : -(e.end ?? Math.PI * 2)
      ctx.moveTo(X(e.cx) + rPx * Math.cos(a0), Yc(e.cy) + rPx * Math.sin(a0))
      ctx.arc(X(e.cx), Yc(e.cy), rPx, a0, a1, e.kind === 'arc')
    }
  }

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const e of drawing.entities) {
    if (e.kind === 'text') continue // sheet text stays vector in the panel
    ctx.strokeStyle = e.color ?? CATEGORY_COLOR[e.category] ?? CATEGORY_COLOR.other
    ctx.lineWidth =
      e.category === 'wall' ? 2 : e.category === 'annotation' || e.category === 'dimension' ? 0.6 : 1
    ctx.beginPath()
    path(e)
    ctx.stroke()
  }

  // Furniture as light outlines — occupancy reads on paper without the
  // (heavy) flattened block linework.
  ctx.strokeStyle = '#b9c0c9'
  ctx.lineWidth = 1
  for (const f of drawing.furniture) {
    const [x0, y0, x1, y1] = f.bbox
    ctx.strokeRect(X(x0), Yc(y1), (x1 - x0) * k, (y1 - y0) * k)
  }

  return { canvas, metersPerPx: k > 0 ? 1 / k : 0 }
}

/**
 * Export an IMPORTED plan as a print-ready A3 landscape PDF sheet: the drawing
 * raster on the left, title block + import metrics (extent, furniture count,
 * specified count + ₹ total) in the right-hand panel. Shares the byte writer
 * and sheet chrome with `exportPlanPDF`.
 */
export async function exportDrawingPDF(
  drawing: Drawing,
  opts: { boundCount: number; specTotalInr: number | null },
  filename = 'dsource-import.pdf',
): Promise<void> {
  const { img, wPx, hPx } = planImageRect()
  const { canvas, metersPerPx } = renderDrawingPrintCanvas(drawing, wPx, hPx)
  const jpegBytes = canvasToJpeg(canvas)

  const ops: ContentOp[] = []
  ops.push({ op: 'image', x: img.x, y: PAGE_H - (img.yTop + img.h), w: img.w, h: img.h })
  const { px0, px1, panelW, text, hr, footer } = sheetChrome(ops)

  // --- title block -------------------------------------------------------
  let y = MARGIN + 32
  text(px0, y, 8, 'DSOURCE EDITOR', { gray: 0.45 })
  y += 24
  text(px0, y, 16, clipText('Untitled Project', 16, true, panelW), { bold: true, gray: 0.05 })
  y += 20
  text(px0, y, 11, 'IMPORTED PLAN', { gray: 0.3 })
  y += 14
  hr(y)

  const metaRow = (label: string, value: string) => {
    y += 17
    text(px0, y, 7.5, label, { gray: 0.5 })
    text(px1, y, 9, value, { align: 'right', gray: 0.1 })
  }
  metaRow(
    'DATE',
    new Date()
      .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      .toUpperCase(),
  )
  metaRow('SCALE', scaleNote(metersPerPx, wPx, img.w))
  metaRow('SHEET', 'A-201')
  y += 12
  hr(y)

  // --- import metrics ------------------------------------------------------
  const extentW = drawing.bounds[2] - drawing.bounds[0]
  const extentH = drawing.bounds[3] - drawing.bounds[1]
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

  y += 20
  text(px0, y, 9, 'IMPORT METRICS', { bold: true, gray: 0.3 })
  const metricRow = (label: string, value: string) => {
    y += 16.5
    text(px0, y, 8.5, label, { gray: 0.45 })
    text(px1, y, 9.5, value, { bold: true, align: 'right', gray: 0.08 })
  }
  metricRow('EXTENT', `${extentW.toFixed(1)} × ${extentH.toFixed(1)} m`)
  metricRow('FURNITURE ITEMS', `${drawing.furniture.length}`)
  metricRow('LINE ENTITIES', `${drawing.entities.length}`)
  metricRow('LAYERS', `${drawing.layers.length}`)
  metricRow('SPECIFIED', `${opts.boundCount} OF ${drawing.furniture.length}`)
  // ₹ is not in WinAnsi/Helvetica, so the total prints as "Rs." (pdfSafeText).
  metricRow(
    'SPECIFIED TOTAL',
    opts.specTotalInr != null ? `Rs. ${inr.format(opts.specTotalInr)}` : '-',
  )
  y += 12
  hr(y)

  footer()

  const pdf = buildPdfBytes(ops, { bytes: jpegBytes, width: wPx, height: hPx })
  triggerDownload(new Blob([pdf], { type: 'application/pdf' }), filename)
}
