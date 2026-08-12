// Shared primitives for the sheet gates SG1-SG6.
//
// EVERY function here obeys `.claude/rules/gate-independence.md`: it either
// reads the DELIVERED ARTIFACT (the PNG raster's pixels, the PDF's own byte
// stream) or it re-derives the SPEC from source (template constants parsed out
// of web/src/export/*.ts) or from CORE STATE (the input document the sheets are
// built from). Nothing here consumes the producer's own account of what it drew.
//
// The one piece of producer-adjacent data a gate touches is
// `out/sheets/<pack>/<sheet>.geometry.json`. It is admissible only because
// `loadGeometry()` VALIDATES it against the template constants read
// independently out of source before any gate uses a rect from it — "metadata
// the gate can validate is acceptable; metadata it must trust is not."
// Everything the harness MEASURED rather than declared (page.wPx/hPx, sha256,
// image, title, bytes) is never read: the raster's own IHDR, the static
// `BASE_SHEETS` table and the delivered PDF's own title blocks supply those
// (`sheetsFor` / `deliveredSheetNumbers`).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
/** Where the rendered sheets live. `SHEETS_OUT` exists for SG6, which re-runs
 *  every gate against sabotaged copies of the harness output and requires
 *  byte-identical results. */
export const SHEETS_DIR = process.env.SHEETS_OUT
  ? path.resolve(REPO, process.env.SHEETS_OUT)
  : path.join(REPO, 'out/sheets')
export const PACKS = ['seeded', 'testfit', 'dwg']

// ---------------------------------------------------------------------------
// Failure discipline — a missing input is a FAILURE, never a skip
// ---------------------------------------------------------------------------

export class GateError extends Error {}

/** Read a required file. Absence is a named failure, never a `continue`. */
export function must(file, why) {
  if (!fs.existsSync(file)) throw new GateError(`missing input: ${path.relative(REPO, file)} — ${why}`)
  return fs.readFileSync(file)
}

// ---------------------------------------------------------------------------
// The spec side: template constants, parsed out of source
// ---------------------------------------------------------------------------

/**
 * `[export] const <name> = <number>` out of a module's source.
 *
 * Deliberately NOT the harness's `sourceConst` (scripts/sheets/render-all.mjs):
 * a gate that re-used the producer's reader would be trusting the producer's
 * reading of the spec. Different invariant, so a second implementation is the
 * correct call under `.claude/rules/no-bloat.md` §1.
 */
export function sourceNumber(relFile, name) {
  const file = path.join(REPO, relFile)
  const src = must(file, 'the gate reads the sheet template constants out of source').toString('utf8')
  const m = src.match(new RegExp(`^\\s*(?:export )?const ${name}(?:\\s*:\\s*\\w+)? = (-?[0-9.]+)\\b`, 'm'))
  if (!m) throw new GateError(`${relFile}: no \`const ${name} = <number>\` — the gate cannot read the spec`)
  return Number(m[1])
}

