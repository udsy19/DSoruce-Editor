// Drawing-set generator — turns a finished test-fit into a professional
// multi-sheet architectural PDF (cover · contents · demolition · construction),
// the first slice of docs/design/drawing-set-generator.md §5.
//
// Built entirely on the hand-written PDF engine (buildMultiPagePdfBytes +
// renderPrintCanvas, now layer-aware) and the shared sheet primitives in
// sheet.ts — no new PDF engine, no new deps. The plan family is ONE renderer
// with a layer mask: demolition (existing grey + demolished red cross-hatch)
// and construction (existing grey + new blue + furniture + D01/W1 tags) are the
// SAME plan drawn twice, keyed on DocWall.generated.

import {
  PAGE_W,
  PAGE_H,
  PdfPage,
  PdfJpeg,
  Rgb,
  buildMultiPagePdfBytes,
  renderPrintCanvas,
  canvasToJpeg,
  planScaleN,
  WallSeg,
} from './pdf'
import {
  Page,
  MARGIN,
  RES,
  ACCENT,
  hex2rgb,
  keyPlanJpeg,
  titleBlock,
  TITLE_BLOCK_H,
} from './sheet'
import type { ReportMeta } from './report'
import type { DocState, DocComponent, ZoneShape } from '../editor/EditorCanvas'
import type { Drawing } from '../import/types'
import type { BindingInfo } from '../persist/file'
import { extractPlate, extractInteriorWalls } from '../import/testfit'
import { healWalls } from '../import/heal'
import { triggerDownload } from './png'

// ---------------------------------------------------------------------------
// Meta + options
// ---------------------------------------------------------------------------

export interface SheetSetMeta extends ReportMeta {
  studio?: string
  drawnBy?: string
  approvedBy?: string
  revision?: string
}

export interface DrawingSetOpts {
  meta: SheetSetMeta
  /** Imported original drawing — its interior walls seed the demolition plan. */
  drawing?: Drawing | null
  /** Product bindings (reserved for the furniture-card slice, M3). */
  bindings?: Map<string, BindingInfo>
}

const INK = hex2rgb('#2e343b')
const GREY_WALL: Rgb = hex2rgb('#14181d')
const BLUE_WALL: Rgb = hex2rgb('#3b6fd4')
const RED_DEMO: Rgb = hex2rgb('#d6336c')
const FURN: Rgb = hex2rgb('#5c6670')

function todayLabel(): string {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Enclosed area (m²) of an (axis-aligned) zone shape; rings exclude the hole. */
function zoneArea(s: ZoneShape): number {
  return s.kind === 'RectRing' ? s.w * s.h - s.in_w * s.in_h : s.w * s.h
}

/** Center point of a zone shape. */
function zoneCenter(s: ZoneShape): { x: number; y: number } {
  return { x: s.x, y: s.y }
}

/** Shortest distance from point p to segment a→b (m). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * The demolished set for the demolition plan: interior walls of the imported
 * original that are NOT retained in the current doc. We re-derive the plate the
 * import used (deterministic), take its interior partitions in editor coords,
 * and drop any that coincide with a live wall (kept-existing walls match; a
 * fresh fit clears the interior, so all originals read as demolished). Returns
 * [] when there is no imported drawing (a hand-drawn / new-build plan).
 */
function demolishedWalls(state: DocState, drawing: Drawing | null | undefined): WallSeg[] {
  if (!drawing) return []
  const plate = extractPlate(healWalls(drawing))
  if (!plate) return []
  const interior = extractInteriorWalls(drawing, plate)
  const retained = (w: WallSeg) => {
    const mx = (w.ax + w.bx) / 2
    const my = (w.ay + w.by) / 2
    return state.walls.some((s) => segDist(mx, my, s.a.x, s.a.y, s.b.x, s.b.y) < 0.35)
  }
  return interior
    .map((w) => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, thickness: w.thickness }))
    .filter((w) => !retained(w))
}

// ---------------------------------------------------------------------------
// Door / window schedule (§1.3b)
// ---------------------------------------------------------------------------

export interface Opening {
  tag: string
  kind: 'Door' | 'Window'
  x: number // world m (for the plan glyph)
  y: number
  w: number // leaf / run width, m
  h: number // height, m
  sill?: string
  material?: string
}

