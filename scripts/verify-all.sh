#!/usr/bin/env bash
# THE standard verification battery, aggregated by EXIT CODE.
#
#   bash scripts/verify-all.sh              # staged-aware: Rust suite only if Rust changed
#   bash scripts/verify-all.sh --full       # always run everything
#
# A skipped step is COUNTED and NAMED — whether THIS FILE declined to run it
# (`skip()`) or the step itself ran and measured nothing (`run()`'s skip
# detection). Quote a floor number only from `--full`; `48/49, 1 skipped` is not
# the same measurement as `49/49`.
#   VERIFY_SELFTEST=1 bash scripts/verify-all.sh   # append the lying fixtures
#
# WHY THIS EXISTS. Twice in one working session a commit landed on a red signal —
# once a red style gate, once a red Rust suite. Same cause both times: the
# verification was a shell pipeline ending in `grep "test result"` or `&& echo
# OK`, and the DECIDING ACT was a human reading a summary line. Both were
# self-caught, and "I will read more carefully next time" is a promise from the
# faculty that just failed.
#
# So the reading is removed from the loop. Every step's exit code is captured,
# the scoreboard is derived from those codes, and the script exits non-zero if
# any step failed. A pre-commit hook (`.githooks/pre-commit`) refuses the commit
# on that exit code, so no summary line is ever the deciding act again.
#
# This follows the same promotion the empty-file assertion and the build-identity
# probe followed: a vigilance failure becomes harness.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.cargo/bin:$PATH"

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

declare -a NAMES=() CODES=() SKIPPED=()

# A STEP THAT EXITS 0 WITHOUT MEASURING IS NOT GREEN.
#
# The `skip()` facility below fixed R8 for the steps THIS FILE decides not to
# run. It could not see the other half: a step that runs, discovers its subject
# is absent, prints a skip notice and exits 0. `run()` captured its stdout and
# printed it only on failure, so the notice never reached the log, `SKIPPED[]`
# stayed empty, and the board printed a silent `62/62`.
#
# MEASURED at 1e12952: `supabase/tests/rls.test.mjs` — the ONLY instrument for
# the entire RLS authorization model, 50 checks with a database — printed
# `SKIP: no reachable Postgres`, exited 0, and was tallied ✓. The comment beside
# its `run` line said "It prints SKIP; read it", and the runner it lived in
# discarded the string. It has never graded a commit on this machine.
#
# So the reading is removed from this loop too. Two detectors, because neither
# alone is sufficient:
#
#   EXIT 77 — the canonical protocol going forward (autotools' skip code). A
#             step that cannot measure exits 77. Unambiguous, not text.
#   A DECLARED SKIP ON STDOUT — an exit-0 step whose own output opens a line
#             with uppercase `SKIP`. This is the existing repo convention (12
#             sites print `SKIP: <reason>`), so codifying it converts every one
#             of them without editing a single test file — which is the point:
#             a fix that named rls.test.mjs would re-create the class one file
#             over. Lowercase `(skipped …)` is deliberately NOT matched: those
#             four sites drop SOME checks and still measure, and a partial skip
#             is degraded coverage, not an unmeasured step.
#
# WHAT THIS CANNOT SEE, STATED RATHER THAN BURIED. A step that skips silently —
# exit 0, no marker — still counts green. The detector is fed by the step's own
# declaration, so the step chooses whether to declare; what it can no longer
# choose is whether a declaration is COUNTED. Closing the residue means every
# step reporting a check count the runner can floor, which is a change to all 62
# steps, not to this one. Named here so it is a known hole, not an assumed one.
#
# THE CENSUS behind those numbers, re-derived rather than quoted: every
# `process.exit(0)` outside node_modules, classified by hand. TWELVE are
# whole-step skips that print `SKIP:` and are now caught — 11 under `web/src`
# (8 guarding `web/src/wasm`, 2 guarding `dwg2dxf`, 1 guarding `bench/fixtures`)
# plus `supabase/tests/rls.test.mjs`. Four more notices are lowercase PARTIAL
# skips (`dwgJson`, `dwgVerify`, `zipEntry` ×2) which still measure and are
# deliberately left green. The rest are success exits or flag-gated CLI modes
# (`area-census --list`, `reconcile --update-roster`), and the battery passes no
# flags, so none of them can fire from here.
#
# R10 AXES: channel (exit 77 and an exit-0 declaration are separate detectors,
# so VSKIP77 and VSKIP0 below are separate fixtures) · bookkeeping (a detected
# skip must leave the numerator AND stay in the denominator) · anchoring
# (lowercase partial-skip notices must NOT be swallowed as whole-step skips).
readonly EXIT_SKIP=77

