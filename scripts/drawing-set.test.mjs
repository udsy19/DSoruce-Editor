// Regression cover for the architectural drawing set (sheetSet.ts).
//
//   node scripts/drawing-set.test.mjs                # check against the baseline
//   node scripts/drawing-set.test.mjs --update --why '<attribution>'
//                                                    # re-record it (LOOK FIRST).
//                                                    # --why is REQUIRED: an
//                                                    # unattributed digest is a
//                                                    # claim nobody can audit.
//   node scripts/drawing-set.test.mjs --dump <dir>   # write every sheet's digest
//                                                    # rows, to diff two versions
//
// WHY THIS EXISTS. `placeNear` is shared: the plan graphic (gate G4/G11) and
// every plan sheet in this set lay their labels out through it. Commit 2420722
// changed its all-candidates-collide fallback and nothing in the repo rendered
// a single sheet of this set — report.test.mjs asserts model-level KPIs, and G4
// only ever looks at plan.png. A change to shared placement machinery shipped
// with zero cover on this path; this file is that cover.
//
// GATE INDEPENDENCE (.claude/rules/gate-independence.md). Every assertion is
// re-derived, never read back from the producer:
//   * the drawn side is parsed out of the PDF BYTES — the content streams are
//     uncompressed (pdf.ts keeps them that way on purpose), so each drawing op
//     is read straight off the wire. No `Page.ops` object is consulted;
//   * the expected side is the CORE STATE — the Rust generator re-run in Node
//     (scripts/lib/demo-doc.mjs) — projected through a world->sheet transform
//     this file recomputes from the model (a deliberate second derivation of
//     pdf.ts's fit: if the renderer's fit and this one diverge, the room checks
//     fail loudly rather than measuring nothing);
//   * a MISSING baseline is a FAILURE, never a skip.
//
// EVERY CASE IS GRADED, ALWAYS. A failing assertion is RECORDED, not thrown:
// the first `assert.ok` to fire used to abort the whole run, so a single red
// check (the baseline hand-off) left the SECOND case — dwg — never rendered and
// never graded, and SG5 counted 25 checks where it expects 27
// (reports/sheets-defects-1.md, D-F). Each case now runs inside its own
// try/catch, failures accumulate, and the process still exits non-zero.
//
// What it asserts, per case (seeded + dwg):
//   1. STRUCTURE  — the 11 unconditional sheets, each expected title present
//      exactly once, plus ONE continuation sheet per further page. The count is
//      DERIVED: A.02's schedule paginates only what its panel cannot hold, so a
//      document with <= 31 tagged openings legitimately has none and the set is
//      11 sheets, not 12.
//   2. DETERMINISM — an independent second render is byte-identical (the same
//      property G4 proves for plan.png, on the path G4 does not look at).
//   3. ROOMS      — every non-circulation zone the core places is labelled
//      exactly once on A.01 and A.02, and every label that sits off its room
//      carries a LEADER whose far end lands inside that room (labelLeader).
//   4. BASELINE   — the full text+vector content digest equals the recorded
//      one, so any layout shift on any sheet has to be looked at and re-blessed
//      rather than shipping unseen.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './lib/demo-doc.mjs'
import { groundZoneTypes } from './gates/sheets/lib/sheetlib.mjs'
import { renderSheetSet, SHEET_META } from './render-sheets.mjs'

const BASELINE = path.join(REPO, 'scripts/fixtures/drawing-set.baseline.json')
const CASES = ['seeded', 'dwg']
const UPDATE = process.argv.includes('--update')
/**
 * **A DIGEST IS A CLAIM ABOUT WHAT SHOULD PRINT, AND A CLAIM CARRIES ITS
 * PROVENANCE.** `--update` alone is refused; every re-record names the fix or
 * the ruling that moved the ink, and the reason is stamped onto each sheet whose
 * md5 actually changed. Sheets that did not move keep the reason they already
 * had.
 *
 * This exists because of what re-recording nearly did here. Nineteen failures
 * stood at base; twelve of them were the test being WRONG (it demanded labels
 * the `isGroundZone` fold forbids) and the rest traced to landed work. A bare
 * `--update` would have frozen all nineteen into the expectation as one
 * undifferentiated blob — laundering a stale predicate into ground truth, and
 * silently blessing a document that had grown a room. Attribution before
 * expectation.
 */
