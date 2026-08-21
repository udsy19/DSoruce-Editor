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
// Measured, not copied forward (W2, leftovers loop, 2026-08-20, this tree):
//
//   $ GATE_BASE=http://localhost:5312 bash scripts/gates/run-all.sh G1..G11
//   11/11 passing · ALL GATES GREEN.        (pack built fresh in THIS worktree)
//   $ GATE_BASE=http://localhost:5312 node scripts/gates/sheets/sg5-board-integrity.mjs
//   SG5 PASS (67 checks)
//
// 32 -> 67 is this change: the eleven count pins each gained an identity-
// manifest trio (pinned-file-is-invoked-file, no-vanished, no-unpinned = 33)
// plus the pin-file presence + coverage pair (2). The G-board manifest was
// captured from that green run's tree (`--capture-g-manifest`), i.e. from a
// population explicitly verified clean, immediately after the board above.
//
// The closing sabotage pair was registered before being run, then RUN AND
// MEASURED, in scratch worktrees off d868ec3 (never in the real tree), each
// with its own server on the tree it graded:
//   * SWAP (g8, one check replaced by a different assertion, runtime count flat
//     at 9): OLD SG5 (d868ec3) `SG5 PASS (32 checks)` — the recorded standing
//     weakness, demonstrated — NEW SG5 `FAIL (67 checks, 2 failing)`, naming
//     the swapped check in both directions and nothing else.
//   * VANISH (g5, one once-executing check removed, count padded flat with a
//     verbatim duplicate of an already-pinned check): OLD `PASS (32)`, NEW
//     `FAIL (67, 2 failing)` naming the vanished check AND the duplicate
//     surplus — multiset, not set.
// Transcripts: reports/editor-completion/w2-sg5-identity-manifests.md.
// ---------------------------------------------------------------------------

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { REPO, runGate, GateError } from './lib/sheetlib.mjs'

/** The board at `1a2b8d5`: gate id → check count.
 *
 *  COUNTS, KEPT — but no longer the only pin. The R23 weakness these carried
 *  (a count stays flat while checks swap identity, exactly as drawing-set's
 *  count masked 29 vanished checks) is closed by the G-BOARD IDENTITY MANIFEST
 *  below (`scripts/fixtures/g-board.manifest.json`): every `g.check(...)` call
 *  site in the eleven gate files is pinned BY NAME. The counts stay because
 *  the two pins watch different populations — the manifest pins call sites in
 *  the SOURCE, the counts pin EXECUTIONS at runtime — and a data-driven loop
 *  that iterates fewer rows moves the count without touching any call site.
 *  A manifest plus a count is strictly stronger than either. */
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
  // 56 → 58 at integration-2 (editor-completion-2): G11's emission loop runs
  // one equality check per distinct (room, item) pair in the seeded document,
  // and the W4 generator's regrown demo doc carries 32 pairs where the
  // 1a2b8d5 document carried 30 — measured with the gate's OWN zone_at /
  // item_description over core_state('seeded') in both trees (net +2; zone ids
  // renumber, the multiset re-derivation is in
  // reports/editor-completion/integration-2-reconcile.md). Document-driven
  // growth in a data-driven loop with the call-site manifest unchanged is the
  // exact case this count exists to be read alongside the manifest for; the
  // manifest held, so the pin moves WITH its attribution, never silently.
  G11: 58,
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

