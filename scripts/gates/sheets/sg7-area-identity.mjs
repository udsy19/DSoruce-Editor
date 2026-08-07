// SG7 — AREA IDENTITY.  Every m² a delivered sheet prints for a room is the
// core's area for that room.
//
//   node scripts/gates/sheets/sg7-area-identity.mjs [--pack seeded,dwg]
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// Sheet A.09's `AREA m²` column and the room label on every plan sheet were
// computed in TypeScript from the zone SHAPE — raw, unclipped, un-de-overlapped
// — while the QTO workbook billed the same rooms off the core's basis. On the
// UNEDITED F1 fixture that put `Open Workspace (2)` on paper at **35.0 m²**
// against the workbook's **8.0**, a factor of 4.4, inside one delivered pack.
//
// It shipped under a 49/49 green board and a 12/12 sheet board for one reason:
// **nothing anywhere read the sheet's area column.** Every gate that touched
// area read the workbook, which was right. The lie lived on the one surface no
// instrument had ever looked at, which is where lies live.
//
// So the sheet becomes a READ surface. Nothing about the fix protects it — a
// future consumer can recompute an area again tomorrow, and
// `scripts/gates/area-census.mjs` only sees the forms it knows how to spell.
// This gate does not read source at all.
//
// ── INDEPENDENCE (.claude/rules/gate-independence.md) ───────────────────────
//
// Both sides are re-derived, and they are re-derived from DIFFERENT places:
//
//   * the EXPECTED areas come from the CORE — `Editor.quantities()` on the
//     document the pack was built from. The core is not the system under test
//     here; the drawing/export layer is.
//   * the DELIVERED areas come from the PDF BYTES — poppler's own measurement
//     of the shipped glyph runs (`pageWords`), never the exporter's account of
//     what it drew.
//
// The two surfaces are NOT compared against each other. Sheet-vs-workbook would
// be presence-matching two artifact-derived lists — the mutual-contamination
// shape the rules file names — and it would go green the moment both surfaces
// drifted the same way. Each is held to core state on its own, so identity
// between them is a consequence rather than the assertion.
//
// Rows are keyed by ZONE ID, which A.09 prints in its own `ID` column
// (`finishSchedule.ts` draws `String(r.id)`), so no name matching is involved
// on the assertion that matters.
//
// ── FALSIFICATION (R3) ──────────────────────────────────────────────────────
//
// The motivating defect IS the falsification, and it was run in that order: the
// gate was written first and pointed at the sheets already on disk, which had
// been rendered from the pre-fix build. Result recorded in the ledger.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PACKS,
  REPO,
  GateError,
  coreState,
  pageWords,
  scheduledRooms,
  sheetsFor,
  runGate,
} from './lib/sheetlib.mjs'

/** Printed precision of every area on a sheet: `toFixed(1)`. Two cells that
 *  round to the same tenth are the same number as far as paper is concerned. */
const TOL = 0.05

/**
 * THE CORE's per-zone areas for a pack, zone id → m².
 *
 * `Editor.quantities()`, straight off the document the pack was built from.
 * This is the same basis the Statistics panel and the workbook read; it is an
 * INPUT to the drawing layer, never a readback of it.
 */
const areaCache = new Map()
async function coreAreas(pack) {
  if (areaCache.has(pack)) return areaCache.get(pack)
  const { buildCaseDoc } = await import(path.join(REPO, 'scripts/render-sheets.mjs'))
  const doc = await buildCaseDoc(pack)
  const rooms = doc?.quantities?.rooms
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new GateError(
      `${pack}: Editor.quantities() returned no room rows — the gate has no ground truth. ` +
        'A missing input is a FAILURE, never a skip.',
    )
  }
  const m = new Map(rooms.map((r) => [r.roomId, r.areaM2]))
  areaCache.set(pack, m)
  return m
}

/** Group words into visual rows by baseline proximity. */
function rowsOf(words, tol = 4) {
  const sorted = [...words].sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0)
  const rows = []
  for (const w of sorted) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.y - w.y1) <= tol) {
      last.words.push(w)
      continue
    }
    rows.push({ y: w.y1, words: [w] })
  }
  for (const r of rows) r.words.sort((a, b) => a.x0 - b.x0)
  return rows
}

/**
 * The `AREA m²` column's x-range, taken from the DELIVERED HEADER — not from
 * `COLS` in the source. The header is right-aligned and so are its cells, so
 * the band runs from a little left of the header to a little right of it.
 */
function areaColumn(words) {
  const area = words.filter((w) => w.text === 'AREA')
  if (area.length !== 1) {
    throw new GateError(`expected exactly one 'AREA' header word on the schedule sheet, found ${area.length}`)
  }
  const h = area[0]
  // The header row also carries the `m²` token; take the union so a cell that
  // sits under either part is inside the band. Widen left by the column width
  // the header sits at the right edge of (66 pt), narrow enough not to reach
  // `CLG HT` (56 pt further left).
  return { x0: h.x0 - 50, x1: h.x1 + 30, y: h.y1 }
}

