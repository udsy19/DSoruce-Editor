// RECONCILE — every gate that EXISTS is a gate that RUNS, and every TEST that
// was ever pinned is a test that still exists (section 5, F1).
//
//   node scripts/gates/reconcile.mjs            # verdict
//   node scripts/gates/reconcile.mjs --explain  # + the three derived sets
//   node scripts/gates/reconcile.mjs --update-roster --why '<attribution>'
//                                               # re-record the test rosters;
//                                               # --why is REQUIRED (section 5)
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
  'scripts/gates/cost-reconciliation.mjs': {
    why:
      'the two rupee formulas disagree TERM BY TERM at HEAD: cost.rs bills the base shell on GEA and ' +
      "stats.ts's buildElements bills it on NIA (12 of 18 documents, worst F3 at 695.1480 m² = ₹97,32,072.62 — " +
      'the six that agree are exactly those where GEA == NIA); the two furniture keyword ladders price 5 of ' +
      '34 categories differently (Meeting ₹2,500 vs ₹1,20,000, Double Door ₹2,500 vs ₹25,000, Counter, ' +
      'Settee, Banquette); and both sides filter `w.generated`, so 131.30 m of transplanted interior ' +
      'partition bills ₹0 on BOTH surfaces. A core change, not a gate fix — and cost.rs is owned by ' +
      'another session, so the gate ships before the fix by design (reports/INTEGRATION-5-merged-board.md §5: ' +
      'writing the fix first produces a gate calibrated to the fix, and this defect already survived a ' +
      'reconciliation that stopped one term short).',
    cmd: ['scripts/gates/cost-reconciliation.mjs'],
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
// 1b. R12 AMENDED — THE ASSERTING-FILE CENSUS, DERIVED FROM THE REPO
// ---------------------------------------------------------------------------
//
// The population above is `walk('bench') + walk('scripts/gates')`: two
// directory names, authored once. Everything this file says about orphans is
// therefore scoped to those two trees — and it never said so.
//
// `scripts/drawing-set.test.mjs` lives in neither. It renders the whole
// architectural set and asserts against a frozen digest, it was RED at base with
// 19 failures, and the only thing that ran it was SG5, nested inside a board
// that needs a live dev server. It went unnoticed for 73 commits. That is the
// sixth hiding-place class — **the asserting file outside every population** —
// and it closes the way the previous five did: by DERIVING the census instead of
// authoring it.
//
// An ASSERTING FILE is any file that can fail a build: a `*.test.*` by name, or
// any script carrying a verdict-exit idiom. Every one must be reachable from a
// named runner, or exempt with its reason. Reachability is itself derived — a
// runner that globs (`find src -name '*.test.mjs'`) covers what the glob covers,
// and the glob is READ OUT OF THE RUNNER'S SOURCE so deleting it takes the
// coverage claim with it.
const REPO_SKIP = new Set([
  'node_modules', 'target', 'dist', '.git', 'out', 'graphify-out', 'samples',
  'wasm', '.dev-plans', 'research', 'docs', 'reports', '__pycache__',
])

function walkRepo(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // `lib/`, `adapters/`, `fixtures/` are excluded STRUCTURALLY here for the
    // same reason the gate walk excludes them: a shared helper that carries an
    // exit idiom is not a check, and nobody should be able to slip one past
    // this by naming a file.
    if (REPO_SKIP.has(e.name) || NON_GATE_DIRS.has(e.name) || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkRepo(full, out)
    else if (/\.(mjs|js|ts|tsx|py|sh)$/.test(e.name)) out.push(full)
  }
  return out
}

/** By NAME (a `*.test.*`) or by BYTES (a verdict-exit idiom). */
const isAsserting = (p) => {
  if (/\.test\.[a-z]+$/.test(path.basename(p))) return true
  const ext = path.extname(p)
  if (!VERDICT[ext]) return false
  try {
    return isCheck(p)
  } catch {
    return false
  }
}

/**
 * The runners' DYNAMIC reach. `verify-all.sh` runs every `web/src/**` test
 * through `find src -name '*.test.mjs'`; that is real coverage, and it is
 * claimed here only while the glob is still in the runner's source.
 */
const GLOBS = [
  {
    runner: 'scripts/verify-all.sh',
    needle: "find src -name '*.test.mjs'",
    covers: (r) => r.startsWith('web/src/') && r.endsWith('.test.mjs'),
    why: "verify-all.sh globs them: `find src -name '*.test.mjs'` from web/",
  },
]
const liveGlobs = GLOBS.filter((g) => {
  const src = fs.existsSync(path.join(ROOT, g.runner)) ? read(path.join(ROOT, g.runner)) : ''
  return src.includes(g.needle)
})

/**
 * Asserting files that are NOT gates and NOT in a globbed battery, each with the
 * board that runs it. An entry here is a claim that some runner invokes it; the
 * reconciliation below re-checks that by scanning runner source, so a wrong
 * claim is red rather than decorative.
 */
const ASSERTING_ELSEWHERE = {
  'scripts/drawing-set.test.mjs':
    'the architectural drawing set, graded against a per-sheet content digest. It now has its OWN ROW on the sheet board (scripts/gates/sheets/run-all.mjs), so its redness is a scoreboard line rather than a sentence inside SG5\'s failure message — which is how it stayed red at base for 73 commits.',
}

/**
 * PRODUCERS AND HAND TOOLS — they carry a verdict-exit because they refuse to
 * write a bad artifact, which is right; they are not graders. Each entry states
 * why it cannot be a board row, and the reasons are of exactly two kinds:
 * it WRITES rather than grades, or it requires arguments no board can supply.
 */
const NOT_A_GRADER = {
  'scripts/sheets/render-all.mjs': 'PRODUCER — renders the 33 sheets the SG gates grade. Invoked by the sheet board and by run-all.sh step 0b.',
  'scripts/render-walkthrough.mjs': 'PRODUCER — renders the walkthrough mp4 that G7 grades.',
  'scripts/share-plan.mjs': 'PRODUCER — publishes the GLB + /share/<id> bundle that G8 grades.',
  'scripts/one-action.e2e.mjs': 'PRODUCER — drives the app\'s one export control to write out/; it is what G10 grades.',
  'scripts/capture-fixtures.mjs': 'HAND TOOL — re-records capture fixtures. Running it on a board would overwrite the expectations the board grades against.',
  'scripts/capture-plate-fixture.mjs': 'HAND TOOL — same, for the plate fixture.',
  'scripts/pixdiff.py': 'HAND TOOL — takes two image paths and prints their difference. No arguments a board could supply; the same shape as bench/assert-build.mjs.',
  'web/src/import/sampleDrawing.mjs': 'FIXTURE BUILDER — constructs the sample drawing other tests import. It asserts its own output is well-formed; it grades nothing.',
}

const assertingAll = walkRepo(ROOT)
  .map(rel)
  .filter((r) => !RUNNERS.map(rel).includes(r))
  .filter((r) => isAsserting(path.join(ROOT, r)))
  .sort()

/** Computed at check time — `invoked` is defined in section 2, below this. */
const unclassifiedAsserting = () =>
  assertingAll.filter((r) => {
    if (population.includes(r)) return false                     // the gate population above
    if (EXEMPT.has(r)) return false
    if (liveGlobs.some((g) => g.covers(r))) return false         // a runner globs it
    if (r in ASSERTING_ELSEWHERE) return false                   // declared, checked below
    if (r in NOT_A_GRADER) return false                          // producer / hand tool
    if (invoked(r)) return false                                 // some runner names it
    return true
  })

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

// R12 AMENDED — every asserting file in the REPO is classified.
const assertingUnclassified = unclassifiedAsserting()
check(
  assertingUnclassified.length === 0,
  `every asserting file is in a board's population (${assertingAll.length} found repo-wide)`,
  assertingUnclassified.map((r) => `${r} — asserts, and no board's population contains it`).join('\n          ') +
    '\n          Wire it into a runner, or declare it in ASSERTING_ELSEWHERE with the board that runs it.' +
    '\n          An asserting file nobody runs has never graded a commit, whatever any report says.',
)
// The declared ones are re-checked against runner source, not trusted.
for (const [p_, why] of Object.entries(ASSERTING_ELSEWHERE)) {
  check(fs.existsSync(path.join(ROOT, p_)), `ASSERTING_ELSEWHERE names a real file: ${p_}`, 'declared but absent')
  check(invoked(p_), `${p_} is actually invoked by a runner`, `declared as: ${why}`)
}
// And the glob claims are live, not historical.
for (const g of GLOBS) {
  check(
    liveGlobs.includes(g),
    `${g.runner} still globs its battery (${g.needle})`,
    'the glob is gone, so every file it covered is now unreached — and the coverage claim with it',
  )
}
// Non-vacuity: a census that walks nothing classifies everything perfectly.
check(
  assertingAll.length >= 40,
  `the asserting-file census reaches the tree (${assertingAll.length} files)`,
  'too few files found — the walk is not reaching the repo, and a reconciliation over an empty population is green for the wrong reason',
)

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

// ---------------------------------------------------------------------------
// 5. THE ROSTERS (F1) — the two largest populations, as MANIFESTS OF NAMES
// ---------------------------------------------------------------------------
//
// THE DEFECT. Everything above reconciles GATES. The two biggest populations on
// the battery are not gates: the 43 globbed `web/src/**/*.test.mjs` files and
// the 200 `#[test]` functions in `ds-core`. Both are DISCOVERED FROM THE
// ARTIFACT BEING GRADED — `find src -name '*.test.mjs'` and cargo's own harness
// discovery — so a deleted test does not lower the numerator, it leaves the
// population and takes the denominator with it.
//
// MEASURED in a disposable worktree off 56af276: delete `statsPanel.test.mjs`
// and `zone::tests::capacity_rules` (one of only two guards on
// `capacity_from_area`) and the tree is FULLY GREEN —
// `VERIFY OK — 53/53 steps green`, `199 passed; 0 failed`, `reconcile OK`.
// Nothing named the loss. That is the R8 defect verify-all.sh's own header
// documents, fixed for the `skip()` path only.
//
// And THIS FILE could already see it and threw it away: the census below printed
// `83 file(s) … 43 globbed by a runner` before the deletion and `82 … 42` after,
// and still exited `reconcile OK`. The number was printed, never asserted.
// CLAUDE.md:198 has stated the rule the whole time — Rust tests "counted BY
// NAME, because a matching number with a missing name is a regression."
//
// INDEPENDENCE. The pin (`scripts/fixtures/test-roster.manifest.json`) is the
// only hand-declared side; it is authored, reviewed and re-recorded with
// attribution. Both disk sides are re-derived per run from something that is not
// the pin, and neither is a re-implementation of the runner:
//
//   JS   — the shell pipeline is EXTRACTED FROM verify-all.sh's own source (the
//          text inside `done < <( … )`) and RUN. Reconciling against a second
//          hand-written walker would let the two drift; reconciling against the
//          runner's literal command cannot. Delete the pipeline and the
//          extraction fails RED rather than reconciling against nothing.
//   RUST — `cargo test -p ds-core -- --list`. Names, not a count, and the parse
//          is cross-checked against cargo's own `N tests` summary so a regex
//          that stops matching cannot pass as a shrinking population.
//
// THE COST, STATED RATHER THAN AVOIDED. `cargo test -p ds-core -- --list`
// requires the crate and its test harness to COMPILE. Measured in a disposable
// worktree with an isolated CARGO_TARGET_DIR: 8.96 s cold (no target dir at
// all), 0.17 s warm, 1.04 s warm after touching one Rust source. verify-all.sh
// skips the Rust SUITE on a change with no Rust in it; reconcile does NOT skip
// the LIST, so on a JS-only change the battery now pays that compile where it
// used to pay nothing.
//
// That is the trade, taken deliberately. Sampling a subset, caching the list, or
// skipping it when Rust looks untouched would each restore the exact defect this
// section exists for — a population that leaves the denominator — and "expensive"
// becoming "skipped" is this mission's oldest failure. Nine seconds once, then
// tenths, is the price of the 200 names being NAMES.
//
// R10 AXES: direction (a member gone and a member arrived are SEPARATE checks,
// so a rename reads as one gone + one new and never as net zero) · derivation
// anchor (remove the `done < <(…)` pipeline, or the `cargo test -p ds-core`
// invocation, from verify-all.sh — the roster's coverage claim dies with the
// runner that backs it) · parse integrity (the `: test` matcher against cargo's
// own total) · subject existence (a missing or unparseable pin is a FAILURE,
// never a skip) · provenance (`--update-roster` is refused without `--why`, and
// refused when it would change nothing).

const ROSTER_PIN = path.join(ROOT, 'scripts/fixtures/test-roster.manifest.json')
const VERIFY_ALL = path.join(ROOT, 'scripts/verify-all.sh')
const UPDATE_ROSTER = process.argv.includes('--update-roster')
const ROSTER_WHY = (() => {
  const i = process.argv.indexOf('--why')
  const v = i > 0 ? process.argv[i + 1] : null
  return v && !v.startsWith('--') ? v : null
})()

/**
 * The JS side, taken from the RUNNER'S OWN PIPELINE rather than re-walked.
 *
 * Exactly one `done < <( … )` is expected. If verify-all.sh grows a second
 * globbed loop this reds — correctly: a second glob is a second population, and
 * this roster would be silently pinning only one of them.
 */
function jsRosterOnDisk() {
  if (!fs.existsSync(VERIFY_ALL)) return { err: 'scripts/verify-all.sh is gone — there is no runner to reconcile against' }
  // ANCHORED TO THE WHOLE CONSTRUCT, not to the pipeline alone: the loop must
  // read a name AND `run node` on it AND be fed by the glob. The pipeline on its
  // own is a list; only the loop makes it a population that grades commits.
  // (Measured: the first version of the Rust half of this section matched
  // `cargo test -p ds-core` ANYWHERE in the runner's source, and the E2 sabotage
  // — replace the `run` line with a `skip`, leave the two comment mentions —
  // came back `reconcile OK`. Same family, so both halves are anchored to the
  // invocation now.)
  const pipes = [
    ...read(VERIFY_ALL).matchAll(
      /^while IFS= read -r (\w+); do\n\s*run "[^"]*" node "\$\1"\n\s*done < <\((.+)\)\s*$/gm,
    ),
  ].map((m) => m[2])
  if (pipes.length !== 1) {
    return {
      err: `verify-all.sh has ${pipes.length} \`while read … run node … done < <( … )\` loop(s), expected exactly 1 — ` +
        'the JS roster derivation has lost its anchor in the runner (0: the glob is gone, or it no ' +
        'longer feeds a loop that actually RUNS each file), or the runner grew a second globbed ' +
        'population this pin does not cover (2+)',
    }
  }
  const r = spawnSync('bash', ['-c', pipes[0]], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) return { err: `the runner's own pipeline failed (exit ${r.status}): ${pipes[0]}` }
  return { names: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean), how: pipes[0] }
}

