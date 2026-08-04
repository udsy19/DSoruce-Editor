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
//   * furniture rows → `buildTakeoffModel` (takeoff.ts)
//   * legend chip hexes → `PLAN_LEGEND_CHIPS` (qbiqPalette → palette.json)
//   * the OOXML byte stream → `buildXlsx` (workbook.ts)
//
// Layout mirrors `docs/reference/qbiq/spec/workbook-spec.json`. Deviations from
// the reference are marked `DEVIATION:` and explained where they occur.

import type { DocState, DocZone } from '../editor/EditorCanvas'
import { zoneArea } from '../util/zoneGeom'
import { FINISH_SPEC, TYPE_LABEL, finishTypeFor } from './finishSchedule'
import { CIRCULATION_ROOM_ID, planRoomList, type PlanRoom } from './planGraphic'
import { PLAN_LEGEND_CHIPS, WORKBOOK_CHROME } from './qbiqPalette'
import { buildTakeoffModel, type TakeoffOptions } from './takeoff'
import { buildXlsx, colName, pxToEmu, type Cell, type SheetSpec, type StyleSpec } from './workbook'
import { triggerDownload } from './png'
import { zipStore } from './zip'

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
   * OPT-IN unit-price pre-fill, keyed by the `General` Material/Type Name.
   * Absent → every unit price ships as `0`, which is the honest default: the
   * material bank prices furniture, not floor finishes or drywall runs. The
   * client fills these in and the workbook reprices itself.
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
  floor: string | number
  project: string
}

/** One row of a `General` catalog block. */
export interface CatalogRow {
  name: string
  id: number
  unit: string
  price: number
  /** Linear categories (walls, glass partitions) carry their measured run. */
  lengthM?: number
  /** Counted categories (doors) carry their amount. */
  count?: number
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
const BODY_MONEY: StyleSpec = { ...BODY, numFmt: '"₹"#,##0.00' }
const SCALAR: StyleSpec = { ...BODY, numFmt: '0.00', font: { bold: true } }
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
    if (z.zone_type !== 'Circulation') continue
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
    if (z.zone_type === 'Circulation') furnitureRefs.set(z.id, CIRCULATION_ROOM_ID)
  }
  const takeoff = buildTakeoffModel(state, { ...opts, roomRefs: furnitureRefs })

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
        if (z.zone_type === 'Circulation') areaM2 += qtyById.get(z.id)?.areaM2 ?? 0
      }
    }
    const key = zone ? finishTypeFor(zone) : 'other'
    const spec = FINISH_SPEC[key]
    return {
      id: pr.id,
      zoneId: pr.zoneId,
      department: 'GENERAL',
      spaceType: pr.zoneId == null ? 'Circulation' : qr?.spaceType ?? pr.label,
      subcategory: pr.zoneId == null ? 'Circulation' : TYPE_LABEL[key],
      name: pr.label,
      headcount: pr.zoneId == null ? 0 : qr?.headcount ?? 0,
      areaM2,
      areaSqf: areaM2 * quantities.sqfPerM2,
      floorMaterial: spec.floor,
      ceilingMaterial: spec.ceiling,
      furnitureElements: (byRoom.get(pr.id) ?? []).join(', '),
    }
  })

  // --- General catalog blocks ---------------------------------------------
  const price = (name: string) => opts.unitPrices?.[name] ?? 0
  const distinct = (vals: string[]) => [...new Set(vals)]

  const floors: CatalogRow[] = distinct(rooms.map((r) => r.floorMaterial)).map((name) => ({
    name,
    id: materialId(name),
    unit: 'm^2',
    price: price(name),
  }))
  const ceilings: CatalogRow[] = distinct(rooms.map((r) => r.ceilingMaterial)).map((name) => ({
    name,
    id: materialId(name),
    unit: 'm^2',
    price: price(name),
  }))

  // All six wall types, legend order, zero-length rows included — G3 checks the
  // General!J/L table against the ground truth in BOTH directions.
  const walls: CatalogRow[] = quantities.walls.map((w) => ({
    name: w.label,
    id: materialId(w.label),
    unit: 'm',
    price: price(w.label),
    lengthM: w.lengthM,
  }))
  const glassRun = quantities.walls.find((w) => w.label === 'Glass')?.lengthM ?? 0
  const glass: CatalogRow[] = [
    {
      name: 'Glass Partition',
      id: materialId('Glass Partition'),
      unit: 'm',
      price: price('Glass Partition'),
      lengthM: glassRun,
    },
  ]
  const doors: CatalogRow[] = quantities.doors.map((d) => ({
    name: d.label,
    id: materialId(`Door ${d.label}`),
    unit: 'Number',
    price: price(d.label),
    count: d.count,
  }))

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
    floor: opts.floor ?? 1,
    project: opts.project ?? 'DSource Test-Fit',
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

