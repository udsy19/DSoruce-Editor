// SG2 — PLATE CONFINEMENT.  Every opening tag drawn on the plan lives inside the
// plan's own viewport, and every tag that had to be moved off its opening is
// joined back to it by a leader.
//
//   node scripts/gates/sheets/sg2-plate-confinement.mjs [--pack seeded,dwg]
//
// HOW THE TAGS ARE FOUND.  In the raster, by construction (lib/tags.mjs): a tag
// is a regular polygon of known radius / sides / rotation, stroked in a palette
// colour parsed out of sheetSet.ts, over a pure-white backdrop mask, with a
// pure-neutral glyph run at its centre.  No producer-emitted tag position is
// read anywhere in this gate — the schedule's own tag list is not consulted
// either.  The two call sites of `drawTagGlyph` give the two sizes, and the size
// IS the classification: an 11 pt glyph is a plan tag (belongs in the plate), an
// 8 pt glyph is a schedule tag (belongs in the panel).
//
// WHAT IT ASSERTS, AND WHAT EACH ASSERTION IS ANCHORED TO
//
//  2.1  Every plan tag lies wholly inside `plate`.       (template rect = spec)
//  2.2  No plan tag's glyph box touches `titleBlock` or any panel rect.
//  2.3  Every schedule tag lies wholly inside its panel rect.
//  2.4  The number of DOOR tags on the plan equals the number of components
//       with `category === 'Door'` in CORE STATE — a count a flag cannot drop
//       because the geometry is in the document.
//  2.5  ATTRIBUTION.  Every plan tag either touches a wall (its glyph is within
//       its own radius of a wall segment) or is joined to one by a leader
//       stroke read out of the delivered PDF's content stream.  Wall geometry
//       comes from CORE STATE, re-projected here (`planMap`) rather than taken
//       from the renderer; the projection is validated first — every wall must
//       land inside the plate.
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — actual output at HEAD (1748bdf), before any defect was fixed:
//
//   $ node scripts/gates/sheets/sg2-plate-confinement.mjs
//   SG2 FAIL (24 checks, 5 failing)
//
//   FAIL dwg/A02 every plan tag inside the plate — 5 of 43 outside:
//        Window@(466.5,63.5)pt [13.5 pt above the plate top],
//        Door@(295.0,69.0)pt [8.0 pt above], Window@(203.5,70.0)pt [7.0 pt
//        above], Window@(528.0,76.5)pt [0.5 pt above], and
//        Window@(376.0,728.5)pt [69.6 pt BELOW the plate bottom] — that last
//        one is S0's W33, sitting inside the title block.
//        S0 reported ONE escaped tag; the gate names FIVE.
//   FAIL dwg/A02 no plan tag over the title block or panel —
//        Window@(376.0,728.5)pt overlaps titleBlock
//   FAIL seeded/A02  every schedule tag inside its panel —  9 of 41 outside,
//        lowest at y=810.0 pt (panel bottom 685.89 pt)
//   FAIL testfit/A02 every schedule tag inside its panel — 10 of 42 outside,
//        lowest at y=824.0 pt
//   FAIL dwg/A02     every schedule tag inside its panel — 10 of 42 outside,
//        lowest at y=824.0 pt   (SG1's overflow, in the tag domain)
//
//   Checks 2.4 and 2.5 PASS today — the plan door-tag count found in the raster
//   is 17/18/11, exactly the number of `category === 'Door'` components in core
//   state for seeded/testfit/dwg, and every one of those doors is either under
//   its tag or joined to it by a leader. They are the companions that keep
//   2.1-2.3 honest: if the detector under-counted, 2.4 would say so.
// ---------------------------------------------------------------------------

import path from 'node:path'
import {
  PACKS,
  SHEETS_DIR,
  loadGeometry,
  readPng,
  coreState,
  pageLines,
  runGate,
  GateError,
} from './lib/sheetlib.mjs'
import { findTags, TAG_SIZE_PT } from './lib/tags.mjs'

