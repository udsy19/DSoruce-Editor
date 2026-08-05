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
// FAIL-FIRST — this gate is the one that must be GREEN at HEAD, and is:
//
//   $ node scripts/gates/sheets/sg5-board-integrity.mjs
//   SG5 PASS (27 checks)
//   … G1 59 · G2 17 · G3 92 · G4 18 · G5 70 · G6 53 · G7 19 · G8 9 · G9 24 ·
//     G10 14 · G11 56 (+12 integrity) and drawing-set 252, all matching
//
// Its falsification is the opposite of the other five: it fails if the sheet
// work moves a number it must not move.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { REPO, runGate, GateError } from './lib/sheetlib.mjs'

/** The board at `1a2b8d5`: gate id → check count. */
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
/** `node scripts/drawing-set.test.mjs` — the sheet-content regression fixture.
 *
 *  252 at `1a2b8d5` → **283**. Raised deliberately, with the delta measured
 *  rather than inferred (`reports/sheets-S5-1.md` §5), because SG5's contract is
 *  that an *unexplained* change in coverage is a defect — not that coverage may
 *  never grow:
 *    +18  the checking layer. S7 made drawing-set failures RECORDED rather than
 *         thrown, so the dwg case is graded again; at 1a2b8d5 it was never
 *         rendered at all after the first throw. Measured by scoring the current
 *         test against a reconstructed pre-mission product: 270.
 *    +13  the product. The 12th sheet (A.10, the paginated schedule) plus dwg's
 *         now-distinct room names.
 *  A DECREASE remains a defect: a silently vanished check reports a passing
 *  number that means less than it did. Keep the strict equality. */
const BASELINE_DRAWING_SET = 283

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

    const ds = run('node', [path.join(REPO, 'scripts/drawing-set.test.mjs')])
    const m = ds.match(/drawing-set (PASS|FAIL) \((\d+) checks?\)/)
    c.ok('drawing-set.test.mjs reports a result', m != null, ds.trim().split('\n').slice(-1)[0])
    if (m) {
      c.ok('drawing-set.test.mjs passes', m[1] === 'PASS', `it says ${m[1]}`)
      c.ok(
        `drawing-set.test.mjs still runs ${BASELINE_DRAWING_SET} checks`,
        Number(m[2]) === BASELINE_DRAWING_SET,
        `${m[2]} checks now, ${BASELINE_DRAWING_SET} at the baseline`,
      )
    }
  })
}

process.exit((await main()) ? 0 : 1)
