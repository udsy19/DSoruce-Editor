// Space-planning report exporter — the multi-page A3-landscape PDF that
// replicates the qbiq "Sample Report" deliverable (see
// docs/reference/qbiq/…/Crystal Tower Modern…pdf):
//
//   cover · 3D virtual-tour page · one page per alternative · summary
//
// It is built entirely on the hand-written PDF primitives in `pdf.ts`
// (buildMultiPagePdfBytes + ContentOp, now RGB-capable) — no new PDF engine,
// no new deps. Colored floor plans reuse pdf.ts's `renderPrintCanvas` (zones +
// CAD furniture symbols + walls) so a report plan is pixel-identical to the
// single-sheet PDF export; legend swatches reuse the same PRINT_ZONE_FILL
// palette so the key matches the drawing.
//
// Two entry points:
//   • buildReportModel(...)  — PURE: scratch-clones each snapshot and computes
//     every KPI. No canvas, so it is unit-testable in node (needs only wasm).
//   • exportSpacePlanningReport(...) — renders the model to pages and downloads.
//
// India-first note (CLAUDE.md): the app is ₹/m², but this format mirrors qbiq's
// sf/seats/density-sqf-per-person vocabulary. We keep USF in sf and report
// density in BOTH sqf/person (qbiq-parity, primary) and m²/person; areas in the
// space-mix are m². Currency is never shown (this is a space report, not a
// costing).

import { Editor } from '../wasm/ds_core'
import type { DocState, DocZone, ZoneType } from '../types/doc'
import type { Metrics, ZoneStat } from '../types/metrics'
import { distToPoly } from '../editor/paint'
import { pointInZoneShape } from '../util/zoneGeom'
import { PAGE_W, PAGE_H, ContentOp, PdfPage, PdfJpeg, Rgb, buildMultiPagePdfBytes, textWidth, pdfSafeText } from './pdfDoc'
import { renderPrintCanvas, canvasToJpeg, PRINT_ZONE_FILL } from './printPlan'
import { Page, MARGIN, RES, ACCENT, hex2rgb, pageHeader, logoJpeg } from './sheet'
import { triggerDownload } from './png'
import { ACCENT_AMBER } from '../editor/planStyle'
import { SF_PER_M2 } from '../util/units'

// ---------------------------------------------------------------------------
// Report model (pure, testable)
// ---------------------------------------------------------------------------

export interface ReportMeta {
  client?: string
  project: string
  style?: string
  address?: string
  floor?: string
  /** Client logo as a data: URL (any raster the browser can decode). */
  logo?: string
}

export interface AlternativeInput {
  name: string
  snapshot: string
}

/** Zone-area shares for the summary's space-mix bar, m². */
export interface SpaceMix {
  work: number
  sharedSpace: number
  amenities: number
  shared: number
}

/** Every KPI for one alternative, computed from its snapshot's state(). */
export interface AltKpis {
  name: string
  designId: string
  usfSf: number
  niaM2: number
  geaM2: number
  seats: number
  workstations: number
  openSpaceSeats: number
  meetingSeats: number
  offices: number
  confRooms: number
  densitySqf: number
  densityM2: number
  daylightPct: number
  privacyPct: number
  efficiencyPct: number
  spaceMix: SpaceMix
  /** Distinct zone types present, in fixed legend order. */
  zoneTypes: ZoneType[]
  hasWalls: boolean
  /** Retained so the render layer can draw the plan without re-cloning. */
  snapshot: string
}

export interface ReportModel {
  meta: ReportMeta
  alternatives: AltKpis[]
}

/** Daylit = a workstation within this distance of the exterior (facade). */
const DAYLIGHT_RADIUS_M = 5

// Zones that DON'T count as enclosed rooms for the privacy metric (open plan).
const OPEN_ZONE_TYPES: ReadonlySet<ZoneType> = new Set(['Circulation', 'Workspace'])

/** Fixed legend order (qbiq lists rooms first, circulation last). */
const LEGEND_ORDER: ZoneType[] = [
  'Workspace',
  'ClosedOffice',
  'Meeting',
  'Collaboration',
  'Amenity',
  'Core',
  'Circulation',
]

/** qbiq-aligned display name for each app ZoneType (used in the plan legend). */
const ZONE_LABEL: Record<ZoneType, string> = {
  Workspace: 'Open Space',
  ClosedOffice: 'Office',
  Meeting: 'Conf Room',
  Collaboration: 'Collaboration',
  Amenity: 'Amenities',
  Core: 'Core / IT',
  Circulation: 'Circulation',
}

