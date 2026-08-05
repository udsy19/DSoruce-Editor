// Orientation-equivalence harness for the merge-into-plan stamp (mergeFit.ts).
// Run from web/:  node src/import/mergeOrient.test.mjs
//
// WHAT THIS PROVES
// ----------------
// The imported 2D canvas (DrawingCanvas) renders furniture Y-UP (its toScreen is
// `y = -wy*scale + off`). The EDITOR canvas renders Y-DOWN (`y = wy*scale + off`)
// and the plate/furniture push is offset-ONLY (no Y negation). So the merged
// editor document is a GLOBAL VERTICAL MIRROR (y → −y) of the initial-import view.
// For a merged furniture symbol to face the SAME way it did in the import view
// (relative to its walls), its on-screen glyph must therefore equal the VERTICAL
// MIRROR of the import-view glyph.
//
// TWO carries, one invariant:
//   • SYMMETRIC symbols (Desk/Chair/Table/Window/Furniture) are left-right
//     invariant (x → −x), so mergeFit reproduces the vertical mirror with a pure
//     `rotation = norm.rotation + π` (no mirror facet). A +π turn == a y-flip for
//     these because the x-flip half of the mirror is a no-op on a symmetric glyph.
//   • The DOOR is handed (a genuine reflection — no rotation can map a left-hand
//     door onto a right-hand one), so mergeFit carries it as a real reflection:
//     `rotation = norm.rotation` (NO +π) with the hinge hand INVERTED
//     (`mirror = !norm.mirror`). The renderer reflects the leaf+arc on `mirror`
//     (symbols.ts `door`, via `ctx.scale(1,-1)` in `drawSymbol`).
//
// This harness renders every canonical imported-furniture symbol through a
// transform-recording fake ctx in BOTH paths — WITH the `mirror` facet threaded
// through exactly as DrawingCanvas.drawItemSymbol / EditorCanvas.drawComponent do
// — and asserts, per category × pose:
//
//     merged_glyph  ==  verticalMirror( import_glyph )
//
// It PASSES for the symmetric symbols at all 4 authored quadrants (proof the +π is
// exact) AND for the Door at all 4 opening axes × BOTH hinge hands (proof the
// reflection carry is exact — the door survives the merge facing the same way it
// swung in the import view, hinge side and swing direction both preserved).

