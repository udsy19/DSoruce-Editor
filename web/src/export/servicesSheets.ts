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
import {
  labelLeader,
  paintPlanInk,
  placeNear,
  planInk,
  tryPlaceNear,
  zoneBoxOnSheet,
  type Leader,
  type OccBox,
  type PlanInk,
} from './sheetSet'
import type { SheetSetMeta } from './sheetSet'
import { roomDisplayNames, roomLabelForms } from './roomNaming'
import type { DocState } from '../types/doc'
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
/** Lighting-circuit tag type size (pt). */
const CIRCUIT_SIZE = 6

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
// Room labels — DE-COLLIDED FIRST, painted last.
//
// Each label is painted as a white knockout halo plus its text, in zone order,
// so that two labels landing on the same spot do not merely overlap: the later
// one's halo ERASES the earlier one's glyphs. That is defect D3, and it is what
// produced "PHON PHON PHONE BOOTH 3" and "O OPEN WORKS OPEN WORKSPACE" on the
// delivered sheets — and, on dwg, a "Wellness Room" so far interleaved that a
// text extractor reads it as "W" + "ELLNESS". The name is not clipped; there is
// no clip region here at all. It is over-printed.
//
// So the labels are placed BEFORE any ink is laid down, through the drawing
// set's own `tryPlaceNear`/`labelLeader`/`zoneBoxOnSheet` — the same machinery
// A.02 and the plan graphic use (there is deliberately no second de-collision
// system in this file), with the plate as a hard boundary so a displaced label
// cannot walk off the drawing. A label that ends up off the room it names
// carries a leader back to it.
//
// When even a displaced label has nowhere clear to go, the fit ladder
// (`roomLabelForms`) steps the label down — shrink to a 70% floor, then wrap to
// two lines, then the shared abbreviation map — and the placement is retried per
// rung. Nothing is ever ellipsized and no fragment is ever printed.
//
// Fixture glyphs are then nudged off the final label boxes (`clearOfLabels`).
// (screen pt, top-down)
// ---------------------------------------------------------------------------

interface LabelBox {
  x: number // top-left of the knockout halo
  y: number
  w: number
  h: number
  cx: number // text centre
  cy: number // FIRST baseline
  lines: string[]
  size: number
  leader: Leader | null
}

/** Room-label type: 7.5 pt, the face the schedules and the plan share. */
const LABEL_SIZE = 7.5
/** Horizontal padding of the knockout halo around the glyph run (3 pt a side —
 *  the pad SG3 measures label separation with). */
const HALO_PAD = 6
/** Extra clearance reserved during PLACEMENT only, never drawn: `textWidth` is
 *  an estimator and the delivered glyph run is measured by the renderer's own
 *  font. Two labels are therefore parked 1 pt further apart than their halos
 *  need, so an under-estimate cannot turn into a touching pair on the page. */
const PLACE_SLACK = 2

/** Halo box for a laid-out label, from its first baseline. Ascent/descent are
 *  fractions of the type size, so the box tracks a shrunk rung exactly. */
function haloBox(lines: string[], size: number, width: number, cx: number, baseline: number) {
  const ascent = size * 1.07
  const descent = size * 0.53
  const gap = size * 1.4
  const w = width + HALO_PAD
  const h = ascent + descent + (lines.length - 1) * gap
  return { x: cx - w / 2, y: baseline - ascent, w, h, gap, ascent }
}

/**
 * Every non-circulation room label, laid out and de-collided (same transform the
 * plan uses). Zone order is the document's own id order, so the result is
 * deterministic. `bounds` is the plate viewport — no label may leave it.
 *
 * `occ` is the SHEET's annotation occupancy, not a private one: the fixture
 * glyphs and the lighting-circuit tags that are placed after these labels have
 * to see where the names went, or they land under a halo and are erased by it —
 * the same cross-family failure that put opening tags on room names on A.02.
 *
 * Room NAMES come from the one shared helper (`roomDisplayNames`), so a room
 * that reads "Open Workspace (5)" here reads "Open Workspace (5)" on the finish
 * schedule and in the QTO workbook too.
 */
