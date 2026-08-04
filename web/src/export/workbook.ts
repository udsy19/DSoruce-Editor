// Hand-written OOXML (.xlsx) workbook writer.
//
// The repo hand-writes every exporter's byte stream rather than pulling a heavy
// dependency (see zip.ts / dxf.ts / ifc.ts / obj.ts), and the export path must
// stay 100% client-side — one user action, no server round-trip. This module is
// the general form of the writer that `takeoff.ts` used to inline: it emits a
// full SpreadsheetML package with everything the qbiq-parity workbook needs.
//
//   * `<f>` formulas (incl. cross-sheet refs), with `fullCalcOnLoad` so every
//     reader recomputes on open instead of showing a stale cached value
//   * a drawing layer — `xl/media/*` + `xl/drawings/drawing{n}.xml` + rels —
//     supporting twoCellAnchor and oneCellAnchor with EMU offsets
//   * `showGridLines="0"` per sheet
//   * column widths / row heights
//   * merged cells
//   * list data validations (inline "a,b,c" lists or a cross-sheet range)
//   * real styles: solid ARGB fills, fonts, borders, alignment, number formats
//
// Everything is declarative: build `SheetSpec[]`, call `buildXlsx`. Styles and
// media are de-duplicated automatically, so a legend chip colour used 200 times
// costs one `<xf>` and a logo repeated on 11 sheets costs one media part.

import { zipStore, crc32 } from './zip'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** `#RRGGBB`, `RRGGBB` or `AARRGGBB` — normalised to 8-digit ARGB internally. */
export type Color = string

export interface FontSpec {
  name?: string
  /** Points. */
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: Color
}

export type BorderStyle =
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double'
  | 'hair'
  | 'none'

export type BorderEdge = BorderStyle | { style: BorderStyle; color?: Color }

export interface BorderSpec {
  /** Shorthand: apply the same edge to all four sides. */
  all?: BorderEdge
  left?: BorderEdge
  right?: BorderEdge
  top?: BorderEdge
  bottom?: BorderEdge
}

export interface AlignSpec {
  h?: 'left' | 'center' | 'right' | 'justify' | 'fill' | 'general'
  v?: 'top' | 'center' | 'bottom' | 'justify'
  wrap?: boolean
  indent?: number
  /** Degrees, 0–180 (90 = text reading bottom-to-top). */
  rotation?: number
}

export interface StyleSpec {
  font?: FontSpec
  /** Solid fill colour. Emitted as `<fgColor rgb="FFxxxxxx"/>` — no palette indirection. */
  fill?: Color
  /** Number-format code, e.g. `'0.00'`, `'@'`, `'"₹"#,##0'`. */
  numFmt?: string
  border?: BorderSpec
  align?: AlignSpec
}

/** A cell: a bare value, or an object carrying a formula and/or a style. */
export interface CellSpec {
  /** Literal value. For a formula cell this is the *cached* result (optional). */
  v?: number | string | boolean | null
  /** Formula text, with or without the leading `=`. Takes precedence over `v`. */
  f?: string
  style?: StyleSpec
}

export type Cell = number | string | null | undefined | CellSpec

export interface AnchorPoint {
  /** 0-based column index (B == 1). */
  col: number
  /** 0-based row index (row 5 == 4). */
  row: number
  /** EMU offset inside the cell (1 px @96dpi == 9525 EMU). */
  colOff?: number
  rowOff?: number
}

export interface SheetImage {
  data: Uint8Array
  format: 'png' | 'jpeg' | 'gif'
  from: AnchorPoint
  /** Present → twoCellAnchor (the image spans from→to). */
  to?: AnchorPoint
  /** Used when `to` is absent → oneCellAnchor with this explicit EMU extent. */
  ext?: { cx: number; cy: number }
  /** twoCellAnchor sizing behaviour. Default `'oneCell'` (move, don't size). */
  editAs?: 'oneCell' | 'twoCell' | 'absolute'
  /** Shape name in the drawing (cosmetic). */
  name?: string
}

