// Paired overlay: the DSource glyph against the MEASURED reference outline, at
// identical scale, per category.
//
//   node research/qbiq-symbol-overlay.mjs            # table only
//   node research/qbiq-symbol-overlay.mjs --png DIR  # + one PNG per pair
//
// WHY IT IS A DIFFERENCE AND NOT A SAMPLE
// ---------------------------------------
// `.claude/rules/gate-independence.md`: measure by DIFFERENCING two artifacts
// that differ only in the thing under test. So both sides are rendered by ONE
// code path, into ONE canvas size, at ONE scale, with ONE ink — the only thing
// that differs is which geometry gets drawn. Nothing samples a screenshot and
// reasons about which pixels belong to what.
//
// The reference side is drawn from `research/qbiq-symbol-spec.json`'s
// `outlines`, which are the PDF's own vertices in millimetres. The DSource side
// is `web/src/editor/symbols.ts`, bundled and executed — not reimplemented here,
// because a second copy of the glyph would measure the copy.
//
// THE METRIC, AND ITS TOLERANCE
// -----------------------------
// `ink_iou`: intersection over union of the two ink masks after dilating each by
// SHAPE_TOL_MM. That radius is not a knob — it is the SAME tolerance
// `qbiq-symbol-extract.py` uses to decide that two of the reference's own paths
// are the same part (25 mm, itself calibrated by a sweep). Two marks that the
// extractor would call congruent must score 1.0 here.
//
//   PASS  ink_iou >= 0.60
//
// 0.60 is stated, not derived, and it is the one number in this file that is a
// judgement: it is the level at which the two drawings read as the same symbol
// rather than as the same object drawn differently. It is reported alongside the
// BEFORE value from the pre-W4 glyph, and that pairing is the real evidence —
// a threshold nobody can falsify is worth less than a direction of movement
// measured with one instrument.
//
// `diff_pct` is also reported: the plain proportion of differing pixels over the
// union, i.e. 1 - IoU with NO dilation. It is the harsher number and it is what
// `scripts/pixdiff.py` would say.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'web')
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'research/qbiq-symbol-spec.json'), 'utf8'))

/** Same value as the extractor's SHAPE_TOL_MM. Read from the spec, not retyped. */
const TOL_MM = SPEC.parameters.shape_tol_mm
const PASS_IOU = 0.60
/** Render scale. 0.25 px/mm puts a 565 mm chair at 141 px — big enough that the
 *  metric is about the shape and not about the rasteriser. */
const PX_PER_MM = 0.25

/**
 * The pairs. Each names a DSource category and the reference symbol it must
 * answer to, keyed by the spec's `reading` — a READING, per the extractor's own
 * `naming_provenance`. Where no reference symbol exists the pair says so and is
 * reported as unpaired rather than scored against something else.
 */
//
// The optional third element is the COMPONENT FOOTPRINT in mm, where the glyph
// legitimately draws outside it. Only `Desk` has that property, and only since
// W4 made it true on purpose: the reference's workstation symbol measures
// 1348 x 1021 mm but its DESK is the 674 x 1348 mm bench position that the
// extractor's own scale anchor pins (`scale.anchor_check.dominant_mm`), with the
// chair drawn beyond the front edge. Passing the whole 1021 mm as the component
// would ask our glyph to draw a 1021 mm-deep worktop and then score it for not
// being 674 — measuring the harness, not the symbol.
const PAIRS = [
  ['Chair', 'task chair: seat 470x429, backrest 415x82, two armrests 48x286'],
  ['Desk', 'workstation: bench desk position + tucked task chair', 'anchor'],
  ['Table', 'meeting table top, rounded rect'],
  ['Storage', 'crossed-X casework run: outline + cell divider + both diagonals'],
  ['Plant', 'planter: overlapping foliage blobs'],
  ['Settee', 'lounge armchair with wrap-around back'],
  ['Column', '$columns'], // synthesised from spec.columns — a different tier
  ['Furniture', null],
  ['Stair', null],
  ['Lift', null],
  ['WC', null],
]