/** `const <name> = hex2rgb('#rrggbb')` → [r,g,b] 0-255. Palette is spec. */
export function sourceHex(relFile, name) {
  const file = path.join(REPO, relFile)
  const src = must(file, 'the gate reads the sheet palette out of source').toString('utf8')
  const m = src.match(new RegExp(`^\\s*(?:export )?const ${name}(?:\\s*:\\s*\\w+)? = hex2rgb\\('#([0-9a-fA-F]{6})'\\)`, 'm'))
  if (!m) throw new GateError(`${relFile}: no \`const ${name} = hex2rgb('#…')\` — the gate cannot read the palette`)
  const h = m[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * The sheet template, recomputed from the NAMED constants in source. This is
 * the gate’s own copy of the spec; `loadGeometry()` holds the harness's
 * geometry.json to it.
 *
 *   pdfDoc.ts     PAGE_W, PAGE_H
 *   sheet.ts      MARGIN, TITLE_BLOCK_H, RES
 *   sheetSet.ts   PANEL_W
 */
export function templateSpec() {
  // PAGE_W/PAGE_H are PDF container constants and moved to pdfDoc.ts when pdf.ts
  // was split under R1. The anchor follows the DECLARATION, not the old filename.
  const PAGE_W = sourceNumber('web/src/export/pdfDoc.ts', 'PAGE_W')
  const PAGE_H = sourceNumber('web/src/export/pdfDoc.ts', 'PAGE_H')
  const MARGIN = sourceNumber('web/src/export/sheet.ts', 'MARGIN')
  const TITLE_BLOCK_H = sourceNumber('web/src/export/sheet.ts', 'TITLE_BLOCK_H')
  const RES = sourceNumber('web/src/export/sheet.ts', 'RES')
  const PANEL_W = sourceNumber('web/src/export/sheetSet.ts', 'PANEL_W')
  const bandTop = PAGE_H - MARGIN - TITLE_BLOCK_H
  return {
    PAGE_W,
    PAGE_H,
    MARGIN,
    TITLE_BLOCK_H,
    RES,
    PANEL_W,
    bandTop,
    frame: { x: MARGIN, y: MARGIN, w: PAGE_W - MARGIN * 2, h: PAGE_H - MARGIN * 2 },
    titleBlock: { x: MARGIN, y: bandTop, w: PAGE_W - MARGIN * 2, h: TITLE_BLOCK_H },
    panelX: PAGE_W - MARGIN - PANEL_W,
    // sheet.ts:325 `const x5 = right - 130` and :371 the sheet-number box
    // `p.box(x5 + 12, top + 24, right - x5 - 24, TITLE_BLOCK_H - 44)`.
    numberBox: {
      x: PAGE_W - MARGIN - 130 + 12,
      y: bandTop + 24,
      w: 130 - 24,
      h: TITLE_BLOCK_H - 44,
    },
    // sheet.ts:318 band frame stroke `width: 1.1` — ink may legally sit half a
    // stroke outside the rect it is drawn on.
    bandStrokePt: 1.1,
  }
}

// ---------------------------------------------------------------------------
// The sheet set's shape — a static table, not a measurement
// ---------------------------------------------------------------------------

/** The UNCONDITIONAL sheets: file stem → page / number / title, as
 *  `buildDrawingSetPdf` assembles them for EVERY document. Static spec; SG1
 *  proves the delivered title blocks agree with it. */
export const BASE_SHEETS = [
  { file: 'cover', page: 1, no: null, title: 'Cover' },
  { file: 'contents', page: 2, no: null, title: 'Contents' },
  { file: 'A01', page: 3, no: 'A.01', title: 'Demolition Plan' },
  { file: 'A02', page: 4, no: 'A.02', title: 'Construction & Furnishing Plan' },
  { file: 'A03', page: 5, no: 'A.03', title: 'Reflected Ceiling Plan' },
  { file: 'A04', page: 6, no: 'A.04', title: 'Power & Data Plan' },
  { file: 'A05', page: 7, no: 'A.05', title: 'Sections' },
  { file: 'A06', page: 8, no: 'A.06', title: 'Sections' },
  { file: 'A07', page: 9, no: 'A.07', title: 'Furniture & Fixtures' },
  { file: 'A08', page: 10, no: 'A.08', title: 'Moodboard' },
  { file: 'A09', page: 11, no: 'A.09', title: 'Room Finish Schedule' },
]

/** The title `scheduleContPage` gives every continuation sheet (sheetSet.ts) —
 *  spec, quoted, so SG1's title-block vocabulary knows it without reading the
 *  page's own `title` field out of geometry.json. */
const CONT_TITLE = 'Door & Window Schedule (cont.)'
/** How many base sheets carry a number (A.01 … A.09) — where continuation
 *  numbering picks up (`scheduleContSheets`: `A.(startNo + i + 1)`). */
const BASE_NUMBERED = BASE_SHEETS.filter((s) => s.no).length

/**
 * THE SHEET LIST IS DERIVED PER PACK, NOT A CONSTANT.
 *
 * A.02's door/window schedule paginates only the openings its panel column
 * cannot hold, so a document with 31 or fewer tagged openings legitimately
 * produces NO continuation sheet and the set is 11 pages, not 12. The gates used
 * to carry a static 12-row table and a `A10` entry, which made every one of them
 * report `missing input: …/A10.geometry.json` on a perfectly correct short set
 * (reports/sheets-defects-1.md, D-C).
 *
 * The rule, stated so it is falsifiable:
 *
 *   the 11 unconditional sheets above, carrying A.01 … A.09 in order,
 *   followed by ZERO OR MORE continuation sheets numbered A.10, A.11, …
 *
 * The COUNT comes from the delivered PDF's own page objects; the IDENTITY of
 * every page is then held to the sequence above by reading the `A.NN` out of
 * each delivered page's sheet-number box (`deliveredSheetNumbers`). A page that
 * carries the wrong number — the shape a swallowed section-sheet builder takes
 * when a continuation sheet backfills the count — is a hard failure here, so
 * deriving the count does not buy the producer a way to shrink its own test.
 */
export function sheetsFor(pack) {
  const numbers = deliveredSheetNumbers(pack)
  const cont = numbers.length - BASE_SHEETS.length
  if (cont < 0) {
    throw new GateError(
      `${pack}: the delivered set has ${numbers.length} pages and ${BASE_SHEETS.length} sheets are unconditional — ` +
        'a sheet builder threw and was swallowed by its try-wrapper (classically the two section sheets, ' +
        'when Chromium has no GL context)',
    )
  }
  const sheets = [
    ...BASE_SHEETS,
    ...Array.from({ length: cont }, (_, i) => {
      const n = String(BASE_NUMBERED + 1 + i).padStart(2, '0')
      return { file: `A${n}`, page: BASE_SHEETS.length + 1 + i, no: `A.${n}`, title: CONT_TITLE }
    }),
  ]
  const wrong = sheets.filter((s, i) => numbers[i] !== s.no)
  if (wrong.length > 0) {
    throw new GateError(
      `${pack}: the delivered sheet numbers are not the expected sequence — ` +
        wrong
          .slice(0, 4)
          .map((s) => `page ${s.page} should carry ${s.no ?? 'no number'} but carries ${numbers[s.page - 1] ?? 'no number'}`)
          .join('; '),
    )
  }
  return sheets
}

// ---------------------------------------------------------------------------
// The delivered set: how many pages, and what number each one carries
// ---------------------------------------------------------------------------

/** The harness's own name for "this render threw" (scripts/sheets/render-all.mjs
 *  `FAILURE_MARKER`). It is written INTO the pack directory beside the previous,
 *  untouched render. */
const FAILURE_MARKER = 'RENDER-FAILED.json'

/**
 * A pack whose last render FAILED is a hard failure here, carrying the harness's
 * own error — never a "missing input", and never a silent grading of whatever
 * survived. The harness no longer empties a pack directory on the way to
 * failing, so the evidence is still on disk; this is what stops a gate treating
 * it as the current artifact.
 */
export function assertRendered(pack) {
  const marker = path.join(SHEETS_DIR, pack, FAILURE_MARKER)
  if (!fs.existsSync(marker)) return
  let why = ''
  try {
    why = JSON.parse(fs.readFileSync(marker, 'utf8')).error ?? ''
  } catch {
    why = '(unreadable marker)'
  }
  throw new GateError(
    `${pack}: the sheet harness FAILED on its last run and this pack was not re-rendered — ${why}\n` +
      `  (the previous render is still on disk beside ${FAILURE_MARKER}; it is not the artifact under test)`,
  )
}

const numberCache = new Map()

/**
 * The `A.NN` printed inside each delivered page's own sheet-number box, read out
 * of the PDF's text layer. One entry per page, `null` where a page carries no
 * number (the cover and the contents index draw no title block).
 *
 * The box is sheet.ts:325 `const x5 = right - 130` and :371
 * `p.box(x5 + 12, top + 24, right - x5 - 24, TITLE_BLOCK_H - 44)` — template
 * geometry, recomputed by `templateSpec()`. Confining the read to that rect is
 * what distinguishes a page's own number from the eleven in the contents index
 * and from A.02's "SCHEDULE CONTINUED ON A.10" pointer.
 */
export function deliveredSheetNumbers(pack) {
  if (numberCache.has(pack)) return numberCache.get(pack)
  assertRendered(pack)
  const pdf = path.join(SHEETS_DIR, pack, 'drawing-set.pdf')
  must(pdf, 'render the sheets first: node scripts/sheets/render-all.mjs')
  let xml
  try {
    xml = execFileSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch (err) {
    throw new GateError(`pdftotext (poppler) is required and failed: ${err.message}\n  install it with:  brew install poppler`)
  }
  const nb = templateSpec().numberBox
  const out = []
  for (const pageXml of xml.split('<page ').slice(1)) {
    let no = null
    for (const m of pageXml.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g)) {
      if (!/^A\.\d\d$/.test(m[5])) continue
      if (Number(m[1]) >= nb.x && Number(m[3]) <= nb.x + nb.w && Number(m[2]) >= nb.y && Number(m[4]) <= nb.y + nb.h) no = m[5]
    }
    out.push(no)
  }
  if (out.length === 0) throw new GateError(`${pack}: the delivered PDF has no pages`)
  numberCache.set(pack, out)
  return out
}

// ---------------------------------------------------------------------------
// geometry.json — loaded, then validated against the spec above
// ---------------------------------------------------------------------------

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

/**
 * Load `<pack>/<sheet>.geometry.json` and PROVE it is the template before any
 * gate reads a rect out of it. Every failure mode is a hard error.
 */
export function loadGeometry(pack, sheetFile) {
  assertRendered(pack)
  const spec = templateSpec()
  const file = path.join(SHEETS_DIR, pack, `${sheetFile}.geometry.json`)
  const g = JSON.parse(must(file, 'render the sheets first: node scripts/sheets/render-all.mjs').toString('utf8'))

  const where = `${pack}/${sheetFile}.geometry.json`
  if (g.ptToPx !== g.dpi / 72) throw new GateError(`${where}: ptToPx ${g.ptToPx} ≠ dpi/72 (${g.dpi}/72)`)
  const s = g.ptToPx
  const check = (name, rc) => {
    if (!rc) return
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!near(rc.px[k], rc.pt[k] * s, 1e-3)) {
        throw new GateError(`${where}: ${name}.px.${k}=${rc.px[k]} ≠ ${name}.pt.${k}×${s}`)
      }
    }
  }
  check('frame', g.frame)
  check('titleBlock', g.titleBlock)
  check('plate', g.plate)
  for (const p of g.panels ?? []) check(`panel[${p.id}]`, p)

  // The rects must BE the template — recomputed here from named source constants.
  const eq = (name, rc, want) => {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!near(rc.pt[k], want[k], 1e-6)) {
        throw new GateError(`${where}: ${name}.pt.${k}=${rc.pt[k]} but the template says ${want[k]} ` +
          `(PAGE_W/PAGE_H from pdf.ts, MARGIN/TITLE_BLOCK_H from sheet.ts, PANEL_W from sheetSet.ts)`)
      }
    }
  }
  eq('frame', g.frame, spec.frame)
  if (g.titleBlock) eq('titleBlock', g.titleBlock, spec.titleBlock)
  for (const p of g.panels ?? []) {
    // A panel column is right-aligned to the frame and bottoms out on the band.
    if (!near(p.pt.x + p.pt.w, spec.PAGE_W - spec.MARGIN, 1e-6)) {
      throw new GateError(`${where}: panel[${p.id}] right edge ${p.pt.x + p.pt.w} ≠ PAGE_W-MARGIN ${spec.PAGE_W - spec.MARGIN}`)
    }
    if (!near(p.pt.y + p.pt.h, spec.bandTop, 1e-6)) {
      throw new GateError(`${where}: panel[${p.id}] bottom ${p.pt.y + p.pt.h} ≠ the title-block band top ${spec.bandTop}`)
    }
  }
  if (g.plate) {
    const panel = (g.panels ?? [])[0]
    if (!panel) throw new GateError(`${where}: a plate rect with no panel column`)
    if (g.plate.pt.x < spec.frame.x) throw new GateError(`${where}: plate starts left of the frame`)
    if (g.plate.pt.x + g.plate.pt.w > panel.pt.x) throw new GateError(`${where}: plate overruns the panel column`)
    if (!near(g.plate.pt.y, panel.pt.y, 1e-6)) throw new GateError(`${where}: plate top ≠ panel top`)
    if (g.plate.pt.y + g.plate.pt.h > spec.bandTop) throw new GateError(`${where}: plate overruns the title-block band`)
  }
  return { ...g, spec }
}