function roomLabelBoxes(
  state: DocState,
  map: (x: number, y: number) => { x: number; y: number },
  bounds: OccBox,
  occ: OccBox[],
): LabelBox[] {
  const names = roomDisplayNames(state)
  const out: LabelBox[] = []
  for (const z of state.zones ?? []) {
    if (z.zone_type === 'Circulation' || !z.label) continue
    const ctr = zoneCenter(z.shape)
    const c = map(ctr.x, ctr.y)
    const text = (names.get(z.id) ?? z.label).toUpperCase()
    const room = zoneBoxOnSheet(z.shape, map)

    const forms = roomLabelForms(text, LABEL_SIZE, (t, s) => textWidth(t, s, false))
    let chosen = forms[0]
    let pos: { x: number; y: number } | null = null
    for (const form of forms) {
      const box = haloBox(form.lines, form.size, form.width, c.x, c.y)
      pos = tryPlaceNear(occ, c.x, c.y, box.w + PLACE_SLACK, box.h + PLACE_SLACK, bounds)
      if (pos) {
        chosen = form
        break
      }
    }
    const probe = haloBox(chosen.lines, chosen.size, chosen.width, c.x, c.y)
    // Every rung collided everywhere: take the least-overlapping spot for the
    // narrowest rung rather than dropping the room's name off the drawing.
    if (!pos) pos = placeNear(occ, c.x, c.y, probe.w + PLACE_SLACK, probe.h + PLACE_SLACK, bounds)

    const baseline = pos.y - probe.h / 2 + probe.ascent
    const box = haloBox(chosen.lines, chosen.size, chosen.width, pos.x, baseline)
    out.push({
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      cx: pos.x,
      cy: baseline,
      lines: chosen.lines,
      size: chosen.size,
      leader: labelLeader(c.x, c.y, pos, box.w, box.h, room),
    })
  }
  return out
}

/**
 * A services glyph whose meaning is a WORD rather than a shape: the exit
 * luminaire's `E` and the distribution board's `DB`, both reversed out of an
 * opaque amber tile. Every other ceiling/power symbol is a line figure that
 * still reads through a neighbour.
 *
 * This is the line between "glyph-on-glyph is not a defect" and the defect: two
 * troffers sharing a spot are two rectangles, and a reader sees two fixtures;
 * two exit tiles sharing a spot are one amber square with an unreadable letter
 * on it, and the second luminaire has vanished from the drawing.
 */
function glyphCarriesType(t: CeilingFixtureType | PowerPointType): boolean {
  return t === 'exit' || t === 'db'
}

/**
 * Nudge a services glyph of radius `s` clear of the type already placed.
 *
 * THE SHARED STRICT PLACER, not a placement system of its own: `tryPlaceNear`
 * walks the same 13 candidates and 20 wider rings every room label and opening
 * tag is placed with, so a symbol moves the way a label moves. Glyph-on-TYPE is
 * the thing being avoided: by the time the fixtures are placed `occ` holds the
 * room names and the circuit tags, and a symbol yields to both.
 *
 * WHETHER THE GLYPH TAKES A SEAT is `glyphCarriesType`'s question, and it is the
 * whole of defect D-R. A line-figure symbol is handed a COPY of `occ` and
 * reserves nothing, deliberately — the ceiling/power grid is regular by intent
 * and two overlapping troffers are still two readable troffers. A glyph that
 * carries a WORD is annotation: it reserves in the sheet's one occupancy like
 * every other family that prints type, so the next one cannot be nudged onto it.
 * Without that seat, two exit luminaires were nudged 2.91 pt apart on seeded
 * A.03 — one amber tile on another, their two `E`s 39% overlapped.
 *
 * WHEN NOTHING WITHIN REACH IS CLEAR the two kinds part again. A line figure
 * stays on its grid point — it is derived from the layout and belongs there, and
 * it can no longer erase what it lands on because every symbol is painted before
 * any type. A word-carrying tile takes the third rung of the SAME ladder A.02's
 * opening tags use, `placeNear`: the least-overlapping spot inside the plate,
 * which always places and always reserves. Staying put is not open to it —
 * "nowhere clear to go" is exactly the case where two of them ended up on one
 * point, and the true spot is the one square already known to be taken. A tile
 * that ended up away from its fixture carries a `labelLeader` back to it.
 */
