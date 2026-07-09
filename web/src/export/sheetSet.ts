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
  textWidth,
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
  productCard,
  logoJpeg,
} from './sheet'
import type { ProductCardInfo } from './sheet'
import type { ReportMeta } from './report'
import { buildTakeoffModel } from './takeoff'
import type { TakeoffFurnitureRow, TakeoffSummaryRow } from './takeoff'
import type { DocState, DocComponent, ZoneShape } from '../editor/EditorCanvas'
import type { Drawing } from '../import/types'
import type { BindingInfo } from '../persist/file'
import { extractPlate, extractInteriorWalls } from '../import/testfit'
import { healWalls } from '../import/heal'
import { triggerDownload } from './png'
import { sectionSheets } from './section'

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
  /** Product bindings — drive the furniture cards + moodboard (M3). */
  bindings?: Map<string, BindingInfo>
  /**
   * Optional sheet whitelist (M6 sheets-manager toggles). When present, ONLY
   * sheets whose id is listed are emitted; when absent, ALL sheets emit
   * (backward compatible). Ids: 'cover' | 'contents' | 'demolition' |
   * 'construction' | 'sections' | 'furniture' | 'moodboard'.
   */
  include?: string[]
}

const INK = hex2rgb('#2e343b')
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
 * Merge collinear + contiguous glazed wall segments into real window runs. The
 * generator emits a glazed front as many short segments (e.g. sixteen 0.15 m
 * pieces); left un-merged the schedule lists 0.15 m fragments instead of one
 * 2.4 m window. We bucket segments by their infinite line (canonical angle +
 * signed perpendicular offset), sort each bucket along the line, and union
 * intervals that touch (gap ≤ GAP). Each union → one window {center, length}.
 * Deterministic: purely a function of the wall geometry.
 */
