// Sheet harness — rasterise EVERY sheet of the architectural drawing set, for
// every pack, at a fixed DPI, with the sheet-template geometry written out
// beside each image.
//
// WHY THIS EXISTS. `buildDrawingSetPdf` shipped with no gate looking at a
// rendered sheet: the first time all 22 sheets were rasterised (reports/R-1.md
// §2) it turned up four defects nothing had ever measured. A gate cannot look at
// a sheet that nobody rendered, so this is the standing producer every sheet
// gate reads from. It grades nothing itself.
//
//   node scripts/sheets/render-all.mjs [--pack seeded|testfit|dwg|all]
//                                      [--out out/sheets] [--dpi 144]
//
// On disk (stable, one directory per pack):
//
//   out/sheets/<pack>/drawing-set.pdf        the PDF the PNGs come from
//   out/sheets/<pack>/cover.png              sheet 1     + cover.geometry.json
//   out/sheets/<pack>/contents.png           sheet 2     + contents.geometry.json
//   out/sheets/<pack>/A01.png … A09.png      sheets 3-11 + A01.geometry.json …
//   out/sheets/<pack>/A10.png …              the door/window schedule's
//                                            continuation sheet(s), if the
//                                            document tags more openings than
//                                            A.02's panel column holds — SEE
//                                            `sheetSpecFor()`: the count is
//                                            DERIVED, not a constant
//   out/sheets/<pack>/index.json             pack manifest: sizes + sha256
//   out/sheets/index.json                    the packs rendered by this run
//   out/sheets/<pack>/RENDER-FAILED.json     written INSTEAD of a swap when a
//                                            render throws; the previous pack
//                                            is left untouched beside it
//
// DETERMINISM. Two consecutive runs are byte-identical per PNG:
//   * the three packs are seeded/fixed documents (scripts/lib/demo-doc.mjs) and
//     the title block is frozen (`SHEET_META` in scripts/render-sheets.mjs);
//   * the one legitimately-varying value — `todayLabel()` — is pinned to
//     FREEZE_DATE_AT in UTC, so no timestamp reaches a pixel;
//   * rasterising is poppler `pdftoppm -png -r <dpi>`, which is deterministic
//     for a given PDF (verified: same digests over repeat runs);
//   * nothing here calls Math.random or reads the clock.
//
// GEOMETRY IS SPEC, NOT MEASUREMENT (.claude/rules/gate-independence.md). The
// rects in every geometry.json come from the sheet TEMPLATE constants —
// `sheetGeometry()` in web/src/export/sheetSet.ts (PAGE_W/PAGE_H/MARGIN/
// TITLE_BLOCK_H/PANEL_W/planBox), plus the panel width of the two modules that
// own their own column (section.ts, servicesSheets.ts), read out of their
// source. Not one number is measured off the rendered page, so a gate that
// compares ink against these rects is comparing the drawing to its template
// rather than to itself.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { REPO } from '../lib/demo-doc.mjs'
import { CASES, renderSheetSet } from '../render-sheets.mjs'

/** Rasterisation resolution. 144 dpi = exactly 2 px per pt on A3 landscape. */
export const DEFAULT_DPI = 144

/** The instant every sheet's date stamp is pinned to (UTC). Any fixed instant
 *  works; this one is chosen for being unambiguous in every timezone. */
export const FREEZE_DATE_AT = '2026-01-01T12:00:00Z'

/**
 * The UNCONDITIONAL sheets — the ones `buildDrawingSetPdf` assembles for every
 * document, whatever it contains (sheetSet.ts §Orchestration): cover · contents ·
 * A.01 demolition · A.02 construction · A.03 RCP · A.04 power · A.05/A.06
 * sections · A.07 furniture · A.08 moodboard · A.09 room finish schedule.
 * `kind` selects which template geometry applies.
 *
 * Everything past A.09 is conditional and is derived, not listed — see
 * `sheetSpecFor()`.
 */
