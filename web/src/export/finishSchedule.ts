// Room Finish Schedule sheet(s) for the drawing set — the tabular deliverable
// every architectural set carries: one row per room listing its floor / base /
// wall / ceiling finishes, ceiling height and enclosed area (the schedule that
// Rayon / Qbiq sets include). It complements the graphic sheets (plans, RCP,
// power, sections) with the written finish specification a contractor prices
// against (docs/design/drawing-set-generator.md §1.3).
//
// SELF-CONTAINED: this module owns nothing the drawing-set agents own. It reuses
// the shared sheet primitives (sheet.ts Page/titleBlock/keyPlanJpeg/ACCENT) and
// the PDF text helpers (pdf.ts textWidth/pdfSafeText) READ-ONLY, pulls the
// canonical CEILING_HEIGHT from services.ts so the schedule and the RCP never
// drift, and returns finished `Page`s the orchestrator drops straight into
// buildDrawingSetPdf's page list — mirroring export/section.ts and
// export/servicesSheets.ts exactly.
//
// ── Wire-in (in sheetSet.ts buildDrawingSetPdf, alongside the other sheets) ──
//   import { finishScheduleSheets } from './finishSchedule'
//   ...
//   if (want('finishes')) {
//     try {
//       for (const s of finishScheduleSheets(state, { meta: opts.meta, startNo: numbered.length })) {
//         numbered.push({ title: s.title, no: s.no, page: s.page })
//       }
//     } catch (err) {
//       console.warn('drawing-set: finish schedule skipped —', err)
//     }
//   }
// (self-numbers A.(startNo+i+1); pass startNo=numbered.length so the sheets take
// the next free slots and the contents list stays in sync. Continuation sheets
// take further slots automatically.)
//
// Manifest row to add to sheetManifest.ts SHEET_MANIFEST (id 'finishes'):
//   { id: 'finishes', no: 'A.NN', title: 'Room Finish Schedule', kind: 'schedule',
//     blurb: 'Per-room floor / base / wall / ceiling finishes · area', available: true }
// ('schedule' is a new SheetKind — add it to the SheetKind union, or reuse
// 'furniture' if you would rather not widen the type.)

import { PAGE_W, PAGE_H, textWidth, pdfSafeText } from './pdf'
import type { PdfJpeg } from './pdf'
import {
  Page,
  MARGIN,
  ACCENT,
  keyPlanJpeg,
  titleBlock,
  TITLE_BLOCK_H,
  type TitleBlockInfo,
} from './sheet'
import type { SheetSetMeta } from './sheetSet'
import type { DocState, DocZone } from '../editor/EditorCanvas'
import { zoneArea as zoneShapeArea } from '../util/zoneGeom'
import { CEILING_HEIGHT } from './services'

export interface FinishScheduleOpts {
  meta: SheetSetMeta
  /** First sheet-number index (produces `A.0(startNo+1)`, …). Default 4, so it
   *  can follow a 2-plan set + two default sections; the orchestrator passes
   *  `startNo = numbered.length` to take the next free slots. Continuation
   *  sheets consume the slots after it. */
  startNo?: number
}

/** One finished finish-schedule sheet + the metadata the orchestrator/contents need. */
export interface FinishSheet {
  page: Page
  no: string // 'A.06'
  title: string // 'Room Finish Schedule'
  kind: 'finishes'
}

// ---------------------------------------------------------------------------
// Finish vocabulary — a deterministic India-market spec keyed by room type.
// No randomness, no dates: the same document always yields the same schedule.
// Cell abbreviations (CPT, LVT, VIT, GYP, MR board, R10, AFF …) are expanded
// in the FINISH LEGEND / NOTES footer block on every sheet.
// ---------------------------------------------------------------------------

type FinishKey =
  | 'workspace'
  | 'conference'
  | 'boardroom'
  | 'cabin'
  | 'reception'
  | 'pantry'
  | 'toilet'
  | 'phonebooth'
  | 'focus'
  | 'collab'
  | 'wellness'
  | 'storage'
  | 'itserver'
  | 'print'
  | 'core'
  | 'other'

interface FinishSpec {
  floor: string
  base: string // skirting
  wall: string
  ceiling: string
}

