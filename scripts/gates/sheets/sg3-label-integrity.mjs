// SG3 — LABEL INTEGRITY.  Every room's name is drawn once, whole, legible and
// identical on every sheet that names it.
//
//   node scripts/gates/sheets/sg3-label-integrity.mjs [--pack seeded,dwg]
//
// GROUND TRUTH IS CORE STATE.  The expected display string for a room is
// `zone.label` from the document the sheets are built from (`scheduledRooms`),
// never a string scraped off a sheet.  The gate then LOCATES that string in the
// delivered artifact — poppler's own reading of the delivered glyph runs, laid
// out with the very font it rasterises with, so the text extents are measured
// rather than estimated (the producer's `textWidth()` estimator is not used, and
// could not be trusted here anyway: it is part of the system under test).
//
// WHAT IT ASSERTS, AND WHAT EACH ASSERTION IS ANCHORED TO
//
//  3.1  Every scheduled room's display string is rendered EXACTLY ONCE on every
//       name-labelled plan sheet (A.02, A.03, A.04).  Zero means the string is
//       not recoverable from the page at all.
//  3.2  No two rendered room labels overlap, counting each label's knockout
//       halo.  Anchor: the halo is the label box padded by half of the `+ 6`
//       in `roomLabelBoxes` (web/src/export/servicesSheets.ts:291) on the
//       services sheets, and half of the `+ 4` in `roomLabels`
//       (web/src/export/sheetSet.ts) on A.02 — both source constants.
//  3.3  No glyph run is cut.  On the RASTER, the widest ink-free column run
//       inside a label word must stay under 0.5 em.  Anchor: Helvetica's own
//       metrics — the widest blank an intra-word glyph pair can leave is the two
//       side bearings, ≈0.26 em for the worst (digit) pair; 0.5 em is ~2× that.
//       Nothing is calibrated against a sheet.
//  3.4  Every sheet renders the IDENTICAL display string for the same room:
//       A.02/A.03/A.04 carry `label.toUpperCase()`, A.09 carries `label`, and
//       the two must agree case-insensitively, room for room.
//  3.5  No label is truncated: no room's name is rendered as a shortened form
//       ending in an ellipsis (`clip()` in sheet.ts is the only truncator).
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — actual output at HEAD (1748bdf), before any defect was fixed:
//
//   $ node scripts/gates/sheets/sg3-label-integrity.mjs
//   SG3 FAIL (295 checks, 17 failing)
//
//   FAIL seeded/A03 no two room labels overlap — 7 overlapping pair(s):
//        FOCUS ROOM 1 ↔ FOCUS ROOM 2 | PRINT POINT 1 ↔ PRINT POINT 2 |
//        PRINT POINT 2 ↔ PHONE BOOTH 1 | PRINT POINT 2 ↔ PHONE BOOTH 2 |
//        PHONE BOOTH 1 ↔ PHONE BOOTH 2 | PHONE BOOTH 1 ↔ PHONE BOOTH 3 |
//        PHONE BOOTH 2 ↔ PHONE BOOTH 3
//        — S0's "PRINT POIN" and "PHON PHON PHONE BOOTH 3", named as pairs
//   FAIL seeded/A04 … the same 7 pairs
//   FAIL seeded/A03 no glyph run is cut — POINT at (438.5,267.8)pt has an 8 px
//        (0.53 em) ink-free column run inside its own box
//   FAIL seeded/A04 … the same word
//   FAIL dwg/A03 no two room labels overlap — 14 overlapping pair(s):
//        MEETING ROOM 1 ↔ MEETING ROOM 2 | FOCUS ROOM 2 ↔ RECEPTION |
//        STORAGE ↔ PRINT POINT 2 | PRINT POINT 1 ↔ PRINT POINT 2 |
//        IT / SERVER ↔ OPEN WORKSPACE (2) | PHONE BOOTH 1 ↔ PHONE BOOTH 2 | …
//   FAIL dwg/A04 … the same 14 pairs
//   FAIL dwg/A03 room 118 "Wellness Room" rendered exactly once — rendered 0×:
//        the collision has interleaved another label's glyphs so far into this
//        one that poppler reads "W" + "ELLNESS" as two words. The room's own
//        name is NOT RECOVERABLE from the delivered page. (Not in S0's report:
//        S0 saw "WELLNESS ROOm" on seeded; on dwg the same defect destroys the
//        string outright.)
//   FAIL dwg/A04 room 118 "Wellness Room" rendered 0×
//   FAIL dwg/A02,A03,A04 rooms 246, 247, 248 "Open Workspace" rendered 3× each
//        — SG4's defect surfacing here as a 3.1 uniqueness failure
//
//   testfit/A03 and testfit/A04 PASS 3.2 with 0 overlapping pairs, and
//   seeded/A02 and dwg/A02 pass it too — the evidence that 3.2 is measuring
//   collisions, not just printing red.
// ---------------------------------------------------------------------------

import path from 'node:path'
import {
  PACKS,
  SHEETS_DIR,
  loadGeometry,
  readPng,
  pageWords,
  coreState,
  scheduledRooms,
  findLabelRuns,
  widestInteriorGap,
  rectsOverlap,
  runGate,
  GateError,
} from './lib/sheetlib.mjs'

