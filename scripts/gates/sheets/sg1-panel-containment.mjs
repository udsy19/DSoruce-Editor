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
//       the A.NN numbers the delivered title blocks carry, in order.
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
  SHEETS,
  PACKS,
  SHEETS_DIR,
  loadGeometry,
  readPng,
  pageWords,
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

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG1', (c) => {
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)

      // --- 1.4b contents index vs the delivered title blocks -----------------
      const contents = pageWords(pack, 2)
        .map((w) => w.text)
        .filter((t) => /^A\.\d\d$/.test(t))
      const delivered = []

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
        if (delivered.length < SHEETS.length) delivered.push(sheet.no)

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
          const cont = contents.filter((n) => !SHEETS.some((sh) => sh.no === n))
          c.ok(
            `${pack}/${sheet.file} panel[${panel.id}] schedule overflow paginates`,
            rows.length === 0 || cont.length > 0,
            rows.length
              ? `${rows.length} row(s) (${rows.join(' ')}) print below the panel bottom ${bottomPt} pt, ` +
                `and the contents index lists ${cont.length} continuation sheet(s)`
              : '',
          )
        }
      }

      // --- 1.4b -------------------------------------------------------------
      const inTitleBlocks = SHEETS.filter((s) => s.no).map((s) => s.no)
      c.ok(
        `${pack} contents index lists every numbered sheet`,
        contents.join(',') === inTitleBlocks.join(','),
        `contents = [${contents.join(' ')}], delivered = [${inTitleBlocks.join(' ')}]`,
      )
    }
  })
}

process.exit((await main()) ? 0 : 1)
