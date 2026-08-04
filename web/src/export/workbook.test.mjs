// Node test for the hand-written OOXML workbook writer. Run from web/:
//   node src/export/workbook.test.mjs
//
// This is a correctness test for a binary format, so it does not assert against
// our own reader. It builds a synthetic workbook exercising ALL SEVEN of the
// capabilities the qbiq-parity deliverable needs —
//
//   1 <f> formulas (arithmetic, cross-sheet, VLOOKUP, SUMIF, ROUND, <>)
//   2 drawing layer: twoCellAnchor + oneCellAnchor with EMU offsets, png + jpeg
//   3 showGridLines=false, per sheet
//   4 column widths + row heights (incl. a tall 140pt image row)
//   5 merged cells
//   6 data validations (inline list + a range on the `dropdowns` sheet)
//   7 real styles: exact ARGB fills, bold/size/colour fonts, borders, numFmts
//
// — then hands it to two independent readers:
//   * python3 + openpyxl, for structure (formulas, anchors, widths, ARGB, …)
//   * headless LibreOffice, for RECALCULATION (a formula must produce the right
//     cached value after a round-trip) and for ZERO repair warnings.
//
// Bundling mirrors takeoff.test.mjs (esbuild resolved through vite).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workbook-'))

// --- bundle workbook.ts -----------------------------------------------------
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const outFile = path.join(SCRATCH, 'workbook.bundle.mjs')
await build({
  entryPoints: [path.join(here, 'workbook.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const { buildXlsx, pxToEmu, colName, colIndex } = await import(pathToFileURL(outFile).href)

let failures = 0
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// --- unit checks on the address helpers ------------------------------------
check('colName 1/26/27/28 -> A/Z/AA/AB', ['A', 'Z', 'AA', 'AB'].join() === [colName(1), colName(26), colName(27), colName(28)].join())
check('colIndex round-trips', colIndex('AA') === 27 && colIndex('B') === 2)
check('pxToEmu(240) === 2286000 (the reference thumbnail width)', pxToEmu(240) === 2286000)
check('pxToEmu(180) === 1714500 (the reference thumbnail height)', pxToEmu(180) === 1714500)

// --- test images (generated with PIL so the test is self-contained) --------
execFileSync('python3', [
  '-c',
  `
from PIL import Image, ImageDraw
import sys, os
d = sys.argv[1]
# logo: a 181x83 JPEG, the size of the reference's per-sheet logo
Image.new('RGB', (181, 83), (11, 103, 249)).save(os.path.join(d, 'logo.jpeg'), 'JPEG')
# plan: 1040x780 RGBA PNG, the reference master-plan canvas
p = Image.new('RGBA', (1040, 780), (0, 0, 0, 0))
ImageDraw.Draw(p).rectangle([3, 433, 1011, 755], fill=(255, 230, 230, 255))
p.save(os.path.join(d, 'plan.png'))
# two DISTINCT 240x180 room thumbnails
for i, col in enumerate([(255, 220, 96, 255), (119, 219, 241, 255)]):
    t = Image.new('RGBA', (240, 180), col)
    ImageDraw.Draw(t).rectangle([10, 10, 100 + i * 40, 80], fill=(0, 0, 0, 255))
    t.save(os.path.join(d, f'thumb{i + 1}.png'))
print('images ok')
`,
  SCRATCH,
], { encoding: 'utf8' })

const bytes = (n) => new Uint8Array(fs.readFileSync(path.join(SCRATCH, n)))
const LOGO = bytes('logo.jpeg')
const PLAN = bytes('plan.png')
const THUMB1 = bytes('thumb1.png')
const THUMB2 = bytes('thumb2.png')

// --- the seven palette chips, verbatim from the reference spec -------------
const CHIPS = [
  ['Drywall', '#FFDC60'],
  ['Half Drywall', '#72BDA1'],
  ['Glass', '#77DBF1'],
  ['Core', '#A0A0A0'],
  ['Perimeter windows', '#DCDBEE'],
  ['Perimeter wall', '#AEB6FF'],
  ['Door_length', '#FFC393'],
]

const HEADER = {
  font: { bold: true, size: 10, color: '#FFFFFF' },
  fill: '#0B67F9',
  align: { h: 'center', v: 'top', wrap: true },
  border: { all: 'thin' },
  numFmt: '@',
}

// --- build the synthetic workbook ------------------------------------------
const sheets = [
  // 1. General — the lookup source. Gridlines LEFT ON, as a control for #3.
  {
    name: 'General',
    cells: {
      D5: 3,
      B9: 'Carpet',
      C9: 'MAT-001',
      D9: 1250,
      B10: 'Vinyl',
      C10: 'MAT-002',
      D10: 900,
    },
  },
  // 2. Inventory — SUMIF source + the tall thumbnail rows.
  {
    name: 'Inventory',
    gridlines: false,
    cols: { A: 10.67, B: 34.0, C: 35.5 },
    rowHeights: { 5: 140, 6: 140 },
    cells: {
      A4: { v: 'Room ID', style: HEADER },
      B4: { v: 'Plan', style: HEADER },
      C4: { v: 'Material', style: HEADER },
      A5: 101,
      C5: 'Carpet',
      A6: 102,
      C6: 'Vinyl',
      K1: 10,
      K2: 20,
      K3: 30,
      L1: 'Carpet',
      L2: 'Vinyl',
      L3: 'Carpet',
    },
    images: [
      // logo — twoCellAnchor with EMU offsets, exactly like the reference
      {
        data: LOGO,
        format: 'jpeg',
        from: { col: 1, row: 1, colOff: 0, rowOff: 0 },
        to: { col: 1, row: 2, colOff: 752475, rowOff: 155574 },
        name: 'Logo',
      },
      // room thumbnail — twoCellAnchor sized by offsets (reference style)
      {
        data: THUMB1,
        format: 'png',
        from: { col: 1, row: 4, colOff: 0, rowOff: 0 },
        to: { col: 1, row: 4, colOff: 2286000, rowOff: 1714500 },
      },
      // room thumbnail — oneCellAnchor with an explicit EMU extent
      {
        data: THUMB2,
        format: 'png',
        from: { col: 1, row: 5, colOff: 0, rowOff: 0 },
        ext: { cx: pxToEmu(240), cy: pxToEmu(180) },
      },
    ],
  },
  // 3. Plan — the big master image + the legend chips (capability 7's hard part).
  {
    name: 'Plan',
    gridlines: false,
    merges: ['Q4:R4'],
    cols: { Q: 3.0, R: 40.5 },
    cells: {
      Q4: { v: 'Wall type', style: { font: { bold: true, color: '#FFFFFF' }, fill: '#0B67F9' } },
      ...Object.fromEntries(
        CHIPS.flatMap(([label, hex], i) => [
          [`Q${5 + i}`, { v: null, style: { fill: hex, border: { all: 'thin' } } }],
          [`R${5 + i}`, { v: label, style: { fill: '#FCF5F2' } }],
        ]),
      ),
    },
    images: [
      {
        data: LOGO, // same bytes as Inventory's logo -> must de-dupe to ONE part
        format: 'jpeg',
        from: { col: 1, row: 1 },
        to: { col: 2, row: 3, colOff: 628650, rowOff: 118 },
      },
      {
        data: PLAN,
        format: 'png',
        from: { col: 0, row: 0 },
        to: { col: 12, row: 36, colOff: 215900, rowOff: 31750 },
      },
    ],
  },
  // 4. Calc — every formula shape, merges, validations.
  {
    name: 'Calc',
    gridlines: false,
    merges: ['D1:F1'],
    cols: { A: 18.5, B: 12 },
    rowHeights: { 1: 24 },
    cells: {
      D1: { v: 'Formula bench', style: { font: { bold: true, size: 14 } } },
      A1: 6,
      B1: 7,
      C1: { f: '=A1*B1' }, // 42
      A2: { f: "='General'!B9" }, // 'Carpet'
      A3: { f: "VLOOKUP(A2,'General'!$B$9:$D$10,3,FALSE)" }, // 1250
      A4: { f: "SUMIF('Inventory'!$L$1:$L$3,A2,'Inventory'!$K$1:$K$3)" }, // 40
      A5: { f: "=ROUND('General'!$D$5*A4,2)" }, // 120
      A6: { f: 'IF(ISBLANK(A1),"",IF(A1<>0,A1*2,0))' }, // 12  (escaping: <> and quotes)
      A7: { f: 'A3*A4', v: 0, style: { numFmt: '#,##0.00' } }, // cached 0 must be overwritten by recalc
    },
    validations: [
      {
        type: 'list',
        formula1: '"cm,m,f,inch"',
        sqref: ['M9:M12', 'K3'],
        allowBlank: false,
      },
      {
        type: 'list',
        formula1: 'dropdowns!$A$1:$A$4',
        sqref: 'N9:N12',
        allowBlank: true,
      },
    ],
  },
  // 5. dropdowns — the validation source range.
  {
    name: 'dropdowns',
    cells: { A1: 'Carpet', A2: 'Vinyl', A3: 'Timber', A4: 'Stone' },
  },
]

const xlsx = buildXlsx(sheets)
check('xlsx bytes produced', xlsx instanceof Uint8Array && xlsx.length > 1000)
check('starts with ZIP magic', xlsx[0] === 0x50 && xlsx[1] === 0x4b && xlsx[2] === 0x03 && xlsx[3] === 0x04)

const xlsxPath = path.join(SCRATCH, 'synthetic.xlsx')
fs.writeFileSync(xlsxPath, xlsx)
console.log(`\nwrote synthetic workbook: ${xlsxPath} (${xlsx.length} bytes)\n`)

// --- reader 1: python3 + openpyxl ------------------------------------------
const PY_VERIFY = `
import json, sys, zipfile
import openpyxl

p = sys.argv[1]
out = []
def ck(cond, label):
    out.append(("PASS" if cond else "FAIL") + "  " + label)

wb = openpyxl.load_workbook(p)
ck(wb.sheetnames == ['General','Inventory','Plan','Calc','dropdowns'],
   "sheet order %r" % (wb.sheetnames,))

# --- 1 formulas -------------------------------------------------------------
c = wb['Calc']
ck(c['C1'].value == '=A1*B1', "C1 formula reads back as '=A1*B1' (got %r)" % c['C1'].value)
ck(c['C1'].data_type == 'f', "C1 data_type is 'f' (got %r)" % c['C1'].data_type)
ck(c['A2'].value == "='General'!B9", "cross-sheet ref survives (got %r)" % c['A2'].value)
ck(c['A3'].value == "=VLOOKUP(A2,'General'!$B$9:$D$10,3,FALSE)", "VLOOKUP survives (got %r)" % c['A3'].value)
ck(c['A4'].value == "=SUMIF('Inventory'!$L$1:$L$3,A2,'Inventory'!$K$1:$K$3)", "SUMIF survives (got %r)" % c['A4'].value)
ck(c['A6'].value == '=IF(ISBLANK(A1),"",IF(A1<>0,A1*2,0))', "<> and quotes survive escaping (got %r)" % c['A6'].value)
ck(c['A1'].value == 6 and c['B1'].value == 7, "literal numerics intact")

# --- 3 gridlines ------------------------------------------------------------
ck(c.sheet_view.showGridLines is False, "Calc gridlines off (got %r)" % c.sheet_view.showGridLines)
ck(wb['Inventory'].sheet_view.showGridLines is False, "Inventory gridlines off")
ck(wb['General'].sheet_view.showGridLines is not False, "General gridlines ON (per-sheet control)")

# --- 4 widths / heights -----------------------------------------------------
inv = wb['Inventory']
ck(abs(inv.column_dimensions['B'].width - 34.0) < 1e-6, "col B width 34.0 (got %r)" % inv.column_dimensions['B'].width)
ck(abs(inv.column_dimensions['C'].width - 35.5) < 1e-6, "col C width 35.5 (got %r)" % inv.column_dimensions['C'].width)
ck(inv.row_dimensions[5].height == 140, "row 5 height 140pt (got %r)" % inv.row_dimensions[5].height)
ck(inv.row_dimensions[6].height == 140, "row 6 height 140pt")
ck(abs(wb['Calc'].column_dimensions['A'].width - 18.5) < 1e-6, "Calc col A width 18.5")

# --- 5 merges ---------------------------------------------------------------
ck('Q4:R4' in [str(r) for r in wb['Plan'].merged_cells.ranges], "Plan merge Q4:R4 present")
ck('D1:F1' in [str(r) for r in c.merged_cells.ranges], "Calc merge D1:F1 present")

# --- 6 data validations -----------------------------------------------------
dvs = list(c.data_validations.dataValidation)
ck(len(dvs) == 2, "Calc has 2 data validations (got %d)" % len(dvs))
by_f = {d.formula1: d for d in dvs}
ck('"cm,m,f,inch"' in by_f, "inline list validation present (got %r)" % list(by_f))
ck('dropdowns!$A$1:$A$4' in by_f, "range-source validation present")
if '"cm,m,f,inch"' in by_f:
    d = by_f['"cm,m,f,inch"']
    ck(d.type == 'list', "inline validation type is list")
    ck(sorted(str(x) for x in d.sqref.ranges) == ['K3', 'M9:M12'], "multi-range sqref (got %r)" % [str(x) for x in d.sqref.ranges])

# --- 7 styles: exact ARGB ---------------------------------------------------
CHIPS = ${JSON.stringify(CHIPS)}
pl = wb['Plan']
for i, (label, hexv) in enumerate(CHIPS):
    cell = pl['Q%d' % (5 + i)]
    got = cell.fill.fgColor.rgb
    want = 'FF' + hexv.lstrip('#').upper()
    ck(got == want, "legend chip Q%d (%s) fill %r == %r" % (5 + i, label, got, want))
    ck(cell.fill.patternType == 'solid', "legend chip Q%d is a solid fill" % (5 + i))
    ck(pl['R%d' % (5 + i)].value == label, "legend label R%d == %r" % (5 + i, label))
ck(pl['Q4'].fill.fgColor.rgb == 'FF0B67F9', "legend header fill FF0B67F9 (got %r)" % pl['Q4'].fill.fgColor.rgb)
ck(pl['Q4'].font.bold is True, "legend header font bold")
ck(pl['Q4'].font.color.rgb == 'FFFFFFFF', "legend header font white (got %r)" % pl['Q4'].font.color.rgb)
h = inv['B4']
ck(h.fill.fgColor.rgb == 'FF0B67F9', "Inventory header fill")
ck(h.font.sz == 10 and h.font.bold, "Inventory header font 10pt bold")
ck(h.alignment.horizontal == 'center' and h.alignment.wrap_text is True, "header alignment centre + wrap")
ck(h.border.left.style == 'thin' and h.border.bottom.style == 'thin', "header thin border on all sides")
ck(h.number_format == '@', "header number format '@' (got %r)" % h.number_format)
ck(c['A7'].number_format == '#,##0.00', "numFmt on a formula cell (got %r)" % c['A7'].number_format)

# --- 2 images ---------------------------------------------------------------
imgs = inv._images
ck(len(imgs) == 3, "Inventory carries 3 images (got %d)" % len(imgs))
def frm(im):
    a = im.anchor._from
    return (a.col, a.row, a.colOff, a.rowOff)
thumbs = [im for im in imgs if int(im.width) == 240 and int(im.height) == 180]
ck(len(thumbs) == 2, "2 thumbnails are exactly 240x180 px (got %d)" % len(thumbs))
anch = sorted(frm(t) for t in thumbs)
ck(anch == [(1, 4, 0, 0), (1, 5, 0, 0)], "thumbnails anchored in column B rows 5 and 6 (got %r)" % (anch,))
two = [t for t in thumbs if t.anchor.__class__.__name__ == 'TwoCellAnchor']
one = [t for t in thumbs if t.anchor.__class__.__name__ == 'OneCellAnchor']
ck(len(two) == 1 and len(one) == 1, "one twoCellAnchor + one oneCellAnchor (got %r)" % ([t.anchor.__class__.__name__ for t in thumbs],))
if two:
    t = two[0].anchor.to
    ck((t.col, t.row, t.colOff, t.rowOff) == (1, 4, 2286000, 1714500),
       "twoCellAnchor 'to' EMU offsets preserved (got %r)" % ((t.col, t.row, t.colOff, t.rowOff),))
if one:
    e = one[0].anchor.ext
    ck((e.cx, e.cy) == (2286000, 1714500), "oneCellAnchor ext EMU preserved (got %r)" % ((e.cx, e.cy),))
logo = [im for im in imgs if int(im.width) == 181 and int(im.height) == 83]
ck(len(logo) == 1, "logo jpeg present at 181x83 (got %d)" % len(logo))
if logo:
    ck(frm(logo[0]) == (1, 1, 0, 0), "logo anchored at B2 (got %r)" % (frm(logo[0]),))

pimgs = wb['Plan']._images
ck(len(pimgs) == 2, "Plan carries 2 images (got %d)" % len(pimgs))
plan = [im for im in pimgs if int(im.width) == 1040 and int(im.height) == 780]
ck(len(plan) == 1, "master plan png is 1040x780 (got %r)" % [(int(i.width), int(i.height)) for i in pimgs])
if plan:
    t = plan[0].anchor.to
    ck((t.col, t.row, t.colOff, t.rowOff) == (12, 36, 215900, 31750),
       "plan twoCellAnchor to M37 + EMU offsets (got %r)" % ((t.col, t.row, t.colOff, t.rowOff),))

z = zipfile.ZipFile(p)
names = z.namelist()
media = sorted(n for n in names if n.startswith('xl/media/'))
ck(len(media) == 4, "media de-duped to 4 parts (logo used twice) (got %r)" % media)
ck(sum(1 for n in media if n.endswith('.jpeg')) == 1, "exactly one jpeg part")
ck(len([n for n in names if n.startswith('xl/drawings/drawing')]) == 2, "2 drawing parts (only sheets with images)")
ck('xl/worksheets/_rels/sheet2.xml.rels' in names, "sheet2 has drawing rels")
ct = z.read('[Content_Types].xml').decode()
ck('Extension="png"' in ct and 'Extension="jpeg"' in ct, "content types declare png + jpeg defaults")
ck('fullCalcOnLoad="1"' in z.read('xl/workbook.xml').decode(), "workbook requests full recalc on load")
for n in names:
    if n.endswith('.xml') or n.endswith('.rels'):
        import xml.dom.minidom as m
        m.parseString(z.read(n))
ck(True, "every XML part parses")

print(json.dumps(out))
`

const pyOut = execFileSync('python3', ['-c', PY_VERIFY, xlsxPath], { encoding: 'utf8' })
console.log('--- openpyxl structural verification ---')
for (const line of JSON.parse(pyOut.trim().split('\n').pop())) {
  console.log(line)
  if (line.startsWith('FAIL')) failures++
}

// --- reader 2: headless LibreOffice — recalc + repair warnings --------------
const SOFFICE = ['soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].find((p) => {
  try {
    if (p.startsWith('/')) return fs.existsSync(p)
    execFileSync('which', [p], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
check('LibreOffice (soffice) resolved', !!SOFFICE)

if (SOFFICE) {
  const conv = path.join(SCRATCH, 'converted')
  const profile = path.join(SCRATCH, 'profile')
  fs.mkdirSync(conv, { recursive: true })
  let stdout = ''
  let stderr = ''
  try {
    const r = execFileSync(
      SOFFICE,
      [
        `-env:UserInstallation=file://${profile}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--convert-to',
        'xlsx:Calc MS Excel 2007 XML',
        '--outdir',
        conv,
        xlsxPath,
      ],
      { encoding: 'utf8', timeout: 240000 },
    )
    stdout = r
  } catch (err) {
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
  }
  const dest = path.join(conv, 'synthetic.xlsx')
  check('LibreOffice produced converted output', fs.existsSync(dest))

  // G9's bar: zero repair/corruption complaints.
  const REPAIR = ['repair', 'corrupt', 'unreadable', 'recover', 'invalid', 'error:', 'malformed']
  const noise = ['javaldx', 'gtk', 'dbus', 'warning: failed to launch', 'fontconfig']
  const warns = (stdout + '\n' + stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !noise.some((n) => l.toLowerCase().includes(n)))
    .filter((l) => REPAIR.some((b) => l.toLowerCase().includes(b)))
  check(`LibreOffice reported no repair warnings${warns.length ? ' — ' + warns.slice(0, 2).join(' | ') : ''}`, warns.length === 0)

  if (fs.existsSync(dest)) {
    const PY_RECALC = `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
c = wb['Calc']
out = []
def ck(cond, label):
    out.append(("PASS" if cond else "FAIL") + "  " + label)
ck(c['C1'].value == 42, "recalc =A1*B1 -> 42 (got %r)" % c['C1'].value)
ck(c['A2'].value == 'Carpet', "recalc cross-sheet ='General'!B9 -> 'Carpet' (got %r)" % c['A2'].value)
ck(c['A3'].value == 1250, "recalc VLOOKUP -> 1250 (got %r)" % c['A3'].value)
ck(c['A4'].value == 40, "recalc SUMIF -> 40 (got %r)" % c['A4'].value)
ck(c['A5'].value == 120, "recalc ROUND(General!D5*A4,2) -> 120 (got %r)" % c['A5'].value)
ck(c['A6'].value == 12, "recalc nested IF/ISBLANK/<> -> 12 (got %r)" % c['A6'].value)
ck(c['A7'].value == 50000, "stale cached value overwritten by recalc: A3*A4 -> 50000 (got %r)" % c['A7'].value)
wb2 = openpyxl.load_workbook(sys.argv[1])
ck(wb2.sheetnames == ['General','Inventory','Plan','Calc','dropdowns'], "sheets survive the round-trip %r" % wb2.sheetnames)
ck(wb2['Calc'].sheet_view.showGridLines is False, "gridlines still off after round-trip")
ck(len(wb2['Inventory']._images) == 3, "images survive the round-trip (got %d)" % len(wb2['Inventory']._images))
ck(len(list(wb2['Calc'].data_validations.dataValidation)) == 2, "validations survive the round-trip")
ck(wb2['Plan']['Q5'].fill.fgColor.rgb == 'FFFFDC60', "chip ARGB survives the round-trip (got %r)" % wb2['Plan']['Q5'].fill.fgColor.rgb)
print(json.dumps(out))
`
    const out2 = execFileSync('python3', ['-c', PY_RECALC, dest], { encoding: 'utf8' })
    console.log('\n--- LibreOffice recalc verification ---')
    for (const line of JSON.parse(out2.trim().split('\n').pop())) {
      console.log(line)
      if (line.startsWith('FAIL')) failures++
    }
  }
}

console.log(`\nartifacts kept at ${SCRATCH}`)
if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll assertions passed.')
