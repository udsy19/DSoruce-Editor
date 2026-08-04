#!/usr/bin/env bash
# Run every deliverable-pack gate and print a scoreboard.
#
#   bash scripts/gates/run-all.sh                 # all gates
#   bash scripts/gates/run-all.sh G1 G2 G4        # only these
#   VERBOSE=1 bash scripts/gates/run-all.sh       # show each gate's stderr notes
#
# Exits non-zero if any gate fails. A gate whose artifact does not exist yet
# fails with "artifact missing: <path>" — that is the expected day-one state.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

declare -a IDS=(G1 G2 G3 G4 G5 G6 G7 G8 G9 G10)
declare -a CMDS=(
  "python3 $HERE/g1-sheet-structure.py"
  "python3 $HERE/g2-formula-liveness.py"
  "python3 $HERE/g3-quantity-truth.py"
  "python3 $HERE/g4-plan-graphic.py"
  "python3 $HERE/g5-thumbnails.py"
  "python3 $HERE/g6-renders.py"
  "python3 $HERE/g7-video.py"
  "node $HERE/g8-web-viewer.mjs"
  "python3 $HERE/g9-roundtrip.py"
  "node $HERE/g10-one-action.mjs"
)
declare -a TITLES=(
  "Sheet structure"
  "Formula liveness"
  "Quantity truth"
  "Plan graphic"
  "Thumbnails"
  "Renders"
  "Video"
  "Web viewer"
  "Round-trip"
  "One-action UX"
)

WANT=("$@")
selected() {
  [ ${#WANT[@]} -eq 0 ] && return 0
  local id="$1"
  for w in "${WANT[@]}"; do [ "$w" = "$id" ] && return 0; done
  return 1
}

echo "=============================================================="
echo " DSource deliverable-pack gates"
echo " repo: $REPO"
echo "=============================================================="

FAILED=0
RAN=0
declare -a LINES=()

for i in "${!IDS[@]}"; do
  id="${IDS[$i]}"
  selected "$id" || continue
  RAN=$((RAN+1))
  if [ "${VERBOSE:-0}" = "1" ]; then
    out="$(eval "${CMDS[$i]}" 2>&1)"
  else
    out="$(eval "${CMDS[$i]}" 2>/dev/null)"
  fi
  rc=$?
  line="$(printf '%s' "$out" | grep -E "^${id} (PASS|FAIL)" | tail -1)"
  [ -z "$line" ] && line="${id} FAIL: gate produced no scoreboard line (rc=$rc)"
  [ $rc -ne 0 ] && FAILED=$((FAILED+1))
  LINES+=("$(printf '%-4s %-18s %s' "$id" "${TITLES[$i]}" "${line#"$id" }")")
  if [ "${VERBOSE:-0}" = "1" ]; then printf '%s\n' "$out" | grep -v -E "^${id} (PASS|FAIL)"; fi
done

echo
echo "--------------------------- SCOREBOARD -----------------------"
for l in "${LINES[@]}"; do echo "  $l"; done
echo "--------------------------------------------------------------"
echo "  $((RAN-FAILED))/$RAN passing"
echo

if [ $FAILED -ne 0 ]; then
  echo "FAIL: $FAILED gate(s) red."
  exit 1
fi
echo "ALL GATES GREEN."