/** Reference geometry for a pair, in mm, centred on (0,0). */
function referenceGeometry(key, footprint) {
  if (key === null) return null
  if (key === '$columns') {
    const c = SPEC.columns.sizes_mm[0]
    return {
      w: c.w, h: c.h, fill: SPEC.columns.fill_hex,
      outlines: [[[-c.w / 2, -c.h / 2], [c.w / 2, -c.h / 2], [c.w / 2, c.h / 2],
                  [-c.w / 2, c.h / 2], [-c.w / 2, -c.h / 2]]],
    }
  }
  const s = SPEC.symbols.find((x) => x.reading === key)
  if (!s) throw new Error(`no reference symbol reads "${key}" — the spec moved under this script`)
  const g = { w: s.w_mm, h: s.h_mm, fill: null, outlines: s.outlines }
  if (footprint === 'anchor') {
    const [a, b] = SPEC.scale.anchor_check.dominant_mm
    g.fw = Math.max(a, b)
    g.fh = Math.min(a, b)
    // Registration is DERIVED from the reference, not chosen: the component is
    // the symbol's largest outline (the desk rect), so our glyph is drawn at
    // that outline's own centre. Nothing here searches for a flattering offset.
    let best = null
    for (const poly of g.outlines) {
      const xs = poly.map((p) => p[0]); const ys = poly.map((p) => p[1])
      const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      if (!best || area > best.area) {
        best = { area, ox: (Math.max(...xs) + Math.min(...xs)) / 2,
                 oy: (Math.max(...ys) + Math.min(...ys)) / 2 }
      }
    }
    g.ox = best.ox; g.oy = best.oy
  }
  return g
}