/** `12.7` from a right-aligned numeric cell, or null. */
function numeric(text) {
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null
}

async function body(c) {
  const only = (() => {
    const i = process.argv.indexOf('--pack')
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : PACKS
  })()

  for (const pack of only) {
    const state = await coreState(pack)
    const areas = await coreAreas(pack)
    const rooms = scheduledRooms(state)
    const sheets = sheetsFor(pack)

    // ---- 7.1  A.09's AREA column, keyed by the ID column ------------------
    //
    // The schedule paginates, so every sheet titled 'Room Finish Schedule' is
    // read, not just A.09.
    const schedulePages = sheets.filter((s) => s.title === 'Room Finish Schedule').map((s) => s.page)
    c.ok(
      `${pack}: the set carries at least one Room Finish Schedule sheet`,
      schedulePages.length > 0,
      `sheets: ${sheets.map((s) => s.no ?? s.file).join(' ')}`,
    )

    const printed = new Map() // zone id → area printed on the schedule
    for (const page of schedulePages) {
      const words = pageWords(pack, page)
      let col
      try {
        col = areaColumn(words)
      } catch (err) {
        c.ok(`${pack} p${page}: the AREA column header is findable`, false, err.message)
        continue
      }
      for (const row of rowsOf(words)) {
        // Header row and the legend/notes strip carry no numeric ID.
        const id = numeric(row.words[0]?.text ?? '')
        if (id === null || !Number.isInteger(id)) continue
        if (row.y <= col.y + 2) continue // the header itself
        const cell = row.words.filter((w) => w.x0 >= col.x0 && w.x1 <= col.x1).map((w) => numeric(w.text)).filter((v) => v !== null)
        if (cell.length === 0) continue
        printed.set(id, cell[cell.length - 1])
      }
    }

    // Completeness first — an area check over an empty row set is vacuous, and
    // "the gate found nothing to check" must never read as "everything agrees".
    c.ok(
      `${pack}: every scheduled room has an AREA cell on the delivered schedule`,
      rooms.every((r) => printed.has(r.id)),
      `missing: ${rooms.filter((r) => !printed.has(r.id)).map((r) => `${r.id} "${r.display}"`).slice(0, 6).join(', ')}`,
    )
    c.ok(
      `${pack}: the schedule prints no room the core does not have`,
      [...printed.keys()].every((id) => areas.has(id)),
      `orphan ids: ${[...printed.keys()].filter((id) => !areas.has(id)).slice(0, 6).join(', ')}`,
    )
    c.ok(`${pack}: the schedule is non-empty`, printed.size > 0, `${printed.size} rows read`)

    for (const r of rooms) {
      const got = printed.get(r.id)
      if (got === undefined) continue // already failed above; do not double-count
      const want = areas.get(r.id)
      c.ok(
        `${pack} A.09 room ${r.id} "${r.display}" prints the core's area`,
        want !== undefined && Math.abs(got - want) <= TOL,
        `sheet ${got} m² · core ${want === undefined ? 'ABSENT' : want.toFixed(3)} m²` +
          (want ? ` (${(got / want).toFixed(2)}x)` : ''),
      )
    }

    // ---- 7.2  plan-sheet room labels --------------------------------------
    //
    // `roomLabels` draws the name and, directly beneath it, `NN.N m²`. Every
    // such value on a plan sheet must be SOME scheduled room's core area. This
    // is deliberately the weaker multiset form rather than a name→area pairing:
    // the label ladder may wrap, shrink or abbreviate a name, so pairing by
    // proximity would fail for reasons that have nothing to do with areas —
    // and a raw extent still cannot hide here, because 35.0 is nobody's.
    const wanted = new Set([...areas.values()].map((v) => v.toFixed(1)))
    const planPages = sheets.filter((s) => s.no === 'A.01' || s.no === 'A.02').map((s) => s.page)
    let labelAreas = 0
    for (const page of planPages) {
      const words = pageWords(pack, page)
      for (let i = 0; i < words.length; i++) {
        if (!/^m²$/.test(words[i].text)) continue
        const prev = words[i - 1]
        const v = prev ? numeric(prev.text) : null
        if (v === null) continue
        labelAreas++
        c.ok(
          `${pack} p${page}: plan label area ${v.toFixed(1)} m² is a core room area`,
          wanted.has(v.toFixed(1)),
          `printed ${v.toFixed(1)} m²; core areas are {${[...wanted].sort((a, b) => a - b).join(', ')}}`,
        )
      }
    }
    c.note(`${pack}: ${printed.size} schedule rows · ${labelAreas} plan-label areas · ${rooms.length} scheduled rooms`)
    c.ok(
      `${pack}: the plan sheets print at least one room-label area (the label check is not vacuous)`,
      labelAreas > 0,
      `${labelAreas} found on pages ${planPages.join(',')}`,
    )
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit((await runGate('SG7', body)) ? 0 : 1)
export { body as sg7Body }
