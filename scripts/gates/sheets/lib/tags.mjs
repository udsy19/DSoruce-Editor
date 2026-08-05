// Opening-tag detection, from the RASTER, by construction properties only.
//
// `drawTagGlyph` (web/src/export/sheetSet.ts) draws a tag as
//
//     p.box(cx - r, cy - r, 2r, 2r, { fill: true, gray: 1 })   // white mask
//     polyOutline(p, cx, cy, r, 16, 0,       { rgb: INK,       width: 0.9 })  // Door
//     polyOutline(p, cx, cy, r, 6,  PI/6,    { rgb: BLUE_WALL, width: 1   })  // Window
//     p.text(cx, cy + size*0.32, size*0.68, tag, { align: 'center', bold: true, gray: 0.12 })
//
// so a tag is a REGULAR POLYGON of known radius, sides and rotation, stroked in
// a known palette colour, over a pure-white square. Those five facts are the
// whole detector: no producer-emitted position list is read, and the tag's
// identity is confirmed by the pure-neutral (`gray 0.12`, r == g == b) glyph run
// at its centre.
//
// The two sizes are the two call sites, and they are the classification:
//   * plan tag      `drawTagGlyph(p, pos.x, pos.y, …)`                size 11 pt
//   * schedule tag  `drawTagGlyph(p, b.panelX + 18, ly - 3, …, 8)`    size  8 pt
// A plan tag belongs in the plate; a schedule tag belongs in the panel.

import { sourceHex, isNeutral, isInk } from './sheetlib.mjs'

/** The two tag palettes, parsed out of sheetSet.ts — spec, not measurement. */
export function tagPalette() {
  return {
    Door: sourceHex('web/src/export/sheetSet.ts', 'INK'),
    Window: sourceHex('web/src/export/sheetSet.ts', 'BLUE_WALL'),
  }
}

/** The two glyph shapes, exactly as `drawTagGlyph` builds them. */
export const TAG_SHAPE = {
  Door: { sides: 16, rot: 0 },
  Window: { sides: 6, rot: Math.PI / 6 },
}

/** The two call sites' sizes (pt). `plan` tags must lie in the plate, `schedule`
 *  tags in the panel. */
export const TAG_SIZE_PT = { plan: 11, schedule: 8 }

/**
 * A pixel is "outline ink" for palette colour C when it is a blend of C toward
 * the page's white background: `px = t·C + (1-t)·255` for one shared t ≥ T_MIN.
 *
 * ANCHOR: this is antialiasing as the rasteriser defines it — the stroke is
 * composited over the glyph's own pure-white backdrop mask, so every edge pixel
 * lies on that segment BY CONSTRUCTION. `T_MIN = 0.45` keeps only pixels at
 * least 45% covered (a 0.9-1.0 pt stroke is ~2 px wide at 144 dpi, so its core
 * is fully covered); `TOL = 16` is 8-bit rounding slack on the two channels not
 * used to solve for t. Neither number is calibrated against a sheet.
 */
const T_MIN = 0.45
const T_MAX = 1.06
const TOL = 16

function makeMask(img, C) {
  const { w, h, data } = img
  // Solve t on the channel with the largest 255-C (best conditioned).
  let ch = 0
  for (let i = 1; i < 3; i++) if (255 - C[i] > 255 - C[ch]) ch = i
  const den = 255 - C[ch]
  const mask = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < w * h; p++, i += 3) {
    const t = (255 - data[i + ch]) / den
    if (t < T_MIN || t > T_MAX) continue
    // Both tag palettes are CHROMATIC by definition (#2e343b spreads 13,
    // #3b6fd4 spreads 153); text and rules are drawn with the grayscale `g`/`G`
    // operator and are PURE NEUTRAL by renderer definition. Rejecting neutrals
    // is what stops the 34 pt "A.02" — near-black, and a plausible blend of
    // #2e343b toward white — from scoring as a 16-gon.
    if (isNeutral(data[i], data[i + 1], data[i + 2])) continue
    let ok = true
    for (let k = 0; k < 3; k++) {
      if (Math.abs(data[i + k] - (255 - t * (255 - C[k]))) > TOL) {
        ok = false
        break
      }
    }
    if (ok) mask[p] = 1
  }
  return mask
}

