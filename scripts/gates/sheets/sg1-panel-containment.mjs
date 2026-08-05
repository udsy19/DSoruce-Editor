// SG1 — PANEL CONTAINMENT.  A sheet's content stays inside the region the
// template gives it, and a schedule that will not fit paginates onto a
// continuation sheet that the contents index lists.
//
//   node scripts/gates/sheets/sg1-panel-containment.mjs [--pack seeded,dwg]
//
// WHAT IT ASSERTS, AND WHAT EACH ASSERTION IS ANCHORED TO
//
//  1.1  TITLE-BLOCK PURITY.  Every word whose box touches the `titleBlock` rect
//       is one of the title block's OWN strings.  Anchor: the vocabulary is
//       enumerated from `titleBlock()` in web/src/export/sheet.ts (the field
//       labels it literally draws), the harness's frozen `SHEET_META` (an
//       INPUT), the static sheet no/title table, and the frozen date — never
//       from the rendered page.
//  1.2  NOTHING BELOW / BESIDE THE FRAME (pixels).  Zero ink below
//       `frame.bottom`, left of `frame.left` or right of `frame.right`, with a
//       half-stroke allowance of 1.1 pt (sheet.ts:318, the band frame's own
//       stroke width).  The frame TOP is deliberately excluded: sheet titles are
//       drawn at baseline y=42 with a 15 pt face, so their ascenders sit above
//       y=MARGIN by construction (`p.text(MARGIN + 6, 42, 15, …)`).
//  1.3  SHEET-NUMBER BOX PURITY (pixels).  Inside the big sheet-number box
//       (sheet.ts:371 `p.box(x5+12, top+24, right-x5-24, TITLE_BLOCK_H-44)`,
//       x5 = right-130 at sheet.ts:325) the only ink is the A.NN glyph run.
//  1.4  PAGINATION.  If any schedule row is rendered below its panel's bottom
//       edge, continuation sheets MUST exist and MUST be listed in the contents
//       index.  Plus, always: the A.NN numbers in the contents index are exactly
//       the A.NN numbers the DELIVERED TITLE BLOCKS carry, in order (1.4b —
//       both sides now read off the artifact; see the D-I note below).
//  1.5  SCHEDULE COMPLETENESS — the pointer, the continuation sheet and the row
//       set, tied together.  Four assertions per pack:
//         a. every opening TAGGED ON THE PLAN has exactly one schedule row
//            somewhere in the set (A.02's panel + every continuation sheet);
//         b. no schedule row is an ORPHAN — every row's tag is on the plan;
//         c. the `SCHEDULE CONTINUED ON A.NN  (n MORE)` pointer names a sheet
//            the delivered set actually carries and states the correct
//            remaining count — and is absent exactly when nothing overflowed;
//         d. the DOOR rows are counted against CORE STATE (`category ===
//            'Door'`), the external anchor that keeps (a) and (b) from being two
//            readings of one contaminated population;
//         e. the WINDOW rows are matched, width for width, against the glazed
//            RUNS re-derived from CORE STATE (`glazedRuns`) — the other half of
//            the same anchor (see the S8 amendment below).
//
// ---------------------------------------------------------------------------
// AMENDMENT (agent S7) — D-B, D-C, D-I from reports/sheets-defects-1.md.
//
//   D-B.  A set saying `SCHEDULE CONTINUED ON A.99  (0 MORE)`, with W24 tagged
//   on the plan and NO schedule row anywhere, passed SG1 201 / SG2 24 / SG3 295
//   all green.  1.4 only ever asked "did a row print BELOW the panel?" — never
//   "is every opening scheduled, exactly once, across A.02 and the
//   continuation?".  1.5 is that question.  Both sides are read out of the
//   DELIVERED PDF (plan tags = `[DW]\d+` words inside the `plate` rect; rows =
//   the `Door`/`Window` TYPE word of a printed row and the tag word beside it),
//   and 1.5d anchors the door half against core state so the two artifact-side
//   populations are not merely agreeing with each other.
//
//   D-C.  The sheet list is no longer a static 12-row table.  `sheetsFor(pack)`
//   derives it: the 11 unconditional sheets, then one continuation sheet per
//   further delivered page, each held to the `A.NN` its own title block carries.
//   A document with <= 31 tagged openings has no continuation sheet and is
//   graded correctly instead of failing on `missing input: A10.geometry.json`.
//
//   D-I.  1.4b compared the contents index against the STATIC table while
//   building a `delivered` array it never read.  It now compares the index
//   against the numbers the delivered title blocks actually carry
//   (`deliveredSheetNumbers`), which is what its own header always claimed.
//
//   201 checks -> 213: +4 per pack, all of them 1.5.  Falsified, not argued —
//   the Judge's own fabricated schedule (A.02's pointer forced to
//   `SCHEDULE CONTINUED ON A.99  (0 MORE)`, and `openingOverflow.slice(0, -1)`
//   so one tagged opening has no row anywhere), which passed
//   SG1 201 / SG2 24 / SG3 295 all green:
//
//     FAIL seeded  every tagged opening has exactly one schedule row in the set
//          — 1 of 41 plan tag(s) have NO schedule row anywhere: W24
//            (plan tags 41, rows 40 across A.02+A.10)
//     FAIL seeded/A02 the continuation pointer resolves — the pointer names
//          A.99, which the delivered set does not carry; the pointer says
//          (0 MORE) but 9 row(s) are continued
//     FAIL testfit … W30 · FAIL dwg … W33   (the same two, per pack)
//     SG1 FAIL (213 checks, 6 failing)
//
// ---------------------------------------------------------------------------
// AMENDMENT (agent S8) — D-O from reports/sheets-defects-2.md §2.
//
//   THE HOLE.  1.5d anchored the DOOR half to core state and said so; the
//   WINDOW half had no external anchor at all.  Both the plan tags (1.5a) and
//   the schedule rows (1.5b) descend from ONE `openingSchedule()` call, so when
//   the Judge dropped a real glazed run UPSTREAM of it
//   (`mergeGlazedRuns(state.walls)…filter((_, i) => i !== 3)`), the window lost
//   its plan tag and its schedule row TOGETHER — the two populations agreed
//   with each other, and SG1 71 / SG2 8 / SG3 97 all passed on a set in which a
//   window that exists in the building is neither tagged nor scheduled
//   anywhere.  `.claude/rules/gate-independence.md` §"never calibrate against
//   the population under test", inside a gate written to enforce it.
//
//   1.5e CLOSES IT the way 1.5d already closed the door half: the gate derives
//   the glazed runs from CORE STATE itself (`glazedRuns` in lib/sheetlib.mjs —
//   the window-run grammar, stated there and re-implemented, with the merge
//   policy's three tolerances read out of source by name, never the producer's
//   run list) and matches them WIDTH FOR WIDTH against the `Window` rows read
//   off the delivered pages.  Core-state geometry cannot lose a run when a
//   downstream list drops one, so the row that vanished has nothing to agree
//   with.  Matching is a multiset over widths (tolerance 0.006 m, half the
//   printed 2-dp step), so it is independent of tag order and of which sheet a
//   row landed on.
//
//   213 checks -> 216: +1 per pack, 1.5e.  Falsified, not argued — the Judge's
//   own upstream sabotage re-applied, and the OLD gate reproduced on it first
//   (`SG1 PASS (71 checks)` · `SG2 PASS (8 checks)` · `SG3 PASS (97 checks)`,
//   the Judge's three numbers exactly, on a seeded set whose plan tags run
//   W1…W23 and whose pointer reads `(9 MORE)` instead of W1…W24 / `(10 MORE)`):
//
//     FAIL seeded one schedule row per glazed run in core state — 1 of 24
//          glazed run(s) in core state have NO Window row: W4 0.65 m at
//          (37.68, 2.45) (core-state runs 24, Window rows 23, total glazed
//          150.30 m vs 149.65 m scheduled)
//     SG1 FAIL (72 checks, 1 failing)        [--pack seeded; 216 over all three]
//
//   And a second, deeper sabotage — one glazed segment dropped INSIDE
//   `mergeGlazedRuns` rather than downstream of it, so that no filter on the
//   producer's own run list could be what the gate is watching:
//
//     FAIL seeded one schedule row per glazed run in core state — 1 of 24
//          glazed run(s) in core state have NO Window row: W14 3.85 m at
//          (27.83, 4.05) …                       SG2 PASS (8) · SG3 PASS (97)
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — actual output at HEAD (1748bdf), before any defect was fixed:
//
//   $ node scripts/gates/sheets/sg1-panel-containment.mjs
//   SG1 FAIL (183 checks, 14 failing)
//
//   FAIL seeded/A02 title-block purity — 80 foreign word(s) printed over the
//        title block: W16 W16 Window 1.85 × 1.50 m Glazed partition +0.80 W17
//        W17 … (tags W16 W17 W18 W19 W20 W21 W22 W23)
//   FAIL seeded/A02 no ink below the frame — 2760 ink px, topmost row 1605,
//        x 1685..2284
//   FAIL seeded/A02 no ink left of the frame — 255 ink px, topmost row 730,
//        x 33..77
//   FAIL seeded/A02 sheet-number box carries only "A.02" — 2975 foreign ink px
//        inside the number box, first at 2067,1424
//   FAIL seeded/A02 panel[legend-schedule] schedule overflow paginates —
//        9 row(s) (W16 W17 W18 W19 W20 W21 W22 W23 W24) print below the panel
//        bottom 685.89 pt, and the contents index lists 0 continuation sheet(s)
//   FAIL testfit/A02 … the same five, rows W15-W24, 6775 ink px below the frame
//   FAIL dwg/A02     … four of the five (no left-margin overrun on this plate),
//        rows W22-W31, and the title block also carries the stray W33 tag and a
//        room label's "6.8 m²"
//
//   All 14 are on A.02. The other 24 numbered sheets pass all four families —
//   the check is not "always red".
//
//   NOT ONE OF THE FOUR REPORTED DEFECTS, and found by 1.2: on seeded and
//   testfit the OVERALL PERIMETER dimension string "24.00 m" is drawn at
//   x 16.26-43.36 pt, i.e. straddling and mostly OUTSIDE the MARGIN=40 frame,
//   in the unprintable left margin. Reported as a fifth defect.
// ---------------------------------------------------------------------------

