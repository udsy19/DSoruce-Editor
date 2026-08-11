// The plan-quality board — PQ1-PQ2, from the PROFESSIONAL-FEEL mission's §1.1
// visual-acceptance rubric.
//
//   node scripts/gates/plan-quality/run-all.mjs                 # all
//   node scripts/gates/plan-quality/run-all.mjs PQ1             # only these
//   node scripts/gates/plan-quality/run-all.mjs --as-gate G14   # + a parent line
//   PQSELF=1 node scripts/gates/plan-quality/run-all.mjs        # + a lying gate
//   node scripts/gates/plan-quality/run-all.mjs --seeds 7,11,23 # widen the population
//
// WHY ITS OWN BOARD. `run-all.sh` owns G1-G12 for the deliverable pack and G13
// for circulation; `sheets/` and `circulation/` each took their own board and
// folded into the parent as ONE row. This follows that precedent exactly, so
// `GSELF`'s scoreboard-line matching keeps working.
//
// WHY IT EXISTS. The mission's §1.1 says a professional reviewer should see
// architecture, not "desks on pastels". Every existing gate grades quantities,
// bytes and formulas — all green while the delivered plan carried twelve
// sub-minimum gaps between rooms and a desk field whose neighbourhoods ran
// 16, 12, 8, 8, 4, 4, 4, 4, 2, 1. A board can be perfect about what it measures
// and silent about what the product is for.
//
// The checks live in `checks.mjs` — ONE implementation, shared with the sabotage
// round in `falsify.mjs`. Independence and the single stated metadata dependency
// are documented there.
//
// WATCHED RED FIRST. Both checks were written before any generator change and
// run against the unmodified tree, per the mission's "write the gate first, and
// watch it fail first". Day-one output is recorded in
// `docs/audits/PROFESSIONAL-FEEL-LEDGER.md`.

import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildDemoDoc } from '../../lib/demo-doc.mjs'
import { pq1, pq2 } from './checks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const asGate =
  (argv.find((a) => a.startsWith('--as-gate=')) ?? '').split('=')[1] ||
  (argv.includes('--as-gate') ? argv[argv.indexOf('--as-gate') + 1] : '')
const seedArg =
  (argv.find((a) => a.startsWith('--seeds=')) ?? '').split('=')[1] ||
  (argv.includes('--seeds') ? argv[argv.indexOf('--seeds') + 1] : '')
const SEEDS = seedArg ? seedArg.split(',').map((s) => Number(s.trim())) : [7]
const picked = argv.filter((a) => /^PQ\d+$/.test(a))
const selected = (id) => picked.length === 0 || picked.includes(id)
// PQ0 runs once for the board, not once per seed — it grades the checks
// themselves, which do not vary with the document.

const CHECKS = [
  { id: 'PQ1', title: 'desk neighbourhoods', fn: pq1 },
  { id: 'PQ2', title: 'no sub-minimum room gaps', fn: pq2 },
]

let failed = 0
let ran = 0

// PQ0 — the sabotage round is a PERMANENT FIXTURE, re-run on every board
// execution, exactly as SG5 re-runs GSELF. An independence proof that ran once
// at authoring time and never again is a claim, not a measurement: the day a
// check starts reading `zone.label` or `cluster_cols`, this reds immediately
// instead of at the next audit. It also makes `falsify.mjs` an INVOKED gate,
// which is what `scripts/gates/reconcile.mjs` requires of every gate on disk.
if (selected('PQ0')) {
  ran++
  const r = spawnSync(process.execPath, [path.join(HERE, 'falsify.mjs')], { encoding: 'utf8' })
  const ok = r.status === 0 && /FALSIFY PASS/.test(r.stdout ?? '')
  if (!ok) failed++
  const summary = (r.stdout ?? '').split('\n').filter((l) => /FAIL/.test(l)).join('; ')
  console.log(
    `PQ0 ${ok ? 'PASS' : 'FAIL'} (12 checks): ` +
      (ok
        ? 'sabotage round holds — 6 producer hints corrupted then deleted, verdict identical; 6 falsifications fire'
        : `sabotage round BROKEN — ${summary || 'no FALSIFY PASS line'}`),
  )
}

for (const seed of SEEDS) {
  const { state } = await buildDemoDoc({ seed })
  for (const c of CHECKS) {
    if (!selected(c.id)) continue
    ran++
    let res
    try {
      res = c.fn(state)
    } catch (e) {
      // A check that throws is a FAILURE, never a skip: `if (!x) continue` hands
      // the producer a veto over its own test.
      res = { ok: false, checks: 0, detail: `threw: ${e.message}` }
    }
    if (!res.ok) failed++
    const seedTag = SEEDS.length > 1 ? ` seed=${seed}` : ''
    console.log(`${c.id} ${res.ok ? 'PASS' : 'FAIL'}${seedTag} (${res.checks} checks): ${res.detail}`)
  }
}

// The deliberately lying check, per SG5/GSELF: prints FAIL while the process
// would otherwise exit 0, so the parent board is proven to count the LINE and
// not merely the exit code.
if (process.env.PQSELF === '1') {
  ran++
  failed++
  console.log('PQSELF FAIL (1 checks): deliberately lying gate — the board must report this red')
}

if (asGate) {
  console.log(
    failed === 0
      ? `${asGate} PASS (${ran} checks)`
      : `${asGate} FAIL: ${failed} of ${ran} plan-quality check(s) red`,
  )
}

process.exit(failed === 0 ? 0 : 1)