function clearOfLabels(
  cx: number,
  cy: number,
  s: number,
  occ: OccBox[],
  bounds: OccBox,
  reserve: boolean,
): { x: number; y: number } {
  const box = s * 2
  if (!reserve) return tryPlaceNear([...occ], cx, cy, box, box, bounds) ?? { x: cx, y: cy }
  return tryPlaceNear(occ, cx, cy, box, box, bounds) ?? placeNear(occ, cx, cy, box, box, bounds)
}

/**
 * The lighting-circuit tags (`LC-01` …), placed and queued.
 *
 * They used to be printed straight at their switch (`sw.x + 4, sw.y - 3`) with
 * no de-collision and no seat in the sheet's occupancy, and they are the family
 * that pays for that twice over: a room-label halo, painted afterwards, ERASES
 * them (the `LC-` of `LC-02` eaten by FOCUS ROOM 2 on seeded A.03), and two
 * circuits sharing a switch print their tags on the same point (six of them at
 * one spot on seeded, five on dwg). Both are the A.02 blocker's failure class —
 * a family that de-conflicts only within itself, and a mask that outranks
 * someone else's type.
 *
 * So they take their turn in the SAME occupancy, after the names and the fixture
 * glyphs, through the same strict placer; the original spot is candidate one, so
 * a tag with room around it does not move. A tag that ends up away from its
 * switch carries a `labelLeader` back to it.
 */
function circuitTags(
  p: Page,
  circuits: { sw: { x: number; y: number }; label: string }[],
  map: (x: number, y: number) => { x: number; y: number },
  bounds: OccBox,
  occ: OccBox[],
  ink: PlanInk,
): void {
  for (const cc of circuits) {
    const sw = map(cc.sw.x, cc.sw.y)
    const w = textWidth(cc.label, CIRCUIT_SIZE, true)
    const asc = CIRCUIT_SIZE * 1.07
    const h = asc + CIRCUIT_SIZE * 0.53
    // Candidate one of the shared stack is the box centred here, i.e. exactly
    // the left-aligned run at (sw.x + 4, sw.y - 3) this always drew.
    const ax = sw.x + 4 + w / 2
    const ay = sw.y - 3 - asc + h / 2
    const pos =
      tryPlaceNear(occ, ax, ay, w + 2, h + 2, bounds) ?? placeNear(occ, ax, ay, w + 2, h + 2, bounds)
    const lead = labelLeader(ax, ay, pos, w + 2, h + 2)
    if (lead) p.line(lead.x1, lead.y1, lead.x2, lead.y2, { rgb: CIRCUIT, width: 0.4 })
    ink.type.push(() =>
      p.text(pos.x - w / 2, pos.y - h / 2 + asc, CIRCUIT_SIZE, cc.label, { rgb: CIRCUIT, bold: true }),
    )
  }
}

/**
 * Queue the room-name labels: leaders in place, halos into the sheet's MASK
 * pass, glyphs into its GLYPH pass.
 *
 * ALL leaders first, then all halos: a leader may cross a neighbouring label's
 * halo, and a leader painted over finished text would be the same over-printing
 * defect in miniature. The boxes themselves cannot collide — `roomLabelBoxes`
 * de-collided them before a single mark was made — so no halo can erase another
 * label's glyphs.
 *
 * The halo goes into the caller's mask pass rather than being painted here for
 * the same reason one sheet-wide occupancy exists: the halo is opaque, and the
 * RCP carries two OTHER ink families (fixture glyphs, circuit tags). With every
 * mask and every symbol behind all type, a halo can no longer erase a circuit
 * tag whatever order the families were placed in.
 */