# The step's own skip declaration, verbatim, or empty if it made none.
skip_declaration() {
  printf '%s\n' "$1" | grep -m1 -E '^[[:space:]]*SKIP(PED)?([^[:alpha:]]|$)' | sed 's/^[[:space:]]*//'
  return 0
}

run() {                       # run <name> <command...>
  local name="$1"; shift
  local out rc reason
  out="$("$@" 2>&1)"; rc=$?
  reason=""
  if [ $rc -eq $EXIT_SKIP ]; then
    reason="$(skip_declaration "$out")"
    [ -z "$reason" ] && reason="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)"
    [ -z "$reason" ] && reason="exited $EXIT_SKIP and said nothing"
  elif [ $rc -eq 0 ]; then
    reason="$(skip_declaration "$out")"
  fi
  if [ -n "$reason" ]; then
    skip "$name" "$reason"
    return 0
  fi
  NAMES+=("$name"); CODES+=("$rc")
  if [ $rc -ne 0 ]; then
    printf '\033[1;31m  ✗ %s\033[0m (exit %d)\n' "$name" "$rc"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
  else
    printf '\033[1;32m  ✓ %s\033[0m\n' "$name"
  fi
}

# A SKIPPED STEP IS A DECLARED STEP THAT DID NOT RUN — it stays in the
# denominator and it is named in the summary. It is NOT absent.
#
# WHY. The Rust suite is step 49, and it was skipped on every clean tree — which
# is the state of every post-commit floor measurement. `total` was `${#NAMES[@]}`,
# the count of steps that RAN, so the skipped step did not lower the numerator:
# it left the population. Measured on the branch base (956125e, clean tree):
#
#     bash scripts/verify-all.sh           ->  VERIFY OK — 48/48 steps green
#     bash scripts/verify-all.sh --full    ->  VERIFY OK — 49/49 steps green
#
# Both print OK, neither says a step was dropped, and the ledger's recorded floor
# ("battery 49/49") is not comparable to either without knowing which invocation
# produced it. That is R8 — the summary was derived from the rows, but the rows
# were the wrong population — and it is the same shape as the SUBJECT EXISTENCE
# axis stated ~30 lines below: a missing subject is a FAILURE, not a skip. This
# file named the rule and then broke it one screen up.
skip() {                      # skip <name> <reason>
  SKIPPED+=("$1 — $2")
  printf '\033[1;33m  · %s — SKIPPED\033[0m (%s)\n' "$1" "$2"
}

# Rust changes are the only reason to pay for the Rust suite.
#
# Widened from `crates` alone, and from staged-XOR-worktree to staged-OR-worktree.
# The old predicate had two holes: Rust behaviour also moves with the workspace
# manifests (a dependency bump changes no file under `crates/`), and the
# staged/worktree branch was exclusive — with ANY file staged, unstaged Rust edits
# took the `--cached` arm and reported untouched. Both holes end in the same
# place: the suite skipped on a change that could break it.
rust_touched() {
  [ $FULL -eq 1 ] && return 0
  ! git diff --quiet -- crates Cargo.toml Cargo.lock 2>/dev/null && return 0
  ! git diff --cached --quiet -- crates Cargo.toml Cargo.lock 2>/dev/null && return 0
  return 1
}

echo "verification battery"
if rust_touched; then
  run "cargo test -p ds-core" cargo test -p ds-core
else
  skip "cargo test -p ds-core" "no Rust in this change; --full to force"
fi
run "tsc --noEmit" bash -c 'cd web && pnpm typecheck'
while IFS= read -r t; do
  run "node ${t#web/src/}" node "$t"
done < <(cd web && find src -name '*.test.mjs' | sed 's|^|web/|' | sort)