/** The finish spec for every room type (floor · base/skirting · wall · ceiling). */
const FINISH_SPEC: Record<FinishKey, FinishSpec> = {
  workspace: {
    floor: 'Carpet tile 500×500 (CPT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum board (GYP)',
    ceiling: 'Metal grid 600×600 (MGC)',
  },
  conference: {
    floor: 'Carpet tile 500×500 (CPT)',
    base: 'PVC skirting 100 mm',
    wall: 'Acoustic fabric panel (ACP)',
    ceiling: 'Painted gypsum, cove (GYP)',
  },
  boardroom: {
    floor: 'Carpet tile, premium (CPT)',
    base: 'Timber skirting 75 mm',
    wall: 'Timber veneer + acoustic (ACP)',
    ceiling: 'Gypsum + linear light (GYP)',
  },
  cabin: {
    floor: 'Engineered timber (TIM)',
    base: 'Timber skirting 75 mm',
    wall: 'Painted gypsum board (GYP)',
    ceiling: 'Painted gypsum board (GYP)',
  },
  reception: {
    floor: 'Porcelain stone, LF (POR)',
    base: 'Stone skirting 100 mm',
    wall: 'Feature veneer / backlit',
    ceiling: 'Suspended gypsum (GYP)',
  },
  pantry: {
    floor: 'Anti-skid vitrified tile (VIT)',
    base: 'Ceramic tile skirting',
    wall: 'Ceramic splashback / paint (CER)',
    ceiling: 'MR gypsum board (MRB)',
  },
  toilet: {
    floor: 'Anti-skid ceramic, R10 (CER)',
    base: 'Ceramic tile skirting',
    wall: 'Full-height ceramic tile (CER)',
    ceiling: 'MR grid / board (MRB)',
  },
  phonebooth: {
    floor: 'Carpet tile 500×500 (CPT)',
    base: 'PVC skirting 100 mm',
    wall: 'Upholstered acoustic panel (ACP)',
    ceiling: 'Acoustic pad (ACP)',
  },
  focus: {
    floor: 'Carpet tile 500×500 (CPT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum + pinboard (GYP)',
    ceiling: 'Metal grid 600×600 (MGC)',
  },
  collab: {
    floor: 'Luxury vinyl tile (LVT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum, accent (GYP)',
    ceiling: 'Exposed services, painted',
  },
  wellness: {
    floor: 'Cushioned vinyl (LVT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum, calm tone (GYP)',
    ceiling: 'Painted gypsum board (GYP)',
  },
  storage: {
    floor: 'Sealed vinyl / screed (VNL)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted masonry',
    ceiling: 'Exposed slab / grid',
  },
  itserver: {
    floor: 'Anti-static vinyl (VNL)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum, FR (GYP)',
    ceiling: 'Exposed slab, painted',
  },
  print: {
    floor: 'Luxury vinyl tile (LVT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum board (GYP)',
    ceiling: 'Metal grid 600×600 (MGC)',
  },
  core: {
    floor: 'Cement screed, sealed',
    base: 'Cement skirting 100 mm',
    wall: 'Painted masonry',
    ceiling: 'Exposed slab',
  },
  other: {
    floor: 'Carpet tile 500×500 (CPT)',
    base: 'PVC skirting 100 mm',
    wall: 'Painted gypsum board (GYP)',
    ceiling: 'Metal grid 600×600 (MGC)',
  },
}

/** Human room-type label shown in the schedule's Room Type column. */
const TYPE_LABEL: Record<FinishKey, string> = {
  workspace: 'Open Workspace',
  conference: 'Conference',
  boardroom: 'Boardroom',
  cabin: 'Cabin / Office',
  reception: 'Reception',
  pantry: 'Pantry / Kitchen',
  toilet: 'Toilet',
  phonebooth: 'Phone Booth',
  focus: 'Focus Room',
  collab: 'Collaboration',
  wellness: 'Wellness',
  storage: 'Storage',
  itserver: 'IT / Server',
  print: 'Print / Copy',
  core: 'Service Core',
  other: 'Other',
}

/**
 * Infer a room's finish type from its label first (the generator names zones
 * "Reception", "Pantry", "Cabin 2", "Phone Booth 3", "Focus 1", "Meeting Room 4"
 * …), falling back to the broad `zone_type`. Deterministic — pure string match.
 */
