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

import { PAGE_W, PAGE_H, PdfPage, PdfJpeg, Rgb, buildMultiPagePdfBytes, textWidth } from './pdfDoc'
import { isGroundZone } from '../types/doc'
import { renderPrintCanvas, canvasToJpeg, planScaleN, WallSeg } from './printPlan'
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
import { buildTakeoffModel, parseItemDescription } from './takeoff'
import type { TakeoffFurnitureRow, TakeoffSummaryRow } from './takeoff'
import type { DocState, DocComponent, DocZone } from '../types/doc'
import { zoneArea as zoneShapeArea, zoneBBox, zoneCenter as zoneShapeCenter } from '../util/zoneGeom'
import type { Drawing } from '../import/types'
import type { BindingInfo } from '../persist/file'
import { extractPlate, extractInteriorWalls } from '../import/testfit'
import { healWalls } from '../import/heal'
import { triggerDownload } from './png'
import { sectionSheets } from './section'
import { servicesSheets } from './servicesSheets'
import { finishScheduleSheets } from './finishSchedule'
import { roomDisplayNames, roomLabelForms } from './roomNaming'

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
   * 'construction' | 'rcp' | 'power' | 'sections' | 'furniture' | 'moodboard' |
   * 'finishes'.
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

/** Enclosed area (m²); rings exclude the hole, polys shoelace. */
const zoneArea = zoneShapeArea

/** Center point of a zone shape (polygon → area-weighted centroid). */
const zoneCenter = zoneShapeCenter

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

/** The y a sheet's plan band and panel column must stay above: the title-block
 *  band top. One name for the value planBox/sheetGeometry/the schedule all use. */
const PANEL_BOTTOM = PAGE_H - MARGIN - TITLE_BLOCK_H

function planBox(): PlanBox {
  const bandTop = PANEL_BOTTOM
  const planY = 66
  const planX = MARGIN + 6
  const panelX = PAGE_W - MARGIN - PANEL_W
  const planW = panelX - planX - 16
  const planH = bandTop - planY - 16
  return { planX, planY, planW, planH, panelX, panelW: PANEL_W }
}

/** The plate viewport as a placement region — nothing drawn ON the plan (room
 *  labels, opening tags) may leave it. Same rect `sheetGeometry().plate` reports. */
function plateBox(b: PlanBox): OccBox {
  return { x: b.planX, y: b.planY, w: b.planW, h: b.planH }
}

/** A rectangle in top-down sheet points (the `Page` coordinate space). */
export interface SheetRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The plan-sheet TEMPLATE geometry, in top-down sheet points — the page, the
 * bottom title-block band, the right-hand panel column and the plate viewport,
 * all derived from the same constants the sheets are drawn with (`PAGE_W`,
 * `PAGE_H`, `MARGIN`, `TITLE_BLOCK_H`, `PANEL_W`, `planBox`).
 *
 * Exported for harnesses and gates: the template constants ARE the spec, so a
 * checker reads its expected rects from here rather than measuring the drawn
 * output (which is the thing under test — `.claude/rules/gate-independence.md`).
 * Read-only: nothing here changes what any sheet draws.
 *
 * `panel` runs from the top of the plan band down to the title-block band top —
 * the column's legal extent, which is what an overflowing schedule breaks out of.
 */
export function sheetGeometry(): {
  pageW: number
  pageH: number
  margin: number
  titleBlockH: number
  panelW: number
  frame: SheetRect
  titleBlock: SheetRect
  panel: SheetRect
  plate: SheetRect
} {
  const b = planBox()
  const bandTop = PANEL_BOTTOM
  return {
    pageW: PAGE_W,
    pageH: PAGE_H,
    margin: MARGIN,
    titleBlockH: TITLE_BLOCK_H,
    panelW: PANEL_W,
    frame: { x: MARGIN, y: MARGIN, w: PAGE_W - MARGIN * 2, h: PAGE_H - MARGIN * 2 },
    titleBlock: { x: MARGIN, y: bandTop, w: PAGE_W - MARGIN * 2, h: TITLE_BLOCK_H },
    panel: { x: b.panelX, y: b.planY, w: b.panelW, h: bandTop - b.planY },
    plate: { x: b.planX, y: b.planY, w: b.planW, h: b.planH },
  }
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

export interface OccBox {
  x: number // top-left, top-down pt
  y: number
  w: number
  h: number
  /**
   * Cost multiplier when a placement has to sit on this box, default 1.
   *
   * Occupancy is not one kind of thing. Type-on-type is UNREADABLE — two room
   * names over each other cannot be recovered by the reader, and SG3 gates it.
   * Type-on-furniture is merely untidy: the name still reads and the symbol is
   * still mostly visible. So when a crowded region leaves no free candidate,
   * the least-cost placement must prefer a desk to another label. Weighting the
   * fallback is what expresses that ORDER; a bare occupancy list cannot, because
   * it says only "taken", never "taken by what".
   *
   * This does NOT weaken avoidance: the zero-overlap fast path still refuses
   * every occupied box whatever its weight, so wherever there is room a label
   * still steps aside for furniture (which is E7's whole point).
   */
  weight?: number
}

/** Furniture is soft occupancy — see {@link OccBox.weight}. Small enough that a
 *  label will cross a whole desk before it clips a single character of another
 *  label, and non-zero so that among otherwise equal spots it still prefers the
 *  clear one. */
const FURNITURE_WEIGHT = 0.02

/** THE overlap predicate for annotation boxes — one definition, so two sheets
 *  can never disagree about whether two annotations collide. */
function boxesOverlap(a: OccBox, b: OccBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * A deferred paint op, and where an annotation sends one.
 *
 * ANNOTATION FAMILIES SHARE A PAGE, SO THEY MUST SHARE A PAINT ORDER. Every
 * family used to de-collide inside itself and paint as it went, so whichever
 * painted last won — and several of them paint something OPAQUE (`tagMask`'s
 * white knockout, a room label's halo, an exit luminaire's amber tile).
 * Confining opening tags to the plate pushed them onto room names and the tag
 * knockout erased the names: 9 plan words on A.02, across the three packs, more
 * than 15% of their own box under a tag mask, with "BOOTH" (of PHONE BOOTH 2)
 * at 76% and one room's whole "m²" at 100%. SG3 3.1 was green throughout,
 * because the glyphs WERE emitted — `.claude/rules/gate-independence.md`
 * §"Emission is not visibility".
 *
 * The fix is structural, not a nudge. A sheet places every annotation first (one
 * shared `occ`, below), and then paints in THREE passes, opaque to legible:
 *
 *   1. {@link PlanInk.masks}   every knockout / backdrop
 *   2. {@link PlanInk.symbols} the glyphs that are shapes (tag outlines, fixture
 *                              symbols) — opaque fills live here too
 *   3. {@link PlanInk.type}    every glyph run that has to be READ
 *
 * Type is painted last, by every family at once, so nothing any family draws can
 * reach another family's words — whatever order the families ran in, and whether
 * or not the placement above found them a clear spot.
 *
 * A caller with nothing opaque to sequence behind (A.01 carries room names and
 * nothing else) passes {@link paintNow} and draws in place, exactly as before.
 */
export type Draw = () => void
type InkSink = (draw: Draw) => void

/** The three paint passes of a plan sheet, in the order they are flushed. */
export interface PlanInk {
  masks: Draw[]
  symbols: Draw[]
  type: Draw[]
}

/** A fresh set of empty passes. */
export function planInk(): PlanInk {
  return { masks: [], symbols: [], type: [] }
}

/** Run the three passes in order. Nothing may be queued after this. */
export function paintPlanInk(ink: PlanInk): void {
  for (const d of ink.masks) d()
  for (const d of ink.symbols) d()
  for (const d of ink.type) d()
}

/** Sink for a sheet with no opaque marks to sequence behind: paint immediately. */
const paintNow: InkSink = (d) => d()

/** The box a `p.text` run occupies, from its baseline — ascent/descent as
 *  fractions of the type size (the same fractions `servicesSheets.haloBox`
 *  uses), so one annotation's reserved box means the same thing as another's. */
function textBoxAt(
  x: number,
  baseline: number,
  size: number,
  label: string,
  align: 'left' | 'center' | 'right',
): OccBox {
  const w = textWidth(label, size)
  const asc = size * 1.07
  const desc = size * 0.53
  return {
    x: align === 'center' ? x - w / 2 : align === 'right' ? x - w : x,
    y: baseline - asc,
    w,
    h: asc + desc,
  }
}

/** Total area of `box` covered by anything already in `occ`. */
function overlapArea(box: OccBox, occ: OccBox[]): number {
  let a = 0
  for (const b of occ) {
    const w = Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x)
    const h = Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y)
    if (w > 0 && h > 0) a += w * h * (b.weight ?? 1)
  }
  return a
}