/** THE ELEVEN G-BOARD PINS, AS MANIFESTS (closing the R23 residue).
 *
 *  WHY SOURCE CALL SITES AND NOT EMITTED CHECK LINES. G1-G11 do not emit
 *  per-check identity on a green run — `Gate.check(cond, msg)` (both
 *  lib/gatelib.py and lib/gatelib.mjs) surfaces `msg` only on FAILURE, and
 *  `finish()` prints one scoreboard line. So on the board this gate watches,
 *  runtime check identity is structurally unparseable, for all eleven gates
 *  alike, and editing the gates to emit it is outside this gate's remit. What
 *  IS parseable without touching them: the `g.check(...)` CALL SITES in each
 *  gate's source bytes. The identity pinned per site is the whitespace-
 *  normalized source text of the msg argument — the same string the gate would
 *  print on failure, before interpolation — which changes exactly when someone
 *  edits what the check asserts or says.
 *
 *  Re-derived from the gate source bytes on every run (never from any gate's
 *  output), compared to the pin as a MULTISET in both directions: a vanished
 *  site is coverage silently left, an unexpected one is coverage arrived
 *  unexamined, and a duplicated one is a compensation trick (padding the count
 *  with a repeat of an existing check) — the multiset names all three.
 *
 *  Stated limitation, on the record: a swap of WHICH FILE run-all.sh invokes
 *  for a gate id would dodge a source pin keyed on the pinned file path; the
 *  runtime count + board-green checks still watch that surface.
 *
 *  Re-pin deliberately (after looking at what changed) with:
 *    node scripts/gates/sheets/sg5-board-integrity.mjs --capture-g-manifest
 */
const G_MANIFEST_PIN = path.join(REPO, 'scripts/fixtures/g-board.manifest.json')

/** gate id → source file, mirroring run-all.sh's CMDS for G1-G11. */
const GATE_FILES = {
  G1: 'scripts/gates/g1-sheet-structure.py',
  G2: 'scripts/gates/g2-formula-liveness.py',
  G3: 'scripts/gates/g3-quantity-truth.py',
  G4: 'scripts/gates/g4-plan-graphic.py',
  G5: 'scripts/gates/g5-thumbnails.py',
  G6: 'scripts/gates/g6-renders.py',
  G7: 'scripts/gates/g7-video.py',
  G8: 'scripts/gates/g8-web-viewer.mjs',
  G9: 'scripts/gates/g9-roundtrip.py',
  G10: 'scripts/gates/g10-one-action.mjs',
  G11: 'scripts/gates/g11-furniture-agreement.py',
}

// Exact extraction for the python gates: ast finds every `<x>.check(...)` call
// and returns the msg argument's source segment, whitespace-normalized, in
// line order. Passed to `python3 -c`, so it ships inside this file — SG5 owns
// its own instrument.
const PY_SITES = `
import ast, json, re, sys
src = open(sys.argv[1]).read()
out = []
for node in ast.walk(ast.parse(src)):
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'check'):
        msg = node.args[1] if len(node.args) >= 2 else next(
            (k.value for k in node.keywords if k.arg == 'msg'), None)
        seg = ast.get_source_segment(src, msg if msg is not None else node) or ''
        out.append((node.lineno, re.sub(r'\\s+', ' ', seg).strip()))
print(json.dumps([s for _, s in sorted(out, key=lambda t: t[0])]))
`

/** Extraction for the two .mjs gates: a single-pass scanner that understands
 *  strings, template literals (with nested \${}), comments and (heuristically)
 *  regex literals, so a `.check(` inside any of those never counts and parens
 *  inside them never unbalance the argument scan. Identity = the source text
 *  after the first top-level comma of the argument list (the msg expression),
 *  whitespace-normalized. */