# The glob above only reaches `web/src`. These three assert on the SERVER and
# DATABASE halves — the API guard, the billing arithmetic, and the RLS policies —
# and were invisible to it, which `scripts/gates/reconcile.mjs` correctly called
# out: an asserting file nobody runs has never graded a commit. They run from
# `web/` because that is where their esbuild/vite dependency resolves from.
#
# rls.test.mjs needs a reachable Postgres and SKIPs cleanly (exit 0) without one,
# so a machine with no database does not turn the battery red for the wrong
# reason — but a skip is not a pass. It used to say "It prints SKIP; read it",
# and the runner it said that in threw the string away; `run()` now detects the
# declaration and the summary NAMES the step. Supply a database
# (`PGHOST`/`PGPORT`/`PGUSER`) and the row goes green with 50 checks; without
# one it is a named skip, and the whole authorization model is unmeasured.
run "node deploy/apiCore.test.mjs (API guard + LLM gateway)" \
  bash -c 'cd web && node ../deploy/apiCore.test.mjs'
run "node deploy/llmPricing.test.mjs (billing arithmetic)" \
  bash -c 'cd web && node ../deploy/llmPricing.test.mjs'
run "node supabase/tests/rls.test.mjs (tenancy policies)" \
  bash -c 'node supabase/tests/rls.test.mjs'

run "deadspace (core-derived)" node scripts/gates/deadspace-core.mjs --max-dead 0.10
run "style-gate" node bench/style-gate.mjs
run "accent-univalence" node bench/accent-univalence.mjs

# ---------------------------------------------------------------------------
# R12 — THE THREE GATES THAT GATED NOTHING.
#
# ladder-check, lod-sweep and export-parity existed, passed, were falsified and
# were ledgered — and NO RUNNER INVOKED ANY OF THEM. Four documents recorded
# `ladder-check` as PASS on a board it had never been on. They cost 51/49/54 ms
# together; the reason they were not here was that nobody had looked, not that
# anybody had measured a cost. Each carries its R10 axis statement — the axes its
# falsification varies — so a future reader can see what it does and does not
# watch without opening it.
# ---------------------------------------------------------------------------

# R10 AXES: value (perturb a TIER multiplier — the ratio leaves tolerance) ·
# clamp (move BASE_STROKE_PX so a tier lands on MIN/MAX and the ladder flattens
# into a plateau) · membership (delete a measured rung from TIER, or invent one
# the spec does not measure — both directions, since it iterates the SPEC).
run "ladder-check" node bench/ladder-check.mjs

# R10 AXES: shape (a step function passes monotonicity and the endpoints; only
# the max-jump bound separates a ramp from a threshold) · traversal (a lod() that
# sits at the ends never crossfades) · SUBJECT EXISTENCE (symbols.ts missing is a
# FAILURE, not a skip — the previous fixture-replay version stayed green with the
# file deleted, which is the vacuity this rewrite closed).
run "lod-sweep" node bench/lod-sweep.mjs

# R10 AXES: source (a zone hex RESTATED in the export rather than read from ZONE)
# · path (the palette moved to printPlan.ts and the legend stayed in pdf.ts — two
# anchors, because one `pdf` read would be vacuous for half these checks) ·
# code-path specificity (the groundZones assertion is anchored INSIDE the fill
# loop; matching the file anywhere passed with the fill guard deleted) ·
# encoding (the paper amber invariant matches #e8a13c / rgb / 0x, and
# deliberately NOT the token names, which are references to the one source).
run "export-parity" node bench/export-parity.mjs