import path from 'node:path'
import {
  PACKS,
  SHEETS_DIR,
  sheetsFor,
  deliveredSheetNumbers,
  loadGeometry,
  readPng,
  pageWords,
  coreState,
  glazedRuns,
  wordRect,
  rectsOverlap,
  forEachInk,
  runGate,
  GateError,
} from './lib/sheetlib.mjs'

/** The harness's frozen title-block copy (scripts/render-sheets.mjs SHEET_META)
 *  — an INPUT to the producer, so quoting it is quoting the spec. */
const META = {
  project: 'DSource Demo Fit-Out',
  client: 'Studio Nova',
  address: '46 Residency Road, Bengaluru',
  studio: 'DSOURCE',
  revision: 'A',
  drawnBy: 'DS',
  approvedBy: 'UT',
}

/** Every literal `titleBlock()` draws (web/src/export/sheet.ts:311-373). */
const TITLE_BLOCK_LITERALS = [
  'DRAWING SET',
  'KEY PLAN',
  'NOTES',
  'CLIENT',
  'PROJECT',
  'REVISION',
  'DATE',
  'TITLE',
  'DRAWN',
  'APPROVED',
  'SCALE',
  'DSOURCE',
  'dsource.editor',
  '-',
]

/** The date every sheet stamps: FREEZE_DATE_AT rendered by `todayLabel()`
 *  (`en-GB`, 2-digit day/month, numeric year). */