export interface DataValidationSpec {
  type: 'list' | 'whole' | 'decimal' | 'date' | 'time' | 'textLength' | 'custom'
  /** For `list`: an inline list `'"cm,m,f,inch"'` **or** a range `'dropdowns!$A$1:$A$9'`. */
  formula1: string
  formula2?: string
  operator?: 'between' | 'notBetween' | 'equal' | 'greaterThan' | 'lessThan'
  /** Space-separated A1 ranges, or an array of them: `['M9:M12', 'K3']`. */
  sqref: string | string[]
  allowBlank?: boolean
  /** Default true (shows the in-cell dropdown arrow). */
  showDropDown?: boolean
  errorTitle?: string
  error?: string
  promptTitle?: string
  prompt?: string
}

export interface ColSpec {
  width: number
  hidden?: boolean
}

export interface SheetSpec {
  name: string
  /** Dense, row-major. `rows[0]` is row 1, `rows[0][0]` is A1. */
  rows?: Cell[][]
  /** Sparse overlay keyed by A1 address — merged over `rows` (wins on conflict). */
  cells?: Record<string, Cell>
  /** Column letter → width (Excel character units) / hidden flag. */
  cols?: Record<string, number | ColSpec>
  /** 1-based row number → height in points. */
  rowHeights?: Record<number, number>
  /** `['Q4:R4', 'B2:D2']`. */
  merges?: string[]
  /** Default true. `false` emits `<sheetView showGridLines="0"/>`. */
  gridlines?: boolean
  /** Default true. */
  showRowColHeaders?: boolean
  /** Freeze panes at this cell, e.g. `'A5'` (everything above/left is frozen). */
  freeze?: string
  images?: SheetImage[]
  validations?: DataValidationSpec[]
  /** Default row height in points (`<sheetFormatPr>`). */
  defaultRowHeight?: number
}

export interface WorkbookOptions {
  /** Force every reader to recalculate on open. Default true. */
  fullCalcOnLoad?: boolean
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const XML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/** XML-escape text, and drop control characters SpreadsheetML forbids. */
export function esc(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (ch) => XML_ESC[ch])
}

/** 1-based column number → letters (1 → 'A', 27 → 'AA'). */
export function colName(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

/** Letters → 1-based column number ('A' → 1, 'AA' → 27). */
export function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** Pixels at 96 dpi → EMU (English Metric Units). */
export function pxToEmu(px: number): number {
  return Math.round(px * 9525)
}

/** Points → EMU. */
export function ptToEmu(pt: number): number {
  return Math.round(pt * 12700)
}

/** `#0B67F9` / `0B67F9` / `FF0B67F9` → `FF0B67F9`. */
function argb(c: Color): string {
  let h = c.trim().replace(/^#/, '').toUpperCase()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length === 6) h = 'FF' + h
  if (!/^[0-9A-F]{8}$/.test(h)) throw new Error(`workbook: bad colour ${JSON.stringify(c)}`)
  return h
}

const A1 = /^([A-Za-z]+)(\d+)$/
function parseA1(ref: string): { col: number; row: number } {
  const m = A1.exec(ref.trim())
  if (!m) throw new Error(`workbook: bad cell reference ${JSON.stringify(ref)}`)
  return { col: colIndex(m[1]), row: parseInt(m[2], 10) }
}

/** Excel sheet names: ≤31 chars, none of []:*?/\ — trimmed rather than thrown on. */
function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31) || 'Sheet'
}

// ---------------------------------------------------------------------------
// Style table — dedupes fonts/fills/borders/numFmts into cellXfs indices
// ---------------------------------------------------------------------------