function finishTypeFor(z: DocZone): FinishKey {
  const raw = z.label ?? ''
  const l = raw.toLowerCase()
  if (l.includes('reception')) return 'reception'
  if (l.includes('board')) return 'boardroom'
  if (l.includes('meeting')) return 'conference'
  if (l.includes('cabin')) return 'cabin'
  if (l.includes('phone') || l.includes('booth')) return 'phonebooth'
  if (l.includes('focus')) return 'focus'
  if (l.includes('pantry') || l.includes('kitchen')) return 'pantry'
  if (l.includes('toilet') || l.includes('washroom') || l.includes('restroom') || /\bwc\b/.test(l)) return 'toilet'
  if (l.includes('wellness') || l.includes('mother')) return 'wellness'
  if (raw.startsWith('IT') || l.includes('server')) return 'itserver'
  if (l.includes('storage') || l.includes('store')) return 'storage'
  if (l.includes('print') || l.includes('copy')) return 'print'
  if (l.includes('collab') || l.includes('breakout') || l.includes('lounge')) return 'collab'
  switch (z.zone_type) {
    case 'Workspace':
      return 'workspace'
    case 'Meeting':
      return 'conference'
    case 'Collaboration':
      return 'collab'
    case 'ClosedOffice':
      return 'cabin'
    case 'Amenity':
      return 'pantry'
    case 'Core':
      return 'core'
    default:
      return 'other'
  }
}

/** Enclosed area (m²) of a zone shape; rings exclude the hole, polys shoelace. */
const zoneArea = zoneShapeArea

// ---------------------------------------------------------------------------
// One schedule row — a resolved room ready to draw.
// ---------------------------------------------------------------------------

interface Row {
  id: number
  name: string
  type: string
  spec: FinishSpec
  ceilHt: string
  area: string
}

/** Resolve every non-circulation zone into a schedule row (deterministic order:
 *  by zone id). Circulation is corridor / "walking place" — graphic on the plan,
 *  not a scheduled room — so it is excluded, matching roomLabels/servicesSheets. */
function scheduleRows(state: DocState): Row[] {
  const zones = (state.zones ?? []).filter((z) => z.zone_type !== 'Circulation')
  const ordered = [...zones].sort((a, b) => a.id - b.id)
  let n = 0
  return ordered.map((z) => {
    n++
    const key = finishTypeFor(z)
    const name = (z.label && z.label.trim()) || `Room ${String(n).padStart(2, '0')}`
    return {
      id: z.id,
      name,
      type: TYPE_LABEL[key],
      spec: FINISH_SPEC[key],
      ceilHt: `${CEILING_HEIGHT.toFixed(2)} m`,
      area: zoneArea(z.shape).toFixed(1),
    }
  })
}

// ---------------------------------------------------------------------------
// Table geometry + drawing (matches the door/window & services schedules:
// gray header band, bold headers, ruled rows, right-aligned numerics).
// ---------------------------------------------------------------------------

interface Col {
  header: string
  w: number
  align?: 'right'
}

// Left-to-right; widths (pt) sum ≤ table width (A3 landscape, ~1066 of ~1098).
const COLS: Col[] = [
  { header: 'ID', w: 46 },
  { header: 'ROOM NAME', w: 150 },
  { header: 'ROOM TYPE', w: 120 },
  { header: 'FLOOR FINISH', w: 168 },
  { header: 'BASE / SKIRTING', w: 132 },
  { header: 'WALL FINISH', w: 168 },
  { header: 'CEILING FINISH', w: 160 },
  { header: 'CLG HT', w: 56, align: 'right' },
  { header: 'AREA m²', w: 66, align: 'right' },
]

const TABLE_X = MARGIN + 6
const HEADER_TOP = 64
const HEADER_H = 16
const ROW_H = 17
const FOOTER_H = 88 // legend/notes strip above the title block
const BAND_TOP = PAGE_H - MARGIN - TITLE_BLOCK_H
const ROWS_TOP = HEADER_TOP + HEADER_H + 3
const ROWS_BOTTOM = BAND_TOP - FOOTER_H - 8
const MAX_ROWS = Math.max(1, Math.floor((ROWS_BOTTOM - ROWS_TOP) / ROW_H))

/** Cumulative left-x of each column. */
function colXs(): number[] {
  const xs: number[] = []
  let x = TABLE_X
  for (const c of COLS) {
    xs.push(x)
    x += c.w
  }
  return xs
}

/** Truncate to fit `maxW` pt (Helvetica advance estimate), "…"-clipped.
 *  Uses "..." (not U+2026) so the glyph stays in WinAnsi/Helvetica. */
function clip(s: string, size: number, bold: boolean, maxW: number): string {
  if (textWidth(pdfSafeText(s), size, bold) <= maxW) return s
  let t = s
  while (t.length > 1 && textWidth(pdfSafeText(t + '...'), size, bold) > maxW) t = t.slice(0, -1)
  return t + '...'
}