// @covers: web/src/import/mergeFit.ts
// @covers: web/src/import/normalize.ts
// @covers: web/src/editor/symbols.ts

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRequire = createRequire(path.join(here, '../../package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)

const bundle = async (entry) => {
  const outFile = path.join(os.tmpdir(), `ds-${path.basename(entry, '.ts')}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({ entryPoints: [path.join(here, entry)], outfile: outFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(outFile).href)
  fs.rmSync(outFile, { force: true })
  return mod
}

const { normalizeFurniture } = await bundle('normalize.ts')
const { baseStampAround } = await bundle('mergeFit.ts')
const { drawSymbol } = await bundle('../editor/symbols.ts')

// --- transform-recording fake CanvasRenderingContext2D -----------------------
// Tracks the CTM (2D affine) across save/restore/translate/rotate/scale and maps
// every drawing primitive into device space. It records the glyph as a set of
// SUBPATHS (polylines) + arc-center MARKERS. We compare glyphs by rasterizing to
// a 1px bitmap — an invariant that ignores the arbitrary path START VERTEX and
// traversal direction (a rounded rect drawn from a rotated start corner is the
// SAME shape, so it must compare equal).
class RecordingCtx {
  constructor() {
    this.m = [1, 0, 0, 1, 0, 0] // a,b,c,d,e,f
    this.stack = []
    this.subpaths = [] // array of polylines (each an array of [x,y] device pts)
    this.markers = []  // isolated points (arc centers)
    this.cur = null
  }
  // property setters the symbols poke — no-ops
  set strokeStyle(_v) {}
  set fillStyle(_v) {}
  set lineWidth(_v) {}
  set lineJoin(_v) {}
  set lineCap(_v) {}
  set font(_v) {}
  set textAlign(_v) {}
  set textBaseline(_v) {}
  save() { this.stack.push(this.m.slice()) }
  restore() { if (this.stack.length) this.m = this.stack.pop() }
  translate(x, y) { this._mul([1, 0, 0, 1, x, y]) }
  scale(x, y) { this._mul([x, 0, 0, y, 0, 0]) }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this._mul([c, s, -s, c, 0, 0]) }
  _mul(n) {
    const m = this.m
    this.m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ]
  }
  _t(x, y) { const m = this.m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] }
  _flush() { if (this.cur && this.cur.length > 1) this.subpaths.push(this.cur); this.cur = null }
  // path primitives
  beginPath() { this._flush() }
  closePath() { if (this.cur && this.cur.length > 1) this.cur.push(this.cur[0]) }
  stroke() {}
  fill() {}
  clip() {}
  setLineDash() {}
  moveTo(x, y) { this._flush(); this.cur = [this._t(x, y)] }
  lineTo(x, y) { if (!this.cur) this.cur = []; this.cur.push(this._t(x, y)) }
  arcTo(x1, y1, x2, y2) { if (!this.cur) this.cur = []; this.cur.push(this._t(x1, y1)); this.cur.push(this._t(x2, y2)) }
  // rect / fillRect / strokeRect → a standalone closed 4-cycle
  rect(x, y, w, h) { this._rect(x, y, w, h) }
  strokeRect(x, y, w, h) { this._rect(x, y, w, h) }
  fillRect(x, y, w, h) { this._rect(x, y, w, h) }
  _rect(x, y, w, h) {
    const p = [this._t(x, y), this._t(x + w, y), this._t(x + w, y + h), this._t(x, y + h)]
    p.push(p[0])
    this.subpaths.push(p)
  }
  // arc: sample as a mini-polyline (captures the arc's swing/orientation) and
  // record the center as a marker (a door swing's hinge is a real directional cue).
  arc(cx, cy, r, a0, a1) {
    this.markers.push(this._t(cx, cy))
    const poly = []
    const N = 8
    for (let i = 0; i <= N; i++) { const a = a0 + (a1 - a0) * (i / N); poly.push(this._t(cx + r * Math.cos(a), cy + r * Math.sin(a))) }
    // arc appends to the current subpath in canvas semantics; keep it standalone
    // so start-vertex noise from a preceding moveTo can't contaminate it.
    this.subpaths.push(poly)
  }
  result() { this._flush(); return { subpaths: this.subpaths, markers: this.markers } }
}

// px/m — high enough that every LOD band is fully on, so the real glyphs (not a
// faded-out reduction) are what gets compared.
const SCALE = 100

// `drawSymbol` takes WORLD metres plus a view; `opts.w/h` here are metres.
function record(opts) {
  const ctx = new RecordingCtx()
  drawSymbol(
    ctx,
    { cx: 0, cy: 0, selected: false, ...opts },
    { stroke: '#000', detail: '#000', accent: '#000' },
    { pxPerM: SCALE, dpr: 1 },
  )
  return ctx.result()
}

// --- rasterize a glyph to a 1px pixel set (parameterization-invariant) --------
// Stroke every subpath segment (+ arc-center markers) into integer pixels via
// Bresenham. Comparing bitmaps ignores path start-vertex / traversal / corner-
// split artifacts entirely: two identical SHAPES rasterize to the same pixels.
function rasterize({ subpaths, markers }) {
  const px = new Set()
  const plot = (x, y) => px.add(`${x},${y}`)
  const line = (p, q) => {
    let x0 = Math.round(p[0]), y0 = Math.round(p[1])
    const x1 = Math.round(q[0]), y1 = Math.round(q[1])
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      plot(x0, y0)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  for (const sp of subpaths) for (let i = 0; i + 1 < sp.length; i++) line(sp[i], sp[i + 1])
  for (const m of markers) plot(Math.round(m[0]), Math.round(m[1]))
  return px
}
const mirrorY = ({ subpaths, markers }) => ({ subpaths: subpaths.map((sp) => sp.map(([x, y]) => [x, -y])), markers: markers.map(([x, y]) => [x, -y]) })
// Bitmap match with a 1px dilation tolerance (kills sub-pixel rounding noise).
// Returns the fraction of pixels in one set with no neighbor in the other.
function mismatchRatio(A, B) {
  const near = (set, k) => {
    const [x, y] = k.split(',').map(Number)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (set.has(`${x + dx},${y + dy}`)) return true
    return false
  }
  let miss = 0
  for (const k of A) if (!near(B, k)) miss++
  for (const k of B) if (!near(A, k)) miss++
  return (A.size + B.size) === 0 ? 0 : miss / (A.size + B.size)
}
// Two glyphs are equivalent if <2% of stroked pixels lack a near-match.
const eq = (a, b) => mismatchRatio(rasterize(a), rasterize(b)) < 0.02

// A synthetic imported block: landscape (bw>bh) or portrait, authored rotation.
const mkItem = (name, bw, bh, rotDeg, extra = {}) => ({
  id: 1, name, raw: name, category: 'furniture',
  bbox: [0, 0, bw, bh], origin: [bw / 2, bh / 2], rotation: (rotDeg * Math.PI) / 180, entities: [], ...extra,
})

// A synthetic DOOR block carrying a real swing arc so recoverDoorPose recovers a
// definite opening axis + hinge hand (an empty-entities door would fall back to
// upright/unmirrored and never exercise the mirror carry). Hinge at origin; the
// strike jamb runs along `axisDeg`; the leaf swings CCW (+90°, hand 'L' → the
// canonical unmirrored hand) or CW (−90°, hand 'R' → mirrored). Arc = a quarter
// circle tessellated to a polyline; a straight leaf line marks the open tip.
const arcPts = (cx, cy, r, a0, a1) => {
  const pts = []
  const n = 16
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]) }
  return pts
}
const mkDoor = (axisDeg, hand) => {
  const A = (axisDeg * Math.PI) / 180
  const strikeA = A
  const openA = A + (hand === 'L' ? Math.PI / 2 : -Math.PI / 2)
  const r = 0.9
  const arc = arcPts(0, 0, r, strikeA, openA)
  const open = [r * Math.cos(openA), r * Math.sin(openA)]
  const xs = arc.map((p) => p[0]).concat(0, open[0])
  const ys = arc.map((p) => p[1]).concat(0, open[1])
  return {
    id: 1, name: 'DOOR SINGLE LEAF', raw: 'DOOR SINGLE LEAF', category: 'door',
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    origin: [0, 0], rotation: A,
    entities: [
      { kind: 'polyline', layer: '0', category: 'door', pts: arc },
      { kind: 'polyline', layer: '0', category: 'door', pts: [[0, 0], open] },
    ],
  }
}
const emptyDrawing = (item) => ({ units: 'm', bounds: [0, 0, 1, 1], layers: [], entities: [], furniture: [item] })
const FAR = [[1e5, 1e5], [1e5 + 1, 1e5], [1e5 + 1, 1e5 + 1], [1e5, 1e5 + 1]] // selection far away → item kept

// Render the IMPORT-VIEW glyph exactly as DrawingCanvas.drawItemSymbol does
// (un-swap aspect-baked w/h to natural, rotate by −norm.rotation, apply the
// recovered `mirror` facet — a door's hinge hand).
function importGlyph(item) {
  const n = normalizeFurniture(item)
  const odd = Math.round(n.rotation / (Math.PI / 2)) % 2 !== 0
  const nw = odd ? n.h : n.w
  const nh = odd ? n.w : n.h
  return record({ category: n.category, w: nw, h: nh, rotation: -n.rotation, mirror: n.mirror })
}

// Render the MERGED glyph exactly as EditorCanvas.drawComponent does, from the
// component mergeFit actually produces (baseStampAround → StampComp): its
// rotation + inverted-for-doors `mirror` facet are both honored.
function mergedGlyph(item) {
  const { comps } = baseStampAround(emptyDrawing(item), FAR, { x: 0, y: 0 })
  if (comps.length !== 1) throw new Error(`expected 1 comp, got ${comps.length}`)
  const c = comps[0]
  return { comp: c, glyph: record({ category: c.category, w: c.w, h: c.h, rotation: c.rotation, mirror: c.mirror }) }
}

// Axis-aligned bbox [w,h] of a glyph's device geometry — the on-screen extent.
function extent({ subpaths, markers }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const acc = ([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  for (const sp of subpaths) sp.forEach(acc)
  markers.forEach(acc)
  return [maxX - minX, maxY - minY]
}

// --- cases -------------------------------------------------------------------
let failures = 0
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++ }

// (A) SYMMETRIC symbols: a pure +π carry reproduces the vertical mirror at every
//     authored quadrant (left-right invariance makes the x-flip half a no-op).
const SYMMETRIC = [
  { label: 'Desk (WORKSTATION)', name: 'WORKSTATION BENCH' },
  { label: 'Chair (TASK CHAIR)', name: 'TASK CHAIR' },
  { label: 'Table (CONF TABLE)', name: 'CONF TABLE' },
  { label: 'Window (GLAZED)', name: 'GLAZED PANEL' },
  { label: 'Furniture (SOFA)', name: 'SOFA LOUNGE UNIT' },
]
// authored quadrants, with a footprint that keeps the aspect sane for each turn
const QUADS = [
  { deg: 0, bw: 1.5, bh: 0.7 },
  { deg: 90, bw: 0.7, bh: 1.5 },
  { deg: 180, bw: 1.5, bh: 0.7 },
  { deg: 270, bw: 0.7, bh: 1.5 },
]

console.log('=== orientation equivalence: merged glyph  vs  verticalMirror(import glyph) ===')
for (const cse of SYMMETRIC) {
  let allMatch = true
  const detail = []
  for (const q of QUADS) {
    const item = mkItem(cse.name, q.bw, q.bh, q.deg)
    const match = eq(mergedGlyph(item).glyph, mirrorY(importGlyph(item)))
    if (!match) allMatch = false
    detail.push(`${q.deg}°:${match ? 'ok' : 'MISMATCH'}`)
  }
  console.log(`  ${cse.label.padEnd(22)}  ${detail.join('  ')}`)
  check(`${cse.label}: merged == verticalMirror(import) at all 4 quadrants`, allMatch)
}

// (B) DOOR — the handed symbol — now carried as a genuine reflection (rotation,
//     mirror inverted). It must match the vertical mirror at every opening AXIS
//     and BOTH hinge HANDS (hinge side + swing direction both preserved on merge).
for (const hand of ['L', 'R']) {
  let allMatch = true
  const detail = []
  for (const axisDeg of [0, 90, 180, 270]) {
    const item = mkDoor(axisDeg, hand)
    const match = eq(mergedGlyph(item).glyph, mirrorY(importGlyph(item)))
    if (!match) allMatch = false
    detail.push(`${axisDeg}°:${match ? 'ok' : 'MISMATCH'}`)
  }
  console.log(`  ${`Door (${hand === 'L' ? 'left' : 'right'}-hand)`.padEnd(22)}  ${detail.join('  ')}`)
  check(`Door (${hand === 'L' ? 'left' : 'right'}-hand): merged == verticalMirror(import) at all 4 opening axes`, allMatch)
}

// (C) A left-hand door and a right-hand door must NOT stamp to the same glyph —
//     the hand is a real, carried facet, not a silent drop (else every door would
//     face one way, the very bug the mirror facet fixes).
{
  const l = mergedGlyph(mkDoor(0, 'L')).glyph
  const r = mergedGlyph(mkDoor(0, 'R')).glyph
  check('Door: left-hand and right-hand stamp to DISTINCT glyphs (hand is carried, not dropped)', !eq(l, r))
}

// (D) The +π is a real turn: a directional glyph at authored 0° must differ from
//     its merged form (else the mirror/turn is a silent no-op and desks face wrong).
{
  const item = mkItem('WORKSTATION BENCH', 1.5, 0.7, 0)
  check('Desk: merged glyph is NOT identical to the raw import glyph (the turn is applied)', !eq(mergedGlyph(item).glyph, importGlyph(item)))
}

// (E) Footprint invariant: the merged glyph's ON-SCREEN extent equals the import
//     view's (both derive from the same aspect-baked w/h), so positions/sizes never
//     drift on merge — only facing changes. Covers symmetric pieces AND doors.
{
  let ok = true
  const items = []
  for (const cse of SYMMETRIC) for (const q of QUADS) items.push(mkItem(cse.name, q.bw, q.bh, q.deg))
  for (const hand of ['L', 'R']) for (const axisDeg of [0, 90, 180, 270]) items.push(mkDoor(axisDeg, hand))
  for (const item of items) {
    const [iw, ih] = extent(importGlyph(item))
    const [mw, mh] = extent(mergedGlyph(item).glyph)
    if (Math.abs(iw - mw) > 1e-6 || Math.abs(ih - mh) > 1e-6) ok = false
  }
  check('every category (incl. Door): merged on-screen extent equals the import view (no size drift)', ok)
}

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1) }
console.log('\nAll orientation-equivalence assertions passed.')