/** The Rust side, from cargo's own discovery. A missing cargo is a FAILURE. */
function rustRosterOnDisk() {
  const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ''}` }
  const r = spawnSync('cargo', ['test', '-p', 'ds-core', '--', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) {
    const tail = (r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    return {
      err: `cargo test -p ds-core -- --list failed (${r.error?.code ?? `exit ${r.status}`}) — ` +
        `a missing input is a FAILURE, never a skip. ${tail}`,
    }
  }
  const names = [...r.stdout.matchAll(/^(\S+): test$/gm)].map((m) => m[1])
  // Cargo's own arithmetic, as the parser's independent check: `N tests, M benchmarks`.
  //
  // MEASURED OVERLAP, stated because a check whose absence changes nothing is a
  // guard wearing a check's grade (R16). Sabotage E8 disabled this assertion AND
  // broke the name parser to match only `zone::`, and the tree still went RED —
  // the VANISHED check fired with `193 gone`. So this is NOT the only thing
  // standing between a broken parse and a green board.
  //
  // It is kept, and it is not a tautology, because it is the only assertion that
  // SEPARATES THE TWO CAUSES. Its message reads `7 parsed · 200 declared` — the
  // parser broke. VANISHED's reads `193 gone` — indistinguishable, on its face,
  // from someone deleting 193 tests. A scalar cannot settle which; two
  // differently-derived numbers can.
  const declared = [...r.stdout.matchAll(/^(\d+) tests?, \d+ benchmark/gm)].reduce((a, m) => a + Number(m[1]), 0)
  return { names, declared }
}

const jsDisk = jsRosterOnDisk()
const rustDisk = rustRosterOnDisk()

let pin = null
let pinErr = ''
try {
  pin = JSON.parse(read(ROSTER_PIN))
  if (!pin.js || !pin.rust || !Array.isArray(pin.updates)) { pin = null; pinErr = 'malformed: needs `js`, `rust` and `updates`' }
} catch (e) {
  pinErr = e.code === 'ENOENT' ? 'missing on disk' : `unparseable: ${e.message}`
}

// -- re-record, with attribution ---------------------------------------------
if (UPDATE_ROSTER) {
  if (!pin) {
    console.error(`REFUSED: ${rel(ROSTER_PIN)} ${pinErr}. --update-roster re-records an existing pin; it does not mint one.`)
    process.exit(1)
  }
  if (!ROSTER_WHY) {
    console.error(
      "REFUSED: --update-roster needs --why '<attribution>'.\n" +
        'A manifest anyone can regenerate on a whim is a count with extra steps. Name what moved:\n' +
        "  the fix, the ruling, or the retirement that added or removed each member.",
    )
    process.exit(1)
  }
  if (jsDisk.err || rustDisk.err) {
    console.error(`REFUSED: cannot re-record against a broken derivation.\n  ${jsDisk.err ?? ''}\n  ${rustDisk.err ?? ''}`)
    process.exit(1)
  }
  const apply = (side, disk) => {
    const cur = pin[side]
    const sorted = [...disk].sort()
    const added = sorted.filter((n) => !(n in cur))
    const removed = Object.keys(cur).filter((n) => !sorted.includes(n))
    // Existing members KEEP the reason they were pinned with. A re-record may
    // not launder an old member's provenance by restating a new one.
    pin[side] = Object.fromEntries(sorted.map((n) => [n, cur[n] ?? ROSTER_WHY]))
    return { added, removed }
  }
  const j = apply('js', jsDisk.names)
  const u = apply('rust', rustDisk.names)
  const moved = j.added.length + j.removed.length + u.added.length + u.removed.length
  if (moved === 0) {
    console.error('REFUSED: --update-roster with no difference. A no-op re-record that rewrites the provenance log is how the log becomes decoration.')
    process.exit(1)
  }
  pin.updates.push({
    when: new Date().toISOString().slice(0, 10),
    why: ROSTER_WHY,
    js: { added: j.added, removed: j.removed },
    rust: { added: u.added, removed: u.removed },
  })
  fs.writeFileSync(ROSTER_PIN, JSON.stringify(pin, null, 2) + '\n')
  // THE WRITE IS PROVED, NOT REPORTED. "A success message is not evidence that
  // anything changed" — gate-independence, the tooling-layer section. Re-read.
  const back = JSON.parse(read(ROSTER_PIN))
  for (const [side, d] of [['js', j], ['rust', u]]) {
    for (const n of d.added) if (!(n in back[side])) throw new Error(`write did not take: ${side}/${n} absent after write`)
    for (const n of d.removed) if (n in back[side]) throw new Error(`write did not take: ${side}/${n} still present after write`)
  }
  if (back.updates.length !== pin.updates.length) throw new Error('write did not take: updates[] not appended')
  console.log(`roster re-recorded — js +${j.added.length}/-${j.removed.length}, rust +${u.added.length}/-${u.removed.length}, verified by re-read`)
  for (const [side, d] of [['js', j], ['rust', u]]) {
    for (const n of d.added) console.log(`  + ${side}  ${n}`)
    for (const n of d.removed) console.log(`  - ${side}  ${n}`)
  }
  process.exit(0)
}

// -- reconcile, both directions, per roster ----------------------------------
console.log()
check(pin !== null, `the test-roster pin is present and well-formed: ${rel(ROSTER_PIN)}`, `${pinErr} — without it this section pins nothing at all`)
check(!jsDisk.err, "the JS roster derivation runs verify-all.sh's own glob pipeline", jsDisk.err)
check(!rustDisk.err, "the Rust roster derivation runs cargo's own test list", rustDisk.err)
// The roster is a claim that these populations are GRADED. That claim dies with
// the runner behind it, so the runner is re-checked here (the JS half is the
// extraction above; this is the Rust half).
// ANCHORED TO THE INVOCATION, NOT THE STRING. `includes('cargo test -p ds-core')`
// was the first version and it is the export-parity code-path-specificity defect
// verbatim: the E2 sabotage replaced the `run` line with a `skip` and left the
// two comment mentions of the same string, and this came back GREEN with nothing
// running the Rust suite at all. Found by the sabotage round, not by review.
check(
  fs.existsSync(VERIFY_ALL) && /^\s*run\s+"[^"]*"\s+cargo\s+test\s+-p\s+ds-core\s*$/m.test(read(VERIFY_ALL)),
  'verify-all.sh still RUNS the Rust suite this roster pins',
  'no `run "…" cargo test -p ds-core` line in the runner — a roster over a suite no runner runs pins ' +
    'a population that grades nothing. A comment mentioning the command does not count.',
)
if (rustDisk.names) {
  check(
    rustDisk.names.length === rustDisk.declared && rustDisk.declared > 0,
    `the Rust name parse agrees with cargo's own total (${rustDisk.names.length} parsed · ${rustDisk.declared} declared)`,
    'the `<name>: test` matcher and cargo\'s `N tests` summary disagree — the parser is dropping names, ' +
      'and a shrinking parse is indistinguishable from a shrinking suite',
  )
}