const WHY = (() => {
  const i = process.argv.indexOf('--why')
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null
})()
/**
 * `--why-sheet "<case>:<n>=<reason>"`, repeatable — a PER-SHEET attribution that
 * overrides `--why` for that one digest.
 *
 * One reason for a whole re-record is a summary, and a summary is where two
 * causes become one blur. This round's nine moved digests had exactly two: seven
 * from work landed across 73 commits, and two (`seeded` A.01 + A.09) from this
 * round's area fix, which changed one text op each — `668.5 m²` to `550.6 m²`.
 * Recording both under one sentence would lose precisely the distinction the
 * attribution exists to preserve.
 */
const WHY_SHEET = (() => {
  const m = new Map()
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--why-sheet') continue
    const spec = process.argv[i + 1] ?? ''
    const eq = spec.indexOf('=')
    if (eq <= 0) continue
    const key = spec.slice(0, eq).trim()
    const why = spec.slice(eq + 1).trim()
    if (key && why) m.set(key, why)
  }
  return m
})()
const DUMP = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null
/** `--manifest <path>` — write the sorted list of every check this run ran.
 *  SG5 diffs it against the committed pin, so a check that disappears is named
 *  rather than merely subtracted. */
const MANIFEST_OUT = process.argv.includes('--manifest')
  ? process.argv[process.argv.indexOf('--manifest') + 1]
  : null

// A3 landscape sheet geometry — pdf.ts PAGE_W/PAGE_H, sheet.ts MARGIN/RES/
// TITLE_BLOCK_H, sheetSet.ts PANEL_W/planBox(). Re-stated here on purpose (see
// GATE INDEPENDENCE above), not imported from the module under test.
const PAGE_W = 1190.55
const PAGE_H = 841.89
const MARGIN = 40
const RES = 2.6
const TITLE_BLOCK_H = 116
const PANEL_W = 316
const PLAN_PAD_PX = 48

// Sheet banner → how many sheets carry it, for the UNCONDITIONAL sheets: every
// document produces cover + contents + these 9 banners over 9 pages (the section
// pack is two cuts, longitudinal + cross, under one banner) = 11 sheets.
const SHEET_TITLES = [
  ['DEMOLITION PLAN', 1],
  ['CONSTRUCTION & FURNISHING PLAN', 1],
  ['REFLECTED CEILING PLAN', 1],
  ['POWER & DATA PLAN', 1],
  ['SECTIONS', 2],
  ['FURNITURE & FIXTURES', 1],
  ['MOODBOARD', 1],
  ['ROOM FINISH SCHEDULE', 1],
]
const BASE_SHEETS = 11

// The one CONDITIONAL sheet kind. A.02's legend panel measures its own capacity
// (31 rows on A3) and paginates only the openings it cannot hold, so the number
// of these is a function of the DOCUMENT — 41/48/44 tagged openings give one
// each, 25 would give none. Asserting a flat 12 made this file, and the whole
// sheet-gate suite, inoperable below that threshold (D-C).
const CONT_TITLE = 'DOOR & WINDOW SCHEDULE (CONT.)'

// ---------------------------------------------------------------------------
// PDF reader — from the bytes, not from the producer's op list
// ---------------------------------------------------------------------------

