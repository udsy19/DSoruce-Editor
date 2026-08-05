// LOD SWEEP — does level-of-detail change continuously, or in jumps?
//
//   node bench/lod-sweep.mjs
//
// WHY THIS WAS REWRITTEN — the defect this file used to have
// ----------------------------------------------------------
// The first version analysed recorded ink sweeps in bench/fixtures/. It was
// built that way deliberately, because Playwright is not a repo dependency and
// "a check that cannot run is not a sensor". That trade had a cost nobody
// stated at the time: **it could always run, and it no longer watched the
// code.** Proven during the three-branch merge by DELETING symbols.ts from the
// tree and re-running — still green.
//
// A check that runs but observes a recording is a REPLAY, not a sensor. It
// certifies the implementation that produced the fixture, which after a merge
// may be an implementation that no longer exists.
//
// So this reads the LIVE `lod()` out of symbols.ts and exercises it. Same
// zero-dependency property (it parses source, like ladder-check does with
// TIER), but the subject is now the code that ships.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'web/src/editor/symbols.ts')
if (!fs.existsSync(SRC)) {
  // The subject moving is a FAILURE, not an absence. The previous version of
  // this file passed green with symbols.ts deleted; that is precisely the
  // vacuity being fixed, so the missing-subject path must be loud.
  console.log(`LOD FAIL: ${path.relative(ROOT, SRC)} does not exist.`)
  console.log('  This check observes the shipped lod(). If symbol geometry moved,')
  console.log('  re-anchor this path in the SAME commit that moves it.')
  process.exit(1)
}
const src = fs.readFileSync(SRC, 'utf8')

// --- reconstruct the shipped implementation from source ---------------------
const bandBlock = src.match(/const BAND = \{([\s\S]*?)\} as const/)
if (!bandBlock) throw new Error('lod-sweep: BAND not found in symbols.ts')
const BAND = {}
for (const m of bandBlock[1].matchAll(/(\w+):\s*\{\s*exit:\s*([0-9.]+),\s*enter:\s*([0-9.]+)/g)) {
  BAND[m[1]] = { exit: +m[2], enter: +m[3] }
}

const fnBody = src.match(
  /export function lod\(sizePx: number, band: \{ exit: number; enter: number \}\): number \{([\s\S]*?)\n\}/,
)
if (!fnBody) throw new Error('lod-sweep: lod() not found in symbols.ts')
// Strip TS annotations — the body is plain arithmetic.
const lod = new Function('sizePx', 'band', fnBody[1].replace(/: number/g, ''))

let failed = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`)
  if (!ok) failed++
}

console.log(`lod-sweep — live ${path.relative(ROOT, SRC)}\n`)
console.log(`  bands: ${Object.entries(BAND).map(([k, b]) => `${k} ${b.exit}->${b.enter}`).join(', ')}\n`)

for (const [name, band] of Object.entries(BAND)) {
  const span = band.enter - band.exit
  const N = 400
  const xs = Array.from({ length: N + 1 }, (_, i) => band.exit - span * 0.25 + (i / N) * span * 1.5)
  const ys = xs.map((x) => lod(x, band))

  check(`${name}: 0 at and below exit`, lod(band.exit, band) === 0 && lod(band.exit - 1, band) === 0)
  check(`${name}: 1 at and above enter`, lod(band.enter, band) === 1 && lod(band.enter + 1, band) === 1)
  check(
    `${name}: monotonic non-decreasing`,
    ys.every((y, i) => i === 0 || y >= ys[i - 1] - 1e-12),
    'detail must not go backwards as a mark grows',
  )

  // THE ANTI-SNAP PROPERTY, and the reason this file exists. A step function
  // satisfies every assertion above; only this one separates a ramp from a
  // threshold. The largest jump between adjacent samples must stay small —
  // a snap shows up as a single jump of ~1.0.
  const jumps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]))
  const maxJump = Math.max(...jumps)
  check(
    `${name}: continuous — no step (max jump ${maxJump.toFixed(4)})`,
    maxJump < 0.05,
    'one sample-to-sample jump of ~1.0 is a threshold, not a ramp — every mark ' +
      'in the plan would change state at the same instant',
  )

  // And it must actually TRAVERSE the band rather than sitting at the ends.
  const interior = ys.filter((y) => y > 0.01 && y < 0.99).length
  check(`${name}: crossfades through the band (${interior} intermediate samples)`, interior > N / 4)
}

// --- historical evidence, explicitly NOT a verdict --------------------------
const fixtures = path.join(ROOT, 'bench/fixtures')
const recorded = fs.existsSync(fixtures)
  ? fs.readdirSync(fixtures).filter((f) => f.startsWith('lod-sweep-'))
  : []
if (recorded.length) {
  console.log(
    `\n  note  ${recorded.length} recorded ink sweep(s) retained in bench/fixtures/ as EVIDENCE\n` +
      `        for the original 2c finding (a snapped build produced 2 in-band\n` +
      `        discontinuities; a ramped one produced 0). They certify the\n` +
      `        implementation that produced them — furniture.ts, which no longer\n` +
      `        exists — so they are history, not this check's verdict.`,
  )
}

console.log()
if (failed > 0) {
  console.log(`LOD FAIL: ${failed} assertion(s) against the shipped lod().`)
  process.exit(1)
}
console.log('lod OK — the shipped lod() ramps continuously across every band')
