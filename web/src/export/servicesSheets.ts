// MEP / services sheets for the drawing set — a Reflected Ceiling Plan (RCP)
// and a Power & Data plan, the technical half of an architectural set
// (docs/design/drawing-set-generator.md §1.3 c/d + §M5). Each sheet embeds a
// faint base plan (renderPrintCanvas with a muted layer set), overlays the
// derived services fixtures (services.ts) as vector glyphs on a ceiling / point
// grid, and carries a fixture legend + count schedule beside the shared
// Studio-Nova title block + key plan — identical furniture to every other
// sheet, differing only in title / content / sheet no.
//
// SELF-CONTAINED: this module owns nothing the drawing-set agents own. It reuses
// the shared sheet primitives (sheet.ts Page/titleBlock/keyPlanJpeg) and the PDF
// raster helpers (pdf.ts renderPrintCanvas/canvasToJpeg/planScaleN) READ-ONLY,
// and returns finished `Page`s the orchestrator drops straight into
// buildDrawingSetPdf's page list — mirroring export/section.ts exactly.
//
// ── Wire-in (in sheetSet.ts buildDrawingSetPdf, AFTER the moodboard add) ─────
//   import { servicesSheets } from './servicesSheets'
//   ...
//   if (want('rcp') || want('power')) {
//     for (const s of servicesSheets(state, { meta: opts.meta, startNo: numbered.length })) {
//       if (want(s.kind)) numbered.push({ title: s.title, no: s.no, page: s.page })
//     }
//   }
// (servicesSheets self-numbers as A.(startNo+i+1); pass startNo=numbered.length
// so the sheets take the next free slots and the contents list stays in sync.)

import { canvasToJpeg, planScaleN, renderPrintCanvas, textWidth } from './pdf'
import type { Rgb, PdfJpeg } from './pdf'
import {
  Page,
  MARGIN,
  RES,
  ACCENT,
  hex2rgb,
  keyPlanJpeg,
  titleBlock,
  TITLE_BLOCK_H,
  type TitleBlockInfo,
} from './sheet'
import type { SheetSetMeta } from './sheetSet'
import type { DocState } from '../editor/EditorCanvas'
import { zoneCenter } from '../util/zoneGeom'
import {
  ceilingLayout,
  powerLayout,
  lightingCircuits,
  CEILING_HEIGHT,
  type CeilingFixtureType,
  type PowerPointType,
  type ServiceScheduleRow,
} from './services'

const PAGE_W = 1190.55 // A3 landscape (pt) — kept local, matches pdf.ts PAGE_W.
const PAGE_H = 841.89
const PANEL_W = 316 // right-hand legend/schedule column (pt), matches sheetSet.

const INK: Rgb = hex2rgb('#2e343b')
const BLUE: Rgb = hex2rgb('#3b6fd4')
/** Switch-leg / lighting-circuit runs on the RCP — a muted green so the thin
 *  polyline reads as switching wiring, distinct from the grey ceiling grid. */
const CIRCUIT: Rgb = hex2rgb('#4f8a72')

export interface ServicesSheetsOpts {
  meta: SheetSetMeta
  /** First sheet-number index (produces `A.0(startNo+1)`, …). Default 4, so the
   *  services follow demolition/construction + two default sections. The
   *  orchestrator passes `startNo = numbered.length` to take the next slots. */
  startNo?: number
}

/** One finished services sheet + the metadata the orchestrator/contents need. */
export interface ServicesSheet {
  page: Page
  no: string // 'A.05'
  title: string // 'Reflected Ceiling Plan'
  kind: 'rcp' | 'power'
}

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

// ---------------------------------------------------------------------------
// Shared plan-sheet layout (mirrors sheetSet.planBox / worldMapper)
// ---------------------------------------------------------------------------

interface PlanBox {
  planX: number
  planY: number
  planW: number
  planH: number
  panelX: number
}

