// LADDER CHECK — the weight ladder's RATIOS must survive strokePx().
//
//   node bench/ladder-check.mjs
//
// The ladder is the one part of the plan grammar with a vector-exact source:
// the qbiq reference PDF's own path widths, measured in Phase 0 and recorded in
// `research/qbiq-plan-style-spec.json`. Its content is the RATIOS between tiers,
// not the absolute points — those belong to the reference's page scale, not our
// screen.
//
// So the property worth enforcing is: for every tier,
//
//     strokePx(tier) / strokePx(base)  ===  spec.pt[tier] / spec.base_pt
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
//
// ---------------------------------------------------------------------------
// V4 — WHY THE GROUND TRUTH IS NOW READ, NOT RESTATED
// ---------------------------------------------------------------------------
// This file used to carry `MEASURED_PT`, a hand-copy of the spec's six measured
// pt values, under a comment calling the spec "the only source of a correct
// ratio" — while never opening it. V3 had moved the anchor off the TIER table
// (the subject) and onto that copy, which reads as a fix and is not one: ONE
// SIDE ANCHORED TO A COPY OF GROUND TRUTH IS NOT ANCHORED TO GROUND TRUTH.
// Reproduced, at HEAD, before this rewrite: deleting the room-enclosure tier
// FROM THE SPEC left the gate printing `ladder OK — 6 measured tiers, all
// present in TIER`, exit 0, while the spec measured 5. Same family as the D-O
// finding in `.claude/rules/gate-independence.md` — presence-matching two lists
// that both descend from one upstream copy.
//
// SUBJECT vs GROUND TRUTH, stated so the next reader cannot get it backwards:
//   subject      = `web/src/editor/planStyle.ts` — TIER, BASE/MIN/MAX_STROKE_PX.
//                  This is the shipping implementation. It is what is graded.
//   ground truth = `research/qbiq-plan-style-spec.json`, `line_weights`. Measured
//                  by PyMuPDF from the reference PDF's own vector operators — an
//                  EXTERNAL artifact, produced before planStyle.ts existed and
//                  not derived from it. Anchoring to planStyle.ts's own exports
//                  instead would make this gate compare the subject to itself.
//
// The only thing this file still states about the reference is the VOCABULARY
// BRIDGE below: the spec names its tiers in prose ("room / zone enclosure"), the
// implementation names them as identifiers (`roomEnclosure`). Two artifacts
// describing one ladder in two vocabularies have to be joined somewhere, and the
// gate — which is the only thing that reads both — is where. The bridge carries
// NO NUMBERS. Every graded value comes out of the JSON at run time.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPEC_PATH = 'research/qbiq-plan-style-spec.json'

/** The spec restates its own ladder in four places (per-tier `pt`, per-tier
 *  `ratio`, `base_pt`, and `tolerances.stroke_ratio.ladder`), rounded to 2-3
 *  significant figures. 0.5% is comfortably above that rounding (worst real gap:
 *  0.046%) and far below any edit anyone would make on purpose. */
const SPEC_SELF_TOL = 0.005

let failed = 0
const fail = (...lines) => {
  failed++
  for (const l of lines) console.log(l)
}
/** Structural problems abort: with no ground truth there is nothing to grade,
 *  and a gate that shrugs at a missing input hands the producer a veto over its
 *  own test (`gate-independence.md`, "a missing input is a FAILURE, never a
 *  skip"). */
const abort = (msg) => {
  console.log(`LADDER FAIL: ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// THE SUBJECT — parsed out of planStyle.ts source, so this check cannot drift
// from what ships by importing some parallel copy of the constants.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(ROOT, 'web/src/editor/planStyle.ts'), 'utf8')
const num = (name) => {
  const m = SRC.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`))
  if (!m) abort(`${name} not found in planStyle.ts`)
  return parseFloat(m[1])
}
const BASE = num('BASE_STROKE_PX')
const MIN = num('MIN_STROKE_PX')
const MAX = num('MAX_STROKE_PX')