const nameList = (a) => a.slice(0, 12).join(' · ') + (a.length > 12 ? ` … +${a.length - 12} more` : '')

for (const [side, disk, label] of [
  ['js', jsDisk, 'JS test file'],
  ['rust', rustDisk, 'Rust test'],
]) {
  if (!pin || !disk.names) continue // already red above; a second red would be noise
  const pinned = Object.keys(pin[side])
  const got = new Set(disk.names)
  const want = new Set(pinned)
  const lost = pinned.filter((n) => !got.has(n))
  const gained = disk.names.filter((n) => !want.has(n))
  // NON-VACUITY, both sides. Strict equality over two empty sets is green, and
  // it is the one way this could pin nothing while reporting a clean board.
  check(pinned.length > 0, `the pin names ${label}s at all (${pinned.length} pinned)`, `pin.${side} is empty — an equality over nothing is green for the wrong reason`)
  check(disk.names.length > 0, `the ${label} derivation found members (${disk.names.length} on disk)`, 'the derivation returned nothing; it is not reaching the population')
  // BOTH DIRECTIONS, AS TWO CHECKS. One equality would report "the roster moved"
  // and make the reader do the diff — which is exactly what a count did. A
  // rename must read as one GONE and one NEW, never as net zero.
  check(
    lost.length === 0,
    `no pinned ${label} has VANISHED (${pinned.length} pinned)`,
    `${lost.length} gone: ${nameList(lost)}\n          ` +
      'recover it, or retire it deliberately: node scripts/gates/reconcile.mjs --update-roster --why "<why it went>". ' +
      'Never let it leave the population silently — that is F1.',
  )
  check(
    gained.length === 0,
    `no UNPINNED ${label} has appeared (${disk.names.length} on disk)`,
    `${gained.length} new: ${nameList(gained)}\n          ` +
      're-pin deliberately, having read what it asserts: node scripts/gates/reconcile.mjs --update-roster --why "<what it covers>"',
  )
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
// The census's own scope, printed rather than implied (R17's scoped-claim rule
// applies to positive coverage claims too).
console.log(
  `  asserting-file census (R12 amended): ${assertingAll.length} file(s) repo-wide that can fail a build — ` +
    `${population.length} gates, ` +
    `${assertingAll.filter((r) => liveGlobs.some((g) => g.covers(r))).length} globbed by a runner, ` +
    `${Object.keys(NOT_A_GRADER).length} producers/hand tools, ` +
    `${Object.keys(ASSERTING_ELSEWHERE).length} on a named board, 0 unclassified. ` +
    `Scope: *.mjs|js|ts|tsx|py|sh outside node_modules|target|dist|out|research|docs|reports and outside lib/|adapters/|fixtures/.`,
)
console.log(
  `  test rosters (F1), by NAME: ${Object.keys(pin?.js ?? {}).length} JS test file(s) and ` +
    `${Object.keys(pin?.rust ?? {}).length} Rust test(s) pinned in ${rel(ROSTER_PIN)}, ` +
    `both reconciled in both directions against the runner's own glob and cargo's own list. ` +
    `Scope: these two populations only — every other N/N on the battery is still a ratio ` +
    `whose denominator is discovered from the artifact it grades.`,
)
