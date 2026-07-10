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
// mergeFit stamps `rotation = norm.rotation + π` and footprint `odd?[h,w]:[w,h]`.
// A pure +π rotation reproduces a vertical mirror ONLY for a LEFT-RIGHT-symmetric
// symbol (x → −x invariant). This harness renders every canonical imported-
// furniture symbol through a transform-recording fake ctx in BOTH paths and
// asserts, per category × authored quadrant:
//
//     merged_glyph  ==  verticalMirror( import_glyph )
//
// It PASSES for the symmetric symbols (Desk/Chair/Table/Window/Furniture) — proof
// the +π is exact — and it PINS the one asymmetric symbol (Door) as a rotation-
// vs-reflection limitation (documented; a rotation-only facet cannot mirror it).

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
const { drawFurnitureSymbol } = await bundle('../editor/furniture.ts')

// --- transform-recording fake CanvasRenderingContext2D -----------------------
// Tracks the CTM (2D affine) across save/restore/translate/rotate/scale and maps
// every drawing primitive into device space. It records the glyph as a set of
// SUBPATHS (polylines) + arc-center MARKERS. We compare glyphs by their UNDIRECTED
// EDGE MULTISET (+ marker multiset) — an invariant that ignores the arbitrary path
// START VERTEX and traversal direction (a rounded rect drawn from a rotated start
// corner is the SAME shape, so it must compare equal). A naive point-cloud compare
// would spuriously differ on the start vertex; edges are the honest orientation.
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

const SCALE = 100 // px/m — keep min symbol dimension > MIN_DETAIL so real glyphs draw