const tierBlock = SRC.match(/export const TIER = \{([\s\S]*?)\} as const/)
if (!tierBlock) abort('TIER table not found in planStyle.ts')
const TIER = {}
for (const m of tierBlock[1].matchAll(/(\w+):\s*([0-9.]+)/g)) TIER[m[1]] = parseFloat(m[2])
if (Object.keys(TIER).length === 0) abort('TIER table parsed empty')

const strokePx = (tier) => Math.min(MAX, Math.max(MIN, BASE * TIER[tier]))

// ---------------------------------------------------------------------------
// THE GROUND TRUTH — read from the spec file, every time this runs.
// ---------------------------------------------------------------------------
let SPEC
try {
  SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, SPEC_PATH), 'utf8'))
} catch (e) {
  abort(`cannot read ${SPEC_PATH} — ${e.message}\n  It is the only source of a correct ratio; without it nothing here is graded.`)
}
const LW = SPEC.line_weights
if (!LW || !Array.isArray(LW.tiers) || LW.tiers.length === 0) {
  abort(`${SPEC_PATH} has no line_weights.tiers array`)
}
const BASE_PT = LW.base_pt
if (!Number.isFinite(BASE_PT) || BASE_PT <= 0) {
  abort(`${SPEC_PATH}: line_weights.base_pt is not a positive number (${JSON.stringify(BASE_PT)})`)
}

// The vocabulary bridge. Anchored on each role's leading noun, so a prose edit
// elsewhere in the sentence is tolerated but a retitled or deleted tier is not.
// Totality AND injectivity are asserted in both directions immediately below —
// an unmatched role is a measured rung with no implementation key, and an
// unmatched pattern is a rung that has left the spec.
const BRIDGE = [
  [/^furniture\b/i, 'furniture'],
  [/^fine detail\b/i, 'detail'],
  [/^structural columns\b/i, 'column'],
  [/^walls\b/i, 'wall'],
  [/^room\b/i, 'roomEnclosure'],
  [/^opening\b/i, 'openingPunch'],
]
/** Which tier the spec calls its base. Used only to name the ratio denominator;
 *  the value comes from `line_weights.base_pt`. */
const BASE_TIER = 'furniture'

// MEASURED: {key -> pt}, built ONLY from the spec.
const MEASURED = {}
const roleOf = {}
for (const [i, t] of LW.tiers.entries()) {
  if (typeof t.role !== 'string' || !Number.isFinite(t.pt) || t.pt <= 0) {
    abort(`${SPEC_PATH}: line_weights.tiers[${i}] has no usable role/pt — ${JSON.stringify(t)}`)
  }
  const hits = BRIDGE.filter(([re]) => re.test(t.role))
  if (hits.length !== 1) {
    fail(
      `LADDER FAIL: spec role ${JSON.stringify(t.role)} matches ${hits.length} implementation tier(s)` +
        `${hits.length ? ` (${hits.map(([, k]) => k).join(', ')})` : ''}.`,
      '  The spec measured a rung this gate cannot name, so its ratio cannot be graded.',
      '  Extend the vocabulary bridge in bench/ladder-check.mjs — and give planStyle.ts',
      '  the tier, because a measured rung nothing implements is a gap, not a nuisance.',
    )
    continue
  }
  const key = hits[0][1]
  if (key in MEASURED) {
    fail(`LADDER FAIL: two spec roles both map to '${key}': ${JSON.stringify(roleOf[key])} and ${JSON.stringify(t.role)}`)
    continue
  }
  MEASURED[key] = t.pt
  roleOf[key] = t.role

  // The spec states each ratio a second time, as a stored `ratio` field. Two
  // stored numbers for one fact drift; assert they still agree, so an edit to
  // either one is loud. (They are stored, not derived — this can fail.)
  if (!Number.isFinite(t.ratio)) {
    fail(`LADDER FAIL: spec tier ${JSON.stringify(t.role)} has no numeric \`ratio\` beside its \`pt\``)
  } else {
    const d = Math.abs(t.ratio - t.pt / BASE_PT) / (t.pt / BASE_PT)
    if (d > SPEC_SELF_TOL) {
      fail(
        `LADDER FAIL: spec tier ${JSON.stringify(t.role)} is internally inconsistent — ` +
          `ratio ${t.ratio} vs pt/base_pt ${(t.pt / BASE_PT).toFixed(5)} (${(d * 100).toFixed(2)}%).`,
        '  One of the two was edited and the other was not. Ground truth that disagrees',
        '  with itself cannot grade anything.',
      )
    }
  }
}
// The bridge must be total in the other direction too: a pattern with no role is
// how the reproduced defect looked from the spec's side.
for (const [re, key] of BRIDGE) {
  if (!(key in MEASURED)) {
    fail(
      `LADDER FAIL: no tier in ${SPEC_PATH} matches ${re} — the '${key}' rung has left the spec.`,
      '  Either it was deleted from the measured ladder (in which case planStyle.ts is',
      '  drawing a weight with no ground truth behind it), or its role was retitled and',
      '  this bridge needs updating. Both are edits somebody must look at.',
    )
  }
}
if (!(BASE_TIER in MEASURED)) {
  abort(`${SPEC_PATH} no longer measures the '${BASE_TIER}' tier — the ladder has no origin to take ratios against`)
}
// base_pt is a third statement of the base tier's width. Same reasoning.
{
  const d = Math.abs(BASE_PT - MEASURED[BASE_TIER]) / MEASURED[BASE_TIER]
  if (d > SPEC_SELF_TOL) {
    fail(
      `LADDER FAIL: line_weights.base_pt ${BASE_PT} disagrees with the '${BASE_TIER}' tier's ` +
        `pt ${MEASURED[BASE_TIER]} (${(d * 100).toFixed(2)}%).`,
      '  The base IS that tier; if they part company every ratio below is taken against',
      '  a denominator the spec does not stand behind.',
    )
  }
}