function mergeGlazedRuns(walls: DocState['walls']): { x: number; y: number; len: number }[] {
  const ANG_TOL = 0.02 // rad — same line direction
  const OFF_TOL = 0.06 // m — same perpendicular offset (collinear)
  const GAP = 0.1 // m — fragments this close along the line are one run

  interface Bucket {
    ang: number
    cux: number
    cuy: number
    nx: number
    ny: number
    off: number
    spans: { lo: number; hi: number }[]
  }
  const buckets: Bucket[] = []

  for (const w of walls) {
    if (w.glazing !== true) continue
    const dx = w.b.x - w.a.x
    const dy = w.b.y - w.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    // Canonical direction angle in [0, π) so a→b and b→a share a line.
    let ang = Math.atan2(dy, dx)
    if (ang < 0) ang += Math.PI
    if (ang >= Math.PI) ang -= Math.PI
    const cux = Math.cos(ang)
    const cuy = Math.sin(ang)
    const nx = -cuy
    const ny = cux
    const off = w.a.x * nx + w.a.y * ny
    const ta = w.a.x * cux + w.a.y * cuy
    const tb = w.b.x * cux + w.b.y * cuy
    const lo = Math.min(ta, tb)
    const hi = Math.max(ta, tb)
    let b = buckets.find(
      (g) => Math.abs(g.ang - ang) < ANG_TOL && Math.abs(g.off - off) < OFF_TOL,
    )
    if (!b) {
      b = { ang, cux, cuy, nx, ny, off, spans: [] }
      buckets.push(b)
    }
    b.spans.push({ lo, hi })
  }

  const out: { x: number; y: number; len: number }[] = []
  for (const b of buckets) {
    b.spans.sort((a, c) => a.lo - c.lo)
    let cur = { ...b.spans[0] }
    const flush = () => {
      const mid = (cur.lo + cur.hi) / 2
      out.push({
        x: mid * b.cux + b.off * b.nx,
        y: mid * b.cuy + b.off * b.ny,
        len: cur.hi - cur.lo,
      })
    }
    for (let i = 1; i < b.spans.length; i++) {
      const s = b.spans[i]
      if (s.lo <= cur.hi + GAP) cur.hi = Math.max(cur.hi, s.hi)
      else {
        flush()
        cur = { ...s }
      }
    }
    flush()
  }
  return out
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
  const windows = mergeGlazedRuns(state.walls).sort((a, b) => a.y - b.y || a.x - b.x)
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

// ---------------------------------------------------------------------------
// Label / tag de-collision (deterministic nudge + stack, leader when far)
// ---------------------------------------------------------------------------

interface OccBox {
  x: number // top-left, top-down pt
  y: number
  w: number
  h: number
}

function boxesOverlap(a: OccBox, b: OccBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Find a non-overlapping center for a `w×h` label near (cx,cy): try the true
 * spot first, then a fixed stack of vertical/horizontal offsets. The candidate
 * order is deterministic, so the same plan always lays out identically. Records
 * the chosen box in `occ` and returns the center actually used.
 */
function placeNear(occ: OccBox[], cx: number, cy: number, w: number, h: number): { x: number; y: number } {
  const dv = h + 3
  const dh = w * 0.55 + 6
  const cands: [number, number][] = [
    [0, 0],
    [0, dv],
    [0, -dv],
    [dh, 0],
    [-dh, 0],
    [0, 2 * dv],
    [0, -2 * dv],
    [dh, dv],
    [-dh, dv],
    [dh, -dv],
    [-dh, -dv],
    [0, 3 * dv],
    [0, -3 * dv],
  ]
  for (const [ox, oy] of cands) {
    const box: OccBox = { x: cx + ox - w / 2, y: cy + oy - h / 2, w, h }
    if (!occ.some((b) => boxesOverlap(box, b))) {
      occ.push(box)
      return { x: cx + ox, y: cy + oy }
    }
  }
  occ.push({ x: cx - w / 2, y: cy - h / 2, w, h })
  return { x: cx, y: cy }
}

/** Draw a room label + area at each non-circulation zone center, de-collided. */
function roomLabels(
  p: Page,
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
  occ: OccBox[],
): void {
  let n = 0
  for (const z of state.zones ?? []) {
    if (z.zone_type === 'Circulation') continue
    n++
    const c = zoneCenter(z.shape)
    const pt = map(c.x, c.y)
    const name = (z.label || `ROOM ${String(n).padStart(2, '0')}`).toUpperCase()
    const area = `${zoneArea(z.shape).toFixed(1)} m²`
    const w = Math.max(textWidth(name, 8, true), textWidth(area, 7.5)) + 4
    const pos = placeNear(occ, pt.x, pt.y + 4, w, 26)
    p.text(pos.x, pos.y - 4, 8, name, { align: 'center', bold: true, gray: 0.2 })
    p.text(pos.x, pos.y + 7, 7.5, area, { align: 'center', gray: 0.4 })
  }
}

// ---------------------------------------------------------------------------
// Demolition plan (A.01)
// ---------------------------------------------------------------------------

function demolitionSheet(state: DocState, opts: DrawingSetOpts, no: string): Page {
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
  roomLabels(p, state, map, [])
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
  titleBlock(p, tb(opts, no, 'Demolition Plan', scaleN ? `1:${scaleN}` : 'NTS', keyPlanJpeg(state, 'all', 340, 190)))
  return p
}

// ---------------------------------------------------------------------------
// Construction & furnishing plan (A.02)
// ---------------------------------------------------------------------------

function constructionSheet(state: DocState, opts: DrawingSetOpts, no: string): Page {
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

  // Overall perimeter dimension strings first (they don't compete for label space).
  dimStrings(p, state, map)

  // Room labels + opening tags share one occupancy list so tags never land on a
  // room label; each nudges deterministically and drops a leader when moved.
  const occ: OccBox[] = []
  roomLabels(p, state, map, occ)
  const openings = openingSchedule(state)
  for (const o of openings) {
    const pt = map(o.x, o.y)
    const pos = placeNear(occ, pt.x, pt.y, 24, 24)
    if (Math.hypot(pos.x - pt.x, pos.y - pt.y) > 14) {
      p.line(pt.x, pt.y, pos.x, pos.y, { gray: 0.5, width: 0.4 })
    }
    drawTagGlyph(p, pos.x, pos.y, o.tag, o.kind)
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
    tb(opts, no, 'Construction & Furnishing Plan', scaleN ? `1:${scaleN}` : 'NTS', keyPlanJpeg(state, 'all', 340, 190)),
  )
  return p
}

/** Regular-polygon outline as a line fan — the hand-written PDF engine has no
 *  arc op, so a circle is a 16-gon and a hexagon its 6-gon sibling. */
function polyOutline(
  p: Page,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rot: number,
  o: { rgb?: Rgb; gray?: number; width?: number },
): void {
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (i / sides) * Math.PI * 2
    const a1 = rot + ((i + 1) / sides) * Math.PI * 2
    p.line(cx + r * Math.cos(a0), cy + r * Math.sin(a0), cx + r * Math.cos(a1), cy + r * Math.sin(a1), o)
  }
}

/** Tag glyph: circle for a door (D), hexagon for a window (W) — true polygon
 *  outlines over a white mask so the plan raster doesn't bleed through. */
function drawTagGlyph(p: Page, cx: number, cy: number, tag: string, kind: 'Door' | 'Window', size = 11): void {
  const r = size
  p.box(cx - r, cy - r, r * 2, r * 2, { fill: true, gray: 1 }) // white backdrop mask
  if (kind === 'Door') {
    polyOutline(p, cx, cy, r, 16, 0, { rgb: INK, width: 0.9 })
  } else {
    polyOutline(p, cx, cy, r, 6, Math.PI / 6, { rgb: BLUE_WALL, width: 1 })
  }
  p.text(cx, cy + size * 0.32, size * 0.68, tag, { align: 'center', bold: true, gray: 0.12 })
}

/** Overall width + height dimension strings around the plate (construction). */
function dimStrings(
  p: Page,
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
): void {
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
  if (minX === Infinity) return

  const tick = (x: number, y: number, dx: number, dy: number) =>
    p.line(x - dx, y - dy, x + dx, y + dy, { gray: 0.4, width: 0.5 })

  // Bottom edge — overall width.
  const bl = map(minX, maxY)
  const br = map(maxX, maxY)
  const by = bl.y + 16
  p.line(bl.x, by, br.x, by, { gray: 0.4, width: 0.5 })
  tick(bl.x, by, 0, 3)
  tick(br.x, by, 0, 3)
  p.text((bl.x + br.x) / 2, by + 11, 7.5, `${(maxX - minX).toFixed(2)} m`, { align: 'center', gray: 0.3 })

  // Left edge — overall height.
  const tl = map(minX, minY)
  const lx = tl.x - 16
  p.line(lx, tl.y, lx, bl.y, { gray: 0.4, width: 0.5 })
  tick(lx, tl.y, 3, 0)
  tick(lx, bl.y, 3, 0)
  p.text(lx - 4, (tl.y + bl.y) / 2, 7.5, `${(maxY - minY).toFixed(2)} m`, { align: 'right', gray: 0.3 })
}

// ---------------------------------------------------------------------------
// Furniture cards + moodboard (driven by buildTakeoffModel — no re-derivation)
// ---------------------------------------------------------------------------

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** ₹ price label; em-dash when unpriced (mirrors takeoff's spec-only fallback). */
function priceLabel(n: number): string {
  return n > 0 ? `₹${INR.format(n)}` : '—'
}

// Category tint for the fallback tile (bank image absent). Named families first,
// then a stable hash so every distinct item still gets a consistent colour.
const NAME_TINT: Record<string, string> = {
  Desk: '#3b6fd4',
  Chair: '#3f9c95',
  Table: '#7a6a55',
  'Meeting Room': '#7d5ba6',
  Sofa: '#c26d4e',
  Storage: '#5c6670',
  Planter: '#4f9d5d',
  'Fall Ceiling': '#8b939e',
}
const TINT_POOL = ['#3b6fd4', '#3f9c95', '#7a6a55', '#7d5ba6', '#c26d4e', '#4f9d5d', '#b0663b', '#5c6670']
function tintFor(name: string): Rgb {
  if (NAME_TINT[name]) return hex2rgb(NAME_TINT[name])
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return hex2rgb(TINT_POOL[h % TINT_POOL.length])
}

/** Split takeoff's "Desk W70 X L140" into a display name + "70 × 140 cm" dims. */
function parseItem(desc: string): { name: string; dims?: string } {
  const m = desc.match(/^(.+?)\s+W(\d+)\s+X\s+L(\d+)$/)
  return m ? { name: m[1], dims: `${m[2]} × ${m[3]} cm` } : { name: desc }
}

/**
 * Resolve one product thumbnail per (supplier|price) — the same key a bound
 * takeoff row carries — so a card finds its bank image without re-deriving the
 * furniture list. Bound products drop their real photo; the rest fall back to a
 * tinted tile. Async because logoJpeg decodes the data-URI off-DOM.
 */
async function resolveThumbs(bindings?: Map<string, BindingInfo>): Promise<Map<string, PdfJpeg>> {
  const out = new Map<string, PdfJpeg>()
  if (!bindings) return out
  for (const [, b] of bindings) {
    if (!b.image) continue
    const key = `${b.supplier?.trim() || b.brand?.trim() || ''}|${b.price ?? 0}`
    if (out.has(key)) continue
    const jpeg = await logoJpeg(b.image, 480)
    if (jpeg) out.set(key, jpeg)
  }
  return out
}
function thumbFor(supplier: string, unitPrice: number, thumbs: Map<string, PdfJpeg>): PdfJpeg | null {
  return thumbs.get(`${supplier}|${unitPrice}`) ?? null
}

/** One card's content from an item-summary row (aggregated across rooms). */
function cardFromSummary(r: TakeoffSummaryRow, thumbs: Map<string, PdfJpeg>): ProductCardInfo {
  const { name, dims } = parseItem(r.itemDescription)
  return {
    name,
    dims,
    qty: r.quantity,
    supplier: r.supplier,
    code: r.costCode,
    unit: priceLabel(r.unitPrice),
    total: r.totalPrice > 0 ? `₹${INR.format(r.totalPrice)}` : '—',
    thumb: thumbFor(r.supplier, r.unitPrice, thumbs),
    tint: tintFor(name),
  }
}

/** Moodboard groups: bound products (priced or with a photo), grouped by room
 *  type, aggregated across rooms so each distinct item shows once per room type. */
function buildMoodGroups(
  furniture: TakeoffFurnitureRow[],
  thumbs: Map<string, PdfJpeg>,
): { label: string; cards: ProductCardInfo[] }[] {
  const byRoom = new Map<string, Map<string, ProductCardInfo & { _qty: number }>>()
  for (const r of furniture) {
    const bound = r.unitPrice > 0 || thumbFor(r.supplier, r.unitPrice, thumbs)
    if (!bound) continue
    const g = byRoom.get(r.roomType) ?? new Map()
    byRoom.set(r.roomType, g)
    const existing = g.get(r.itemDescription)
    if (existing) {
      existing._qty += r.quantity
      existing.qty = existing._qty
      existing.total = `₹${INR.format(existing._qty * r.unitPrice)}`
    } else {
      const { name, dims } = parseItem(r.itemDescription)
      g.set(r.itemDescription, {
        _qty: r.quantity,
        name,
        dims,
        category: r.roomType,
        qty: r.quantity,
        supplier: r.supplier,
        code: r.costCode,
        unit: priceLabel(r.unitPrice),
        total: r.totalPrice > 0 ? `₹${INR.format(r.quantity * r.unitPrice)}` : '—',
        thumb: thumbFor(r.supplier, r.unitPrice, thumbs),
        tint: tintFor(name),
      })
    }
  }
  return [...byRoom.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, m]) => ({ label, cards: [...m.values()] }))
}