class StyleTable {
  // Index 0 of each table is the OOXML-mandated default.
  private fonts = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>']
  // Fills 0 and 1 are reserved by the format (none, gray125) — Excel requires it.
  private fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ]
  private borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>']
  private numFmts: { id: number; code: string }[] = []
  private xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']

  private fontIdx = new Map<string, number>()
  private fillIdx = new Map<string, number>()
  private borderIdx = new Map<string, number>()
  private numFmtIdx = new Map<string, number>()
  private xfIdx = new Map<string, number>()

  /** Style spec → cellXfs index (0 for undefined/empty). */
  id(style: StyleSpec | undefined): number {
    if (!style) return 0
    const key = JSON.stringify([style.font, style.fill, style.numFmt, style.border, style.align])
    const hit = this.xfIdx.get(key)
    if (hit != null) return hit

    const fontId = style.font ? this.font(style.font) : 0
    const fillId = style.fill ? this.fill(style.fill) : 0
    const borderId = style.border ? this.border(style.border) : 0
    const numFmtId = style.numFmt ? this.numFmt(style.numFmt) : 0

    let xf =
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
      (numFmtId ? ' applyNumberFormat="1"' : '') +
      (fontId ? ' applyFont="1"' : '') +
      (fillId ? ' applyFill="1"' : '') +
      (borderId ? ' applyBorder="1"' : '') +
      (style.align ? ' applyAlignment="1"' : '')
    if (style.align) {
      const a = style.align
      const attrs =
        (a.h ? ` horizontal="${a.h}"` : '') +
        (a.v ? ` vertical="${a.v}"` : '') +
        (a.wrap ? ' wrapText="1"' : '') +
        (a.indent ? ` indent="${a.indent}"` : '') +
        (a.rotation ? ` textRotation="${a.rotation}"` : '')
      xf += `><alignment${attrs}/></xf>`
    } else {
      xf += '/>'
    }

    const idx = this.xfs.length
    this.xfs.push(xf)
    this.xfIdx.set(key, idx)
    return idx
  }

  private font(f: FontSpec): number {
    const key = JSON.stringify(f)
    const hit = this.fontIdx.get(key)
    if (hit != null) return hit
    const xml =
      '<font>' +
      (f.bold ? '<b/>' : '') +
      (f.italic ? '<i/>' : '') +
      (f.underline ? '<u/>' : '') +
      `<sz val="${f.size ?? 11}"/>` +
      (f.color ? `<color rgb="${argb(f.color)}"/>` : '<color theme="1"/>') +
      `<name val="${esc(f.name ?? 'Calibri')}"/><family val="2"/>` +
      '</font>'
    const idx = this.fonts.length
    this.fonts.push(xml)
    this.fontIdx.set(key, idx)
    return idx
  }

  private fill(c: Color): number {
    const rgb = argb(c)
    const hit = this.fillIdx.get(rgb)
    if (hit != null) return hit
    // bgColor indexed="64" is the "automatic" background Excel writes for solids.
    const xml = `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`
    const idx = this.fills.length
    this.fills.push(xml)
    this.fillIdx.set(rgb, idx)
    return idx
  }

  private border(b: BorderSpec): number {
    const key = JSON.stringify(b)
    const hit = this.borderIdx.get(key)
    if (hit != null) return hit
    const edge = (tag: string, e: BorderEdge | undefined): string => {
      const spec = e ?? b.all
      if (!spec) return `<${tag}/>`
      const style = typeof spec === 'string' ? spec : spec.style
      const color = typeof spec === 'string' ? undefined : spec.color
      if (style === 'none') return `<${tag}/>`
      return `<${tag} style="${style}">${color ? `<color rgb="${argb(color)}"/>` : '<color indexed="64"/>'}</${tag}>`
    }
    const xml =
      '<border>' +
      edge('left', b.left) +
      edge('right', b.right) +
      edge('top', b.top) +
      edge('bottom', b.bottom) +
      '<diagonal/></border>'
    const idx = this.borders.length
    this.borders.push(xml)
    this.borderIdx.set(key, idx)
    return idx
  }

  private numFmt(code: string): number {
    const hit = this.numFmtIdx.get(code)
    if (hit != null) return hit
    const id = 164 + this.numFmts.length // 0–163 are reserved/builtin
    this.numFmts.push({ id, code })
    this.numFmtIdx.set(code, id)
    return id
  }

  xml(): string {
    const nf = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">` +
        this.numFmts.map((n) => `<numFmt numFmtId="${n.id}" formatCode="${esc(n.code)}"/>`).join('') +
        '</numFmts>'
      : ''
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      nf +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/>' +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
    )
  }
}