/** True when `box` lies wholly inside `bounds` (no bounds ⇒ everywhere is legal). */
function boxInside(box: OccBox, bounds?: OccBox | null): boolean {
  if (!bounds) return true
  return (
    box.x >= bounds.x &&
    box.y >= bounds.y &&
    box.x + box.w <= bounds.x + bounds.w &&
    box.y + box.h <= bounds.y + bounds.h
  )
}

/** The candidate stack, in the order they are tried: the true spot, then a
 *  fixed ladder of vertical/horizontal offsets. ONE stack, shared by the strict
 *  placer and the best-effort one, so the two can never disagree about where a
 *  label would go. */
function placeCandidates(w: number, h: number): [number, number][] {
  const dv = h + 3
  const dh = w * 0.55 + 6
  return [
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
}

/**
 * Wider rings, tried by the STRICT placer only, after the shared stack above is
 * exhausted — up to two columns out and four rows up/down, nearest first.
 *
 * Why the strict placer gets more reach and {@link placeNear} does not: a
 * caller that can be told "no" always draws a LEADER back to the room when a
 * label lands off it, so extra distance stays readable, and the alternative it
 * would otherwise fall to is a rung that damages the name (shrink → wrap →
 * abbreviate). Measured on dwg A.02: with the shared 13 candidates alone, room
 * 214's "OPEN WORKSPACE (4)" could not be placed at any size and wrapped onto
 * two lines, which takes the room's own name off the page as a single glyph
 * run. `placeNear`'s stack is deliberately untouched — the plan graphic shares
 * it and its layout is gated byte-for-byte (G4).
 */
function extendedCandidates(w: number, h: number): [number, number][] {
  const dv = h + 3
  const dh = w * 0.55 + 6
  return [
    [dh, 2 * dv],
    [-dh, 2 * dv],
    [dh, -2 * dv],
    [-dh, -2 * dv],
    [2 * dh, 0],
    [-2 * dh, 0],
    [2 * dh, dv],
    [-2 * dh, dv],
    [2 * dh, -dv],
    [-2 * dh, -dv],
    [0, 4 * dv],
    [0, -4 * dv],
    [dh, 3 * dv],
    [-dh, 3 * dv],
    [dh, -3 * dv],
    [-dh, -3 * dv],
    [2 * dh, 2 * dv],
    [-2 * dh, 2 * dv],
    [2 * dh, -2 * dv],
    [-2 * dh, -2 * dv],
  ]
}

/**
 * A **strictly** clear centre for a `w×h` label near (cx,cy) — or `null` when
 * every candidate either collides or leaves `bounds`. Same candidate stack (then
 * the wider rings above), same `occ` bookkeeping as {@link placeNear}; the only
 * difference is that it refuses to place rather than settling for the least-bad
 * spot.
 *
 * That refusal is what a fit ladder needs. The services sheets walk
 * `roomLabelForms` from the full name down to smaller/abbreviated forms and ask
 * this function for each rung in turn: a "no" means *this form does not fit
 * anywhere near this room*, which is the question the ladder is answering. A
 * placer that always says yes cannot be asked it — which is exactly how three
 * phone-booth labels ended up stacked on one another, each one's white knockout
 * halo erasing the last (`drawRoomLabels`, defect D3).
 *
 * Nothing is pushed to `occ` when it returns `null`.
 */
export function tryPlaceNear(
  occ: OccBox[],
  cx: number,
  cy: number,
  w: number,
  h: number,
  bounds?: OccBox | null,
  /**
   * Second-pass reach: ignore SOFT occupancy (furniture, {@link OccBox.weight}
   * below 1) and refuse only hard boxes — other type.
   *
   * The caller runs this pass only after the strict one has failed everywhere,
   * and it is what keeps E7 from trading one defect for a worse one. Strict
   * placement refuses furniture too, so seeding the desks makes it fail on a
   * dense plan and drop to the narrow always-yields placer, which is where two
   * room names end up on top of each other. Here the label stays in the WIDE,
   * leader-backed ring set — it may cross a desk, but it never lands on another
   * label, and `labelLeader` still ties it to the room it names.
   */
  allowSoft = false,
): { x: number; y: number } | null {
  const blocks = (b: OccBox) => (allowSoft ? (b.weight ?? 1) >= 1 : true)
  for (const [ox, oy] of [...placeCandidates(w, h), ...extendedCandidates(w, h)]) {
    const box: OccBox = { x: cx + ox - w / 2, y: cy + oy - h / 2, w, h }
    if (!boxInside(box, bounds)) continue
    if (!occ.some((b) => blocks(b) && boxesOverlap(box, b))) {
      occ.push(box)
      return { x: cx + ox, y: cy + oy }
    }
  }
  return null
}

/**
 * Find a non-overlapping center for a `w×h` label near (cx,cy): try the true
 * spot first, then a fixed stack of vertical/horizontal offsets. The candidate
 * order is deterministic, so the same plan always lays out identically. Records
 * the chosen box in `occ` and returns the center actually used.
 *
 * When EVERY candidate collides — a dense desk field where `occ` is seeded with
 * furniture (planGraphic.ts) can do that — the least-overlapping candidate wins
 * rather than the true spot, so the label lands in the widest gap it can reach
 * instead of squarely on a symbol. Ties keep candidate order, so the layout
 * stays deterministic (gate G4 diffs two independent renders byte-for-byte).
 *
 * `bounds` (OPTIONAL, top-down pt, the same space as `occ`) is the region the
 * chosen box may not leave — the plate viewport, for anything drawn on the plan.
 * Without it the de-collision stack is free to walk a label or an opening tag
 * clean off the drawing: measured on the delivered A.02, five tags left the
 * plate (one of them 69.6 pt below it, inside the title block's NOTES panel) and
 * a room's area string printed across the band top. With it, out-of-region
 * candidates are simply not candidates: the search falls through to the next
 * one, and when EVERY in-region candidate collides the least-overlapping one
 * wins — a tag over a furniture symbol, carrying a leader, is correct drafting;
 * a tag in the title block is not. Should the region be too small to hold the
 * box at any candidate (it never is on an A3 plate), the true spot is clamped
 * into it, so this can only ever move content INTO the region.
 *
 * Callers that pass no `bounds` take exactly the path they took before — the
 * `plan graphic` shares this function by design, and its layout is byte-gated.
 */
export function placeNear(
  occ: OccBox[],
  cx: number,
  cy: number,
  w: number,
  h: number,
  bounds?: OccBox | null,
): { x: number; y: number } {
  const cands = placeCandidates(w, h)
  let best: [number, number] | null = null
  let bestArea = Infinity
  for (const [ox, oy] of cands) {
    const box: OccBox = { x: cx + ox - w / 2, y: cy + oy - h / 2, w, h }
    if (!boxInside(box, bounds)) continue
    if (!occ.some((b) => boxesOverlap(box, b))) {
      occ.push(box)
      return { x: cx + ox, y: cy + oy }
    }
    const a = overlapArea(box, occ)
    if (a < bestArea) {
      bestArea = a
      best = [ox, oy]
    }
  }
  if (!best) {
    // No candidate fits the region at all — clamp the true spot into it.
    const x = Math.min(Math.max(cx - w / 2, bounds!.x), Math.max(bounds!.x, bounds!.x + bounds!.w - w))
    const y = Math.min(Math.max(cy - h / 2, bounds!.y), Math.max(bounds!.y, bounds!.y + bounds!.h - h))
    occ.push({ x, y, w, h })
    return { x: x + w / 2, y: y + h / 2 }
  }
  occ.push({ x: cx + best[0] - w / 2, y: cy + best[1] - h / 2, w, h })
  return { x: cx + best[0], y: cy + best[1] }
}

/** A leader stroke: label edge → the space it names. Top-down coords, like the
 *  boxes `placeNear` works in (sheet pt on a PDF page, px on the plan canvas). */
export interface Leader {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Shorter than this and a leader is a tick, not a pointer — drawn as nothing. */
const MIN_LEADER = 6

function boxContains(b: OccBox, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
}

/** Where the ray from (ix,iy) — inside `b` — towards (ox,oy) crosses b's edge. */
function exitPoint(b: OccBox, ix: number, iy: number, ox: number, oy: number): { x: number; y: number } {
  const dx = ox - ix
  const dy = oy - iy
  let t = 1
  if (dx > 0) t = Math.min(t, (b.x + b.w - ix) / dx)
  else if (dx < 0) t = Math.min(t, (b.x - ix) / dx)
  if (dy > 0) t = Math.min(t, (b.y + b.h - iy) / dy)
  else if (dy < 0) t = Math.min(t, (b.y - iy) / dy)
  t = Math.max(0, Math.min(1, t))
  return { x: ix + dx * t, y: iy + dy * t }
}

/**
 * The leader line a DISPLACED label needs, or `null` when it needs none.
 *
 * `placeNear` moves a label out of the way of furniture, dimension strings and
 * other labels; it returns only the new centre, which leaves the reader to
 * guess. Guessing is safe while the label still sits on the space it names, and
 * stops being safe the moment it does not: three identical 1.4 m² phone booths
 * in a row, each label pushed outside its booth, cannot be told apart (rooms
 * 155/163/171 on the delivered plan). A leader is exactly the drafting answer.
 *
 * THRESHOLD — a leader is drawn when the label's CENTRE leaves the room's own
 * footprint (`room`, in the same top-down coordinates), and not before:
 *
 *  * it is the ambiguity condition itself, not a proxy for it. Inside the room
 *    the label is self-attributing; outside it is not, whatever the distance;
 *  * it scales with the drawing. A 668 m² open workspace absorbs a big nudge
 *    and stays unambiguous; a 1.4 m² booth is smaller than its own label, so
 *    any displacement at all escapes it. One rule, both cases, no magic px;
 *  * it cannot fire for a label nobody moved — `placeNear`'s first candidate is
 *    the true spot, which is inside the room by construction.
 *
 * `room` is optional: with no footprint to test against (the plan's aggregated
 * circulation label has no single zone) the label's own box at the anchor
 * stands in, i.e. "displaced by more than its own width/height". Leaders below
 * `MIN_LEADER` are dropped, so a centre that lands a hair outside the wall
 * gets no stub.
 *
 * The line runs from the label's box edge to the room's edge — it stops where
 * the space starts rather than crossing it, so it never adds ink over the
 * furniture inside (gate G11 measures exactly that ink). Pure arithmetic on the
 * inputs: deterministic, as G4's byte-for-byte re-render requires.
 */
export function labelLeader(
  anchorX: number,
  anchorY: number,
  pos: { x: number; y: number },
  w: number,
  h: number,
  room?: OccBox | null,
): Leader | null {
  const ref: OccBox = room ?? { x: anchorX - w / 2, y: anchorY - h / 2, w, h }
  if (ref.w <= 0 || ref.h <= 0) return null
  if (boxContains(ref, pos.x, pos.y)) return null
  // Aim from the anchor when the anchor is inside the room (it normally is —
  // it IS the room centre); from the room centre when a concave/offset anchor
  // put it outside, so the ray always starts inside the box it exits.
  const inside = boxContains(ref, anchorX, anchorY)
  const ax = inside ? anchorX : ref.x + ref.w / 2
  const ay = inside ? anchorY : ref.y + ref.h / 2
  const to = exitPoint(ref, ax, ay, pos.x, pos.y)
  const from = exitPoint({ x: pos.x - w / 2, y: pos.y - h / 2, w, h }, pos.x, pos.y, to.x, to.y)
  if (Math.hypot(to.x - from.x, to.y - from.y) < MIN_LEADER) return null
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y }
}

/** A zone's footprint in the same top-down coords a label is placed in. */
/**
 * A component's axis-aligned footprint in SHEET units — the ink a furniture
 * symbol occupies, in the box shape `placeNear` de-collides against.
 *
 * Lives here, beside `placeNear`/`zoneBoxOnSheet`, because this module owns the
 * de-collision vocabulary and `planGraphic` already imports from it; the reverse
 * import would be a cycle. It was local to `planGraphic` while only the workbook
 * seeded occupancy — both plan producers need it now (E7).
 */
export function componentBox(
  c: DocComponent,
  map: (x: number, y: number) => { x: number; y: number },
  k: number,
): OccBox {
  const cos = Math.abs(Math.cos(c.rotation))
  const sin = Math.abs(Math.sin(c.rotation))
  const w = (c.w * cos + c.h * sin) * k
  const h = (c.w * sin + c.h * cos) * k
  const p = map(c.x, c.y)
  return { x: p.x - w / 2, y: p.y - h / 2, w, h }
}

export function zoneBoxOnSheet(
  shape: DocZone['shape'],
  map: (x: number, y: number) => { x: number; y: number },
): OccBox {
  const bb = zoneBBox(shape)
  const a = map(bb.minX, bb.minY)
  const b = map(bb.maxX, bb.maxY)
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/** Draw a room label + area at each non-circulation zone center, de-collided —
 *  with a leader back to the room whenever de-collision pushed the label off it
 *  (see `labelLeader`). The leader is drawn first, so the label always reads on
 *  top of it. `bounds` is the plate viewport: a room label is plan content and
 *  may not be nudged out of the drawing (on dwg A.02 one room's "6.8 m²" printed
 *  across the title-block band top at y 686 pt, band top 685.89 pt).
 *
 *  `occ` is the sheet's ONE annotation occupancy — it arrives holding the
 *  dimension strings and leaves holding the names, so the opening-tag pass that
 *  follows on A.02 sees both. `ink` is where the type goes: A.02 queues it so
 *  that every tag knockout is painted before any name (see {@link InkSink}). */
function roomLabels(
  p: Page,
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
  occ: OccBox[],
  bounds: OccBox | null | undefined,
  ink: InkSink,
): void {
  // ONE naming rule for the whole deliverable: the plan, the services sheets,
  // the finish schedule and the QTO workbook all print what `roomDisplayNames`
  // says, so three zones the generator called "Open Workspace" can never reach
  // the reader as three identical labels (defect D4).
  const names = roomDisplayNames(state)
  let n = 0
  for (const z of state.zones ?? []) {
    if (isGroundZone(z.zone_type)) continue
    n++
    const c = zoneCenter(z.shape)
    const pt = map(c.x, c.y)
    const name = (names.get(z.id) ?? (z.label || `ROOM ${String(n).padStart(2, '0')}`)).toUpperCase()
    const area = `${zoneArea(z.shape).toFixed(1)} m²`
    const areaW = textWidth(area, 7.5)
    // The same fit ladder the services sheets use (`roomLabelForms`): try every
    // position for the full name first, and only then a smaller / wrapped /
    // abbreviated form. Without it a crowded plan falls through to
    // `placeNear`'s least-overlapping candidate and prints two names on top of
    // each other — measured on dwg A.02, where "PRINT POINT 1" and "CORE 2"
    // landed 1.6 pt apart on the same baseline.
    const forms = roomLabelForms(name, 8, (t, s) => textWidth(t, s, true))
    let form = forms[0]
    let box = { w: 0, h: 0 }
    let pos: { x: number; y: number } | null = null
    // The ladder, in priority order. Two things are being traded off and they
    // are NOT equally severe, so the rungs are ordered by what survives:
    //   1. the full name, clear of everything;
    //   2. the full name crossing FURNITURE (soft occupancy, wide leader-backed
    //      rings) — untidy, still readable, still recoverable;
    //   3. a shorter/wrapped/ABBREVIATED form, clear of everything;
    //   4. the narrow always-yields placer, full name, may collide.
    //
    // Rung 2 sits above rung 3 deliberately. An abbreviation is not the room's
    // name: the sheet and the model stop naming the same set of rooms, which is
    // exactly what happened when seeding furniture (E7) pushed four seeded-A.02
    // names — COLLAB, STORAGE, PRINT POINT 1, CABIN 3 — off their full form and
    // onto an abbreviation, drawn 0x. A name over a desk can be read; a name
    // that was never written cannot.
    const place = (f: (typeof forms)[number], soft: boolean) => {
      const b = { w: Math.max(f.width, areaW) + 4, h: 26 + (f.lines.length - 1) * 11 }
      const at = tryPlaceNear(occ, pt.x, pt.y + 4, b.w, b.h, bounds, soft)
      if (at) {
        form = f
        box = b
      }
      return at
    }
    pos = place(forms[0], false) ?? place(forms[0], true)
    for (let i = 1; i < forms.length && !pos; i++) pos = place(forms[i], false)
    if (!pos) {
      box = { w: Math.max(form.width, areaW) + 4, h: 26 + (form.lines.length - 1) * 11 }
      pos = placeNear(occ, pt.x, pt.y + 4, box.w, box.h, bounds)
    }
    const lead = labelLeader(pt.x, pt.y + 4, pos, box.w, box.h, zoneBoxOnSheet(z.shape, map))
    if (lead) p.line(lead.x1, lead.y1, lead.x2, lead.y2, { gray: 0.5, width: 0.4 })
    // Baselines are anchored to the block's top/bottom, so a single-line label
    // lands exactly where it always did (name at pos.y-4, area at pos.y+7).
    const at = pos
    const shape = form
    const blk = box
    ink(() => {
      shape.lines.forEach((line, i) => {
        p.text(at.x, at.y - blk.h / 2 + 9 + i * 11, shape.size, line, { align: 'center', bold: true, gray: 0.2 })
      })
      p.text(at.x, at.y + blk.h / 2 - 6, 7.5, area, { align: 'center', gray: 0.4 })
    })
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
  // A.01 carries no knockout mask of any kind, so its names paint in place.
  roomLabels(p, state, map, [], plateBox(b), paintNow)
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
// Door / window schedule table — ONE column renderer, two places it is drawn:
// the A.02 legend panel, and the continuation sheet(s) the overflow paginates
// onto. The column is PANEL_W wide in both, so the two never drift.
// ---------------------------------------------------------------------------

/** What a plan opening tag reserves in the sheet's annotation occupancy: the
 *  11 pt glyph's knockout is 22 pt square (`tagMask`), plus 1 pt of slack a side
 *  so a mask cannot come to rest flush against a neighbouring glyph run. */
const PLAN_TAG_BOX = 24

/** The knockout's true extent, asked for only when the slack version finds
 *  nowhere at all (dwg A.02 needs it for 4 of 44 tags). */
const PLAN_TAG_MASK = 22

/** Row pitch of the door/window schedule (pt). */
const SCHED_ROW_H = 15
/** How far below its baseline a row reaches: the 8 pt tag glyph is centred at
 *  `ly - 3` with radius 8, so its mask bottom is `ly + 5`. This is what has to
 *  clear the panel's bottom edge, not the text baseline. */
const SCHED_ROW_DROP = 5
/** Distance from a column's section-title baseline to its FIRST row baseline
 *  (`scheduleHeader`'s own 8 + 10 + 4 advance) — so capacity can be computed
 *  before anything is drawn. */
const SCHED_HEADER_H = 22
/** Space a truncated column reserves for its "continued on A.NN" pointer. */
const SCHED_CONT_NOTE_H = 16

/**
 * The schedule's section title + grey header band, in a `PANEL_W`-wide column
 * whose left edge is `x` and whose title baseline is `yTop`. Returns the y from
 * which row baselines advance by `SCHED_ROW_H` (always `yTop + SCHED_HEADER_H`).
 */
function scheduleHeader(p: Page, x: number, yTop: number, title: string): number {
  let ly = yTop
  p.text(x + 8, ly, 9, title, { bold: true, gray: 0.3 })
  ly += 8
  p.box(x + 8, ly, PANEL_W - 16, 13, { fill: true, gray: 0.93 })
  ly += 10
  p.text(x + 30, ly, 7, 'TAG', { bold: true, gray: 0.4 })
  p.text(x + 66, ly, 7, 'TYPE', { bold: true, gray: 0.4 })
  p.text(x + 118, ly, 7, 'SIZE (W×H)', { bold: true, gray: 0.4 })
  p.text(x + 200, ly, 7, 'MATERIAL / SILL', { bold: true, gray: 0.4 })
  return ly + 4
}

/** One schedule row (tag glyph · tag · type · size · material/sill · rule). */
function scheduleRow(p: Page, x: number, ly: number, o: Opening): void {
  drawTagGlyph(p, x + 18, ly - 3, o.tag, o.kind, 8)
  p.text(x + 30, ly, 7.5, o.tag, { gray: 0.2 })
  p.text(x + 66, ly, 7.5, o.kind, { gray: 0.2 })
  p.text(x + 118, ly, 7.5, `${o.w.toFixed(2)} × ${o.h.toFixed(2)} m`, { gray: 0.2 })
  p.text(x + 200, ly, 7, o.sill ? `${o.material} ${o.sill}` : (o.material ?? '-'), { gray: 0.35 })
  p.line(x + 8, ly + 4, x + PANEL_W - 8, ly + 4, { gray: 0.9, width: 0.4 })
}

/**
 * How many rows a column can hold: rows advance from `firstY` by `SCHED_ROW_H`
 * and reach `SCHED_ROW_DROP` below their baseline, so the last legal baseline is
 * `bottom - SCHED_ROW_DROP`. CAPACITY IS MEASURED, not assumed — that is the
 * whole defect: the A.02 schedule had no concept of its panel's extent and drew
 * every opening it was given, running rows through the title block (rows W16-W23
 * on seeded), past the sheet-number box, and off the bottom of the printable
 * page (baselines at y 807-814 pt against a frame bottom of 801.89 pt).
 */
function scheduleCapacity(firstY: number, bottom: number): number {
  return Math.max(0, Math.floor((bottom - SCHED_ROW_DROP - firstY) / SCHED_ROW_H))
}

// ---------------------------------------------------------------------------
// Construction & furnishing plan (A.02)
// ---------------------------------------------------------------------------

/** A.02, plus what its legend panel could not hold. `noteContinuedOn` stamps the
 *  pointer into the panel once the continuation sheets have taken their numbers
 *  (they are appended after the finish schedule, so their A.NN is not known
 *  while the plan is being drawn). */
interface ConstructionSheet {
  page: Page
  /** Openings that did not fit the panel, in schedule order. */
  overflow: Opening[]
  noteContinuedOn: (nos: string[]) => void
}

function constructionSheet(state: DocState, opts: DrawingSetOpts, no: string): ConstructionSheet {
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

  // ---------------------------------------------------------------------
  // PLAN ANNOTATION — one occupancy, then the three paint passes.
  //
  // Every ink-bearing annotation the plate carries (perimeter dimensions,
  // per-room dimensions, room names + their ordinals + their area strings,
  // opening tags) reserves its box in the SAME `occ`, in that order — widest
  // authority first, most-movable last — and NOTHING is painted until the last
  // box is reserved. Then knockouts, then symbols, then type ({@link PlanInk}).
  //
  // Both halves are load-bearing, and each fixes a different half of the same
  // defect. Families used to de-collide only within themselves: tags avoided
  // tags (via a second occupancy list) and room labels avoided room labels, so
  // whichever painted last won. Confining the tags to the plate closed their
  // escape route and the least-overlap fallback started parking them on room
  // names, where `tagMask`'s white knockout erased the name — 76% of "BOOTH"
  // (of PHONE BOOTH 2), a whole "m²", 43% of the "(4)" ordinal. Placing
  // strictly stops a tag from being put there; painting every mask and every
  // symbol before any type means even the last-resort placement cannot erase a
  // word.
  // ---------------------------------------------------------------------
  const occ: OccBox[] = []
  // E7, the sheet half. `occ` is SEEDED WITH THE FURNITURE FOOTPRINTS, not just
  // with the type already placed. Every label pass below knocks a white halo out
  // of what it lands on, so a name parked over a desk erases the symbol the
  // Furniture Inventory bills — the workbook's own defect (planGraphic, E7),
  // which this producer inherited because it started its occupancy list empty.
  // Labels now step aside for furniture exactly as they already step aside for
  // each other: DISPLACED, never dropped or shrunk, so the "every room labelled
  // exactly once" invariant still holds and the symbols stay visible.
  for (const c of state.components) {
    if (c.category === 'Door') continue
    occ.push({ ...componentBox(c, map, k), weight: FURNITURE_WEIGHT })
  }
  const plate = plateBox(b)
  const inkPasses = planInk()
  const ink: InkSink = (d) => inkPasses.type.push(d)

  dimStrings(p, state, map, ink, occ)
  roomDims(p, state, map, occ, ink)
  roomLabels(p, state, map, occ, plate, ink)

  const openings = openingSchedule(state)
  for (const o of openings) {
    const pt = map(o.x, o.y)
    // STRICT FIRST. An opening tag is plan content, so it is confined to the
    // plate; and it is the family that carries a leader by construction, so it
    // is the family that yields. `tryPlaceNear` refuses to settle — it walks the
    // shared 13 candidates and then the wider rings, and a "no" means no spot
    // near this opening is clear of a dimension, a room name or another tag.
    // Displacing a tag over furniture with a leader back to the opening is
    // correct drafting; a tag over a room name is not.
    const pos =
      tryPlaceNear(occ, pt.x, pt.y, PLAN_TAG_BOX, PLAN_TAG_BOX, plate) ??
      // Still nothing: ask again for the knockout's TRUE extent, with no slack.
      // A second, tighter lattice (the candidate steps are derived from the box)
      // is a real second chance, and a tag that merely touches its neighbour
      // still erases nothing.
      tryPlaceNear(occ, pt.x, pt.y, PLAN_TAG_MASK, PLAN_TAG_MASK, plate) ??
      // Nowhere clear within reach: take the least-overlapping in-plate spot
      // rather than dropping the tag. Nothing is erased even here (the mask is
      // painted before every glyph on this sheet), and the leader keeps it
      // attributable.
      placeNear(occ, pt.x, pt.y, PLAN_TAG_BOX, PLAN_TAG_BOX, plate)
    if (Math.hypot(pos.x - pt.x, pos.y - pt.y) > 14) {
      p.line(pt.x, pt.y, pos.x, pos.y, { gray: 0.5, width: 0.4 })
    }
    inkPasses.masks.push(() => tagMask(p, pos.x, pos.y))
    inkPasses.symbols.push(() => tagBody(p, pos.x, pos.y, o.tag, o.kind))
  }

  paintPlanInk(inkPasses)

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

  // Doors & windows specifications — CAPACITY FIRST, then rows. The panel's
  // legal extent is the title-block band top; anything past it paginates.
  const firstRow = scheduleHeader(p, b.panelX, ly, 'DOORS & WINDOWS SPECIFICATIONS')
  const capFull = scheduleCapacity(firstRow, PANEL_BOTTOM)
  const cap = openings.length > capFull ? scheduleCapacity(firstRow, PANEL_BOTTOM - SCHED_CONT_NOTE_H) : capFull
  const overflow = openings.slice(cap)
  ly = firstRow
  if (openings.length === 0) {
    ly += SCHED_ROW_H
    p.text(b.panelX + 30, ly, 8, 'No tagged openings in this fit.', { gray: 0.5 })
  }
  for (const o of openings.slice(0, cap)) {
    ly += SCHED_ROW_H
    scheduleRow(p, b.panelX, ly, o)
  }
  const noteY = ly + 14
  const noteX = b.panelX + 8

  const scaleN = planScaleN(metersPerPx, wPx, b.planW)
  titleBlock(
    p,
    tb(opts, no, 'Construction & Furnishing Plan', scaleN ? `1:${scaleN}` : 'NTS', keyPlanJpeg(state, 'all', 340, 190)),
  )
  return {
    page: p,
    overflow,
    noteContinuedOn: (nos) => {
      if (nos.length === 0) return
      const where = nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : nos[0]
      p.text(noteX, noteY, 7.5, `SCHEDULE CONTINUED ON ${where}  (${overflow.length} MORE)`, {
        bold: true,
        gray: 0.35,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Door & window schedule — continuation sheet(s) for the A.02 panel's overflow
// ---------------------------------------------------------------------------

/** Continuation sheets lay the same PANEL_W column three-up across the frame. */
const CONT_COLS = 3
const CONT_COL_GAP = 40
/** Section-title baseline of a continuation column. */
const CONT_COL_TOP = 72

/** Rows one continuation column holds, from the same measured arithmetic the
 *  A.02 panel uses (8 pt of air above the band so no rule touches it). */
function contColCapacity(): number {
  return scheduleCapacity(CONT_COL_TOP + SCHED_HEADER_H, PANEL_BOTTOM - 8)
}

function scheduleContPage(
  state: DocState,
  opts: DrawingSetOpts,
  rows: Opening[],
  no: string,
  from: string,
  idx: number,
  count: number,
): Page {
  const p = new Page()
  const perCol = contColCapacity()
  p.text(MARGIN + 6, 42, 15, `DOOR & WINDOW SCHEDULE (CONT.)`, { bold: true, gray: 0.1 })
  if (count > 1) {
    p.text(PAGE_W - MARGIN - 6, 42, 9, `SHEET ${idx + 1} OF ${count}`, { align: 'right', gray: 0.4, bold: true })
  }
  p.text(MARGIN + 6, 58, 8, `CONTINUED FROM ${from}  ·  CONSTRUCTION & FURNISHING PLAN`, { gray: 0.45 })
  for (let c = 0; c < CONT_COLS; c++) {
    const slice = rows.slice(c * perCol, (c + 1) * perCol)
    if (slice.length === 0) break
    const x = MARGIN + 6 + c * (PANEL_W + CONT_COL_GAP)
    let ly = scheduleHeader(p, x, CONT_COL_TOP, 'DOORS & WINDOWS SPECIFICATIONS (CONT.)')
    for (const o of slice) {
      ly += SCHED_ROW_H
      scheduleRow(p, x, ly, o)
    }
  }
  titleBlock(
    p,
    tb(opts, no, 'Door & Window Schedule (cont.)', 'NTS', state.walls.length > 0 ? keyPlanJpeg(state, 'all', 340, 190) : null),
  )
  return p
}

/**
 * The continuation sheet(s) carrying the openings A.02's legend panel could not
 * hold — a full-frame, three-column reprise of the SAME schedule column, with
 * its column headers repeated on every column of every sheet.
 *
 * Self-numbered `A.(startNo + i + 1)` exactly like `sectionSheets`,
 * `servicesSheets` and `finishScheduleSheets`: the orchestrator passes
 * `startNo = numbered.length`, so the sheets take the next free slots and the
 * contents index and every title block stay in sync with no second numbering
 * scheme. They sit at the back of the set, beside the Room Finish Schedule,
 * which is where a set's schedules belong — and it means A.01-A.09 keep the
 * numbers they already had.
 */
function scheduleContSheets(
  state: DocState,
  opts: DrawingSetOpts,
  rows: Opening[],
  startNo: number,
  from: string,
): { page: Page; no: string; title: string }[] {
  const perSheet = contColCapacity() * CONT_COLS
  const chunks: Opening[][] = []
  for (let i = 0; i < rows.length; i += perSheet) chunks.push(rows.slice(i, i + perSheet))
  const no = (i: number) => `A.${String(startNo + i + 1).padStart(2, '0')}`
  return chunks.map((slice, i) => ({
    page: scheduleContPage(state, opts, slice, no(i), from, i, chunks.length),
    no: no(i),
    title: 'Door & Window Schedule (cont.)',
  }))
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

/** The tag's white backdrop mask — an OPAQUE `2r × 2r` knockout, so that the
 *  plan raster does not bleed through the glyph. It is also the one thing on the
 *  plan that can erase finished type, which is why a sheet with tags on it
 *  paints every mask before any glyph ({@link InkSink}). */
function tagMask(p: Page, cx: number, cy: number, size = 11): void {
  p.box(cx - size, cy - size, size * 2, size * 2, { fill: true, gray: 1 })
}

/** The tag itself, WITHOUT its mask: circle for a door (D), hexagon for a
 *  window (W) — true polygon outlines — plus the tag's own glyph run. */
function tagBody(p: Page, cx: number, cy: number, tag: string, kind: 'Door' | 'Window', size = 11): void {
  if (kind === 'Door') {
    polyOutline(p, cx, cy, size, 16, 0, { rgb: INK, width: 0.9 })
  } else {
    polyOutline(p, cx, cy, size, 6, Math.PI / 6, { rgb: BLUE_WALL, width: 1 })
  }
  p.text(cx, cy + size * 0.32, size * 0.68, tag, { align: 'center', bold: true, gray: 0.12 })
}

/** Mask + body in one pass, for a caller with nothing underneath to protect:
 *  the schedule column, where the tag sits on blank panel. The plan pass on A.02
 *  calls the two halves separately, in two phases. */
function drawTagGlyph(p: Page, cx: number, cy: number, tag: string, kind: 'Door' | 'Window', size = 11): void {
  tagMask(p, cx, cy, size)
  tagBody(p, cx, cy, tag, kind, size)
}

/**
 * One architect dimension string between two canvas points (a→b) along an
 * axis-aligned edge, drawn on a line offset perpendicular by `off` pt (sign
 * chooses the side; e.g. negative = above/left, positive = below/right). Thin
 * extension lines join the measured edge to the dim line, ticks cap each end,
 * and the numeric metre label (IBM Plex Mono via the sheet font) sits centred on
 * the line's far side. Shared by BOTH the overall-perimeter and the per-room
 * runs so there is exactly one arrow/tick/label renderer. `horizontal` picks the
 * edge axis: true → runs in x (label above/below), false → runs in y (label to
 * the side).
 *
 * The numeric label is INK LIKE ANY OTHER ANNOTATION: it goes out through `ink`
 * (so a sheet can paint it behind every knockout) and reserves its own box in
 * `occ` (so the room-name and opening-tag passes that follow de-conflict against
 * it). The line work itself is drawn in place — it is under everything by
 * intent, and a tag mask clipping a dimension line where the tag sits is the
 * drafting convention, not a defect.
 */
function dimString(
  p: Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
  off: number,
  meters: number,
  horizontal: boolean,
  ink: InkSink,
  occ: OccBox[],
): void {
  const G = 0.4 // dim-line gray
  const W = 0.5 // dim-line width
  const EXT = { gray: 0.65, width: 0.3 } // extension-line style
  const label = `${meters.toFixed(2)} m`
  /** Queue the label's glyphs and reserve the box they will occupy. */
  const put = (x: number, baseline: number, align: 'left' | 'center' | 'right') => {
    occ.push(textBoxAt(x, baseline, 7.5, label, align))
    ink(() => p.text(x, baseline, 7.5, label, { align, gray: 0.3 }))
  }
  if (horizontal) {
    const y = a.y + off
    p.line(a.x, a.y, a.x, y, EXT)
    p.line(b.x, b.y, b.x, y, EXT)
    p.line(a.x, y, b.x, y, { gray: G, width: W })
    p.line(a.x, y - 3, a.x, y + 3, { gray: G, width: W })
    p.line(b.x, y - 3, b.x, y + 3, { gray: G, width: W })
    put((a.x + b.x) / 2, off >= 0 ? y + 11 : y - 4, 'center')
  } else {
    const x = a.x + off
    p.line(a.x, a.y, x, a.y, EXT)
    p.line(b.x, b.y, x, b.y, EXT)
    p.line(x, a.y, x, b.y, { gray: G, width: W })
    p.line(x - 3, a.y, x + 3, a.y, { gray: G, width: W })
    p.line(x - 3, b.y, x + 3, b.y, { gray: G, width: W })
    if (off >= 0) {
      put(x + 4, (a.y + b.y) / 2 + 3, 'left')
      return
    }
    // CONTAINMENT. Right-aligned at `x - 4` is the normal place for an outward
    // vertical dim, and it is where the string stays whenever there is room.
    // There is not always room: `renderPrintCanvas` pads the plate by 48 px
    // (~18 pt), so on a width-constrained plate the left wall lands barely
    // inside the plate and the string runs off the printable page — measured on
    // the delivered seeded/testfit A.02, "24.00 m" occupied x 16.26..43.36 pt
    // against MARGIN = 40, i.e. mostly in the unprintable left margin. When the
    // string will not fit beside the line, it moves to the HEAD of that line
    // (the plate's own top padding is clear there, and the string still touches
    // the dimension it belongs to) with its left edge clamped to the frame.
    const lw = textWidth(label, 7.5)
    if (x - 4 - lw >= MARGIN + 2) {
      put(x - 4, (a.y + b.y) / 2 + 3, 'right')
    } else {
      put(Math.max(MARGIN + 2, x - lw / 2), Math.min(a.y, b.y) - 5, 'left')
    }
  }
}

/** Overall width + height dimension strings around the plate (construction).
 *  Their two labels are the first entries in the sheet's shared annotation
 *  occupancy — they own their position absolutely (they measure the building),
 *  so everything placed afterwards de-conflicts around them. */
function dimStrings(
  p: Page,
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
  ink: InkSink,
  occ: OccBox[],
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

  // Bottom edge — overall width (offset outward, below the plate).
  dimString(p, map(minX, maxY), map(maxX, maxY), 16, maxX - minX, true, ink, occ)
  // Left edge — overall height (offset outward, left of the plate).
  dimString(p, map(minX, minY), map(minX, maxY), -16, maxY - minY, false, ink, occ)
}

// per-room dim lines sit this far inside the room's bottom / left edge (pt).
const DIM_INSET = 12

/**
 * Per-room internal dimension runs (construction plan). For every
 * non-circulation zone we draw its width along the bottom edge and its depth
 * along the left edge, each inset just INSIDE the room (so a run never spills
 * into the neighbouring room the way an outward offset would on a packed plate)
 * — one consistent L of dimensions per room, in the same style as the overall
 * perimeter via the shared `dimString` helper. A run is skipped when the room is
 * too small on the sheet for its label to read, keeping dense fits legible.
 * Rectangular rooms are dimensioned exactly; non-rectangular zones (RectRing
 * cores) are dimensioned by their bounding extents (outer w × h). Each drawn
 * label's box is recorded in `occ` — by `dimString` itself, from the baseline it
 * actually draws on — so the room name/opening-tag passes that run afterwards
 * de-conflict around the dimensions. Deterministic.
 */
function roomDims(
  p: Page,
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
  occ: OccBox[],
  ink: InkSink,
): void {
  for (const z of state.zones ?? []) {
    if (isGroundZone(z.zone_type)) continue
    const s = z.shape // Rect or RectRing — both centred at (x,y) with outer w×h
    if (s.kind === 'Poly') continue // boundary-conforming (Circulation-only): no orthogonal dim string
    const x0 = s.x - s.w / 2
    const x1 = s.x + s.w / 2
    const y0 = s.y - s.h / 2
    const y1 = s.y + s.h / 2
    const bl = map(x0, y1)
    const br = map(x1, y1)
    const tl = map(x0, y0)
    // Width along the bottom edge, inset upward into the room. Skip when the
    // room is too narrow for the label, or when the label box would land on an
    // already-placed dim label (declutters two rooms sharing a baseline, e.g. an
    // open field and a cellular room whose bottom edges coincide).
    const wLabelW = textWidth(`${s.w.toFixed(2)} m`, 7.5)
    const wBox = { x: (bl.x + br.x) / 2 - wLabelW / 2, y: bl.y - DIM_INSET - 12, w: wLabelW, h: 12 }
    if (Math.abs(br.x - bl.x) > wLabelW + 8 && !occ.some((b) => boxesOverlap(wBox, b))) {
      dimString(p, bl, br, -DIM_INSET, s.w, true, ink, occ)
    }
    // Depth along the left edge, inset rightward into the room (same guards).
    const hLabelW = textWidth(`${s.h.toFixed(2)} m`, 7.5)
    const hBox = { x: tl.x + DIM_INSET + 4, y: (tl.y + bl.y) / 2 - 5, w: hLabelW, h: 12 }
    if (Math.abs(bl.y - tl.y) > 26 && !occ.some((b) => boxesOverlap(hBox, b))) {
      dimString(p, tl, bl, DIM_INSET, s.h, false, ink, occ)
    }
  }
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

/** Split takeoff's "Desk W70 X L140" into a display name + "70 × 140 cm" dims.
 *  The parser lives beside the formatter it inverts (`takeoff.itemDescription`);
 *  this shim only adapts `dims: null` to the card's optional field. */
function parseItem(desc: string): { name: string; dims?: string } {
  const { name, dims } = parseItemDescription(desc)
  return dims ? { name, dims } : { name }
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
  // A.02 draws as many schedule rows as its legend panel measures room for and
  // hands back the rest; the continuation sheets are appended at the back of the
  // set (below), and only then can A.02 be told which A.NN to point at.
  let openingOverflow: Opening[] = []
  let constructionNo = ''
  let noteContinuedOn: ((nos: string[]) => void) | null = null
  add('construction', 'Construction & Furnishing Plan', (no) => {
    const built = constructionSheet(state, opts, no)
    openingOverflow = built.overflow
    constructionNo = no
    noteContinuedOn = built.noteContinuedOn
    return built.page
  })
  // ── Services plans: Reflected Ceiling Plan + Power & Data (servicesSheets.ts) ──
  // Grouped with the architectural plans (before sections). servicesSheets builds
  // both sheets self-numbered A.(startNo+i+1); startNo=numbered.length keeps them
  // in the running A.NN sequence. Each sheet honors its own M6 toggle (rcp/power).
  // Try-wrapped so a services-render failure never sinks the rest of the set.
  if (want('rcp') || want('power')) {
    try {
      for (const s of servicesSheets(state, { meta: opts.meta, startNo: numbered.length })) {
        if (want(s.kind)) numbered.push({ title: s.title, no: s.no, page: s.page })
      }
    } catch (err) {
      console.warn('drawing-set: services sheets skipped —', err)
    }
  }
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
  // ── Room Finish Schedule (export/finishSchedule.ts) — the closing schedule ──
  // Self-numbered like sections/services; startNo=numbered.length keeps it in the
  // running A.NN sequence. Paginates to continuation sheets. Try-wrapped so a
  // schedule failure never sinks the rest of the set.
  if (want('finishes')) {
    try {
      for (const s of finishScheduleSheets(state, { meta: opts.meta, startNo: numbered.length })) {
        numbered.push({ title: s.title, no: s.no, page: s.page })
      }
    } catch (err) {
      console.warn('drawing-set: finish schedule skipped —', err)
    }
  }
  // ── Door & window schedule continuation (A.02's panel overflow) ──
  // Self-numbered from `numbered.length` like every other appended sheet, so the
  // contents index and the title blocks follow automatically; A.02 then gets its
  // "continued on A.NN" pointer stamped into the panel it was drawn with.
  if (openingOverflow.length > 0) {
    const cont = scheduleContSheets(state, opts, openingOverflow, numbered.length, constructionNo)
    for (const s of cont) numbered.push({ title: s.title, no: s.no, page: s.page })
    ;(noteContinuedOn as ((nos: string[]) => void) | null)?.(cont.map((s) => s.no))
  }

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