/** The plan sheets that print room names, and each one's halo pad (pt): half of
 *  the `+ N` a label box is built with in its own module. */
const NAMED = [
  { file: 'A02', page: 4, pad: 2 },
  { file: 'A03', page: 5, pad: 3 },
  { file: 'A04', page: 6, pad: 3 },
]
const SCHEDULE = { file: 'A09', page: 11 }

/** 3.3's ceiling, in em. See the header: a Helvetica bound, not a fit. */
const MAX_INTERIOR_GAP_EM = 0.5
/** The face room labels are drawn at: 8 pt on A.02, 7.5 pt on A.03/A.04. The
 *  smaller face gives the tighter px budget, so it is the one to divide by. */
const LABEL_PT = 7.5

const key = (b) => `${b.x.toFixed(2)},${b.y.toFixed(2)},${b.w.toFixed(2)}`

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG3', async (c) => {
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)
      const rooms = scheduledRooms(await coreState(pack))
      if (rooms.length === 0) throw new GateError(`${pack}: core state has no scheduled rooms`)
      const expected = rooms.map((r) => r.label.toUpperCase())

      for (const sheet of NAMED) {
        const g = loadGeometry(pack, sheet.file)
        const img = readPng(path.join(SHEETS_DIR, pack, `${sheet.file}.png`))
        const words = pageWords(pack, sheet.page)

        // --- 3.1 one rendering per room -----------------------------------
        const instances = new Map() // box key → { text, box }
        for (const r of rooms) {
          const want = r.label.toUpperCase()
          const runs = findLabelRuns(words, want, expected)
          c.ok(
            `${pack}/${sheet.file} room ${r.id} "${r.label}" rendered exactly once`,
            runs.length === 1,
            runs.length === 0
              ? 'rendered 0× — the string is not recoverable from the delivered page ' +
                '(an overlapping label has broken the glyph run)'
              : `rendered ${runs.length}×`,
          )
          for (const run of runs) instances.set(key(run.box), run)
        }

        // --- 3.2 no two labels overlap --------------------------------------
        const inst = [...instances.values()]
        const pad = sheet.pad
        const pairs = []
        for (let a = 0; a < inst.length; a++) {
          for (let b = a + 1; b < inst.length; b++) {
            const A = { x: inst[a].box.x - pad, y: inst[a].box.y, w: inst[a].box.w + pad * 2, h: inst[a].box.h }
            const B = { x: inst[b].box.x - pad, y: inst[b].box.y, w: inst[b].box.w + pad * 2, h: inst[b].box.h }
            if (rectsOverlap(A, B)) pairs.push(`${inst[a].text} ↔ ${inst[b].text}`)
          }
        }
        c.ok(
          `${pack}/${sheet.file} no two room labels overlap`,
          pairs.length === 0,
          pairs.length ? `${pairs.length} overlapping pair(s): ${pairs.slice(0, 8).join(' | ')}${pairs.length > 8 ? ' | …' : ''}` : '',
        )

        // --- 3.3 no cut glyph runs (raster) ---------------------------------
        const limitPx = MAX_INTERIOR_GAP_EM * LABEL_PT * g.ptToPx
        const cut = []
        for (const run of inst) {
          for (const w of run.words) {
            const gap = widestInteriorGap(img, { x: w.x0, y: w.y0, w: w.x1 - w.x0, h: w.y1 - w.y0 }, g.ptToPx)
            if (gap.gapPx > limitPx) {
              cut.push(
                `${w.text} at (${w.x0.toFixed(1)},${w.y0.toFixed(1)})pt has a ${gap.gapPx} px ` +
                  `(${(gap.gapPx / g.ptToPx / LABEL_PT).toFixed(2)} em) ink-free column run inside its own box`,
              )
            }
          }
        }
        c.ok(
          `${pack}/${sheet.file} no glyph run is cut`,
          cut.length === 0,
          cut.length ? `${cut.length}: ${cut.slice(0, 4).join('; ')}` : '',
        )

        // --- 3.5 no truncation ----------------------------------------------
        const truncated = words.filter(
          (w) => /(\.\.\.|…)$/.test(w.text) && expected.some((e) => e.startsWith(w.text.replace(/(\.\.\.|…)$/, ''))),
        )
        c.ok(
          `${pack}/${sheet.file} no room name is truncated`,
          truncated.length === 0,
          truncated.map((w) => `"${w.text}"`).join(' '),
        )
      }

      // --- 3.4 the same string on every sheet --------------------------------
      const schedWords = pageWords(pack, SCHEDULE.page)
      for (const r of rooms) {
        const onSchedule = findLabelRuns(
          schedWords,
          r.label,
          rooms.map((x) => x.label),
        )
        c.ok(
          `${pack}/A09 room ${r.id} "${r.label}" appears in the finish schedule`,
          onSchedule.length >= 1,
          `found ${onSchedule.length}× on A.09 while the plan sheets carry "${r.label.toUpperCase()}"`,
        )
      }
    }
  })
}

process.exit((await main()) ? 0 : 1)
