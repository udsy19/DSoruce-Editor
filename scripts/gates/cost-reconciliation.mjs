// COST RECONCILIATION — the two rupee formulas, TERM BY TERM.
//
//   node scripts/gates/cost-reconciliation.mjs             # verdict
//   node scripts/gates/cost-reconciliation.mjs --explain    # + the extracted rate table
//
// QUARANTINED, and RED at HEAD. Registered in scripts/gates/reconcile.mjs, which
// RUNS it and asserts it still fails. The day it goes green, reconcile reds and
// demands it be wired into scripts/verify-all.sh.
//
// @covers: crates/ds-core/src/cost.rs
// @covers: web/src/editor/stats.ts
//
// ---------------------------------------------------------------------------
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// Two implementations price one building:
//
//   crates/ds-core/src/cost.rs   `indicative_cost` — the headline, over the wasm
//     boundary as `metrics().indicative_cost`.
//   web/src/editor/stats.ts      `buildElements` — the Statistics panel's BoQ.
//
// `cost.rs`'s own header says "keep the two in lockstep"; `stats.ts`'s says
// "change here ⇒ change there". Nothing measured it. Measured here, unedited, at
// e145fed:
//
//     fixture   GEA        NIA        headline        panel           Δ
//     F1        930.0625   899.7895   ₹1,79,17,715    ₹1,74,93,892    −2.37%
//     F3       1594.9375   899.7895   ₹2,72,25,965    ₹1,74,93,892   −35.75%
//
// and `Δ − (GEA − NIA) × 14 000 = ₹0.000000` on 5 of 5. The base shell is billed
// on GEA by the core and on NIA by the panel. Every other term agrees to the
// paisa, which is why an aggregate comparison would have told you a number and
// not a cause.
//
// TWO MORE, found by this gate and NOT in the report that commissioned it:
//
//   * THE COMPONENT CLASSIFIER DISAGREES ON FOUR CATEGORIES. `furniture_rate`
//     (cost.rs) and `furnGroup` (stats.ts) are two hand-written keyword ladders,
//     and they are not the same ladder: `Counter` ₹20,000 vs ₹2,500, `Double
//     Door` ₹2,500 vs ₹25,000, `Settee` and `Banquette` ₹2,500 vs ₹12,000. Latent
//     on the seeded fixtures, whose only categories are Door/Table/Chair/Desk —
//     live the moment a DWG import supplies its own vocabulary.
//
//   * THE PARTITION PREDICATE IS PROVENANCE, NOT GEOMETRY. Both sides filter
//     `w.generated`, so a plan whose interior partitions were imported rather
//     than generated bills ₹0 of partition on BOTH surfaces — they agree, and are
//     both wrong. A cross-surface check cannot see this; §5 measures it against
//     geometry instead.
//
// THE STANDING FALSE ASSURANCE this replaces the *scope* of, not the file:
// `web/src/export/publishedArea.test.mjs` (1160/1160, green) and
// `web/src/editor/referenceMetrics.test.mjs` both declare `@covers: cost.rs` and
// both run on every commit. `publishedArea` reconciles the ENCLOSED-ROOM PREMIUM
// across exactly these two surfaces (its line ~452) and stops there. It is
// correct and it stays; this gate is the same idea carried to every term.
//
// ---------------------------------------------------------------------------
// INDEPENDENCE (.claude/rules/gate-independence.md)
// ---------------------------------------------------------------------------
// The rule's demand is that a gate not consume a value produced by the system
// under test. Both cost implementations ARE the system under test, so neither
// may supply a quantity, a rate, or a classification. Nothing here is read from
// either implementation's source or from either's account of itself:
//
//   QUANTITIES come from core state through exports neither cost path writes —
//     `state()` (wall endpoints, component categories, the `generated`/`glazing`/
//     `reference` facets), `metrics()` (GEA, NIA), `quantities().rooms[].areaM2`
//     (the `area_basis` per-zone areas). Wall metres are re-derived from the two
//     endpoints with a hypot; they are not read off any takeoff.
//
//   RATES are EXTRACTED BEHAVIOURALLY, by ablation — never parsed out of
//     `cost.rs` and never imported from `stats.ts`. Each rate is the finite
//     difference of `metrics().indicative_cost` under a single controlled edit
//     through the public `Editor` API:
//       base shell  a bare plate with NO zones (NIA = 0, so the rate and the
//                   basis separate: a per-NIA model bills 0 there, and the core
//                   bills ₹84,00,000)
//       partitions  `set_wall` lengthens ONE generated wall by 1 m along its own
//                   axis; the extraction is void unless GEA, NIA and every zone
//                   area are bit-identical across the edit, which is asserted
//                   (§1.4), not hoped for
//       enclosure   `add_zone` one Meeting room; divided by the area
//                   `quantities()` reports for it, not by w·h
//       components  `add_component` one unit of a category
//     A rate table parsed from `cost.rs` would have been the producer supplying
//     the yardstick it is measured against. It is also how this gate catches the
//     classifier divergence: the core is asked what a `Settee` costs, and the
//     answer is compared with what the panel charges for one.
//
//   THE CORE'S PER-TERM CONTRIBUTION is not exported — `indicative_cost` is a
//     scalar. §4 therefore reconciles by RESIDUAL: every term but the base shell
//     is derived independently and subtracted, and what is left, divided by the
//     extracted base rate, is the quantity the core billed the base shell on.
//     A residual can silently absorb a second divergence, so §4 does not trust
//     it: the implied quantity must equal GEA or NIA to 1e-6, and anything else
//     is a named failure rather than an attribution (§4c). The panel side is
//     additionally checked term by term against the same independent quantities
//     (§4a), so a second divergence surfaces on its own row with its own name.
//
// ---------------------------------------------------------------------------
// WHAT THIS GATE IS BLIND TO — stated, because a scope not written down is a
// scope nobody can check
// ---------------------------------------------------------------------------
//   * RATE CORRECTNESS, and the blind spot is NARROWER than it first looks —
//     the first draft of this paragraph was wrong and the sabotage round said so.
//     It claimed that changing `BASE_SHELL` to ₹14,500 in `cost.rs` would leave
//     the gate "exactly as red as it is now", because the extracted rate follows
//     the change. MEASURED (S3: cost.rs edited, wasm rebuilt): 20 of 212, not 19.
//     The extracted rate does follow — and §3 then catches the panel's ₹14,000
//     failing to. A rate moved on ONE side is red.
//     The true null is BOTH SIDES IN LOCKSTEP. MEASURED (S3b: cost.rs 14_000 →
//     14_500 AND stats.ts FLOOR 11_000 → 11_500): 19 of 212, identical to
//     baseline. Two agreeing implementations of a wrong rate are invisible to a
//     reconciliation, by definition — whether ₹14,000/m² is right for a
//     Bengaluru CAT-B fit-out is a question for the sources cited in `cost.rs`.
//     This is the same shape as the `m2_per_seat` null already on this mission's
//     record.
//   * CARBON. `indicative_carbon` is the structurally-paired second output and
//     is not reconciled here. The rates travel as `(cost, carbon)` tuples in
//     `cost.rs` and as `{cost, co2}` records in `stats.ts`, so the same
//     divergence is presumptively live on the carbon side — presumptively, which
//     is not measured, which is why it is in this list and not in a finding.
//   * MATERIO BINDINGS. `stats.ts` overrides a bound component's rate with its
//     bank price; `cost.rs` never does. That is declared by design
//     (`referenceMetrics.test.mjs`), so the component-cost check needs an unbound
//     population — and asserts it (§4a) rather than assuming it, so a future
//     bound fixture fails loudly instead of comparing two different models.
//   * WHETHER ANY OF IT REACHES PAPER. It does not: three independent sweeps
//     found no rupee figure in any delivered artifact (reports/INTEGRATION-5).
//     This gate grades a core-state identity, which is why it is on reconcile's
//     quarantine list and not on the sheet board.
//
// ---------------------------------------------------------------------------
// R10 AXES this varies
// ---------------------------------------------------------------------------
//   TERM        — each of base shell / partition-solid / partition-glass /
//                 enclosure / components asserted separately, so a divergence
//                 names itself. A single total comparison catches this defect
//                 once and names nothing.
//   QUANTITY vs RATE — split deliberately (§3 rates, §4 quantities). Today's
//                 defect is a QUANTITY divergence under agreeing rates, and a
//                 check that multiplied them together would have reported one
//                 number for two different causes.
//   BASIS       — GEA vs NIA, the axis the live defect sits on, plus the
//                 anti-absorption check that refuses to attribute a residual it
//                 cannot land on a known basis.
//   CATEGORY    — the component vocabulary, widened past what the fixtures use
//                 by harvesting the keyword literals from BOTH classifiers, so a
//                 latent divergence is caught before an import makes it live.
//   POPULATION  — 5 fixtures × 3 states (unedited / all-Workspace / all-Meeting,
//                 which empties and then maximises the enclosure term) + 3
//                 generated fits on 2 plate sizes.
//   PROVENANCE  — §5's transplant: identical geometry, `generated` true vs
//                 false. The one axis where the two surfaces AGREE and are both
//                 wrong, so it is measured against geometry, not across surfaces.
//
// ---------------------------------------------------------------------------
// SABOTAGE RECORD — run in a disposable worktree, baseline 19 of 213 red.
// Nulls are listed, not omitted; two sabotages falsified this file's own claims.
// ---------------------------------------------------------------------------
//   S1  panelOf feeds the panel GEA (test-side)      19 → 7    12 base rows green,
//         §3b's 5 and §5's 2 untouched — the three findings are independent.
//   S2  cost.rs bills the base shell on NIA, wasm     19 → 7    THE REAL FIX greens
//         rebuilt (product-side)                              every base row.
//         FIRST RUN OF S2 WENT 19 → 47, NOT GREEN, and that is why §1.1 and §1.2
//         look the way they do: the old single-probe instrument divided by a zero
//         headline and misread the enclosure rate as ₹20,000. The gate could not
//         have gone green on the fix it demands. Found only because the round was
//         run exhaustively rather than to a checklist.
//   S3  cost.rs BASE_SHELL 14_000 → 14_500 only       19 → 20   §3 catches it. This
//         REFUTED the blind-spot paragraph above, which claimed 19.
//   S3b same, plus stats.ts FLOOR 11_000 → 11_500     19 → 19   THE TRUE NULL: a
//         rate wrong on BOTH sides in lockstep is invisible, by definition.
//   S4  stats.ts FLOOR 11_000 → 11_500 only           19 → 20   §3 rate parity.
//   S5  stats.ts furnGroup gains `counter`            19 → 18   exactly the Counter
//         row clears; the other four categories stay.
//   S6a partition ablation aimed at a BOUNDARY wall   19 → 50   §1.4's guard fires.
//   S6b same wall, guard DELETED                      19 → 47   NOT a null, but not
//         a clean catch either: the bad rate escapes §1.4 and is caught downstream
//         by §3, which reports it as "the panel's rate disagrees" — a true red
//         with a FALSE CAUSE, accusing stats.ts of the instrument's error. The
//         guard's value is attribution, not detection.
//   S7  extracted enclosure rate corrupted ×1.5       19 → 36   §4c fires on 13
//         documents and refuses to blame the base term. Not a tautology. It stays
//         silent on the all-Workspace states, which have no enclosure term — the
//         population axis doing visible work.
//   S8  population cut to one fixture                 19/213 → 13/117  the `docs >= 15`
//         floor reds rather than the gate passing on a thin population.
//   S9  §5 transplants an EMPTY interior set          19 → 19   count unchanged, but
//         the composition is not: the non-vacuity floor fires as the core row goes
//         green (0 expected vs 0 billed). Vacuity caught, not passed.
//   S11 NULL — §4c neutered                           19 → 19   as predicted: a
//         change that only REMOVES coverage can never red a red tree, so its green
//         means nothing. Recorded so nobody reads it as evidence.
//   S10 web/src/wasm removed                          exit 1 with the missing-subject
//         message — never a green skip.
//   Restored: 19 of 213, matching baseline exactly.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const EXPLAIN = process.argv.includes('--explain')