// ---------------------------------------------------------------------------
// Furniture & Fixtures schedule sheet (grid of cards)
// ---------------------------------------------------------------------------

function furnitureSheet(
  opts: DrawingSetOpts,
  no: string,
  cards: ProductCardInfo[],
  titleSuffix: string,
  keyPlan: PdfJpeg | null,
): Page {
  const p = new Page()
  p.text(MARGIN + 6, 42, 15, `FURNITURE & FIXTURES${titleSuffix}`, { bold: true, gray: 0.1 })

  const cols = 4
  const rows = 3
  const gap = 16
  const gridX = MARGIN + 6
  const gridTop = 62
  const gridW = PAGE_W - MARGIN - gridX
  const gridBottom = PAGE_H - MARGIN - TITLE_BLOCK_H - 8
  const cardW = (gridW - gap * (cols - 1)) / cols
  const cardH = (gridBottom - gridTop - gap * (rows - 1)) / rows

  if (cards.length === 0) {
    p.box(gridX, gridTop, gridW, 120, { fill: true, gray: 0.97 })
    p.text(PAGE_W / 2, gridTop + 62, 12, 'NO FURNITURE SPECIFIED YET', { align: 'center', gray: 0.45, bold: true })
    p.text(PAGE_W / 2, gridTop + 82, 9, 'Generate a test-fit and bind products from the material bank.', {
      align: 'center',
      gray: 0.5,
    })
  } else {
    cards.forEach((c, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = gridX + col * (cardW + gap)
      const y = gridTop + row * (cardH + gap)
      productCard(p, x, y, cardW, cardH, c)
    })
  }

  titleBlock(p, tb(opts, no, 'Furniture & Fixtures', 'NTS', keyPlan))
  return p
}