// The spec states the ladder a FOURTH time, in `tolerances.stroke_ratio.ladder`
// — a partial (4 of 6) pre-registered acceptance ladder in a third vocabulary.
// It is checked because a spec edit made in only one of its two ladder sections
// is exactly the silent disagreement this rewrite exists to make loud.
{
  const decl = SPEC.tolerances?.stroke_ratio?.ladder
  if (!decl || typeof decl !== 'object') {
    fail(`LADDER FAIL: ${SPEC_PATH} has no tolerances.stroke_ratio.ladder — the pre-registered acceptance ladder is gone`)
  } else {
    const DECL_BRIDGE = {
      furniture: 'furniture',
      walls: 'wall',
      room_enclosure: 'roomEnclosure',
      opening_punch: 'openingPunch',
    }
    for (const [declName, key] of Object.entries(DECL_BRIDGE)) {
      const stated = decl[declName]
      if (!Number.isFinite(stated)) {
        fail(`LADDER FAIL: tolerances.stroke_ratio.ladder is missing '${declName}'`)
        continue
      }
      if (!(key in MEASURED)) continue // already reported as a missing rung
      const measured = MEASURED[key] / BASE_PT
      const d = Math.abs(stated - measured) / measured
      if (d > SPEC_SELF_TOL) {
        fail(
          `LADDER FAIL: the spec's two ladders disagree on '${key}' — ` +
            `tolerances.stroke_ratio.ladder says ${stated}, line_weights measures ` +
            `${measured.toFixed(5)} (${(d * 100).toFixed(2)}%).`,
          '  One section was edited and the other was not.',
        )
      }
    }
  }
}

