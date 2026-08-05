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
// image, title, bytes) is never read: the raster's own IHDR and the static
// SHEET_SPEC table supply those.

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
 *   pdf.ts        PAGE_W, PAGE_H
 *   sheet.ts      MARGIN, TITLE_BLOCK_H, RES
 *   sheetSet.ts   PANEL_W
 */
export function templateSpec() {
  const PAGE_W = sourceNumber('web/src/export/pdf.ts', 'PAGE_W')
  const PAGE_H = sourceNumber('web/src/export/pdf.ts', 'PAGE_H')
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

/** File stem → sheet number / title, as `buildDrawingSetPdf` assembles the set.
 *  Static spec; SG1 proves the delivered title blocks agree with it. */
export const SHEETS = [
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

// ---------------------------------------------------------------------------
// geometry.json — loaded, then validated against the spec above
// ---------------------------------------------------------------------------

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

/**
 * Load `<pack>/<sheet>.geometry.json` and PROVE it is the template before any
 * gate reads a rect out of it. Every failure mode is a hard error.
 */
export function loadGeometry(pack, sheetFile) {
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

/** Every scheduled (non-circulation) room, in the order the sheets take them. */
export function scheduledRooms(state) {
  const zones = (state.zones ?? []).filter((z) => z.zone_type !== 'Circulation')
  return [...zones].sort((a, b) => a.id - b.id).map((z, i) => ({
    id: z.id,
    zone: z,
    label: (z.label && z.label.trim()) || `Room ${String(i + 1).padStart(2, '0')}`,
  }))
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

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