// ---------------------------------------------------------------------------
// Moodboard sheet (larger tiles for bound products, grouped by room)
// ---------------------------------------------------------------------------

function moodboardSheet(
  opts: DrawingSetOpts,
  no: string,
  groups: { label: string; cards: ProductCardInfo[] }[],
  keyPlan: PdfJpeg | null,
): Page {
  const p = new Page()
  p.text(MARGIN + 6, 42, 15, 'MOODBOARD', { bold: true, gray: 0.1 })

  const gridX = MARGIN + 6
  const gridW = PAGE_W - MARGIN - gridX
  const bottom = PAGE_H - MARGIN - TITLE_BLOCK_H - 8

  if (groups.length === 0) {
    p.box(gridX, 62, gridW, 130, { fill: true, gray: 0.97 })
    p.text(PAGE_W / 2, 128, 13, 'NO PRODUCTS SPECIFIED YET', { align: 'center', gray: 0.45, bold: true })
    p.text(PAGE_W / 2, 150, 9, 'Bind products from the material bank to populate the moodboard.', {
      align: 'center',
      gray: 0.5,
    })
    titleBlock(p, tb(opts, no, 'Moodboard', 'NTS', keyPlan))
    return p
  }

  const cols = 3
  const gap = 18
  const cardW = (gridW - gap * (cols - 1)) / cols
  const cardH = 196
  let y = 62
  let overflow = 0
  let stopped = false

  for (const g of groups) {
    if (stopped) {
      overflow += g.cards.length
      continue
    }
    if (y + 20 + cardH > bottom) {
      overflow += g.cards.length
      stopped = true
      continue
    }
    // Room/category section band.
    p.box(gridX, y, gridW, 16, { fill: true, gray: 0.95 })
    p.text(gridX + 8, y + 11, 9, g.label.toUpperCase(), { bold: true, gray: 0.3 })
    p.text(PAGE_W - MARGIN - 8, y + 11, 8, `${g.cards.length} ITEM${g.cards.length > 1 ? 'S' : ''}`, {
      align: 'right',
      gray: 0.45,
    })
    y += 24
    let col = 0
    for (const c of g.cards) {
      if (y + cardH > bottom) {
        overflow++
        stopped = true
        continue
      }
      const x = gridX + col * (cardW + gap)
      productCard(p, x, y, cardW, cardH, c)
      col++
      if (col >= cols) {
        col = 0
        y += cardH + gap
      }
    }
    if (col > 0) y += cardH + gap
  }
  if (overflow > 0) {
    p.text(gridX, Math.min(y, bottom) + 2, 9, `+ ${overflow} more bound product${overflow > 1 ? 's' : ''}`, { gray: 0.5 })
  }

  titleBlock(p, tb(opts, no, 'Moodboard', 'NTS', keyPlan))
  return p
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

function contentsSheet(opts: DrawingSetOpts, numbered: { title: string; no: string }[]): Page {
  const p = new Page()
  p.text(MARGIN, MARGIN + 30, 34, 'Contents', { bold: true, gray: 0.08 })
  p.text(MARGIN, MARGIN + 60, 12, opts.meta.project, { gray: 0.4 })

  const items: { title: string; no: string }[] = [
    { title: 'Cover', no: '—' },
    { title: 'Contents', no: '—' },
    ...numbered.map((n) => ({ title: n.title, no: n.no })),
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

/**
 * Build the drawing-set PDF bytes: cover · contents · A.01 demolition · A.02
 * construction · [sections] · furniture-card sheet(s) · moodboard. A.NN numbers
 * are auto-assigned in order, so the contents list and title blocks always
 * agree even as furniture paginates. Async because product thumbnails decode
 * off-DOM (logoJpeg) before the sheets compose.
 */
export async function buildDrawingSetPdf(state: DocState, opts: DrawingSetOpts): Promise<Uint8Array<ArrayBuffer>> {
  const thumbs = await resolveThumbs(opts.bindings)
  const model = buildTakeoffModel(state, {
    bindings: opts.bindings,
    floor: opts.meta.floor,
    project: opts.meta.project,
  })
  const keyPlan = () => keyPlanJpeg(state, 'all', 340, 190)

  // Furniture cards, paginated (12 per A3 sheet); one empty page → graceful state.
  const cards = model.summary.map((r) => cardFromSummary(r, thumbs))
  const CARDS_PER = 12
  const cardPages: ProductCardInfo[][] = []
  if (cards.length === 0) cardPages.push([])
  else for (let i = 0; i < cards.length; i += CARDS_PER) cardPages.push(cards.slice(i, i + CARDS_PER))
  const moodGroups = buildMoodGroups(model.furniture, thumbs)

  // Optional sheet whitelist (M6 toggles). Absent → every sheet emits.
  const want = (id: string) => !opts.include || opts.include.includes(id)

  // Numbered sheets, in order; A.NN assigned by position. `id` keys the M6
  // manifest; a de-selected sheet is skipped entirely (its build never runs).
  const numbered: { title: string; no: string; page: Page }[] = []
  const add = (id: string, title: string, build: (no: string) => Page) => {
    if (!want(id)) return
    const no = `A.${String(numbered.length + 1).padStart(2, '0')}`
    numbered.push({ title, no, page: build(no) })
  }
  add('demolition', 'Demolition Plan', (no) => demolitionSheet(state, opts, no))
  add('construction', 'Construction & Furnishing Plan', (no) => constructionSheet(state, opts, no))
  // ── Section sheets (orthographic cuts from the 3D model, export/section.ts) ──
  // section.ts self-numbers as A.(startNo+i+1); passing startNo=numbered.length
  // gives the first cut the next free slot (A.03 after the two plans) and keeps
  // the contents list + title blocks in sync. Wrapped so a WebGL/section-render
  // failure can never sink the plan/furniture sheets that already succeeded.
  if (want('sections')) {
    try {
      for (const s of sectionSheets(state, { meta: opts.meta, startNo: numbered.length })) {
        numbered.push({ title: s.title, no: s.no, page: s.page })
      }
    } catch (err) {
      console.warn('drawing-set: section sheets skipped —', err)
    }
  }
  cardPages.forEach((rows, i) =>
    add('furniture', `Furniture & Fixtures${i > 0 ? ' (cont.)' : ''}`, (no) =>
      furnitureSheet(opts, no, rows, i > 0 ? ' (CONT.)' : '', keyPlan()),
    ),
  )
  add('moodboard', 'Moodboard', (no) => moodboardSheet(opts, no, moodGroups, keyPlan()))

  const toPage = (pg: Page): PdfPage => ({ ops: pg.ops, images: pg.images })
  const pages: PdfPage[] = []
  if (want('cover')) pages.push(toPage(coverSheet(state, opts)))
  if (want('contents')) pages.push(toPage(contentsSheet(opts, numbered)))
  pages.push(...numbered.map((n) => toPage(n.page)))
  return buildMultiPagePdfBytes(pages)
}

/** Build the drawing set and download it. */
export async function exportDrawingSet(
  state: DocState,
  opts: DrawingSetOpts,
  filename = 'dsource-drawing-set.pdf',
): Promise<void> {
  const bytes = await buildDrawingSetPdf(state, opts)
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename)
}
