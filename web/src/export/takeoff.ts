// Quantity Takeoff export: DocState -> .xlsx bill of materials.
//
// Replicates the qbiq "Quantity Takeoff" deliverable
// (docs/reference/qbiq/.../Quantity Takeoff - Formal - modern.xlsx). That file
// has 12 sheets, but most are machinery, not content: a 'Plan' image sheet, a
// 'General' materials/settings lookup table, a 'dropdowns' data-validation
// list, and five per-material-category BOM sheets (Floors/Ceilings/Glass
// Partitions/Doors/Walls) that are *pure VLOOKUP* against 'General'. Only three
// sheets carry real takeoff content:
//   - 'Furniture Inventory'          — per-component BOM (9 columns)
//   - 'Furniture Inventory Summary'  — the same, aggregated by item (6 columns)
//   - the wall/glass/door BOM sheets — linear quantities per wall type
//
// We compute every value directly in TypeScript, so the lookup/dropdown/plan
// infrastructure adds nothing, and the five per-category BOM sheets (we model
// walls, glass, doors — not floor/ceiling finishes) collapse into ONE wall
// schedule. So we emit four sheets, matching the task's sanctioned
// {Summary, Furniture BOM, Wall Schedule} consolidation plus the cheap,
// column-identical item summary:
//   1. Main Summary          — grand totals per cost group (mirrors 'Main Summary')
//   2. Furniture Inventory   — per-component BOM, columns verbatim from the sample
//   3. Furniture Inventory Summary — aggregated by item, columns verbatim
//   4. Wall Schedule         — linear meters per wall type + door count/length
//
// Currency is ₹ (INR) per CLAUDE.md; the qbiq sample is generic-currency.
// Item Descriptions carry W×L in cm ("Desk W70 X L140"), matching the sample.
//
// The OOXML byte stream is written by `workbook.ts` (the shared, general
// SpreadsheetML writer) — this file only declares sheets, styles and formulas.

import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../editor/EditorCanvas'
import { pointInZoneShape } from '../util/zoneGeom'
import { catByCategory } from '../editor/catalog'
import { buildXlsx, type Cell, type SheetSpec, type StyleSpec } from './workbook'
import { triggerDownload } from './png'

// ---------------------------------------------------------------------------
// Model (pure — unit-testable without the xlsx layer)
// ---------------------------------------------------------------------------

export interface TakeoffOptions {
  /** product_id -> binding. Same shape as App's `bindings` (extra keys ok);
   *  `supplier`/`brand` feed the Supplier column, `price` the cost columns. */
  bindings?: Map<string, { price: number | null; supplier?: string | null; brand?: string | null }>
  /** Floor label/number shown in the BOM (default 1). */
  floor?: string | number
  /** Project name for docProps. */
  project?: string
  /** Supplier shown when a component has no bound supplier (matches sample). */
  supplierFallback?: string
  /** zone.id → user room reference (from a Space-step room marker sitting in
   *  that zone). When present, the Room ID column shows the human ref (e.g.
   *  "502") instead of the generated zone id. Re-resolved per export against
   *  the current zones (workflow.md §3.2). */
  roomRefs?: Map<number, string>
}