function drawRoomLabels(p: Page, labels: LabelBox[], ink: PlanInk): void {
  for (const l of labels) {
    if (l.leader) p.line(l.leader.x1, l.leader.y1, l.leader.x2, l.leader.y2, { gray: 0.5, width: 0.4 })
  }
  for (const l of labels) ink.masks.push(() => p.box(l.x, l.y, l.w, l.h, { fill: true, gray: 1 }))
  for (const l of labels) {
    ink.type.push(() =>
      l.lines.forEach((line, i) => {
        p.text(l.cx, l.cy + i * l.size * 1.4, l.size, line, { align: 'center', gray: 0.45 })
      }),
    )
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

    // ONE occupancy for every ink family the plate carries (room names, fixture
    // glyphs, circuit tags) and the three paint passes over it — knockouts,
    // symbols, then type. See `circuitTags` / `drawRoomLabels`.
    const plate = { x: b.planX, y: b.planY, w: b.planW, h: b.planH }
    const occ: OccBox[] = []
    const ink = planInk()

    const layout = ceilingLayout(state)
    const labels = roomLabelBoxes(state, map, plate, occ)
    // Ceiling grid first, so the fixture knockouts mask over it cleanly.
    for (const g of layout.grid) {
      const a = map(g.x1, g.y1)
      const c = map(g.x2, g.y2)
      p.line(a.x, a.y, c.x, c.y, { gray: 0.86, width: 0.35 })
    }
    // Lighting-circuit switch legs under the glyphs (thin green runs).
    const circuits = lightingCircuits(state)
    for (const cc of circuits) {
      let prev = map(cc.sw.x, cc.sw.y)
      for (const lum of cc.luminaires) {
        const q = map(lum.x, lum.y)
        p.line(prev.x, prev.y, q.x, q.y, { rgb: CIRCUIT, width: 0.5 })
        prev = q
      }
    }
    // TYPE BEFORE SYMBOLS. The circuit tags take their seats next, so they have
    // only the room names to work around and the strict placer nearly always
    // finds them a clear one; the fixture glyphs then nudge off both. A ceiling
    // symbol carries its meaning in its shape and can absorb a nudge along the
    // grid — a two-glyph tag under a symbol cannot be read at all.
    circuitTags(p, circuits, map, plate, occ, ink)
    for (const f of layout.fixtures) {
      const pt = map(f.x, f.y)
      const size = f.type === 'luminaire' ? 6 : f.type === 'exit' ? 5 : 5.5
      const carriesType = glyphCarriesType(f.type)
      const q = clearOfLabels(pt.x, pt.y, size, occ, plate, carriesType)
      // A word-carrying tile that had to move says where its fixture actually
      // is; a line-figure symbol absorbs its nudge along the grid, as before.
      const lead = carriesType ? labelLeader(pt.x, pt.y, q, size * 2, size * 2) : null
      if (lead) p.line(lead.x1, lead.y1, lead.x2, lead.y2, { gray: 0.6, width: 0.4 })
      ink.masks.push(() => mask(p, q.x, q.y, size))
      ink.symbols.push(() => ceilGlyph(p, f.type, q.x, q.y, size, false))
    }
    drawRoomLabels(p, labels, ink)
    paintPlanInk(ink)

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

    // Same contract as the RCP: one occupancy, then knockouts, symbols, type.
    const plate = { x: b.planX, y: b.planY, w: b.planW, h: b.planH }
    const occ: OccBox[] = []
    const ink = planInk()

    const layout = powerLayout(state)
    const labels = roomLabelBoxes(state, map, plate, occ)
    for (const pt of layout.points) {
      const m = map(pt.x, pt.y)
      const size = pt.type === 'db' ? 6 : pt.type === 'floorbox' ? 5.5 : 4.5
      const carriesType = glyphCarriesType(pt.type)
      const q = clearOfLabels(m.x, m.y, size, occ, plate, carriesType)
      const lead = carriesType ? labelLeader(m.x, m.y, q, size * 2, size * 2) : null
      if (lead) p.line(lead.x1, lead.y1, lead.x2, lead.y2, { gray: 0.6, width: 0.4 })
      ink.masks.push(() => mask(p, q.x, q.y, size))
      ink.symbols.push(() => powerGlyph(p, pt.type, q.x, q.y, size, false))
    }
    drawRoomLabels(p, labels, ink)
    paintPlanInk(ink)

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