const FROZEN_DATE = '01/01/2026'

function allowedWords(sheet) {
  const out = new Set()
  const add = (s) => String(s).split(/\s+/).filter(Boolean).forEach((t) => out.add(t))
  TITLE_BLOCK_LITERALS.forEach(add)
  Object.values(META).forEach(add)
  add(sheet.no)
  add(sheet.title)
  add(FROZEN_DATE)
  add('NTS')
  return out
}

const isScale = (t) => /^1:\d+$/.test(t)
const isScheduleTag = (t) => /^[DW]\d+$/.test(t)

// ---------------------------------------------------------------------------
// 1.5's two populations, both read out of the DELIVERED PDF
// ---------------------------------------------------------------------------

/** Same baseline: pdftotext reports one `yMin` per drawn run, and the two words
 *  of a schedule row are emitted by two `p.text` calls at the identical `ly`.
 *  The row's own tag glyph sits 1.04 pt off it (`drawTagGlyph` draws at
 *  `cy + size*0.32` about `ly - 3`), which is what this tolerance excludes. */
const SAME_BASELINE = 0.05
/** A row's TYPE column starts at `x + 66` and its TAG column at `x + 30`
 *  (sheetSet.ts `scheduleRow`), so the gap between them is ~22 pt for the
 *  widest tag. The glyph tag at `x + 18` is 41 pt away and on another baseline. */