// ---------------------------------------------------------------------------
// The raster — decoded here, from the PNG bytes
// ---------------------------------------------------------------------------

/** Decode an 8-bit truecolour, non-interlaced PNG (what pdftoppm -png emits). */
export function readPng(file) {
  const buf = must(file, 'render the sheets first: node scripts/sheets/render-all.mjs')
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new GateError(`${file}: not a PNG`)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const depth = buf[24]
  const color = buf[25]
  const interlace = buf[28]
  if (depth !== 8 || color !== 2 || interlace !== 0) {
    throw new GateError(`${file}: expected 8-bit truecolour non-interlaced PNG, got depth=${depth} color=${color} interlace=${interlace}`)
  }
  const idat = []
  let o = 8
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('latin1', o + 4, o + 8)
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = 3
  const stride = w * bpp
  const out = Buffer.alloc(stride * h)
  let p = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[p++]
    const row = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = i >= bpp && prev ? prev[i - bpp] : 0
      let v = row[i]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (ft !== 0) throw new GateError(`${file}: unknown PNG filter ${ft} on row ${y}`)
      cur[i] = v & 0xff
    }
  }
  return {
    w,
    h,
    data: out,
    at(x, y) {
      const i = (y * w + x) * 3
      return [out[i], out[i + 1], out[i + 2]]
    },
  }
}