export const BASE_SHEET_SPEC = [
  { file: 'cover', id: 'cover', no: '—', title: 'Cover', kind: 'frontmatter' },
  { file: 'contents', id: 'contents', no: '—', title: 'Contents', kind: 'frontmatter' },
  { file: 'A01', id: 'demolition', no: 'A.01', title: 'Demolition Plan', kind: 'plan' },
  { file: 'A02', id: 'construction', no: 'A.02', title: 'Construction & Furnishing Plan', kind: 'plan' },
  { file: 'A03', id: 'rcp', no: 'A.03', title: 'Reflected Ceiling Plan', kind: 'services' },
  { file: 'A04', id: 'power', no: 'A.04', title: 'Power & Data Plan', kind: 'services' },
  { file: 'A05', id: 'section-aa', no: 'A.05', title: 'Sections', kind: 'section' },
  { file: 'A06', id: 'section-bb', no: 'A.06', title: 'Sections', kind: 'section' },
  { file: 'A07', id: 'furniture', no: 'A.07', title: 'Furniture & Fixtures', kind: 'sheet' },
  { file: 'A08', id: 'moodboard', no: 'A.08', title: 'Moodboard', kind: 'sheet' },
  { file: 'A09', id: 'finishes', no: 'A.09', title: 'Room Finish Schedule', kind: 'sheet' },
]

/** How many of the base sheets carry an `A.NN` number (A.01 … A.09). */
const BASE_NUMBERED = BASE_SHEET_SPEC.filter((s) => /^A\.\d\d$/.test(s.no)).length

/**
 * The n-th (0-based) door/window schedule CONTINUATION sheet.
 *
 * `scheduleContSheets` (sheetSet.ts) numbers them `A.(startNo + i + 1)` with
 * `startNo = numbered.length` — i.e. they take the next free slots after the
 * last numbered base sheet — and titles every one of them the same. That is
 * spec, so the harness can state it; it is NOT assumed, because
 * `deliveredSheetNumbers()` below reads the number off each delivered page and
 * the two must agree.
 */
export function contSheetSpec(i) {
  const n = BASE_NUMBERED + 1 + i
  return {
    file: `A${String(n).padStart(2, '0')}`,
    id: i === 0 ? 'openings-cont' : `openings-cont-${i + 1}`,
    no: `A.${String(n).padStart(2, '0')}`,
    title: 'Door & Window Schedule (cont.)',
    kind: 'sheet',
  }
}

/**
 * THE EXPECTED SHEET COUNT IS DERIVED, NOT A CONSTANT.
 *
 * The 11 sheets above are unconditional: every drawing set has them, whatever
 * the document says. The door/window schedule's continuation sheets are not —
 * A.02's legend panel measures its own capacity (31 rows on A3) and paginates
 * only what it cannot hold, so a fit-out with 31 or fewer tagged openings
 * legitimately produces **11** sheets and one with 41 produces 12. Asserting a
 * flat 12 made the whole suite inoperable below that threshold, and blamed
 * swiftshader for it (reports/sheets-defects-1.md, D-C).
 *
 * The rule instead:
 *
 *   expected = the 11 unconditional sheets, in order, carrying A.01 … A.09,
 *              followed by ZERO OR MORE continuation sheets numbered A.10, A.11, …
 *
 * and it is enforced POSITIONALLY against the delivered page's own title block
 * (`deliveredSheetNumbers`), not against the page count. That is what keeps the
 * swiftshader tripwire live: if the two section sheets vanish and a continuation
 * sheet backfills the count, the page that should carry A.05 carries A.07 and
 * this fails loudly — where a bare count comparison would have shrugged.
 */
export function sheetSpecFor(pages) {
  const cont = pages - BASE_SHEET_SPEC.length
  if (cont < 0) return null
  return [...BASE_SHEET_SPEC, ...Array.from({ length: cont }, (_, i) => contSheetSpec(i))]
}

// ---------------------------------------------------------------------------
// Template constants owned by the modules this harness may not edit
// ---------------------------------------------------------------------------

/**
 * Read `const <name> = <number>` out of a module's source. section.ts and
 * servicesSheets.ts each declare their own `PANEL_W`/plan origin (a mirror of
 * sheetSet's, deliberately: they are separate sheet builders). Parsing the
 * declaration keeps the harness following the spec instead of holding a private
 * copy that can drift. A missing declaration is a hard failure.
 */
