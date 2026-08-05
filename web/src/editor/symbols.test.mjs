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

console.log(fail === 0 ? `symbols.test.mjs: ALL PASS (${pass})` : `${pass} passed, ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