/**
 * INK CLASSIFIER. A PDF page starts unpainted and poppler renders unpainted
 * area as pure #FFFFFF — so background is white BY CONSTRUCTION, and every
 * non-white pixel is paint or its antialias tail. The 250 cutoff is a
 * deliberate relaxation of that construction fact (it can only ever *shrink*
 * the ink set, i.e. make a containment gate more forgiving, never stricter),
 * chosen so a 1-px antialias fringe on a white-on-white boundary is not
 * counted. It is not calibrated against any sheet.
 */
export const INK_CUTOFF = 250
export function isInk(r, g, b) {
  return r < INK_CUTOFF || g < INK_CUTOFF || b < INK_CUTOFF
}

/** Pure neutral: r == g == b. Text is drawn with the `g`/`G` grayscale
 *  operator (pdf.ts `col()`), so glyph ink is neutral BY RENDERER DEFINITION.
 *  ±2 absorbs 8-bit rounding only. */
export function isNeutral(r, g, b) {
  return Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2 && Math.abs(r - b) <= 2
}

/** Iterate every ink pixel in a px rect (clipped to the image). */
export function forEachInk(img, rc, fn) {
  const x0 = Math.max(0, Math.floor(rc.x))
  const y0 = Math.max(0, Math.floor(rc.y))
  const x1 = Math.min(img.w, Math.ceil(rc.x + rc.w))
  const y1 = Math.min(img.h, Math.ceil(rc.y + rc.h))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 3
      const r = img.data[i]
      const g = img.data[i + 1]
      const b = img.data[i + 2]
      if (isInk(r, g, b)) fn(x, y, r, g, b)
    }
  }
}

// ---------------------------------------------------------------------------
// The delivered PDF — its own text layer and its own content stream
// ---------------------------------------------------------------------------

const wordCache = new Map()

/**
 * Word boxes for one page of the delivered PDF, in TOP-DOWN sheet points —
 * poppler's own measurement of the delivered glyph runs, with the same font it
 * rasterises with. This is the artifact, not the producer's account of it.
 */
export function pageWords(pack, pageNo) {
  const key = `${pack}:${pageNo}`
  if (wordCache.has(key)) return wordCache.get(key)
  assertRendered(pack)
  const pdf = path.join(SHEETS_DIR, pack, 'drawing-set.pdf')
  must(pdf, 'render the sheets first: node scripts/sheets/render-all.mjs')
  let xml
  try {
    xml = execFileSync('pdftotext', ['-f', String(pageNo), '-l', String(pageNo), '-bbox', pdf, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    })
  } catch (err) {
    throw new GateError(`pdftotext (poppler) is required and failed: ${err.message}\n  install it with:  brew install poppler`)
  }
  const words = []
  const re = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g
  let m
  while ((m = re.exec(xml))) {
    words.push({
      x0: Number(m[1]),
      y0: Number(m[2]),
      x1: Number(m[3]),
      y1: Number(m[4]),
      text: m[5]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    })
  }
  if (words.length === 0) throw new GateError(`${pack} page ${pageNo}: pdftotext found no words at all`)
  wordCache.set(key, words)
  return words
}

const streamCache = new Map()

/**
 * The stroked line segments of one page, read out of the delivered PDF's own
 * content stream (`x1 y1 m x2 y2 l S`), converted to top-down points. The
 * engine writes content streams uncompressed (pdf.ts: `<< /Length … >>`, no
 * /Filter), so this is a plain read of the shipped bytes.
 */