/** Is point p inside this zone shape? Rings exclude the hole; polys ray-cast. */
const pointInZone = pointInZoneShape

/** Deterministic 6-digit "Design #" from the snapshot (stands in for qbiq's). */
function designId(snapshot: string): string {
  let h = 0
  for (let i = 0; i < snapshot.length; i++) h = (h * 31 + snapshot.charCodeAt(i)) >>> 0
  return String(100000 + (h % 900000))
}

/**
 * Compute all KPIs for one snapshot via a scratch-clone (the compare.ts /
 * engine.ts pattern): from_snapshot → read state/metrics/zone_stats/plate,
 * derive, free.
 *
 * KPI formulas (report-grade approximations — documented for the reader):
 *   USF          = net internal area × 10.7639 (m²→sf), kept in sf per qbiq.
 *   Workstations = Desk component count (Rust metrics.workstations).
 *   Meeting seats= Σ area-rule capacity() of Meeting + Collaboration zones.
 *   Seats        = Workstations + Meeting seats.
 *   Open Space   = Workstations NOT inside an enclosed room (open-plan desks).
 *   Offices      = count of ClosedOffice zones.
 *   Conf Rooms   = count of Meeting zones.
 *   Density      = USF / Seats (sqf/person) and NIA / Seats (m²/person).
 *   Daylight %   = % of workstations within 5 m of the floor-plate boundary
 *                  (facade). Needs a closed plate; 0 when the plate can't trace.
 *   Privacy %    = % of workstations whose center lies inside a non-open zone
 *                  (Meeting/Collaboration/ClosedOffice/Amenity/Core).
 *   Efficiency % = Rust metrics.efficiency_pct (programmed / NIA), else NIA/GEA.
 *   Space mix    = zone-area m² grouped Work(Workspace+ClosedOffice) /
 *                  Shared Space(Meeting+Collaboration) / Amenities / Shared
 *                  (Circulation+Core).
 */
function computeAltKpis(input: AlternativeInput): AltKpis {
  const ed = Editor.from_snapshot(input.snapshot)
  try {
    const st = ed.state() as DocState
    const m = ed.metrics() as Metrics
    const zs = (typeof (ed as unknown as { zone_stats?: () => unknown }).zone_stats === 'function'
      ? ((ed as unknown as { zone_stats: () => unknown }).zone_stats() as ZoneStat[])
      : []) ?? []
    const plate = (ed.plate() as [number, number][] | null | undefined) ?? null

    const niaM2 = m.net_internal_area ?? 0
    const geaM2 = m.gross_external_area ?? m.floor_area ?? 0
    const workstations = m.workstations ?? st.components.filter((c) => c.category === 'Desk').length

    const meetingSeats = zs
      .filter((z) => z.zone_type === 'Meeting' || z.zone_type === 'Collaboration')
      .reduce((s, z) => s + z.capacity, 0)
    const seats = workstations + meetingSeats
    const offices = zs.filter((z) => z.zone_type === 'ClosedOffice').length
    const confRooms = zs.filter((z) => z.zone_type === 'Meeting').length

    // Geometric daylight + privacy over Desk centers (robust to whether the
    // generator populated zone.component_ids).
    const enclosed = (st.zones ?? []).filter((z) => !OPEN_ZONE_TYPES.has(z.zone_type))
    let daylit = 0
    let enclosedDesks = 0
    const desks = st.components.filter((c) => c.category === 'Desk')
    for (const d of desks) {
      if (plate && plate.length >= 3 && distToPoly(plate, { x: d.x, y: d.y }) <= DAYLIGHT_RADIUS_M) {
        daylit++
      }
      if (enclosed.some((z) => pointInZone(z.shape, d.x, d.y))) enclosedDesks++
    }
    const daylightPct = desks.length > 0 ? (daylit / desks.length) * 100 : 0
    const privacyPct = desks.length > 0 ? (enclosedDesks / desks.length) * 100 : 0
    const openSpaceSeats = Math.max(0, workstations - enclosedDesks)

    const efficiencyPct =
      m.efficiency_pct ?? (geaM2 > 0 ? (niaM2 / geaM2) * 100 : 0)

    const usfSf = niaM2 * SF_PER_M2
    const densitySqf = seats > 0 ? usfSf / seats : 0
    const densityM2 = seats > 0 ? niaM2 / seats : 0

    const areaOf = (types: ZoneType[]) =>
      zs.filter((z) => types.includes(z.zone_type)).reduce((s, z) => s + z.area, 0)
    const spaceMix: SpaceMix = {
      work: areaOf(['Workspace', 'ClosedOffice']),
      sharedSpace: areaOf(['Meeting', 'Collaboration']),
      amenities: areaOf(['Amenity']),
      shared: areaOf(['Circulation', 'Core']),
    }

    const present = new Set((st.zones ?? []).map((z: DocZone) => z.zone_type))
    const zoneTypes = LEGEND_ORDER.filter((t) => present.has(t))

    return {
      name: input.name,
      designId: designId(input.snapshot),
      usfSf,
      niaM2,
      geaM2,
      seats,
      workstations,
      openSpaceSeats,
      meetingSeats,
      offices,
      confRooms,
      densitySqf,
      densityM2,
      daylightPct,
      privacyPct,
      efficiencyPct,
      spaceMix,
      zoneTypes,
      hasWalls: m.wall_count > 0,
      snapshot: input.snapshot,
    }
  } finally {
    ed.free()
  }
}

