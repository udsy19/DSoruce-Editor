// SG5 — BOARD INTEGRITY.  The eleven deliverable-pack gates still pass, with the
// SAME NUMBER OF CHECKS as the baseline this mission opened on.
//
//   node scripts/gates/sheets/sg5-board-integrity.mjs
//
// WHY A COUNT AND NOT JUST A COLOUR.  A gate that silently stops asserting
// something still prints PASS. Both blind spots this project has found were
// invisible to a green board and visible in what the board was NOT counting, so
// a check that vanishes is a defect even when everything left over passes. The
// baseline below is the orchestrator's own run at `1a2b8d5` (reports/
// ORCHESTRATOR_LOG.md, "MISSION 2 — Baseline"), recorded before any sheet work
// began — an external anchor, not a number read back off today's board.
//
// The suite is invoked with its eleven ids named explicitly. The sheet gates are
// deliberately NOT part of `scripts/gates/run-all.sh`'s board while they are red
// by design, so there is no recursion: SG5 runs G1-G11, and nothing runs SG5.
//
// ---------------------------------------------------------------------------
// FAIL-FIRST — this gate is the one that must be GREEN at HEAD.
//
// Its falsification is the opposite of the other five: it fails if the sheet
// work moves something it must not move.
//
// THE RECORD THAT USED TO SIT HERE WAS STALE, IN BOTH ITS NUMBERS. It read
// `SG5 PASS (27 checks) … and drawing-set 252, all matching` while the constant
// below said 329 and the gate ran 29 checks — a FAIL-FIRST record describing a
// state two re-pins in the past. A stale record of a green run is worth less
// than none: it reads as evidence. Measured, not copied forward:
//
//   $ node scripts/gates/sheets/sg5-board-integrity.mjs      (i6, integration b9ec338)
//   SG5 FAIL (32 checks, 25 failing)
//
// **and 32/25 is not a regression — it is this worktree having no deliverable
// pack.** `out/` is empty, so all eleven gates produce no scoreboard line and
// 22 rows + integrity + board-green + GSELF fail for want of artifacts, not for
// want of correctness. The 7 checks that do not depend on the pack — the rules
// file, drawing-set's result and colour, and the four manifest checks below —
// all PASS. 29 -> 32 is this change: one count assertion retired, four manifest
// assertions added.
//
// A GREEN SG5 IS NOT CLAIMED HERE. Claiming one would need `out/` built first,
// and this round did not build it.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { statSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { REPO, runGate, GateError } from './lib/sheetlib.mjs'

/** The board at `1a2b8d5`: gate id → check count.
 *
 *  STILL COUNTS, AND THEREFORE STILL CARRYING THE WEAKNESS R23 CLOSED BELOW.
 *  The drawing-set pin became a manifest because its count was measured masking
 *  29 vanished checks. These eleven are the same shape of pin and nothing has
 *  measured them for the same defect — a gate that drops one assertion and adds
 *  another reports an unchanged number here exactly as drawing-set did.
 *
 *  Not converted in this round, deliberately and with the reason stated rather
 *  than left implicit: a manifest needs the members to be NAMED at their call
 *  sites, drawing-set's naming was a 14-site change in one file, and eleven
 *  gates is a different size of job. Recorded as open, not as done. */
