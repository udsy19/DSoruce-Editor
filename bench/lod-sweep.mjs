// LOD SWEEP — does zooming change the drawing continuously, or in jumps?
//
//   node bench/lod-sweep.mjs
//
// Analyses recorded zoom sweeps in bench/fixtures/lod-sweep-*.txt. Each line is
// `pxPerM:ink`, where ink is mean darkness over the canvas — a single number
// summarising how much the plan draws.
//
// WHY THE OBVIOUS METRIC IS WRONG, recorded because it was measured first and
// gave a BACKWARDS answer. The first attempt scored max/mean of the first
// differences and reported the SNAPPED build as smoother (2.21) than the
// continuous one (2.44). That metric is dominated by the zoom trend itself: ink
// changes steadily as the view scales, so a step change hides inside a series
// that is already moving. A large delta is not what a pop is.
//
// A POP IS A REVERSAL. Every symbol flips state at the same instant, so ink
// jumps AGAINST the direction it was travelling. What identifies it is a change
// of sign in the first difference, not its magnitude — a curvature property.
//
// The check therefore counts TREND REVERSALS and compares only reversals that
// differ between builds: reversals present in BOTH are not LOD artifacts (they
// come from the view re-framing at certain zooms) and must not be counted as
// evidence either way.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (f) =>
  fs
    .readFileSync(path.join(DIR, f), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const [px, ink] = l.trim().split(':')
      return { px: +px, ink: +ink }
    })

/** Points where the series turns around — down then up, or up then down. */
function reversals(series, eps = 0.05) {
  const d = series.slice(1).map((p, i) => p.ink - series[i].ink)
  const out = []
  for (let i = 0; i < d.length - 1; i++) {
    if ((d[i] < -eps && d[i + 1] > eps) || (d[i] > eps && d[i + 1] < -eps)) {
      out.push({ px: series[i + 1].px, from: +d[i].toFixed(3), to: +d[i + 1].toFixed(3) })
    }
  }
  return out
}

const snapped = read('lod-sweep-snapped.txt')
const continuous = read('lod-sweep-continuous.txt')

const rs = reversals(snapped)
const rc = reversals(continuous)
const key = (r) => r.px
const shared = rs.filter((r) => rc.some((o) => key(o) === key(r)))
const onlySnapped = rs.filter((r) => !rc.some((o) => key(o) === key(r)))
const onlyContinuous = rc.filter((r) => !rs.some((o) => key(o) === key(r)))

console.log(`sweep: ${snapped[0].px} -> ${snapped[snapped.length - 1].px} px/m, ${snapped.length} steps`)
console.log(`  reversals shared by both builds : ${shared.length}  ${shared.map((r) => r.px + ' px/m').join(', ')}`)
console.log(`    (view re-framing, not LOD — excluded from the verdict)`)
console.log(`  reversals ONLY when snapped     : ${onlySnapped.length}  ${onlySnapped.map((r) => `${r.px} px/m (${r.from} -> +${r.to})`).join(', ')}`)
console.log(`  reversals ONLY when continuous  : ${onlyContinuous.length}`)

if (onlyContinuous.length > 0) {
  console.log('\nLOD FAIL: the continuous build introduces a discontinuity the snapped one lacks.')
  process.exit(1)
}
if (onlySnapped.length === 0) {
  console.log(
    '\nLOD INCONCLUSIVE: the snapped build shows no pop either, so this sweep does\n' +
      'not cross the LOD band. Re-capture across the band before drawing a conclusion.',
  )
  process.exit(1)
}
console.log(
  `\nlod OK — the snap produces ${onlySnapped.length} discontinuit${onlySnapped.length === 1 ? 'y' : 'ies'} ` +
    `inside the LOD band that the continuous ramp does not.`,
)