/** Pure: build the full report model (KPIs per alternative) from snapshots. */
export function buildReportModel(alternatives: AlternativeInput[], meta: ReportMeta): ReportModel {
  return { meta, alternatives: alternatives.map(computeAltKpis) }
}

/**
 * Category "winner" badges per alternative — the SAME superlatives the S7
 * generate gallery shows on each candidate card, computed from the shared
 * AltKpis so the picker and the report can never disagree. Returns, per
 * alternative index, the labels it wins; ties resolve to the first alternative.
 * Fewer than two alternatives win nothing (a lone option is not "best" at
 * anything).
 */
export function computeWinners(kpis: AltKpis[]): Record<number, string[]> {
  const out: Record<number, string[]> = {}
  if (kpis.length < 2) return out
  const add = (i: number, label: string) => (out[i] = [...(out[i] ?? []), label])
  /**
   * Index of the best alternative on `f`, or null when NOBODY is any good at
   * it — every alternative scores 0.
   *
   * "Best of nothing" is not a superlative. Reloading the Generate step used to
   * run the search on an empty plate and return three 0-workstation candidates;
   * a plain argmax dutifully crowned the first one **"Most seats · Best
   * daylight · Best density"**, three gold stars on a blank sheet. The bug that
   * produced the empty plate is fixed at its source, but the rule belongs here:
   * this function is shared by the gallery AND the branded report, so anything
   * that can hand it a degenerate field — a plate that fails to trace, a
   * program nothing fits, a path not yet written — inherits the honesty for
   * free instead of re-earning it.
   */
  const argmax = (f: (a: AltKpis) => number): number | null => {
    let bi = 0
    kpis.forEach((a, i) => {
      if (f(a) > f(kpis[bi])) bi = i
    })
    return f(kpis[bi]) > 0 ? bi : null
  }
  const award = (i: number | null, label: string) => {
    if (i !== null) add(i, label)
  }
  award(argmax((a) => a.seats), 'Most seats')
  award(argmax((a) => a.daylightPct), 'Best daylight')
  // Densest = most workstations per m² of net internal area.
  award(argmax((a) => (a.niaM2 > 0 ? a.workstations / a.niaM2 : 0)), 'Best density')
  return out
}

// ---------------------------------------------------------------------------
// Radar normalization (pure, testable)
// ---------------------------------------------------------------------------

/** The 8 comparison axes, in clockwise-from-top order (matches qbiq). */
export const RADAR_AXES = [
  'Efficiency',
  'Daylight',
  'Density',
  'Open Space',
  'Rooms',
  'Conferences',
  'Privacy',
  'Conference Seats',
] as const
export type RadarAxis = (typeof RADAR_AXES)[number]

function rawAxis(a: AltKpis, axis: RadarAxis): number {
  switch (axis) {
    case 'Efficiency':
      return a.efficiencyPct
    case 'Daylight':
      return a.daylightPct
    case 'Density':
      return a.densitySqf
    case 'Open Space':
      return a.openSpaceSeats
    case 'Rooms':
      return a.offices
    case 'Conferences':
      return a.confRooms
    case 'Privacy':
      return a.privacyPct
    case 'Conference Seats':
      return a.meetingSeats
  }
}

/**
 * Normalize each axis to [0,1] against the max across alternatives (best = 1),
 * so the radar is a relative comparison. Returns rows aligned to `alternatives`,
 * each an 8-value array in RADAR_AXES order.
 */