/** One aggregated line in the per-component furniture BOM. */
export interface TakeoffFurnitureRow {
  costCode: string
  floor: string | number
  roomId: string | number
  roomType: string
  itemDescription: string
  supplier: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

/** One line in the item-summary sheet (aggregated across all rooms). */
export interface TakeoffSummaryRow {
  costCode: string
  itemDescription: string
  supplier: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

/** One wall-type line in the linear-quantity wall schedule. */
export interface TakeoffWallRow {
  wallType: string
  unit: 'm' | 'no.'
  quantity: number
  unitPrice: number
  totalPrice: number
}

export interface TakeoffModel {
  furniture: TakeoffFurnitureRow[]
  summary: TakeoffSummaryRow[]
  walls: TakeoffWallRow[]
  totals: {
    furniture: number
    walls: number
    grand: number
    itemCount: number
  }
}

const DEFAULT_SUPPLIER = 'Can be customized'

// zone_type -> the sample's room-type vocabulary.
const ROOM_TYPE: Record<ZoneType, string> = {
  Workspace: 'Open Space WorkStation',
  Meeting: 'Conference',
  Collaboration: 'Comfort Zone',
  ClosedOffice: 'Executive Office',
  Amenity: 'Kitchen',
  Core: 'Other',
  Circulation: 'Open Space',
}

// Short per-category cost code (the sample leaves this "Can be customized";
// a real code is more useful and still overridable downstream).
const COST_CODE: Record<string, string> = {
  Desk: 'FF-DSK',
  Chair: 'FF-CHR',
  Table: 'FF-TBL',
  MeetingRoom: 'FF-MTG',
  FallCeiling: 'CL-FCL',
}
function costCodeFor(category: string): string {
  return COST_CODE[category] ?? `FF-${category.slice(0, 3).toUpperCase()}`
}

// Categories that are NOT loose furniture — routed to the wall schedule, not
// the furniture BOM (doors are placed as components by the generator).
const NON_FURNITURE = new Set(['Door'])

/** Clean display name for a component ("Desk", "Meeting Room", …). */
function itemName(c: DocComponent): string {
  return catByCategory(c.category)?.label ?? c.category
}

/**
 * Item Description with W×L in cm, matching the sample's "Desk W70 X L140"
 * style: W is the shorter side, L the longer — rotation-independent.
 */
function itemDescription(c: DocComponent): string {
  const a = Math.round(Math.min(c.w, c.h) * 100)
  const b = Math.round(Math.max(c.w, c.h) * 100)
  return `${itemName(c)} W${a} X L${b}`
}

function len(w: DocWall): number {
  return Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
}

/** The zone whose rect contains point (px,py) in EDITOR coords, or null.
 *  Exported so the room-marker → zone association (App.tsx) reuses the one
 *  point-in-zone test rather than forking it (no-bloat). */
export function zoneAtPoint(px: number, py: number, zones: DocZone[]): DocZone | null {
  for (const z of zones) {
    if (pointInZoneShape(z.shape, px, py)) return z
  }
  return null
}

/** The zone whose rect contains a component's center, or null (→ catch-all). */
function zoneFor(c: DocComponent, zones: DocZone[]): DocZone | null {
  return zoneAtPoint(c.x, c.y, zones)
}

/** Perimeter (m) of a zone's shape — for costing Core walls. */
function zonePerimeter(z: DocZone): number {
  const s = z.shape
  if (s.kind === 'Rect') return 2 * (s.w + s.h)
  if (s.kind === 'RectRing') return 2 * (s.w + s.h) + 2 * (s.in_w + s.in_h)
  // Poly: sum of edge lengths.
  let per = 0
  for (let i = 0; i < s.pts.length; i++) {
    const [x0, y0] = s.pts[i]
    const [x1, y1] = s.pts[(i + 1) % s.pts.length]
    per += Math.hypot(x1 - x0, y1 - y0)
  }
  return per
}

/**
 * Build the structured takeoff (wall schedule + per-room BOM + item summary +
 * totals) from a document. Pure — no DOM, no xlsx — so it is unit-testable.
 */
export function buildTakeoffModel(state: DocState, opts: TakeoffOptions = {}): TakeoffModel {
  const floor = opts.floor ?? 1
  const supplierFallback = opts.supplierFallback ?? DEFAULT_SUPPLIER
  const bindings = opts.bindings
  const roomRefs = opts.roomRefs
  const zones = state.zones ?? []

  const priceOf = (c: DocComponent): number => {
    if (!c.product_id || !bindings) return 0
    const p = bindings.get(c.product_id)?.price
    return p != null && Number.isFinite(p) ? p : 0
  }

  // Supplier per component: the bound product's real supplier, else its brand,
  // else the sample's fallback. Empty/whitespace values are treated as absent.
  const supplierOf = (c: DocComponent): string => {
    const b = c.product_id ? bindings?.get(c.product_id) : undefined
    const s = b?.supplier?.trim() || b?.brand?.trim()
    return s || supplierFallback
  }

  // --- Furniture BOM: aggregate identical items within a room -------------
  // Key by room + description + supplier + unit price so genuinely identical
  // lines merge (e.g. 10 conference chairs) but differently-priced ones don't.
  const groups = new Map<string, TakeoffFurnitureRow>()
  for (const c of state.components) {
    if (NON_FURNITURE.has(c.category)) continue
    // Passive imported/legacy furniture is reference-only — not part of the
    // specified fit-out you'd buy, so it stays out of the BoQ (matches the
    // cost/CO2 metric filter; laiout-deep-research.md: BoQ = generated only).
    if (c.reference) continue
    const zone = zoneFor(c, zones)
    const roomId = zone ? (roomRefs?.get(zone.id) ?? zone.id) : 'OS'
    const roomType = zone ? ROOM_TYPE[zone.zone_type] : 'Open Space'
    const desc = itemDescription(c)
    const unitPrice = priceOf(c)
    const supplier = supplierOf(c)
    const key = `${roomId}|${desc}|${supplier}|${unitPrice}`
    const existing = groups.get(key)
    if (existing) {
      existing.quantity += 1
      existing.totalPrice = existing.quantity * existing.unitPrice
    } else {
      groups.set(key, {
        costCode: costCodeFor(c.category),
        floor,
        roomId,
        roomType,
        itemDescription: desc,
        supplier,
        quantity: 1,
        unitPrice,
        totalPrice: unitPrice,
      })
    }
  }
  const furniture = [...groups.values()].sort(
    (a, b) =>
      String(a.roomId).localeCompare(String(b.roomId), undefined, { numeric: true }) ||
      a.itemDescription.localeCompare(b.itemDescription),
  )

  // --- Item summary: aggregate across all rooms by description ------------
  const summaryMap = new Map<string, TakeoffSummaryRow>()
  for (const r of furniture) {
    const key = `${r.itemDescription}|${r.supplier}|${r.unitPrice}`
    const s = summaryMap.get(key)
    if (s) {
      s.quantity += r.quantity
      s.totalPrice = s.quantity * s.unitPrice
    } else {
      summaryMap.set(key, {
        costCode: r.costCode,
        itemDescription: r.itemDescription,
        supplier: r.supplier,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        totalPrice: r.totalPrice,
      })
    }
  }
  const summary = [...summaryMap.values()].sort((a, b) =>
    a.itemDescription.localeCompare(b.itemDescription),
  )

  // --- Wall schedule: linear meters per wall type -------------------------
  // Boundary = user/plate wall (not generated). Generated = room partition.
  // glazing splits each into glass vs. solid.
  let perimeterWall = 0
  let perimeterWindows = 0
  let drywall = 0
  let glassPartition = 0
  for (const w of state.walls) {
    const l = len(w)
    const generated = w.generated ?? false
    const glass = w.glazing ?? false
    if (!generated) {
      if (glass) perimeterWindows += l
      else perimeterWall += l
    } else {
      if (glass) glassPartition += l
      else drywall += l
    }
  }
  // Core walls: perimeter of Core zones (WCs/risers/stairs shell).
  let coreWall = 0
  for (const z of zones) if (z.zone_type === 'Core') coreWall += zonePerimeter(z)

  // Doors are placed as components; count + total leaf length.
  const doors = state.components.filter((c) => c.category === 'Door')
  const doorCount = doors.length
  const doorLength = doors.reduce((n, c) => n + Math.max(c.w, c.h), 0)

  const wallRaw: TakeoffWallRow[] = [
    { wallType: 'Perimeter wall', unit: 'm', quantity: perimeterWall, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Perimeter windows', unit: 'm', quantity: perimeterWindows, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Drywall partition', unit: 'm', quantity: drywall, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Glass partition', unit: 'm', quantity: glassPartition, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Core walls', unit: 'm', quantity: coreWall, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Doors', unit: 'no.', quantity: doorCount, unitPrice: 0, totalPrice: 0 },
    { wallType: 'Door length', unit: 'm', quantity: doorLength, unitPrice: 0, totalPrice: 0 },
  ]
  const walls: TakeoffWallRow[] = wallRaw.map((r) => ({
    ...r,
    quantity: round2(r.quantity),
    totalPrice: round2(r.quantity * r.unitPrice),
  }))

  const furnitureTotal = furniture.reduce((n, r) => n + r.totalPrice, 0)
  const wallsTotal = walls.reduce((n, r) => n + r.totalPrice, 0)
  const itemCount = furniture.reduce((n, r) => n + r.quantity, 0)

  return {
    furniture,
    summary,
    walls,
    totals: {
      furniture: round2(furnitureTotal),
      walls: round2(wallsTotal),
      grand: round2(furnitureTotal + wallsTotal),
      itemCount,
    },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// XLSX layer — declarative sheets handed to the shared OOXML writer
// ---------------------------------------------------------------------------

const HEADER: StyleSpec = {
  font: { bold: true, size: 10, color: '#FFFFFF' },
  fill: '#0B67F9',
  align: { h: 'center', v: 'center', wrap: true },
  border: { all: 'thin' },
}
const TITLE: StyleSpec = { font: { bold: true, size: 14 } }
const RUPEE: StyleSpec = { numFmt: '"\u20B9"#,##0' }
const TOTAL: StyleSpec = { font: { bold: true }, border: { top: 'thin' } }
const TOTAL_RUPEE: StyleSpec = { ...TOTAL, numFmt: '"\u20B9"#,##0' }

const money = (v: number, isTotal = false): Cell => ({ v, style: isTotal ? TOTAL_RUPEE : RUPEE })
const head = (labels: string[]): Cell[] => labels.map((v) => ({ v, style: HEADER }))
const bold = (v: number | string): Cell => ({ v, style: TOTAL })

/** Assemble the four sheets from a takeoff model. */
function planSheets(model: TakeoffModel, opts: TakeoffOptions): SheetSpec[] {
  const project = opts.project ?? 'DSource Test-Fit'
  const t = model.totals

  // 1. Main Summary --------------------------------------------------------
  const mainSummary: SheetSpec = {
    name: 'Main Summary',
    gridlines: false,
    cols: { A: 28, B: 18 },
    rows: [
      [{ v: `Quantity Takeoff \u2014 ${project}`, style: TITLE }],
      head(['Cost group', 'Total (\u20B9)']),
      ['Furniture', money(t.furniture)],
      ['Walls, glazing & doors', money(t.walls)],
      [bold('Grand total'), money(t.grand, true)],
      [],
      ['Furniture line items', model.summary.length],
      ['Furniture units', t.itemCount],
    ],
  }

  // 2. Furniture Inventory (per-component BOM) -----------------------------
  const furnitureInventory: SheetSpec = {
    name: 'Furniture Inventory',
    gridlines: false,
    freeze: 'A2',
    cols: { A: 11, B: 7, C: 9, D: 22, E: 26, F: 18, G: 10, H: 13, I: 14 },
    rows: [
      head([
        'Cost Code',
        'Floor',
        'Room ID',
        'Room Type',
        'Item Description',
        'Supplier',
        'Quantity',
        'Unit Price',
        'Total Price',
      ]),
      ...model.furniture.map((r, i): Cell[] => [
        r.costCode,
        r.floor,
        r.roomId,
        r.roomType,
        r.itemDescription,
        r.supplier,
        r.quantity,
        money(r.unitPrice),
        // Live formula, so an edited unit price re-totals in the client's hands.
        { f: `H${i + 2}*G${i + 2}`, v: r.totalPrice, style: RUPEE },
      ]),
      [bold('Total'), null, null, null, null, null, bold(t.itemCount), null, money(t.furniture, true)],
    ],
  }

  // 3. Furniture Inventory Summary (aggregated by item) --------------------
  const furnitureSummary: SheetSpec = {
    name: 'Furniture Inventory Summary',
    gridlines: false,
    freeze: 'A2',
    cols: { A: 11, B: 26, C: 18, D: 10, E: 13, F: 14 },
    rows: [
      head(['Cost Code', 'Item Description', 'Supplier', 'Quantity', 'Unit Price', 'Total Price']),
      ...model.summary.map((r, i): Cell[] => [
        r.costCode,
        r.itemDescription,
        r.supplier,
        r.quantity,
        money(r.unitPrice),
        { f: `E${i + 2}*D${i + 2}`, v: r.totalPrice, style: RUPEE },
      ]),
      [bold('Total'), null, null, bold(t.itemCount), null, money(t.furniture, true)],
    ],
  }

  // 4. Wall Schedule (linear quantities) -----------------------------------
  const wallSchedule: SheetSpec = {
    name: 'Wall Schedule',
    gridlines: false,
    freeze: 'A2',
    cols: { A: 22, B: 8, C: 12, D: 13, E: 14 },
    rows: [
      head(['Wall Type', 'Unit', 'Quantity', 'Unit Price', 'Total Cost']),
      ...model.walls.map((r, i): Cell[] => [
        r.wallType,
        r.unit,
        { v: r.quantity, style: { numFmt: '0.00' } },
        money(r.unitPrice),
        { f: `D${i + 2}*C${i + 2}`, v: r.totalPrice, style: RUPEE },
      ]),
      [bold('Total'), null, null, null, money(t.walls, true)],
    ],
  }

  return [mainSummary, furnitureInventory, furnitureSummary, wallSchedule]
}

/** Build the full .xlsx byte stream from a takeoff model. */
export function takeoffToXlsx(model: TakeoffModel, opts: TakeoffOptions = {}): Uint8Array {
  return buildXlsx(planSheets(model, opts))
}

/** Build the takeoff workbook and trigger a browser download. */
export function exportQuantityTakeoff(
  state: DocState,
  opts: TakeoffOptions = {},
  filename = 'dsource-takeoff.xlsx',
): void {
  const model = buildTakeoffModel(state, opts)
  const bytes = takeoffToXlsx(model, opts)
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  triggerDownload(blob, filename)
}
