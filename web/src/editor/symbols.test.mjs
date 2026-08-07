// The two invariants the symbol module exists to guarantee:
//   1. A symbol's CONTENT never changes with zoom.
//   2. The glyph renders the MODEL's seat count — it never derives its own.
//
// Both are checked by drawing to a recording stub that logs primitive calls, so
// the assertions are about what actually reaches the canvas, not about internal
// state. Run: node src/editor/symbols.test.mjs
//
// Imports the TypeScript source directly — Node strips the types natively, so
// the test exercises exactly the module the app ships, with no build step and no
// hand-rolled transform to drift out of sync.

import * as mod from './symbols.ts'

// --- recording canvas stub ---------------------------------------------------
function stubCtx() {
  const calls = []
  const rec = (name) => (...args) => calls.push({ name, args })
  const ctx = {
    calls,
    globalAlpha: 1,
    save() { calls.push({ name: 'save', args: [] }) },
    restore() { calls.push({ name: 'restore', args: [] }) },
    translate: rec('translate'),
    rotate: rec('rotate'),
    scale: rec('scale'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arcTo: rec('arcTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    clip: rec('clip'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    strokeRect: rec('strokeRect'),
    fillRect: rec('fillRect'),
  }
  return ctx
}

const INK = { stroke: '#000', detail: '#888', fill: '#fff', seat: '#eee', accent: '#f00' }

/** Count chairs by counting the translate→rotate pairs `seatAt` emits (one per
 *  seat). `drawSymbol` itself opens with translate→rotate to place the symbol,
 *  so that first pair is the frame, not a chair. */
function drawAndCount(spec, pxPerM, dpr = 1) {
  const ctx = stubCtx()
  mod.drawSymbol(ctx, { cx: 0, cy: 0, rotation: 0, ...spec }, INK, { pxPerM, dpr })
  let pairs = 0
  for (let i = 1; i < ctx.calls.length; i++) {
    if (ctx.calls[i].name === 'rotate' && ctx.calls[i - 1].name === 'translate') pairs++
  }
  return { seats: Math.max(0, pairs - 1), calls: ctx.calls }
}

let pass = 0
let fail = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`)
  }
}

// --- 1. the glyph renders the MODEL's seat count ----------------------------
// The real generated boardroom: 2.4 x 3.3 m, which the core stamps as 12 seats.
// Before this module the renderer drew 0/6/8/10 depending on the zoom; the first
// version of this module still capped by seat pitch and drew 10 against a model
// value of 12. It must draw exactly what the model says.
for (const seats of [2, 4, 6, 8, 10, 12, 14]) {
  const { seats: drawn } = drawAndCount({ category: 'Table', w: 2.4, h: 3.3, seats }, 60)
  check(`table 2.4x3.3 renders model seats=${seats}`, drawn, seats)
}
// A small 2-seat table and a deep 4-seat one.
check('table 1.2x0.6 seats=2', drawAndCount({ category: 'Table', w: 1.2, h: 0.6, seats: 2 }, 60).seats, 2)
check('table 1.2x0.9 seats=4', drawAndCount({ category: 'Table', w: 1.2, h: 0.9, seats: 4 }, 60).seats, 4)

// --- 2. seat count is INVARIANT across the whole zoom range -----------------
// This is the headline bug: the same object drew a different number of chairs at
// different zoom levels. Sweep the full clamp range the canvas allows (8..300).
const ZOOMS = [8, 12, 16, 20, 26, 30, 45, 70, 110, 200, 300]
const boardroom = { category: 'Table', w: 2.4, h: 3.3, seats: 12 }
const counts = ZOOMS.map((k) => drawAndCount(boardroom, k).seats)
check(`boardroom seat count across zooms ${ZOOMS.join('/')}`, counts, ZOOMS.map(() => 12))

// A desk draws its chair inline rather than via seatAt, so count its structural
// paths instead: once fine detail is fully on, a desk is always made of exactly
// the same parts (worktop, monitor, keyboard, 2 arms, seat, backrest).
const deskParts = (k) =>
  drawAndCount({ category: 'Desk', w: 1.4, h: 0.7, seats: 1 }, k).calls.filter(
    (c) => c.name === 'closePath',
  ).length
const deskAtFullDetail = [70, 110, 200, 300].map(deskParts)
check('desk is the same object at every full-detail zoom', new Set(deskAtFullDetail).size, 1)
check('desk part count', deskAtFullDetail[0], 7)

// --- 3. countable DETAIL is world-derived, so it too is zoom-invariant ------
// Fine detail legitimately FADES OUT at overview zoom (that is the continuous
// LOD). The invariant is that wherever it IS drawn, the count is always the same
// — it must never be drawn at one count here and a different count there.
// Seams and grid lines are the only `lineTo` these two symbols emit (their
// bodies are roundRect paths, which use arcTo), so this counts detail exactly.
const detailCount = (spec, k) =>
  drawAndCount(spec, k).calls.filter((c) => c.name === 'lineTo').length

// Casework drawer seams: one per 0.45 m of run.
const seams = ZOOMS.map((k) => detailCount({ category: 'Furniture', w: 2.7, h: 0.5, seats: 0 }, k))
check('casework seams: one non-zero count only', new Set(seams.filter((n) => n > 0)).size, 1)

// Ceiling tiles: a 0.6 m grid.
const tiles = ZOOMS.map((k) => detailCount({ category: 'FallCeiling', w: 3.6, h: 2.4, seats: 0 }, k))
check('ceiling tiles: one non-zero count only', new Set(tiles.filter((n) => n > 0)).size, 1)

// And the counts must match the real-world pitch, not some screen heuristic:
// a 2.7 m credenza has 6 fronts (5 seams); a 3.6 x 2.4 m ceiling is 6 x 4 tiles
// (5 + 3 = 8 grid lines).
check('casework seam count is world-derived', Math.max(...seams), 5)
check('ceiling grid count is world-derived', Math.max(...tiles), 8)

// --- 4. pens land on the device-pixel grid ---------------------------------
// A hairline must be exactly one physical pixel at any DPR; the old fixed 1.35 /
// 1.6 CSS px straddled the grid at DPR 1 AND 2, which is why they read as a soft
// grey smear rather than a crisp line.
for (const dpr of [1, 1.5, 2, 3]) {
  for (const w of ['hair', 'thin', 'med', 'thick']) {
    const cssPx = mod.pen(w, dpr)
    const devicePx = cssPx * dpr
    const onGrid = Math.abs(devicePx - Math.round(devicePx)) < 1e-9
    check(`pen ${w} @dpr${dpr} lands on device grid (${devicePx}px)`, onGrid, true)
  }
}

// --- 5. LOD is a continuous ramp, never a step -----------------------------
const band = { exit: 10, enter: 20 }
check('lod below exit', mod.lod(9, band), 0)
check('lod at exit', mod.lod(10, band), 0)
check('lod midpoint', mod.lod(15, band), 0.5)
check('lod at enter', mod.lod(20, band), 1)
check('lod above enter', mod.lod(40, band), 1)
// Monotonic and gap-free across the band — no jump anywhere. A 0.25px step on a
// 10px-wide band moves alpha by 0.025, so any jump above 0.05 is a discontinuity
// (i.e. a pop) rather than a ramp.
let prev = mod.lod(8, band)
let monotonic = true
for (let s = 8.25; s <= 22; s += 0.25) {
  const v = mod.lod(s, band)
  if (v < prev - 1e-9 || v - prev > 0.05) monotonic = false
  prev = v
}
check('lod ramps monotonically with no step', monotonic, true)

// --- 6. the TS fallback mirrors the core's seats_for exactly ----------------
// Used only for snapshots that predate the `seats` facet; it must agree with
// crates/ds-core/src/model.rs::seats_for or the two would drift.
check('seatsForSize desk', mod.seatsForSize('Desk', 1.4, 0.7), 1)
check('seatsForSize chair', mod.seatsForSize('Chair', 0.5, 0.5), 1)
check('seatsForSize 1.2x0.6', mod.seatsForSize('Table', 1.2, 0.6), 2)
check('seatsForSize 1.2x0.9', mod.seatsForSize('Table', 1.2, 0.9), 4)
check('seatsForSize 4.5x2.5', mod.seatsForSize('Table', 4.5, 2.5), 14)
check('seatsForSize orientation-invariant', mod.seatsForSize('Table', 2.5, 4.5), 14)
check('seatsForSize door', mod.seatsForSize('Door', 0.9, 0.15), 0)
check('seatsForSize degenerate', mod.seatsForSize('Table', 0, 0), 0)

// --- 7. EVERY declared category draws, at three LOD levels ------------------
//
// The population is DERIVED from the switch in `drawSymbol`, not typed out here.
// A hand-written list is a list that goes stale the first time somebody adds a
// case, and the test then certifies a vocabulary that has moved
// (`.claude/rules/gate-independence.md`: derive the complete expected set, never
// presence-match two lists). The property each member is checked against is
// independent of that parse: does it draw, and does it draw something OTHER than
// the generic fallback box?
//
// "Falling through to the generic box undeclared" is the failure this catches.
// A `case 'Plant':` whose body was deleted still compiles, still renders, and
// still looks like furniture — it just silently becomes a rounded rectangle.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'symbols.ts'), 'utf8')
const SWITCH = SRC.slice(SRC.indexOf('switch (s.category)'), SRC.indexOf('default:'))
const CATEGORIES = [...SWITCH.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1])

check('the category population is non-vacuous', CATEGORIES.length >= 12, true)

/** A signature of what actually reached the canvas: the op sequence. */
const opsFor = (category, pxPerM) => {
  const ctx = stubCtx()
  mod.drawSymbol(ctx, { category, cx: 0, cy: 0, w: 1.2, h: 0.9, rotation: 0, seats: 4 },
                 INK, { pxPerM, dpr: 1 })
  return ctx.calls.map((c) => c.name).join(',')
}
/** The generic fallback, reached by any category the switch does not name. */
const FALLBACK = (pxPerM) => opsFor('__no_such_category__', pxPerM)

// Three LOD levels, one per band the module declares: below `primary.exit`
// (no detail), inside the ramp, and above `fine.enter` (everything on). A 0.9 m
// short side puts those at roughly 8 / 28 / 56 px/m.
const LODS = [9, 31, 62]
const MARKS = new Set(['fill', 'stroke', 'strokeRect', 'fillRect'])
for (const category of CATEGORIES) {
  for (const k of LODS) {
    const ops = opsFor(category, k)
    check(`${category} @${k}px/m emits marks`,
          ops.split(',').some((o) => MARKS.has(o)), true)
  }
  // At full detail every named category must be DISTINGUISHABLE from the box.
  check(`${category} is not the generic fallback`, opsFor(category, 62) === FALLBACK(62), false)
}

// --- 8. content is still zoom-invariant for the NEW categories --------------
// Same invariant as §3, applied to the countables W4 added: a stair's treads and
// a casework run's cells come from real dimensions, so wherever they are drawn
// at all, the count is one number.
// Each of these draws a BODY at every zoom and its detail only above the ramp,
// so the invariant is stated against the body's own baseline: the counts above
// it must all be the SAME number, never two.
for (const [category, spec, expectedDetail] of [
  ['Stair', { w: 3.0, h: 1.5 }, 2 * 11 + 2],   // 3.0 / 0.237 -> 12 treads (11 risers, 2 lines each) + 2 stringer lines
  ['Storage', { w: 2.88, h: 0.6 }, 3 * 2 + 2], // 2.88 / 0.96 -> 3 cells, 2 diagonals each + 2 dividers
  ['Settee', { w: 1.716, h: 0.7 }, 3],         // 1.716 / 0.572 -> 3 cushions
]) {
  const at = (k) => {
    const ctx = stubCtx()
    mod.drawSymbol(ctx, { category, cx: 0, cy: 0, rotation: 0, ...spec }, INK, { pxPerM: k, dpr: 1 })
    return ctx.calls.filter((c) => c.name === 'lineTo' || c.name === 'closePath').length
  }
  // The baseline is the BODY alone, measured below the primary band rather than
  // taken as the minimum of the sample — some of these draw their detail at every
  // zoom in ZOOMS, and `min` would then silently equal the full count.
  const baseline = at(0.5)
  const counts = ZOOMS.map(at)
  const detail = [...new Set(counts.filter((n) => n !== baseline))]
  check(`${category}: one detail count across all zooms`, detail.length, 1)
  check(`${category}: the count is world-derived`, detail[0] - baseline, expectedDetail)
}

// --- 9. the measured chair is not square, and its seat is the widest part ----
// The two facts `REF.chair` exists to carry, asserted against the DRAWN glyph
// rather than against the constant — a constant can be right while the code
// that reads it is not. `taskChair` emits its parts as roundRect paths, whose
// four `arcTo` corners bracket each part's extent.
{
  const ctx = stubCtx()
  mod.drawSymbol(ctx, { category: 'Chair', cx: 0, cy: 0, w: 0.565, h: 0.51, rotation: 0 },
                 INK, { pxPerM: 200, dpr: 1 })
  // Each roundRect starts with moveTo; collect per-part x extents from arcTo.
  const parts = []
  for (const c of ctx.calls) {
    if (c.name === 'moveTo') parts.push([c.args[0], c.args[0], c.args[1], c.args[1]])
    else if (c.name === 'arcTo' && parts.length) {
      const p = parts[parts.length - 1]
      for (const [x, y] of [[c.args[0], c.args[1]], [c.args[2], c.args[3]]]) {
        p[0] = Math.min(p[0], x); p[1] = Math.max(p[1], x)
        p[2] = Math.min(p[2], y); p[3] = Math.max(p[3], y)
      }
    }
  }
  const widths = parts.map((p) => p[1] - p[0]).sort((a, b) => b - a)
  const depths = parts.map((p) => p[3] - p[2])
  // The widest part is the SEAT and the next is the BACKREST — the inversion
  // this module carried before W4 (backrest 0.92 against a seat of 0.80).
  check('chair: the seat is drawn wider than the backrest', widths[0] > widths[1], true)
  check('chair: seat/backrest width ratio matches the measured 470/415',
        Math.abs(widths[0] / widths[1] - 470 / 415) < 0.02, true)
  // And the glyph is not square: 510.5 / 565.2 = 0.903.
  const span = Math.max(...parts.map((p) => p[3])) - Math.min(...parts.map((p) => p[2]))
  const across = Math.max(...parts.map((p) => p[1])) - Math.min(...parts.map((p) => p[0]))
  check('chair: measured depth/width aspect 0.903', Math.abs(span / across - 510.5 / 565.2) < 0.02, true)
  check('chair: parts drawn', parts.length >= 4 && depths.length >= 4, true)
}

// --- 10. the column is GREY-FILLED, not hatched -----------------------------
// `planStyle.ts` has declared `column.fill = solid COLUMN_FILL` for its whole
// life while this module drew a poché and no fill at all. Assert the fill
// reaches the canvas, and that no hatch does.
{
  const ctx = stubCtx()
  mod.drawSymbol(ctx, { category: 'Column', cx: 0, cy: 0, w: 0.674, h: 0.674, rotation: 0 },
                 INK, { pxPerM: 200, dpr: 1 })
  const names = ctx.calls.map((c) => c.name)
  check('column fills before it strokes', names.indexOf('fillRect') < names.indexOf('strokeRect'), true)
  check('column draws no hatch', names.includes('clip'), false)
}

console.log(fail === 0 ? `symbols.test.mjs: ALL PASS (${pass})` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