export function normalizeRadar(model: ReportModel): number[][] {
  const alts = model.alternatives
  const max = RADAR_AXES.map((axis) => Math.max(1e-9, ...alts.map((a) => rawAxis(a, axis))))
  return alts.map((a) => RADAR_AXES.map((axis, i) => Math.min(1, rawAxis(a, axis) / max[i])))
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** Per-alternative accent (radar polygon, table dot, space-mix, header). */
const ALT_COLORS = ['#7b74d4', ACCENT_AMBER, '#3f9c95', '#c4607a', '#5b8def']
const MUTED = 0.5

/** Render a plan raster for an alternative into a box of the given PT size. */
function planJpeg(
  st: DocState,
  wPt: number,
  hPt: number,
): { jpeg: PdfJpeg; metersPerPx: number } {
  const wPx = Math.round(wPt * RES)
  const hPx = Math.round(hPt * RES)
  const { canvas, metersPerPx } = renderPrintCanvas(st, wPx, hPx)
  return { jpeg: { bytes: canvasToJpeg(canvas), width: wPx, height: hPx }, metersPerPx }
}

function stateOf(snapshot: string): DocState {
  const ed = Editor.from_snapshot(snapshot)
  try {
    return ed.state() as DocState
  } finally {
    ed.free()
  }
}

const LETTERS = 'ABCDEFGH'
function altName(a: AltKpis, i: number): string {
  return a.name?.trim() ? a.name : `Alternative ${LETTERS[i] ?? i + 1}`
}
function projectTitle(meta: ReportMeta): string {
  return meta.style ? `${meta.project} | ${meta.style}` : meta.project
}

// ---------------------------------------------------------------------------
// Page 1 — cover
// ---------------------------------------------------------------------------

function coverPage(model: ReportModel, hero: PdfJpeg | null, logo: PdfJpeg | null): Page {
  const p = new Page()
  const { meta } = model
  const x = MARGIN + 20

  // Right ~48%: a framed hero panel. The first alternative's plan stands in for
  // the qbiq building photo (we have no building photo), inset and captioned so
  // it reads as a deliberate "indicative plan", not a full-bleed image.
  const heroX = PAGE_W * 0.52
  const inset = 30
  const bx = heroX
  const by = inset
  const bw = PAGE_W - heroX - inset
  const bh = PAGE_H - inset * 2
  p.box(bx, by, bw, bh, { fill: true, gray: 0.97 })
  if (hero) {
    const s = Math.min(bw / hero.width, bh / hero.height)
    const w = hero.width * s
    const h = hero.height * s
    p.image(hero, bx + (bw - w) / 2, by + (bh - h) / 2, w, h)
    p.text(bx + 14, by + bh - 14, 9, `${altName(model.alternatives[0], 0)} — indicative plan`, {
      gray: 0.5,
    })
  }
  p.box(bx, by, bw, bh, { fill: false, gray: 0.82, width: 1 })

  // Left column — the report preparer's small mark up top; client branding is
  // the focal point below it (qbiq-cover order: preparer · client logo ·
  // client · project · address · floor).
  p.text(x, MARGIN + 24, 15, 'dsource', { bold: true, rgb: ACCENT })
  p.text(x + textWidth('dsource', 15, true) + 10, MARGIN + 24, 9, 'SPACE PLANNING', { gray: 0.55 })

  // Client logo — hero of the cover. Scaled up to a generous box so it is the
  // first thing the reader sees; skipped cleanly when absent.
  let y = 210
  if (logo) {
    const maxW = 290
    const maxH = 130
    const s = Math.min(maxW / logo.width, maxH / logo.height)
    const w = logo.width * s
    const h = logo.height * s
    p.image(logo, x, y, w, h)
    y += h + 46
  } else {
    y += 24
  }

  if (meta.client) {
    p.text(x, y, 20, meta.client, { gray: 0.3 })
    y += 34
  }
  // Warm-amber brand tick above the project name (CLAUDE.md accent).
  p.box(x, y - 5, 44, 3, { fill: true, rgb: ACCENT })
  y += 30

  // Project name large — steps down to fit the left column if very long.
  const titleMaxW = heroX - x - 12
  let titleSize = 34
  while (titleSize > 18 && textWidth(pdfSafeText(projectTitle(meta)), titleSize, true) > titleMaxW) {
    titleSize -= 2
  }
  p.text(x, y, titleSize, projectTitle(meta), { bold: true, gray: 0.05 })
  y += titleSize + 12

  if (meta.address) {
    p.text(x, y, 14, meta.address, { gray: 0.4 })
    y += 38
  }
  if (meta.floor) {
    p.text(x, y, 15, meta.floor, { bold: true, gray: 0.15 })
  }

  p.text(x, PAGE_H - MARGIN, 9, 'SPACE PLANNING REPORT  ·  PREPARED BY DSOURCE EDITOR', {
    gray: 0.55,
  })
  return p
}

// ---------------------------------------------------------------------------
// Page 2 — 3D virtual tour (plan thumbnail + "open in 3D" note; no QR)
// ---------------------------------------------------------------------------

function tourPage(model: ReportModel): Page {
  const p = new Page()
  const first = model.alternatives[0]
  pageHeader(p, projectTitle(model.meta), model.meta.client)

  p.text(MARGIN, 130, 40, '3D virtual tour', { bold: true, gray: 0.08 })
  p.text(MARGIN, 175, 15, altName(first, 0), { gray: 0.4 })

  // Plan thumbnail (left half).
  const boxW = PAGE_W * 0.42
  const boxH = 380
  const { jpeg } = planJpeg(stateOf(first.snapshot), boxW, boxH)
  const s = Math.min(boxW / jpeg.width, boxH / jpeg.height)
  const w = jpeg.width * s
  const h = jpeg.height * s
  p.image(jpeg, MARGIN + (boxW - w) / 2, 210, w, h)

  p.text(MARGIN, 660, 16, 'Open in 3D', { bold: true, gray: 0.1 })
  p.text(MARGIN, 685, 11, 'Interactive walkthrough available in the DSource Editor 3D viewer.', { gray: MUTED })
  p.text(MARGIN, 703, 11, 'No hosted walkthrough link in this export.', { gray: MUTED })

  p.text(MARGIN, PAGE_H - MARGIN, 8, 'FOR EVALUATION PURPOSES ONLY', { gray: 0.55 })
  return p
}

// ---------------------------------------------------------------------------
// Per-alternative page — KPI rail + colored plan + legend + scale bar
// ---------------------------------------------------------------------------

const WHITE: Rgb = [1, 1, 1]

function altPage(a: AltKpis, i: number, meta: ReportMeta, wins: string[]): Page {
  const p = new Page()
  const accent = hex2rgb(ALT_COLORS[i % ALT_COLORS.length])
  pageHeader(p, `${altName(a, i)}: ${projectTitle(meta)}`, meta.client)

  // --- left KPI rail ------------------------------------------------------
  const railX = MARGIN
  const railW = 240
  const railTop = 86
  p.box(railX, railTop + 28, railW, PAGE_H - (railTop + 28) - MARGIN, { fill: true, gray: 0.975, width: 0.8 })
  p.box(railX, railTop + 28, railW, PAGE_H - (railTop + 28) - MARGIN, { fill: false, gray: 0.85, width: 1 })

  const cx = railX + railW / 2
  // Per-alternative identity chip: the alt's accent color makes A/B/C instantly
  // distinguishable page-to-page (same colors as the summary radar + table).
  p.box(railX, railTop, railW, 28, { fill: true, rgb: accent })
  p.text(cx, railTop + 19, 13, altName(a, i).toUpperCase(), { align: 'center', bold: true, rgb: WHITE })

  // "At a glance" ribbon: the category-winner pills (same superlatives as the
  // S7 gallery), each in the alt's accent, above the plan.
  let rx = railX + railW + 24
  const ribbonY = railTop + 4
  for (const label of wins) {
    const pw = textWidth(label, 10, true) + 22
    p.box(rx, ribbonY, pw, 20, { fill: true, rgb: accent })
    p.text(rx + 11, ribbonY + 14, 10, label, { bold: true, rgb: WHITE })
    rx += pw + 8
  }

  const int = (n: number) => Math.round(n).toLocaleString('en-US')
  let ky = 126
  const kpi = (big: string, label: string) => {
    p.text(cx, ky, 26, big, { align: 'center', bold: true, gray: 0.08 })
    p.text(cx, ky + 20, 10, label, { align: 'center', gray: MUTED })
    ky += 62
  }
  kpi(int(a.usfSf), 'USF (sf)')
  kpi(int(a.seats), 'Seats')
  kpi(int(a.openSpaceSeats), 'Open Space')
  kpi(int(a.offices), 'Offices')
  kpi(int(a.confRooms), 'Conf Room')
  // Density carries both units (India-first note).
  p.text(cx, ky, 22, a.densitySqf.toFixed(2), { align: 'center', bold: true, gray: 0.08 })
  p.text(cx, ky + 18, 10, 'Density sqf/person', { align: 'center', gray: MUTED })
  p.text(cx, ky + 32, 9, `${a.densityM2.toFixed(2)} m²/person`, { align: 'center', gray: 0.62 })
  ky += 62

  // Daylight / Privacy / Efficiency bars.
  const barX = railX + 18
  const barW = railW - 90
  const bar = (label: string, pct: number) => {
    p.text(barX, ky + 3, 10, label, { gray: 0.35 })
    p.box(barX, ky + 8, barW, 6, { fill: true, gray: 0.88 })
    p.box(barX, ky + 8, (barW * Math.max(0, Math.min(100, pct))) / 100, 6, { fill: true, rgb: ACCENT })
    p.text(railX + railW - 16, ky + 3, 10, `${Math.round(pct)}%`, { align: 'right', bold: true, gray: 0.15 })
    ky += 30
  }
  ky += 6
  bar('Daylight', a.daylightPct)
  bar('Privacy', a.privacyPct)
  bar('Efficiency', a.efficiencyPct)

  // --- plan drawing (below the superlative ribbon) ------------------------
  const planX = railX + railW + 24
  const planY = 120
  const planW = PAGE_W - planX - MARGIN
  const planH = 540
  const { jpeg, metersPerPx } = planJpeg(stateOf(a.snapshot), planW, planH)
  p.image(jpeg, planX, planY, planW, planH)

  // --- scale bar (0/10/20/30 m) — a short bar at the left, so it never runs
  //     under the legend. Segments cap at whatever fits ~180 pt of paper. -----
  const sbY = planY + planH + 24
  if (metersPerPx > 0) {
    // points per meter on paper = (boxW pt / wPx) / metersPerPx.
    const ptPerM = planW / jpeg.width / metersPerPx
    const seg = 10 * ptPerM
    const nSeg = Math.max(1, Math.min(3, Math.floor(180 / seg)))
    const sx = planX
    for (let k = 0; k < nSeg; k++) {
      p.box(sx + k * seg, sbY, seg, 5, { fill: k % 2 === 0, gray: 0.1 })
      p.box(sx + k * seg, sbY, seg, 5, { fill: false, gray: 0.1, width: 0.6 })
    }
    for (let k = 0; k <= nSeg; k++) p.text(sx + k * seg, sbY + 15, 8, `${k * 10}`, { align: 'center', gray: 0.4 })
    p.text(sx + nSeg * seg + 8, sbY + 5, 8, 'm', { gray: 0.4 })
  } else {
    p.text(planX, sbY + 5, 8, 'N.T.S.', { gray: 0.4 })
  }

  // --- room-type legend — its own row below the scale bar (single wrapping
  //     line), so swatches never collide with the scale. -----------------------
  let lx = planX
  let ly = sbY + 34
  for (const zt of a.zoneTypes) {
    const label = ZONE_LABEL[zt]
    const itemW = 16 + textWidth(label, 9) + 22
    if (lx + itemW > PAGE_W - MARGIN - 90) {
      lx = planX
      ly += 18
    }
    const rgb = hex2rgb(PRINT_ZONE_FILL[zt] ?? PRINT_ZONE_FILL.Core)
    p.box(lx, ly - 8, 10, 10, { fill: true, rgb })
    p.box(lx, ly - 8, 10, 10, { fill: false, gray: 0.6, width: 0.5 })
    p.text(lx + 16, ly, 9, label, { gray: 0.35 })
    lx += itemW
  }

  p.text(PAGE_W - MARGIN, PAGE_H - MARGIN, 9, `Design #${a.designId}`, { align: 'right', gray: 0.45 })
  return p
}

// ---------------------------------------------------------------------------
// Summary page — comparison table + radar + space-mix bars
// ---------------------------------------------------------------------------

/** Hand-drawn 8-axis radar on a canvas → JPEG (curves are easier raster-side). */
function radarJpeg(model: ReportModel, wPt: number, hPt: number): PdfJpeg {
  const wPx = Math.round(wPt * RES)
  const hPx = Math.round(hPt * RES)
  const cv = document.createElement('canvas')
  cv.width = wPx
  cv.height = hPx
  const ctx = cv.getContext('2d')
  if (!ctx) return { bytes: canvasToJpeg(cv), width: wPx, height: hPx }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, wPx, hPx)

  const cx = wPx / 2
  const cy = hPx / 2 + 8 * RES
  const R = Math.min(wPx, hPx) * 0.34
  const n = RADAR_AXES.length
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2

  // Grid rings + spokes.
  ctx.strokeStyle = '#d7dbe0'
  ctx.lineWidth = 1 * RES
  for (let r = 1; r <= 5; r++) {
    ctx.beginPath()
    for (let i = 0; i <= n; i++) {
      const a = ang(i % n)
      const rr = (R * r) / 5
      const x = cx + rr * Math.cos(a)
      const y = cy + rr * Math.sin(a)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  for (let i = 0; i < n; i++) {
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + R * Math.cos(ang(i)), cy + R * Math.sin(ang(i)))
    ctx.stroke()
  }

  // Axis labels.
  ctx.fillStyle = '#5a626b'
  ctx.font = `${11 * RES}px Helvetica, Arial, sans-serif`
  for (let i = 0; i < n; i++) {
    const a = ang(i)
    const x = cx + (R + 14 * RES) * Math.cos(a)
    const y = cy + (R + 14 * RES) * Math.sin(a)
    ctx.textAlign = Math.abs(Math.cos(a)) < 0.3 ? 'center' : Math.cos(a) > 0 ? 'left' : 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(RADAR_AXES[i], x, y)
  }

  // One polygon per alternative.
  const rows = normalizeRadar(model)
  rows.forEach((row, ai) => {
    const [r, g, b] = hex2rgb(ALT_COLORS[ai % ALT_COLORS.length]).map((v) => Math.round(v * 255))
    ctx.beginPath()
    row.forEach((v, i) => {
      const a = ang(i)
      const x = cx + R * v * Math.cos(a)
      const y = cy + R * v * Math.sin(a)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = `rgba(${r},${g},${b},0.18)`
    ctx.strokeStyle = `rgb(${r},${g},${b})`
    ctx.lineWidth = 2 * RES
    ctx.fill()
    ctx.stroke()
  })

  return { bytes: canvasToJpeg(cv), width: wPx, height: hPx }
}

function summaryPage(model: ReportModel): Page {
  const p = new Page()
  const alts = model.alternatives
  pageHeader(p, `Summary: ${projectTitle(model.meta)}`, model.meta.client)

  // --- comparison table ---------------------------------------------------
  const tx = MARGIN
  const tw = PAGE_W - MARGIN * 2
  const labelW = 220
  const colW = (tw - labelW) / alts.length
  let ty = 120
  p.box(tx, ty - 18, tw, 26 + 8 * 26, { fill: false, gray: 0.85, width: 1 })

  // Header row: an accent-colored chip per column (same colors as the alt-page
  // identity chips + radar), so the three options separate at a glance.
  alts.forEach((a, i) => {
    const cxp = tx + labelW + colW * i + colW / 2
    const rgb = hex2rgb(ALT_COLORS[i % ALT_COLORS.length])
    const name = altName(a, i)
    const chW = textWidth(name, 10, true) + 20
    p.box(cxp - chW / 2, ty - 11, chW, 17, { fill: true, rgb })
    p.text(cxp, ty + 1, 10, name, { align: 'center', bold: true, rgb: WHITE })
  })
  ty += 22
  p.line(tx, ty - 8, tx + tw, ty - 8, { gray: 0.8, width: 0.8 })

  // Each metric row highlights its leading alternative (in that alt's accent),
  // when there is a spread — so the comparison reads without hunting. Density
  // is left neutral (lower vs. higher is program-dependent, not "better").
  const row = (label: string, get: (a: AltKpis) => number, fmt: (n: number) => string, highlight = true) => {
    const nums = alts.map(get)
    const best = Math.max(...nums)
    const spread = best - Math.min(...nums)
    p.text(tx + 6, ty + 4, 10, label, { bold: true, gray: 0.25 })
    alts.forEach((_, i) => {
      const win = highlight && spread > 1e-9 && nums[i] === best
      p.text(tx + labelW + colW * i + colW / 2, ty + 4, 10, fmt(nums[i]), {
        align: 'center',
        bold: win,
        rgb: win ? hex2rgb(ALT_COLORS[i % ALT_COLORS.length]) : undefined,
        gray: win ? undefined : 0.15,
      })
    })
    ty += 26
    p.line(tx, ty - 8, tx + tw, ty - 8, { gray: 0.9, width: 0.6 })
  }
  const intFmt = (n: number) => `${Math.round(n)}`
  const pctFmt = (n: number) => `${Math.round(n)}%`
  row('Seats', (a) => a.seats, intFmt)
  row('Open Space', (a) => a.openSpaceSeats, intFmt)
  row('Offices', (a) => a.offices, intFmt)
  row('Conf Room', (a) => a.confRooms, intFmt)
  row('Density sqf/person', (a) => a.densitySqf, (n) => n.toFixed(2), false)
  row('Daylight', (a) => a.daylightPct, pctFmt)
  row('Privacy', (a) => a.privacyPct, pctFmt)
  row('Efficiency', (a) => a.efficiencyPct, pctFmt)

  // --- lower panels: radar (left) + space-mix (right) ---------------------
  const panelY = ty + 24
  const panelH = PAGE_H - panelY - MARGIN - 24
  const gap = 24
  const panelW = (tw - gap) / 2

  // Radar panel.
  p.box(tx, panelY, panelW, panelH, { fill: false, gray: 0.85, width: 1 })
  p.text(tx + 14, panelY + 22, 11, 'Compare', { gray: 0.35 })
  const radar = radarJpeg(model, panelW - 28, panelH - 40)
  p.image(radar, tx + 14, panelY + 30, panelW - 28, panelH - 40)

  // Space-mix panel — stacked horizontal bars per alternative (vector rgb).
  const sx = tx + panelW + gap
  p.box(sx, panelY, panelW, panelH, { fill: false, gray: 0.85, width: 1 })
  p.text(sx + 14, panelY + 22, 11, 'Space mix', { gray: 0.35 })
  const mixKeys: { key: keyof SpaceMix; label: string; rgb: Rgb }[] = [
    { key: 'work', label: 'Work', rgb: hex2rgb('#dcebfb') },
    { key: 'sharedSpace', label: 'Shared Space', rgb: hex2rgb('#def1e2') },
    { key: 'amenities', label: 'Amenities', rgb: hex2rgb('#fbf3d6') },
    { key: 'shared', label: 'Shared', rgb: hex2rgb('#eceef1') },
  ]
  // Legend swatches.
  let lgx = sx + 90
  mixKeys.forEach((m) => {
    p.box(lgx, panelY + 15, 9, 9, { fill: true, rgb: m.rgb })
    p.box(lgx, panelY + 15, 9, 9, { fill: false, gray: 0.6, width: 0.5 })
    p.text(lgx + 13, panelY + 23, 8.5, m.label, { gray: 0.4 })
    lgx += textWidth(m.label, 8.5) + 34
  })
  const barX = sx + 20
  const barW = panelW - 40
  let by = panelY + 52
  alts.forEach((a, i) => {
    const rgb = hex2rgb(ALT_COLORS[i % ALT_COLORS.length])
    p.box(barX, by, 9, 9, { fill: true, rgb })
    p.text(barX + 14, by + 8, 10, altName(a, i), { gray: 0.3 })
    by += 18
    const total = Math.max(1e-9, a.spaceMix.work + a.spaceMix.sharedSpace + a.spaceMix.amenities + a.spaceMix.shared)
    let seg = barX
    mixKeys.forEach((m) => {
      const w = (barW * a.spaceMix[m.key]) / total
      p.box(seg, by, w, 16, { fill: true, rgb: m.rgb })
      seg += w
    })
    p.box(barX, by, barW, 16, { fill: false, gray: 0.75, width: 0.6 })
    by += 46
  })

  p.text(MARGIN, PAGE_H - MARGIN + 6, 7.5, 'For evaluation purposes only. Metrics are report-grade approximations generated by DSource Editor.', {
    gray: 0.5,
  })
  return p
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the full report PDF bytes (async: rasterizes plans/radar/logo). Split
 * from the download so it is drivable from a headless browser test.
 */
export async function buildReportPdfBytes(
  alternatives: AlternativeInput[],
  meta: ReportMeta,
): Promise<Uint8Array<ArrayBuffer>> {
  const model = buildReportModel(alternatives, meta)
  if (model.alternatives.length === 0) throw new Error('report needs at least one alternative')

  const hero = planJpeg(stateOf(model.alternatives[0].snapshot), PAGE_W * 0.5, PAGE_H).jpeg
  const logo = await logoJpeg(meta.logo, 400)

  const winners = computeWinners(model.alternatives)
  const pages: PdfPage[] = []
  const push = (pg: Page) => pages.push({ ops: pg.ops, images: pg.images })
  push(coverPage(model, hero, logo))
  push(tourPage(model))
  model.alternatives.forEach((a, i) => push(altPage(a, i, meta, winners[i] ?? [])))
  push(summaryPage(model))

  return buildMultiPagePdfBytes(pages)
}

/**
 * Build the multi-page space-planning report and download it. `alternatives`
 * are the (1–3) test-fit options to compare — sourced by the caller from the
 * best autonomous-search candidates (or the live plan). Missing logo/style/
 * address degrade gracefully; a single alternative still produces cover + tour
 * + one plan page + a (trivial) summary.
 */
export async function exportSpacePlanningReport(
  alternatives: AlternativeInput[],
  meta: ReportMeta,
  filename = 'dsource-space-planning-report.pdf',
): Promise<void> {
  const bytes = await buildReportPdfBytes(alternatives, meta)
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename)
}