/** Every body cell of a Main Summary / BOM row, as live formulas. */
function bomRowCells(spec: BomRowSpec, r: number, invRows: [number, number]): Record<string, Cell> {
  const guard = (body: string) => `IF(ISBLANK(C${r}),"",${body})`
  const look = (col: number) => `VLOOKUP(C${r},${spec.table},${col},FALSE)`
  let qty: string
  if (spec.qty.kind === 'area') {
    const [r0, r1] = invRows
    const inv = q('Inventory')
    qty = guard(
      `SUMIF(${inv}!$${spec.qty.matCol}$${r0}:$${spec.qty.matCol}$${r1},$C${r},` +
        `${inv}!$J$${r0}:$J$${r1})`,
    )
  } else if (spec.qty.kind === 'linear') {
    qty = guard(`${spec.qty.heightCell}*(${look(spec.qty.lengthCol)})`)
  } else {
    qty = guard(look(spec.qty.amountCol))
  }
  return {
    [`B${r}`]: { f: guard(spec.anchor), style: BODY_TEXT },
    [`C${r}`]: { f: spec.nameRef, style: BODY_TEXT },
    [`D${r}`]: { f: guard(look(spec.idCol)), style: BODY_TEXT },
    [`E${r}`]: { f: guard(look(spec.unitCol)), style: BODY_TEXT },
    [`F${r}`]: { f: qty, style: BODY_NUM },
    // The ONE hardcoded body cell: a user override slot. Left at 0, the total
    // falls back to the measured quantity in F (see column I).
    [`G${r}`]: { v: 0, style: BODY_NUM },
    [`H${r}`]: { f: guard(look(spec.priceCol)), style: BODY_MONEY },
    // DEVIATION: the reference bills area rows as H*G, and G ships as a literal
    // 0 — so editing a floor unit price there moves nothing. Falling back to F
    // when the override is unset makes every row live, which is the entire
    // point of the deliverable.
    [`I${r}`]: { f: guard(`H${r}*IF(G${r}>0,G${r},F${r})`), style: BODY_MONEY },
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
  return {
    name,
    gridlines: false,
    cols: BOM_COLS,
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells,
    images: logoImages(logo),
  }
}

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
        : { v: model.quantities.doorTotalWidthM, style: { ...LEGEND_LABEL, numFmt: '0.00' } }
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
  }

  // ---- 2. Furniture Inventory --------------------------------------------
  const fiHeaders = [
    'Cost Code', 'Floor', 'Room ID', 'Room Type', 'Item Description',
    'Supplier', 'Quantity', 'Unit Price', 'Total Price',
  ]
  const fiCells: Record<string, Cell> = {}
  fiHeaders.forEach((h, i) => {
    fiCells[`${colName(i + 2)}4`] = { v: h, style: HDR }
  })
  model.furniture.forEach((r, i) => {
    const row = 5 + i
    fiCells[`B${row}`] = { v: r.costCode, style: BODY_TEXT }
    fiCells[`C${row}`] = { v: String(r.floor), style: BODY_TEXT }
    fiCells[`D${row}`] = { v: String(r.roomId), style: BODY_TEXT }
    fiCells[`E${row}`] = { v: r.roomType, style: BODY_TEXT }
    fiCells[`F${row}`] = { v: r.itemDescription, style: BODY_TEXT }
    fiCells[`G${row}`] = { v: r.supplier, style: BODY_TEXT }
    fiCells[`H${row}`] = { v: r.quantity, style: BODY_INT }
    fiCells[`I${row}`] = { v: r.unitPrice, style: BODY_MONEY }
    fiCells[`J${row}`] = { f: `H${row}*I${row}`, style: BODY_MONEY }
  })
  const fiLast = 4 + Math.max(model.furniture.length, 1)
  const furnitureInventory: SheetSpec = {
    name: 'Furniture Inventory',
    gridlines: false,
    freeze: 'A5',
    cols: { A: 10.67, B: 12, C: 7, D: 10, E: 22, F: 30, G: 20, H: 10, I: 14, J: 15 },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells: fiCells,
    images: logoImages(logo),
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
    fsCells[`F${row}`] = {
      f: `IFERROR(INDEX(${FI}!$I$5:$I$${fiLast},MATCH(C${row},${descRange},0)),0)`,
      style: BODY_MONEY,
    }
    fsCells[`G${row}`] = { f: `E${row}*F${row}`, style: BODY_MONEY }
  })
  const furnitureSummary: SheetSpec = {
    name: 'Furniture Inventory Summary',
    gridlines: false,
    freeze: 'A5',
    cols: { A: 10.67, B: 12, C: 30, D: 20, E: 10, F: 14, G: 15 },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 30 },
    cells: fsCells,
    images: logoImages(logo),
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
    D5: { v: model.quantities.wallHeightM, style: SCALAR }, E5: { v: 'm', style: BODY_TEXT },
    F5: { v: 2.1, style: SCALAR }, G5: { v: 'm', style: BODY_TEXT },
    H5: { v: model.quantities.wallHeightM, style: SCALAR }, I5: { v: 'm', style: BODY_TEXT },
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

  const general: SheetSpec = {
    name: 'General',
    gridlines: false,
    cols: {
      A: 9.17, B: 26, C: 12, D: 10, E: 12, F: 26, G: 12, H: 11.35, I: 12,
      J: 19.67, K: 11.85, L: 10, M: 8, N: 12, O: 19.5, P: 11.85, Q: 10, R: 8, S: 12,
      T: 12.17, U: 12.5, V: 10.17, W: 10, X: 12.67,
    },
    rowHeights: { 1: 8, 2: 34, 3: 24, 4: 40, 5: 19.5, 6: 10, 7: 19.5, 8: 30 },
    merges: ['B7:E7', 'F7:I7', 'J7:N7', 'O7:S7', 'T7:X7'],
    cells: gen,
    images: logoImages(logo),
    // Wired to the `dropdowns` sheet's ranges rather than inline literals, so
    // the lists are visible, editable and gate-verifiable (Agent A's rec).
    validations: [
      {
        type: 'list',
        formula1: `${q('dropdowns')}!$B$2:$B$5`,
        sqref: [`M9:M${wR1}`, `R9:R${gR1}`, 'C5', 'E5', 'G5', 'I5', 'K5'],
      },
      {
        type: 'list',
        formula1: `${q('dropdowns')}!$C$2:$C$5`,
        sqref: [`D9:D${fR1}`, `H9:H${cR1}`],
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
  const dropdowns: SheetSpec = {
    name: 'dropdowns',
    gridlines: false,
    cols: { A: 19.5, B: 22.5, C: 20.85, D: 22.85, E: 27.5, F: 8.85 },
    rowHeights: { 1: 17 },
    cells: ddCells,
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
  ctx.fillStyle = '#E8A13C'
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

/**
 * The deliverable pack as one .zip, from one click: the workbook, the master
 * plan (plus its determinism twin), the per-room thumbnails and
 * `ground-truth.json`. The 3D renders, the walkthrough and the share link are
 * appended by their own owners; this is the client-side half.
 */
export async function exportDeliverablePack(
  state: DocState,
  quantities: Quantities,
  opts: QtoRenderOptions = {},
  filename = 'dsource-deliverable-pack.zip',
): Promise<QtoPack> {
  const pack = await buildQtoPack(state, quantities, opts)
  const enc = new TextEncoder()
  const files = [
    { name: 'quantity-takeoff.xlsx', data: pack.xlsx },
    { name: 'plan.png', data: pack.planPng },
    { name: 'plan.repeat.png', data: pack.planRepeatPng },
    {
      name: 'ground-truth.json',
      data: enc.encode(JSON.stringify(pack.groundTruth, null, 2)),
    },
    ...pack.thumbs.map((t) => ({ name: `thumbs/${t.id}.png`, data: t.png })),
  ]
  triggerDownload(new Blob([zipStore(files) as unknown as BlobPart], { type: 'application/zip' }), filename)
  return pack
}