function planBox(): PlanBox {
  const bandTop = PAGE_H - MARGIN - TITLE_BLOCK_H
  const planY = 66
  const planX = MARGIN + 6
  const panelX = PAGE_W - MARGIN - PANEL_W
  return { planX, planY, planW: panelX - planX - 16, planH: bandTop - planY - 16, panelX }
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

// ---------------------------------------------------------------------------
// Glyphs — the hand-written PDF engine has no arc op, so circles are line fans
// (same trick as sheetSet.drawTagGlyph). Each optionally sits on a white mask
// so the base-plan raster doesn't bleed through on the plan (no mask in legend).
// ---------------------------------------------------------------------------

function polyOutline(p: Page, cx: number, cy: number, r: number, sides: number, rot: number, o: { rgb?: Rgb; gray?: number; width?: number }): void {
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (i / sides) * Math.PI * 2
    const a1 = rot + ((i + 1) / sides) * Math.PI * 2
    p.line(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1), o)
  }
}

function mask(p: Page, cx: number, cy: number, r: number): void {
  p.box(cx - r, cy - r, r * 2, r * 2, { fill: true, gray: 1 })
}

/** RCP fixture glyph at (cx,cy), radius ~s pt. */
function ceilGlyph(p: Page, type: CeilingFixtureType, cx: number, cy: number, s: number, withMask: boolean): void {
  if (withMask) mask(p, cx, cy, s)
  switch (type) {
    case 'luminaire': {
      // Recessed troffer — a rectangle with a centre lamp line.
      p.box(cx - s, cy - s * 0.62, s * 2, s * 1.24, { fill: false, rgb: INK, width: 0.8 })
      p.line(cx - s * 0.7, cy, cx + s * 0.7, cy, { rgb: INK, width: 0.7 })
      break
    }
    case 'exit': {
      // Emergency / exit luminaire — filled amber square with an E.
      p.box(cx - s, cy - s, s * 2, s * 2, { fill: true, rgb: ACCENT })
      p.text(cx, cy + s * 0.62, s * 1.5, 'E', { align: 'center', bold: true, gray: 1 })
      break
    }
    case 'diffuser': {
      // HVAC diffuser — square with a 4-way (X) supply pattern.
      p.box(cx - s, cy - s, s * 2, s * 2, { fill: false, rgb: INK, width: 0.8 })
      p.line(cx - s, cy - s, cx + s, cy + s, { rgb: INK, width: 0.6 })
      p.line(cx - s, cy + s, cx + s, cy - s, { rgb: INK, width: 0.6 })
      break
    }
    case 'smoke': {
      // Smoke detector — circle with a centre dot.
      polyOutline(p, cx, cy, s, 16, 0, { rgb: INK, width: 0.8 })
      p.box(cx - s * 0.28, cy - s * 0.28, s * 0.56, s * 0.56, { fill: true, rgb: INK })
      break
    }
  }
}