/**
 * Outline sample points of the glyph — sampled along the STRAIGHT EDGES between
 * consecutive vertices, exactly the segments `polyOutline` emits as `p.line`.
 * (Sampling the circumscribed circle instead puts a hexagon's edge midpoint
 * r(1-cos 30°) = 3 px outside its own stroke at the plan size — the shape must
 * be reconstructed the way it is drawn.)
 */
function outlinePoints(sides, rot, r, per = 6) {
  const v = []
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2
    v.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  const pts = []
  for (let i = 0; i < sides; i++) {
    const [x0, y0] = v[i]
    const [x1, y1] = v[(i + 1) % sides]
    for (let s = 0; s < per; s++) {
      const t = s / per
      pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    }
  }
  return pts
}

/** Fraction of the glyph outline present in `mask` when centred at (cx,cy). */
function score(mask, w, h, cx, cy, pts) {
  let hit = 0
  for (const [dx, dy] of pts) {
    const x = Math.round(cx + dx)
    const y = Math.round(cy + dy)
    let found = false
    for (let oy = -1; oy <= 1 && !found; oy++) {
      for (let ox = -1; ox <= 1 && !found; ox++) {
        const px = x + ox
        const py = y + oy
        if (px >= 0 && py >= 0 && px < w && py < h && mask[py * w + px]) found = true
      }
    }
    if (found) hit++
  }
  return hit / pts.length
}

/** A tag's glyph run is pure-neutral bold text at its centre (`gray 0.12`). */
function hasNeutralCore(img, cx, cy, r) {
  let n = 0
  const R = Math.round(r * 0.75)
  for (let y = Math.round(cy - R); y <= Math.round(cy + R); y++) {
    for (let x = Math.round(cx - R); x <= Math.round(cx + R); x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue
      const i = (y * img.w + x) * 3
      const [rr, gg, bb] = [img.data[i], img.data[i + 1], img.data[i + 2]]
      if (isInk(rr, gg, bb) && isNeutral(rr, gg, bb) && rr < 160) n++
    }
  }
  return n
}

/** Minimum outline coverage for a glyph to be called a tag. A 16-gon/hexagon
 *  drawn as straight strokes is either there or not; 0.85 tolerates a couple of
 *  vertices swallowed by a dark wall underneath without admitting linework. */
const MIN_SCORE = 0.85

/**
 * Every opening tag on a sheet raster.
 * @returns [{ kind:'Door'|'Window', scale:'plan'|'schedule', cx, cy, r, score, glyphInk }]
 *          cx/cy/r in PIXELS.
 */
export function findTags(img, ptToPx) {
  const palette = tagPalette()
  const out = []
  for (const kind of ['Door', 'Window']) {
    const mask = makeMask(img, palette[kind])
    const { sides, rot } = TAG_SHAPE[kind]
    for (const scale of ['plan', 'schedule']) {
      const r = TAG_SIZE_PT[scale] * ptToPx
      const pts = outlinePoints(sides, rot, r)
      // Both shapes have a vertex at the glyph's topmost point (angle -PI/2 for
      // the 16-gon at rot 0, and -PI/2 for the hexagon at rot PI/6), so every
      // mask pixel is a candidate "top vertex" and the centre sits r below it.
      const seen = new Set()
      const hits = []
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue
        const qx = p % img.w
        const qy = (p / img.w) | 0
        for (let d = -1; d <= 1; d++) {
          const cx = qx
          const cy = qy + r + d
          const key = `${cx},${cy}`
          if (seen.has(key)) continue
          seen.add(key)
          if (cy - r < -2 || cy + r > img.h + 2) continue
          const sc = score(mask, img.w, img.h, cx, cy, pts)
          if (sc >= MIN_SCORE) hits.push({ cx, cy, score: sc })
        }
      }
      // Cluster: one glyph gives several near-identical accepted centres.
      hits.sort((a, b) => b.score - a.score || a.cy - b.cy || a.cx - b.cx)
      const kept = []
      for (const hgt of hits) {
        if (kept.some((k) => Math.hypot(k.cx - hgt.cx, k.cy - hgt.cy) < r)) continue
        const glyphInk = hasNeutralCore(img, hgt.cx, hgt.cy, r)
        kept.push({ ...hgt, kind, scale, r, glyphInk })
      }
      out.push(...kept)
    }
  }
  // A plan-scale glyph contains a schedule-scale one geometrically; keep the
  // larger when two detections share a centre.
  return out
    .filter((t, i, all) => !all.some((o, j) => j !== i && o.r > t.r && Math.hypot(o.cx - t.cx, o.cy - t.cy) < o.r))
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
}