/** Every `N 0 obj … endobj` in the file, as { num, dict, stream }. */
function pdfObjects(buf) {
  const s = buf.toString('latin1')
  const out = new Map()
  const re = /(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g
  let m
  while ((m = re.exec(s))) {
    const num = Number(m[1])
    const body = m[2]
    const at = body.indexOf('\nstream\n')
    out.set(num, {
      num,
      dict: at < 0 ? body : body.slice(0, at),
      stream: at < 0 ? null : body.slice(at + '\nstream\n'.length).replace(/\nendstream$/, ''),
    })
  }
  return out
}

/**
 * Decode one page content stream into drawing ops. The stream is one op per
 * line (pdf.ts opToStream + join('\n')), all numbers already rounded to 2 dp,
 * y in PDF space — flipped back to the top-down space the sheet is composed in
 * so a parsed position can be compared with a re-derived one directly.
 */
function readOps(stream) {
  const ops = { text: [], line: [], rect: [], image: [] }
  const yTop = (y) => Math.round((PAGE_H - Number(y)) * 100) / 100
  for (const raw of stream.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    let m
    if ((m = l.match(/^BT \/(F1|F2) ([\d.-]+) Tf (.+?) ([\d.-]+) ([\d.-]+) Td \((.*)\) Tj ET$/))) {
      ops.text.push({
        font: m[1],
        size: Number(m[2]),
        color: m[3],
        x: Number(m[4]),
        y: yTop(m[5]),
        str: m[6].replace(/\\([()\\])/g, '$1'),
      })
    } else if ((m = l.match(/^(.+?) ([\d.-]+) w ([\d.-]+) ([\d.-]+) m ([\d.-]+) ([\d.-]+) l S$/))) {
      ops.line.push({
        color: m[1],
        width: Number(m[2]),
        x1: Number(m[3]),
        y1: yTop(m[4]),
        x2: Number(m[5]),
        y2: yTop(m[6]),
      })
    } else if ((m = l.match(/^(.+?) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re f$/))) {
      ops.rect.push({ color: m[1], x: Number(m[2]), y: yTop(m[3]), w: Number(m[4]), h: Number(m[5]), fill: true })
    } else if ((m = l.match(/^(.+?) ([\d.-]+) w ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re S$/))) {
      ops.rect.push({
        color: m[1],
        width: Number(m[2]),
        x: Number(m[3]),
        y: yTop(m[4]),
        w: Number(m[5]),
        h: Number(m[6]),
        fill: false,
      })
    } else if ((m = l.match(/^q ([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm \/Im(\d+) Do Q$/))) {
      ops.image.push({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: yTop(m[4]), img: Number(m[5]) })
    } else {
      throw new Error(`unparsed PDF content op (the writer emitted something this reader does not know): ${l}`)
    }
  }
  return ops
}

/** Pages in /Kids order, each decoded into ops + its embedded image sizes. */
function readPages(buf) {
  const objs = pdfObjects(buf)
  const pagesObj = [...objs.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict))
  assert.ok(pagesObj, 'PDF has no /Pages node — the file is not a drawing set')
  const kids = [...pagesObj.dict.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]))
  return kids.map((n) => {
    const page = objs.get(n)
    assert.ok(page, `/Kids references object ${n}, which the file does not contain`)
    const contents = Number(page.dict.match(/\/Contents (\d+) 0 R/)[1])
    const c = objs.get(contents)
    assert.ok(c?.stream != null, `page ${n} content stream ${contents} is missing`)
    const images = [...page.dict.matchAll(/\/Im\d+ (\d+) 0 R/g)].map((m) => {
      const im = objs.get(Number(m[1]))
      return {
        w: Number(im.dict.match(/\/Width (\d+)/)[1]),
        h: Number(im.dict.match(/\/Height (\d+)/)[1]),
        bytes: Number(im.dict.match(/\/Length (\d+)/)[1]),
      }
    })
    return { ops: readOps(c.stream), images }
  })
}

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

const DATE = /\b\d{2}\/\d{2}\/\d{4}\b/g

/**
 * A stable, diffable string per drawing op. Dates are masked — every sheet
 * carries today's date in its title block, which is the ONE thing in the set
 * that legitimately differs between runs. Embedded raster bytes are NOT
 * digested: JPEG output is a Chromium encoder detail, so the baseline would go
 * red on a browser upgrade for no drawing change. The rasters are covered by
 * the determinism check instead, which compares two renders in the same
 * process, and by their placement + pixel dimensions here.
 */
function digestPage(p) {
  const n = (v) => (Math.round(v * 100) / 100).toFixed(2)
  const rows = []
  for (const t of p.ops.text) rows.push(`T ${n(t.x)} ${n(t.y)} ${t.size} ${t.font} ${t.color} ${t.str.replace(DATE, '<DATE>')}`)
  for (const l of p.ops.line) rows.push(`L ${n(l.x1)} ${n(l.y1)} ${n(l.x2)} ${n(l.y2)} ${l.width} ${l.color}`)
  for (const r of p.ops.rect) rows.push(`R ${n(r.x)} ${n(r.y)} ${n(r.w)} ${n(r.h)} ${r.fill ? 'f' : `s${r.width}`} ${r.color}`)
  for (const i of p.ops.image) rows.push(`I ${n(i.x)} ${n(i.y)} ${n(i.w)} ${n(i.h)} #${i.img}`)
  for (const im of p.images) rows.push(`X ${im.w}x${im.h}`)
  return rows
}

