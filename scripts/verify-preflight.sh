#!/usr/bin/env bash
#
# Browser-verification pre-flight — run this BEFORE trusting anything you see in
# a browser. Design: docs/design/ui-system.md §3.6.1.
#
#   scripts/verify-preflight.sh <port> <identifier> [module-path]
#   scripts/verify-preflight.sh 5199 setActive src/editor/EditorCanvas.ts
#
# WHY THIS EXISTS
# ---------------
# This repo is developed in parallel git worktrees. A `vite --strictPort` started
# from a DIFFERENT worktree will happily hold the port, answer every request, and
# hot-reload cleanly — while serving another branch entirely. That is a FALSE
# GREEN with no symptom: unlike a blank page or a stale console error, nothing
# about it looks wrong. It cost ~15 minutes of chasing a fix that was already
# correct, and it could just as easily have "confirmed" a fix that never landed.
#
# So this is a script rather than a remembered rule. It asserts, in order:
#   1. something is listening on the port;
#   2. the process listening is serving THIS worktree (checks the listening
#      PID's cwd — not merely that something answers);
#   3. the module it serves contains a distinctive identifier from the change
#      under test.
#
# Grep for an IDENTIFIER, never for comment text: esbuild strips comments in dev,
# so a comment grep returns 0 against perfectly current code and sends you
# chasing a phantom.

set -uo pipefail

PORT="${1:-}"
IDENT="${2:-}"
MODULE="${3:-src/App.tsx}"

die() { printf '\033[1;31m✗ PRE-FLIGHT FAILED\033[0m  %s\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

[ -n "$PORT" ] && [ -n "$IDENT" ] || die "usage: $0 <port> <identifier> [module-path]"

# The worktree this script lives in — the one whose code we intend to test.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1 — is anything listening?
PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
[ -n "$PID" ] || die "nothing is listening on :$PORT — start the dev server first."
ok "something is listening on :$PORT (pid $PID)"

# 2 — is it OURS? Compare the listening process's cwd against this worktree.
#     `lsof -a -d cwd` prints the process's working directory.
PID_CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
[ -n "$PID_CWD" ] || die "could not read the cwd of pid $PID (permissions?). Do not trust :$PORT."
case "$PID_CWD" in
  "$ROOT"|"$ROOT"/*) ok "the listener is this worktree ($PID_CWD)" ;;
  *) die "':$PORT' is served by a DIFFERENT worktree.
      listening pid cwd : $PID_CWD
      this worktree     : $ROOT
    You would be verifying another branch's code through a server that responds
    normally and reloads cleanly. Start your own server on a session-specific
    port and re-run. Never reuse 5173 while other worktrees exist." ;;
esac

# 3 — does the served module actually contain the change under test?
BODY="$(curl -fsS --max-time 10 "http://localhost:$PORT/$MODULE" 2>/dev/null)" \
  || die "could not fetch http://localhost:$PORT/$MODULE"
COUNT="$(printf '%s' "$BODY" | grep -c -- "$IDENT" || true)"
[ "$COUNT" -gt 0 ] || die "the server on :$PORT does NOT serve '$IDENT' in $MODULE.
    It is serving stale or foreign code. (If you grepped for comment text, that
    is the bug — esbuild strips comments in dev. Use an identifier.)"
ok "serves '$IDENT' in $MODULE ($COUNT occurrence(s))"

printf '\033[1;32m✓ pre-flight clear\033[0m — http://localhost:%s is this worktree, current.\n' "$PORT"