function sourceConst(relFile, name) {
  const file = path.join(REPO, relFile)
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(new RegExp(`^\\s*const ${name} = (-?[0-9.]+)\\b`, 'm'))
  if (!m) throw new Error(`${relFile}: no \`const ${name} = <number>\` — the harness cannot read the template geometry`)
  return { value: Number(m[1]), where: `${relFile}:${src.slice(0, m.index).split('\n').length}` }
}

// ---------------------------------------------------------------------------
// Geometry, in sheet points → PNG pixels
// ---------------------------------------------------------------------------

const r4 = (n) => Math.round(n * 1e4) / 1e4
const rect = (x, y, w, h) => ({ x: r4(x), y: r4(y), w: r4(w), h: r4(h) })
const scaleRect = (rc, s) => rect(rc.x * s, rc.y * s, rc.w * s, rc.h * s)
/** A rect in both spaces: `pt` = sheet points (top-down), `px` = PNG pixels. */
const both = (rc, s) => ({ pt: rect(rc.x, rc.y, rc.w, rc.h), px: scaleRect(rc, s) })

/**
 * Per-sheet template rects, from `sheetGeometry()` plus the two modules that
 * own their own panel column. Every sheet that carries a title block carries
 * the SAME one (`titleBlock()` in sheet.ts draws it from MARGIN/TITLE_BLOCK_H);
 * front matter (cover, contents) has none.
 */
function sheetRects(spec, g, alt) {
  const bandTop = g.pageH - g.margin - g.titleBlockH
  if (spec.kind === 'frontmatter') {
    return {
      titleBlock: null,
      panels: [],
      plate: null,
      note:
        'Front matter: coverSheet/contentsSheet draw no title block and no panel column, ' +
        'and lay their content out inline rather than through the shared plan template.',
    }
  }
  if (spec.kind === 'plan' || spec.kind === 'services') {
    // servicesSheets.ts mirrors sheetSet's planBox exactly (checked in run()).
    return {
      titleBlock: g.titleBlock,
      panels: [{ id: spec.kind === 'plan' ? 'legend-schedule' : 'legend-fixture-schedule', ...g.panel }],
      plate: g.plate,
    }
  }
  if (spec.kind === 'section') {
    // section.ts: same band/origin, its own narrower notes column.
    const panelX = g.pageW - g.margin - alt.sectionPanelW
    return {
      titleBlock: g.titleBlock,
      panels: [{ id: 'section-notes', x: panelX, y: g.plate.y, w: alt.sectionPanelW, h: bandTop - g.plate.y }],
      plate: { x: g.plate.x, y: g.plate.y, w: panelX - g.plate.x - 16, h: bandTop - g.plate.y - 16 },
    }
  }
  // Card/schedule sheets (furniture, moodboard, finish schedule): the shared
  // title block, and content across the full frame — no panel, no plate.
  return { titleBlock: g.titleBlock, panels: [], plate: null }
}

// ---------------------------------------------------------------------------
// PNG helpers
// ---------------------------------------------------------------------------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** Width/height straight out of the IHDR chunk (bytes 16..24). */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

