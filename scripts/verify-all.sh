#!/usr/bin/env bash
# THE standard verification battery, aggregated by EXIT CODE.
#
#   bash scripts/verify-all.sh              # staged-aware: Rust suite only if Rust changed
#   bash scripts/verify-all.sh --full       # always run everything
#
# A skipped step is COUNTED and NAMED (see `skip()` below). Quote a floor number
# only from `--full`; `48/49, 1 skipped` is not the same measurement as `49/49`.
#   VERIFY_SELFTEST=1 bash scripts/verify-all.sh   # append a deliberately failing step
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
run() {                       # run <name> <command...>
  local name="$1"; shift
  local out
  out="$("$@" 2>&1)"; local rc=$?
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

# THE LYING STEP (GSELF pattern). A battery that cannot detect its own false
# green is not a battery. This step exits 1 while printing nothing alarming; the
# scoreboard below must report it red, and the script must exit non-zero.
if [ "${VERIFY_SELFTEST:-0}" = "1" ]; then
  run "VSELF (deliberately failing)" bash -c 'echo "everything is fine"; exit 1'
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