# R12/R8 — THE RECONCILIATION. The check that makes the three above impossible to
# lose again: it derives every gate on disk from the FILESYSTEM and every
# invocation from the RUNNERS' SOURCE, and reds on a gate that exists and is
# never invoked. Without it, deleting any `run` line above silently restores the
# exact defect this section was written to fix.
#
# R10 AXES: invocation (remove a runner's call — the gate is orphaned and named)
# · population completeness (the classifier is byte-derived and was widened after
# it missed six sheet gates, G8, G10 and deadspace.py) · board bookkeeping
# (IDS/CMDS/TITLES lengths re-derived here, not trusted from the board's own
# assertion) · declaration-vs-disk (a CMD naming a file that no longer exists) ·
# exemption liveness (each exemption re-tested against the property that
# justifies it; the quarantined gate is RUN and must still be red).
# R17 AXES: language (a recompute added on EITHER side of the wasm boundary —
# the R14 census used rustc and could not see web/) · form (an inline `w * h` or
# a hand-written shoelace that names no symbol; a `grep zoneArea` census
# reported seven owners where this instrument finds ten) · register drift (a
# classified site deleted, or a second site added inside an already-classified
# function) · shape (an m2-returning helper re-exported from util/zoneGeom.ts).
# Its own detector had a false NEGATIVE — an inline `#[cfg(test)]` made a
# backward scan swallow two production sites — and grew rather than gaining an
# exemption; see rustTestRanges.
# R22 AXES: the generated TS view of the zone domain must match what the core
# ANSWERS (not what its source looks like). Staleness here is the authored-domain
# defect wearing a generator, so it is a build failure, not a runtime hope.
run "zone-domain generated view" node scripts/gen-zone-domain.mjs --check

run "area-census (one area, both languages)" node scripts/gates/area-census.mjs

run "gate reconciliation" node scripts/gates/reconcile.mjs

# THE LYING STEPS (GSELF pattern), one per way this board can be lied to. A
# battery that cannot detect its own false green is not a battery, and these are
# permanent fixtures, not a one-off falsification: each is the negative case of a
# mechanism above, run every time somebody asks for the self-test.
#
#   VSELF   — exits 1 while printing nothing alarming. Must be reported RED and
#             must make the script exit non-zero.
#   VSKIP0  — THE DEFECT THIS FILE WAS FIXED FOR: exits 0 having measured
#             nothing, declaring it on stdout. Must be reported SKIPPED and
#             NAMED, never ✓. Before the fix this printed a green tick.
#   VSKIP77 — the same claim over the exit-code channel. Separate fixture
#             because it is a separate detector; deleting either arm of the
#             `if` in `run()` must red exactly one of these two.
#   VSKIPRED— THE DANGEROUS DIRECTION, and the reason the exit-0 detector is
#             gated on `rc -eq 0`. A step that FAILS while also printing a skip
#             notice must stay RED; laundering a failure into a named skip would
#             be a worse defect than the silent green this fix removed, because
#             a skip reads as "nobody looked" rather than "this is broken".
#
# Expected board: 2 skipped, 2 red, denominator +4.
if [ "${VERIFY_SELFTEST:-0}" = "1" ]; then
  run "VSELF (deliberately failing)" bash -c 'echo "everything is fine"; exit 1'
  run "VSKIP0 (exit 0, measured nothing)" bash -c 'echo "SKIP: deliberately measured nothing"; exit 0'
  run "VSKIP77 (exit 77, measured nothing)" bash -c 'echo "subject absent"; exit 77'
  run "VSKIPRED (exit 1 while printing SKIP)" bash -c 'echo "SKIP: a failure wearing a skip notice"; exit 1'
fi

failed=0
for c in "${CODES[@]}"; do [ "$c" -ne 0 ] && failed=$((failed + 1)); done
ran=${#NAMES[@]}
skipped=${#SKIPPED[@]}
# The denominator is DECLARED steps (ran + skipped), never `ran` alone — see the
# `skip()` note at the top. A green board must state its own coverage: 48/49 with
# one named skip and 49/49 are different measurements and must not print alike.
total=$((ran + skipped))
green=$((ran - failed))
echo
if [ $skipped -gt 0 ]; then
  printf '\033[1;33m  %d step(s) SKIPPED — NOT MEASURED:\033[0m\n' "$skipped"
  for s in "${SKIPPED[@]}"; do echo "    $s"; done
fi
if [ $failed -eq 0 ]; then
  printf '\033[1;32mVERIFY OK\033[0m — %d/%d steps green' "$green" "$total"
  [ $skipped -gt 0 ] && printf ', \033[1;33m%d skipped\033[0m' "$skipped"
  printf '\n'
  exit 0
fi
printf '\033[1;31mVERIFY FAIL\033[0m — %d of %d step(s) red' "$failed" "$total"
[ $skipped -gt 0 ] && printf ', \033[1;33m%d skipped\033[0m' "$skipped"
printf ':\n'
for i in "${!NAMES[@]}"; do
  [ "${CODES[$i]}" -ne 0 ] && echo "    ${NAMES[$i]}"
done
exit 1
