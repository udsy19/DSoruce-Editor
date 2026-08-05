// The sheet-gate board — SG1-SG6, with their producer.
//
//   node scripts/gates/sheets/run-all.mjs               # all six
//   node scripts/gates/sheets/run-all.mjs SG1 SG3       # only these
//   node scripts/gates/sheets/run-all.mjs --no-produce  # grade what is on disk
//
// Exits non-zero if any gate is red. At HEAD, SG1-SG4 ARE red: they are the
// fail-first gates for the four open drawing-set defects, written before any fix
// so that they are calibrated against ground truth rather than against whatever
// a fix happens to produce (`.claude/rules/gate-independence.md`, §"write the
// gate first"). SG5 and SG6 are green and must stay green.
//
// THE PRODUCER RUNS IN THIS INVOCATION, ON PURPOSE. `render-all.mjs` writes the
// 33 sheets the gates grade and `export-pack.mjs` writes the workbook SG4
// cross-checks them against; a board that graded a directory some earlier,
// unrelated run left behind is the failure `scripts/gates/run-all.sh` documents
// at its step 0 and reports/sheets-S0-1.md §7.7 warns about for sheets.
//
// These gates are deliberately NOT in `scripts/gates/run-all.sh`'s IDS/CMDS
// while they are red by design — that board must stay 11/11 with its baseline
// check counts, which is exactly what SG5 asserts. Wiring them in as G12 is the
// last step of the mission, once they are green twice running.

import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { REPO } from './lib/sheetlib.mjs'

const GATES = [
  ['SG1', 'Panel containment', 'sg1-panel-containment.mjs'],
  ['SG2', 'Plate confinement', 'sg2-plate-confinement.mjs'],
  ['SG3', 'Label integrity', 'sg3-label-integrity.mjs'],
  ['SG4', 'Name uniqueness', 'sg4-name-uniqueness.mjs'],
  ['SG5', 'Board integrity', 'sg5-board-integrity.mjs'],
  ['SG6', 'Determinism + independence', 'sg6-determinism.mjs'],
]

const argv = process.argv.slice(2)
const verbose = process.env.VERBOSE === '1'
const produce = !argv.includes('--no-produce')
const want = argv.filter((a) => !a.startsWith('--'))
const selected = (id) => want.length === 0 || want.includes(id)

console.log('==============================================================')
console.log(' DSource drawing-sheet gates')
console.log(` repo: ${REPO}`)
console.log('==============================================================')

if (produce) {
  for (const [what, script, args] of [
    ['rendering the 33 sheets', 'scripts/sheets/render-all.mjs', ['--pack', 'all', '--out', 'out/sheets']],
    ['producing the QTO workbooks', 'scripts/export-pack.mjs', ['--out', 'out']],
  ]) {
    console.log(`\n  ${what}: node ${script} ${args.join(' ')}`)
    try {
      execFileSync('node', [path.join(REPO, script), ...args], {
        cwd: REPO,
        stdio: verbose ? 'inherit' : 'pipe',
        maxBuffer: 64 << 20,
      })
    } catch (err) {
      console.error(`\nFAIL: the producer ${script} did not run — the gates would grade a stale directory.`)
      console.error(String(err.stdout ?? '') + String(err.stderr ?? err.message))
      process.exit(1)
    }
  }
}

const t0 = Date.now()
const lines = []
let failed = 0
let ran = 0
for (const [id, title, file] of GATES) {
  if (!selected(id)) continue
  ran++
  const r = spawnSync('node', [path.join(REPO, 'scripts/gates/sheets', file)], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const line = (out.match(new RegExp(`^${id} (PASS|FAIL).*$`, 'm')) ?? [])[0]
  if (r.status !== 0) failed++
  lines.push(`  ${id.padEnd(4)} ${title.padEnd(28)} ${line ? line.slice(id.length + 1) : `FAIL: no scoreboard line (rc=${r.status})`}`)
  if (verbose || r.status !== 0) {
    for (const l of out.split('\n')) if (l.trim() && !l.startsWith(id)) console.log(`       ${l}`)
  }
}

console.log('\n--------------------------- SCOREBOARD -----------------------')
for (const l of lines) console.log(l)
console.log('--------------------------------------------------------------')
console.log(`  ${ran - failed}/${ran} passing${' '.repeat(20)}${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log()
if (failed) {
  console.log(`FAIL: ${failed} sheet gate(s) red.`)
  process.exit(1)
}
console.log('ALL SHEET GATES GREEN.')
