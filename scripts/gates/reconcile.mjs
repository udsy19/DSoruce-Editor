// RECONCILE — every gate that EXISTS is a gate that RUNS.
//
//   node scripts/gates/reconcile.mjs            # verdict
//   node scripts/gates/reconcile.mjs --explain  # + the three derived sets
//
// THE DEFECT THIS EXISTS FOR. `bench/ladder-check.mjs`, `bench/lod-sweep.mjs`
// and `bench/export-parity.mjs` were written, falsified, ledgered — and invoked
// by NO RUNNER. `verify-all.sh` ran three gates, `run-all.sh` ran G1-G13, the
// root `package.json` had one `bench` script pointing at something else, and
// there is no `.github/workflows`. All three passed at HEAD in ~51/49/54 ms and
// none of them had graded a commit. **Four documents recorded `ladder-check` as
// PASS on a board it has never been on.** Existing-but-uninvoked is not a state
// a gate may be in, and nothing in the tree could see it.
//
// It is R8 extended. R8 says the board runner is itself a system under test —
// proven by the IDS/TITLES length mismatch that ran G13, counted it, and then
// silently dropped its row. That defect was about a check the board GRADED and
// did not SHOW. This is the same family one step earlier: a check the board
// never reached at all. Both are the board's own bookkeeping, and the board
// cannot be the only thing auditing it.
//
// ---------------------------------------------------------------------------
// INDEPENDENCE — what each side is derived from, and why it is not the other
// ---------------------------------------------------------------------------
//
// `.claude/rules/gate-independence.md`, "derive the full expected set, never
// presence-match two artifact-derived lists": anchoring one side to ground truth
// is not enough if the other side descends from the same upstream list, because
// the two contaminated sides then AGREE about the missing element.
//
// The two sides here come from genuinely different artifacts:
//
//   POPULATION — the FILESYSTEM. Every check file that exists, found by walking
//     the gate directories and classifying on the file's OWN BYTES. No list
//     anywhere declares what the gates are; adding a gate file adds a row here
//     whether or not anybody remembered to register it, which is the entire
//     point. A hand-maintained roster would have listed exactly the three gates
//     that were already orphaned.
//
//   INVOCATIONS — the RUNNERS' SOURCE. What the shell and node runners actually
//     spawn, read out of their text. Not their declared IDs, not their
//     scoreboards: the commands.
//
// Delete a gate file and it leaves BOTH sets — correct, a deleted gate is not an
// orphan, and deletion is a legitimate outcome. That hole is closed from the
// other side by the bookkeeping section: a board that still DECLARES a gate
// whose file is gone fails there.
//
// ---------------------------------------------------------------------------
// THE CLASSIFIER, and its two-sided exemption
// ---------------------------------------------------------------------------
//
// A gate is a file that can turn a board red. That is a property of the bytes,
// not of anybody's intent, so it is what gets tested for:
//
//   .mjs — `process.exit(1)`, or a `gatelib` scoreboard call
//   .py  — `run_gate(`, or `sys.exit(1)`
//
// MEASURED, and it shrank the design: the benchmark DRIVERS in `bench/`
// (`run.mjs`, `runQto.mjs`, `runSearch.mjs`) and the fixture producer
// (`bench/fixtures/generate.mjs`) carry no verdict-exit at all, so the
// byte-derived classifier never claims them and the four exemptions first
// written for them were deleted rather than kept as dead weight. What remains
// needs a name, and each entry is TWO-SIDED — asserted against the property
// that justifies it, so an exemption that outlives its reason fails as loudly as
// an orphan. That is `deadspace-core`'s EXPECTED_UNRESOLVED shape.
//
//   NOT_A_BATTERY_GATE — a check that cannot run unattended (needs a live URL).
//     Two-sided: it must still require its target argument.
//   QUARANTINED — a real gate that is RED against the shipped product today.
//     Two-sided, and re-derived rather than trusted: this file RUNS it and
//     asserts it still fails. The day it goes green, this reds and demands it
//     be wired. A quarantine nobody re-measures is an orphan with paperwork.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const EXPLAIN = process.argv.includes('--explain')
const rel = (p) => path.relative(ROOT, p)
const read = (p) => fs.readFileSync(p, 'utf8')