async function bundle(entrySrc, outfile) {
  const webRequire = createRequire(path.join(WEB, 'package.json'))
  const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
  const { build } = await import(pathToFileURL(esbuildPath).href)
  await build({
    entryPoints: [entrySrc], outfile, bundle: true, format: 'esm',
    platform: 'neutral', target: 'es2022', logLevel: 'silent',
  })
  return fs.readFileSync(outfile, 'utf8')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symoverlay-'))

/** Bundle the CURRENT symbols.ts, and the one at HEAD, so BEFORE and AFTER are
 *  measured by the same instrument in the same run. */
const nowEntry = path.join(tmp, 'now.ts')
fs.writeFileSync(nowEntry, `export * from ${JSON.stringify(path.join(WEB, 'src/editor/symbols.ts'))}`)
const nowJs = await bundle(nowEntry, path.join(tmp, 'now.mjs'))

let headJs = null
try {
  const headDir = path.join(tmp, 'head/web/src/editor')
  fs.mkdirSync(headDir, { recursive: true })
  for (const f of ['symbols.ts', 'planStyle.ts']) {
    fs.writeFileSync(path.join(headDir, f),
      execFileSync('git', ['show', `HEAD:web/src/editor/${f}`], { cwd: ROOT, maxBuffer: 1 << 26 }))
  }
  // planStyle imports a type from ../types/doc; type-only, so a stub suffices.
  fs.mkdirSync(path.join(tmp, 'head/web/src/types'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'head/web/src/types/doc.ts'), 'export type ZoneType = string\n')
  const headEntry = path.join(tmp, 'headEntry.ts')
  fs.writeFileSync(headEntry, `export * from ${JSON.stringify(path.join(headDir, 'symbols.ts'))}`)
  headJs = await bundle(headEntry, path.join(tmp, 'head.mjs'))
} catch (e) {
  console.error(`(BEFORE column unavailable: ${e.message.split('\n')[0]})`)
}

const PNG_DIR = process.argv.includes('--png')
  ? process.argv[process.argv.indexOf('--png') + 1] : null
const { chromium } = createRequire(path.join(WEB, 'package.json'))('playwright')
const browser = await chromium.launch()
const page = await browser.newPage()

const INK = { stroke: '#000000', detail: '#000000', fill: '#ffffff', seat: '#ffffff', accent: '#000000' }

const results = await page.evaluate(async ({ nowJs, headJs, pairs, tolMm, pxPerMm, ink, wantPng }) => {
  const load = async (src) =>
    src ? await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))) : null
  const now = await load(nowJs)
  const head = await load(headJs)

  function mask(draw, W, H) {
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)
    ctx.translate(W / 2, H / 2)
    draw(ctx)
    const d = ctx.getImageData(0, 0, W, H).data
    const m = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (d[i * 4] < 160) m[i] = 1  // ink = anything darker than paper
    return m
  }

  function dilate(m, W, H, r) {
    if (r <= 0) return m
    const out = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W || dx * dx + dy * dy > r * r) continue
            out[yy * W + xx] = 1
          }
        }
      }
    }
    return out
  }

  const rawIou = (a, b) => {
    let inter = 0, uni = 0
    for (let i = 0; i < a.length; i++) {
      if (a[i] || b[i]) uni++
      if (a[i] && b[i]) inter++
    }
    return uni ? inter / uni : 1
  }

  // The extractor canonicalises every symbol's ORIENTATION (landscape bbox,
  // third-moment signs) and therefore quotients its output by the dihedral
  // group — which way a chair's backrest points is not preserved in the spec.
  // So agreement has to be measured over the same quotient, or the number is a
  // measurement of the extractor's canonical frame rather than of our glyph.
  // Only the four bbox-preserving symmetries are tried; a 90-degree turn would
  // change the raster size and is not a candidate against a fixed canvas.
  const flip = (m, W, H, fx, fy) => {
    if (!fx && !fy) return m
    const out = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        out[(fy ? H - 1 - y : y) * W + (fx ? W - 1 - x : x)] = m[y * W + x]
    return out
  }
  const iou = (a, b, W, H) => Math.max(
    ...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([fx, fy]) => rawIou(flip(a, W, H, fx, fy), b)))

  const out = []
  let row_png = null
  for (const [category, ref] of pairs) {
    row_png = null
    if (!ref) { out.push({ category, unpaired: true }); continue }
    const W = Math.max(24, Math.round(ref.w * pxPerMm) + 8)
    const H = Math.max(24, Math.round(ref.h * pxPerMm) + 8)
    const wM = (ref.fw ?? ref.w) / 1000, hM = (ref.fh ?? ref.h) / 1000
    const view = { pxPerM: pxPerMm * 1000, dpr: 1 }

    const drawRef = (ctx) => {
      ctx.lineWidth = 1
      ctx.strokeStyle = '#000000'
      if (ref.fill) { ctx.fillStyle = ref.fill }
      for (const poly of ref.outlines) {
        ctx.beginPath()
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * pxPerMm, y * pxPerMm)
                                       : ctx.moveTo(x * pxPerMm, y * pxPerMm)))
        if (ref.fill) ctx.fill()
        ctx.stroke()
      }
    }
    const drawOurs = (mod) => (ctx) =>
      mod.drawSymbol(ctx, {
        category, cx: (ref.ox ?? 0) * pxPerMm, cy: (ref.oy ?? 0) * pxPerMm,
        w: wM, h: hM, rotation: 0,
      }, ink, view)

    const R = mask(drawRef, W, H)
    const A = mask(drawOurs(now), W, H)
    if (wantPng) {
      const c = document.createElement('canvas')
      c.width = W * 3 + 16; c.height = H
      const cx2 = c.getContext('2d')
      cx2.fillStyle = '#ffffff'; cx2.fillRect(0, 0, c.width, c.height)
      const put = (m, ox, col) => {
        const im = cx2.createImageData(W, H)
        for (let i = 0; i < W * H; i++) {
          const on = m[i]
          im.data[i * 4] = on ? col[0] : 255
          im.data[i * 4 + 1] = on ? col[1] : 255
          im.data[i * 4 + 2] = on ? col[2] : 255
          im.data[i * 4 + 3] = 255
        }
        cx2.putImageData(im, ox, 0)
      }
      put(R, 0, [0, 0, 0]); put(A, W + 8, [0, 0, 0])
      const ov = new Uint8Array(W * H)
      const im = cx2.createImageData(W, H)
      for (let i = 0; i < W * H; i++) {
        const r = R[i], a = A[i]
        im.data[i * 4] = a && !r ? 220 : 255
        im.data[i * 4 + 1] = r && !a ? 60 : (a && r ? 60 : 255)
        im.data[i * 4 + 2] = r && !a ? 220 : 255
        im.data[i * 4 + 3] = 255
      }
      cx2.putImageData(im, W * 2 + 16, 0)
      row_png = c.toDataURL('image/png')
    }
    const r = Math.max(1, Math.round(tolMm * pxPerMm))
    const row = {
      category, ref_w_mm: ref.w, ref_h_mm: ref.h,
      footprint_mm: ref.fw ? `${ref.fw}x${ref.fh}` : null, px: `${W}x${H}`,
      ink_iou: +iou(dilate(R, W, H, r), dilate(A, W, H, r), W, H).toFixed(3),
      diff_pct: +((1 - iou(R, A, W, H)) * 100).toFixed(1),
      ref_ink: R.reduce((s, v) => s + v, 0),
      ours_ink: A.reduce((s, v) => s + v, 0),
    }
    if (wantPng) row.png = row_png
    if (head) {
      try {
        const B = mask(drawOurs(head), W, H)
        row.ink_iou_before = +iou(dilate(R, W, H, r), dilate(B, W, H, r), W, H).toFixed(3)
        row.before_ink = B.reduce((s, v) => s + v, 0)
      } catch { row.ink_iou_before = null }
    }
    out.push(row)
  }
  return out
}, {
  nowJs, headJs, tolMm: TOL_MM, pxPerMm: PX_PER_MM, ink: INK, wantPng: PNG_DIR != null,
  pairs: PAIRS.map(([c, k, f]) => [c, referenceGeometry(k, f)]),
})

