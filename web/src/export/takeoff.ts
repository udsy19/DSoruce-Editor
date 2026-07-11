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
//   3. Furniture Summary     — aggregated by item, columns verbatim from the sample
//   4. Wall Schedule         — linear meters per wall type + door count/length
//
// Currency is ₹ (INR) per CLAUDE.md; the qbiq sample is generic-currency.
// Item Descriptions carry W×L in cm ("Desk W70 X L140"), matching the sample.

import type { DocState, DocComponent, DocWall, DocZone, ZoneType } from '../editor/EditorCanvas'
import { catByCategory } from '../editor/catalog'
import { zipStore } from './zip'
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

function pointInRect(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x - w / 2 && px <= x + w / 2 && py >= y - h / 2 && py <= y + h / 2
}

/** The zone whose rect contains point (px,py) in EDITOR coords, or null.
 *  Exported so the room-marker → zone association (App.tsx) reuses the one
 *  point-in-zone test rather than forking it (no-bloat). */
export function zoneAtPoint(px: number, py: number, zones: DocZone[]): DocZone | null {
  for (const z of zones) {
    const s = z.shape
    if (s.kind === 'Rect') {
      if (pointInRect(px, py, s.x, s.y, s.w, s.h)) return z
    } else {
      // RectRing: inside the outer rect but outside the inner hole.
      const inOuter = pointInRect(px, py, s.x, s.y, s.w, s.h)
      const inHole = pointInRect(px, py, s.x, s.y, s.in_w, s.in_h)
      if (inOuter && !inHole) return z
    }
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
  return 2 * (s.w + s.h) + 2 * (s.in_w + s.in_h)
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
// XLSX layer (hand-written OOXML, zipped by zip.ts)
// ---------------------------------------------------------------------------

const XML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => XML_ESC[ch])
}

type Cell = { t: 'n'; v: number } | { t: 's'; v: string } | null

/** A cell holding text (inlineStr) or a number, with an optional style index. */
function cellXml(col: string, row: number, cell: Cell, style?: number): string {
  if (cell == null) return ''
  const s = style != null ? ` s="${style}"` : ''
  if (cell.t === 'n') {
    return `<c r="${col}${row}"${s}><v>${cell.v}</v></c>`
  }
  return `<c r="${col}${row}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`
}

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** Build one worksheet XML from a matrix of cells. Style indices (styles.xml):
 *  0 default, 1 bold header, 2 title (bold large), 3 currency (₹). */
function sheetXml(rows: Cell[][], styleFor: (r: number, c: number) => number | undefined): string {
  const body = rows
    .map((cells, ri) => {
      const rowNum = ri + 1
      const cellsXml = cells
        .map((cell, ci) => cellXml(COL_LETTERS[ci], rowNum, cell, styleFor(ri, ci)))
        .join('')
      return `<row r="${rowNum}">${cellsXml}</row>`
    })
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  )
}

const num = (v: number): Cell => ({ t: 'n', v })
const str = (v: string): Cell => ({ t: 's', v })

interface SheetPlan {
  name: string
  rows: Cell[][]
  /** Rows (0-based) that are the bold header band. */
  headerRows: Set<number>
  /** Column indices (0-based) that are ₹ currency. */
  currencyCols: Set<number>
  /** Title rows (0-based) — bold, larger. */
  titleRows: Set<number>
}