function digestSet(pages) {
  return pages.map((p, i) => {
    const rows = digestPage(p)
    return {
      sheet: i + 1,
      text: p.ops.text.length,
      line: p.ops.line.length,
      rect: p.ops.rect.length,
      image: p.ops.image.length,
      md5: crypto.createHash('md5').update(rows.join('\n')).digest('hex'),
      rows,
    }
  })
}

// ---------------------------------------------------------------------------
// world -> sheet, re-derived from the core state (pdf.ts fit + sheetSet planBox)
// ---------------------------------------------------------------------------

function sheetMapper(state) {
  const planX = MARGIN + 6
  const planY = 66
  const panelX = PAGE_W - MARGIN - PANEL_W
  const planW = panelX - planX - 16
  const planH = PAGE_H - MARGIN - TITLE_BLOCK_H - planY - 16
  const wPx = Math.round(planW * RES)
  const hPx = Math.round(planH * RES)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const pt = (x, y) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
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
  assert.ok(Number.isFinite(minX), 'the core document has no geometry to project')
  const spanX = Math.max(maxX - minX, 0.001)
  const spanY = Math.max(maxY - minY, 0.001)
  const k = Math.min((wPx - 2 * PLAN_PAD_PX) / spanX, (hPx - 2 * PLAN_PAD_PX) / spanY)
  const ox = (wPx - spanX * k) / 2 - minX * k
  const oy = (hPx - spanY * k) / 2 - minY * k
  const sx = planW / wPx
  const sy = planH / hPx
  return (x, y) => ({ x: planX + (x * k + ox) * sx, y: planY + (y * k + oy) * sy })
}

/** World bounds of a zone shape (Rect · RectRing · Poly) — the same geometry
 *  util/zoneGeom.zoneBBox computes, re-derived here so the check does not lean
 *  on the module it is checking. */
