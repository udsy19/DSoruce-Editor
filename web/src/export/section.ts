// Section / elevation sheets for the drawing set — the "wow" architectural page
// (docs/design/drawing-set-generator.md §1.4 / M4). Each sheet embeds an
// orthographic SECTION rendered from the document by three/sectionRender.ts
// (walls in poché, furniture beyond in elevation, floor/ceiling datum, height
// dims, scale figures) on the LEFT, with a description + material-note panel on
// the RIGHT and the shared Studio-Nova title block at the bottom — identical
// furniture to every other sheet, differing only in title / scale / sheet no.
//
// SELF-CONTAINED: this module owns nothing the drawing-set agents own. It reuses
// the shared sheet primitives (sheet.ts Page/titleBlock/keyPlanJpeg) and the PDF
// raster helpers (pdf.ts canvasToJpeg/planScaleN) READ-ONLY, and returns finished
// `Page`s the orchestrator drops straight into buildDrawingSetPdf's page list.
//
// ── Wire-in (one call, in sheetSet.ts buildDrawingSetPdf) ────────────────────
//   import { sectionSheets } from './section'
//   ...
//   const pages: PdfPage[] = [
//     toPage(coverSheet(state, opts)),
//     toPage(contentsSheet(opts)),
//     toPage(demolitionSheet(state, opts)),
//     toPage(constructionSheet(state, opts)),
//     // append the section sheets (numbered after the plans):
//     ...sectionSheets(state, { meta: opts.meta, startNo: 3 }).map((s) => toPage(s.page)),
//   ]
// where `toPage = (pg: Page): PdfPage => ({ ops: pg.ops, images: pg.images })`
// (already defined in sheetSet.ts). Add the two "Sections … A.0N" rows to the
// contents list to match.

import { PAGE_W, PAGE_H } from './pdfDoc'
import { canvasToJpeg, planScaleN } from './printPlan'
import {
  Page,
  MARGIN,
  RES,
  ACCENT,
  keyPlanJpeg,
  titleBlock,
  TITLE_BLOCK_H,
  type KeyRegion,
  type TitleBlockInfo,
} from './sheet'
import type { SheetSetMeta } from './sheetSet'
import { renderSection, defaultCuts, type SectionCut } from '../three/sectionRender'
import type { DocState } from '../types/doc'
export interface SectionSheetsOpts {
  meta: SheetSetMeta
  /** Cut planes to draw. Default: a longitudinal + a cross cut through centre
   *  ({@link defaultCuts}). */
  cuts?: SectionCut[]
  /** First sheet-number index (produces `A.0(startNo+1)`, …). Default 3, so the
   *  sections follow a 2-plan set (demolition A.01, construction A.02). */
  startNo?: number
  /** Force the Canvas2D fallback in the section renderer (testing / headless). */
  forceCanvas2D?: boolean
}

/** One finished section sheet + the metadata the orchestrator/contents need. */
export interface SectionSheet {
  page: Page
  no: string // 'A.03'
  title: string // 'Sections'
  cutLabel: string // 'A' — the "SECTION A-A" this sheet carries
  scale: string // '1:60'
  /** Which massing path the renderer used — 'webgl' or 'canvas2d' (fallback). */
  path: 'webgl' | 'canvas2d'
}

const PANEL_W = 300

function todayLabel(): string {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** Build the shared title-block info for a section sheet (mirrors sheetSet.tb). */
function tb(meta: SheetSetMeta, no: string, title: string, scale: string, keyPlan: TitleBlockInfo['keyPlan']): TitleBlockInfo {
  return {
    no,
    title,
    scale,
    keyPlan,
    studio: meta.studio,
    client: meta.client,
    project: meta.project,
    address: meta.address,
    revision: meta.revision,
    date: todayLabel(),
    drawnBy: meta.drawnBy,
    approvedBy: meta.approvedBy,
  }
}

/** Whole-plate bbox (m) of the walls — for the key-plan cut strip. */
function wallBounds(state: DocState): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of state.walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/** Key-plan highlight for a cut: a thin strip along the cut line across the plate. */
function cutRegion(state: DocState, cut: SectionCut): KeyRegion {
  const b = wallBounds(state)
  if (!b) return 'all'
  const thick = 0.6
  return cut.axis === 'y'
    ? { x: b.minX, y: cut.position - thick / 2, w: b.maxX - b.minX, h: thick }
    : { x: cut.position - thick / 2, y: b.minY, w: thick, h: b.maxY - b.minY }
}

/** Minimal word-wrap to a character budget (Helvetica estimate; local because
 *  sheetSet.ts owns — and does not export — its copy). */
function wrap(s: string, maxChars: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) lines.push(cur)
      cur = w
    } else cur = (cur + ' ' + w).trim()
  }
  if (cur) lines.push(cur)
  return lines
}