// --- scoreboard ---------------------------------------------------------------
let checks = 0
let failures = 0
const check = (ok, label, detail) => {
  checks++
  if (!ok) {
    failures++
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`)
  }
}
const okline = (s) => console.log(`  ok    ${s}`)

const inr = (n) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps

// --- subject 1: the core, over the real wasm boundary --------------------------
// SUBJECT EXISTENCE IS A FAILURE, NEVER A SKIP. The sibling suites print
// `SKIP: web/src/wasm not built` and exit 0; that is right for a battery row on a
// fresh clone and wrong for a quarantined gate, whose whole contract is that it
// stays red. A gate that exits 0 because its subject is missing is a gate lying
// green, and reconcile.mjs would accept the lie.
const wasmDir = path.join(ROOT, 'web/src/wasm')
if (!fs.existsSync(path.join(wasmDir, 'ds_core_bg.wasm'))) {
  console.log('COST-RECONCILIATION FAIL — web/src/wasm is not built; run `make wasm`.')
  console.log('A missing subject is a failure, not a skip: this gate cannot report agreement it did not measure.')
  process.exit(1)
}
const wasm = await import(pathToFileURL(path.join(wasmDir, 'ds_core.js')).href)
await wasm.default({ module_or_path: fs.readFileSync(path.join(wasmDir, 'ds_core_bg.wasm')) })
const { Editor } = wasm

// --- subject 2: the REAL panel module, bundled from source ---------------------
const webRequire = createRequire(path.join(ROOT, 'web/package.json'))
const esbuildPath = createRequire(webRequire.resolve('vite')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
const bundle = async (entry) => {
  const out = path.join(os.tmpdir(), `ds-cr-${path.basename(entry, '.ts')}-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({ entryPoints: [path.join(ROOT, 'web/src', entry)], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const mod = await import(pathToFileURL(out).href)
  fs.rmSync(out, { force: true })
  return mod
}
const { buildElements } = await bundle('editor/stats.ts')
// The REAL ZoneAreas constructor through its own entry point, so the panel is
// handed the core's areas the way the app hands them to it.
const { zoneAreasFromStats } = await bundle('types/metrics.ts')

// --- document builders (public Editor API only) --------------------------------
const PROGRAM = {
  desks: 20, meeting_rooms: 2, desk_w: 1.6, desk_h: 0.8, meeting_w: 3, meeting_h: 3,
  cluster_cols: 4, target_corridor_m: 1.2, desk_clearance_m: 0.9, bench_pairs: true,
  support_spaces: true, rooms: [], w_capacity: 0.35, w_adjacency: 0.2, w_circulation: 0.25,
  w_density: 0.2, w_program: 0.1, w_daylight: 0.05, w_entry: 0.05,
}
const wallLen = (w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
const ENCLOSED = new Set(['Meeting', 'ClosedOffice'])

/** A bare rectangular plate: architectural walls only, no zones, no components. */
function bare(w = 30, h = 20) {
  const ed = new Editor()
  const box = [[0, 0], [w, 0], [w, h], [0, h]]
  for (let i = 0; i < 4; i++) ed.add_wall(box[i][0], box[i][1], box[(i + 1) % 4][0], box[(i + 1) % 4][1], 0.1)
  return ed
}
/** A bare plate plus a deterministic generated fit. */
function fit(seed, w = 30, h = 20) {
  const ed = bare(w, h)
  ed.generate(PROGRAM, BigInt(seed), false)
  return ed
}

/**
 * Everything the panel is handed, plus its term vector, for one document.
 *
 * THE ARGUMENTS ARE THE SHIPPED CALL SITE'S, not a convenient approximation.
 * `src/ui/StatsPanel.tsx` passes `m.net_internal_area ?? zones.totalArea ?? 0`,
 * and its own comment records that the previous form — `zones.totalArea ||
 * m.net_internal_area`, which is still what `referenceMetrics.test.mjs` uses —
 * was a THIRD owner of NIA that printed 138 m² beside a GEA of 1 m². The two
 * forms differ whenever `Σ zone areas` exceeds the plate and the core's cap
 * bites. A gate that fed the panel the retired form would be grading a
 * document the product never builds, so the shipped form is used here and the
 * claim is re-checked against the source below.
 */
function panelOf(ed) {
  const st = ed.state()
  const zs = ed.zone_stats()
  const m = ed.metrics()
  const nia = m.net_internal_area ?? zs.reduce((s, z) => s + z.area, 0) ?? 0
  const el = buildElements(st, nia, zoneAreasFromStats(zs))
  const group = (l) => el.groups.find((g) => g.label === l)
  const line = (gl, ll) => group(gl)?.lines.find((l) => l.label === ll)
  return { el, group, line, nia }
}

// ===========================================================================
// §1  INSTRUMENT — extract the core's rate table by ablation.
//     Nothing below reads a rate from either implementation's source.
// ===========================================================================
console.log('cost reconciliation — two rupee formulas, term by term\n')

// §0 THE SUBJECT MUST NOT MOVE OUT FROM UNDER THE GATE. `panelOf` reproduces
// StatsPanel.tsx's invocation; if that call site changes basis, every quantity
// below is being compared against a document the product never builds, and the
// gate would keep reporting whatever it last measured. Anchored on the argument
// expression, not on a comment.
{
  const src = fs.readFileSync(path.join(ROOT, 'web/src/ui/StatsPanel.tsx'), 'utf8')
  const call = src.match(/const nia = ([^\n]+)\n\s*const elements = buildElements\(([^)]*)\)/)
  check(!!call, '§0 StatsPanel.tsx still computes an `nia` and hands it to buildElements', 'the shipped call site has been restructured; re-read it and re-anchor panelOf() before trusting any row below')
  if (call) {
    check(
      /m\.net_internal_area/.test(call[1]) && call[1].indexOf('m.net_internal_area') < (call[1].indexOf('totalArea') + 1 || Infinity),
      '§0 the shipped panel bills its base shell on the core NIA first',
      `the call site now derives nia as \`${call[1].trim()}\` — panelOf() mirrors \`m.net_internal_area ?? …\` and must be updated in the same change`,
    )
  }
}

console.log('§1 rate table, extracted from the core by ablation (no source parsed)')

const RATES = {}

// §1.1 BASE SHELL — the RATE and the BASIS, determined together, by two probes.
//
// TWO PROBES, NOT ONE, AND THE SABOTAGE ROUND IS WHY. The first version used the
// bare plate alone: NIA = 0 while GEA = 600, so a per-NIA model bills ₹0 and a
// per-GEA one bills ₹84,00,000, and the basis reads straight off. That is true,
// and it is only half a instrument — it can OBSERVE a GEA basis and can only
// INFER a NIA one from a zero. Sabotage S2 built the actual fix (cost.rs billing
// on NIA, wasm rebuilt) and the gate did not go green: it went red at 47 with
// `RATES.base = 0`, a divide-by-zero and an `Infinity m²` in every row. The
// guard fired and said the right thing, so nothing false was reported — but a
// gate that cannot go green when the defect is fixed is not measuring the
// defect, it is measuring today.
//
// So the basis is DERIVED from a pair that separates the two candidates in both
// directions. P2 adds one WORKSPACE zone — deliberately not an enclosed type, so
// the enclosure premium cannot move and the base shell is the only term that can
// differ between the two documents:
//
//   headline(P1) > 0 and headline(P2) == headline(P1)  ⇒ basis GEA (NIA appeared
//       and changed nothing), rate = headline(P1) / GEA
//   headline(P1) == 0 and headline(P2) > 0             ⇒ basis NIA, rate =
//       headline(P2) / NIA(P2)
//
// Anything else is a shape neither branch describes, and is a failure rather
// than a default.
{
  const p1 = bare()
  const m1 = p1.metrics()
  const p2 = bare()
  p2.add_zone('Workspace', 5, 5, 4, 4, 'base basis probe')
  const m2 = p2.metrics()
  const rooms2 = p2.quantities().rooms

  check(near(m1.gross_external_area, 600) && near(m2.gross_external_area, 600), '§1.1 both base probes measure a 600 m² plate', `GEA ${m1.gross_external_area} / ${m2.gross_external_area}`)
  check(near(m1.net_internal_area, 0), '§1.1 probe P1 has NIA = 0', `NIA ${m1.net_internal_area} — P1 must carry no zone, or the two probes stop separating the bases`)
  check(rooms2.length === 1 && m2.net_internal_area > 0, '§1.1 probe P2 has exactly one zone and a positive NIA', `${rooms2.length} room(s), NIA ${m2.net_internal_area}`)

  const geaLike = m1.indicative_cost > 0 && near(m1.indicative_cost, m2.indicative_cost)
  const niaLike = near(m1.indicative_cost, 0) && m2.indicative_cost > 0
  check(
    geaLike !== niaLike,
    '§1.1 the core\'s base-shell BASIS is determined by the probe pair',
    `P1 (GEA ${m1.gross_external_area}, NIA ${m1.net_internal_area}) bills ${inr(m1.indicative_cost)} and ` +
      `P2 (GEA ${m2.gross_external_area}, NIA ${m2.net_internal_area}) bills ${inr(m2.indicative_cost)} — ` +
      `that is neither the GEA shape nor the NIA shape, so a third term moved between two documents that ` +
      `differ only by one non-enclosed zone. Every rate below would be measuring it.`,
  )
  if (geaLike) {
    RATES.base = m1.indicative_cost / m1.gross_external_area
    RATES.baseBasis = 'GEA'
  } else if (niaLike) {
    RATES.base = m2.indicative_cost / m2.net_internal_area
    RATES.baseBasis = 'NIA'
  } else {
    RATES.base = NaN
    RATES.baseBasis = 'indeterminate'
  }
  p1.free(); p2.free()
}

// §1.2 ENCLOSED-ROOM PREMIUM, per m² of the area `quantities()` reports.
//
// BY RETYPE, NOT BY ADDING A ROOM — also from S2. Adding a Meeting zone to a
// bare plate moves the enclosure term AND, under a NIA basis, the base term with
// it; the first version read the enclosure rate as ₹20,000/m² (= 14,000 + 6,000)
// against the true ₹6,000 the moment the core was put on NIA. A retype changes
// the zone's TYPE and not its area, so the base term is fixed under either
// basis — and that is asserted across the edit rather than assumed.
{
  const ed = bare()
  const zid = ed.add_zone('Workspace', 5, 5, 4, 4, 'enclosure rate probe')
  const m0 = ed.metrics()
  const rooms = ed.quantities().rooms
  ed.set_zone_type(zid, 'Meeting')
  const m1 = ed.metrics()
  check(rooms.length === 1, '§1.2 the enclosure probe has exactly one room', `quantities() reports ${rooms.length}`)
  check(
    near(m0.gross_external_area, m1.gross_external_area) && near(m0.net_internal_area, m1.net_internal_area),
    '§1.2 the retype moved no area',
    `GEA ${m0.gross_external_area}→${m1.gross_external_area}, NIA ${m0.net_internal_area}→${m1.net_internal_area} — ` +
      `the Δ below would carry a base-shell change and be read as an enclosure rate`,
  )
  RATES.enclosure = (m1.indicative_cost - m0.indicative_cost) / rooms[0].areaM2
  ed.free()
}

// §1.3 COMPONENTS, per unit, per category.
const unitCache = new Map()
function coreUnitRate(category) {
  if (unitCache.has(category)) return unitCache.get(category)
  const ed = bare()
  const before = ed.metrics().indicative_cost
  ed.add_component(category, 5, 5, 1, 1)
  const m = ed.metrics()
  const st = ed.state()
  // Instrument guard: exactly one non-reference component landed, and no area moved.
  const okShape = st.components.filter((c) => !c.reference).length === 1 && near(m.gross_external_area, 600) && near(m.net_internal_area, 0)
  const r = okShape ? m.indicative_cost - before : NaN
  ed.free()
  unitCache.set(category, r)
  return r
}

// §1.4 PARTITIONS, per running metre — the one term with no constructor in the
// public API (`add_wall` always writes `generated: false`). Extracted instead by
// LENGTHENING an existing generated wall by exactly 1 m along its own axis with
// `set_wall`, which rewrites the endpoints and touches no other facet.
//
// THE ENABLING STEP IS THE GUARD. Moving a wall can move the plate bounding box
// (hence GEA, hence the base term) and can move zone areas (hence the enclosure
// term). Either would land in the Δ and be read as a partition rate. So the
// extraction is CONDITIONED on GEA, NIA and the full zone-area vector being
// unchanged across the edit, and on the length having actually moved by 1 m —
// a candidate that fails any of those is rejected, and running out of candidates
// is a failure, not a fallback.
function partitionRate(glazed) {
  const ed = fit(3)
  const st = ed.state()
  const inside = (w, extra) => {
    const L = wallLen(w)
    if (!(L > 0.2)) return false
    const ux = (w.b.x - w.a.x) / L, uy = (w.b.y - w.a.y) / L
    const ex = w.a.x + ux * (L + extra), ey = w.a.y + uy * (L + extra)
    const pts = [w.a.x, w.b.x, ex], qts = [w.a.y, w.b.y, ey]
    return Math.min(...pts) > 1 && Math.max(...pts) < 29 && Math.min(...qts) > 1 && Math.max(...qts) < 19
  }
  const cands = st.walls.filter((w) => w.generated && !!w.glazing === glazed && inside(w, 1))
  if (cands.length === 0) { ed.free(); return { rate: NaN, why: 'no interior generated wall of this kind can be lengthened without leaving the plate' } }
  const w = cands[0]
  const m0 = ed.metrics()
  const z0 = JSON.stringify(ed.zone_stats().map((z) => [z.id, z.area]))
  const L0 = wallLen(w)
  const ux = (w.b.x - w.a.x) / L0, uy = (w.b.y - w.a.y) / L0
  ed.set_wall(w.id, w.a.x, w.a.y, w.a.x + ux * (L0 + 1), w.a.y + uy * (L0 + 1))
  const m1 = ed.metrics()
  const z1 = JSON.stringify(ed.zone_stats().map((z) => [z.id, z.area]))
  const L1 = wallLen(ed.state().walls.find((x) => x.id === w.id))
  const dL = L1 - L0
  const clean =
    near(m0.gross_external_area, m1.gross_external_area) &&
    near(m0.net_internal_area, m1.net_internal_area) &&
    z0 === z1 &&
    near(dL, 1, 1e-9)
  const out = clean
    ? { rate: (m1.indicative_cost - m0.indicative_cost) / dL, why: '' }
    : { rate: NaN, why: `the edit moved more than the wall: ΔGEA ${(m1.gross_external_area - m0.gross_external_area).toExponential(2)} ΔNIA ${(m1.net_internal_area - m0.net_internal_area).toExponential(2)} zoneAreasEqual=${z0 === z1} ΔL ${dL}` }
  ed.free()
  return out
}
{
  const s = partitionRate(false)
  const g = partitionRate(true)
  check(Number.isFinite(s.rate), '§1.4 solid-partition rate extracted cleanly', s.why)
  check(Number.isFinite(g.rate), '§1.4 glazed-partition rate extracted cleanly', g.why)
  RATES.solid = s.rate
  RATES.glass = g.rate
}

// Non-vacuity of the instrument itself: a rate table of zeros or NaNs would make
// every comparison below pass by arithmetic accident.
for (const k of ['base', 'enclosure', 'solid', 'glass']) {
  check(Number.isFinite(RATES[k]) && RATES[k] > 0, `§1 extracted rate '${k}' is finite and positive`, `got ${RATES[k]}`)
}
check(RATES.glass > RATES.solid, '§1 the extracted glazed rate exceeds the solid rate', `solid ${RATES.solid} glass ${RATES.glass} — the two probes may have selected the same wall kind`)

if (EXPLAIN) {
  console.log(`        base shell   ${inr(RATES.base)} / m² of ${RATES.baseBasis}`)
  console.log(`        partition    ${inr(RATES.solid)} / m solid · ${inr(RATES.glass)} / m glazed`)
  console.log(`        enclosure    ${inr(RATES.enclosure)} / m² of basis area`)
}

// ===========================================================================
// §2  THE CATEGORY VOCABULARY — widened past what the fixtures happen to use.
// ===========================================================================
// Two hand-written keyword ladders can only be compared over inputs that reach
// their branches. The seeded fixtures use four categories and would exercise
// three branches of eleven. The vocabulary is therefore the UNION of:
//   (a) every category actually present in the population (checked in §4), and
//   (b) the keyword literals harvested from both classifiers' source.
//
// (b) is derived from the subjects, and that is deliberate and safe: it widens
// the population the gate tests over, it never supplies a verdict. Every price
// compared below still comes from running the two implementations. Harvesting
// from BOTH sides matters — a keyword present on one side only is exactly the
// divergence to probe, and taking the union is what reaches it.
function harvest() {
  const rust = fs.readFileSync(path.join(ROOT, 'crates/ds-core/src/cost.rs'), 'utf8')
  const ts = fs.readFileSync(path.join(ROOT, 'web/src/editor/stats.ts'), 'utf8')
  const words = new Set()
  const fnRust = rust.slice(rust.indexOf('fn furniture_rate'), rust.indexOf('fn is_enclosed'))
  for (const m of fnRust.matchAll(/c\.contains\("([a-z]+)"\)/g)) words.add(m[1])
  const fnTs = ts.slice(ts.indexOf('function furnGroup'), ts.indexOf('function buildPriceMap'))
  for (const m of fnTs.matchAll(/\/([a-z|\\b]+)\/\.test\(c\)/g))
    for (const w of m[1].split('|')) { const t = w.replace(/\\b/g, ''); if (t.length > 2) words.add(t) }
  return words
}
const HARVESTED = harvest()
check(HARVESTED.size >= 20, '§2 the classifier vocabulary harvest reaches both ladders', `only ${HARVESTED.size} keywords found — the slices above no longer bracket furniture_rate / furnGroup, and the category axis has gone thin`)
// Title-case each keyword into a plausible category string, plus a handful of
// two-word forms, because both ladders are substring/word matchers and a
// compound is where their orders diverge.
const VOCAB = [...new Set([
  ...[...HARVESTED].map((w) => w[0].toUpperCase() + w.slice(1)),
  'Double Door', 'Meeting Table', 'Storage Cabinet', 'Acoustic Pod', 'File Cabinet', 'Phone Booth',
])].sort()

// ===========================================================================
// §3  RATE PARITY — what the panel charges per unit against what the core does.
// ===========================================================================
// Split from §4 on purpose. Today's defect is a QUANTITY divergence under
// AGREEING rates, and a check that multiplied rate by quantity would report one
// number for two different causes.
console.log('\n§3 rate parity — panel implied rates vs the core rates extracted in §1')
{
  // A generated fit exercises every non-component term at once.
  const ed = fit(3)
  const { group, line } = panelOf(ed)
  const rateOf = (l) => (l && l.qty > 0 ? l.cost / l.qty : NaN)

  const floor = line('Floor', 'Floor finish')
  const light = line('Lighting', 'Ambient + task')
  check(!!floor && !!light, '§3 the panel bills a base shell on a generated fit', 'the Floor and/or Lighting group is missing, and the base-shell rate cannot be read')
  if (floor && light) {
    // The panel splits the base shell across two groups. They must bill ONE
    // quantity — two base-shell lines on different quantities is a divergence
    // inside a single implementation.
    check(near(floor.qty, light.qty), '§3 the panel bills Floor and Lighting on ONE quantity', `Floor ${floor.qty} m² vs Lighting ${light.qty} m²`)
    const panelBase = rateOf(floor) + rateOf(light)
    check(near(panelBase, RATES.base, 1e-9), '§3 base-shell RATE agrees (panel Floor+Lighting vs core)', `panel ${inr(panelBase)}/m² vs core ${inr(RATES.base)}/m² — Δ ${inr(panelBase - RATES.base)}/m²`)
  }
  const def = line('Partition Wall', 'Default')
  const gls = line('Partition Wall', 'Glass')
  check(!!def && !!gls, '§3 the generated fit exercises both partition kinds', `Default=${!!def} Glass=${!!gls} — a missing kind leaves that rate unmeasured`)
  if (def) check(near(rateOf(def), RATES.solid, 1e-9), '§3 solid-partition RATE agrees', `panel ${inr(rateOf(def))}/m vs core ${inr(RATES.solid)}/m`)
  if (gls) check(near(rateOf(gls), RATES.glass, 1e-9), '§3 glazed-partition RATE agrees', `panel ${inr(rateOf(gls))}/m vs core ${inr(RATES.glass)}/m`)
  const room = line('Room Fit-out', 'Ceiling + HVAC + AV')
  check(!!room, '§3 the generated fit has enclosed rooms', 'no Room Fit-out line — the enclosure rate is unmeasured')
  if (room) check(near(rateOf(room), RATES.enclosure, 1e-9), '§3 enclosure-premium RATE agrees', `panel ${inr(rateOf(room))}/m² vs core ${inr(RATES.enclosure)}/m²`)
  ed.free()
}

// §3b — the component classifier, category by category. One component of one
// category in an otherwise bare document: the core's Δ and the panel's Furniture
// group total are then both the per-unit price of that one category.
{
  let probed = 0
  const diverged = []
  for (const cat of VOCAB) {
    const core = coreUnitRate(cat)
    const ed = bare()
    ed.add_component(cat, 5, 5, 1, 1)
    const { el } = panelOf(ed)
    const furn = el.groups.find((g) => g.label === 'Furniture')
    const panel = furn ? furn.cost : NaN
    const bucket = furn ? furn.lines[0].label : '—'
    ed.free()
    probed++
    if (!near(core, panel, 1e-9)) diverged.push({ cat, core, panel, bucket })
    check(
      near(core, panel, 1e-9),
      `§3b component unit price agrees for category "${cat}"`,
      `core ${inr(core)} vs panel ${inr(panel)} (panel bucket "${bucket}") — Δ ${inr(panel - core)} per unit. ` +
        `cost.rs furniture_rate and stats.ts furnGroup are two keyword ladders and they do not agree on this string.`,
    )
  }
  check(probed >= 20, '§3b the category axis is not thin', `only ${probed} categories probed`)
  if (diverged.length) {
    console.log(`        ${diverged.length} of ${probed} categories diverge: ${diverged.map((d) => `${d.cat} ${inr(d.core)}/${inr(d.panel)}`).join(' · ')}`)
  }
}

// ===========================================================================
// §4  QUANTITY PARITY — term by term, over the population.
// ===========================================================================
console.log('\n§4 quantity parity — term by term over the population')

function* population() {
  for (const id of Editor.fixture_ids()) {
    const plain = new Editor(); plain.load_fixture(id)
    yield { key: `${id} (unedited)`, ed: plain }
    // Empty the enclosure term.
    const ws = new Editor(); ws.load_fixture(id)
    for (const z of ws.state().zones) ws.set_zone_type(z.id, 'Workspace')
    yield { key: `${id} (all-Workspace)`, ed: ws }
    // Maximise it.
    const mt = new Editor(); mt.load_fixture(id)
    for (const z of mt.state().zones) mt.set_zone_type(z.id, 'Meeting')
    yield { key: `${id} (all-Meeting)`, ed: mt }
  }
  for (const [seed, w, h] of [[1, 30, 20], [3, 30, 20], [7, 42, 26]]) {
    yield { key: `generated seed ${seed} on ${w}×${h}`, ed: fit(seed, w, h) }
  }
}

let docs = 0
let enclosureStates = 0
let emptyEnclosureStates = 0
const baseDeltas = []

for (const { key, ed } of population()) {
  docs++
  const m = ed.metrics()
  const st = ed.state()
  const q = ed.quantities()
  const { group, line } = panelOf(ed)

  // ---- independently derived quantities, from core state only ----------------
  const gen = (st.walls ?? []).filter((w) => w.generated)
  const solidM = gen.filter((w) => !w.glazing).reduce((s, w) => s + wallLen(w), 0)
  const glassM = gen.filter((w) => w.glazing).reduce((s, w) => s + wallLen(w), 0)

  const areaById = new Map(q.rooms.map((r) => [r.roomId, r.areaM2]))
  let enclM2 = 0
  let missing = 0
  for (const z of st.zones ?? []) {
    if (!ENCLOSED.has(z.zone_type)) continue
    const a = areaById.get(z.id)
    // A MISSING INPUT IS A FAILURE, NEVER A SKIP.
    if (a === undefined) { missing++; continue }
    enclM2 += a
  }
  check(missing === 0, `§4 ${key}: every enclosed zone has a quantities() row`, `${missing} enclosed zone(s) absent from quantities() — the enclosure term cannot be derived, and skipping them would hand the producer a veto`)
  if (enclM2 > 0) enclosureStates++
  else emptyEnclosureStates++

  const live = (st.components ?? []).filter((c) => !c.reference)
  const bound = live.filter((c) => c.product_id).length
  // The bank-price override is a declared difference between the two models
  // (see the blind-spot list). This population must be free of it, and that is
  // asserted rather than assumed.
  check(bound === 0, `§4 ${key}: the population is unbound`, `${bound} component(s) carry a Materio binding; stats.ts would override their rate and cost.rs would not, so the component term below would compare two different models`)
  let unitCost = 0
  for (const c of live) unitCost += coreUnitRate(c.category)

  // ---- §4a  PANEL, term by term ---------------------------------------------
  const def = line('Partition Wall', 'Default')
  const gls = line('Partition Wall', 'Glass')
  const panelSolid = def ? def.qty : 0
  const panelGlass = gls ? gls.qty : 0
  check(near(panelSolid, solidM, 1e-9), `§4a ${key} · TERM partition-solid: panel quantity`, `panel bills ${panelSolid.toFixed(4)} m, core state carries ${solidM.toFixed(4)} m of generated non-glazed wall — Δ ${inr((panelSolid - solidM) * RATES.solid)}`)
  check(near(panelGlass, glassM, 1e-9), `§4a ${key} · TERM partition-glass: panel quantity`, `panel bills ${panelGlass.toFixed(4)} m, core state carries ${glassM.toFixed(4)} m of generated glazed wall — Δ ${inr((panelGlass - glassM) * RATES.glass)}`)

  const room = line('Room Fit-out', 'Ceiling + HVAC + AV')
  const panelEncl = room ? room.qty : 0
  check(near(panelEncl, enclM2, 1e-6), `§4a ${key} · TERM enclosure: panel quantity`, `panel bills ${panelEncl.toFixed(4)} m², quantities() reports ${enclM2.toFixed(4)} m² over Meeting+ClosedOffice — Δ ${inr((panelEncl - enclM2) * RATES.enclosure)}`)

  const furn = group('Furniture')
  const panelUnits = furn ? furn.cost : 0
  check(near(panelUnits, unitCost, 1e-6), `§4a ${key} · TERM components: panel cost`, `panel bills ${inr(panelUnits)} for ${live.length} components, the core prices the same categories at ${inr(unitCost)} — Δ ${inr(panelUnits - unitCost)}`)

  // ---- §4b  CORE base shell, by residual ------------------------------------
  const others = solidM * RATES.solid + glassM * RATES.glass + enclM2 * RATES.enclosure + unitCost
  const impliedBaseQty = (m.indicative_cost - others) / RATES.base

  // §4c ANTI-ABSORPTION. A residual can hide a second divergence by rolling it
  // into the base term. It is therefore not attributed unless it LANDS on a
  // basis the core actually publishes. Anything else is reported as an
  // unattributable residual, not silently blamed on the base shell.
  const matchesGea = near(impliedBaseQty, m.gross_external_area, 1e-6)
  const matchesNia = near(impliedBaseQty, m.net_internal_area, 1e-6)
  check(
    matchesGea || matchesNia,
    `§4c ${key}: the base-shell residual lands on a published basis`,
    `residual implies ${impliedBaseQty.toFixed(6)} m², which is neither GEA ${m.gross_external_area.toFixed(6)} nor NIA ${m.net_internal_area.toFixed(6)}. ` +
      `Some OTHER term diverges and is being absorbed here; do not read the base-shell row below as the cause.`,
  )

  const floor = line('Floor', 'Floor finish')
  const panelBaseQty = floor ? floor.qty : 0
  const dQty = impliedBaseQty - panelBaseQty
  if (!near(dQty, 0, 1e-6)) baseDeltas.push({ key, dQty, dInr: dQty * RATES.base })
  check(
    near(dQty, 0, 1e-6),
    `§4b ${key} · TERM base shell: the two implementations bill DIFFERENT QUANTITIES at the same rate`,
    `core bills ${impliedBaseQty.toFixed(4)} m² (${matchesGea ? '== GEA' : matchesNia ? '== NIA' : 'unattributed'}), ` +
      `panel bills ${panelBaseQty.toFixed(4)} m² (${near(panelBaseQty, m.net_internal_area, 1e-6) ? '== NIA' : near(panelBaseQty, m.gross_external_area, 1e-6) ? '== GEA' : 'neither'}) ` +
      `at an agreed ${inr(RATES.base)}/m² — Δ ${dQty.toFixed(4)} m² = ${inr(dQty * RATES.base)}`,
  )
  ed.free()
}

// Non-vacuity of the population.
check(docs >= 15, '§4 the population is not thin', `only ${docs} documents reconciled`)
check(enclosureStates >= 5, '§4 the enclosure term is exercised', `only ${enclosureStates} documents carry enclosed rooms`)
check(emptyEnclosureStates >= 5, '§4 the empty-enclosure case is exercised', `only ${emptyEnclosureStates} documents have no enclosed rooms — the all-Workspace edit is not landing`)

// ===========================================================================
// §5  PROVENANCE — the `w.generated` partition predicate, against GEOMETRY.
// ===========================================================================
// Both implementations filter `w.generated`, so they AGREE that an imported
// partition is free. Agreement is not correctness, and a cross-surface check is
// structurally blind to it — this is the "presence-matching two contaminated
// lists" shape from the rules file, one level up: two implementations descended
// from one predicate.
//
// The independent ground truth is a METAMORPHIC one: the same building costs the
// same however it was authored. Two documents are built through the public API:
//
//   A  a plate + `generate()`. The generator marks its own interior partitions,
//      so A supplies the SET of segments that are interior partitions — no
//      envelope-vs-interior heuristic of mine is involved.
//   B  a fresh Editor with every one of A's wall segments re-added by
//      `add_wall`, which writes `generated: false`. Identical geometry, opposite
//      provenance.
//
// B must bill A's interior partitions. It bills nothing.
console.log('\n§5 provenance — identical geometry, generated vs imported')
{
  const A = fit(3)
  const sa = A.state()
  const ma = A.metrics()
  const gen = sa.walls.filter((w) => w.generated)
  const interiorM = gen.reduce((s, w) => s + wallLen(w), 0)
  check(gen.length >= 10 && interiorM > 50, '§5 A carries a real interior partition set', `${gen.length} generated walls, ${interiorM.toFixed(2)} m — too little to transplant`)

  const B = new Editor()
  for (const w of sa.walls) B.add_wall(w.a.x, w.a.y, w.b.x, w.b.y, w.thickness)
  const sb = B.state()
  const mb = B.metrics()

  // Instrument guards: the transplant preserved the geometry, and B really is
  // all-imported and otherwise empty, so the residual below is the partition
  // term and nothing else.
  check(sb.walls.length === sa.walls.length, '§5 the transplant carried every wall', `${sb.walls.length} of ${sa.walls.length}`)
  check(near(mb.gross_external_area, ma.gross_external_area), '§5 the transplant preserved the plate', `GEA ${mb.gross_external_area} vs ${ma.gross_external_area}`)
  check(sb.walls.every((w) => !w.generated), '§5 every transplanted wall is imported', 'add_wall no longer writes generated:false, and this section measures nothing')
  check((sb.zones ?? []).length === 0 && (sb.components ?? []).length === 0, '§5 B has no other billable term', `${(sb.zones ?? []).length} zones, ${(sb.components ?? []).length} components — the residual is no longer the partition term alone`)

  // `add_wall` cannot carry the glazing facet, so every transplanted run arrives
  // solid. The expectation is therefore at the SOLID rate for the whole set —
  // deliberately conservative: A bills the glazed runs far higher.
  const expected = interiorM * RATES.solid
  // B's only other term is the base shell, and it is subtracted ON THE BASIS
  // §1.1 DERIVED — not on GEA. Hardcoding GEA here reported B's partition term
  // as −₹84,00,000 under sabotage S2's NIA-billing core: the verdict was still
  // red, and the rupee figure beside it was nonsense. A gate quoting a wrong
  // number is not saved by reaching the right verdict.
  const baseQty = RATES.baseBasis === 'NIA' ? mb.net_internal_area : mb.gross_external_area
  const billed = mb.indicative_cost - baseQty * RATES.base
  check(
    near(billed, expected, 1e-6),
    '§5 · TERM partition: the core bills imported interior partitions',
    `${interiorM.toFixed(4)} m of interior partition, geometrically identical to runs the same model bills in A, is billed ${inr(billed)}; ` +
      `at the extracted solid rate it is ${inr(expected)} — Δ ${inr(expected - billed)}. ` +
      `The predicate is PROVENANCE (\`w.generated\`), not geometry, so an imported floor plate bills ₹0 of partition.`,
  )

  const pb = panelOf(B)
  const pbSolid = pb.line('Partition Wall', 'Default')
  check(
    !!pbSolid && near(pbSolid.qty, interiorM, 1e-9),
    '§5 · TERM partition: the panel bills imported interior partitions',
    `panel bills ${pbSolid ? `${pbSolid.qty.toFixed(4)} m` : 'no Partition Wall line at all'} against ${interiorM.toFixed(4)} m present — ` +
      `stats.ts carries the same \`w.generated\` filter, so both surfaces agree and both are wrong. ` +
      `This is why §5 measures against geometry and not across the two surfaces.`,
  )
  A.free(); B.free()
}

// ===========================================================================
// VERDICT
// ===========================================================================
console.log()
if (baseDeltas.length) {
  const worst = baseDeltas.reduce((a, b) => (Math.abs(b.dInr) > Math.abs(a.dInr) ? b : a))
  console.log(`  base-shell basis divergence on ${baseDeltas.length}/${docs} documents; worst: ${worst.key} — ${worst.dQty.toFixed(4)} m² = ${inr(worst.dInr)}`)
}
if (failures > 0) {
  console.log(`\nCOST-RECONCILIATION FAIL — ${failures} of ${checks} checks red.`)
  process.exit(1)
}
console.log(`\ncost reconciliation OK — ${checks} checks green over ${docs} documents.`)
okline('rates extracted by ablation, quantities re-derived from core state, neither cost implementation consulted about itself.')