function drawHeader(p: Page): void {
  const xs = colXs()
  const tableW = COLS.reduce((t, c) => t + c.w, 0)
  p.box(TABLE_X, HEADER_TOP, tableW, HEADER_H, { fill: true, gray: 0.92 })
  p.box(TABLE_X, HEADER_TOP, tableW, HEADER_H, { fill: false, gray: 0.6, width: 0.6 })
  const ty = HEADER_TOP + 11
  COLS.forEach((c, i) => {
    if (c.align === 'right') {
      p.text(xs[i] + c.w - 6, ty, 7, c.header, { bold: true, align: 'right', gray: 0.35 })
    } else {
      p.text(xs[i] + 6, ty, 7, c.header, { bold: true, gray: 0.35 })
    }
  })
}

function drawRow(p: Page, r: Row, yTop: number, zebra: boolean): void {
  const xs = colXs()
  const tableW = COLS.reduce((t, c) => t + c.w, 0)
  if (zebra) p.box(TABLE_X, yTop - ROW_H + 4, tableW, ROW_H, { fill: true, gray: 0.975 })
  const ty = yTop
  const cells: { text: string; bold?: boolean; gray: number }[] = [
    { text: String(r.id), gray: 0.15, bold: true },
    { text: r.name, gray: 0.12, bold: true },
    { text: r.type, gray: 0.3 },
    { text: r.spec.floor, gray: 0.3 },
    { text: r.spec.base, gray: 0.3 },
    { text: r.spec.wall, gray: 0.3 },
    { text: r.spec.ceiling, gray: 0.3 },
    { text: r.ceilHt, gray: 0.15 },
    { text: r.area, gray: 0.1, bold: true },
  ]
  COLS.forEach((c, i) => {
    const cell = cells[i]
    const size = 7.5
    if (c.align === 'right') {
      p.text(xs[i] + c.w - 6, ty, size, clip(cell.text, size, cell.bold ?? false, c.w - 8), {
        align: 'right',
        bold: cell.bold,
        gray: cell.gray,
      })
    } else {
      p.text(xs[i] + 6, ty, size, clip(cell.text, size, cell.bold ?? false, c.w - 10), {
        bold: cell.bold,
        gray: cell.gray,
      })
    }
  })
  // Row rule.
  p.line(TABLE_X, yTop + 4, TABLE_X + tableW, yTop + 4, { gray: 0.9, width: 0.4 })
}

/** Finish-code legend + general notes, in the reserved footer strip. */
function drawLegend(p: Page): void {
  const top = BAND_TOP - FOOTER_H
  const tableW = COLS.reduce((t, c) => t + c.w, 0)
  p.line(TABLE_X, top, TABLE_X + tableW, top, { rgb: ACCENT, width: 1 })
  let y = top + 12
  p.text(TABLE_X, y, 8, 'FINISH LEGEND', { bold: true, gray: 0.3 })
  p.text(TABLE_X + tableW / 2 + 20, y, 8, 'GENERAL NOTES', { bold: true, gray: 0.3 })
  y += 12

  const codes: [string, string][] = [
    ['CPT', 'Carpet tile, medium loop'],
    ['LVT', 'Luxury vinyl tile / plank'],
    ['VIT', 'Vitrified tile, anti-skid'],
    ['POR', 'Porcelain / stone, large fmt'],
    ['TIM', 'Engineered timber, matt'],
    ['CER', 'Ceramic wall / floor tile'],
    ['VNL', 'Sealed / anti-static vinyl'],
    ['GYP', 'Painted gypsum plasterboard'],
    ['ACP', 'Acoustic / upholstered panel'],
    ['MGC', 'Metal grid ceiling 600×600'],
    ['MRB', 'Moisture-resistant board'],
  ]
  const notes = [
    `Ceiling ht ${CEILING_HEIGHT.toFixed(2)} m AFF unless noted (per RCP).`,
    'Skirting 100 mm; timber 75 mm to cabins/boardroom.',
    'Wet areas: anti-skid R10 floors, tiled full height.',
    'Paint: low-VOC acrylic emulsion, matt, off-white.',
  ]

  // Legend codes — two columns on the left half.
  const legX = TABLE_X
  const colW = 175
  codes.forEach(([code, desc], i) => {
    const cx = legX + (i % 2) * colW
    const cy = y + Math.floor(i / 2) * 10
    p.text(cx, cy, 6.5, code, { bold: true, gray: 0.25 })
    p.text(cx + 28, cy, 6.5, desc, { gray: 0.45 })
  })

  // Notes — right half.
  const noteX = TABLE_X + tableW / 2 + 20
  notes.forEach((n, i) => {
    // "·" (U+00B7) is in WinAnsi; "•" (U+2022) is not, so it renders as "?".
    p.text(noteX, y + i * 11, 7, `·  ${n}`, { gray: 0.4 })
  })
}

