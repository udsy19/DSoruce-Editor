// SG4 — NAME UNIQUENESS.  Two rooms are never given the same name on a drawing,
// and whatever disambiguates them is the same on every sheet AND in the QTO
// workbook.
//
//   node scripts/gates/sheets/sg4-name-uniqueness.mjs [--pack seeded,dwg]
//
// WHAT IT ASSERTS, AND WHAT EACH ASSERTION IS ANCHORED TO
//
//  4.1  CORE STATE.  No two scheduled rooms may end up with the same display
//       name.  Checked on the document AND on the delivered pages, because the
//       drawing layer is where the disambiguation is meant to happen: if two
//       zones share a label, the sheets must still print two distinct strings.
//  4.2  A.02/A.03/A.04.  No rendered room-name string appears more than once.
//       (The plan labels carry no room id, so a repeated string IS the defect —
//       a reader cannot tell the rooms apart.)
//  4.3  A.09.  The finish schedule's rows are parsed straight out of the
//       delivered text layer — leftmost word on a baseline is the room id, the
//       single-space run after it is the name — and no two rows may share a
//       name.  Every id must be a zone id from CORE STATE, and every row's name
//       must be its zone's label, optionally followed by a deterministic
//       ` (n)` ordinal.  Nothing else is admissible: a suffix scheme the gate
//       cannot predict is a suffix scheme that can drift.
//  4.4  THE WORKBOOK.  `out/cases/<pack>/quantity-takeoff.xlsx`, Inventory sheet,
//       columns `Room ID` and `Program Room Name`, must agree with A.09 row for
//       row.  Two artifacts, one name per room, or the deliverable contradicts
//       itself.
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — actual output at HEAD (1748bdf), before any defect was fixed:
//
//   $ node scripts/gates/sheets/sg4-name-uniqueness.mjs
//   SG4 FAIL (33 checks, 6 failing)
//
//   FAIL dwg core state gives every scheduled room a distinct name —
//        "Open Workspace" is the label of 3 zones: 246, 247, 248
//   FAIL dwg/A02 no room name is rendered twice — "OPEN WORKSPACE" rendered 3×
//        at (469,101) (407,130) (416,159)
//   FAIL dwg/A03 no room name is rendered twice — "OPEN WORKSPACE" rendered 3×
//        at (412,130) (421,130) (473,130)
//   FAIL dwg/A04 no room name is rendered twice — same three
//   FAIL dwg/A09 no two schedule rows share a room name — "Open Workspace"
//        on rows 246, 247, 248
//   FAIL dwg workbook Inventory names are unique — "Open Workspace" on rooms
//        246, 247, 248
//
//   Note what 4.4 does NOT say: the workbook and A.09 AGREE, room for room, in
//   all three packs. A cross-artifact consistency check alone would have been
//   green on this defect — it is 4.1-4.3 that catch it, and 4.4 is what stops
//   the fix from being applied to one artifact and not the other.
//
//   seeded and testfit PASS all of 4.1-4.4 — 22 rooms, 22 distinct names, 22
//   schedule rows, and a workbook that agrees with every one of them.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  REPO,
  PACKS,
  pageWords,
  loadGeometry,
  coreState,
  scheduledRooms,
  findLabelRuns,
  must,
  runGate,
  GateError,
} from './lib/sheetlib.mjs'

const NAMED = [
  { file: 'A02', page: 4 },
  { file: 'A03', page: 5 },
  { file: 'A04', page: 6 },
]
const SCHEDULE_PAGE = 11
/** Helvetica's space advance at the schedule's face, plus slack — the same
 *  single-space rule `findLabelRuns` uses to decide what is one drawn string. */
const WORD_GAP = 3.5

/**
 * The finish schedule's rows, read out of the delivered page: group words by
 * baseline, keep the lines whose leftmost word is an integer (the ROOM ID
 * column), and take the single-space run that follows as ROOM NAME.
 */