/** Power/data point glyph at (cx,cy), radius ~s pt. */
function powerGlyph(p: Page, type: PowerPointType, cx: number, cy: number, s: number, withMask: boolean): void {
  if (withMask) mask(p, cx, cy, s)
  switch (type) {
    case 'power': {
      // Twin power outlet — filled circle with two prong ticks.
      polyOutline(p, cx, cy, s, 16, 0, { rgb: INK, width: 0.8 })
      p.line(cx - s * 0.35, cy - s * 0.4, cx - s * 0.35, cy + s * 0.4, { rgb: INK, width: 0.8 })
      p.line(cx + s * 0.35, cy - s * 0.4, cx + s * 0.35, cy + s * 0.4, { rgb: INK, width: 0.8 })
      break
    }
    case 'data': {
      // Data outlet — a blue triangle.
      polyOutline(p, cx, cy, s, 3, -Math.PI / 2, { rgb: BLUE, width: 1 })
      break
    }
    case 'floorbox': {
      // Floor box — nested squares.
      p.box(cx - s, cy - s, s * 2, s * 2, { fill: false, rgb: INK, width: 0.9 })
      p.box(cx - s * 0.5, cy - s * 0.5, s, s, { fill: false, rgb: INK, width: 0.7 })
      break
    }
    case 'switch': {
      // Lighting switch — small circle with a lever line.
      polyOutline(p, cx, cy, s * 0.7, 12, 0, { rgb: INK, width: 0.8 })
      p.line(cx, cy, cx + s * 1.3, cy - s * 1.3, { rgb: INK, width: 0.9 })
      break
    }
    case 'db': {
      // Distribution board — filled amber square with a DB label.
      p.box(cx - s * 1.2, cy - s, s * 2.4, s * 2, { fill: true, rgb: ACCENT })
      p.text(cx, cy + s * 0.5, s * 1.1, 'DB', { align: 'center', bold: true, gray: 1 })
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Legend + schedule (right panel), shared shape between the two sheets
// ---------------------------------------------------------------------------

/** Draw the legend + count schedule for one services family in the right panel.
 *  `draw` renders the glyph swatch centred at the given point. */
function legendSchedule(
  p: Page,
  b: PlanBox,
  yStart: number,
  heading: string,
  rows: ServiceScheduleRow[],
  draw: (code: string, cx: number, cy: number) => void,
): void {
  const x = b.panelX + 8
  const total = rows.reduce((t, r) => t + r.count, 0)
  let ly = yStart

  p.text(x, ly, 10, heading, { bold: true, gray: 0.3 })
  ly += 8
  p.box(x, ly, PANEL_W - 16, 13, { fill: true, gray: 0.93 })
  ly += 10
  p.text(x + 44, ly, 7, 'FIXTURE', { bold: true, gray: 0.4 })
  p.text(b.panelX + PANEL_W - 12, ly, 7, 'QTY', { bold: true, align: 'right', gray: 0.4 })
  ly += 6

  const rowH = 24
  for (const r of rows) {
    ly += rowH
    draw(r.code, x + 16, ly - 6)
    p.text(x + 44, ly, 8.5, r.label, { gray: 0.2 })
    p.text(b.panelX + PANEL_W - 12, ly, 9, `${r.count}`, { align: 'right', bold: true, gray: 0.1 })
    p.line(x, ly + 6, b.panelX + PANEL_W - 8, ly + 6, { gray: 0.9, width: 0.4 })
  }
  ly += rowH
  p.text(x + 44, ly, 9, 'TOTAL', { bold: true, gray: 0.15 })
  p.text(b.panelX + PANEL_W - 12, ly, 9.5, `${total}`, { align: 'right', bold: true, gray: 0.05 })
}

// ---------------------------------------------------------------------------
// Glyph / label de-collision — fixture glyphs must not sit on room-name labels.
// We compute each room label's screen box up front, nudge any overlapping glyph
// to the nearest clear offset (deterministic candidate stack, mirroring
// sheetSet.placeNear), then paint the labels LAST with a white knockout halo so
// they stay legible over the faint grid and any close glyph. (screen pt, top-down)
// ---------------------------------------------------------------------------

interface LabelBox {
  x: number // top-left
  y: number
  w: number
  h: number
  cx: number // text centre
  cy: number
  text: string
}

function boxesOverlap(ax: number, ay: number, aw: number, ah: number, b: LabelBox): boolean {
  return ax < b.x + b.w && ax + aw > b.x && ay < b.y + b.h && ay + ah > b.y
}

/** Screen boxes for every non-circulation room label (same transform the plan
 *  uses). Label text baseline sits at `cy`; the box brackets the cap height. */
function roomLabelBoxes(state: DocState, map: (x: number, y: number) => { x: number; y: number }): LabelBox[] {
  const out: LabelBox[] = []
  for (const z of state.zones ?? []) {
    if (z.zone_type === 'Circulation' || !z.label) continue
    const ctr = zoneCenter(z.shape)
    const c = map(ctr.x, ctr.y)
    const text = z.label.toUpperCase()
    const w = textWidth(text, 7.5, false) + 6
    const h = 12
    out.push({ x: c.x - w / 2, y: c.y - 8, w, h, cx: c.x, cy: c.y, text })
  }
  return out
}

/** Nudge a glyph of radius `s` off any room label — try the true spot first,
 *  then a fixed ring of small offsets. Deterministic, so the same plan lays out
 *  identically. Only clears labels (glyph-on-glyph is unchanged / acceptable). */
function clearOfLabels(cx: number, cy: number, s: number, labels: LabelBox[]): { x: number; y: number } {
  const step = s * 2 + 2
  const cands: [number, number][] = [
    [0, 0],
    [step, 0],
    [-step, 0],
    [0, step],
    [0, -step],
    [step, step],
    [-step, step],
    [step, -step],
    [-step, -step],
    [2 * step, 0],
    [-2 * step, 0],
  ]
  for (const [dx, dy] of cands) {
    if (!labels.some((l) => boxesOverlap(cx + dx - s, cy + dy - s, s * 2, s * 2, l))) {
      return { x: cx + dx, y: cy + dy }
    }
  }
  return { x: cx, y: cy }
}

/** Paint the room-name labels on top with a white knockout halo so they stay
 *  legible over the faint ceiling grid and any nearby glyph. */
function drawRoomLabels(p: Page, labels: LabelBox[]): void {
  for (const l of labels) {
    p.box(l.x, l.y, l.w, l.h, { fill: true, gray: 1 })
    p.text(l.cx, l.cy, 7.5, l.text, { align: 'center', gray: 0.45 })
  }
}

function emptyPlanMessage(p: Page, b: PlanBox, msg: string): void {
  p.box(b.planX, b.planY, b.planW, b.planH, { fill: true, gray: 0.97 })
  p.text(b.planX + b.planW / 2, b.planY + b.planH / 2, 12, msg, { align: 'center', gray: 0.45, bold: true })
}

// ---------------------------------------------------------------------------
// Reflected Ceiling Plan (RCP)
// ---------------------------------------------------------------------------

function rcpSheet(state: DocState, no: string, opts: ServicesSheetsOpts): ServicesSheet {
  const p = new Page()
  const b = planBox()
  p.text(MARGIN + 6, 42, 15, 'REFLECTED CEILING PLAN', { bold: true, gray: 0.1 })

  const hasPlan = state.walls.length > 0
  let scale = 'NTS'
  if (!hasPlan) {
    emptyPlanMessage(p, b, 'NO PLAN — GENERATE A TEST-FIT FIRST')
  } else {
    const wPx = Math.round(b.planW * RES)
    const hPx = Math.round(b.planH * RES)
    // Muted base: walls only (no zone tint, no furniture, no labels).
    const { canvas, metersPerPx, k, ox, oy } = renderPrintCanvas(state, wPx, hPx, {
      layers: { zoneFill: false, furniture: false, roomLabels: false, existingWalls: true, generatedWalls: true },
    })
    p.image({ bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, b.planX, b.planY, b.planW, b.planH)
    const map = worldMapper(b, wPx, hPx, k, ox, oy)

    const layout = ceilingLayout(state)
    const labels = roomLabelBoxes(state, map)
    // Ceiling grid first, so glyphs mask over it cleanly.
    for (const g of layout.grid) {
      const a = map(g.x1, g.y1)
      const c = map(g.x2, g.y2)
      p.line(a.x, a.y, c.x, c.y, { gray: 0.86, width: 0.35 })
    }
    // Lighting-circuit switch legs under the glyphs (thin green runs).
    for (const cc of lightingCircuits(state)) {
      let prev = map(cc.sw.x, cc.sw.y)
      for (const lum of cc.luminaires) {
        const q = map(lum.x, lum.y)
        p.line(prev.x, prev.y, q.x, q.y, { rgb: CIRCUIT, width: 0.5 })
        prev = q
      }
      const sw = map(cc.sw.x, cc.sw.y)
      p.text(sw.x + 4, sw.y - 3, 6, cc.label, { rgb: CIRCUIT, bold: true })
    }
    for (const f of layout.fixtures) {
      const pt = map(f.x, f.y)
      const size = f.type === 'luminaire' ? 6 : f.type === 'exit' ? 5 : 5.5
      const q = clearOfLabels(pt.x, pt.y, size, labels)
      ceilGlyph(p, f.type, q.x, q.y, size, true)
    }
    drawRoomLabels(p, labels)

    // Ceiling-height note bottom-left of the plan.
    p.text(b.planX + 12, b.planY + b.planH - 12, 9, `FINISHED CEILING HEIGHT  ${CEILING_HEIGHT.toFixed(2)} m`, {
      gray: 0.4,
      bold: true,
    })

    const scaleN = planScaleN(metersPerPx, wPx, b.planW)
    scale = scaleN ? `1:${scaleN}` : 'NTS'
    legendSchedule(p, b, b.planY + 20, 'CEILING FIXTURE SCHEDULE', layout.schedule, (code, cx, cy) => {
      const t: CeilingFixtureType = code === 'L1' ? 'luminaire' : code === 'E1' ? 'exit' : code === 'HV' ? 'diffuser' : 'smoke'
      ceilGlyph(p, t, cx, cy, 6, false)
    })
  }

  titleBlock(p, tb(opts.meta, no, 'Reflected Ceiling Plan', scale, hasPlan ? keyPlanJpeg(state, 'all', 340, 190) : null))
  return { page: p, no, title: 'Reflected Ceiling Plan', kind: 'rcp' }
}

// ---------------------------------------------------------------------------
// Power & Data plan
// ---------------------------------------------------------------------------

function powerSheet(state: DocState, no: string, opts: ServicesSheetsOpts): ServicesSheet {
  const p = new Page()
  const b = planBox()
  p.text(MARGIN + 6, 42, 15, 'POWER & DATA PLAN', { bold: true, gray: 0.1 })

  const hasPlan = state.walls.length > 0
  let scale = 'NTS'
  if (!hasPlan) {
    emptyPlanMessage(p, b, 'NO PLAN — GENERATE A TEST-FIT FIRST')
  } else {
    const wPx = Math.round(b.planW * RES)
    const hPx = Math.round(b.planH * RES)
    // Muted base: walls + faint furniture (so outlets read against the desks).
    const { canvas, metersPerPx, k, ox, oy } = renderPrintCanvas(state, wPx, hPx, {
      layers: { zoneFill: false, furniture: true, roomLabels: false, existingWalls: true, generatedWalls: true },
    })
    p.image({ bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, b.planX, b.planY, b.planW, b.planH)
    const map = worldMapper(b, wPx, hPx, k, ox, oy)

    const layout = powerLayout(state)
    const labels = roomLabelBoxes(state, map)
    for (const pt of layout.points) {
      const m = map(pt.x, pt.y)
      const size = pt.type === 'db' ? 6 : pt.type === 'floorbox' ? 5.5 : 4.5
      const q = clearOfLabels(m.x, m.y, size, labels)
      powerGlyph(p, pt.type, q.x, q.y, size, true)
    }
    drawRoomLabels(p, labels)

    const scaleN = planScaleN(metersPerPx, wPx, b.planW)
    scale = scaleN ? `1:${scaleN}` : 'NTS'
    legendSchedule(p, b, b.planY + 20, 'POWER & DATA SCHEDULE', layout.schedule, (code, cx, cy) => {
      const t: PowerPointType =
        code === 'P' ? 'power' : code === 'D' ? 'data' : code === 'FB' ? 'floorbox' : code === 'SW' ? 'switch' : 'db'
      powerGlyph(p, t, cx, cy, t === 'db' ? 5 : 5.5, false)
    })
  }

  titleBlock(p, tb(opts.meta, no, 'Power & Data Plan', scale, hasPlan ? keyPlanJpeg(state, 'all', 340, 190) : null))
  return { page: p, no, title: 'Power & Data Plan', kind: 'power' }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Build the services sheets for the drawing set — the RCP followed by the Power
 * & Data plan. Returns finished {@link Page}s (plus kind/no/title metadata) the
 * orchestrator drops into `buildDrawingSetPdf`'s page list (see the wire-in note
 * at the top of this file). Never throws: an empty plan yields graceful "no
 * plan" sheets.
 *
 * @example
 *   const sheets = servicesSheets(state, { meta, startNo: numbered.length })
 *   for (const s of sheets) numbered.push({ title: s.title, no: s.no, page: s.page })
 */
export function servicesSheets(state: DocState, opts: ServicesSheetsOpts): ServicesSheet[] {
  const start = opts.startNo ?? 4
  const no = (i: number) => `A.${String(start + i + 1).padStart(2, '0')}`
  return [rcpSheet(state, no(0), opts), powerSheet(state, no(1), opts)]
}
