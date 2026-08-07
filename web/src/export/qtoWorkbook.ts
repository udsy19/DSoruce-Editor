// The qbiq-parity Quantity Takeoff workbook — 12 sheets, formula-wired.
//
//   Plan · Furniture Inventory · Furniture Inventory Summary · Inventory ·
//   General · Main Summary · BOM - Floors · BOM - Ceilings ·
//   BOM - Glass Partitions · BOM - Doors · BOM - Walls · dropdowns
//
// The point of this deliverable is that it RECALCULATES. `General` is the single
// catalog: every BOM sheet and the Main Summary reach it by reference/VLOOKUP,
// so editing one unit price there reprices the whole book with no code involved
// (gate G2 proves this through a headless LibreOffice recalc).
//
// Where every number comes from — nothing is re-derived here:
//   * wall runs / door counts / room areas  → `Editor.quantities()` (Rust core,
//     crates/ds-core/src/quantity.rs). The TS side never classifies a wall.
//   * the room set (Inventory rows == plan labels) → `planRoomList` (planGraphic)
//   * floor/ceiling materials → `FINISH_SPEC` / `finishTypeFor` (finishSchedule)
//   * room TYPE, on every sheet that names one → `roomTypeLabel` (finishSchedule).
//     `Inventory!Subcategory` and `Furniture Inventory!Room Type` are the same
//     call on the same zone, so the workbook cannot contradict itself.
//   * furniture rows → `buildTakeoffModel` (takeoff.ts)
//   * legend chip hexes → `PLAN_LEGEND_CHIPS` (qbiqPalette → palette.json)
//   * the OOXML byte stream → `buildXlsx` (workbook.ts)
//
// Layout mirrors `docs/reference/qbiq/spec/workbook-spec.json`. Deviations from
// the reference are marked `DEVIATION:` and explained where they occur.

import type { DocState, DocZone } from '../types/doc'
import { isGroundZone } from '../types/doc'
import { zoneArea } from '../util/zoneGeom'
import { FINISH_SPEC, finishTypeFor, roomTypeLabel } from './finishSchedule'
import { CIRCULATION_ROOM_ID, planRoomList, type PlanRoom } from './planGraphic'
import { PLAN_LEGEND_CHIPS, WORKBOOK_CHROME } from './qbiqPalette'
import { buildTakeoffModel, type TakeoffFurnitureRow, type TakeoffOptions } from './takeoff'
import { constructionRate, PRICE_BASIS_LABEL, type RateCategory } from './rateCard'
import { buildXlsx, colName, pxToEmu, type Cell, type SheetSpec, type StyleSpec } from './workbook'
import { triggerDownload } from './png'
import { ACCENT_AMBER } from '../editor/planStyle'

// ---------------------------------------------------------------------------
// The core quantity surface — the shape `Editor.quantities()` returns.
// ---------------------------------------------------------------------------

/** One wall-type row from the core. `label` is the exact `General!J*` name. */
export interface QtyWall {
  wallType: string
  label: string
  lengthM: number
  heightM: number
  areaM2: number
  segments: number
}

/** One door-type row from the core (`Glass` / `Solid`, both always present). */
export interface QtyDoor {
  doorType: string
  label: string
  count: number
  totalWidthM: number
}

/** One zone's measured quantities. `roomId` is the zone id. */
export interface QtyRoom {
  roomId: number
  name: string
  zoneType: string
  spaceType: string
  areaM2: number
  areaSqf: number
  headcount: number
  capacity: number
}