const TAG_TO_TYPE_PT = 45
/** The SIZE cell (`38.80 × 1.50 m`) starts at `x + 118`, i.e. 52 pt right of
 *  the TYPE cell; MATERIAL / SILL starts at `x + 200`, 134 pt right of it. The
 *  window's WIDTH is the first `d.dd` word inside that gap — the height (1.50)
 *  follows the `×`, and the sill (`+0.80`) carries a sign, so neither can be
 *  mistaken for it. */
const TYPE_TO_MATERIAL_PT = 134

/**
 * Every opening TAGGED ON THE PLAN: a `D12`/`W24` word whose box lies inside
 * the plan's own viewport. The plate rect is template geometry, so this is
 * "what the reader sees pointing at an opening", not a producer tag list.
 */
function planTags(words, plate) {
  return words
    .filter((w) => isScheduleTag(w.text) && rectsOverlap(wordRect(w), plate) && w.x0 >= plate.x && w.x1 <= plate.x + plate.w)
    .map((w) => w.text)
}

/**
 * Every SCHEDULE ROW printed on a page, above the title-block band.
 *
 * A row is identified by its TYPE cell — the literal `Door` or `Window`
 * `scheduleRow` prints at `x + 66` — with the nearest tag word to its left on
 * the same baseline. Anchoring on the type word is what makes this one hit per
 * printed row: the row's tag is drawn twice (once inside the hexagon glyph,
 * once in the TAG column) and a tag-first reader would double-count. `TYPE` in
 * the grey header band is upper-case and matches nothing here.
 */
function scheduleRowsOn(words, bandTop, where) {
  const rows = []
  for (const t of words) {
    if ((t.text !== 'Door' && t.text !== 'Window') || t.y1 > bandTop) continue
    const sameLine = words.filter((w) => Math.abs(w.y0 - t.y0) <= SAME_BASELINE)
    const tag = sameLine
      .filter((w) => isScheduleTag(w.text) && w.x1 <= t.x0 && t.x0 - w.x1 <= TAG_TO_TYPE_PT)
      .sort((a, b) => b.x1 - a.x1)[0]
    if (!tag) continue
    // The SIZE cell, for 1.5e. A row that prints a type and a tag but no width
    // is a FAILURE, never a skipped row (gate-independence: "a missing input is
    // a failure, never a skip").
    const size = sameLine
      .filter((w) => /^\d+(?:\.\d+)?$/.test(w.text) && w.x0 > t.x0 && w.x0 - t.x0 <= TYPE_TO_MATERIAL_PT)
      .sort((a, b) => a.x0 - b.x0)[0]
    if (!size) throw new GateError(`${where}: schedule row ${tag.text} prints no SIZE cell — 1.5e cannot read its width`)
    rows.push({ tag: tag.text, kind: t.text, y: t.y0, x: t.x0, w: Number(size.text) })
  }
  return rows
}