if (failed > 0) {
  console.log(`\n${failed} problem(s) with the ground truth or the bridge to it — nothing was graded.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// MEMBERSHIP — the half this file shipped without (V3, adversary round), and
// then shipped anchored to a copy (V4, this round).
//
// The loop below once iterated `TIER` — the table under test — so a rung DELETED
// from the table was simply not visited, and `ladder OK — 5 tiers` printed green
// with `roomEnclosure` gone. A check that iterates its subject can only ever
// grade the rungs the subject chose to offer.
//
// The expected set is now derived from the spec ON EVERY RUN, and the two sides
// are compared BOTH ways: a rung in the spec that the table no longer carries is
// a deletion, and a rung in the table with no measured value is an invention with
// no ground truth behind its ratio. Neither can be graded, so neither is a skip.
// ---------------------------------------------------------------------------
{
  const inTable = new Set(Object.keys(TIER))
  const inSpec = new Set(Object.keys(MEASURED))
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
      console.log(`  ${SPEC_PATH} is the only source of a correct ratio.`)
      console.log('  Measure it there first, or the tier has no ground truth to reproduce.')
    }
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// THE LADDER ITSELF.
//
// R10 — WHICH AXES THIS GUARD'S FALSIFICATION VARIES:
//   (1) VALUE      — perturb a TIER multiplier; the ratio leaves tolerance.
//   (2) CLAMP      — move BASE_STROKE_PX so a tier lands on a bound; the top of
//                    the ladder flattens into a plateau while every width still
//                    looks reasonable on its own.
//   (3) MEMBERSHIP — delete a rung from TIER, or add one the spec does not
//                    measure. Both directions.
//   (4) GROUND TRUTH — edit the SPEC: delete a tier, or change a pt. This is the
//                    axis V3's copy could not vary at all, and the one this
//                    rewrite is named for.
//
// NOT AN ALGEBRAIC IDENTITY, and here is the one place it would be: the BASE row
// compares strokePx(base)/strokePx(base) against pt[base]/base_pt. Both sides are
// 1.0 by construction, for every possible input. The previous version printed it
// as `0.00%` among the graded rows, which reads as five passing checks plus a
// sixth that is really a tautology. It is labelled `origin` below and its ratio
// is NOT counted. Its CLAMP check is real and is kept — drop BASE_STROKE_PX
// below MIN and the base row is the first to hit the floor.
//
// Every other row compares a number from planStyle.ts against a number from the
// spec JSON. The two files share no derivation: nothing makes TIER.wall equal
// 0.2903/0.1452, and the sabotage log in the ledger shows both sides moving
// independently and the gate reddening.
// ---------------------------------------------------------------------------
const TOLERANCE = 0.01 // 1% — the measured pt values carry their own rounding.
// Tighter on purpose than the spec's own `tolerances.stroke_ratio.tolerance_pct`
// (10%), which is the acceptance band for a DELIVERED PLAN against the reference.
// This gate grades a TABLE against the same reference, where the only honest
// error is rounding — so 1% is a drift detector, not a quality bar.

const baseRendered = strokePx(BASE_TIER)
const order = Object.keys(MEASURED).sort((a, b) => MEASURED[a] - MEASURED[b])
console.log(`ground truth: ${SPEC_PATH} · line_weights (${order.length} measured tiers, base ${BASE_PT} pt)`)
console.log('tier            TIER   rendered   ratio    measured   delta')
for (const tier of order) {
  const mult = TIER[tier]
  const px = strokePx(tier)
  const ratio = px / baseRendered
  const measured = MEASURED[tier] / BASE_PT
  const delta = Math.abs(ratio - measured) / measured
  const clamped = px === MIN || px === MAX
  const isOrigin = tier === BASE_TIER
  const ok = clamped ? false : isOrigin || delta <= TOLERANCE
  if (!ok) failed++
  console.log(
    `${tier.padEnd(15)}${String(mult).padEnd(7)}${px.toFixed(3).padEnd(11)}` +
      `${ratio.toFixed(3).padEnd(9)}${measured.toFixed(3).padEnd(11)}` +
      `${isOrigin ? 'origin  ' : (delta * 100).toFixed(2) + '%'}${clamped ? '  <- CLAMPED' : ''}${ok ? '' : '  <- FAIL'}`,
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
const graded = order.length - 1
console.log(
  `\nladder OK — ${order.length} tiers read from ${SPEC_PATH}, all present in TIER; ` +
    `${graded} graded ratios within ${TOLERANCE * 100}% (the base row is the origin, not a check)`,
)
console.log(`  base ${BASE} px · clamps [${MIN}, ${MAX}] · no tier on a bound`)