/** `Editor.quantities()`. The single source of geometric truth for this file. */
export interface Quantities {
  sqfPerM2: number
  wallHeightM: number
  floorAreaM2: number
  walls: QtyWall[]
  doors: QtyDoor[]
  doorCount: number
  doorTotalWidthM: number
  rooms: QtyRoom[]
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface QtoOptions extends TakeoffOptions {
  /** Master plan PNG (`renderHighlightedPlan`), embedded on the `Plan` sheet. */
  planPng?: Uint8Array | null
  /** One 240×180 thumbnail per Inventory row, keyed by Room ID
   *  (`renderAllRoomThumbnails`). Anchored in column B of that room's row. */
  thumbs?: { id: string; png: Uint8Array }[]
  /** Brand mark embedded on all 11 data sheets (`renderBrandMarkPng`). */
  logoPng?: Uint8Array | null
  /**
   * Per-project unit-price override, keyed by the `General` Material/Type Name.
   * Wins over the rate card for the names it mentions; names it omits fall back
   * to `rateCard.ts`.
   *
   * This used to be the ONLY price source, and absent it every unit price and
   * every total in the book shipped as `0` — the entire commercial half of a
   * costed document, empty. A takeoff prices measured quantities from a
   * published rate schedule; that schedule is now the default, is visible on
   * `General` with its basis, and is editable in place.
   */
  unitPrices?: Record<string, number>
}

/** One `Inventory` body row === one plan label === one `ground-truth.rooms[]`. */
export interface QtoRoomRow {
  id: string
  zoneId: number | null
  department: string
  spaceType: string
  subcategory: string
  name: string
  headcount: number
  areaM2: number
  areaSqf: number
  floorMaterial: string
  ceilingMaterial: string
  furnitureElements: string
}

/** The resolved workbook content, before it becomes OOXML. Pure + testable. */
export interface QtoModel {
  quantities: Quantities
  rooms: QtoRoomRow[]
  furniture: ReturnType<typeof buildTakeoffModel>['furniture']
  summary: ReturnType<typeof buildTakeoffModel>['summary']
  floors: CatalogRow[]
  ceilings: CatalogRow[]
  walls: CatalogRow[]
  glass: CatalogRow[]
  doors: CatalogRow[]
  /** Rate-card prices for the furniture the plan places, one row per distinct
   *  Item Description. Empty when every furniture line carries a bound price. */
  furnitureRates: FurnitureRateRow[]
  floor: string | number
  project: string
}

/** One row of a `General` catalog block. */
export interface CatalogRow {
  name: string
  id: number
  unit: string
  price: number
  /** Why `price` is that number — printed in the `General` rate-basis table so
   *  a reader never has to take a ₹ figure on trust. Empty when the price came
   *  from a caller-supplied `unitPrices` override. */
  basis: string
  /** Linear categories (walls, glass partitions) carry their measured run. */
  lengthM?: number
  /** Counted categories (doors) carry their amount. */
  count?: number
}

/** One row of the `General` furniture rate block — a rate-card price for an
 *  item description, which the Furniture Inventory looks up. */
export interface FurnitureRateRow {
  /** The Item Description, verbatim: `'Table W190 X L290'`. */
  name: string
  id: number
  price: number
  basis: string
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const C = WORKBOOK_CHROME

const HDR: StyleSpec = {
  font: { size: 10, bold: true, color: C.headerBandFontColor },
  fill: C.headerBandFill,
  align: { h: 'center', v: 'center', wrap: true },
  border: { all: 'thin' },
  numFmt: '@',
}
const BAND: StyleSpec = {
  font: { size: 11, bold: true, color: C.headerBandFontColor },
  fill: C.subHeaderFill,
  align: { h: 'center', v: 'center' },
  border: { all: 'thin' },
  numFmt: '@',
}
const BODY: StyleSpec = { fill: C.bodyFill, align: { wrap: true, v: 'top' }, border: { all: 'thin' } }
const BODY_TEXT: StyleSpec = { ...BODY, numFmt: '@' }
const BODY_NUM: StyleSpec = { ...BODY, numFmt: '#,##0.00' }
const BODY_INT: StyleSpec = { ...BODY, numFmt: '0' }
// Money renders at 0 dp: a fit-out takeoff is quoted to the rupee, and `₹0.00`
// columns are what made the book look unfinished. The stored value is still
// settled to the paisa by ROUND(...,2) inside each formula.
const BODY_MONEY: StyleSpec = { ...BODY, numFmt: '"₹"#,##0' }
const SCALAR: StyleSpec = { ...BODY, numFmt: '0.00', font: { bold: true } }
/** Long prose — a rate's basis, the scope note. Wrapped, top-aligned, 9 pt. */
const BODY_WRAP: StyleSpec = { ...BODY, numFmt: '@', font: { size: 9 }, align: { wrap: true, v: 'top' } }
const LEGEND_LABEL: StyleSpec = {
  fill: '#FCF5F2',
  border: { all: 'thin' },
  align: { v: 'center' },
  numFmt: '@',
}
const CHIP = (hex: string): StyleSpec => ({ fill: hex, border: { all: 'thin' } })

const LOGO_W = 181
const LOGO_H = 83
const THUMB_W = 240
const THUMB_H = 180
/** The master plan's native size (`renderHighlightedPlan` defaults, and the
 *  reference's own `xl/media/image1.png`). */
const PLAN_PX_W = 1040
const PLAN_PX_H = 780
/** Inventory body row height (pt). The 180 px thumbnail needs 135 pt; G5 floors
 *  it at 120. The reference uses 180 pt. */
const INVENTORY_ROW_PT = 140

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Unit → how many of it make one BASE unit (m for a length, m² for an area, 1
 * for a count). Written onto the `dropdowns` sheet and read by column G of
 * every BOM sheet, so the conversion is auditable in the file rather than
 * compiled into a formula nobody can check.
 */
const UNIT_FACTORS: [string, number][] = [
  ['m', 1],
  ['cm', 100],
  ['f', 3.280839895],
  ['inch', 39.37007874],
  ['m^2', 1],
  ['cm^2', 10_000],
  ['f^2', 10.763910417],
  ['inch^2', 1550.0031],
  ['Number', 1],
]

/**
 * What this takeoff bills, and — just as importantly — what it does not.
 *
 * Without this the book invites a false comparison: the app's own headline
 * indicative cost is an ALL-IN element model (it folds lighting, small power,
 * data, HVAC distribution, fire and BMS into a single ₹/m² base-shell rate),
 * while this workbook can only bill materials it has a measured quantity for.
 * A reader who sees the two side by side and is not told why they differ will
 * assume one of them is wrong.
 */
const SCOPE_NOTE =
  'This takeoff bills the five measured material categories above (floor finishes, ceiling ' +
  'finishes, partitions, glazed fronts, doors) plus loose furniture — i.e. the scope the plan ' +
  'geometry can measure. It EXCLUDES: lighting, small power and containment, structured data, ' +
  'HVAC distribution, fire detection and suppression, BMS, sanitaryware, signage, main-contractor ' +
  'preliminaries, professional fees, GST and contingency. Those are the difference between this ' +
  'figure and an all-in delivery cost, and on an Indian metro CAT-B floor they are typically ' +
  'larger than the scope billed here. Rates are indicative market rates for the Indian metro ' +
  '(Bengaluru / Hyderabad) commercial CAT-B fit-out market, ₹ 2024–25, supply and install — ' +
  'planning figures, not quotations. Every Unit Price cell above is editable and the whole book ' +
  'reprices itself.'

/** Deterministic 4-digit Material ID from a name — stable across exports. */
function materialId(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 1000 + (Math.abs(h) % 9000)
}

const q = (sheet: string) => `'${sheet}'`

/**
 * PRESENTATION ROUNDING — 2 dp, applied where a measured number is written into
 * the model that becomes cells and ground truth.
 *
 * `26.5500000000001 m²`, `4.31999999999999 m²` and `285.784200000001 sqft` are
 * the same quantities as their 2 dp forms and they read as a broken instrument
 * on a costed document. 2 dp is 1 cm² on an area and 1 cm on a run — finer than
 * anything the geometry resolves — so nothing measurable is lost, and the number
 * a data consumer reads finally matches the number the cell displays.
 *
 * Money is NOT rounded here: it is a product of a live formula, displayed at 0 dp
 * by its number format and settled to the paisa by `ROUND(...,2)` inside the
 * formula, so editing a unit price still reprices exactly.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** A `General` block's absolute VLOOKUP table range, e.g. `'General'!$B$9:$E$10`. */
function tableRef(c0: string, c1: string, r0: number, r1: number): string {
  return `${q('General')}!$${c0}$${r0}:$${c1}$${r1}`
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The largest `Circulation` zone — the aggregated `Room ID "0"` row's anchor.
 *  Same rule `planRoomList` uses to place that label, so the row the Inventory
 *  describes and the label the plan draws are the same piece of floor. */
function largestCirculationZone(state: DocState): DocZone | null {
  let best: DocZone | null = null
  for (const z of state.zones ?? []) {
    if (!isGroundZone(z.zone_type)) continue
    if (!best || zoneArea(z.shape) > zoneArea(best.shape)) best = z
  }
  return best
}

/**
 * Resolve the workbook content from a document + the core's quantity surface.
 *
 * The room set is `planRoomList` — the SAME list the plan renderer labels and
 * the thumbnail renderer crops. G3 asserts a 1:1 correspondence between the
 * Inventory rows, the ground-truth rooms and the plan labels; deriving all
 * three from this one call is what makes that unfailable.
 */
export function buildQtoModel(
  state: DocState,
  quantities: Quantities,
  opts: QtoOptions = {},
): QtoModel {
  const zones = state.zones ?? []
  const zoneById = new Map<number, DocZone>(zones.map((z) => [z.id, z]))
  const qtyById = new Map<number, QtyRoom>(quantities.rooms.map((r) => [r.roomId, r]))
  const planRooms: PlanRoom[] = planRoomList(state, opts.roomRefs)

  // Room IDs used by the Furniture Inventory must be the Inventory's own ids,
  // so a designer can read across the two sheets. Circulation zones collapse to
  // the aggregated "0" row exactly as `planRoomList` does.
  const furnitureRefs = new Map<number, string>(opts.roomRefs ?? [])
  for (const z of zones) {
    if (isGroundZone(z.zone_type)) furnitureRefs.set(z.id, CIRCULATION_ROOM_ID)
  }
  // `rateCard: true`: this is a TAKEOFF, so an unbound component is priced from
  // the published rate schedule and the line says so. A bound product's real
  // `price_inr` still wins (ADR 0004) — see `takeoff.ts` `priceOf`.
  const takeoff = buildTakeoffModel(state, { ...opts, roomRefs: furnitureRefs, rateCard: true })

  const byRoom = new Map<string, string[]>()
  for (const r of takeoff.furniture) {
    const key = String(r.roomId)
    const list = byRoom.get(key) ?? []
    list.push(`${r.itemDescription}: ${r.quantity}`)
    byRoom.set(key, list)
  }

  const circAnchor = largestCirculationZone(state)
  const rooms: QtoRoomRow[] = planRooms.map((pr) => {
    // The aggregated circulation row bills EVERY circulation zone's area; every
    // other row is its own zone's plate-clipped, de-overlapped area.
    const zone = pr.zoneId != null ? zoneById.get(pr.zoneId) ?? null : circAnchor
    const qr = pr.zoneId != null ? qtyById.get(pr.zoneId) : undefined
    let areaM2 = qr?.areaM2 ?? 0
    if (pr.zoneId == null) {
      areaM2 = 0
      for (const z of zones) {
        if (isGroundZone(z.zone_type)) areaM2 += qtyById.get(z.id)?.areaM2 ?? 0
      }
    }
    const key = zone ? finishTypeFor(zone) : 'other'
    const spec = FINISH_SPEC[key]
    // sqf is derived from the ROUNDED m², not from the raw one, so the two cells
    // satisfy `sqf == m2 × factor` exactly rather than to within a rounding
    // residue — G3 checks that relation and it should hold by construction.
    const m2 = round2(areaM2)
    return {
      id: pr.id,
      zoneId: pr.zoneId,
      department: 'GENERAL',
      spaceType: pr.zoneId == null ? 'Circulation' : qr?.spaceType ?? pr.label,
      // ONE room-type derivation for the whole workbook: this cell and the
      // `Furniture Inventory` Room Type cell for the same Room ID are the same
      // call on the same zone (`roomTypeLabel`), so they cannot disagree.
      // The aggregated circulation row anchors on a `Circulation` zone, which
      // `roomTypeLabel` labels 'Circulation' — no special case needed here.
      subcategory: roomTypeLabel(zone),
      name: pr.label,
      headcount: pr.zoneId == null ? 0 : qr?.headcount ?? 0,
      areaM2: m2,
      areaSqf: round2(m2 * quantities.sqfPerM2),
      floorMaterial: spec.floor,
      ceilingMaterial: spec.ceiling,
      furnitureElements: (byRoom.get(pr.id) ?? []).join(', '),
    }
  })

  // --- General catalog blocks ---------------------------------------------
  //
  // A caller-supplied `unitPrices` entry wins; otherwise the rate card supplies
  // the figure AND the one-line basis that justifies it. A name the card does
  // not know prices at 0 and says so, rather than silently inventing a rate.
  const priced = (name: string, category: RateCategory): { price: number; basis: string } => {
    const override = opts.unitPrices?.[name]
    if (override != null) return { price: override, basis: 'Project-specific rate supplied at export.' }
    const r = constructionRate(name, category)
    return r
      ? { price: r.inr, basis: r.basis }
      : { price: 0, basis: 'No published rate for this material — to be quoted.' }
  }
  const distinct = (vals: string[]) => [...new Set(vals)]

  const floors: CatalogRow[] = distinct(rooms.map((r) => r.floorMaterial)).map((name) => ({
    name,
    id: materialId(name),
    unit: 'm^2',
    ...priced(name, 'Floors'),
  }))
  const ceilings: CatalogRow[] = distinct(rooms.map((r) => r.ceilingMaterial)).map((name) => ({
    name,
    id: materialId(name),
    unit: 'm^2',
    ...priced(name, 'Ceilings'),
  }))

  // All six wall types, legend order, zero-length rows included — G3 checks the
  // General!J/L table against the ground truth in BOTH directions.
  //
  // DEVIATION: the unit reads `m^2`, not the reference's `m`. Every wall row's
  // Quantity is `ceiling height × run` — square metres of ELEVATION — so the
  // unit price beside it has to be ₹/m², and labelling that column `m` made the
  // three cells of one row (unit · quantity · unit price) describe two
  // different dimensions. The measured run itself is still in metres, in its
  // own `Length (m)` column, which is what G3 reads.
  const walls: CatalogRow[] = quantities.walls.map((w) => ({
    name: w.label,
    id: materialId(w.label),
    unit: 'm^2',
    ...priced(w.label, 'Walls'),
    lengthM: round2(w.lengthM),
  }))
  const glassRun = quantities.walls.find((w) => w.label === 'Glass')?.lengthM ?? 0
  const glass: CatalogRow[] = [
    {
      name: 'Glass Partition',
      id: materialId('Glass Partition'),
      unit: 'm^2',
      ...priced('Glass Partition', 'Glass Partitions'),
      lengthM: round2(glassRun),
    },
  ]
  const doors: CatalogRow[] = quantities.doors.map((d) => ({
    name: d.label,
    id: materialId(`Door ${d.label}`),
    unit: 'Number',
    ...priced(d.label, 'Doors'),
    count: d.count,
  }))

  // --- the furniture rate block -------------------------------------------
  // One row per distinct Item Description that got a rate-card price, so the
  // Furniture Inventory can VLOOKUP its unit price out of `General` and a
  // designer repricing chairs edits ONE cell. Bound products never appear here:
  // their price is the core's and is written as a literal on the line itself.
  const furnitureRateMap = new Map<string, FurnitureRateRow>()
  for (const r of [...takeoff.furniture, ...takeoff.openings]) {
    if (r.priceBasis !== 'rate-card' || furnitureRateMap.has(r.itemDescription)) continue
    furnitureRateMap.set(r.itemDescription, {
      name: r.itemDescription,
      id: materialId(r.itemDescription),
      price: r.unitPrice,
      basis: r.priceNote ?? '',
    })
  }
  const furnitureRates = [...furnitureRateMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  assertOneRoomType(rooms, takeoff.furniture)

  return {
    quantities,
    rooms,
    furniture: takeoff.furniture,
    summary: takeoff.summary,
    floors,
    ceilings,
    walls,
    glass,
    doors,
    furnitureRates,
    floor: opts.floor ?? 1,
    project: opts.project ?? 'DSource Test-Fit',
  }
}

/**
 * The workbook must never tell two stories about one Room ID: the
 * `Furniture Inventory` *Room Type* and the `Inventory` *Subcategory* for the
 * same room have to be the same string. Both sides call `roomTypeLabel` on the
 * same zone, so this cannot fire today — it is the tripwire that makes a second
 * room-type mapping impossible to reintroduce **silently**. Throwing here fails
 * the export itself, so every artifact gate that runs through `buildQtoPack`
 * (G1/G3/G5/G9/G10) sees it, not just the unit test.
 *
 * Rows whose Room ID has no Inventory row (the `"OS"` catch-all for a component
 * standing outside every zone) are skipped — there is nothing to contradict.
 */
function assertOneRoomType(rooms: QtoRoomRow[], furniture: TakeoffFurnitureRow[]): void {
  const subcategoryById = new Map(rooms.map((r) => [r.id, r.subcategory]))
  const bad: string[] = []
  for (const f of furniture) {
    const sub = subcategoryById.get(String(f.roomId))
    if (sub !== undefined && sub !== f.roomType) {
      bad.push(`Room ${f.roomId}: Furniture Inventory "${f.roomType}" vs Inventory "${sub}"`)
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `qtoWorkbook: ${bad.length} room(s) carry two different types across sheets — ` +
        `every sheet must read roomTypeLabel(). ${[...new Set(bad)].join(' · ')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// ground-truth.json
// ---------------------------------------------------------------------------

export interface GroundTruthJson {
  sqfPerM2: number
  walls: Record<string, { lengthM: number }>
  doors: Record<string, number>
  doorCount: number
  rooms: {
    roomId: string
    name: string
    spaceType: string
    subcategory: string
    department: string
    headcount: number
    areaM2: number
    areaSqf: number
    floorMaterial: string
    ceilingMaterial: string
    furnitureElements: string
  }[]
  planLabels: string[]
}

/**
 * The `out/ground-truth.json` payload (schema:
 * `docs/reference/qbiq/spec/ground-truth.schema.json`).
 *
 * This is a pure PROJECTION of `QtoModel` — it decides nothing. Every number is
 * already resolved upstream:
 *
 *   * wall runs, door counts, room areas, the sqf factor → `Editor.quantities()`
 *     (Rust core, `crates/ds-core/src/quantity.rs`), verbatim;
 *   * the room SET → `model.rooms`, i.e. `planRoomList` — the same list the
 *     Inventory sheet, the plan labels and the thumbnails are built from, so
 *     G3's three-way 1:1 check cannot fail by construction rather than by luck;
 *   * finish materials, subcategory and furniture elements → `finishSchedule.ts`
 *     and `takeoff.ts`.
 *
 * The core deliberately does NOT emit this file. `ground-truth.json` is a JOIN of
 * core geometry with data the core does not hold (the finish schedule, furniture
 * descriptions, CAD room-marker ids) and with the renderer's drawn labels; a
 * core-side emitter would necessarily compute a SECOND, independent room set —
 * exactly the divergence G3 exists to catch. See `reports/B1-2.md`.
 */
export function buildQtoGroundTruth(model: QtoModel, planLabels: string[]): GroundTruthJson {
  const walls: Record<string, { lengthM: number }> = {}
  for (const w of model.quantities.walls) walls[w.label] = { lengthM: w.lengthM }
  const doors: Record<string, number> = {}
  for (const d of model.quantities.doors) doors[d.label] = d.count
  return {
    sqfPerM2: model.quantities.sqfPerM2,
    walls,
    doors,
    doorCount: model.quantities.doorCount,
    rooms: model.rooms.map((r) => ({
      roomId: r.id,
      name: r.name,
      spaceType: r.spaceType,
      subcategory: r.subcategory,
      department: r.department,
      headcount: r.headcount,
      areaM2: r.areaM2,
      areaSqf: r.areaSqf,
      floorMaterial: r.floorMaterial,
      ceilingMaterial: r.ceilingMaterial,
      furnitureElements: r.furnitureElements,
    })),
    planLabels,
  }
}

// ---------------------------------------------------------------------------
// BOM / Main Summary row wiring
// ---------------------------------------------------------------------------

type QtySource =
  | { kind: 'area'; matCol: 'L' | 'M' }
  | { kind: 'linear'; heightCell: string; lengthCol: number }
  | { kind: 'count'; amountCol: number }

interface BomRowSpec {
  /** `'General'!$B$7` — the merged category band this row belongs to. */
  anchor: string
  /** `'General'!B9` — a DIRECT reference, so renaming a material propagates. */
  nameRef: string
  /** The VLOOKUP table, e.g. `'General'!$B$9:$E$10`. */
  table: string
  idCol: number
  unitCol: number
  priceCol: number
  qty: QtySource
}

/** The `dropdowns` unit → base-unit factor table that column G converts with. */
const UNIT_FACTOR_TABLE = `${q('dropdowns')}!$H$2:$I$10`

/** Every body cell of a Main Summary / BOM row, as live formulas. */
function bomRowCells(spec: BomRowSpec, r: number, invRows: [number, number]): Record<string, Cell> {
  const guard = (body: string) => `IF(ISBLANK(C${r}),"",${body})`
  const look = (col: number) => `VLOOKUP(C${r},${spec.table},${col},FALSE)`
  let qty: string
  if (spec.qty.kind === 'area') {
    const [r0, r1] = invRows
    const inv = q('Inventory')
    qty = guard(
      `ROUND(SUMIF(${inv}!$${spec.qty.matCol}$${r0}:$${spec.qty.matCol}$${r1},$C${r},` +
        `${inv}!$J$${r0}:$J$${r1}),2)`,
    )
  } else if (spec.qty.kind === 'linear') {
    qty = guard(`ROUND(${spec.qty.heightCell}*(${look(spec.qty.lengthCol)}),2)`)
  } else {
    qty = guard(look(spec.qty.amountCol))
  }
  return {
    [`B${r}`]: { f: guard(spec.anchor), style: BODY_TEXT },
    [`C${r}`]: { f: spec.nameRef, style: BODY_TEXT },
    [`D${r}`]: { f: guard(look(spec.idCol)), style: BODY_TEXT },
    [`E${r}`]: { f: guard(look(spec.unitCol)), style: BODY_TEXT },
    // F: the quantity in its BASE unit (m² / m / count), straight off the
    // measured geometry.
    [`F${r}`]: { f: qty, style: BODY_NUM },
    // G: the same quantity expressed in the Unit Type shown in E, so switching
    // a material to f^2 on `General` reconverts the whole book.
    //
    // DEVIATION, and the reason this cell changed: the reference ships G as a
    // literal `0` user-override slot, and it stayed 0 in every exported book —
    // a column headed "Quantity Amount" reading zero on all 26 rows beside a
    // correct quantity. Making it the converted quantity gives the column a
    // meaning, makes the Unit Type dropdowns do something, and leaves the
    // shipped numbers identical (every default factor is 1, so G == F until a
    // unit is changed). A user who wants an override still just types over it.
    [`G${r}`]: {
      f: guard(`ROUND(F${r}*IFERROR(VLOOKUP(E${r},${UNIT_FACTOR_TABLE},2,FALSE),1),2)`),
      style: BODY_NUM,
    },
    [`H${r}`]: { f: guard(look(spec.priceCol)), style: BODY_MONEY },
    // Billed against the quantity in the unit the price is quoted in.
    [`I${r}`]: { f: guard(`ROUND(H${r}*G${r},2)`), style: BODY_MONEY },
  }
}

const BOM_HEADERS = [
  'Material Category',
  'Material Name',
  'Material ID',
  'Unit Type',
  'Quantity Amount (m^2/m/number)',
  'Quantity Amount',
  'Unit Price',
  'Total cost',
]

const BOM_COLS: Record<string, number> = {
  A: 10.67, B: 19.67, C: 33.5, D: 13.5, E: 15.5, F: 20.5, G: 15.5, H: 15.5, I: 16.5,
}

/** A Main Summary / BOM sheet: header at row 4, body from row 5. */
function bomSheet(
  name: string,
  specs: BomRowSpec[],
  invRows: [number, number],
  logo: Uint8Array | null | undefined,
): SheetSpec {
  const cells: Record<string, Cell> = {}
  BOM_HEADERS.forEach((h, i) => {
    cells[`${colName(i + 2)}4`] = { v: h, style: HDR }
  })
  specs.forEach((s, i) => Object.assign(cells, bomRowCells(s, 5 + i, invRows)))
  const last = 4 + Math.max(specs.length, 1)
  return {
    name,
    gridlines: false,
    cols: BOM_COLS,
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells,
    images: logoImages(logo),
    page: LANDSCAPE_A4(`A1:I${last}`),
  }
}

// ---------------------------------------------------------------------------
// Print setup
// ---------------------------------------------------------------------------
//
// Without this every sheet is sliced by COLUMN across pages. Measured on the
// shipped book: 50 PDF pages, with `Main Summary` split so that Material
// Category · Material Name · Material ID printed on one page and Unit Type ·
// Quantity · Unit Price · Total cost on the next — a takeoff whose printed form
// contains no quantities and no costs. `fitToWidth: 1` with an explicit print
// area is the fix; `printTitleRows` repeats the header band so page 3 of the
// Inventory still says what its columns are.

const LANDSCAPE_A4 = (printArea: string, titles = '4:4') => ({
  orientation: 'landscape' as const,
  paperSize: 9,
  fitToWidth: 1,
  fitToHeight: 0,
  printArea,
  printTitleRows: titles,
  horizontalCentered: true,
  margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5 },
})

const LANDSCAPE_A3 = (printArea: string, titles = '4:4') => ({
  ...LANDSCAPE_A4(printArea, titles),
  paperSize: 8,
})

function logoImages(logo: Uint8Array | null | undefined) {
  if (!logo) return undefined
  return [
    {
      data: logo,
      format: 'png' as const,
      from: { col: 1, row: 1 },
      ext: { cx: pxToEmu(LOGO_W), cy: pxToEmu(LOGO_H) },
      name: 'brand-mark',
    },
  ]
}

// ---------------------------------------------------------------------------
// Sheet assembly
// ---------------------------------------------------------------------------

/** Build the 12-sheet parity workbook. Images are optional so the model and the
 *  formula wiring stay unit-testable outside a browser. */
export function buildQtoWorkbook(model: QtoModel, opts: QtoOptions = {}): Uint8Array {
  const logo = opts.logoPng ?? null
  const nRooms = model.rooms.length
  const invR0 = 5
  const invR1 = 4 + Math.max(nRooms, 1)

  // ---- General: block geometry (drives every VLOOKUP range) ---------------
  const fR1 = 8 + Math.max(model.floors.length, 1)
  const cR1 = 8 + Math.max(model.ceilings.length, 1)
  const wR1 = 8 + Math.max(model.walls.length, 1)
  const gR1 = 8 + Math.max(model.glass.length, 1)
  const dR1 = 8 + Math.max(model.doors.length, 1)
  const T_FLOORS = tableRef('B', 'E', 9, fR1)
  const T_CEIL = tableRef('F', 'I', 9, cR1)
  const T_WALLS = tableRef('J', 'N', 9, wR1)
  const T_GLASS = tableRef('O', 'S', 9, gR1)
  const T_DOORS = tableRef('T', 'X', 9, dR1)

  // The two rate blocks live BELOW the five catalog blocks, in columns B..N, so
  // `General` stays as wide as the reference (A..X) and still prints on one
  // page across. Every VLOOKUP range above is row-bounded at `*R1`, so nothing
  // down here can be swept into a catalog lookup.
  const genBlocksLast = Math.max(fR1, cR1, wR1, gR1, dR1)
  const FURN_BAND = genBlocksLast + 3
  const FURN_R0 = FURN_BAND + 2
  const FURN_R1 = FURN_R0 + Math.max(model.furnitureRates.length, 1) - 1
  const BASIS_BAND = FURN_R1 + 3
  const BASIS_R0 = BASIS_BAND + 2
  // Main Summary bills every catalog row except the Walls table's `Glass`,
  // which is billed on its own sheet — see `wallSpecs` below.
  const mainSummarySpecCount =
    model.floors.length +
    model.ceilings.length +
    model.walls.filter((w) => w.name !== 'Glass').length +
    model.glass.length +
    model.doors.length

  // ---- 1. Plan -----------------------------------------------------------
  const planCells: Record<string, Cell> = {
    Q4: { v: 'Wall type', style: HDR },
    S4: { v: 'Length (m)', style: HDR },
  }
  // Chips come from the SAME constant the plan renderer inks its linework with,
  // so the legend and the drawing cannot drift (G4 compares them exactly).
  PLAN_LEGEND_CHIPS.forEach((chip, i) => {
    const row = 5 + i
    planCells[`Q${row}`] = { v: null, style: CHIP(chip.hex) }
    planCells[`R${row}`] = { v: chip.label, style: LEGEND_LABEL }
    planCells[`S${row}`] =
      i < model.walls.length
        ? { f: `${q('General')}!L${9 + i}`, style: { ...LEGEND_LABEL, numFmt: '0.00' } }
        : { v: round2(model.quantities.doorTotalWidthM), style: { ...LEGEND_LABEL, numFmt: '0.00' } }
  })
  const planImages: NonNullable<SheetSpec['images']> = []
  if (opts.planPng) {
    planImages.push({
      data: opts.planPng,
      format: 'png',
      from: { col: 0, row: 0 },
      to: { col: 12, row: 36, colOff: 215900, rowOff: 31750 },
      // `ext` is mandatory here even though `to` defines the anchor box: the
      // writer's twoCellAnchor fallback derives the `spPr` extent from the
      // offset DELTA, which is only right when from.col === to.col (the
      // Inventory thumbnails). Across a 13-column span it collapses to 0.6 cm
      // and LibreOffice honours it — the plan renders as a 19×3 px smudge.
      ext: { cx: pxToEmu(PLAN_PX_W), cy: pxToEmu(PLAN_PX_H) },
      name: 'master-plan',
    })
  }
  if (logo) {
    planImages.push({
      data: logo,
      format: 'png',
      // Directly above the legend block (Q4:S11) and clear of the plan image,
      // which spans A1:M37.
      from: { col: 16, row: 0 },
      ext: { cx: pxToEmu(LOGO_W), cy: pxToEmu(LOGO_H) },
      name: 'brand-mark',
    })
  }
  const plan: SheetSpec = {
    name: 'Plan',
    gridlines: false,
    cols: { A: 10.67, B: 3, C: 35.5, D: 8.67, O: 4, P: 4, Q: 4.5, R: 26, S: 12 },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 18 },
    merges: ['Q4:R4'],
    cells: planCells,
    images: planImages.length ? planImages : undefined,
    // The plan image spans A1:M37 and the legend sits at Q4:S11 — one A3
    // landscape sheet, no repeated title row (there is no table to continue).
    page: {
      orientation: 'landscape',
      paperSize: 8,
      fitToWidth: 1,
      fitToHeight: 1,
      printArea: 'A1:S38',
      horizontalCentered: true,
      margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5 },
    },
  }

  // ---- 2. Furniture Inventory --------------------------------------------
  const fiHeaders = [
    'Cost Code', 'Floor', 'Room ID', 'Room Type', 'Item Description',
    'Supplier', 'Quantity', 'Unit Price', 'Total Price', 'Price Basis',
  ]
  const fiCells: Record<string, Cell> = {}
  fiHeaders.forEach((h, i) => {
    fiCells[`${colName(i + 2)}4`] = { v: h, style: HDR }
  })
  // Rate-card rows reach into the `General` furniture block by name, so
  // repricing every chair on the floor is one cell edit there. A BOUND product's
  // price is a literal: it is the core's `price_inr` for that specific product
  // (ADR 0004) and must not be overwritten by a category rate.
  const furnTable = `${q('General')}!$B$${FURN_R0}:$E$${FURN_R1}`
  model.furniture.forEach((r, i) => {
    const row = 5 + i
    fiCells[`B${row}`] = { v: r.costCode, style: BODY_TEXT }
    fiCells[`C${row}`] = { v: String(r.floor), style: BODY_TEXT }
    fiCells[`D${row}`] = { v: String(r.roomId), style: BODY_TEXT }
    fiCells[`E${row}`] = { v: r.roomType, style: BODY_TEXT }
    fiCells[`F${row}`] = { v: r.itemDescription, style: BODY_TEXT }
    fiCells[`G${row}`] = { v: r.supplier, style: BODY_TEXT }
    fiCells[`H${row}`] = { v: r.quantity, style: BODY_INT }
    fiCells[`I${row}`] =
      r.priceBasis === 'rate-card'
        ? { f: `IFERROR(VLOOKUP(F${row},${furnTable},4,FALSE),0)`, style: BODY_MONEY }
        : { v: r.unitPrice, style: BODY_MONEY }
    fiCells[`J${row}`] = { f: `H${row}*I${row}`, style: BODY_MONEY }
    fiCells[`K${row}`] = { v: PRICE_BASIS_LABEL[r.priceBasis], style: BODY_TEXT }
  })
  const fiLast = 4 + Math.max(model.furniture.length, 1)
  const furnitureInventory: SheetSpec = {
    name: 'Furniture Inventory',
    gridlines: false,
    freeze: 'A5',
    cols: { A: 10.67, B: 12, C: 7, D: 10, E: 22, F: 30, G: 20, H: 10, I: 14, J: 15, K: 26 },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells: fiCells,
    images: logoImages(logo),
    page: LANDSCAPE_A4(`A1:K${fiLast}`),
  }

  // ---- 3. Furniture Inventory Summary ------------------------------------
  const fsHeaders = ['Cost Code', 'Item Description', 'Supplier', 'Quantity', 'Unit Price', 'Total Price']
  const fsCells: Record<string, Cell> = {}
  fsHeaders.forEach((h, i) => {
    fsCells[`${colName(i + 2)}4`] = { v: h, style: HDR }
  })
  const FI = q('Furniture Inventory')
  const descRange = `${FI}!$F$5:$F$${fiLast}`
  model.summary.forEach((r, i) => {
    const row = 5 + i
    fsCells[`B${row}`] = { v: r.costCode, style: BODY_TEXT }
    fsCells[`C${row}`] = { v: r.itemDescription, style: BODY_TEXT }
    fsCells[`D${row}`] = { v: r.supplier, style: BODY_TEXT }
    // Aggregate live off the per-room sheet: adding a room there re-totals here.
    fsCells[`E${row}`] = { f: `SUMIF(${descRange},C${row},${FI}!$H$5:$H$${fiLast})`, style: BODY_INT }
    // The BLENDED unit price: Σ line totals ÷ Σ quantity, so `G = E*F` is the
    // true roll-up even when the same item appears at a bound price in one room
    // and a rate-card price in another. Reading the FIRST matching row's price
    // (INDEX/MATCH) silently under- or over-billed every other room the moment
    // two prices for one description existed.
    fsCells[`F${row}`] = {
      f: `IFERROR(ROUND(SUMIF(${descRange},C${row},${FI}!$J$5:$J$${fiLast})/E${row},2),0)`,
      style: BODY_MONEY,
    }
    fsCells[`G${row}`] = { f: `E${row}*F${row}`, style: BODY_MONEY }
  })
  const fsLast = 4 + Math.max(model.summary.length, 1)
  const furnitureSummary: SheetSpec = {
    name: 'Furniture Inventory Summary',
    gridlines: false,
    freeze: 'A5',
    cols: { A: 10.67, B: 12, C: 30, D: 20, E: 10, F: 14, G: 15 },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells: fsCells,
    images: logoImages(logo),
    page: LANDSCAPE_A4(`A1:G${fsLast}`),
  }

  // ---- 4. Inventory ------------------------------------------------------
  const invHeaders = [
    'Room Image', 'Floor', 'Department', 'Space Type', 'Subcategory', 'Room ID',
    'Program Room Name', 'Headcount', 'Area (m2)', 'Area (sqf)',
    'Floor Material', 'Ceiling Material', 'Furniture Elements',
  ]
  const invCells: Record<string, Cell> = {}
  invHeaders.forEach((h, i) => {
    invCells[`${colName(i + 2)}4`] = { v: h, style: HDR }
  })
  const invRowHeights: Record<number, number> = { 1: 8, 2: 34, 3: 24, 4: 30 }
  const thumbByRoom = new Map((opts.thumbs ?? []).map((t) => [t.id, t.png]))
  const invImages: NonNullable<SheetSpec['images']> = logo
    ? [{
        data: logo,
        format: 'png',
        from: { col: 1, row: 1 },
        ext: { cx: pxToEmu(LOGO_W), cy: pxToEmu(LOGO_H) },
        name: 'brand-mark',
      }]
    : []
  model.rooms.forEach((r, i) => {
    const row = 5 + i
    invRowHeights[row] = INVENTORY_ROW_PT
    invCells[`C${row}`] = { v: String(model.floor), style: BODY_TEXT }
    invCells[`D${row}`] = { v: r.department, style: BODY_TEXT }
    invCells[`E${row}`] = { v: r.spaceType, style: BODY_TEXT }
    invCells[`F${row}`] = { v: r.subcategory, style: BODY_TEXT }
    invCells[`G${row}`] = { v: r.id, style: BODY_TEXT }
    invCells[`H${row}`] = { v: r.name, style: BODY_TEXT }
    invCells[`I${row}`] = { v: r.headcount, style: BODY_INT }
    // Literal, not a formula: G3 reads these cells straight out of the file.
    invCells[`J${row}`] = { v: r.areaM2, style: BODY_NUM }
    invCells[`K${row}`] = { v: r.areaSqf, style: BODY_NUM }
    invCells[`L${row}`] = { v: r.floorMaterial, style: BODY_TEXT }
    invCells[`M${row}`] = { v: r.ceilingMaterial, style: BODY_TEXT }
    invCells[`N${row}`] = { v: r.furnitureElements, style: BODY_TEXT }
    const png = thumbByRoom.get(r.id)
    if (png) {
      invImages.push({
        data: png,
        format: 'png',
        from: { col: 1, row: row - 1 },
        to: { col: 1, row: row - 1, colOff: pxToEmu(THUMB_W), rowOff: pxToEmu(THUMB_H) },
        name: `room-${r.id}`,
      })
    }
  })
  const inventory: SheetSpec = {
    name: 'Inventory',
    gridlines: false,
    freeze: 'A5',
    cols: {
      A: 10.67, B: 36, C: 8, D: 14, E: 20, F: 18, G: 10, H: 24,
      I: 11, J: 12, K: 12, L: 28, M: 28, N: 48,
    },
    rowHeights: invRowHeights,
    cells: invCells,
    images: invImages.length ? invImages : undefined,
    // A3: thirteen columns including two 28-char finish names and a 48-char
    // furniture list. On A4 the fit scale makes it unreadable.
    page: LANDSCAPE_A3(`A1:N${invR1}`),
  }

  // ---- 5. General --------------------------------------------------------
  const gen: Record<string, Cell> = {
    B4: { v: 'Floor Height', style: HDR }, C4: { v: 'Unit Type', style: HDR },
    D4: { v: 'Ceiling Height', style: HDR }, E4: { v: 'Unit Type', style: HDR },
    F4: { v: 'Door Height', style: HDR }, G4: { v: 'Unit Type', style: HDR },
    H4: { v: 'Glass Partition Height', style: HDR }, I4: { v: 'Unit Type', style: HDR },
    J4: { v: 'Glass Plaster Wall Height', style: HDR }, K4: { v: 'Unit Type', style: HDR },
    B5: { v: 4.0, style: SCALAR }, C5: { v: 'm', style: BODY_TEXT },
    // The height every wall/glass area formula multiplies by comes from the
    // core (`quantities.wallHeightM`), not a hard-coded 3.0 — it is the same
    // number the 3D viewer extrudes walls at.
    D5: { v: round2(model.quantities.wallHeightM), style: SCALAR }, E5: { v: 'm', style: BODY_TEXT },
    F5: { v: 2.1, style: SCALAR }, G5: { v: 'm', style: BODY_TEXT },
    H5: { v: round2(model.quantities.wallHeightM), style: SCALAR }, I5: { v: 'm', style: BODY_TEXT },
    J5: { v: 1.0, style: SCALAR }, K5: { v: 'm', style: BODY_TEXT },
    B7: { v: 'Floors', style: BAND },
    F7: { v: 'Ceilings', style: BAND },
    J7: { v: 'Walls', style: BAND },
    O7: { v: 'Glass Partitions', style: BAND },
    T7: { v: 'Doors', style: BAND },
  }
  const block = (cols: string[], headers: string[], rows: CatalogRow[], kind: 'plain' | 'linear' | 'count') => {
    headers.forEach((h, i) => {
      gen[`${cols[i]}8`] = { v: h, style: HDR }
    })
    rows.forEach((r, i) => {
      const row = 9 + i
      gen[`${cols[0]}${row}`] = { v: r.name, style: BODY_TEXT }
      gen[`${cols[1]}${row}`] = { v: r.id, style: BODY_INT }
      if (kind === 'plain') {
        gen[`${cols[2]}${row}`] = { v: r.unit, style: BODY_TEXT }
        gen[`${cols[3]}${row}`] = { v: r.price, style: BODY_MONEY }
      } else if (kind === 'linear') {
        gen[`${cols[2]}${row}`] = { v: r.lengthM ?? 0, style: BODY_NUM }
        gen[`${cols[3]}${row}`] = { v: r.unit, style: BODY_TEXT }
        gen[`${cols[4]}${row}`] = { v: r.price, style: BODY_MONEY }
      } else {
        gen[`${cols[2]}${row}`] = { v: r.unit, style: BODY_TEXT }
        gen[`${cols[3]}${row}`] = { v: r.count ?? 0, style: BODY_INT }
        gen[`${cols[4]}${row}`] = { v: r.price, style: BODY_MONEY }
      }
    })
  }
  block(['B', 'C', 'D', 'E'], ['Material Name', 'Material ID', 'Unit Type', 'Unit Price'], model.floors, 'plain')
  block(['F', 'G', 'H', 'I'], ['Material Name', 'Material ID', 'Unit Type', 'Unit Price'], model.ceilings, 'plain')
  block(
    ['J', 'K', 'L', 'M', 'N'],
    ['Material Name', 'Material ID', 'Length (m)', 'Unit Type', 'Unit Price'],
    model.walls,
    'linear',
  )
  block(
    ['O', 'P', 'Q', 'R', 'S'],
    ['Material Name', 'Material ID', 'Length (m)', 'Unit Type', 'Unit Price'],
    model.glass,
    'linear',
  )
  block(
    ['T', 'U', 'V', 'W', 'X'],
    ['Type Name', 'Type ID', 'Unit Type', 'Amount', 'Unit Price'],
    model.doors,
    'count',
  )
  // The glass-partition run is the SAME measurement as the Walls table's Glass
  // row — referenced, never re-stated, so the two can never drift.
  const glassWallRow = 9 + model.walls.findIndex((w) => w.name === 'Glass')
  if (glassWallRow >= 9) gen.Q9 = { f: `L${glassWallRow}`, style: BODY_NUM }

  // ---- General: the visible rate card ------------------------------------
  //
  // Two tables under the catalog. The first is the furniture rate block the
  // Furniture Inventory looks up. The second states, for every ₹ figure the
  // book bills, WHERE that figure comes from — and its Unit Price column is a
  // FORMULA pointing at the catalog cell above, never a second copy of the
  // number, so the basis table cannot drift from the rate it explains.
  gen[`B${FURN_BAND}`] = { v: 'Furniture — rate card (₹ per unit)', style: BAND }
  const furnHdr = ['Item Description', 'Item ID', 'Unit Type', 'Unit Price', 'Rate basis']
  furnHdr.forEach((h, i) => {
    gen[`${colName(i + 2)}${FURN_BAND + 1}`] = { v: h, style: HDR }
  })
  model.furnitureRates.forEach((f, i) => {
    const row = FURN_R0 + i
    gen[`B${row}`] = { v: f.name, style: BODY_TEXT }
    gen[`C${row}`] = { v: f.id, style: BODY_INT }
    gen[`D${row}`] = { v: 'Number', style: BODY_TEXT }
    gen[`E${row}`] = { v: f.price, style: BODY_MONEY }
    gen[`F${row}`] = { v: f.basis, style: BODY_WRAP }
  })

  gen[`B${BASIS_BAND}`] = { v: 'Rate basis — every ₹ figure in this book', style: BAND }
  // The name goes in the wide column (B), the category in the merged C:D, so
  // 'Anti-skid vitrified tile (VIT)' and 'Glass Partitions' both fit on one
  // line at the widths the catalog blocks above already fix.
  const basisHdr: [string, string][] = [
    ['B', 'Material / Type Name'],
    ['C', 'Category'],
    ['E', 'Unit Price'],
    ['F', 'Basis & source'],
  ]
  basisHdr.forEach(([c, h]) => {
    gen[`${c}${BASIS_BAND + 1}`] = { v: h, style: HDR }
  })
  gen[`D${BASIS_BAND + 1}`] = { v: null, style: HDR }
  const basisRows: { category: string; row: CatalogRow; priceCell: string }[] = [
    ...model.floors.map((row, i) => ({ category: 'Floors', row, priceCell: `E${9 + i}` })),
    ...model.ceilings.map((row, i) => ({ category: 'Ceilings', row, priceCell: `I${9 + i}` })),
    ...model.walls.map((row, i) => ({ category: 'Walls', row, priceCell: `N${9 + i}` })),
    ...model.glass.map((row, i) => ({ category: 'Glass Partitions', row, priceCell: `S${9 + i}` })),
    ...model.doors.map((row, i) => ({ category: 'Doors', row, priceCell: `X${9 + i}` })),
  ]
  basisRows.forEach((b, i) => {
    const row = BASIS_R0 + i
    gen[`B${row}`] = { v: b.row.name, style: BODY_TEXT }
    gen[`C${row}`] = { v: `${b.category} · ${b.row.unit}`, style: BODY_TEXT }
    gen[`D${row}`] = { v: null, style: BODY_TEXT }
    // A reference, not a restatement: edit the catalog above and this moves.
    gen[`E${row}`] = { f: b.priceCell, style: BODY_MONEY }
    gen[`F${row}`] = { v: b.row.basis, style: BODY_WRAP }
  })
  const basisLast = BASIS_R0 + Math.max(basisRows.length, 1) - 1

  // ---- what the whole book adds up to ------------------------------------
  // Live sums across the two halves of the takeoff. This lives on `General`
  // and NOT as a footer row on `Main Summary`: a `SUM(I5:I29)` inside that
  // sheet's own cost column is double-counted by anything that totals the
  // column, including G2's recalc check.
  const totalRow = basisLast + 2
  const msRows = 4 + Math.max(mainSummarySpecCount, 1)
  const MS = q('Main Summary')
  const FIQ = q('Furniture Inventory')
  const INV = q('Inventory')
  gen[`B${totalRow}`] = { v: 'Project total — this takeoff', style: BAND }
  const totalLines: [string, string][] = [
    ['Materials & construction (Main Summary)', `SUM(${MS}!$I$5:$I$${msRows})`],
    ['Loose furniture & FF&E (Furniture Inventory)', `SUM(${FIQ}!$J$5:$J$${fiLast})`],
    ['Total, scope billed here', `E${totalRow + 1}+E${totalRow + 2}`],
    ['per m² of billed floor area', `IFERROR(E${totalRow + 3}/SUM(${INV}!$J$5:$J$${invR1}),0)`],
    ['per sqft of billed floor area', `IFERROR(E${totalRow + 3}/SUM(${INV}!$K$5:$K$${invR1}),0)`],
  ]
  totalLines.forEach(([label, formula], i) => {
    const row = totalRow + 1 + i
    gen[`B${row}`] = { v: label, style: i === 2 ? { ...BODY_TEXT, font: { bold: true } } : BODY_TEXT }
    gen[`C${row}`] = { v: null, style: BODY_TEXT }
    gen[`D${row}`] = { v: null, style: BODY_TEXT }
    gen[`E${row}`] = { f: formula, style: i === 2 ? { ...BODY_MONEY, font: { bold: true } } : BODY_MONEY }
    gen[`F${row}`] = { v: null, style: BODY_WRAP }
  })
  const totalLast = totalRow + totalLines.length

  const scopeRow = totalLast + 2
  gen[`B${scopeRow}`] = { v: 'Scope of this takeoff', style: BAND }
  gen[`B${scopeRow + 1}`] = { v: SCOPE_NOTE, style: BODY_WRAP }

  // Long basis text needs room; the merge lets it run across the (empty)
  // catalog columns to its right instead of wrapping into a 20-line cell.
  const basisMerges = [
    `B${FURN_BAND}:F${FURN_BAND}`,
    `B${BASIS_BAND}:F${BASIS_BAND}`,
    `C${BASIS_BAND + 1}:D${BASIS_BAND + 1}`,
    `B${totalRow}:F${totalRow}`,
    `B${scopeRow}:F${scopeRow}`,
    `B${scopeRow + 1}:N${scopeRow + 1}`,
    ...model.furnitureRates.map((_f, i) => `F${FURN_R0 + i}:N${FURN_R0 + i}`),
    ...basisRows.flatMap((_b, i) => [`C${BASIS_R0 + i}:D${BASIS_R0 + i}`, `F${BASIS_R0 + i}:N${BASIS_R0 + i}`]),
    ...totalLines.map((_t, i) => `B${totalRow + 1 + i}:D${totalRow + 1 + i}`),
  ]
  const rateRowHeights: Record<number, number> = {}
  for (let i = 0; i < model.furnitureRates.length; i++) rateRowHeights[FURN_R0 + i] = 42
  for (let i = 0; i < basisRows.length; i++) rateRowHeights[BASIS_R0 + i] = 42
  rateRowHeights[scopeRow + 1] = 90

  const general: SheetSpec = {
    name: 'General',
    gridlines: false,
    cols: {
      A: 9.17, B: 26, C: 12, D: 10, E: 12, F: 26, G: 12, H: 11.35, I: 12,
      J: 19.67, K: 11.85, L: 10, M: 8, N: 12, O: 19.5, P: 11.85, Q: 10, R: 8, S: 12,
      T: 12.17, U: 12.5, V: 10.17, W: 10, X: 12.67,
    },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 40, 5: 19.5, 6: 10, 7: 19.5, 8: 30, ...rateRowHeights },
    merges: ['B7:E7', 'F7:I7', 'J7:N7', 'O7:S7', 'T7:X7', ...basisMerges],
    cells: gen,
    images: logoImages(logo),
    // No repeated title row: `General` carries FOUR different tables down the
    // page (the catalog, the furniture rates, the rate basis, the totals), so
    // repeating row 8 would head the rate-basis page with the catalog's column
    // names — a header that lies about the table under it.
    page: {
      orientation: 'landscape',
      paperSize: 8,
      fitToWidth: 1,
      fitToHeight: 0,
      printArea: `A1:X${scopeRow + 1}`,
      horizontalCentered: true,
      margins: { left: 0.35, right: 0.35, top: 0.5, bottom: 0.5 },
    },
    // Wired to the `dropdowns` sheet's ranges rather than inline literals, so
    // the lists are visible, editable and gate-verifiable (Agent A's rec).
    validations: [
      // Heights are lengths; every BILLED quantity in this book is an area or a
      // count, so the wall (M) and glass (R) unit cells take the AREA list —
      // they used to offer cm/m/f/inch beside a quantity measured in m² of
      // elevation.
      {
        type: 'list',
        formula1: `${q('dropdowns')}!$B$2:$B$5`,
        sqref: ['C5', 'E5', 'G5', 'I5', 'K5'],
      },
      {
        type: 'list',
        formula1: `${q('dropdowns')}!$C$2:$C$5`,
        sqref: [`D9:D${fR1}`, `H9:H${cR1}`, `M9:M${wR1}`, `R9:R${gR1}`],
      },
      { type: 'list', formula1: `${q('dropdowns')}!$E$2:$E$2`, sqref: `V9:V${dR1}` },
    ],
  }

  // ---- 6..11. Main Summary + the five BOM sheets -------------------------
  const floorSpecs: BomRowSpec[] = model.floors.map((_, i) => ({
    anchor: `${q('General')}!$B$7`,
    nameRef: `${q('General')}!B${9 + i}`,
    table: T_FLOORS,
    idCol: 2, unitCol: 3, priceCol: 4,
    qty: { kind: 'area', matCol: 'L' },
  }))
  const ceilingSpecs: BomRowSpec[] = model.ceilings.map((_, i) => ({
    anchor: `${q('General')}!$F$7`,
    nameRef: `${q('General')}!F${9 + i}`,
    table: T_CEIL,
    idCol: 2, unitCol: 3, priceCol: 4,
    qty: { kind: 'area', matCol: 'M' },
  }))
  // Glass is billed on its own sheet at the glazing height, so it is excluded
  // here — the Walls table still carries all six types for the ground truth.
  const wallSpecs: BomRowSpec[] = model.walls
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.name !== 'Glass')
    .map(({ i }) => ({
      anchor: `${q('General')}!$J$7`,
      nameRef: `${q('General')}!J${9 + i}`,
      table: T_WALLS,
      idCol: 2, unitCol: 4, priceCol: 5,
      qty: { kind: 'linear' as const, heightCell: `${q('General')}!$D$5`, lengthCol: 3 },
    }))
  const glassSpecs: BomRowSpec[] = model.glass.map((_, i) => ({
    anchor: `${q('General')}!$O$7`,
    nameRef: `${q('General')}!O${9 + i}`,
    table: T_GLASS,
    idCol: 2, unitCol: 4, priceCol: 5,
    qty: { kind: 'linear', heightCell: `${q('General')}!$H$5`, lengthCol: 3 },
  }))
  const doorSpecs: BomRowSpec[] = model.doors.map((_, i) => ({
    anchor: `${q('General')}!$T$7`,
    nameRef: `${q('General')}!T${9 + i}`,
    table: T_DOORS,
    idCol: 2, unitCol: 3, priceCol: 5,
    qty: { kind: 'count', amountCol: 4 },
  }))

  const invRows: [number, number] = [invR0, invR1]
  const mainSummary = bomSheet(
    'Main Summary',
    [...floorSpecs, ...ceilingSpecs, ...wallSpecs, ...glassSpecs, ...doorSpecs],
    invRows,
    logo,
  )

  // ---- 12. dropdowns -----------------------------------------------------
  const LISTS: [string, string[]][] = [
    ['Material Category', ['Floors', 'Ceilings', 'Walls', 'Glass Partitions', 'Doors']],
    ['Length Unit Type', ['cm', 'm', 'f', 'inch']],
    ['Area Unit Type', ['cm^2', 'm^2', 'f^2', 'inch^2']],
    ['Volume Unit Type', ['cm^3', 'm^3', 'f^3', 'inch^3']],
    ['General Unit Type', ['Number']],
    ['units', ['cm', 'm', 'feet', 'inch']],
  ]
  const ddCells: Record<string, Cell> = {}
  LISTS.forEach(([head, vals], ci) => {
    const col = colName(ci + 1)
    ddCells[`${col}1`] = { v: head, style: HDR }
    vals.forEach((v, ri) => {
      ddCells[`${col}${2 + ri}`] = { v, style: BODY_TEXT }
    })
  })
  // The conversion table column G of every BOM sheet reads. It lives here, in
  // the open, rather than baked into a chain of nested IFs: a reader can see
  // that f^2 is 10.7639 m², and correct it if their local convention differs.
  // Rows are `<unit, multiples of the base unit>`; the base is m for a length,
  // m² for an area, and 1 for a count.
  ddCells.H1 = { v: 'Unit', style: HDR }
  ddCells.I1 = { v: 'x base (m / m^2 / count)', style: HDR }
  UNIT_FACTORS.forEach(([unit, factor], i) => {
    ddCells[`H${2 + i}`] = { v: unit, style: BODY_TEXT }
    ddCells[`I${2 + i}`] = { v: factor, style: { ...BODY, numFmt: '0.######' } }
  })
  const dropdowns: SheetSpec = {
    name: 'dropdowns',
    gridlines: false,
    cols: { A: 19.5, B: 22.5, C: 20.85, D: 22.85, E: 27.5, F: 8.85, G: 3, H: 12, I: 24 },
    rowHeights: { 1: 17 },
    cells: ddCells,
    page: {
      orientation: 'landscape',
      paperSize: 9,
      fitToWidth: 1,
      fitToHeight: 0,
      printArea: `A1:I${1 + UNIT_FACTORS.length}`,
      horizontalCentered: true,
    },
  }

  return buildXlsx([
    plan,
    furnitureInventory,
    furnitureSummary,
    inventory,
    general,
    mainSummary,
    bomSheet('BOM - Floors', floorSpecs, invRows, logo),
    bomSheet('BOM - Ceilings', ceilingSpecs, invRows, logo),
    bomSheet('BOM - Glass Partitions', glassSpecs, invRows, logo),
    bomSheet('BOM - Doors', doorSpecs, invRows, logo),
    bomSheet('BOM - Walls', wallSpecs, invRows, logo),
    dropdowns,
  ])
}

// ---------------------------------------------------------------------------
// Brand mark
// ---------------------------------------------------------------------------

/**
 * The 181×83 mark embedded on all 11 data sheets (the reference's logo slot).
 * Drawn on a canvas so there is no binary blob in the source tree; the media
 * table de-dupes it by content, so 11 placements cost one `xl/media` part.
 */
export async function renderBrandMarkPng(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = LOGO_W
  canvas.height = LOGO_H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, LOGO_W, LOGO_H)
  ctx.fillStyle = ACCENT_AMBER
  ctx.fillRect(10, 24, 8, 36)
  ctx.fillStyle = '#1C2126'
  ctx.font = '700 26px Helvetica, Arial, sans-serif'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('DSOURCE', 26, 46)
  ctx.font = '400 10px Helvetica, Arial, sans-serif'
  ctx.fillStyle = '#7D8EA2'
  ctx.fillText('QUANTITY TAKEOFF', 27, 60)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('canvas.toBlob returned null')
  return new Uint8Array(await blob.arrayBuffer())
}

// ---------------------------------------------------------------------------
// Browser action
// ---------------------------------------------------------------------------

export interface QtoRenderOptions extends QtoOptions {
  /** `Editor.circulation()`, or `null` when the document has no walls. */
  circulation?: unknown
  /** Traced plate polygon; clips the circulation wash on irregular plates. */
  plate?: [number, number][] | null
  /** `classifyWalls(state, Editor.wall_types())` — the core's classification. */
  wallSpans?: unknown
}

/** Everything one export action produces, in memory. */
export interface QtoPack {
  xlsx: Uint8Array
  planPng: Uint8Array
  /** An INDEPENDENT re-render of the same inputs — proves determinism (G4). */
  planRepeatPng: Uint8Array
  thumbs: { id: string; png: Uint8Array }[]
  groundTruth: GroundTruthJson
  model: QtoModel
}

/**
 * Render the plan + thumbnails and build the parity workbook. ONE client-side
 * pass — no server round-trip, no second renderer: these are the very same
 * `planGraphic` / `roomThumbs` functions the headless gate harness calls.
 *
 * `quantities` must be `Editor.quantities()`; `wallSpans` should be
 * `classifyWalls(state, Editor.wall_types())` so the coloured plan and the
 * billed workbook classify every wall identically.
 */
export async function buildQtoPack(
  state: DocState,
  quantities: Quantities,
  opts: QtoRenderOptions = {},
): Promise<QtoPack> {
  const { renderHighlightedPlan } = await import('./planGraphic')
  const { renderAllRoomThumbnails } = await import('./roomThumbs')
  const model = buildQtoModel(state, quantities, opts)
  const planOpts = {
    roomRefs: opts.roomRefs,
    circulation: opts.circulation as never,
    plate: opts.plate ?? null,
    wallSpans: opts.wallSpans as never,
  }
  // No `rooms` override: both this model and the renderer call `planRoomList`
  // with the same `roomRefs`, so the Inventory rows and the plan labels are the
  // same set by construction (G3's 1:1 check).
  const one = await renderHighlightedPlan(state, planOpts)
  const two = await renderHighlightedPlan(state, planOpts)
  const thumbs = await renderAllRoomThumbnails(state, {
    roomRefs: opts.roomRefs,
    wallSpans: planOpts.wallSpans,
  })
  const logoPng = opts.logoPng ?? (await renderBrandMarkPng())
  const xlsx = buildQtoWorkbook(model, { ...opts, planPng: one.png, thumbs, logoPng })
  return {
    xlsx,
    planPng: one.png,
    planRepeatPng: two.png,
    thumbs,
    groundTruth: buildQtoGroundTruth(model, one.labels),
    model,
  }
}

/** Build the parity workbook and download it (the export menu's action). */
export async function exportQtoWorkbook(
  state: DocState,
  quantities: Quantities,
  opts: QtoRenderOptions = {},
  filename = 'dsource-quantity-takeoff.xlsx',
): Promise<Uint8Array> {
  const pack = await buildQtoPack(state, quantities, opts)
  const blob = new Blob([pack.xlsx as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  triggerDownload(blob, filename)
  return pack.xlsx
}