// ---------------------------------------------------------------------------
// Sheet assembly
// ---------------------------------------------------------------------------

function todayLabel(): string {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function tb(meta: SheetSetMeta, no: string, title: string, scale: string, keyPlan: PdfJpeg | null): TitleBlockInfo {
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

/** Build one schedule page (a slice of rows), with header + legend. */
function schedulePage(
  state: DocState,
  rows: Row[],
  no: string,
  pageIdx: number,
  pageCount: number,
  opts: FinishScheduleOpts,
): Page {
  const p = new Page()
  const cont = pageIdx > 0 ? ' (CONT.)' : ''
  p.text(MARGIN + 6, 42, 15, `ROOM FINISH SCHEDULE${cont}`, { bold: true, gray: 0.1 })
  if (pageCount > 1) {
    p.text(PAGE_W - MARGIN - 6, 42, 9, `SHEET ${pageIdx + 1} OF ${pageCount}`, { align: 'right', gray: 0.4, bold: true })
  }

  drawHeader(p)
  let y = ROWS_TOP + ROW_H - 4
  rows.forEach((r, i) => {
    drawRow(p, r, y, i % 2 === 1)
    y += ROW_H
  })
  drawLegend(p)

  const hasPlan = state.walls.length > 0
  titleBlock(p, tb(opts.meta, no, 'Room Finish Schedule', 'NTS', hasPlan ? keyPlanJpeg(state, 'all', 340, 190) : null))
  return p
}

/** The graceful empty-state sheet — no rooms to schedule. */
function emptySheet(state: DocState, no: string, opts: FinishScheduleOpts): Page {
  const p = new Page()
  p.text(MARGIN + 6, 42, 15, 'ROOM FINISH SCHEDULE', { bold: true, gray: 0.1 })
  const tableW = COLS.reduce((t, c) => t + c.w, 0)
  const boxY = HEADER_TOP + 40
  const boxH = 120
  p.box(TABLE_X, boxY, tableW, boxH, { fill: true, gray: 0.97 })
  p.text(TABLE_X + tableW / 2, boxY + boxH / 2, 13, 'NO ROOMS SCHEDULED', { align: 'center', bold: true, gray: 0.45 })
  p.text(TABLE_X + tableW / 2, boxY + boxH / 2 + 18, 9, 'Generate a test-fit to populate the finish schedule.', {
    align: 'center',
    gray: 0.5,
  })
  const hasPlan = state.walls.length > 0
  titleBlock(p, tb(opts.meta, no, 'Room Finish Schedule', 'NTS', hasPlan ? keyPlanJpeg(state, 'all', 340, 190) : null))
  return p
}

/**
 * Build the Room Finish Schedule sheet(s) for the drawing set — one A3 table
 * with a row per room (floor / base / wall / ceiling finishes, ceiling height,
 * area), paginated onto continuation sheets when the room count overflows a
 * page. Returns finished {@link Page}s (plus kind/no/title metadata) the
 * orchestrator drops into `buildDrawingSetPdf`'s page list (see the wire-in note
 * at the top of this file). Never throws: no rooms yields a single graceful
 * "NO ROOMS SCHEDULED" sheet.
 *
 * @example
 *   const sheets = finishScheduleSheets(state, { meta, startNo: numbered.length })
 *   for (const s of sheets) numbered.push({ title: s.title, no: s.no, page: s.page })
 */
export function finishScheduleSheets(state: DocState, opts: FinishScheduleOpts): FinishSheet[] {
  const start = opts.startNo ?? 4
  const no = (i: number) => `A.${String(start + i + 1).padStart(2, '0')}`

  const rows = scheduleRows(state)
  if (rows.length === 0) {
    return [{ page: emptySheet(state, no(0), opts), no: no(0), title: 'Room Finish Schedule', kind: 'finishes' }]
  }

  // Paginate at MAX_ROWS rows per page.
  const pages: Row[][] = []
  for (let i = 0; i < rows.length; i += MAX_ROWS) pages.push(rows.slice(i, i + MAX_ROWS))

  return pages.map((slice, i) => ({
    page: schedulePage(state, slice, no(i), i, pages.length, opts),
    no: no(i),
    title: 'Room Finish Schedule',
    kind: 'finishes' as const,
  }))
}
