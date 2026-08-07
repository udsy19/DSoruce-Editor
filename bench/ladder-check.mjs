// LADDER CHECK — the weight ladder's RATIOS must survive strokePx().
//
//   node bench/ladder-check.mjs
//
// The ladder is the one part of the plan grammar with a vector-exact source:
// the qbiq reference PDF's own path widths, measured in Phase 0. Its content is
// the RATIOS between tiers, not the absolute points — those belong to the
// reference's page scale, not our screen.
//
// So the property worth enforcing is: for every tier,
//
//     strokePx(tier) / strokePx(furniture)  ===  TIER[tier] / TIER[furniture]
//
// This is not tautological, and that is the whole reason the file exists.
// strokePx clamps to [MIN, MAX]. A clamp is a NON-LINEAR step: the moment any
// tier lands on a bound, the ratios silently stop matching the measured ladder
// while every individual width still looks perfectly reasonable. Change
// BASE_STROKE_PX, tighten a clamp, or enable world-scaled widths (the
// pixelsPerMeter parameter that exists for exactly that), and a heavy tier hits
// MAX first — flattening the top of the ladder into a plateau.
//
// Ladder face 9 applies with full force here: an error that scales every tier
// equally is INVISIBLE in a ratio-defined system. The converse is what this
// checks — an error that scales tiers UNEQUALLY is invisible in any single
// width. Neither is findable by looking at output; both are findable here.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'web/src/editor/planStyle.ts'), 'utf8')

// Read the table as source, so this check cannot drift from what ships by
// importing some parallel copy of the constants.
const num = (name) => {
  const m = SRC.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`))
  if (!m) throw new Error(`ladder-check: ${name} not found in planStyle.ts`)
  return parseFloat(m[1])
}
const BASE = num('BASE_STROKE_PX')
const MIN = num('MIN_STROKE_PX')
const MAX = num('MAX_STROKE_PX')

const tierBlock = SRC.match(/export const TIER = \{([\s\S]*?)\} as const/)
if (!tierBlock) throw new Error('ladder-check: TIER table not found')
const TIER = {}
for (const m of tierBlock[1].matchAll(/(\w+):\s*([0-9.]+)/g)) TIER[m[1]] = parseFloat(m[2])

const strokePx = (tier) => Math.min(MAX, Math.max(MIN, BASE * TIER[tier]))

// Measured source of truth (research/qbiq-plan-style-spec.json, line_weights).
// Restated here so a change to the table alone cannot quietly redefine "correct".
const MEASURED_PT = {
  furniture: 0.1452,
  detail: 0.1524,
  column: 0.2177,
  wall: 0.2903,
  roomEnclosure: 1.0234,
  openingPunch: 1.2339,
}
const TOLERANCE = 0.01 // 1% — the measured pt values carry their own rounding

// COMPLETENESS, and it is the half this file shipped without (V3, adversary
// round). The loop below used to iterate `TIER` — the table under test — so a
// rung DELETED from the table was simply not visited, and `ladder OK — 5 tiers`
// printed green with `roomEnclosure` gone. A check that iterates its subject can
// only ever grade the rungs the subject chose to offer: `.claude/rules/
// gate-independence.md`, "derive the full expected set, never presence-match".
//
// So the expected set is MEASURED_PT, which is the spec, and the two sides are
// compared BOTH ways: a rung in the spec that the table no longer carries is a
// deletion, and a rung in the table with no measured value is an invention with
// no ground truth behind its ratio. Neither can be graded, so neither is a skip.
//
// R10 — WHICH AXES THIS GUARD'S FALSIFICATION VARIES: (1) the VALUE — perturb a
// multiplier, the ratio leaves tolerance; (2) the CLAMP — move BASE_STROKE_PX so
// a tier lands on a bound; (3) MEMBERSHIP — delete a rung from TIER, or add one
// the spec does not measure. Only (1) and (2) were ever varied.
{
  const inTable = new Set(Object.keys(TIER))
  const inSpec = new Set(Object.keys(MEASURED_PT))
  const missing = [...inSpec].filter((t) => !inTable.has(t))
  const extra = [...inTable].filter((t) => !inSpec.has(t))
  if (missing.length || extra.length) {
    if (missing.length) {
      console.log(`LADDER FAIL: TIER is missing ${missing.length} measured rung(s): ${missing.join(', ')}`)
      console.log('  The ladder IS the ratios; a rung that is not in the table is not graded,')
      console.log('  and iterating the table instead of the spec is how that went unnoticed.')
    }
    if (extra.length) {
      console.log(`LADDER FAIL: TIER carries ${extra.length} rung(s) the spec does not measure: ${extra.join(', ')}`)
      console.log('  research/qbiq-plan-style-spec.json is the only source of a correct ratio.')
      console.log('  Measure it there first, or the tier has no ground truth to reproduce.')
    }
    process.exit(1)
  }
}

let failed = 0
const base = strokePx('furniture')
console.log('tier            TIER   rendered   ratio    measured   delta')
for (const tier of Object.keys(MEASURED_PT)) {
  const mult = TIER[tier]
  const px = strokePx(tier)
  const ratio = px / base
  const measured = MEASURED_PT[tier] / MEASURED_PT.furniture
  const delta = Math.abs(ratio - measured) / measured
  const clamped = px === MIN || px === MAX
  const ok = delta <= TOLERANCE && !clamped
  if (!ok) failed++
  console.log(
    `${tier.padEnd(15)}${String(mult).padEnd(7)}${px.toFixed(3).padEnd(11)}` +
      `${ratio.toFixed(3).padEnd(9)}${measured.toFixed(3).padEnd(11)}` +
      `${(delta * 100).toFixed(2)}%${clamped ? '  <- CLAMPED' : ''}${ok ? '' : '  <- FAIL'}`,
  )
}

if (failed > 0) {
  console.log(
    `\nLADDER FAIL: ${failed} tier(s) do not reproduce the measured ratios.\n` +
      'A clamped tier is a failure even if its own width looks fine — the clamp\n' +
      'flattens the ladder, and the ladder IS the ratios.',
  )
  process.exit(1)
}
console.log(
  `\nladder OK — ${Object.keys(MEASURED_PT).length} measured tiers, all present in TIER, ` +
    `reproduce the qbiq ratios within ${TOLERANCE * 100}%`,
)
console.log(`  base ${BASE} px · clamps [${MIN}, ${MAX}] · no tier on a bound`)