let fails = 0
const check = (ok, name, detail) => {
  if (!ok) fails++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`)
}

// ---------------------------------------------------------------------------
// 1. POPULATION — derived from the filesystem
// ---------------------------------------------------------------------------

// Directories a gate can live in. `lib/` holds shared helpers by convention and
// `fixtures/` + `adapters/` hold inputs and benchmark subjects, none of which
// are graded; those are excluded STRUCTURALLY (by directory), not by name, so
// nobody can slip a gate past this by adding a filename to a list.
const NON_GATE_DIRS = new Set(['lib', 'fixtures', 'adapters', 'sealed-grid', 'style-progress'])

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (NON_GATE_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out)
    } else if (/\.(mjs|py)$/.test(e.name)) {
      out.push(path.join(dir, e.name))
    }
  }
  return out
}

// COMPLETENESS FIRST. The first version of this matched `process.exit(1)` and
// `sys.exit(1)` literally, and MISSED six sheet gates, G8, G10 and
// `deadspace.py` — every one of them a real gate using a different exit idiom
// (`process.exit(ok ? 0 : 1)`, `gatelib`'s `L.finish()`, `raise SystemExit`).
// An under-inclusive population is the D-O failure exactly: the check would have
// reported "no orphans" while an orphaned sheet gate sat next to it. Widened to
// ANY exit expression that can carry a non-zero status, plus the gate library
// itself, and the widening is what surfaced `scripts/gates/deadspace.py`.
const VERDICT = {
  '.mjs': [/process\.exit\(/, /gatelib\.mjs/],
  '.py': [/sys\.exit\(/, /raise SystemExit/, /gatelib/, /run_gate\(/],
}
const isCheck = (p) => {
  const src = read(p)
  return (VERDICT[path.extname(p)] ?? []).some((re) => re.test(src))
}

// Runners are not gates; they are the thing gates are reconciled against.
const RUNNERS = [
  'scripts/verify-all.sh',
  'scripts/gates/run-all.sh',
  'scripts/gates/sheets/run-all.mjs',
  'scripts/gates/circulation/run-all.mjs',
  'package.json',
  '.githooks/pre-commit',
].map((r) => path.join(ROOT, r))

/**
 * NOT A BATTERY GATE — carries a verdict-exit, but cannot run unattended.
 *
 * `probe` is the property that justifies the entry, and it is re-tested every
 * run: the file must STILL require the target it cannot supply itself. The day
 * one of these stops needing an argument it becomes wireable, and the exemption
 * must go with the same commit.
 */
const NOT_A_BATTERY_GATE = {
  'bench/assert-build.mjs': {
    why: 'build-provenance preflight — takes a live URL as argv[2] and fetches it; there is no server in the battery',
    probe: /process\.argv\[2\][\s\S]*?usage: node bench\/assert-build\.mjs <url>/,
  },
  'scripts/gates/deadspace.py': {
    why:
      'RETRACTED instrument. Its own header reads "UNTRUSTED — DO NOT QUOTE THIS SCRIPT\'S NUMBERS": ' +
      'the plate segmentation measured the wall bounding box (1597 m2) instead of the plate polygon ' +
      '(930 m2), three successive versions returned 19.0% / abort / 0.0% on one unchanged drawing, and ' +
      'every figure it produced is void (rubric-q3.md row 8, LOOP-LEDGER 1802). It was superseded by ' +
      'scripts/gates/deadspace-core.mjs, which re-derives from core state and IS on the battery. ' +
      'Wiring this would put a known-wrong instrument on the commit path.',
    // The probe is the banner. Repair it and remove the banner, and this entry
    // fails — a fixed instrument must be wired or deleted, not left in limbo
    // with a stale exemption.
    probe: /UNTRUSTED — DO NOT QUOTE THIS SCRIPT'S NUMBERS/,
  },
}

/**
 * QUARANTINED — a real gate, RED against the product as it ships today.
 *
 * Wiring a red gate into `verify-all.sh` would block every commit on a product
 * gap it did not cause; deleting it would throw away a measured contract. So it
 * is named here with its failure re-derived, not asserted: `cmd` is RUN and its
 * exit code must still be non-zero.
 *
 * This is the one place a gate's own exit code is consumed, and the direction
 * makes it safe: a quarantined gate lying GREEN is what this fails on, so the
 * lie it could tell is the one being caught.
 */
const QUARANTINED = {
  'scripts/gates/composition.mjs': {
    why: 'programme-mix contract vs the qbiq reference: 10 violations across all 5 fixtures at HEAD ' +
      '(desk runs of 7-8 rows against the reference\'s 5; 2.17-3.26 conf rooms per 100 open seats ' +
      'against 8.6). A generator change, not a gate fix.',
    cmd: ['scripts/gates/composition.mjs', '--gate'],
  },
}

const EXEMPT = new Set([...Object.keys(NOT_A_BATTERY_GATE), ...Object.keys(QUARANTINED)])

const population = walk(path.join(ROOT, 'bench'))
  .concat(walk(path.join(ROOT, 'scripts/gates')))
  .filter((p) => !RUNNERS.includes(p))
  .filter(isCheck)
  .map(rel)
  .sort()

// ---------------------------------------------------------------------------
// 2. INVOCATIONS — derived from the runners' source
// ---------------------------------------------------------------------------

const runnerSrc = RUNNERS.filter((r) => fs.existsSync(r))
  .map((r) => `\n/* ==== ${rel(r)} ==== */\n` + read(r))
  .join('\n')

const invoked = (relPath) =>
  runnerSrc.includes(relPath) || runnerSrc.includes(path.basename(relPath))

// ---------------------------------------------------------------------------
// 3. RECONCILE
// ---------------------------------------------------------------------------

console.log('gate reconciliation — every gate that exists is a gate that runs\n')

const gates = population.filter((p) => !EXEMPT.has(p))
const orphans = gates.filter((p) => !invoked(p))

if (EXPLAIN) {
  console.log(`  runners scanned (${RUNNERS.length}):`)
  for (const r of RUNNERS) console.log(`      ${rel(r)}${fs.existsSync(r) ? '' : '  MISSING'}`)
  console.log(`\n  population (${population.length} check files on disk):`)
  for (const p of population) {
    const tag = p in QUARANTINED ? 'quarant' : EXEMPT.has(p) ? 'exempt ' : invoked(p) ? 'invoked' : 'ORPHAN '
    console.log(`      ${tag}  ${p}`)
  }
  console.log()
}

check(
  orphans.length === 0,
  `no orphan gates (${gates.length} gate file(s) on disk, ${gates.length - orphans.length} invoked)`,
  orphans.length
    ? orphans.map((o) => `${o} — exists, passes, and NO runner invokes it`).join('\n          ') +
      '\n          Wire it into a runner, or delete it and ledger the reason.\n' +
      '          A gate nobody runs has never graded a commit, whatever any report says.'
    : '',
)

// Every runner named above must exist. A reconciler that silently skips a
// missing runner would report "no orphans" the moment somebody renamed the
// board — the producer choosing whether it is checked.
for (const r of RUNNERS) {
  check(fs.existsSync(r), `runner present: ${rel(r)}`, 'the reconciler would scan one runner fewer')
}

// The two-sided exemption.
for (const [p, e] of Object.entries(NOT_A_BATTERY_GATE)) {
  const abs = path.join(ROOT, p)
  const there = fs.existsSync(abs)
  check(there, `exemption names a real file: ${p}`, `gone — drop the entry (${e.why})`)
  check(
    !there || e.probe.test(read(abs)),
    `exemption still justified: ${p}`,
    `it no longer requires the target it was exempted for — it can run ` +
      `unattended now, so wire it and delete this entry (${e.why})`,
  )
}

for (const [p, q] of Object.entries(QUARANTINED)) {
  const abs = path.join(ROOT, p)
  const there = fs.existsSync(abs)
  check(there, `quarantine names a real file: ${p}`, `gone — drop the entry (${q.why})`)
  if (!there) continue
  // RE-DERIVED, not trusted. Run it and read the exit code.
  const r = spawnSync(process.execPath, q.cmd.slice(1).length ? [q.cmd[0], ...q.cmd.slice(1)] : [q.cmd[0]], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  check(
    r.status !== 0,
    `quarantine still red: ${p} (exit ${r.status})`,
    'it PASSES now — the product caught up with the contract. Wire it into ' +
      'scripts/verify-all.sh and delete this quarantine entry, in the same change.',
  )
}

// ---------------------------------------------------------------------------
// 4. BOOKKEEPING — the board's declared list against its own commands (R8)
// ---------------------------------------------------------------------------
// The IDS/TITLES mismatch RAN G13, counted it, and dropped its row. run-all.sh
// now asserts its own array lengths — but a board asserting its own bookkeeping
// is the thing R8 forbids, so it is re-derived here from the source text.

const boardSrc = read(path.join(ROOT, 'scripts/gates/run-all.sh'))
const arr = (name) => {
  const m = boardSrc.match(new RegExp(`declare -a ${name}=\\(([\\s\\S]*?)\\)\\n`))
  if (!m) return null
  return m[1]
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
}
const ids = arr('IDS')?.join(' ').split(/\s+/).filter(Boolean) ?? []
const cmds = arr('CMDS') ?? []
const titles = arr('TITLES') ?? []
check(
  ids.length > 0 && ids.length === cmds.length && ids.length === titles.length,
  `board arrays agree (${ids.length} ids · ${cmds.length} cmds · ${titles.length} titles)`,
  'a shorter TITLES is how G13 ran, was counted, and never appeared on the scoreboard',
)

// Every command the board declares must name a file that exists. This is the
// other half of the deletion hole: a gate file removed while its row stayed.
for (let i = 0; i < cmds.length; i++) {
  const m = cmds[i].match(/\$HERE\/([\w./-]+)/)
  if (!m) continue
  const abs = path.join(ROOT, 'scripts/gates', m[1])
  check(fs.existsSync(abs), `${ids[i] ?? `CMDS[${i}]`} names a real file: gates/${m[1]}`, 'declared, missing on disk')
}

console.log()
if (fails > 0) {
  console.log(`RECONCILE FAIL: ${fails} check(s) — the board does not describe the gates on disk.`)
  process.exit(1)
}
console.log(
  `reconcile OK — ${gates.length} gate(s) on disk, all invoked; ` +
    `${Object.keys(NOT_A_BATTERY_GATE).length} exempt (cannot run unattended), ` +
    `${Object.keys(QUARANTINED).length} quarantined and re-measured still red; ` +
    `board declares ${ids.length} rows against ${ids.length} commands and ${titles.length} titles`,
)