await browser.close()

if (PNG_DIR) {
  fs.mkdirSync(PNG_DIR, { recursive: true })
  for (const r of results) {
    if (!r.png) continue
    fs.writeFileSync(path.join(PNG_DIR, `${r.category}.png`),
      Buffer.from(r.png.split(',')[1], 'base64'))
    delete r.png
  }
  console.log(`wrote pair PNGs (reference | ours | overlay) to ${PNG_DIR}`)
}

// ---------------------------------------------------------------------------
console.log(`overlay tolerance: dilation ${TOL_MM} mm (= extractor SHAPE_TOL_MM), pass ink_iou >= ${PASS_IOU}`)
console.log('category    ref mm        raster   ink_iou  (before)  diff%   verdict')
let failed = 0
for (const r of results) {
  if (r.unpaired) {
    console.log(`${r.category.padEnd(11)} —             —        —        —         —      UNPAIRED (no reference symbol)`)
    continue
  }
  const ok = r.ink_iou >= PASS_IOU
  if (!ok) failed++
  const before = r.ink_iou_before == null ? '  —   ' : String(r.ink_iou_before).padEnd(6)
  console.log(
    `${r.category.padEnd(11)} ${`${r.ref_w_mm}x${r.ref_h_mm}`.padEnd(13)} ${r.px.padEnd(8)} ` +
    `${String(r.ink_iou).padEnd(8)} ${before}   ${String(r.diff_pct).padEnd(6)} ${ok ? 'PASS' : 'FAIL'}`)
}
const scored = results.filter((r) => !r.unpaired)
console.log(`\n${scored.length - failed}/${scored.length} paired categories at or above ${PASS_IOU}; ` +
            `${results.length - scored.length} unpaired.`)
if (headJs) {
  const moved = scored.filter((r) => r.ink_iou_before != null && r.ink_iou > r.ink_iou_before)
  const worse = scored.filter((r) => r.ink_iou_before != null && r.ink_iou < r.ink_iou_before)
  console.log(`vs HEAD: ${moved.length} improved, ${worse.length} regressed, ` +
              `${scored.length - moved.length - worse.length} unchanged.`)
}