/**
 * Deterministic opening tags + schedule rows: doors are placed components
 * (category 'Door'); windows are glazed wall segments (DocWall.glazing). Stable
 * order (top-to-bottom, left-to-right) → D01/D02…, W1/W2…, so each tag appears
 * once on the plan and once in the schedule.
 */
export function openingSchedule(state: DocState): Opening[] {
  const out: Opening[] = []
  const doors = (state.components as DocComponent[])
    .filter((c) => c.category === 'Door')
    .sort((a, b) => a.y - b.y || a.x - b.x)
  doors.forEach((d, i) => {
    const leaf = Math.max(d.w, d.h)
    out.push({
      tag: `D${String(i + 1).padStart(2, '0')}`,
      kind: 'Door',
      x: d.x,
      y: d.y,
      w: leaf,
      h: 2.1,
      material: 'Painted wood frame',
    })
  })
  const windows = state.walls
    .filter((w) => w.glazing === true)
    .map((w) => ({
      x: (w.a.x + w.b.x) / 2,
      y: (w.a.y + w.b.y) / 2,
      len: Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x)
  windows.forEach((w, i) => {
    out.push({
      tag: `W${i + 1}`,
      kind: 'Window',
      x: w.x,
      y: w.y,
      w: w.len,
      h: 1.5,
      sill: '+0.80',
      material: 'Glazed partition',
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// Shared plan-sheet layout
// ---------------------------------------------------------------------------

const PANEL_W = 316 // right-hand legend/schedule column (pt)

interface PlanBox {
  planX: number
  planY: number
  planW: number
  planH: number
  panelX: number
  panelW: number
}

function planBox(): PlanBox {
  const bandTop = PAGE_H - MARGIN - TITLE_BLOCK_H
  const planY = 66
  const planX = MARGIN + 6
  const panelX = PAGE_W - MARGIN - PANEL_W
  const planW = panelX - planX - 16
  const planH = bandTop - planY - 16
  return { planX, planY, planW, planH, panelX, panelW: PANEL_W }
}

/** world (m) → PDF top-down pt, given the plan raster's transform + placement. */
function worldMapper(
  b: PlanBox,
  wPx: number,
  hPx: number,
  k: number,
  ox: number,
  oy: number,
): (x: number, y: number) => { x: number; y: number } {
  const sx = b.planW / wPx
  const sy = b.planH / hPx
  return (x, y) => ({ x: b.planX + (x * k + ox) * sx, y: b.planY + (y * k + oy) * sy })
}

function tb(o: DrawingSetOpts, no: string, title: string, scale: string, keyPlan: PdfJpeg | null) {
  return {
    no,
    title,
    scale,
    keyPlan,
    studio: o.meta.studio,
    client: o.meta.client,
    project: o.meta.project,
    address: o.meta.address,
    revision: o.meta.revision,
    date: todayLabel(),
    drawnBy: o.meta.drawnBy,
    approvedBy: o.meta.approvedBy,
  }
}

/** Small swatch + label legend row. */
function legendRow(p: Page, x: number, yTop: number, sw: (px: number, py: number) => void, label: string): void {
  sw(x, yTop - 8)
  p.text(x + 30, yTop, 8.5, label, { gray: 0.25 })
}

/** Draw a room label + area at each non-circulation zone center. */
function roomLabels(p: Page, state: DocState, map: (x: number, y: number) => { x: number; y: number }): void {
  let n = 0
  for (const z of state.zones ?? []) {
    if (z.zone_type === 'Circulation') continue
    n++
    const c = zoneCenter(z.shape)
    const pt = map(c.x, c.y)
    const name = (z.label || `ROOM ${String(n).padStart(2, '0')}`).toUpperCase()
    p.text(pt.x, pt.y, 8, name, { align: 'center', bold: true, gray: 0.2 })
    p.text(pt.x, pt.y + 11, 7.5, `${zoneArea(z.shape).toFixed(1)} m²`, { align: 'center', gray: 0.4 })
  }
}

// ---------------------------------------------------------------------------
// Demolition plan (A.01)
// ---------------------------------------------------------------------------

function demolitionSheet(state: DocState, opts: DrawingSetOpts): Page {
  const p = new Page()
  const b = planBox()
  const wPx = Math.round(b.planW * RES)
  const hPx = Math.round(b.planH * RES)
  const demolished = demolishedWalls(state, opts.drawing)

  const { canvas, metersPerPx, k, ox, oy } = renderPrintCanvas(state, wPx, hPx, {
    layers: {
      zoneFill: false,
      furniture: false,
      roomLabels: false,
      existingWalls: true,
      generatedWalls: false,
      demolishHatch: true,
    },
    demolished,
  })
  p.image({ bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, b.planX, b.planY, b.planW, b.planH)
  const map = worldMapper(b, wPx, hPx, k, ox, oy)

  p.text(MARGIN + 6, 42, 15, 'DEMOLITION PLAN', { bold: true, gray: 0.1 })
  roomLabels(p, state, map)
  if (demolished.length === 0) {
    p.text(b.planX + 12, b.planY + b.planH - 14, 9, 'NO DEMOLITION (NEW BUILD)', { gray: 0.4, bold: true })
  }

  // Legend.
  let ly = b.planY + 20
  p.text(b.panelX + 8, ly, 10, 'LEGEND', { bold: true, gray: 0.3 })
  ly += 24
  legendRow(p, b.panelX + 8, ly, (px, py) => {
    p.box(px, py, 20, 10, { fill: false, gray: 0.1, width: 1 })
    p.line(px, py + 5, px + 20, py + 5, { gray: 0.6, width: 0.4 })
  }, 'Existing walls')
  ly += 22
  legendRow(p, b.panelX + 8, ly, (px, py) => {
    p.box(px, py, 20, 10, { fill: false, rgb: RED_DEMO, width: 1 })
    p.line(px, py, px + 20, py + 10, { rgb: RED_DEMO, width: 0.5 })
    p.line(px, py + 10, px + 20, py, { rgb: RED_DEMO, width: 0.5 })
  }, 'Demolished walls')
  ly += 34
  p.text(b.panelX + 8, ly, 9, 'DEMOLITION NOTES', { bold: true, gray: 0.3 })
  ly += 16
  const note = opts.drawing
    ? 'Existing interior partitions shown crossed in red are to be demolished to receive the new fit-out. Retained shell in grey.'
    : 'New build — no existing conditions to demolish. Shell shown in grey for reference.'
  for (const line of wrapText(note, 46)) {
    p.text(b.panelX + 8, ly, 8, line, { gray: 0.45 })
    ly += 13
  }

  const scaleN = planScaleN(metersPerPx, wPx, b.planW)
  titleBlock(p, tb(opts, 'A.01', 'Demolition Plan', scaleN ? `1:${scaleN}` : 'NTS', keyPlanJpeg(state, 'all', 340, 190)))
  return p
}

// ---------------------------------------------------------------------------
// Construction & furnishing plan (A.02)
// ---------------------------------------------------------------------------

function constructionSheet(state: DocState, opts: DrawingSetOpts): Page {
  const p = new Page()
  const b = planBox()
  const wPx = Math.round(b.planW * RES)
  const hPx = Math.round(b.planH * RES)

  const { canvas, metersPerPx, k, ox, oy } = renderPrintCanvas(state, wPx, hPx, {
    layers: {
      zoneFill: true,
      furniture: true,
      roomLabels: false,
      existingWalls: true,
      generatedWalls: true,
      newWallHighlight: true,
    },
  })
  p.image({ bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, b.planX, b.planY, b.planW, b.planH)
  const map = worldMapper(b, wPx, hPx, k, ox, oy)

  p.text(MARGIN + 6, 42, 15, 'CONSTRUCTION & FURNISHING PLAN', { bold: true, gray: 0.1 })
  roomLabels(p, state, map)

  // Opening tags on the plan (D01 circle, W1 hexagon).
  const openings = openingSchedule(state)
  for (const o of openings) {
    const pt = map(o.x, o.y)
    drawTagGlyph(p, pt.x, pt.y, o.tag, o.kind)
  }

  // Legend + schedule (right panel).
  let ly = b.planY + 20
  p.text(b.panelX + 8, ly, 10, 'LEGEND', { bold: true, gray: 0.3 })
  ly += 24
  legendRow(p, b.panelX + 8, ly, (px, py) => {
    p.box(px, py, 20, 10, { fill: false, gray: 0.1, width: 1 })
  }, 'Existing walls')
  ly += 20
  legendRow(p, b.panelX + 8, ly, (px, py) => {
    p.box(px, py, 20, 10, { fill: false, rgb: BLUE_WALL, width: 1.4 })
  }, 'New walls')
  ly += 20
  legendRow(p, b.panelX + 8, ly, (px, py) => {
    p.box(px, py, 20, 10, { fill: false, rgb: FURN, width: 0.8 })
  }, 'Furniture layout')
  ly += 26

  // Doors & windows specifications.
  p.text(b.panelX + 8, ly, 9, 'DOORS & WINDOWS SPECIFICATIONS', { bold: true, gray: 0.3 })
  ly += 8
  p.box(b.panelX + 8, ly, PANEL_W - 16, 13, { fill: true, gray: 0.93 })
  ly += 10
  p.text(b.panelX + 30, ly, 7, 'TAG', { bold: true, gray: 0.4 })
  p.text(b.panelX + 66, ly, 7, 'TYPE', { bold: true, gray: 0.4 })
  p.text(b.panelX + 118, ly, 7, 'SIZE (W×H)', { bold: true, gray: 0.4 })
  p.text(b.panelX + 200, ly, 7, 'MATERIAL / SILL', { bold: true, gray: 0.4 })
  ly += 4
  const rowH = 15
  if (openings.length === 0) {
    ly += rowH
    p.text(b.panelX + 30, ly, 8, 'No tagged openings in this fit.', { gray: 0.5 })
  }
  for (const o of openings) {
    ly += rowH
    drawTagGlyph(p, b.panelX + 18, ly - 3, o.tag, o.kind, 8)
    p.text(b.panelX + 30, ly, 7.5, o.tag, { gray: 0.2 })
    p.text(b.panelX + 66, ly, 7.5, o.kind, { gray: 0.2 })
    p.text(b.panelX + 118, ly, 7.5, `${o.w.toFixed(2)} × ${o.h.toFixed(2)} m`, { gray: 0.2 })
    p.text(b.panelX + 200, ly, 7, o.sill ? `${o.material} ${o.sill}` : (o.material ?? '-'), { gray: 0.35 })
    p.line(b.panelX + 8, ly + 4, b.panelX + PANEL_W - 8, ly + 4, { gray: 0.9, width: 0.4 })
  }

  const scaleN = planScaleN(metersPerPx, wPx, b.planW)
  titleBlock(
    p,
    tb(opts, 'A.02', 'Construction & Furnishing Plan', scaleN ? `1:${scaleN}` : 'NTS', keyPlanJpeg(state, 'all', 340, 190)),
  )
  return p
}

/** Tag glyph: circle for a door (D), hexagon for a window (W). */
function drawTagGlyph(p: Page, cx: number, cy: number, tag: string, kind: 'Door' | 'Window', size = 11): void {
  const r = size
  if (kind === 'Door') {
    p.box(cx - r, cy - r, r * 2, r * 2, { fill: true, gray: 1 })
    // Circle approximated by a rounded square token — the engine has no arc op;
    // a filled white box + border reads as the door bubble on the sheet.
    p.box(cx - r, cy - r, r * 2, r * 2, { fill: false, rgb: INK, width: 0.8 })
  } else {
    p.box(cx - r, cy - r * 0.86, r * 2, r * 1.72, { fill: true, gray: 1 })
    p.box(cx - r, cy - r * 0.86, r * 2, r * 1.72, { fill: false, rgb: BLUE_WALL, width: 0.8 })
  }
  p.text(cx, cy + size * 0.32, size * 0.72, tag, { align: 'center', bold: true, gray: 0.12 })
}

// ---------------------------------------------------------------------------
// Cover + contents (front matter)
// ---------------------------------------------------------------------------

function coverSheet(state: DocState, opts: DrawingSetOpts): Page {
  const p = new Page()
  const m = opts.meta

  // Hero plan on the left ~58%.
  const heroX = MARGIN
  const heroY = 150
  const heroW = PAGE_W * 0.56
  const heroH = PAGE_H - heroY - MARGIN - 40
  const wPx = Math.round(heroW * RES)
  const hPx = Math.round(heroH * RES)
  const { canvas } = renderPrintCanvas(state, wPx, hPx)
  p.box(heroX, heroY, heroW, heroH, { fill: true, gray: 0.97 })
  p.image({ bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, heroX, heroY, heroW, heroH)
  p.box(heroX, heroY, heroW, heroH, { fill: false, gray: 0.82, width: 1 })

  // Right column — brand, title, concept.
  const rx = heroX + heroW + 40
  p.text(MARGIN, MARGIN + 20, 16, m.studio ?? 'dsource', { bold: true, rgb: ACCENT })
  p.text(MARGIN + 90, MARGIN + 20, 10, 'DRAWING SET', { gray: 0.5 })

  let y = 210
  if (m.client) {
    p.text(rx, y, 15, m.client, { gray: 0.35 })
    y += 30
  }
  p.box(rx, y - 6, 44, 3, { fill: true, rgb: ACCENT })
  y += 24
  p.text(rx, y, 30, m.project, { bold: true, gray: 0.05 })
  y += 34
  if (m.address) {
    p.text(rx, y, 12, m.address, { gray: 0.4 })
    y += 22
  }
  if (m.floor) {
    p.text(rx, y, 12, m.floor, { bold: true, gray: 0.2 })
    y += 30
  }
  const concept =
    m.style
      ? `${m.style} — a workspace test-fit tuned for circulation, daylight and density.`
      : 'An office test-fit tuned for circulation, daylight and density, issued as a coordinated drawing set.'
  y += 10
  for (const line of wrapText(concept, 42)) {
    p.text(rx, y, 11, line, { gray: 0.4 })
    y += 16
  }

  p.text(MARGIN, PAGE_H - MARGIN, 9, `ARCHITECTURAL DRAWING SET  ·  ${todayLabel()}  ·  GENERATED BY DSOURCE EDITOR`, {
    gray: 0.5,
  })
  return p
}

function contentsSheet(opts: DrawingSetOpts): Page {
  const p = new Page()
  p.text(MARGIN, MARGIN + 30, 34, 'Contents', { bold: true, gray: 0.08 })
  p.text(MARGIN, MARGIN + 60, 12, opts.meta.project, { gray: 0.4 })

  const items: { title: string; no: string }[] = [
    { title: 'Cover', no: '—' },
    { title: 'Contents', no: '—' },
    { title: 'Demolition Plan', no: 'A.01' },
    { title: 'Construction & Furnishing Plan', no: 'A.02' },
  ]
  let y = 150
  const x0 = MARGIN + 10
  const x1 = PAGE_W - MARGIN - 10
  for (const it of items) {
    p.text(x0, y, 14, it.title, { gray: 0.2 })
    p.text(x1, y, 14, it.no, { align: 'right', bold: true, gray: 0.15 })
    // Dotted leader.
    p.line(x0 + 240, y - 3, x1 - 40, y - 3, { gray: 0.8, width: 0.5 })
    y += 34
  }
  p.text(MARGIN, PAGE_H - MARGIN, 9, 'DRAWING SET CONTENTS  ·  GENERATED BY DSOURCE EDITOR', { gray: 0.5 })
  return p
}

// ---------------------------------------------------------------------------
// Text wrap (Helvetica estimate, ~chars-per-line)
// ---------------------------------------------------------------------------

function wrapText(s: string, maxChars: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) lines.push(cur)
      cur = w
    } else {
      cur = (cur + ' ' + w).trim()
    }
  }
  if (cur) lines.push(cur)
  return lines
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Build the drawing-set PDF bytes: cover · contents · demolition · construction. */
export function buildDrawingSetPdf(state: DocState, opts: DrawingSetOpts): Uint8Array<ArrayBuffer> {
  const toPage = (pg: Page): PdfPage => ({ ops: pg.ops, images: pg.images })
  const pages: PdfPage[] = [
    toPage(coverSheet(state, opts)),
    toPage(contentsSheet(opts)),
    toPage(demolitionSheet(state, opts)),
    toPage(constructionSheet(state, opts)),
  ]
  return buildMultiPagePdfBytes(pages)
}

/** Build the drawing set and download it. */
export async function exportDrawingSet(
  state: DocState,
  opts: DrawingSetOpts,
  filename = 'dsource-drawing-set.pdf',
): Promise<void> {
  const bytes = buildDrawingSetPdf(state, opts)
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename)
}