/** `SCHEDULE CONTINUED ON A.10  (10 MORE)` — the pointer `constructionSheet`
 *  prints when its panel could not hold every opening (sheetSet.ts:992), read
 *  back off the page as words. `A.10-A.11` is the multi-sheet form. */
function continuationPointer(words) {
  const line = words
    .filter((w) => w.text === 'SCHEDULE')
    .map((w) => words.filter((x) => Math.abs(x.y0 - w.y0) <= SAME_BASELINE).sort((a, b) => a.x0 - b.x0))
    .find((l) => l.map((w) => w.text).join(' ').startsWith('SCHEDULE CONTINUED ON '))
  if (!line) return null
  const text = line.map((w) => w.text).join(' ')
  const m = text.match(/^SCHEDULE CONTINUED ON (\S+)\s+\((\d+) MORE\)/)
  if (!m) return { text, sheets: null, count: null }
  const [first, last] = m[1].split('-')
  return { text, first, last: last ?? first, count: Number(m[2]) }
}

/** A.02 is the sheet that tags the plan and starts the schedule. */
const CONSTRUCTION = 'A02'

/**
 * 1.5 — the pointer, the continuation sheet and the row set, tied together.
 *
 * This is the check whose absence let a fabricated schedule through a fully
 * green board (D-B): a set pointing at a sheet that does not exist, with a
 * tagged opening that has no row anywhere, passed 201/24/295.
 */
