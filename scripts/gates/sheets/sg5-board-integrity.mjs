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
/** `node scripts/drawing-set.test.mjs` — the sheet-content regression fixture. */
const BASELINE_DRAWING_SET = 252

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
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
