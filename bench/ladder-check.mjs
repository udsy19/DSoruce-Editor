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

let failed = 0
const base = strokePx('furniture')
console.log('tier            TIER   rendered   ratio    measured   delta')
for (const [tier, mult] of Object.entries(TIER)) {
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
console.log(`\nladder OK — ${Object.keys(TIER).length} tiers reproduce the qbiq ratios within ${TOLERANCE * 100}%`)
console.log(`  base ${BASE} px · clamps [${MIN}, ${MAX}] · no tier on a bound`)