function requirePdftoppm() {
  try {
    return execFileSync('pdftoppm', ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(
      `pdftoppm (poppler) is required to rasterise the sheets and is not runnable: ${err.message}\n` +
        '  install it with:  brew install poppler',
    )
  }
}

// ---------------------------------------------------------------------------
// What sheet number each delivered page actually carries
// ---------------------------------------------------------------------------

/**
 * The `A.NN` printed inside each page's own sheet-number box, read out of the
 * DELIVERED PDF's text layer (`pdftotext -bbox`, top-down points — the same
 * space every rect here is in). One entry per page; `null` for a page with no
 * number (the cover and the contents index draw no title block).
 *
 * The number box is sheet.ts:325 `const x5 = right - 130` and :371
 * `p.box(x5 + 12, top + 24, right - x5 - 24, TITLE_BLOCK_H - 44)` — template
 * geometry, so a word found inside it is the page's own identification of
 * itself and nothing else. (`A.10` also appears in A.02's "SCHEDULE CONTINUED
 * ON A.10" pointer and eleven times in the contents index; confining the read
 * to the number box is what tells those apart.)
 */
function deliveredSheetNumbers(pdfFile, g) {
  let xml
  try {
    xml = execFileSync('pdftotext', ['-bbox', pdfFile, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch (err) {
    throw new Error(
      `pdftotext (poppler) is required to read the delivered sheet numbers and failed: ${err.message}\n` +
        '  install it with:  brew install poppler',
    )
  }
  const bandTop = g.pageH - g.margin - g.titleBlockH
  const nb = { x: g.pageW - g.margin - 130 + 12, y: bandTop + 24, w: 130 - 24, h: g.titleBlockH - 44 }
  const out = []
  for (const pageXml of xml.split('<page ').slice(1)) {
    let no = null
    for (const m of pageXml.matchAll(
      /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g,
    )) {
      if (!/^A\.\d\d$/.test(m[5])) continue
      const x = Number(m[1])
      const y = Number(m[2])
      const x1 = Number(m[3])
      const y1 = Number(m[4])
      if (x >= nb.x && x1 <= nb.x + nb.w && y >= nb.y && y1 <= nb.y + nb.h) no = m[5]
    }
    out.push(no)
  }
  return out
}

// ---------------------------------------------------------------------------
// Render one pack
// ---------------------------------------------------------------------------

/** The file a failed render leaves behind, so a gate fails LOUDLY with the real
 *  cause instead of "missing input" (or, worse, grades a directory the failure
 *  emptied). `scripts/gates/sheets/lib/sheetlib.mjs` reads it. */
export const FAILURE_MARKER = 'RENDER-FAILED.json'

/**
 * Render one pack's full drawing set to per-sheet PNGs + geometry.
 *
 * FAILS CLOSED, NEVER OPEN (reports/sheets-defects-1.md, D-C). Everything is
 * built in a staging directory and swapped in only once the whole pack is on
 * disk, so a throw anywhere in here leaves the previous render EXACTLY as it
 * was and adds a `RENDER-FAILED.json` naming the cause. The old shape — `rm -rf`
 * the pack directory first, render second — turned any harness error into an
 * empty directory, and every sheet gate then collapsed to "missing input:
 * … render the sheets first" rather than failing on the real defect. A gate must
 * never silently lose its input.
 *
 * @returns the pack manifest (also written as `<outDir>/<pack>/index.json`).
 */
export async function renderPackSheets(pack, { outDir, dpi = DEFAULT_DPI } = {}) {
  const dir = path.join(outDir, pack)
  const staging = path.join(outDir, `.${pack}.staging`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    const r = await renderPackInto(pack, staging, dpi)
    // Swap: the previous render survives until the new one is complete on disk.
    const prev = path.join(outDir, `.${pack}.prev`)
    fs.rmSync(prev, { recursive: true, force: true })
    if (fs.existsSync(dir)) fs.renameSync(dir, prev)
    fs.renameSync(staging, dir)
    fs.rmSync(prev, { recursive: true, force: true })
    return r
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, FAILURE_MARKER),
      JSON.stringify({ pack, failedAt: new Date().toISOString(), error: err.message }, null, 2) + '\n',
    )
    throw err
  }
}

async function renderPackInto(pack, dir, dpi) {
  const { pdf, pages, geometry: g, warnings } = await renderSheetSet(pack, { freezeDateAt: FREEZE_DATE_AT })
  const SHEET_SPEC = sheetSpecFor(pages)
  if (!SHEET_SPEC) {
    throw new Error(
      `${pack}: drawing set came back with ${pages} sheets, and ${BASE_SHEET_SPEC.length} are unconditional. ` +
        'A short set means a sheet builder threw and was swallowed by its try-wrapper — ' +
        'classically the two section sheets, when Chromium has no GL context ' +
        '(render-sheets.mjs must launch with --use-gl=swiftshader).',
    )
  }
  const pdfFile = path.join(dir, 'drawing-set.pdf')
  fs.writeFileSync(pdfFile, pdf)

  // --- the derived spec, held to the delivered title blocks -----------------
  const delivered = deliveredSheetNumbers(pdfFile, g)
  if (delivered.length !== pages) {
    throw new Error(`${pack}: the PDF reports ${pages} pages but pdftotext read ${delivered.length}`)
  }
  const wrong = SHEET_SPEC.map((spec, i) => ({ spec, got: delivered[i] })).filter(
    ({ spec, got }) => (/^A\.\d\d$/.test(spec.no) ? got !== spec.no : got !== null),
  )
  if (wrong.length > 0) {
    throw new Error(
      `${pack}: the delivered sheet numbers are not the expected sequence. ` +
        wrong
          .slice(0, 4)
          .map(({ spec, got }) => `page ${SHEET_SPEC.indexOf(spec) + 1} should carry ${spec.no} but carries ${got ?? 'no number'}`)
          .join('; ') +
        `. Expected the ${BASE_SHEET_SPEC.length} unconditional sheets (A.01…A.09) followed by ` +
        `${pages - BASE_SHEET_SPEC.length} continuation sheet(s). A sheet builder that threw and was ` +
        'swallowed by its try-wrapper looks exactly like this — classically the two section sheets, ' +
        'when Chromium has no GL context (render-sheets.mjs must launch with --use-gl=swiftshader).',
    )
  }

  // --- template geometry (spec side) ---------------------------------------
  const sectionPanel = sourceConst('web/src/export/section.ts', 'PANEL_W')
  const servicesPanel = sourceConst('web/src/export/servicesSheets.ts', 'PANEL_W')
  if (servicesPanel.value !== g.panelW) {
    throw new Error(
      `panel width drift: sheetSet.sheetGeometry() says ${g.panelW}, ` +
        `${servicesPanel.where} says ${servicesPanel.value}. The services sheets no longer share the ` +
        'plan template — teach the harness the two geometries before rendering.',
    )
  }
  const alt = { sectionPanelW: sectionPanel.value }

  // --- rasterise ------------------------------------------------------------
  const scale = dpi / 72 // pt → px; PDF user space is 1/72 inch
  const stage = path.join(dir, '.raster')
  fs.mkdirSync(stage, { recursive: true })
  execFileSync('pdftoppm', ['-png', '-r', String(dpi), pdfFile, path.join(stage, 'p')], { stdio: 'pipe' })
  const raw = fs.readdirSync(stage).filter((f) => f.endsWith('.png')).sort()
  if (raw.length !== SHEET_SPEC.length) {
    throw new Error(`${pack}: pdftoppm produced ${raw.length} images for a ${pages}-sheet PDF`)
  }

  const expectPx = { w: Math.ceil(g.pageW * scale), h: Math.ceil(g.pageH * scale) }
  const sheets = []
  for (const [i, spec] of SHEET_SPEC.entries()) {
    const png = fs.readFileSync(path.join(stage, raw[i]))
    const size = pngSize(png)
    if (Math.abs(size.w - expectPx.w) > 1 || Math.abs(size.h - expectPx.h) > 1) {
      throw new Error(
        `${pack}/${spec.file}: raster is ${size.w}×${size.h} px but the template page ` +
          `(${g.pageW}×${g.pageH} pt at ${dpi} dpi) is ${expectPx.w}×${expectPx.h} px`,
      )
    }
    const pngFile = path.join(dir, `${spec.file}.png`)
    fs.writeFileSync(pngFile, png)

    const rects = sheetRects(spec, g, alt)
    const geom = {
      pack,
      sheet: spec.file,
      index: i + 1,
      no: spec.no,
      id: spec.id,
      title: spec.title,
      kind: spec.kind,
      image: `${spec.file}.png`,
      units: 'PNG pixels, origin top-left, y down; `pt` is the same rect in top-down sheet points',
      dpi,
      ptToPx: scale,
      derivedFrom: [
        'web/src/export/sheetSet.ts sheetGeometry() — PAGE_W/PAGE_H/MARGIN/TITLE_BLOCK_H/PANEL_W/planBox()',
        `${sectionPanel.where} PANEL_W=${sectionPanel.value} (section sheets)`,
        `${servicesPanel.where} PANEL_W=${servicesPanel.value} (services sheets)`,
      ],
      page: {
        wPt: g.pageW,
        hPt: g.pageH,
        wPx: size.w,
        hPx: size.h,
        note: 'wPx/hPx are ceil(pt × ptToPx): the raster covers the MediaBox with no offset, so px = pt × ptToPx.',
      },
      constants: {
        margin: g.margin,
        titleBlockH: g.titleBlockH,
        panelW: g.panelW,
        sectionPanelW: alt.sectionPanelW,
        titleBlockBandTopPt: r4(g.pageH - g.margin - g.titleBlockH),
      },
      frame: both(g.frame, scale),
      titleBlock: rects.titleBlock ? both(rects.titleBlock, scale) : null,
      panels: rects.panels.map((p) => ({ id: p.id, ...both(p, scale) })),
      plate: rects.plate ? both(rects.plate, scale) : null,
    }
    if (rects.note) geom.note = rects.note
    const geomFile = path.join(dir, `${spec.file}.geometry.json`)
    fs.writeFileSync(geomFile, JSON.stringify(geom, null, 2) + '\n')

    sheets.push({
      index: i + 1,
      file: `${spec.file}.png`,
      geometry: `${spec.file}.geometry.json`,
      no: spec.no,
      id: spec.id,
      title: spec.title,
      kind: spec.kind,
      wPx: size.w,
      hPx: size.h,
      bytes: png.length,
      sha256: sha256(png),
    })
  }
  fs.rmSync(stage, { recursive: true, force: true })

  const manifest = {
    pack,
    dpi,
    ptToPx: scale,
    dateFrozenAt: FREEZE_DATE_AT,
    sheetCount: sheets.length,
    expectedSheetCount: SHEET_SPEC.length,
    page: { wPt: g.pageW, hPt: g.pageH, wPx: expectPx.w, hPx: expectPx.h },
    pdf: { file: 'drawing-set.pdf', bytes: pdf.length, sha256: sha256(pdf) },
    sheets,
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { manifest, warnings }
}

/** Render every requested pack. */
export async function renderAllSheets({ packs = CASES, outDir = path.join(REPO, 'out/sheets'), dpi = DEFAULT_DPI, log = () => {} } = {}) {
  requirePdftoppm()
  fs.mkdirSync(outDir, { recursive: true })
  const done = []
  for (const pack of packs) {
    if (!CASES.includes(pack)) throw new Error(`unknown pack '${pack}'; expected one of ${CASES.join(', ')}`)
    const { manifest, warnings } = await renderPackSheets(pack, { outDir, dpi })
    done.push(manifest)
    log(
      `  ${pack}: ${manifest.sheetCount} sheets → ${path.relative(REPO, path.join(outDir, pack))}/ ` +
        `(${manifest.page.wPx}×${manifest.page.hPx} px @ ${dpi} dpi, pdf ${manifest.pdf.bytes} B)`,
    )
    for (const w of warnings) log(`    console: ${w}`)
  }
  fs.writeFileSync(
    path.join(outDir, 'index.json'),
    JSON.stringify(
      {
        dpi,
        ptToPx: dpi / 72,
        packs: done.map((m) => ({ pack: m.pack, sheetCount: m.sheetCount, dir: m.pack, index: `${m.pack}/index.json` })),
      },
      null,
      2,
    ) + '\n',
  )
  return done
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2)
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
  }
  const which = arg('--pack', 'all')
  const dpi = Number(arg('--dpi', String(DEFAULT_DPI)))
  const outDir = path.resolve(REPO, arg('--out', 'out/sheets'))
  const packs = which === 'all' ? CASES : which.split(',')
  console.log(`sheet harness: ${packs.join(' · ')} → ${path.relative(REPO, outDir)}/ at ${dpi} dpi`)
  try {
    const done = await renderAllSheets({ packs, outDir, dpi, log: (s) => console.log(s) })
    const counts = [...new Set(done.map((m) => m.sheetCount))]
    console.log(`sheet harness OK — ${done.length} pack(s) × ${counts.join('/')} sheets`)
  } catch (err) {
    console.error(`sheet harness FAILED: ${err.message}`)
    console.error(
      `  the pack directory was NOT emptied — its previous contents are intact and ${FAILURE_MARKER} names this failure,\n` +
        '  so every sheet gate fails on this error rather than on "missing input".',
    )
    process.exit(1)
  }
}
