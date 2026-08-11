// Falsification + sabotage round for the plan-quality board.
//
//   node scripts/gates/plan-quality/falsify.mjs
//
// .claude/rules/gate-independence.md demands two things of any gate touching
// producer-adjacent data, and this file supplies both:
//
//   1. BYTE-IDENTICAL UNDER SABOTAGE. Corrupt every producer-supplied hint the
//      gate could plausibly be reading, and show the VERDICT is unchanged. An
//      assertion that merely "still passes" proves nothing; an identical verdict
//      tuple proves the value was never consulted.
//   2. A FALSIFICATION. Build the artifact the gate is supposed to catch and
//      show it goes RED — and, just as important, build a CLEAN one and show it
//      goes GREEN, because a gate that is red on everything measures nothing.
//
// The negative cases are built as synthetic documents, never by mutating the
// real generator: falsification runs against a disposable copy, never the
// protected artifact.

import { buildDemoDoc } from '../../lib/demo-doc.mjs'
import { pq1, pq2 } from './checks.mjs'

let failures = 0
const t = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/** The verdict tuple — what the gate DECIDES, stripped of cosmetic message text
 *  (PQ2 prints zone labels, which sabotage S1 legitimately changes). */
const verdict = (r) => JSON.stringify({ ok: r.ok, checks: r.checks, rows: (r.rows ?? []).map((x) => [+x.gap.toFixed(6), +x.area.toFixed(6)]) })

const { state } = await buildDemoDoc({ seed: 7 })
const base1 = verdict(pq1(state))
const base2 = verdict(pq2(state))
const clone = () => JSON.parse(JSON.stringify(state))

console.log('SABOTAGE — corrupt every producer hint; verdict must be identical')

// S1: every zone label blanked and shuffled. A gate reading names to decide
//     what a room is would move.
{
  const s = clone()
  for (const z of s.zones) z.label = ''
  t('S1 blanked zone labels', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

// S2: component labels destroyed. PQ1 selects desks by `category`, never label.
{
  const s = clone()
  for (const c of s.components) c.label = 'XXXX'
  t('S2 destroyed component labels', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

// S3: `seats` and `decision` — product-binding metadata a lazier gate might use
//     as a proxy for "is this a real desk".
{
  const s = clone()
  for (const c of s.components) { c.seats = 999; c.decision = 'Confirmed' }
  t('S3 corrupted seats/decision', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

// S4: every wall's `generated` flag flipped. Neither check consults it.
{
  const s = clone()
  for (const w of s.walls) w.generated = !w.generated
  t('S4 flipped wall.generated', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

// S5: zone `component_ids` membership emptied — the core's own answer about
//     which components belong where. PQ1 re-derives grouping from coordinates.
{
  const s = clone()
  for (const z of s.zones) z.component_ids = []
  t('S5 emptied zone.component_ids', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

// S6: the field DELETED entirely, not merely corrupted — the strongest form.
{
  const s = clone()
  for (const z of s.zones) { delete z.label; delete z.component_ids }
  for (const c of s.components) { delete c.label; delete c.seats }
  t('S6 deleted those fields outright', verdict(pq1(s)) === base1 && verdict(pq2(s)) === base2)
}

console.log('\nFALSIFICATION — the gate must be able to go BOTH ways')

/** A clean synthetic plan: three 8-desk neighbourhoods separated by 1.5 m
 *  aisles, and two rooms separated by a shared 0.1 m wall. */
function cleanDoc() {
  const components = []
  let id = 1
  for (let g = 0; g < 3; g++)
    for (let k = 0; k < 8; k++)
      components.push({
        id: id++, category: 'Desk', reference: false, rotation: 0,
        x: g * 6.0 + (k % 2) * 1.7 + 1, y: Math.floor(k / 2) * 1.0 + 1,
        w: 1.6, h: 0.8,
      })
  const zones = [
    { id: 900, zone_type: 'Meeting', label: 'A', shape: { kind: 'Rect', x: 0, y: 20, w: 4, h: 4 } },
    { id: 901, zone_type: 'Meeting', label: 'B', shape: { kind: 'Rect', x: 4.1, y: 20, w: 4, h: 4 } },
  ]
  return { components, zones, walls: [] }
}

{
  const d = cleanDoc()
  const r1 = pq1(d), r2 = pq2(d)
  t('N1 clean plan -> PQ1 GREEN', r1.ok, r1.detail)
  t('N1 clean plan -> PQ2 GREEN', r2.ok, r2.detail)
}

// N2: inject exactly one dead sliver into the clean plan — 0.5 m between the
//     two rooms: too wide for a wall, too narrow to walk.
{
  const d = cleanDoc()
  d.zones[1].shape.x = 4.5
  const r2 = pq2(d)
  t('N2 one 0.50 m sliver -> PQ2 RED', !r2.ok && r2.rows.length === 1, r2.detail)
}

// N3: merge two neighbourhoods by closing their aisle to 0.5 m — PQ1 must catch
//     the resulting 16-desk super-cluster.
//
//     The first attempt shifted by 1.6 m, which puts the aisle at EXACTLY
//     1.1 m — where `< WALK_MIN_M` is correctly false and nothing merges. The
//     boundary was behaving properly and the sabotage was too weak; that is the
//     sabotage round doing its job on its own fixture. Shift 2.2 m: the g0|g1
//     aisle closes to 0.5 m and merges, the g1|g2 aisle stays 2.7 m and does
//     not, giving [16, 8] — one super-cluster over the 12 bound.
{
  const d = cleanDoc()
  for (const c of d.components) if (c.x > 6) c.x -= 2.2
  const r1 = pq1(d)
  t('N3 closed aisle -> PQ1 RED', !r1.ok && r1.sizes[0] === 16, r1.detail)
}

// N3b: the boundary itself, pinned. An aisle of EXACTLY the minimum is
//      acceptable and must NOT merge — otherwise the gate would demand strictly
//      more than the standard it cites.
{
  const d = cleanDoc()
  for (const c of d.components) if (c.x > 6) c.x -= 1.6
  const r1 = pq1(d)
  t('N3b aisle exactly 1.10 m -> still separate', r1.ok && r1.sizes.length === 3, r1.detail)
}

// N4: a gate that cannot fail is not a gate. Prove the clean case is not passing
//     merely because the check found nothing to look at.
{
  const d = cleanDoc()
  t('N4 clean case actually inspected something', pq1(d).checks === 24 && pq2(d).checks >= 1)
}

console.log(`\n${failures === 0 ? 'FALSIFY PASS' : `FALSIFY FAIL: ${failures} red`}`)
process.exit(failures === 0 ? 0 : 1)