export function pageLines(pack, pageNo) {
  const key = `${pack}:${pageNo}`
  if (streamCache.has(key)) return streamCache.get(key)
  assertRendered(pack)
  const spec = templateSpec()
  const pdf = must(path.join(SHEETS_DIR, pack, 'drawing-set.pdf'), 'render the sheets first').toString('latin1')
  // One `/Type /Page` object per line (pdf.ts writes each object on one line),
  // so [^\n] cannot run past the object it belongs to.
  const pageObjs = [...pdf.matchAll(/\/Type \/Page \/Parent[^\n]*?\/Contents (\d+) 0 R/g)].map((m) => Number(m[1]))
  if (pageObjs.length === 0) throw new GateError(`${pack}: no /Page objects found in the delivered PDF`)
  if (pageNo > pageObjs.length) throw new GateError(`${pack}: page ${pageNo} of a ${pageObjs.length}-page PDF`)
  const num = pageObjs[pageNo - 1]
  const objRe = new RegExp(`(?:^|\\n)${num} 0 obj\\n<< /Length (\\d+) >>\\nstream\\n`, 'g')
  const hit = objRe.exec(pdf)
  if (!hit) throw new GateError(`${pack}: content object ${num} for page ${pageNo} is not an uncompressed stream`)
  const start = hit.index + hit[0].length
  const body = pdf.slice(start, start + Number(hit[1]))
  const out = []
  const re = /([\d.-]+) ([\d.-]+) m ([\d.-]+) ([\d.-]+) l S/g
  let m
  while ((m = re.exec(body))) {
    out.push({
      x1: Number(m[1]),
      y1: spec.PAGE_H - Number(m[2]),
      x2: Number(m[3]),
      y2: spec.PAGE_H - Number(m[4]),
    })
  }
  streamCache.set(key, out)
  return out
}

// ---------------------------------------------------------------------------
// Core state — the input document the sheets are built from
// ---------------------------------------------------------------------------

const docCache = new Map()

/** The pack's document (`scripts/lib/demo-doc.mjs` builders) — the gate's
 *  ground truth for rooms, walls and doors. An input, never an output. */
export async function coreState(pack) {
  if (docCache.has(pack)) return docCache.get(pack)
  const { buildCaseDoc } = await import(path.join(REPO, 'scripts/render-sheets.mjs'))
  const doc = await buildCaseDoc(pack)
  if (!doc?.state) throw new GateError(`${pack}: buildCaseDoc returned no state`)
  docCache.set(pack, doc.state)
  return doc.state
}

/**
 * THE ROOM-NAME GRAMMAR — re-derived here from CORE STATE, never imported from
 * the drawing layer.
 *
 * WHY THE GATE HAS TO KNOW THIS AT ALL.  `zone.label` is what the CORE gives a
 * room, and the core can give several rooms the same one: on the DWG pack zones
 * 246 / 247 / 248 are all "Open Workspace" while 154 / 208 / 211 / 214 already
 * carry "(1)"…"(4)" (`crates/ds-core/src/layout.rs:4340`).  A gate that expects
 * `zone.label` on the page is therefore asserting that a drawing prints one
 * name for three different rooms — which is defect D4 itself, not a check for
 * it.  The PRINTED name is the label after disambiguation, so that is what the
 * gate must predict.
 *
 * THE RULE, stated so it is falsifiable rather than borrowed:
 *
 *   * a room's BASE name is its label with any trailing ` (n)` removed;
 *   * rooms are grouped by base name over every scheduled room in the document;
 *   * a group of ONE prints its label unchanged — nothing unambiguous is
 *     renamed;
 *   * a group of MORE prints `base (1)`, `base (2)`, … in ROOM ID ORDER.
 *
 * Room id is the document's own stable ordering, so the whole prediction comes
 * out of the input document: the gate can say, before opening a single sheet,
 * that room 246 must read "Open Workspace (5)".  A drawing that prints anything
 * else — including the old ambiguous "Open Workspace" — fails.  That is
 * strictly stronger than the ` (n)`-is-admissible grammar SG4 shipped with.
 *
 * A room whose label is empty is not grouped; the `Room NN` fallback below is
 * the gate's own synthesis and no sheet has to match an ordinal against it.
 */
const ORDINAL = /\s+\((\d+)\)\s*$/
function displayNameByZoneId(zones) {
  const groups = new Map()
  for (const z of zones) {
    const label = (z.label ?? '').trim()
    if (!label) continue
    const base = label.replace(ORDINAL, '').trim()
    if (!base) continue
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push(z.id)
  }
  const out = new Map()
  for (const [base, ids] of groups) {
    if (ids.length < 2) continue
    ids.forEach((id, i) => out.set(id, `${base} (${i + 1})`))
  }
  return out
}

/**
 * THE GROUND ZONE TYPES, re-derived from the RUST CORE's own fold rule.
 *
 * This gate used to hardcode `z.zone_type !== 'Circulation'`, written when
 * `Circulation` was the only ground there was. Queue 2 added `Unassigned` —
 * leftover floor that is a finding, not a programme — and made it ground: the
 * drawing set correctly stops naming it, and no published artifact may contain
 * the word at all. The gate did not learn, so it went on demanding a schedule
 * row for six zones that nothing is allowed to name, and reported
 * `SG4 FAIL: 6 room(s) have no named row on A.09` against a correct drawing.
 * The Queue-2 close was recorded as green with this red on the board.
 *
 * Hardcoding the second name would only move the same defect one release along,
 * so the list is PARSED from `lib.rs::published_zone_type` — the single place
 * the fold happens. Ground is Circulation plus everything that folds INTO it.
 * That is core source, not the drawing layer, so the gate still does not consume
 * anything the system under test produced.
 */
