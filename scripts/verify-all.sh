#!/usr/bin/env bash
# THE standard verification battery, aggregated by EXIT CODE.
#
#   bash scripts/verify-all.sh              # staged-aware: Rust suite only if Rust changed
#   bash scripts/verify-all.sh --full       # always run everything
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

declare -a NAMES=() CODES=()
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

# Rust changes are the only reason to pay for the Rust suite. Compare the STAGED
# tree when there is one (pre-commit), else the working tree.
rust_touched() {
  [ $FULL -eq 1 ] && return 0
  if git diff --cached --quiet 2>/dev/null; then
    ! git diff --quiet -- crates 2>/dev/null
  else
    ! git diff --cached --quiet -- crates 2>/dev/null
  fi
}

echo "verification battery"
if rust_touched; then
  run "cargo test -p ds-core" cargo test -p ds-core
else
  echo "  · cargo test -p ds-core — skipped (no Rust in this change; --full to force)"
fi
run "tsc --noEmit" bash -c 'cd web && pnpm typecheck'
while IFS= read -r t; do
  run "node ${t#web/src/}" node "$t"
done < <(cd web && find src -name '*.test.mjs' | sed 's|^|web/|' | sort)
run "deadspace (core-derived)" node scripts/gates/deadspace-core.mjs --max-dead 0.10
run "style-gate" node bench/style-gate.mjs
run "accent-univalence" node bench/accent-univalence.mjs

# THE LYING STEP (GSELF pattern). A battery that cannot detect its own false
# green is not a battery. This step exits 1 while printing nothing alarming; the
# scoreboard below must report it red, and the script must exit non-zero.
if [ "${VERIFY_SELFTEST:-0}" = "1" ]; then
  run "VSELF (deliberately failing)" bash -c 'echo "everything is fine"; exit 1'
fi

failed=0
for c in "${CODES[@]}"; do [ "$c" -ne 0 ] && failed=$((failed + 1)); done
total=${#NAMES[@]}
echo
if [ $failed -eq 0 ]; then
  printf '\033[1;32mVERIFY OK\033[0m — %d/%d steps green\n' "$total" "$total"
  exit 0
fi
printf '\033[1;31mVERIFY FAIL\033[0m — %d of %d step(s) red:\n' "$failed" "$total"
for i in "${!NAMES[@]}"; do
  [ "${CODES[$i]}" -ne 0 ] && echo "    ${NAMES[$i]}"
done
exit 1
