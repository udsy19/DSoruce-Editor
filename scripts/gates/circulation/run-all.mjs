// The circulation board — C1-C10, from the Phase 0 audit's mapping table.
//
//   node scripts/gates/circulation/run-all.mjs                 # all ten
//   node scripts/gates/circulation/run-all.mjs C1 C6           # only these
//   node scripts/gates/circulation/run-all.mjs --as-gate G13   # + a parent line
//   CSELF=1 node scripts/gates/circulation/run-all.mjs         # + a lying gate
//
// WHY ITS OWN BOARD. `scripts/gates/run-all.sh` already owns G1-G12 for the
// deliverable pack. Reusing those numbers would make the board ambiguous and
// break `GSELF`'s scoreboard-line matching, so this follows the `sheets/`
// precedent exactly: its own board, folded into the parent as ONE row (G13).
//
// WHY MOSTLY DELEGATION. Nine of these properties are already guarded by node
// tests written alongside the changes that introduced them, each with its own
// falsification round. A gate that re-implemented those assertions would be a
// SECOND derivation of the same ground truth — the defect this workstream spent
// itself removing. The board's job is to run them under one scoreboard with
// exit-code-AND-line counting, not to restate them.
//
// C10 IS DIFFERENT AND STAYS DIFFERENT. It is the naive-user walkthrough: does
// white space read as floor, coloured space as program, with nothing on the plan
// saying "circulation" anywhere? No machine can answer that, and a gate that
// pretended to would be the most expensive kind of false green. It reports
// PENDING-HUMAN and is never counted as passing.

import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../..')
const WEB = path.join(REPO, 'web')

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose') || process.env.VERBOSE === '1'
const asGate = (argv.find((a) => a.startsWith('--as-gate=')) ?? '').split('=')[1]
  || (argv.includes('--as-gate') ? argv[argv.indexOf('--as-gate') + 1] : '')
const picked = argv.filter((a) => /^C\d+$/.test(a))
const selected = (id) => picked.length === 0 || picked.includes(id)

/** [id, title, kind, target] — `node` runs a web test; `human` never passes. */
const GATES = [
  ['C1', 'Ground silent, corridors named', 'node', 'src/editor/fillRenders.test.mjs'],
  ['C2', 'Hatch editor-only, paper clean', 'node', 'src/editor/fillRenders.test.mjs'],
  ['C3', 'Thumbnails honour the rule', 'node', 'src/editor/fillRenders.test.mjs'],
  ['C4', '3D ground is neutral floor', 'node', 'src/three/groundFloors.test.mjs'],
  ['C5', 'Legends program-only, agreeing', 'node', 'src/export/legendParity.test.mjs'],
  ['C6', 'Efficiency invariant + fold exact', 'node', 'src/export/foldParity.test.mjs'],
  ['C7', 'Core suite + determinism', 'cargo', ''],
  ['C8', 'Metrics card reads core truth', 'node', 'src/ui/metricsCard.test.mjs'],
  ['C9', 'Sheet names no ground', 'node', 'src/export/printLabels.test.mjs'],
  ['C10', 'Naive-user walkthrough', 'human', 'docs/evidence/circulation-audit/G10-walkthrough.md'],
]

const t0 = Date.now()
const lines = []
let failed = 0
let ran = 0
let pending = 0
let checks = 0

for (const [id, title, kind, target] of GATES) {
  if (!selected(id)) continue
  ran++
  if (kind === 'human') {
    // Never green, never red. A human artifact with a blank verdict is PENDING;
    // one with a verdict written is still not this board's to grade.
    const p = path.join(REPO, target)
    const state = fs.existsSync(p) ? 'PENDING-HUMAN (packet ready)' : 'PENDING-HUMAN (packet missing)'
    pending++
    lines.push(`  ${id.padEnd(4)} ${title.padEnd(34)} ${state}`)
    continue
  }
  const r = kind === 'cargo'
    ? spawnSync('cargo', ['test', '-p', 'ds-core'], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20 })
    : spawnSync('node', [target], { cwd: WEB, encoding: 'utf8', maxBuffer: 256 << 20 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const ok = r.status === 0
  if (!ok) failed++
  const detail = kind === 'cargo'
    ? (out.match(/test result: .*/) ?? ['no result line'])[0]
    : (out.split('\n').find((l) => l.startsWith('PASS ')) ?? `FAIL (rc=${r.status})`)
  if (ok) checks++
  lines.push(`  ${id.padEnd(4)} ${title.padEnd(34)} ${ok ? 'PASS' : 'FAIL'}: ${detail.slice(0, 68)}`)
  if (verbose || !ok) for (const l of out.split('\n')) if (l.trim()) console.log(`       ${l}`)
}

// THE LYING GATE (GSELF pattern). Exits 0 while printing FAIL. The board must
// report it red; a board that counts the exit code alone would tally it green,
// which is the exact defect the parent runner shipped once.
if (process.env.CSELF === '1') {
  ran++
  const line = 'CSELF FAIL: deliberately lying gate (exits 0)'
  failed++
  lines.push(`  ${'CSELF'.padEnd(4)} ${'Board self-test'.padEnd(34)} ${line.slice(6)}`)
}

console.log('\n------------------------- CIRCULATION BOARD ------------------------')
for (const l of lines) console.log(l)
console.log('--------------------------------------------------------------------')
console.log(`  ${ran - failed - pending}/${ran - pending} passing · ${pending} pending-human · ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log()

if (failed) {
  console.log(`FAIL: ${failed} circulation gate(s) red.`)
  if (asGate) console.log(`${asGate} FAIL: ${failed} of ${ran} circulation gate(s) red`)
  process.exit(1)
}
console.log(`ALL AUTOMATED CIRCULATION GATES GREEN (${checks}) — ${pending} awaiting a human.`)
if (asGate) console.log(`${asGate} PASS (${checks} gates, ${pending} pending-human)`)