async function scheduleCompleteness(c, pack, SHEETS) {
  const gA02 = loadGeometry(pack, CONSTRUCTION)
  if (!gA02.plate) throw new GateError(`${pack}/${CONSTRUCTION}: no plate rect — 1.5 cannot find the plan's tags`)
  const a02 = SHEETS.find((s) => s.file === CONSTRUCTION)
  const a02Words = pageWords(pack, a02.page)
  const bandTop = gA02.titleBlock.pt.y

  // --- the two populations, both off the delivered pages --------------------
  const tags = planTags(a02Words, gA02.plate.pt)
  const rows = [...scheduleRowsOn(a02Words, bandTop, `${pack}/${CONSTRUCTION}`).map((r) => ({ ...r, sheet: a02.no }))]
  const contSheets = SHEETS.filter((s) => s.title === 'Door & Window Schedule (cont.)')
  for (const s of contSheets) {
    const g = loadGeometry(pack, s.file)
    for (const r of scheduleRowsOn(pageWords(pack, s.page), g.titleBlock.pt.y, `${pack}/${s.file}`)) rows.push({ ...r, sheet: s.no })
  }

  const rowsByTag = new Map()
  for (const r of rows) rowsByTag.set(r.tag, [...(rowsByTag.get(r.tag) ?? []), r])

  // --- 1.5a every tagged opening is scheduled exactly once ------------------
  const unscheduled = tags.filter((t) => !rowsByTag.has(t))
  const doubled = [...rowsByTag.entries()].filter(([t, rs]) => tags.includes(t) && rs.length > 1)
  c.ok(
    `${pack} every tagged opening has exactly one schedule row in the set`,
    unscheduled.length === 0 && doubled.length === 0,
    [
      unscheduled.length
        ? `${unscheduled.length} of ${tags.length} plan tag(s) have NO schedule row anywhere: ${unscheduled.slice(0, 8).join(' ')}`
        : '',
      doubled.length
        ? `${doubled.length} tag(s) scheduled more than once: ` +
          doubled.slice(0, 6).map(([t, rs]) => `${t} on ${rs.map((r) => r.sheet).join('+')}`).join(', ')
        : '',
    ]
      .filter(Boolean)
      .join('; ') + ` (plan tags ${tags.length}, rows ${rows.length} across ${[a02.no, ...contSheets.map((s) => s.no)].join('+')})`,
  )

  // --- 1.5b no orphan rows --------------------------------------------------
  const orphans = rows.filter((r) => !tags.includes(r.tag))
  c.ok(
    `${pack} no schedule row is an orphan`,
    orphans.length === 0,
    orphans.length
      ? `${orphans.length} row(s) specify an opening the plan does not tag: ` +
        orphans.slice(0, 8).map((r) => `${r.tag} on ${r.sheet}`).join(' ')
      : '',
  )

  // --- 1.5c the continuation pointer resolves -------------------------------
  const ptr = continuationPointer(a02Words)
  const contRows = rows.filter((r) => r.sheet !== a02.no)
  const deliveredNos = SHEETS.filter((s) => s.no).map((s) => s.no)
  const why = []
  if (contRows.length === 0 && ptr) why.push(`nothing overflowed but A.02 still says "${ptr.text}"`)
  if (contRows.length > 0 && !ptr) why.push(`${contRows.length} row(s) sit on ${contSheets.map((s) => s.no).join('+')} with no pointer on A.02`)
  if (contRows.length > 0 && ptr) {
    if (ptr.count === null) why.push(`the pointer does not parse: "${ptr.text}"`)
    else {
      for (const no of new Set([ptr.first, ptr.last])) {
        if (!deliveredNos.includes(no)) why.push(`the pointer names ${no}, which the delivered set does not carry`)
        else if (!contSheets.some((s) => s.no === no)) why.push(`the pointer names ${no}, which is not a continuation sheet`)
      }
      if (ptr.count !== contRows.length) why.push(`the pointer says (${ptr.count} MORE) but ${contRows.length} row(s) are continued`)
    }
  }
  c.ok(`${pack}/A02 the continuation pointer resolves`, why.length === 0, why.join('; '))

  // --- 1.5d the door rows against CORE STATE --------------------------------
  // The external anchor. (a) and (b) compare two readings of the same artifact;
  // this one compares the delivered rows to the document they are built from,
  // where a count cannot be dropped because the geometry carries it.
  const state = await coreState(pack)
  const doors = state.components.filter((cc) => cc.category === 'Door')
  const doorRows = rows.filter((r) => r.kind === 'Door')
  c.ok(
    `${pack} one schedule row per Door component in core state`,
    doorRows.length === doors.length,
    `${doorRows.length} Door rows across ${[a02.no, ...contSheets.map((s) => s.no)].join('+')}, ` +
      `${doors.length} Door components in core state`,
  )

  // --- 1.5e the window rows against CORE STATE ------------------------------
  // The door half's twin, and the reason it exists (D-O): a glazed run dropped
  // UPSTREAM of `openingSchedule` takes its plan tag and its schedule row with
  // it, so 1.5a/b — two readings of that one contaminated population — agree
  // and see nothing. `glazedRuns` re-derives the runs from the wall geometry
  // itself, which the drop never touched.
  //
  // Matched by WIDTH, greedily nearest-first, because that is the one property
  // of a run the delivered row actually prints. WIDTH_TOL is half the printed
  // 2-dp step: two runs the schedule prints as the same number are the same
  // number to a reader, so distinguishing them further would be measuring the
  // float, not the drawing.
  const WIDTH_TOL = 0.006
  const runs = glazedRuns(state)
  const winRows = rows.filter((r) => r.kind === 'Window')
  const free = winRows.map((r) => ({ ...r, taken: false }))
  const missing = []
  for (const run of runs) {
    let best = null
    let bestD = Infinity
    for (const r of free) {
      if (r.taken) continue
      const d = Math.abs(r.w - run.len)
      if (d < bestD) {
        bestD = d
        best = r
      }
    }
    if (best && bestD <= WIDTH_TOL) best.taken = true
    else missing.push(run)
  }
  const extra = free.filter((r) => !r.taken)
  const sumRuns = runs.reduce((s, r) => s + r.len, 0)
  const sumRows = winRows.reduce((s, r) => s + r.w, 0)
  c.ok(
    `${pack} one schedule row per glazed run in core state`,
    missing.length === 0 && extra.length === 0,
    [
      missing.length
        ? `${missing.length} of ${runs.length} glazed run(s) in core state have NO Window row: ` +
          missing.slice(0, 8).map((r) => `${r.tag} ${r.len.toFixed(2)} m at (${r.x.toFixed(2)}, ${r.y.toFixed(2)})`).join(', ')
        : '',
      extra.length
        ? `${extra.length} Window row(s) specify glass core state does not carry: ` +
          extra.slice(0, 8).map((r) => `${r.tag} ${r.w.toFixed(2)} m on ${r.sheet}`).join(', ')
        : '',
    ]
      .filter(Boolean)
      .join('; ') +
      ` (core-state runs ${runs.length}, Window rows ${winRows.length}, ` +
      `total glazed ${sumRuns.toFixed(2)} m vs ${sumRows.toFixed(2)} m scheduled)`,
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG1', async (c) => {
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)

      // The sheet list is DERIVED per pack — see `sheetsFor` (D-C).
      const SHEETS = sheetsFor(pack)

      // --- 1.4b contents index vs the delivered title blocks -----------------
      const contents = pageWords(pack, 2)
        .map((w) => w.text)
        .filter((t) => /^A\.\d\d$/.test(t))
      const delivered = deliveredSheetNumbers(pack).filter((n) => n !== null)

      for (const sheet of SHEETS) {
        if (!sheet.no) continue
        const g = loadGeometry(pack, sheet.file)
        const img = readPng(path.join(SHEETS_DIR, pack, `${sheet.file}.png`))
        if (img.w !== Math.ceil(g.page.wPt * g.ptToPx) || img.h !== Math.ceil(g.page.hPt * g.ptToPx)) {
          throw new GateError(
            `${pack}/${sheet.file}: raster is ${img.w}×${img.h} px, template says ` +
              `${Math.ceil(g.page.wPt * g.ptToPx)}×${Math.ceil(g.page.hPt * g.ptToPx)}`,
          )
        }
        const words = pageWords(pack, sheet.page)
        const s = g.ptToPx
        const tb = g.titleBlock
        if (!tb) throw new GateError(`${pack}/${sheet.file}: a numbered sheet with no title-block rect`)

        // --- 1.1 title-block purity ----------------------------------------
        const allowed = allowedWords(sheet)
        const foreign = words.filter(
          (w) => rectsOverlap(wordRect(w), tb.pt) && !allowed.has(w.text) && !isScale(w.text),
        )
        c.ok(
          `${pack}/${sheet.file} title-block purity`,
          foreign.length === 0,
          foreign.length
            ? `${foreign.length} foreign word(s) printed over the title block: ` +
              foreign.slice(0, 12).map((w) => w.text).join(' ') +
              (foreign.length > 12 ? ' …' : '') +
              ` (tags ${[...new Set(foreign.filter((w) => isScheduleTag(w.text)).map((w) => w.text))].join(' ') || 'none'})`
            : '',
        )

        // --- 1.2 nothing below / beside the frame --------------------------
        const half = Math.ceil((g.spec.bandStrokePt / 2) * s)
        const bottom = (g.frame.pt.y + g.frame.pt.h) * s + half
        const outs = [
          { name: 'below', rc: { x: 0, y: bottom, w: img.w, h: img.h - bottom } },
          { name: 'left of', rc: { x: 0, y: 0, w: Math.max(0, g.frame.pt.x * s - half), h: img.h } },
          {
            name: 'right of',
            rc: {
              x: (g.frame.pt.x + g.frame.pt.w) * s + half,
              y: 0,
              w: img.w - ((g.frame.pt.x + g.frame.pt.w) * s + half),
              h: img.h,
            },
          },
        ]
        for (const o of outs) {
          let n = 0
          let top = Infinity
          let minx = Infinity
          let maxx = -1
          forEachInk(img, o.rc, (x, y) => {
            n++
            if (y < top) top = y
            if (x < minx) minx = x
            if (x > maxx) maxx = x
          })
          c.ok(
            `${pack}/${sheet.file} no ink ${o.name} the frame`,
            n === 0,
            n ? `${n} ink px, topmost row ${top}, x ${minx}..${maxx}` : '',
          )
        }

        // --- 1.3 sheet-number box purity -----------------------------------
        // Inset 2 px so the box's OWN 0.6 pt outline (sheet.ts:371
        // `{ fill: false, gray: 0.7, width: 0.6 }` — half a stroke = 0.6 px
        // each side) is not counted as content.
        const NB_INSET = 2
        const nb = g.spec.numberBox
        const numWords = words.filter((w) => w.text === sheet.no)
        c.ok(`${pack}/${sheet.file} the sheet number is drawn`, numWords.length >= 1, `no "${sheet.no}" word on the page`)
        const numBoxes = numWords.map((w) => wordRect(w))
        let stray = 0
        let strayAt = null
        const nbPx = {
          x: nb.x * s + NB_INSET,
          y: nb.y * s + NB_INSET,
          w: nb.w * s - NB_INSET * 2,
          h: nb.h * s - NB_INSET * 2,
        }
        forEachInk(img, nbPx, (x, y) => {
          for (const b of numBoxes) {
            if (x >= (b.x - 1) * s && x <= (b.x + b.w + 1) * s && y >= (b.y - 1) * s && y <= (b.y + b.h + 1) * s) return
          }
          stray++
          if (!strayAt) strayAt = `${x},${y}`
        })
        c.ok(
          `${pack}/${sheet.file} sheet-number box carries only "${sheet.no}"`,
          stray === 0,
          stray ? `${stray} foreign ink px inside the number box, first at ${strayAt}` : '',
        )

        // --- 1.4 pagination -------------------------------------------------
        for (const panel of g.panels ?? []) {
          const bottomPt = panel.pt.y + panel.pt.h
          const overflow = words.filter(
            (w) =>
              isScheduleTag(w.text) &&
              w.x0 >= panel.pt.x &&
              w.x1 <= panel.pt.x + panel.pt.w &&
              w.y1 > bottomPt,
          )
          const rows = [...new Set(overflow.map((w) => w.text))]
          c.ok(
            `${pack}/${sheet.file} panel[${panel.id}] schedule overflow paginates`,
            rows.length === 0,
            rows.length
              ? `${rows.length} row(s) (${rows.join(' ')}) print below the panel bottom ${bottomPt} pt — ` +
                'overflow belongs on a continuation sheet, not past the panel'
              : '',
          )
        }
      }

      // --- 1.4b -------------------------------------------------------------
      // Both sides read off the ARTIFACT: the index page's own A.NN list, and
      // the number each delivered title block carries in its number box.
      c.ok(
        `${pack} contents index lists every numbered sheet`,
        contents.join(',') === delivered.join(','),
        `contents = [${contents.join(' ')}], delivered title blocks = [${delivered.join(' ')}]`,
      )

      // --- 1.5 schedule completeness ----------------------------------------
      await scheduleCompleteness(c, pack, SHEETS)
    }
  })
}

process.exit((await main()) ? 0 : 1)