const BASELINE = {
  G1: 59,
  G2: 17,
  G3: 92,
  G4: 18,
  G5: 70,
  G6: 53,
  G7: 19,
  G8: 9,
  G9: 24,
  G10: 14,
  G11: 56,
}
/** The closing integrity pass's own count, printed as `PASS  (12 checks)`. */
const BASELINE_INTEGRITY = 12
/** THE PIN IS A MANIFEST OF NAMED MEMBERS, NOT A COUNT (R23).
 *
 *  `BASELINE_DRAWING_SET = 329` used to live here, with a comment decomposing
 *  how the number got there. Both are RETIRED — the constant loses its name
 *  (`trace_floor_polygon` standard, no shadows) because a manifest subsumes it:
 *  if the named sets are equal their sizes are equal, so keeping a count check
 *  beside it would be one witness with two places to be wrong (R16 tautology).
 *
 *  WHY THE COUNT HAD TO GO. A count is a scalar over a set. It cannot separate a
 *  check that VANISHED from a check that ARRIVED somewhere else, and this pin
 *  was not merely theoretically vulnerable to that — it was the live case.
 *  Re-derived by name over the bisect window `46908c6..49502e5`:
 *
 *    * the ledger's bisect TABLE is confirmed on all six rows (322 · 353 · 334 ·
 *      328 · 327 · 339), and `drawing-set.test.mjs` is byte-identical at all
 *      seven commits — so every movement came from the system under test;
 *    * its ARITHMETIC is not. "26 lost in three events" summed NET deltas. By
 *      name it is 19 + 7 + 1 = **27** across those three steps (the middle one
 *      is 7 lost against 1 added), plus a **fourth event the ledger reports as a
 *      clean +12** which is 14 added against 2 lost. **29 checks vanished**;
 *    * the assertion `drawing-set.test.mjs passes` was FALSE for **64 commits** —
 *      the fixture went red at `a6c37f5`, one commit BEFORE the ground ruling —
 *      and the count assertion was wrong for all 73, the pin reading 283 where
 *      `46908c6` already ran 322;
 *    * the retired comment's `+56` leg decomposed growth inside a window it
 *      inferred. The legs inside that window sum to **+17**; the other **+39
 *      arrived before the window SG5 itself named**.
 *
 *  Every one of the 29 is disposed — RECOVERED or RETIRED WITH ATTRIBUTION, none
 *  silently dropped — in the pin file's `the_29_losses_disposed` block. The
 *  sharpest case for a manifest is in there: four of the losses are CONDITIONAL
 *  checks (a leader is only asserted for a label displaced off its room) that
 *  vanished because the labels reattached. A check deleted by an editor and a
 *  check the product stopped needing subtract identically from a scalar. Only a
 *  manifest says which. */
const MANIFEST_PIN = path.join(REPO, 'scripts/fixtures/drawing-set.manifest.json')

function run(cmd, args, env) {
  try {
    return execFileSync(cmd, args, {
      cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    })
  } catch (err) {
    // A red board still prints a scoreboard; keep it and let the checks speak.
    if (err.stdout != null) return err.stdout + (err.stderr ?? '')
    throw new GateError(`${cmd} ${args.join(' ')} did not run: ${err.message}`)
  }
}

