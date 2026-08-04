#!/usr/bin/env bash
# Run every deliverable-pack gate and print a scoreboard.
#
#   bash scripts/gates/run-all.sh                 # all gates
#   bash scripts/gates/run-all.sh G1 G2 G4        # only these
#   VERBOSE=1 bash scripts/gates/run-all.sh       # show each gate's stderr notes
#
# Exits non-zero if any gate fails. A gate whose artifact does not exist yet
# fails with "artifact missing: <path>" — that is the expected day-one state.
#
# ORDER: G10 FIRST, then the content gates, then an integrity pass.
# G10 is not a reader — it clicks the product's one export control and the app
# rewrites the whole of `out/`. Running it last (as this script used to) meant
# G1-G9 graded the PREVIOUS run's files and nothing ever looked at what G10 left
# behind: measured, `walkthrough.mp4` went 25,704,418 -> 14,155,824 B after a
# green board (defect D2, reports/defects-1.md). So the producer runs first, the
# graders grade its output, and the closing integrity pass proves the pack was
# not rewritten underneath them — a green board now names the exact bytes it
# graded.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

OUT="${OUT_DIR:-$REPO/out}"

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
# The index of the gate that PRODUCES the pack (G10). Everything else reads.
PRODUCER_IDX=9

# The artifacts the pack itself is made of — what the integrity pass watches.
# (out/g8-viewer.png is a gate's own screenshot, not a deliverable, so it is not
# in the list; G8 legitimately rewrites it while grading.)
declare -a PACK_FILES=(
  "$OUT/quantity-takeoff.xlsx"
  "$OUT/ground-truth.json"
  "$OUT/plan.png"
  "$OUT/plan.repeat.png"
  "$OUT/renders/Reception.png"
  "$OUT/renders/Open_space.png"
  "$OUT/renders/Work_stations.png"
  "$OUT/renders/Conference_room.png"
  "$OUT/walkthrough.mp4"
  "$OUT/share.json"
)

# name · size · mtime for each pack file, one line each. Portable (BSD/GNU).
snapshot_pack() {
  python3 - "$@" <<'PY'
import os, sys
for p in sys.argv[1:]:
    try:
        st = os.stat(p)
        print(f"{os.path.relpath(p)} {st.st_size} {st.st_mtime_ns}")
    except FileNotFoundError:
        print(f"{os.path.relpath(p)} MISSING")
PY
}

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

FAILED=0        # gates that came back red
RAN=0
SUITE_FAIL=0    # suite-level failures (the closing integrity pass)
declare -a LINES=()

run_gate() {
  local i="$1"
  local id="${IDS[$i]}"
  local out rc line
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
  LINES[$i]="$(printf '%-4s %-18s %s' "$id" "${TITLES[$i]}" "${line#"$id" }")"
  if [ "${VERBOSE:-0}" = "1" ]; then printf '%s\n' "$out" | grep -v -E "^${id} (PASS|FAIL)"; fi
}

# ---- 1. produce the pack (the one action), before anything grades it --------
PRODUCED=0
if selected "${IDS[$PRODUCER_IDX]}"; then
  run_gate "$PRODUCER_IDX"
  PRODUCED=1
  BEFORE="$(snapshot_pack "${PACK_FILES[@]}")"
fi

# ---- 2. grade what it left --------------------------------------------------
for i in "${!IDS[@]}"; do
  [ "$i" -eq "$PRODUCER_IDX" ] && continue
  selected "${IDS[$i]}" || continue
  run_gate "$i"
done

# ---- 3. integrity: the graded pack is still the pack ------------------------
INTEGRITY=""
if [ "$PRODUCED" = "1" ]; then
  AFTER="$(snapshot_pack "${PACK_FILES[@]}")"
  if [ "$BEFORE" != "$AFTER" ]; then
    SUITE_FAIL=1
    INTEGRITY="CHANGED under the gates — the board above does NOT describe these files:
$(diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | sed 's/^/      /')"
  else
    verify="$(node "$HERE/g10-one-action.mjs" --verify-only 2>/dev/null | tail -1)"
    case "$verify" in
      "G10 PASS"*) INTEGRITY="unchanged since G10 produced it; ${verify#G10 }" ;;
      *) SUITE_FAIL=1; INTEGRITY="FINAL ARTIFACTS INCOMPLETE — ${verify:-no scoreboard line}" ;;
    esac
  fi
fi

echo
echo "--------------------------- SCOREBOARD -----------------------"
for i in "${!IDS[@]}"; do
  [ -n "${LINES[$i]:-}" ] && echo "  ${LINES[$i]}"
done
echo "--------------------------------------------------------------"
echo "  $((RAN-FAILED))/$RAN passing"

# ---- 4. state exactly which bytes were graded -------------------------------
# NB: invoked directly, never inside $(…) — bash 3.2 (macOS) mis-parses a
# here-document that contains a `)` when it sits inside a command substitution.
describe_pack() {
  python3 - "$@" <<'PY'
import os, subprocess, sys, time
paths = sys.argv[1:]
n = sum(1 for p in paths if os.path.exists(p))
print(f"  graded pack: {n}/{len(paths)} artifacts in {os.path.relpath(os.path.dirname(paths[0]))}/")
for p in paths:
    if not p.endswith('.mp4') or not os.path.exists(p):
        continue
    st = os.stat(p)
    try:
        d = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'default=nw=1:nokey=1', p],
                           capture_output=True, text=True, timeout=60)
        dur = (f"{float(d.stdout.strip()):.2f}s" if d.returncode == 0 and d.stdout.strip()
               else f"DOES NOT DECODE: {d.stderr.strip()[:80]}")
    except Exception as e:
        dur = f"ffprobe unavailable ({e})"
    when = time.strftime('%H:%M:%S', time.localtime(st.st_mtime))
    print(f"               {os.path.basename(p)}  {st.st_size} B  mtime {when}  {dur}")
PY
}

echo
describe_pack "${PACK_FILES[@]}"
[ -n "$INTEGRITY" ] && echo "               $INTEGRITY"
echo

if [ $FAILED -ne 0 ]; then
  echo "FAIL: $FAILED gate(s) red."
  exit 1
fi
if [ $SUITE_FAIL -ne 0 ]; then
  echo "FAIL: every gate passed, but the pack they graded is not the pack on disk."
  exit 1
fi
echo "ALL GATES GREEN."