// ---------------------------------------------------------------------------
// Media table — one part per distinct image, however many sheets embed it
// ---------------------------------------------------------------------------

interface MediaEntry {
  name: string // 'image1.png'
  ext: string // 'png'
  data: Uint8Array
}

class MediaTable {
  readonly entries: MediaEntry[] = []
  private byKey = new Map<string, MediaEntry[]>()

  /** Register bytes, returning the shared media part name. */
  add(data: Uint8Array, format: SheetImage['format']): string {
    const ext = format === 'jpeg' ? 'jpeg' : format
    const key = `${ext}:${data.length}:${crc32(data)}`
    const bucket = this.byKey.get(key)
    if (bucket) {
      for (const e of bucket) if (sameBytes(e.data, data)) return e.name
    }
    const entry: MediaEntry = { name: `image${this.entries.length + 1}.${ext}`, ext, data }
    this.entries.push(entry)
    if (bucket) bucket.push(entry)
    else this.byKey.set(key, [entry])
    return entry.name
  }

  extensions(): string[] {
    return [...new Set(this.entries.map((e) => e.ext))]
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// Worksheet XML
// ---------------------------------------------------------------------------

function normCell(c: Cell): CellSpec | null {
  if (c == null) return null
  if (typeof c === 'number') return { v: c }
  if (typeof c === 'string') return c === '' ? null : { v: c }
  if (c.f == null && (c.v == null || c.v === '') && !c.style) return null
  return c
}

function cellXml(ref: string, c: CellSpec, styleId: number): string {
  const s = styleId ? ` s="${styleId}"` : ''
  if (c.f != null) {
    const f = c.f.replace(/^=/, '')
    // A cached <v> is optional; `fullCalcOnLoad` makes every reader recompute.
    let cached = ''
    let t = ''
    if (typeof c.v === 'number' && Number.isFinite(c.v)) cached = `<v>${c.v}</v>`
    else if (typeof c.v === 'string') {
      t = ' t="str"'
      cached = `<v>${esc(c.v)}</v>`
    }
    return `<c r="${ref}"${s}${t}><f>${esc(f)}</f>${cached}</c>`
  }
  const v = c.v
  if (typeof v === 'number') {
    return Number.isFinite(v) ? `<c r="${ref}"${s}><v>${v}</v></c>` : `<c r="${ref}"${s}/>`
  }
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`
  if (typeof v === 'string') {
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`
  }
  return `<c r="${ref}"${s}/>`
}

function sqrefOf(dv: DataValidationSpec): string {
  return Array.isArray(dv.sqref) ? dv.sqref.join(' ') : dv.sqref
}

function worksheetXml(s: SheetSpec, sty: StyleTable, drawingRelId: string | null): string {
  // --- collect cells: dense rows first, sparse `cells` overlay wins ---------
  const grid = new Map<number, Map<number, CellSpec>>()
  const put = (row: number, col: number, c: CellSpec | null) => {
    if (!c) return
    let r = grid.get(row)
    if (!r) grid.set(row, (r = new Map()))
    r.set(col, c)
  }
  if (s.rows) {
    for (let ri = 0; ri < s.rows.length; ri++) {
      const row = s.rows[ri]
      if (!row) continue
      for (let ci = 0; ci < row.length; ci++) put(ri + 1, ci + 1, normCell(row[ci]))
    }
  }
  if (s.cells) {
    for (const [ref, c] of Object.entries(s.cells)) {
      const { col, row } = parseA1(ref)
      put(row, col, normCell(c))
    }
  }

  // --- dimension ------------------------------------------------------------
  let minC = Infinity
  let maxC = 0
  let minR = Infinity
  let maxR = 0
  for (const [r, cols] of grid) {
    if (!cols.size) continue
    minR = Math.min(minR, r)
    maxR = Math.max(maxR, r)
    for (const c of cols.keys()) {
      minC = Math.min(minC, c)
      maxC = Math.max(maxC, c)
    }
  }
  const dimension =
    maxR > 0
      ? `<dimension ref="${colName(minC)}${minR}:${colName(maxC)}${maxR}"/>`
      : '<dimension ref="A1"/>'

  // --- sheetViews -----------------------------------------------------------
  const viewAttrs =
    (s.gridlines === false ? ' showGridLines="0"' : '') +
    (s.showRowColHeaders === false ? ' showRowColHeaders="0"' : '') +
    ' workbookViewId="0"'
  let pane = ''
  if (s.freeze) {
    const { col, row } = parseA1(s.freeze)
    const xSplit = col - 1
    const ySplit = row - 1
    if (xSplit > 0 || ySplit > 0) {
      const active = ySplit > 0 ? (xSplit > 0 ? 'bottomRight' : 'bottomLeft') : 'topRight'
      pane =
        `<pane${xSplit > 0 ? ` xSplit="${xSplit}"` : ''}${ySplit > 0 ? ` ySplit="${ySplit}"` : ''}` +
        ` topLeftCell="${s.freeze}" activePane="${active}" state="frozen"/>`
    }
  }
  const sheetViews = `<sheetViews><sheetView${viewAttrs}>${pane}</sheetView></sheetViews>`

  // --- sheetFormatPr / cols -------------------------------------------------
  const sheetFormatPr = `<sheetFormatPr defaultRowHeight="${s.defaultRowHeight ?? 15}"${
    s.defaultRowHeight ? ' customHeight="1"' : ''
  }/>`
  let cols = ''
  if (s.cols && Object.keys(s.cols).length) {
    // One <col> per letter so openpyxl's per-letter column_dimensions lookup works.
    const items = Object.entries(s.cols)
      .map(([letter, spec]) => {
        const n = colIndex(letter)
        const cs: ColSpec = typeof spec === 'number' ? { width: spec } : spec
        return { n, ...cs }
      })
      .sort((a, b) => a.n - b.n)
    cols =
      '<cols>' +
      items
        .map(
          (c) =>
            `<col min="${c.n}" max="${c.n}" width="${c.width}" customWidth="1"${
              c.hidden ? ' hidden="1"' : ''
            }/>`,
        )
        .join('') +
      '</cols>'
  }

  // --- sheetData ------------------------------------------------------------
  const heights = s.rowHeights ?? {}
  const rowNums = new Set<number>([...grid.keys(), ...Object.keys(heights).map(Number)])
  const body = [...rowNums]
    .sort((a, b) => a - b)
    .map((rn) => {
      const h = heights[rn]
      const attrs = h != null ? ` ht="${h}" customHeight="1"` : ''
      const cols2 = grid.get(rn)
      const cellsXml = cols2
        ? [...cols2.keys()]
            .sort((a, b) => a - b)
            .map((cn) => {
              const c = cols2.get(cn)!
              return cellXml(`${colName(cn)}${rn}`, c, sty.id(c.style))
            })
            .join('')
        : ''
      return `<row r="${rn}"${attrs}>${cellsXml}</row>`
    })
    .join('')

  // --- merges / validations / drawing --------------------------------------
  const merges = s.merges?.length
    ? `<mergeCells count="${s.merges.length}">` +
      s.merges.map((m) => `<mergeCell ref="${esc(m)}"/>`).join('') +
      '</mergeCells>'
    : ''

  const validations = s.validations?.length
    ? `<dataValidations count="${s.validations.length}">` +
      s.validations
        .map((dv) => {
          // NOTE the OOXML inversion: showDropDown="1" HIDES the in-cell arrow.
          // The API's `showDropDown` reads the sane way; default (true) omits it.
          const attrs =
            `type="${dv.type}"` +
            (dv.operator ? ` operator="${dv.operator}"` : '') +
            (dv.allowBlank ? ' allowBlank="1"' : '') +
            (dv.showDropDown === false ? ' showDropDown="1"' : '') +
            (dv.errorTitle ? ` errorTitle="${esc(dv.errorTitle)}" showErrorMessage="1"` : '') +
            (dv.error ? ` error="${esc(dv.error)}"` : '') +
            (dv.promptTitle ? ` promptTitle="${esc(dv.promptTitle)}" showInputMessage="1"` : '') +
            (dv.prompt ? ` prompt="${esc(dv.prompt)}"` : '') +
            ` sqref="${esc(sqrefOf(dv))}"`
          return (
            `<dataValidation ${attrs}>` +
            `<formula1>${esc(dv.formula1)}</formula1>` +
            (dv.formula2 ? `<formula2>${esc(dv.formula2)}</formula2>` : '') +
            '</dataValidation>'
          )
        })
        .join('') +
      '</dataValidations>'
    : ''

  const drawing = drawingRelId ? `<drawing r:id="${drawingRelId}"/>` : ''

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    dimension +
    sheetViews +
    sheetFormatPr +
    cols +
    `<sheetData>${body}</sheetData>` +
    // Schema order is strict: mergeCells → dataValidations → pageMargins → drawing.
    merges +
    validations +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    drawing +
    '</worksheet>'
  )
}