function scheduleRows(words, bandTop) {
  const lines = new Map()
  // Above the title-block band only: the band's own address line starts with
  // "46 Residency Road…", which would otherwise parse as room 46.
  for (const w of words.filter((x) => x.y1 <= bandTop)) {
    const k = w.y0.toFixed(2)
    if (!lines.has(k)) lines.set(k, [])
    lines.get(k).push(w)
  }
  const rows = []
  for (const line of lines.values()) {
    line.sort((a, b) => a.x0 - b.x0)
    if (!/^\d+$/.test(line[0].text)) continue
    const name = [line[1]]
    if (!name[0]) continue
    for (let i = 2; i < line.length; i++) {
      if (line[i].x0 - name[name.length - 1].x1 > WORD_GAP) break
      name.push(line[i])
    }
    rows.push({ id: Number(line[0].text), name: name.map((w) => w.text).join(' '), y: line[0].y0 })
  }
  return rows.sort((a, b) => a.y - b.y)
}

/** Minimal xlsx reader: worksheet cells as {ref: text}. Inline strings only —
 *  which is what `qtoWorkbook.ts` writes (there is no sharedStrings part). */
function xlsxSheet(file, sheetName) {
  const buf = must(file, 'produce the pack first: node scripts/export-pack.mjs')
  const eocd = buf.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'))
  if (eocd < 0) throw new GateError(`${path.relative(REPO, file)}: no ZIP end-of-central-directory — the workbook is truncated`)
  let cd = buf.readUInt32LE(eocd + 16)
  const n = buf.readUInt16LE(eocd + 10)
  const entries = new Map()
  for (let i = 0; i < n; i++) {
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const name = buf.toString('latin1', cd + 46, cd + 46 + nameLen)
    const lho = buf.readUInt32LE(cd + 42)
    const method = buf.readUInt16LE(cd + 10)
    const size = buf.readUInt32LE(cd + 20)
    entries.set(name, { lho, method, size })
    cd += 46 + nameLen + extraLen + commentLen
  }
  const read = (name) => {
    const e = entries.get(name)
    if (!e) throw new GateError(`${path.relative(REPO, file)}: no member ${name}`)
    const nl = buf.readUInt16LE(e.lho + 26)
    const el = buf.readUInt16LE(e.lho + 28)
    const start = e.lho + 30 + nl + el
    const raw = buf.subarray(start, start + e.size)
    return (e.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8')
  }
  const wb = read('xl/workbook.xml')
  const sheets = [...wb.matchAll(/<sheet name="([^"]+)"[^>]*?r:id="rId(\d+)"/g)].map((m) => [m[1], Number(m[2])])
  const idx = sheets.findIndex(([nm]) => nm === sheetName)
  if (idx < 0) throw new GateError(`${path.relative(REPO, file)}: no worksheet named "${sheetName}" (has ${sheets.map((s) => s[0]).join(', ')})`)
  const xml = read(`xl/worksheets/sheet${idx + 1}.xml`)
  const cells = new Map()
  for (const m of xml.matchAll(/<c [^>]*?r="([A-Z]+\d+)"[^>]*?>([\s\S]*?)<\/c>/g)) {
    const t = m[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)
    const v = m[2].match(/<v>([\s\S]*?)<\/v>/)
    const text = (t ? t[1] : v ? v[1] : '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    cells.set(m[1], text)
  }
  return cells
}

/** A rendered name is admissible iff it is the zone's own label, optionally
 *  followed by a deterministic ` (n)` ordinal. */
const SUFFIX = /^ \(\d+\)$/
function admissible(rendered, label) {
  if (rendered === label) return true
  return rendered.startsWith(label) && SUFFIX.test(rendered.slice(label.length))
}

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG4', async (c) => {
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)
      const rooms = scheduledRooms(await coreState(pack))
      const byId = new Map(rooms.map((r) => [r.id, r]))

      // --- 4.1 core state ----------------------------------------------------
      const byLabel = new Map()
      for (const r of rooms) {
        if (!byLabel.has(r.label)) byLabel.set(r.label, [])
        byLabel.get(r.label).push(r.id)
      }
      const clashes = [...byLabel.entries()].filter(([, ids]) => ids.length > 1)
      c.ok(
        `${pack} core state gives every scheduled room a distinct name`,
        clashes.length === 0,
        clashes.map(([nm, ids]) => `"${nm}" is the label of ${ids.length} zones: ${ids.join(', ')}`).join('; '),
      )

      // --- 4.2 the plan sheets ----------------------------------------------
      const expected = rooms.map((r) => r.label.toUpperCase())
      for (const sheet of NAMED) {
        const words = pageWords(pack, sheet.page)
        const dupes = []
        for (const name of new Set(expected)) {
          const runs = findLabelRuns(words, name, expected)
          if (runs.length > 1) {
            dupes.push(
              `"${name}" rendered ${runs.length}× at ` +
                runs.map((r) => `(${r.box.x.toFixed(0)},${r.box.y.toFixed(0)})`).join(' '),
            )
          }
        }
        c.ok(
          `${pack}/${sheet.file} no room name is rendered twice`,
          dupes.length === 0,
          dupes.join('; '),
        )
      }

      // --- 4.3 the finish schedule ------------------------------------------
      const gA09 = loadGeometry(pack, 'A09')
      const rows = scheduleRows(pageWords(pack, SCHEDULE_PAGE), gA09.titleBlock.pt.y)
      c.ok(
        `${pack}/A09 one schedule row per scheduled room`,
        rows.length === rooms.length,
        `${rows.length} rows parsed off the delivered page, ${rooms.length} scheduled rooms in core state`,
      )
      const seen = new Map()
      for (const r of rows) {
        if (!seen.has(r.name)) seen.set(r.name, [])
        seen.get(r.name).push(r.id)
      }
      const rowDupes = [...seen.entries()].filter(([, ids]) => ids.length > 1)
      c.ok(
        `${pack}/A09 no two schedule rows share a room name`,
        rowDupes.length === 0,
        rowDupes.map(([nm, ids]) => `"${nm}" on rows ${ids.join(', ')}`).join('; '),
      )
      const alien = rows.filter((r) => !byId.has(r.id))
      c.ok(
        `${pack}/A09 every schedule row is a zone from core state`,
        alien.length === 0,
        alien.map((r) => `row id ${r.id}`).join(' '),
      )
      const wrong = rows.filter((r) => byId.has(r.id) && !admissible(r.name, byId.get(r.id).label))
      c.ok(
        `${pack}/A09 every row's name is its zone label plus at most a " (n)" ordinal`,
        wrong.length === 0,
        wrong.map((r) => `row ${r.id}: "${r.name}" vs core label "${byId.get(r.id).label}"`).join('; '),
      )

      // --- 4.4 the workbook --------------------------------------------------
      const xlsx = path.join(REPO, 'out/cases', pack, 'quantity-takeoff.xlsx')
      if (!fs.existsSync(xlsx)) {
        throw new GateError(
          `missing input: out/cases/${pack}/quantity-takeoff.xlsx — the workbook is half of SG4's ` +
            'cross-artifact check; produce it with `node scripts/export-pack.mjs`',
        )
      }
      const cells = xlsxSheet(xlsx, 'Inventory')
      // Locate the header row by its two column titles, then read down.
      let idCol = null
      let nameCol = null
      let headerRow = null
      for (const [ref, text] of cells) {
        const m = ref.match(/^([A-Z]+)(\d+)$/)
        if (text === 'Room ID') {
          idCol = m[1]
          headerRow = Number(m[2])
        }
        if (text === 'Program Room Name') nameCol = m[1]
      }
      if (!idCol || !nameCol) throw new GateError(`${pack}: Inventory has no "Room ID"/"Program Room Name" header`)
      const wbRows = []
      for (let r = headerRow + 1; r < headerRow + 400; r++) {
        const id = cells.get(`${idCol}${r}`)
        if (id === undefined || id === '') continue
        wbRows.push({ id: Number(id), name: cells.get(`${nameCol}${r}`) ?? '' })
      }
      c.ok(`${pack} workbook Inventory has rows`, wbRows.length > 0, 'no Inventory rows found')
      const sheetById = new Map(rows.map((r) => [r.id, r.name]))
      const disagree = wbRows.filter((w) => sheetById.has(w.id) && sheetById.get(w.id) !== w.name)
      c.ok(
        `${pack} workbook Inventory names agree with A.09`,
        disagree.length === 0,
        disagree.map((w) => `room ${w.id}: workbook "${w.name}" vs A.09 "${sheetById.get(w.id)}"`).join('; '),
      )
      const wbDupes = [...wbRows.reduce((m, w) => m.set(w.name, [...(m.get(w.name) ?? []), w.id]), new Map())].filter(
        ([, ids]) => ids.length > 1,
      )
      c.ok(
        `${pack} workbook Inventory names are unique`,
        wbDupes.length === 0,
        wbDupes.map(([nm, ids]) => `"${nm}" on rooms ${ids.join(', ')}`).join('; '),
      )
    }
  })
}

process.exit((await main()) ? 0 : 1)