function jsCheckSites(src) {
  const sites = []
  let i = 0
  const n = src.length
  let lastSig = ''
  function skipQuoted(q) { // src[i] === q; also used for whole template literals
    i++
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue }
      if (src[i] === q) { i++; return }
      i++
    }
  }
  function scanArgs(start) { // src[start] === '('
    let depth = 0
    let j = start
    let firstComma = -1
    let last = ''
    while (j < n) {
      const c = src[j]
      if (c === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue }
      if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2); j = j < 0 ? n : j + 2; continue }
      if (c === "'" || c === '"') {
        j++
        while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === c) { j++; break } else j++ }
        last = c; continue
      }
      if (c === '`') {
        j++
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '`') { j++; break }
          if (src[j] === '$' && src[j + 1] === '{') {
            let d = 1; j += 2
            while (j < n && d > 0) {
              if (src[j] === '\\') { j += 2; continue }
              if (src[j] === "'" || src[j] === '"') { const q = src[j]; j++; while (j < n) { if (src[j] === '\\') j += 2; else if (src[j] === q) { j++; break } else j++ } continue }
              if (src[j] === '`') { let dd = 1; j++; while (j < n && dd > 0) { if (src[j] === '\\') j += 2; else if (src[j] === '`') { dd--; j++ } else j++ } continue }
              if (src[j] === '{') d++
              else if (src[j] === '}') d--
              j++
            }
            continue
          }
          j++
        }
        last = '`'; continue
      }
      if (c === '/' && !/[\w$)\]]/.test(last)) { // regex literal
        const k = j
        j++
        let inClass = false
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue }
          if (src[j] === '[') inClass = true
          else if (src[j] === ']') inClass = false
          else if (src[j] === '/' && !inClass) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; break }
          else if (src[j] === '\n') { j = k + 1; break } // was division after all
          j++
        }
        last = '/'; continue
      }
      if (c === '(') { depth++; j++; last = '('; continue }
      if (c === ')') {
        depth--
        if (depth === 0) return { end: j + 1, firstComma }
        j++; last = ')'; continue
      }
      if (c === ',' && depth === 1 && firstComma < 0) firstComma = j
      if (!/\s/.test(c)) last = c
      j++
    }
    return null
  }
  const head = /([A-Za-z_$][\w$]*)\s*\.\s*check\s*\(/g
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue }
    if (c === "'" || c === '"' || c === '`') { skipQuoted(c); lastSig = c; continue }
    if (c === '/' && !/[\w$)\]]/.test(lastSig)) {
      const k = i
      i++
      let inClass = false
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) { i++; while (i < n && /[a-z]/i.test(src[i])) i++; break }
        else if (src[i] === '\n') { i = k + 1; break }
        i++
      }
      lastSig = '/'; continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      head.lastIndex = i
      const m = head.exec(src)
      if (m && m.index === i) {
        const open = i + m[0].length - 1
        const r = scanArgs(open)
        if (r) {
          const msg = r.firstComma >= 0 ? src.slice(r.firstComma + 1, r.end - 1) : src.slice(open + 1, r.end - 1)
          sites.push(msg.replace(/\s+/g, ' ').trim())
          i = r.end
          lastSig = ')'
          continue
        }
      }
      while (i < n && /[\w$]/.test(src[i])) i++
      lastSig = src[i - 1]
      continue
    }
    if (!/\s/.test(c)) lastSig = c
    i++
  }
  return sites
}

/** Re-derive the current check-site identities for one gate file. */
function gateCheckSites(relFile) {
  const abs = path.join(REPO, relFile)
  if (relFile.endsWith('.py')) {
    return JSON.parse(execFileSync('python3', ['-c', PY_SITES, abs], { encoding: 'utf8' }))
  }
  return jsCheckSites(readFileSync(abs, 'utf8'))
}

/** Multiset difference in both directions. */
function multisetDiff(pinned, got) {
  const bag = new Map()
  for (const s of pinned) bag.set(s, (bag.get(s) || 0) + 1)
  const gained = []
  for (const s of got) {
    const c = bag.get(s) || 0
    if (c > 0) bag.set(s, c - 1)
    else gained.push(s)
  }
  const lost = []
  for (const [s, c] of bag) for (let k = 0; k < c; k++) lost.push(s)
  return { lost, gained }
}

const clip = (s, w = 72) => (s.length > w ? s.slice(0, w - 1) + '…' : s)
const nameList = (arr) =>
  arr.slice(0, 4).map((s) => clip(s)).join(' · ') + (arr.length > 4 ? ` … +${arr.length - 4}` : '')

