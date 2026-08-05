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
# ORDER: G9's inputs, then G10, then the content gates, then an integrity pass.
# G10 is not a reader — it clicks the product's one export control and the app
# rewrites the whole of `out/`. Running it last (as this script used to) meant
# G1-G9 graded the PREVIOUS run's files and nothing ever looked at what G10 left
# behind: measured, `walkthrough.mp4` went 25,704,418 -> 14,155,824 B after a
# green board (defect D2, reports/defects-1.md). So the producers run first, the
# graders grade their output, and the closing integrity pass proves nothing was
# rewritten underneath them — a green board now names the exact bytes it graded.
#
# G10 is not the only producer: `out/cases/*` (G9's twelve inputs, 21 of the
# checks) comes from `scripts/export-pack.mjs`, which nothing here used to run
# and the snapshot did not watch — they were measured 27 minutes stale under two
# green boards (defect E5, reports/defects-2.md). They are regenerated in step 0
# and snapshotted with everything else.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

OUT="${OUT_DIR:-$REPO/out}"

declare -a IDS=(G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 G11)
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
  "python3 $HERE/g11-furniture-agreement.py"
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
  "Furniture agreement"
)
# The index of the gate that PRODUCES the pack (G10). Everything else reads.
# G11 is appended AFTER it, so this index is unaffected by the append.
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

# G9's inputs. NOT part of the one-action pack — `node scripts/export-pack.mjs`
# is the only thing that writes them — so they used to be produced by nobody and
# watched by nobody: measured 27 minutes stale under two consecutive green boards
# while the scoreboard said "unchanged since G10 produced it" (defect E5,
# reports/defects-2.md). They now get the same treatment as every other graded
# byte: produced by this runner below, and diffed by the closing integrity pass.
declare -a CASE_FILES=()
for _c in seeded dwg testfit; do
  for _f in quantity-takeoff.xlsx ground-truth.json plan.png plan.repeat.png; do
    CASE_FILES+=("$OUT/cases/$_c/$_f")
  done
done

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

# ---- 0. produce G9's inputs -------------------------------------------------
# Regenerating all three round-trip cases costs ~1.3 s, so the runner does it
# every time rather than trusting whatever a previous, unrelated invocation left
# behind. (G9 also fails on its own if a case is older than the generator, so
# running the gate outside this script is stale-proof too.)
CASES_NOTE=""
if selected G9; then
  echo
  echo "  producing G9's round-trip cases: node scripts/export-pack.mjs"
  if [ "${VERBOSE:-0}" = "1" ]; then
    node "$REPO/scripts/export-pack.mjs" --out "$OUT"
  else
    node "$REPO/scripts/export-pack.mjs" --out "$OUT" >/dev/null 2>&1
  fi
  if [ $? -ne 0 ]; then
    SUITE_FAIL=1
    CASES_NOTE="scripts/export-pack.mjs FAILED — G9's cases are whatever was on disk"
  fi
fi

# ---- 1. produce the pack (the one action), before anything grades it --------
PRODUCED=0
if selected "${IDS[$PRODUCER_IDX]}"; then
  run_gate "$PRODUCER_IDX"
  PRODUCED=1
  BEFORE="$(snapshot_pack "${PACK_FILES[@]}" "${CASE_FILES[@]}")"
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
  AFTER="$(snapshot_pack "${PACK_FILES[@]}" "${CASE_FILES[@]}")"
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
pack = [p for p in paths if os.sep + 'cases' + os.sep not in p]
cases = [p for p in paths if os.sep + 'cases' + os.sep in p]
n = sum(1 for p in pack if os.path.exists(p))
print(f"  graded pack: {n}/{len(pack)} artifacts in {os.path.relpath(os.path.dirname(pack[0]))}/")
if cases:
    c = sum(1 for p in cases if os.path.exists(p))
    newest = max((os.stat(p).st_mtime for p in cases if os.path.exists(p)), default=0)
    oldest = min((os.stat(p).st_mtime for p in cases if os.path.exists(p)), default=0)
    print(f"               + {c}/{len(cases)} G9 round-trip case files, written "
          f"{time.strftime('%H:%M:%S', time.localtime(oldest))}"
          + (f"-{time.strftime('%H:%M:%S', time.localtime(newest))}" if newest - oldest > 1 else ""))
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
describe_pack "${PACK_FILES[@]}" "${CASE_FILES[@]}"
[ -n "$INTEGRITY" ] && echo "               $INTEGRITY"
[ -n "$CASES_NOTE" ] && echo "               $CASES_NOTE"
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