async function main() {
  return runGate('SG5', (c) => {
    const board = run('bash', [path.join(REPO, 'scripts/gates/run-all.sh'), ...Object.keys(BASELINE)])

    for (const [id, want] of Object.entries(BASELINE)) {
      const m = board.match(new RegExp(`^\\s*${id}\\s+\\S.*?(PASS|FAIL)\\s*\\((\\d+) checks?`, 'm'))
      if (!m) {
        c.ok(`${id} is on the board`, false, 'no scoreboard line — the gate produced nothing')
        c.ok(`${id} check count is ${want}`, false, 'no scoreboard line')
        continue
      }
      c.ok(`${id} passes`, m[1] === 'PASS', `board says ${m[1]}`)
      c.ok(
        `${id} still runs ${want} checks`,
        Number(m[2]) === want,
        `${m[2]} checks now, ${want} at the 1a2b8d5 baseline — a check that appeared or vanished is a defect either way`,
      )
    }

    const integ = board.match(/unchanged since G10 produced it; PASS\s*\((\d+) checks?\)/)
    c.ok(
      `the closing integrity pass still runs ${BASELINE_INTEGRITY} checks`,
      integ != null && Number(integ[1]) === BASELINE_INTEGRITY,
      integ ? `${integ[1]} checks` : 'no integrity line on the board',
    )
    c.ok('the board is green', /ALL GATES GREEN\./.test(board), board.split('\n').filter((l) => /^FAIL/.test(l)).join(' | '))

    // ---- the law itself is load-bearing ------------------------------------
    // `.claude/rules/gate-independence.md` is not documentation: it is input to
    // every future mission, and five of this program's defects were instances of
    // the classes it records. It existed on ONE branch — abandoning that branch
    // would have lost it, and nothing watched for that. Anything the program
    // depends on but nothing checks is the pattern this suite keeps fixing.
    const RULES = '.claude/rules/gate-independence.md'
    let rulesBytes = -1
    try { rulesBytes = statSync(path.join(REPO, RULES)).size } catch { /* absent */ }
    c.ok(`${RULES} is present and non-empty`, rulesBytes > 0,
      rulesBytes < 0 ? 'missing — the accumulated law of this program is gone' : 'zero bytes')

    // ---- the runner is itself a system under test --------------------------
    // A grading system whose summary can disagree with its own rows is the
    // meta-instance of every defect this suite exists to catch. It shipped:
    // while G12 was being wired the board printed "12/12 passing" directly above
    // "G12 FAIL", because FAILED incremented on the exit code alone — a status
    // supplied by the very thing being summarised.
    // GSELF exits 0 while printing FAIL. Proving the runner catches it every run
    // beats reasoning that it does.
    const liar = run('bash', [path.join(REPO, 'scripts/gates/run-all.sh'), 'GSELF'],
      { GATE_SELFTEST: '1' })
    c.ok(
      'the runner reports a gate that exits 0 while printing FAIL as RED',
      /GSELF\s+Runner self-test\s+FAIL/.test(liar) && /\b0\/1 passing\b/.test(liar),
      liar.split('\n').filter((l) => /GSELF|passing/.test(l)).join(' | ') || 'no GSELF line',
    )

    // The manifest is written by the run itself, to a path this gate chooses in
    // a fresh temp dir — so a stale file from an earlier run can never be read
    // as this run's coverage.
    const mfDir = mkdtempSync(path.join(tmpdir(), 'sg5-manifest-'))
    const mfPath = path.join(mfDir, 'drawing-set.manifest.txt')
    const ds = run('node', [path.join(REPO, 'scripts/drawing-set.test.mjs'), '--manifest', mfPath])
    const m = ds.match(/drawing-set (PASS|FAIL) \((\d+) checks?\)/)
    c.ok('drawing-set.test.mjs reports a result', m != null, ds.trim().split('\n').slice(-1)[0])
    if (m) c.ok('drawing-set.test.mjs passes', m[1] === 'PASS', `it says ${m[1]}`)

    // ---- the pin, as a MANIFEST (R23) --------------------------------------
    // A MISSING SUBJECT IS A FAILURE, NEVER A SKIP — on either side. If the pin
    // file is gone, or the run wrote no manifest, that is red and said out loud;
    // `if (!x) return` would hand the producer a veto over its own test.
    let pinned = null
    try { pinned = JSON.parse(readFileSync(MANIFEST_PIN, 'utf8')).checks } catch { /* absent */ }
    c.ok(
      'the drawing-set check manifest pin is present and non-empty',
      Array.isArray(pinned) && pinned.length > 0,
      `${path.relative(REPO, MANIFEST_PIN)} is missing or malformed — without it this gate ` +
        'is pinning nothing at all',
    )
    let observed = null
    try { observed = readFileSync(mfPath, 'utf8').split('\n').filter(Boolean) } catch { /* absent */ }
    c.ok(
      'the run wrote its check manifest',
      Array.isArray(observed) && observed.length > 0,
      'no manifest at the path this gate handed the run — it cannot report which checks ran',
    )
    rmSync(mfDir, { recursive: true, force: true })

    if (Array.isArray(pinned) && Array.isArray(observed)) {
      const want = new Set(pinned)
      const got = new Set(observed)
      const lost = pinned.filter((n) => !got.has(n))
      const gained = observed.filter((n) => !want.has(n))
      // BOTH DIRECTIONS, AS SEPARATE CHECKS. A vanished check is coverage
      // silently left; an unexpected one is coverage arrived unexamined. Folding
      // them into a single equality would report "the manifest moved" and make
      // the reader do the diff — which is what the count did.
      c.ok(
        `no pinned drawing-set check has VANISHED (${pinned.length} pinned)`,
        lost.length === 0,
        `${lost.length} gone: ${lost.slice(0, 8).join(' · ')}${lost.length > 8 ? ` … +${lost.length - 8}` : ''}` +
          ' — recover it, or retire it with attribution in the pin file. Never drop it silently.',
      )
      c.ok(
        'no UNPINNED drawing-set check has appeared',
        gained.length === 0,
        `${gained.length} new: ${gained.slice(0, 8).join(' · ')}${gained.length > 8 ? ` … +${gained.length - 8}` : ''}` +
          ' — re-pin deliberately, having looked at what it asserts.',
      )
      // The count is NOT re-asserted: equal named sets have equal sizes, so a
      // count check here would be true by construction — a tautology, and R16
      // says delete it rather than let it inflate the check total.
    }
  })
}

process.exit((await main()) ? 0 : 1)