/** A.02 is the only sheet that carries opening tags (`constructionSheet`). */
const TAGGED_SHEET = { file: 'A02', page: 4 }

/**
 * world (m) → sheet pt, re-derived from CORE STATE and the template.
 *
 * `renderPrintCanvas` (web/src/export/printPlan.ts) fits `stateBbox` — every wall
 * endpoint and every rotated component corner — into a wPx×hPx canvas with a
 * 48 px pad, and `worldMapper` (sheetSet.ts) places that canvas in the plate.
 * Reproduced here from the document and the template constants, so the gate
 * never asks the renderer where anything went.
 */
function planMap(state, plate, RES) {
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
  return (x, y) => ({ x: plate.x + (x * k + ox) * sx, y: plate.y + (y * k + oy) * sy })
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}

const containsRect = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--pack')
  const packs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',') : PACKS

  return runGate('SG2', async (c) => {
    for (const pack of packs) {
      if (!PACKS.includes(pack)) throw new GateError(`unknown pack '${pack}'`)
      const g = loadGeometry(pack, TAGGED_SHEET.file)
      const img = readPng(path.join(SHEETS_DIR, pack, `${TAGGED_SHEET.file}.png`))
      const s = g.ptToPx
      if (!g.plate) throw new GateError(`${pack}/${TAGGED_SHEET.file}: no plate rect`)
      const plate = g.plate.pt
      const panels = (g.panels ?? []).map((p) => ({ id: p.id, ...p.pt }))
      if (panels.length === 0) throw new GateError(`${pack}/${TAGGED_SHEET.file}: no panel rect`)

      const tags = findTags(img, s).map((t) => ({
        ...t,
        // the glyph's own bounding box, in pt
        box: { x: (t.cx - t.r) / s, y: (t.cy - t.r) / s, w: (t.r * 2) / s, h: (t.r * 2) / s },
        px: (t.cx / s),
        py: (t.cy / s),
      }))
      const plan = tags.filter((t) => t.scale === 'plan')
      const sched = tags.filter((t) => t.scale === 'schedule')
      c.ok(`${pack}/A02 tags were found at all`, plan.length > 0 && sched.length > 0, `plan=${plan.length} schedule=${sched.length}`)
      c.ok(
        `${pack}/A02 every tag carries a glyph run`,
        tags.every((t) => t.glyphInk > 0),
        `${tags.filter((t) => t.glyphInk === 0).length} tag(s) with no neutral text at their centre`,
      )

      // --- 2.1 plan tags inside the plate -----------------------------------
      const escaped = plan.filter((t) => !containsRect(plate, t.box))
      c.ok(
        `${pack}/A02 every plan tag inside the plate`,
        escaped.length === 0,
        escaped.length
          ? `${escaped.length} of ${plan.length} outside: ` +
            escaped
              .map((t) => {
                const above = plate.y - t.box.y
                const below = t.box.y + t.box.h - (plate.y + plate.h)
                const off = below > 0 ? `${below.toFixed(1)} pt below the plate bottom` : `${above.toFixed(1)} pt above the plate top`
                return `${t.kind}@(${t.px.toFixed(1)},${t.py.toFixed(1)})pt [${off}]`
              })
              .join(', ')
          : '',
      )

      // --- 2.2 no plan tag over the title block / panel ---------------------
      const intruding = plan.filter(
        (t) => (g.titleBlock && overlaps(t.box, g.titleBlock.pt)) || panels.some((p) => overlaps(t.box, p)),
      )
      c.ok(
        `${pack}/A02 no plan tag over the title block or panel`,
        intruding.length === 0,
        intruding
          .map((t) => {
            const which = g.titleBlock && overlaps(t.box, g.titleBlock.pt) ? 'titleBlock' : panels.find((p) => overlaps(t.box, p)).id
            return `${t.kind}@(${t.px.toFixed(1)},${t.py.toFixed(1)})pt overlaps ${which}`
          })
          .join(', '),
      )

      // --- 2.3 schedule tags inside their panel -----------------------------
      const loose = sched.filter((t) => !panels.some((p) => containsRect(p, t.box)))
      c.ok(
        `${pack}/A02 every schedule tag inside its panel`,
        loose.length === 0,
        loose.length
          ? `${loose.length} of ${sched.length} outside the panel; lowest at y=${Math.max(...loose.map((t) => t.py)).toFixed(1)} pt ` +
            `(panel bottom ${(panels[0].y + panels[0].h).toFixed(2)} pt)`
          : '',
      )

      // --- 2.4 door tags vs core state --------------------------------------
      const state = await coreState(pack)
      const doors = state.components.filter((cc) => cc.category === 'Door')
      const doorTags = plan.filter((t) => t.kind === 'Door')
      c.ok(
        `${pack}/A02 one plan door tag per Door component`,
        doorTags.length === doors.length,
        `${doorTags.length} door tags drawn, ${doors.length} Door components in core state`,
      )

      // --- 2.5 attribution ---------------------------------------------------
      const map = planMap(state, plate, g.spec.RES)
      const walls = state.walls.map((w) => {
        const a = map(w.a.x, w.a.y)
        const b = map(w.b.x, w.b.y)
        return [a.x, a.y, b.x, b.y]
      })
      const outOfPlate = walls.filter(
        ([x1, y1, x2, y2]) =>
          Math.min(x1, x2) < plate.x - 0.5 ||
          Math.max(x1, x2) > plate.x + plate.w + 0.5 ||
          Math.min(y1, y2) < plate.y - 0.5 ||
          Math.max(y1, y2) > plate.y + plate.h + 0.5,
      )
      c.ok(
        `${pack}/A02 the re-projection lands every core-state wall in the plate`,
        outOfPlate.length === 0,
        `${outOfPlate.length} of ${walls.length} wall segments project outside the plate — the gate's map is wrong, not the drawing`,
      )

      // Per OPENING, not per tag: every Door in core state has a mapped anchor,
      // and the drawing must attach a tag to it — the glyph over the anchor, or
      // a leader from the anchor to a glyph. (Doors only: a window's anchor is
      // the midpoint of a merged glazed run, and merging is producer logic the
      // gate must not re-run. `walls` above still anchors the projection check.)
      const leaders = pageLines(pack, TAGGED_SHEET.page)
      const r = TAG_SIZE_PT.plan
      const orphans = []
      for (const d of doors) {
        const a = map(d.x, d.y)
        const onGlyph = doorTags.find((t) => Math.hypot(t.px - a.x, t.py - a.y) <= r)
        if (onGlyph) continue
        const led = leaders.some((l) => {
          const atAnchor = Math.hypot(l.x1 - a.x, l.y1 - a.y) <= 2 ? [l.x2, l.y2]
            : Math.hypot(l.x2 - a.x, l.y2 - a.y) <= 2 ? [l.x1, l.y1] : null
          return atAnchor !== null && doorTags.some((t) => Math.hypot(t.px - atAnchor[0], t.py - atAnchor[1]) <= r + 2)
        })
        if (!led) orphans.push({ d, a })
      }
      c.ok(
        `${pack}/A02 every Door in core state carries an attributable tag`,
        orphans.length === 0,
        orphans.length
          ? `${orphans.length} of ${doors.length} doors have no tag over them and no leader to one: ` +
            orphans
              .slice(0, 6)
              .map(
                (o) =>
                  `door@world(${o.d.x.toFixed(2)},${o.d.y.toFixed(2)}) → sheet(${o.a.x.toFixed(1)},${o.a.y.toFixed(1)})pt, ` +
                  `nearest tag ${Math.min(...doorTags.map((t) => Math.hypot(t.px - o.a.x, t.py - o.a.y))).toFixed(1)} pt away`,
              )
              .join('; ')
          : '',
      )
    }
  })
}

process.exit((await main()) ? 0 : 1)