/** Assemble the four sheet plans from a takeoff model. */
function planSheets(model: TakeoffModel, opts: TakeoffOptions): SheetPlan[] {
  const project = opts.project ?? 'DSource Test-Fit'
  const t = model.totals

  // 1. Main Summary --------------------------------------------------------
  const summaryRows: Cell[][] = [
    [str(`Quantity Takeoff — ${project}`)],
    [str('Cost group'), str('Total (₹)')],
    [str('Furniture'), num(t.furniture)],
    [str('Walls, glazing & doors'), num(t.walls)],
    [str('Grand total'), num(t.grand)],
    [],
    [str('Furniture line items'), num(model.summary.length)],
    [str('Furniture units'), num(t.itemCount)],
  ]
  const mainSummary: SheetPlan = {
    name: 'Main Summary',
    rows: summaryRows,
    headerRows: new Set([1]),
    currencyCols: new Set([1]),
    titleRows: new Set([0]),
  }

  // 2. Furniture Inventory (per-component BOM) -----------------------------
  const fHeader = [
    'Cost Code',
    'Floor',
    'Room ID',
    'Room Type',
    'Item Description',
    'Supplier',
    'Quantity',
    'Unit Price',
    'Total Price',
  ]
  const furnitureRows: Cell[][] = [
    fHeader.map(str),
    ...model.furniture.map((r) => [
      str(r.costCode),
      typeof r.floor === 'number' ? num(r.floor) : str(String(r.floor)),
      typeof r.roomId === 'number' ? num(r.roomId) : str(String(r.roomId)),
      str(r.roomType),
      str(r.itemDescription),
      str(r.supplier),
      num(r.quantity),
      num(r.unitPrice),
      num(r.totalPrice),
    ]),
    [str('Total'), null, null, null, null, null, num(t.itemCount), null, num(t.furniture)],
  ]
  const furnitureInventory: SheetPlan = {
    name: 'Furniture Inventory',
    rows: furnitureRows,
    headerRows: new Set([0]),
    currencyCols: new Set([7, 8]),
    titleRows: new Set(),
  }

  // 3. Furniture Inventory Summary (aggregated by item) --------------------
  const sHeader = ['Cost Code', 'Item Description', 'Supplier', 'Quantity', 'Unit Price', 'Total Price']
  const summaryBom: Cell[][] = [
    sHeader.map(str),
    ...model.summary.map((r) => [
      str(r.costCode),
      str(r.itemDescription),
      str(r.supplier),
      num(r.quantity),
      num(r.unitPrice),
      num(r.totalPrice),
    ]),
    [str('Total'), null, null, num(t.itemCount), null, num(t.furniture)],
  ]
  const furnitureSummary: SheetPlan = {
    name: 'Furniture Summary',
    rows: summaryBom,
    headerRows: new Set([0]),
    currencyCols: new Set([4, 5]),
    titleRows: new Set(),
  }

  // 4. Wall Schedule (linear quantities) -----------------------------------
  const wHeader = ['Wall Type', 'Unit', 'Quantity', 'Unit Price', 'Total Cost']
  const wallRows: Cell[][] = [
    wHeader.map(str),
    ...model.walls.map((r) => [
      str(r.wallType),
      str(r.unit),
      num(r.quantity),
      num(r.unitPrice),
      num(r.totalPrice),
    ]),
    [str('Total'), null, null, null, num(t.walls)],
  ]
  const wallSchedule: SheetPlan = {
    name: 'Wall Schedule',
    rows: wallRows,
    headerRows: new Set([0]),
    currencyCols: new Set([3, 4]),
    titleRows: new Set(),
  }

  return [mainSummary, furnitureInventory, furnitureSummary, wallSchedule]
}

// styles.xml: fonts[0]=normal, [1]=bold, [2]=bold 14pt; numFmt 164 = ₹ integer;
// cellXfs: 0 default, 1 bold header, 2 title, 3 ₹ currency.
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0"/></numFmts>' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="14"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

/** Build the full .xlsx byte stream from a takeoff model. */
export function takeoffToXlsx(model: TakeoffModel, opts: TakeoffOptions = {}): Uint8Array {
  const plans = planSheets(model, opts)
  const enc = new TextEncoder()

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    plans
      .map(
        (_p, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>'

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    plans
      .map((p, i) => `<sheet name="${esc(p.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>'

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    plans
      .map(
        (_p, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${plans.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'

  const files = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
    ...plans.map((p, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(
        sheetXml(p.rows, (r, c) => {
          if (p.titleRows.has(r)) return 2
          if (p.headerRows.has(r)) return 1
          // Currency style only on numeric cells in currency columns.
          const cell = p.rows[r]?.[c]
          if (cell && cell.t === 'n' && p.currencyCols.has(c)) return 3
          return undefined
        }),
      ),
    })),
  ]
  return zipStore(files)
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