function record(opts) {
  const ctx = new RecordingCtx()
  drawFurnitureSymbol(ctx, { stroke: '#000', detail: '#000', accent: '#000', selected: false, ...opts })
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
const emptyDrawing = (item) => ({ units: 'm', bounds: [0, 0, 1, 1], layers: [], entities: [], furniture: [item] })
const FAR = [[1e5, 1e5], [1e5 + 1, 1e5], [1e5 + 1, 1e5 + 1], [1e5, 1e5 + 1]] // selection far away → item kept

// Render the IMPORT-VIEW glyph exactly as DrawingCanvas.drawItemSymbol does
// (un-swap aspect-baked w/h to natural, rotate by −norm.rotation).
function importGlyph(item) {
  const n = normalizeFurniture(item)
  const odd = Math.round(n.rotation / (Math.PI / 2)) % 2 !== 0
  const nw = odd ? n.h : n.w
  const nh = odd ? n.w : n.h
  return record({ category: n.category, cx: 0, cy: 0, w: nw * SCALE, h: nh * SCALE, rotation: -n.rotation })
}

// Render the MERGED glyph exactly as EditorCanvas.drawComponent does, from the
// component mergeFit actually produces (baseStampAround → StampComp).
function mergedGlyph(item) {
  const { comps } = baseStampAround(emptyDrawing(item), FAR, { x: 0, y: 0 })
  if (comps.length !== 1) throw new Error(`expected 1 comp, got ${comps.length}`)
  const c = comps[0]
  return { comp: c, glyph: record({ category: c.category, cx: 0, cy: 0, w: c.w * SCALE, h: c.h * SCALE, rotation: c.rotation }) }
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
// name keyword → category, and whether the symbol is left-right symmetric (so a
// vertical mirror IS reproducible by a pure rotation). Door is the lone exception.
const CASES = [
  { label: 'Desk (WORKSTATION)', name: 'WORKSTATION BENCH', symmetric: true },
  { label: 'Chair (TASK CHAIR)', name: 'TASK CHAIR', symmetric: true },
  { label: 'Table (CONF TABLE)', name: 'CONF TABLE', symmetric: true },
  { label: 'Window (GLAZED)', name: 'GLAZED PANEL', symmetric: true },
  { label: 'Furniture (SOFA)', name: 'SOFA LOUNGE UNIT', symmetric: true },
  { label: 'Door (DOOR LEAF)', name: 'DOOR SINGLE LEAF', symmetric: false },
]
// authored quadrants, with a footprint that keeps the aspect sane for each turn
const QUADS = [
  { deg: 0, bw: 1.5, bh: 0.7 },
  { deg: 90, bw: 0.7, bh: 1.5 },
  { deg: 180, bw: 1.5, bh: 0.7 },
  { deg: 270, bw: 0.7, bh: 1.5 },
]

let failures = 0
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++ }

console.log('=== orientation equivalence: merged glyph  vs  verticalMirror(import glyph) ===')
for (const cse of CASES) {
  let allMatch = true
  const detail = []
  for (const q of QUADS) {
    const item = mkItem(cse.name, q.bw, q.bh, q.deg)
    const imp = importGlyph(item)
    const { glyph: mrg } = mergedGlyph(item)
    const match = eq(mrg, mirrorY(imp))
    if (!match) allMatch = false
    detail.push(`${q.deg}°:${match ? 'ok' : 'MISMATCH'}`)
  }
  console.log(`  ${cse.label.padEnd(22)}  ${detail.join('  ')}`)
  if (cse.symmetric) {
    check(`${cse.label}: merged == verticalMirror(import) at all 4 quadrants`, allMatch)
  } else {
    // Door: a rotation-only facet cannot express the reflection, so it must NOT
    // match a pure mirror — this pins the documented limitation (and would flag
    // if someone made it accidentally symmetric or "fixed" it silently).
    check(`${cse.label}: rotation-only stamp CANNOT mirror an asymmetric symbol (documented limitation)`, !allMatch)
  }
}

// The +π is a real turn: a directional glyph at authored 0° must differ from its
// merged form (else the mirror/turn is a silent no-op and desks face wrong).
{
  const item = mkItem('WORKSTATION BENCH', 1.5, 0.7, 0)
  const imp = importGlyph(item)
  const { glyph: mrg } = mergedGlyph(item)
  check('Desk: merged glyph is NOT identical to the raw import glyph (the turn is applied)', !eq(mrg, imp))
}

// Footprint invariant: the merged glyph's ON-SCREEN extent equals the import
// view's (both derive from the same aspect-baked w/h), so positions/sizes never
// drift on merge — only facing changes.
{
  let ok = true
  for (const cse of CASES) {
    for (const q of QUADS) {
      const item = mkItem(cse.name, q.bw, q.bh, q.deg)
      const [iw, ih] = extent(importGlyph(item))
      const [mw, mh] = extent(mergedGlyph(item).glyph)
      if (Math.abs(iw - mw) > 1e-6 || Math.abs(ih - mh) > 1e-6) ok = false
    }
  }
  check('every category: merged on-screen extent equals the import view (no size drift)', ok)
}

// Door limitation, characterized: the component model has only a ROTATION facet
// (no mirror flag), so a door — the one handed symbol — cannot be perfectly
// mirrored. But the stamped `+π` is still the BEST rotation-only choice: it maps
// the swing to the correct HEMISPHERE (into vs out of the room), only the hinge
// hand is off. Prove `+π` is strictly closer to the true mirror than upright (0).
{
  const item = mkItem('DOOR SINGLE LEAF', 1.0, 0.15, 0)
  const target = rasterize(mirrorY(importGlyph(item)))
  const n = normalizeFurniture(item)
  const glyphAt = (rot) => rasterize(record({ category: n.category, cx: 0, cy: 0, w: n.w * SCALE, h: n.h * SCALE, rotation: rot }))
  const rPi = mismatchRatio(glyphAt(n.rotation + Math.PI), target) // the stamped choice
  const r0 = mismatchRatio(glyphAt(n.rotation), target) // upright (no turn)
  console.log(`  Door: mirror-mismatch  +π=${rPi.toFixed(3)}  vs  upright=${r0.toFixed(3)}`)
  check('Door: +π is the best rotation-only approximation of the mirror (< upright)', rPi < r0)
}

if (failures > 0) { console.log(`\n${failures} assertion(s) failed`); process.exit(1) }
console.log('\nAll orientation-equivalence assertions passed.')