/**
 * The core's own ground set, loaded once at module scope (ESM top-level await),
 * so `groundZoneTypes()` can stay synchronous for `scheduledRooms`.
 */
const GROUND_FROM_CORE = await (async () => {
  const wasmDir = path.join(REPO, 'web/src/wasm')
  const mod = await import(new URL(`file://${path.join(wasmDir, 'ds_core.js')}`).href)
  mod.initSync({ module: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
  if (typeof mod.Editor.ground_zone_types !== 'function') {
    throw new Error(
      'the wasm core exports no ground_zone_types() — run `make wasm`. A gate ' +
        'that silently fell back to a hand-written set is the defect this export closes',
    )
  }
  return mod.Editor.ground_zone_types()
})()

export function groundZoneTypes() {
  // **THE VALUE, ACROSS THE BOUNDARY — not a regex over the definition's shape.**
  //
  // This parsed `published_zone_type` for `X => ZoneType::Circulation` arms, and
  // the adversary defeated it twice with the semantics unchanged: an `if`/
  // `return` folding `Core` into ground is invisible to the regex (50 steps
  // green with the set silently larger), and a prose comment merely NAMING a
  // type inside the body poisons the parse (`Meeting` joined the set, size 3, so
  // the `size < 2` non-vacuity guard passed and the wrong set returned).
  //
  // Worse, this parser and `coreParity.test.mjs`'s were the SAME REGEX in two
  // files — not two independent witnesses, so one `if` defeated both.
  //
  // `Editor.ground_zone_types()` computes it by running every `ZoneType` through
  // `is_ground_zone`. It is the predicate's own answer. Reading it is not a
  // gate-independence violation: the system under test here is the DRAWING
  // layer, and the core is the independent anchor these gates are supposed to be
  // held to.
  const g = GROUND_FROM_CORE
  const set = new Set(g)
  if (set.size < 1 || !set.has('Circulation')) {
    throw new Error(
      `ground_zone_types() returned ${JSON.stringify(g)} — a ground set without ` +
        'Circulation is not a ground set, and a gate that accepts one is grading nothing',
    )
  }
  return set
}

/** Every scheduled (non-ground) room, in the order the sheets take them.
 *  `label` is the core's own label; `display` is the name the sheets must
 *  print (see `displayNameByZoneId`). */
export function scheduledRooms(state) {
  const ground = groundZoneTypes()
  const zones = (state.zones ?? []).filter((z) => !ground.has(z.zone_type))
  const ordered = [...zones].sort((a, b) => a.id - b.id)
  const display = displayNameByZoneId(ordered)
  return ordered.map((z, i) => ({
    id: z.id,
    zone: z,
    display: display.get(z.id) ?? ((z.label && z.label.trim()) || `Room ${String(i + 1).padStart(2, '0')}`),
    label: (z.label && z.label.trim()) || `Room ${String(i + 1).padStart(2, '0')}`,
  }))
}

/**
 * THE WINDOW-RUN GRAMMAR — re-derived here from CORE STATE, never imported from
 * the drawing layer, and never read back off the schedule it grades.
 *
 * WHY THE GATE HAS TO KNOW THIS AT ALL.  A window in this document is not an
 * object: it is the glass on `DocWall.glazing === true`, and the generator emits
 * one glazed front as many short collinear segments (sixteen 0.15 m pieces on
 * the seeded plate).  So neither "one row per glazed wall" nor "one row per
 * window component" is the truth the schedule owes; the truth is one row per
 * *run* of contiguous collinear glass.  A gate that counted glazed WALLS would
 * be red on every set the moment the merge did its job — calibrated on the
 * present packs' conditions, which is the failure `.claude/rules/
 * gate-independence.md` §"never calibrate against the population under test"
 * describes.  So the gate derives the runs itself.
 *
 * THE RULE, stated so it is falsifiable rather than borrowed:
 *
 *   * a glazed segment lies on the INFINITE LINE given by its canonical unit
 *     direction and its signed perpendicular offset from the origin;
 *   * two segments share a line when their directions differ by less than
 *     `ANG_TOL` and their offsets by less than `OFF_TOL`;
 *   * along one line, segments whose 1-D spans touch or come within `GAP` are
 *     ONE run; the run's width is the union span's length and its position is
 *     that span's midpoint;
 *   * runs are tagged `W1, W2, …` top-to-bottom then left-to-right — the order
 *     `openingSchedule` states in its own contract.
 *
 * The three tolerances are the drafting policy, read out of `sheetSet.ts` by
 * name (`sourceNumber`) exactly as the page template's constants are: a policy
 * the gate can CITE, not a number the producer handed it for this run.  What the
 * gate refuses to consume is the producer's *answer* — the run list itself.  A
 * run dropped anywhere downstream of the geometry therefore has nothing to hide
 * behind: it is still in core state, and the gate still predicts its row.
 *
 * Ordering is used for NAMING ONLY (`W4` in a failure message); every assertion
 * built on this is a multiset comparison, so a change of sort order cannot
 * redden it.
 */
export function glazedRuns(state) {
  const ANG_TOL = sourceNumber('web/src/export/sheetSet.ts', 'ANG_TOL')
  const OFF_TOL = sourceNumber('web/src/export/sheetSet.ts', 'OFF_TOL')
  const GAP = sourceNumber('web/src/export/sheetSet.ts', 'GAP')

  const lines = []
  for (const w of state.walls ?? []) {
    if (w.glazing !== true) continue
    const dx = w.b.x - w.a.x
    const dy = w.b.y - w.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    // Canonical direction: the half of the line with ux > 0 (or uy > 0 when
    // vertical), so a→b and b→a describe the same line.
    let ux = dx / len
    let uy = dy / len
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux
      uy = -uy
    }
    const off = w.a.x * -uy + w.a.y * ux // signed perpendicular offset
    const ta = w.a.x * ux + w.a.y * uy
    const tb = w.b.x * ux + w.b.y * uy
    // Same line when the directions are within ANG_TOL (compared as the sine of
    // the angle between them, i.e. the cross product of two unit vectors) and
    // the offsets within OFF_TOL.
    let line = lines.find(
      (l) => Math.abs(l.ux * uy - l.uy * ux) < Math.sin(ANG_TOL) && Math.abs(l.off - off) < OFF_TOL,
    )
    if (!line) {
      line = { ux, uy, off, spans: [] }
      lines.push(line)
    }
    line.spans.push({ lo: Math.min(ta, tb), hi: Math.max(ta, tb) })
  }

  const runs = []
  for (const l of lines) {
    const spans = [...l.spans].sort((a, b) => a.lo - b.lo)
    let lo = spans[0].lo
    let hi = spans[0].hi
    const close = () => {
      const mid = (lo + hi) / 2
      runs.push({ x: mid * l.ux + l.off * -l.uy, y: mid * l.uy + l.off * l.ux, len: hi - lo })
    }
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].lo <= hi + GAP) hi = Math.max(hi, spans[i].hi)
      else {
        close()
        lo = spans[i].lo
        hi = spans[i].hi
      }
    }
    close()
  }
  runs.sort((a, b) => a.y - b.y || a.x - b.x)
  return runs.map((r, i) => ({ ...r, tag: `W${i + 1}` }))
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * world (m) → sheet pt, re-derived from CORE STATE and the template.
 *
 * `renderPrintCanvas` (web/src/export/printPlan.ts) fits `stateBbox` — every wall
 * endpoint and every rotated component corner — into a wPx×hPx canvas with a
 * 48 px pad, and `worldMapper` (sheetSet.ts) places that canvas in the plate.
 * Reproduced here from the document and the template constants, so a gate
 * never asks the renderer where anything went. Shared by SG2 (tag attribution)
 * and SG8 (string-ink crossing); ONE projection, so two gates cannot disagree
 * about where a wall landed.
 *
 * Returns `{ map, ptPerM }`: `map(x, y)` is world metres → top-down sheet pt;
 * `ptPerM` is the uniform world-to-pt scale (canvas `k` px/m × pt-per-px), the
 * factor a wall's metre thickness crosses into points with.
 */