// ---------------------------------------------------------------------------
// Drawing XML
// ---------------------------------------------------------------------------

function anchorPtXml(tag: 'from' | 'to', p: AnchorPoint): string {
  return (
    `<xdr:${tag}><xdr:col>${p.col}</xdr:col><xdr:colOff>${Math.round(p.colOff ?? 0)}</xdr:colOff>` +
    `<xdr:row>${p.row}</xdr:row><xdr:rowOff>${Math.round(p.rowOff ?? 0)}</xdr:rowOff></xdr:${tag}>`
  )
}

function picXml(id: number, name: string, relId: string, cx: number, cy: number): string {
  return (
    '<xdr:pic>' +
    `<xdr:nvPicPr><xdr:cNvPr id="${id}" name="${esc(name)}"/>` +
    '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    `<xdr:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
    '</xdr:pic>'
  )
}

/** Drawing part XML + the media names it references, in rel order. */
function drawingXml(images: SheetImage[], media: MediaTable): { xml: string; rels: string[] } {
  const rels: string[] = []
  const anchors = images.map((img, i) => {
    const mediaName = media.add(img.data, img.format)
    rels.push(mediaName)
    const relId = `rId${i + 1}`
    const id = i + 2 // 1 is conventionally the sheet itself
    const name = img.name ?? `Picture ${i + 1}`

    if (img.to) {
      // Extent is informational for a twoCellAnchor (the anchors drive the box),
      // but Excel still reads it — derive it from the anchor span where we can.
      const cx = img.ext?.cx ?? Math.max(0, (img.to.colOff ?? 0) - (img.from.colOff ?? 0))
      const cy = img.ext?.cy ?? Math.max(0, (img.to.rowOff ?? 0) - (img.from.rowOff ?? 0))
      return (
        `<xdr:twoCellAnchor editAs="${img.editAs ?? 'oneCell'}">` +
        anchorPtXml('from', img.from) +
        anchorPtXml('to', img.to) +
        picXml(id, name, relId, cx, cy) +
        '<xdr:clientData/></xdr:twoCellAnchor>'
      )
    }
    const ext = img.ext ?? { cx: 0, cy: 0 }
    return (
      '<xdr:oneCellAnchor>' +
      anchorPtXml('from', img.from) +
      `<xdr:ext cx="${Math.round(ext.cx)}" cy="${Math.round(ext.cy)}"/>` +
      picXml(id, name, relId, ext.cx, ext.cy) +
      '<xdr:clientData/></xdr:oneCellAnchor>'
    )
  })

  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    anchors.join('') +
    '</xdr:wsDr>'
  return { xml, rels }
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = {
  sheet:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  workbook:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
}

function relsXml(items: { id: string; type: string; target: string }[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items
      .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`)
      .join('') +
    '</Relationships>'
  )
}

/**
 * Build a complete .xlsx byte stream. Sheet order is array order; sheet names
 * are sanitised (≤31 chars, no `[]:*?/\`) and must be unique.
 */
export function buildXlsx(sheets: SheetSpec[], opts: WorkbookOptions = {}): Uint8Array {
  if (!sheets.length) throw new Error('workbook: at least one sheet is required')
  const enc = new TextEncoder()
  const sty = new StyleTable()
  const media = new MediaTable()

  // Drawing parts, numbered over the sheets that actually carry images.
  const drawings: { part: number; xml: string; rels: string[] }[] = []
  const drawingOfSheet = new Map<number, number>() // sheet index → drawing part number
  for (let i = 0; i < sheets.length; i++) {
    const imgs = sheets[i].images
    if (!imgs?.length) continue
    const part = drawings.length + 1
    const { xml, rels } = drawingXml(imgs, media)
    drawings.push({ part, xml, rels })
    drawingOfSheet.set(i, part)
  }

  const sheetXmls = sheets.map((s, i) =>
    worksheetXml(s, sty, drawingOfSheet.has(i) ? 'rId1' : null),
  )

  const names = new Set<string>()
  const sheetNames = sheets.map((s) => {
    let n = safeSheetName(s.name)
    if (names.has(n)) {
      let k = 2
      while (names.has(`${n.slice(0, 28)} ${k}`)) k++
      n = `${n.slice(0, 28)} ${k}`
    }
    names.add(n)
    return n
  })

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    media
      .extensions()
      .map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpeg' ? 'jpeg' : e}"/>`)
      .join('') +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT.workbook}"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${CT.styles}"/>` +
    sheets
      .map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT.sheet}"/>`)
      .join('') +
    drawings
      .map((d) => `<Override PartName="/xl/drawings/drawing${d.part}.xml" ContentType="${CT.drawing}"/>`)
      .join('') +
    '</Types>'

  const rootRels = relsXml([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'xl/workbook.xml' },
  ])

  const calcPr =
    opts.fullCalcOnLoad === false ? '' : '<calcPr calcId="191029" fullCalcOnLoad="1"/>'

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    `xmlns:r="${REL}">` +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="12000"/></bookViews>' +
    '<sheets>' +
    sheetNames
      .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets>' +
    calcPr +
    '</workbook>'

  const workbookRels = relsXml([
    ...sheets.map((_s, i) => ({
      id: `rId${i + 1}`,
      type: `${REL}/worksheet`,
      target: `worksheets/sheet${i + 1}.xml`,
    })),
    { id: `rId${sheets.length + 1}`, type: `${REL}/styles`, target: 'styles.xml' },
  ])

  const files: { name: string; data: Uint8Array }[] = [
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    // styles.xml is serialised last (below) — the table fills up while sheets render.
  ]
  for (let i = 0; i < sheets.length; i++) {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXmls[i]) })
    const part = drawingOfSheet.get(i)
    if (part != null) {
      files.push({
        name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        data: enc.encode(
          relsXml([{ id: 'rId1', type: `${REL}/drawing`, target: `../drawings/drawing${part}.xml` }]),
        ),
      })
    }
  }
  for (const d of drawings) {
    files.push({ name: `xl/drawings/drawing${d.part}.xml`, data: enc.encode(d.xml) })
    files.push({
      name: `xl/drawings/_rels/drawing${d.part}.xml.rels`,
      data: enc.encode(
        relsXml(
          d.rels.map((m, i) => ({
            id: `rId${i + 1}`,
            type: `${REL}/image`,
            target: `../media/${m}`,
          })),
        ),
      ),
    })
  }
  for (const m of media.entries) files.push({ name: `xl/media/${m.name}`, data: m.data })

  files.push({ name: 'xl/styles.xml', data: enc.encode(sty.xml()) })
  return zipStore(files)
}