// Deliberate re-pin: write the fixture from the CURRENT gate sources. Only for
// a tree whose boards are verified green — the provenance block says so, and
// the person running this is asserting it.
if (process.argv.includes('--capture-g-manifest')) {
  let head = 'unknown'
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() } catch { /* keep 'unknown' */ }
  const gates = {}
  for (const [id, file] of Object.entries(GATE_FILES)) {
    gates[id] = { file, checkSites: gateCheckSites(file) }
  }
  const fixture = {
    provenance: {
      capturedAt: new Date().toISOString(),
      commit: head,
      claim:
        'Captured from a boards-green tree (G1-G11 board PASS on artifacts built via the ' +
        'sanctioned path in this worktree) — a population explicitly verified clean, per ' +
        '.claude/rules/gate-independence.md. Re-capture ONLY from a green board, and only ' +
        'after reading what changed.',
      method:
        'Static extraction of every Gate.check(...) call site in the eleven gate files: ' +
        'python via ast (msg argument source segment), .mjs via the string/template/regex-aware ' +
        'scanner in sg5-board-integrity.mjs. Identity = whitespace-normalized msg-argument ' +
        'source text; compared as a MULTISET, both directions. Runtime check identities are ' +
        'not emitted on a green run (gatelib surfaces msg only on failure), which is why the ' +
        'pin is on source call sites.',
    },
    gates,
  }
  writeFileSync(G_MANIFEST_PIN, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${path.relative(REPO, G_MANIFEST_PIN)}: ` +
    Object.entries(gates).map(([id, g]) => `${id}=${g.checkSites.length}`).join(' '))
  process.exit(0)
}

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

    // ---- the eleven pins, as IDENTITY MANIFESTS ----------------------------
    // A MISSING SUBJECT IS A FAILURE, NEVER A SKIP: a gone pin file, a gate id
    // absent from it, or an extraction error is red and named, because each of
    // those hands somebody a veto over this test.
    let gpin = null
    try { gpin = JSON.parse(readFileSync(G_MANIFEST_PIN, 'utf8')).gates } catch { /* absent */ }
    c.ok(
      'the G-board check-site manifest pin is present and non-empty',
      gpin != null && Object.keys(gpin).length > 0,
      `${path.relative(REPO, G_MANIFEST_PIN)} is missing or malformed — without it the eleven ` +
        'gates are pinned by count alone, the exact weakness this manifest closes',
    )
    c.ok(
      'the manifest pins exactly the eleven baseline gates',
      gpin != null &&
        JSON.stringify(Object.keys(gpin).sort()) === JSON.stringify(Object.keys(BASELINE).sort()),
      gpin ? `pinned: ${Object.keys(gpin).sort().join(' ')}` : 'no pin file',
    )
    for (const id of Object.keys(BASELINE)) {
      const entry = gpin?.[id]
      if (!entry || !Array.isArray(entry.checkSites) || !entry.file) {
        c.ok(`${id}: check identities match the manifest pin`, false,
          `${id} has no well-formed entry in the pin file`)
        continue
      }
      c.ok(
        `${id}: the pinned file is the file run-all.sh invokes`,
        entry.file === GATE_FILES[id],
        `pin says ${entry.file}, the board runs ${GATE_FILES[id]} — a pin on the wrong file pins nothing`,
      )
      let got = null
      let err = ''
      try { got = gateCheckSites(entry.file) } catch (e) { err = String(e?.message || e).slice(0, 160) }
      if (!Array.isArray(got)) {
        c.ok(`${id}: check identities match the manifest pin`, false,
          `could not extract check sites from ${entry.file}: ${err}`)
        continue
      }
      const { lost, gained } = multisetDiff(entry.checkSites, got)
      c.ok(
        `${id}: no pinned check has VANISHED (${entry.checkSites.length} sites pinned)`,
        lost.length === 0,
        `${lost.length} gone: ${nameList(lost)} — recover it, or re-pin deliberately with ` +
          '--capture-g-manifest after reading what changed. Never drop it silently.',
      )
      c.ok(
        `${id}: no UNPINNED check has appeared`,
        gained.length === 0,
        `${gained.length} new: ${nameList(gained)} — re-pin deliberately, having looked at what it asserts.`,
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