export function planProjection(state, plate, RES) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const pt = (x, y) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const w of state.walls) {
    pt(w.a.x, w.a.y)
    pt(w.b.x, w.b.y)
  }
  for (const c of state.components) {
    const cos = Math.cos(c.rotation)
    const sin = Math.sin(c.rotation)
    for (const [lx, ly] of [
      [-c.w / 2, -c.h / 2],
      [c.w / 2, -c.h / 2],
      [c.w / 2, c.h / 2],
      [-c.w / 2, c.h / 2],
    ]) {
      pt(c.x + lx * cos - ly * sin, c.y + lx * sin + ly * cos)
    }
  }
  if (minX === Infinity) throw new GateError('core state has no walls and no components — nothing to project')
  const wPx = Math.round(plate.w * RES)
  const hPx = Math.round(plate.h * RES)
  const pad = 48
  const spanX = Math.max(maxX - minX, 0.001)
  const spanY = Math.max(maxY - minY, 0.001)
  const k = Math.min((wPx - pad * 2) / spanX, (hPx - pad * 2) / spanY)
  const ox = (wPx - spanX * k) / 2 - minX * k
  const oy = (hPx - spanY * k) / 2 - minY * k
  const sx = plate.w / wPx
  const sy = plate.h / hPx
  return {
    map: (x, y) => ({ x: plate.x + (x * k + ox) * sx, y: plate.y + (y * k + oy) * sy }),
    ptPerM: k * sx,
  }
}

export const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
export const wordRect = (wd) => ({ x: wd.x0, y: wd.y0, w: wd.x1 - wd.x0, h: wd.y1 - wd.y0 })

// ---------------------------------------------------------------------------
// Label instances — an EXPECTED string (from core state) located in the artifact
// ---------------------------------------------------------------------------

/**
 * Two words belong to the same drawn string when they share a baseline and are
 * exactly one space apart. `p.text` emits one `Tj` per call, so the only gap
 * inside a drawn string is Helvetica's space advance, 0.278 em — 2.78 pt at the
 * largest face any room label uses (10 pt) and 2.09 pt at 7.5 pt. WORD_GAP is
 * that bound plus 26% slack. It matters that it is TIGHT: two room labels
 * printed side by side on one baseline (the A.03 defect) sit ~5.4 pt apart, and
 * a loose gap would splice them into one phantom string.
 */
const SAME_LINE = 0.05
const WORD_GAP = 3.5