/** Build one A3 section sheet for a single cut. */
function sectionSheet(state: DocState, cut: SectionCut, no: string, opts: SectionSheetsOpts): SectionSheet {
  const p = new Page()

  // Left: the section raster. Right: a description/notes panel. Bottom: title block.
  const bandTop = PAGE_H - MARGIN - TITLE_BLOCK_H
  const drawY = 66
  const drawX = MARGIN + 6
  const panelX = PAGE_W - MARGIN - PANEL_W
  const drawW = panelX - drawX - 16
  const drawH = bandTop - drawY - 16

  const wPx = Math.round(drawW * RES)
  const hPx = Math.round(drawH * RES)
  const sec = renderSection(state, cut, wPx, hPx, { forceCanvas2D: opts.forceCanvas2D })
  p.image({ bytes: canvasToJpeg(sec.canvas), width: wPx, height: hPx }, drawX, drawY, drawW, drawH)
  p.box(drawX, drawY, drawW, drawH, { fill: false, gray: 0.82, width: 0.8 })

  p.text(MARGIN + 6, 42, 15, 'SECTIONS', { bold: true, gray: 0.1 })
  const orient = cut.axis === 'y' ? 'Longitudinal' : 'Cross'

  // Right panel — heading, description, material notes.
  let y = drawY + 4
  p.text(panelX + 8, y, 13, `SECTION ${cut.label}-${cut.label}`, { bold: true, gray: 0.12 })
  y += 8
  p.box(panelX + 8, y, 40, 3, { fill: true, rgb: ACCENT })
  y += 20
  p.text(panelX + 8, y, 8, `${orient.toUpperCase()} CUT`, { gray: 0.45, bold: true })
  y += 20

  const desc =
    `A ${orient.toLowerCase()} section cut through the fit-out at floor-to-ceiling ` +
    `height 2.60 m. Walls at the cut are shown in poché; partitions and furniture ` +
    `beyond read in elevation, fading with depth. Scale figures set the human dimension.`
  for (const line of wrap(desc, 44)) {
    p.text(panelX + 8, y, 8.5, line, { gray: 0.4 })
    y += 13
  }
  y += 12

  p.text(panelX + 8, y, 9, 'MATERIAL NOTES', { bold: true, gray: 0.3 })
  y += 8
  const notes: [string, string][] = [
    ['WALLS', 'Painted plasterboard on stud, matte off-white finish.'],
    ['FLOOR', 'Carpet tile on levelling screed; F.F.L ±0.00.'],
    ['CEILING', 'Suspended acoustic panel, underside at +2.60.'],
    ['GLAZING', 'Framed glass partitions to enclosed rooms where shown.'],
  ]
  for (const [k, v] of notes) {
    y += 15
    p.text(panelX + 8, y, 7.5, k, { bold: true, gray: 0.35 })
    let ny = y
    for (const line of wrap(v, 40)) {
      p.text(panelX + 60, ny, 7.5, line, { gray: 0.45 })
      ny += 11
    }
    y = ny - 11 + 4
    p.line(panelX + 8, y + 3, panelX + PANEL_W - 8, y + 3, { gray: 0.9, width: 0.4 })
  }

  const scaleN = planScaleN(sec.metersPerPx, wPx, drawW)
  const scale = scaleN ? `1:${scaleN}` : 'NTS'
  titleBlock(p, tb(opts.meta, no, 'Sections', scale, keyPlanJpeg(state, cutRegion(state, cut), 340, 190)))

  return { page: p, no, title: 'Sections', cutLabel: cut.label, scale, path: sec.path }
}

/**
 * Build the section sheets for the drawing set — one A3 sheet per cut. Returns
 * finished {@link Page}s (plus the cut/scale/path metadata) the orchestrator
 * drops into `buildDrawingSetPdf`'s page list (see the wire-in note at the top
 * of this file). Never throws: the renderer falls back to Canvas2D where WebGL
 * is unavailable, and `path` reports which ran.
 *
 * @example
 *   const sheets = sectionSheets(state, { meta })
 *   pages.push(...sheets.map((s) => ({ ops: s.page.ops, images: s.page.images })))
 */
export function sectionSheets(state: DocState, opts: SectionSheetsOpts): SectionSheet[] {
  const cuts = opts.cuts ?? defaultCuts(state)
  const start = opts.startNo ?? 3
  return cuts.map((cut, i) => {
    const no = `A.${String(start + i + 1).padStart(2, '0')}`
    return sectionSheet(state, cut, no, opts)
  })
}