function zoneBBox(s) {
  if (s.kind !== 'Poly') {
    return { minX: s.x - s.w / 2, minY: s.y - s.h / 2, maxX: s.x + s.w / 2, maxY: s.y + s.h / 2 }
  }
  const xs = s.pts.map((p) => p[0])
  const ys = s.pts.map((p) => p[1])
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/** A zone's footprint in sheet pt (top-down). */
function roomBox(shape, map) {
  const bb = zoneBBox(shape)
  const a = map(bb.minX, bb.minY)
  const b = map(bb.maxX, bb.maxY)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

const inBox = (b, x, y, tol = 0) =>
  x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol

// A leader stops ON the room's edge, and the content stream rounds every
// coordinate to 2 dp — so "inside the room" has to tolerate that last 0.01 pt.
const EDGE_TOL = 0.02

/**
 * Helvetica advance width, re-implemented (pdf.ts textWidth uses the same four
 * character classes). Needed to turn a parsed text ORIGIN back into the centre
 * the renderer placed, because room labels are centre-aligned.
 */
function textWidth(s, size, bold) {
  let em = 0
  for (const ch of s) {
    if ('iljI.,:;!|()[]\' '.includes(ch)) em += 0.3
    else if ('ft'.includes(ch)) em += 0.36
    else if ('mMW@'.includes(ch)) em += 0.92
    else if (ch >= 'A' && ch <= 'Z') em += 0.7
    else em += 0.56
  }
  return em * size * (bold ? 1.06 : 1)
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let checks = 0
/** Recorded, not thrown — see the header. One red check may not silence the
 *  cases that come after it. */
const failures = []

/** EVERY CHECK IS NAMED, and the names are the pin (R23).
 *
 *  SG5 used to pin this file's check COUNT. A count cannot tell a check that
 *  vanished from a check that was added somewhere else, so three separate loss
 *  events — 27 named checks in total — went by masked behind larger increases,
 *  and the pin stayed green through all of them. `manifest` is the list SG5
 *  compares by MEMBERSHIP; `--manifest <path>` writes it.
 *
 *  Names are authored at the call site, never inferred from the failure message.
 *  A regex over messages was the alternative and it is the weaker instrument:
 *  messages embed counts, coordinates and md5s, so the normalisation rule
 *  becomes a second thing that can drift, and a check whose message is reworded
 *  reads as one check retired and another born. */
const manifest = []
const ok = (checkName, cond, msg) => {
  checks++
  manifest.push(checkName)
  if (!cond) failures.push(msg)
  return cond
}
/** A check with no assertion of its own — the digest fast path and the
 *  case-level catch both increment the counter. They are members of the
 *  manifest like any other; an unnamed member is exactly the hole R23 closes. */
const tally = (checkName) => {
  checks++
  manifest.push(checkName)
}

/**
 * DISPLAY NAME → the zone(s) that print it, upper-cased, in Room ID order.
 *
 * The rule, re-derived from the document: strip a trailing ` (n)` to get a
 * room's base name; a base shared by two or more rooms is re-numbered `(1)`,
 * `(2)`, … in Room ID order; a base held by one room keeps its label untouched.
 * Every group returned therefore has exactly ONE member — a group of two would
 * itself be the duplicate-name defect — and the per-name count assertion below
 * still reads as "drawn once per zone".
 */
function displayGroups(zones) {
  const ordered = [...zones].sort((a, b) => a.id - b.id)
  const bases = new Map()
  for (const z of ordered) {
    const label = (z.label || '').trim()
    if (!label) continue
    const base = label.replace(/\s+\(\d+\)\s*$/, '').trim()
    if (!bases.has(base)) bases.set(base, [])
    bases.get(base).push(z)
  }
  const out = new Map()
  for (const [base, group] of bases) {
    for (const [i, z] of group.entries()) {
      const name = (group.length > 1 ? `${base} (${i + 1})` : (z.label || '').trim()).toUpperCase()
      if (!out.has(name)) out.set(name, [])
      out.get(name).push(z)
    }
  }
  return out
}

/**
 * Every room the core places is named exactly once on the sheet, and a label
 * that sits off its room is tied back to it by a leader.
 *
 * Nothing here is read from the producer: the room set + geometry come from the
 * core state, the label positions from the PDF bytes.
 */
/** Disambiguates a check name when one display name covers several zones.
 *  `displayGroups` re-numbers shared base names so every group has exactly one
 *  member, and a group of two would itself be the duplicate-name defect — but
 *  the manifest must stay injective even on the day that invariant breaks, or a
 *  loss and a gain would cancel inside one name. */
const suffix = (group, z) => (group.length > 1 ? `#${z.id}` : '')

function checkRoomLabels(caseName, sheetNo, page, state, map) {
  // GROUND IS ONE CLASS, AND THIS FILE HELD THE LAST HAND-WRITTEN COPY.
  //
  // This read `z.zone_type !== 'Circulation'` — one type, spelled out. Ruling
  // `7e394eb` ("Ground is one class: isGroundZone, and the ~30 sites that meant
  // it") folded `Unassigned` in with `Circulation`, the sheets correctly stopped
  // naming it, and this predicate was not among the ~30 sites. So the test went
  // on demanding six labels the fold forbids: `dwg A.01`/`A.02`
  // `'UNASSIGNED (1)'…'(6)' is drawn 0x`, twelve failures, **the test wrong and
  // the drawing right**.
  //
  // It is not re-spelled here with the second name added — that would move the
  // same defect one release along. `groundZoneTypes()` PARSES the set out of
  // `lib.rs::published_zone_type`, the single place the fold happens, and
  // `sheetlib.mjs` already carried it for the SG gates. The fix existed; it had
  // simply never reached this file, because this file was in no board's
  // population (R12, amended).
  const ground = groundZoneTypes()
  const zones = (state.zones ?? []).filter((z) => !ground.has(z.zone_type))
  const where = `${caseName} sheet ${sheetNo}`
  let displaced = 0
  const led = []

  // Zones grouped by drawn name. The sheets label rooms by their DISPLAY name,
  // which is the core's label plus a ` (n)` ordinal in Room ID order whenever
  // two rooms share a base name — the dwg pack's three bare 'Open Workspace'
  // pockets (246/247/248) print as (5)/(6)/(7), alongside the (1)…(4) the
  // generator had already numbered. Re-derived here from core state rather than
  // imported, like `textWidth` above: this test proves the sheets agree with the
  // document, so it may not borrow the drawing layer's own answer.
  const byName = new Map()
  for (const [name, group] of displayGroups(zones)) byName.set(name, group)

  for (const [name, group] of byName) {
    const hits = page.ops.text.filter((t) => t.str.toUpperCase() === name && t.size === 8 && t.font === 'F2')
    ok(
      `rooms/${caseName}/${sheetNo}/${name}/drawn-once`,
      hits.length === group.length,
      `${where}: '${name}' is drawn ${hits.length}x for ${group.length} zone(s) — ` +
        'the sheet and the model do not name the same set of rooms',
    )
    if (hits.length !== group.length) continue
    const free = [...hits]
    for (const z of group) {
    const box = roomBox(z.shape, map)
    let pick = 0
    if (free.length > 1) {
      let bestD = Infinity
      free.forEach((h, i) => {
        const d = Math.hypot(
          h.x + textWidth(h.str, 8, true) / 2 - (box.x + box.w / 2),
          h.y + 4 - (box.y + box.h / 2),
        )
        if (d < bestD) {
          bestD = d
          pick = i
        }
      })
    }
    const t = free.splice(pick, 1)[0]
    // Rebuild the label's placement box out of the two text ops the sheet drew.
    // Centre-aligned text carries its LEFT edge, so half the (re-derived) width
    // goes back on; the name sits 4 pt above the box centre and the area line
    // 7 pt below it, and the box is as wide as the wider of the two + 4.
    const nameW = textWidth(t.str, 8, true)
    const cx = t.x + nameW / 2
    const cy = t.y + 4
    const area = page.ops.text.find(
      (a) => a.size === 7.5 && Math.abs(a.y - (cy + 7)) < 0.05 && Math.abs(a.x + textWidth(a.str, 7.5) / 2 - cx) < 0.05,
    )
    ok(`rooms/${caseName}/${sheetNo}/${name}${suffix(group, z)}/area-line`, area != null,
      `${where}: room '${name}' has a name but no area line under it`)
    const w = Math.max(nameW, area ? textWidth(area.str, 7.5) : 0) + 4
    const label = { x: cx - w / 2, y: cy - 13, w, h: 26 }

    // ATTACHED: the label still covers part of its own footprint, so it names
    // itself. (`placeNear`'s first candidate is the true centre, so an
    // un-nudged label always lands here.)
    const gap = Math.max(box.x - (label.x + label.w), label.x - (box.x + box.w), box.y - (label.y + label.h), label.y - (box.y + box.h))
    if (gap < 0) continue
    displaced++

    // DETACHED: there must be a leader from this label to THIS room — one end
    // on the label box, the other on/inside the room's own footprint. Below
    // MIN_LEADER (6 pt) the line would be a tick, and the label is touching the
    // room anyway, so none is required.
    const lead = page.ops.line.find((l) => {
      const ends = [
        [l.x1, l.y1, l.x2, l.y2],
        [l.x2, l.y2, l.x1, l.y1],
      ]
      return ends.some(
        ([ax, ay, bx, by]) => inBox(label, ax, ay, EDGE_TOL) && inBox(box, bx, by, EDGE_TOL),
      )
    })
    if (lead) led.push(name)
    ok(
      `rooms/${caseName}/${sheetNo}/${name}${suffix(group, z)}/leader`,
      lead != null || gap < 6,
      `${where}: room '${name}' label clears its own footprint by ${gap.toFixed(1)} pt with no leader ` +
        'line back to it — a label that sits off every room it could name is unattributable',
    )
    }
  }
  return { rooms: zones.length, displaced, led }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const recorded = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null
if (!recorded && !UPDATE) {
  console.error(
    `FAIL: no baseline at ${path.relative(REPO, BASELINE)}.\n` +
      'The drawing set is unprotected without one. Render the set, LOOK at every sheet, then\n' +
      'record it with: node scripts/drawing-set.test.mjs --update',
  )
  process.exit(1)
}

const fresh = { meta: SHEET_META, cases: {} }
for (const name of CASES) {
  try {
    await runCase(name)
  } catch (err) {
    // A structural throw (a malformed PDF, an unparsed content op) is this
    // case's failure and nobody else's — the remaining cases still get graded.
    tally(`case-threw/${name}`)
    failures.push(`${name}: ${err.message}`)
  }
}

async function runCase(name) {
  const { pdf, doc } = await renderSheetSet(name)
  const pages = readPages(pdf)
  const digest = digestSet(pages)
  fresh.cases[name] = { sheets: digest.map(({ rows: _rows, ...d }) => d) }
  if (DUMP) {
    fs.mkdirSync(DUMP, { recursive: true })
    for (const d of digest) fs.writeFileSync(path.join(DUMP, `${name}.sheet${d.sheet}.txt`), d.rows.join('\n'))
  }

  // 1. structure — the 11 unconditional sheets, then the continuation sheets
  //    the document's own opening count calls for.
  const cont = pages.length - BASE_SHEETS
  ok(
    `structure/${name}/sheet-count-not-short`,
    cont >= 0,
    `${name}: the set has ${pages.length} sheets and ${BASE_SHEETS} are unconditional — a short set means a ` +
      'sheet builder threw and was swallowed by its try-wrapper (classically the two section sheets, with no GL context)',
  )
  const allText = pages.flatMap((p) => p.ops.text.map((t) => t.str))
  for (const [title, want] of SHEET_TITLES) {
    const n = allText.filter((s) => s === title).length
    ok(`structure/${name}/banner/${title}`, n === want,
      `${name}: sheet banner '${title}' appears ${n}x across the set, expected ${want}`)
  }
  // Every page past the unconditional set is a continuation sheet, and they are
  // the LAST pages — so a set that dropped a sheet and grew a continuation one
  // cannot pass by arithmetic.
  const contBanners = pages
    .map((p, i) => (p.ops.text.some((t) => t.str === CONT_TITLE) ? i : -1))
    .filter((i) => i >= 0)
  ok(
    `structure/${name}/continuation-banners`,
    contBanners.length === Math.max(0, cont) && contBanners.every((i) => i >= BASE_SHEETS),
    `${name}: ${contBanners.length} sheet(s) carry '${CONT_TITLE}' (at ${contBanners.map((i) => i + 1).join(',') || 'nowhere'}) ` +
      `for ${cont} page(s) past the ${BASE_SHEETS} unconditional sheets`,
  )

  // 2. determinism — an independent second render, byte for byte
  const twin = await renderSheetSet(name)
  ok(
    `determinism/${name}/byte-identical`,
    Buffer.compare(pdf, twin.pdf) === 0,
    `${name}: two independent renders of the same document differ (${pdf.length} vs ${twin.pdf.length} B) — ` +
      'the drawing set is not deterministic',
  )

  // 3. rooms + leaders, on the two sheets that carry room labels (A.01, A.02)
  const map = sheetMapper(doc.state)
  const r1 = checkRoomLabels(name, 'A.01', pages[2], doc.state, map)
  const r2 = checkRoomLabels(name, 'A.02', pages[3], doc.state, map)
  console.log(
    `  ${name}: ${pages.length} sheets · ${digest.reduce((t, d) => t + d.text, 0)} text / ` +
      `${digest.reduce((t, d) => t + d.line, 0)} line / ${digest.reduce((t, d) => t + d.rect, 0)} rect ops · ` +
      `rooms ${r1.rooms} · A.01 ${r1.displaced} off-room, ${r1.led.length} led [${r1.led.join(', ')}]` +
      ` · A.02 ${r2.displaced} off-room, ${r2.led.length} led [${r2.led.join(', ')}]`,
  )

  // 4. baseline — RECORDED failures, so a stale baseline can no longer stop the
  //    next case being rendered at all (D-F).
  if (!UPDATE) {
    const want = recorded.cases[name]
    if (!ok(`baseline/${name}/case-present`, want != null, `${name}: no recorded baseline for this case`)) return
    ok(
      `baseline/${name}/sheet-count`,
      want.sheets.length === digest.length,
      `${name}: baseline has ${want.sheets.length} sheets, this render has ${digest.length}`,
    )
    // EVERY RECORDED DIGEST NAMES WHAT MOVED IT. A baseline row without a
    // `why` is an expectation nobody can audit — and re-recording is exactly
    // where an unexamined change becomes ground truth. Checked on the RECORDED
    // side, so a bare `--update` that dropped the reasons is red on the next
    // run rather than quietly authoritative.
    ok(
      `baseline/${name}/why-attribution`,
      want.sheets.every((w) => typeof w.why === 'string' && w.why.trim().length >= 12),
      `${name}: ${want.sheets.filter((w) => !w?.why).length} baseline sheet row(s) carry no attribution — ` +
        're-record with --why "<what moved the ink>"',
    )
    for (const d of digest) {
      const w = want.sheets[d.sheet - 1]
      if (!ok(`baseline/${name}/sheet-${d.sheet}/row-present`, w != null,
        `${name} sheet ${d.sheet}: the baseline has no row for this sheet`)) continue
      if (w.md5 === d.md5) {
        tally(`baseline/${name}/sheet-${d.sheet}/digest`)
        continue
      }
      const dump = path.join(REPO, `out/drawing-set.${name}.sheet${d.sheet}.txt`)
      fs.mkdirSync(path.dirname(dump), { recursive: true })
      fs.writeFileSync(dump, d.rows.join('\n'))
      ok(
        `baseline/${name}/sheet-${d.sheet}/digest`,
        false,
        `${name} sheet ${d.sheet}: content digest changed\n` +
          `    was  ${w.md5}  (${w.text} text / ${w.line} line / ${w.rect} rect / ${w.image} image ops)\n` +
          `    now  ${d.md5}  (${d.text} text / ${d.line} line / ${d.rect} rect / ${d.image} image ops)\n` +
          `    this render written to ${path.relative(REPO, dump)}\n` +
          '    LOOK at the sheet (pdftoppm) before re-recording with --update',
      )
    }
  }
}

// THE MANIFEST IS WRITTEN WHATEVER THE COLOUR. A red run's coverage is still
// coverage, and a gate that could only read the manifest of a green run would be
// blind exactly when a check vanished alongside a failure.
if (MANIFEST_OUT) {
  const dup = manifest.filter((n, i) => manifest.indexOf(n) !== i)
  if (dup.length > 0) {
    console.error(`REFUSED: ${dup.length} duplicate check name(s), e.g. ${dup.slice(0, 3).join(', ')}.`)
    console.error('  A manifest with a repeated name cannot distinguish a loss from a gain.')
    process.exit(2)
  }
  fs.mkdirSync(path.dirname(path.resolve(MANIFEST_OUT)), { recursive: true })
  fs.writeFileSync(MANIFEST_OUT, [...manifest].sort().join('\n') + '\n')
}

if (UPDATE) {
  if (!WHY || WHY.trim().length < 12) {
    console.error(
      'REFUSED: --update needs --why "<what moved the ink>".\n' +
        '  A digest is a claim about what SHOULD print. Re-recording without saying\n' +
        '  which fix or ruling moved it turns an unexamined change into ground truth,\n' +
        '  which is how a frozen expectation launders a defect.',
    )
    process.exit(2)
  }
  // Stamp the reason on the sheets that MOVED; leave the rest with theirs, so a
  // baseline accumulates a per-sheet history instead of one global timestamp.
  let moved = 0
  for (const [name, c] of Object.entries(fresh.cases)) {
    const before = recorded?.cases?.[name]?.sheets ?? []
    for (const d of c.sheets) {
      const prev = before[d.sheet - 1]
      if (prev && prev.md5 === d.md5) {
        if (prev.why) d.why = prev.why
        continue
      }
      d.why = WHY_SHEET.get(`${name}:${d.sheet}`) ?? WHY.trim()
      moved++
    }
  }
  // A --why-sheet naming a digest that did NOT move is an attribution for
  // something that did not happen. Loud, not silent.
  const applied = new Set(
    Object.entries(fresh.cases).flatMap(([n, c]) => c.sheets.map((d) => `${n}:${d.sheet}`)),
  )
  const stale = [...WHY_SHEET.keys()].filter((k) => {
    const [n, sh] = k.split(':')
    const row = fresh.cases[n]?.sheets?.[Number(sh) - 1]
    return !applied.has(k) || row?.why !== WHY_SHEET.get(k)
  })
  if (stale.length > 0) {
    console.error(`REFUSED: --why-sheet given for ${stale.join(', ')}, but those digests did not move.`)
    process.exit(2)
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(fresh, null, 2) + '\n')
  console.log(
    `recorded ${path.relative(REPO, BASELINE)} — ${moved} sheet digest(s) moved and were attributed ` +
      `to "${WHY.trim()}"; ${checks} checks passed on the way`,
  )
} else if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL ${f}`)
  // The scoreboard line keeps its exact shape whatever the colour — SG5 reads it.
  console.log(`drawing-set FAIL (${checks} checks)`)
  process.exit(1)
} else {
  console.log(`drawing-set PASS (${checks} checks)`)
}