function chainFrom(words, start, tokens) {
  let cur = start
  const run = [start]
  for (let t = 1; t < tokens.length; t++) {
    const next = words
      .filter(
        (w) =>
          w.text === tokens[t] &&
          Math.abs(w.y0 - start.y0) <= SAME_LINE &&
          w.x0 >= cur.x1 - 0.5 &&
          w.x0 - cur.x1 <= WORD_GAP,
      )
      .sort((a, b) => a.x0 - b.x0)[0]
    if (!next) return null
    run.push(next)
    cur = next
  }
  return run
}

/**
 * Every place `text` is drawn as one complete string on a page.
 *
 * The expectation comes from CORE STATE; this only locates it in the delivered
 * text layer. A run is rejected when another word continues it on the same
 * baseline, so "OPEN WORKSPACE" does not match the head of
 * "OPEN WORKSPACE (1)" — the two are different display strings and the gate
 * must not conflate them.
 */
export function findLabelRuns(words, text, longer = []) {
  const tokens = String(text).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) throw new GateError('findLabelRuns: empty expected string')
  const out = []
  for (const w of words.filter((x) => x.text === tokens[0])) {
    const run = chainFrom(words, w, tokens)
    if (!run) continue
    const last = run[run.length - 1]
    // Reject only when the next adjacent word makes this run the head of a
    // DIFFERENT EXPECTED NAME ("OPEN WORKSPACE" inside "OPEN WORKSPACE (1)").
    // Adjacency alone is not enough: two room labels printed side by side sit
    // ~2.6 pt apart, barely more than a space, so an adjacency-only rule would
    // discard the very labels the collision defect produces.
    const nxt = words
      .filter((x) => Math.abs(x.y0 - w.y0) <= SAME_LINE && x.x0 >= last.x1 - 0.5 && x.x0 - last.x1 <= WORD_GAP)
      .sort((a, b) => a.x0 - b.x0)[0]
    if (nxt && longer.some((L) => String(L).startsWith(`${text} ${nxt.text}`))) continue
    out.push({
      text,
      words: run,
      box: {
        x: Math.min(...run.map((r) => r.x0)),
        y: Math.min(...run.map((r) => r.y0)),
        w: Math.max(...run.map((r) => r.x1)) - Math.min(...run.map((r) => r.x0)),
        h: Math.max(...run.map((r) => r.y1)) - Math.min(...run.map((r) => r.y0)),
      },
    })
  }
  return out.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
}

/**
 * The widest run of ink-free pixel COLUMNS strictly inside a word's own box.
 *
 * A drawn word is a continuous glyph run: the only blanks inside it are glyph
 * side bearings, which Helvetica's AFM bounds well under 0.3 em even for the
 * widest pair (a digit's 0.556 em advance around a ~0.30 em bowl). Anything
 * wider means part of the run is not on the page — the signature of a later
 * knockout halo painted over an earlier label.
 */
export function widestInteriorGap(img, wordBox, s) {
  const x0 = Math.max(0, Math.round(wordBox.x * s))
  const x1 = Math.min(img.w, Math.round((wordBox.x + wordBox.w) * s))
  const y0 = Math.max(0, Math.round(wordBox.y * s) - 1)
  const y1 = Math.min(img.h, Math.round((wordBox.y + wordBox.h) * s) + 1)
  const inked = []
  for (let x = x0; x < x1; x++) {
    let any = false
    for (let y = y0; y < y1 && !any; y++) {
      const i = (y * img.w + x) * 3
      if (isInk(img.data[i], img.data[i + 1], img.data[i + 2])) any = true
    }
    inked.push(any)
  }
  let first = inked.indexOf(true)
  let last = inked.lastIndexOf(true)
  if (first < 0) return { gapPx: x1 - x0, atPx: x0, coverage: 0 }
  let run = 0
  let best = 0
  let bestAt = x0
  for (let i = first; i <= last; i++) {
    if (inked[i]) run = 0
    else {
      run++
      if (run > best) {
        best = run
        bestAt = x0 + i - run + 1
      }
    }
  }
  return { gapPx: best, atPx: bestAt, coverage: inked.filter(Boolean).length / Math.max(1, inked.length) }
}

// ---------------------------------------------------------------------------
// Scoreboard plumbing (matches the G1-G11 gates' one-line contract)
// ---------------------------------------------------------------------------

export class Checks {
  constructor(id) {
    this.id = id
    this.n = 0
    this.fails = []
    this.notes = []
  }
  ok(desc, cond, detail = '') {
    this.n++
    if (!cond) this.fails.push(`${desc}${detail ? ` — ${detail}` : ''}`)
    return cond
  }
  note(s) {
    this.notes.push(s)
  }
  report() {
    for (const s of this.notes) process.stderr.write(`  ${s}\n`)
    for (const f of this.fails) process.stderr.write(`  FAIL ${f}\n`)
    const line = this.fails.length
      ? `${this.id} FAIL (${this.n} checks, ${this.fails.length} failing)`
      : `${this.id} PASS (${this.n} checks)`
    process.stdout.write(line + '\n')
    return this.fails.length === 0
  }
}

/** Run a gate body; a thrown GateError is a FAIL line, not a stack trace. */
export async function runGate(id, body) {
  const c = new Checks(id)
  try {
    await body(c)
  } catch (err) {
    c.n++
    c.fails.push(err instanceof GateError ? err.message : `${err.stack || err}`)
  }
  return c.report()
}
