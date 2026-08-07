#!/usr/bin/env bash
# ATTRIBUTED DISPOSABLE WORKTREES + THE JANITOR (R21, orchestration corollary).
#
#   scripts/worktree.sh new  <name> [ref]   # create, tagged with mission+session
#   scripts/worktree.sh done <name>         # mark closed, then remove it
#   scripts/worktree.sh list                # every worktree, with attribution
#   scripts/worktree.sh sweep [--force]     # remove ATTRIBUTED-AND-CLOSED trees only
#
# WHY THIS EXISTS
# ---------------
# This mission creates disposable worktrees by the dozen — the falsification
# discipline requires them (`.claude/rules/gate-independence.md`: sabotage the
# COPY, never the protected artifact). Nothing ever removed them. They reached
# **32 registered trees** and filled a 460 GiB disk to 100%, which broke tooling
# mid-write with ENOSPC and would have corrupted any run in flight.
#
# Clearing them by hand is not the fix, because the hard part is not deletion —
# it is ATTRIBUTION. At the moment the disk filled, several trees had timestamps
# minutes old and belonged to a PARALLEL session working the same repo. There was
# no way to tell a finished falsification from somebody's live work except by
# guessing from mtimes, and deleting a tree you cannot attribute destroys
# somebody's work. So the janitor was not run, and a human had to clear space.
#
# THE RULE: attribution is written AT CREATION, never inferred afterwards.
# Every tree this script makes carries `.ds-worktree` naming its mission, session
# and purpose. `sweep` removes only trees that are BOTH attributed AND closed.
#
# **An unattributed worktree is UNTOUCHABLE — grandfathered, forever.** That is
# deliberate: the trees that existed before this script cannot be attributed
# retroactively without guessing, and guessing is the failure mode. They are
# listed, never removed, and `sweep` says so on every run rather than silently
# skipping them.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
TAG=".ds-worktree"

MISSION="${DS_MISSION:-qbiq-parity-endgame}"
SESSION="${DS_SESSION:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

usage() { sed -n '2,12p' "$0" >&2; exit 2; }
[ $# -ge 1 ] || usage
cmd="$1"; shift

case "$cmd" in
  new)
    [ $# -ge 1 ] || usage
    name="$1"; ref="${2:-HEAD}"
    dir="/tmp/ds-wt-$name"
    # CONSULT THE TAG BEFORE DESTROYING ANYTHING.
    #
    # This was `rm -rf "$dir"` unconditionally, and it DESTROYED TWO LIVE
    # WORKTREES belonging to the adversary mid-run — an in-flight bisect and an
    # end-to-end sabotage tree — costing it ~7 minutes and 43 rows of
    # CHECKOUT_FAIL. `done` checked the tag; `new` did not. A janitor whose
    # create path deletes what its close path refuses to touch is not a janitor.
    if [ -e "$dir" ]; then
      if [ -f "$dir/$TAG" ]; then
        _s=$(grep '^status=' "$dir/$TAG" | cut -d= -f2)
        _sess=$(grep '^session=' "$dir/$TAG" | cut -d= -f2)
        if [ "$_s" != "closed" ] || [ "$_sess" != "$SESSION" ]; then
          echo "REFUSED: $dir exists, session=$_sess status=$_s — not yours to reuse." >&2
          echo "  Pick another name, or close it from the session that owns it." >&2
          exit 1
        fi
      else
        echo "REFUSED: $dir exists and carries no $TAG — grandfathered, untouchable." >&2
        exit 1
      fi
      git worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
    fi
    git worktree prune
    git worktree add --detach "$dir" "$ref" >/dev/null || exit 1
    # Attribution FIRST — a tree that exists without its tag, even for a moment,
    # is a tree the janitor must refuse to touch.
    cat > "$dir/$TAG" <<EOF
mission=$MISSION
session=$SESSION
name=$name
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
base=$(git rev-parse --short "$ref")
status=open
EOF
    # Deps, so gates and node tests actually run in there.
    # THE TAG WRITE IS CHECKED. Unchecked, a full disk (the exact state this
    # script exists for) leaves a tree with no tag — which `done` then REFUSES
    # and `sweep` grandfathers forever. A permanent leak, created by the tool
    # meant to stop leaks. If the tag cannot be written the tree does not exist.
    if [ ! -s "$dir/$TAG" ]; then
      echo "REFUSED: could not write $dir/$TAG (disk full?) — removing the tree." >&2
      git worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
      exit 1
    fi
    ln -sfn "$REPO/node_modules" "$dir/node_modules" 2>/dev/null
    ln -sfn "$REPO/web/node_modules" "$dir/web/node_modules" 2>/dev/null
    echo "$dir"
    ;;

  done)
    [ $# -ge 1 ] || usage
    dir="/tmp/ds-wt-$1"
    if [ ! -f "$dir/$TAG" ]; then
      echo "REFUSED: $dir carries no $TAG — it is not this script's to close." >&2
      exit 1
    fi
    sed -i '' 's/^status=.*/status=closed/' "$dir/$TAG" 2>/dev/null \
      || sed -i 's/^status=.*/status=closed/' "$dir/$TAG"
    git worktree remove --force "$dir" 2>/dev/null && echo "removed $dir"
    git worktree prune
    ;;

  list)
    git worktree list --porcelain | grep '^worktree ' | sed 's/worktree //' | while read -r w; do
      [ "$w" = "$REPO" ] && continue
      if [ -f "$w/$TAG" ]; then
        m=$(grep '^mission=' "$w/$TAG" | cut -d= -f2)
        s=$(grep '^status=' "$w/$TAG" | cut -d= -f2)
        printf '  %-10s %-24s %s\n' "$s" "$m" "$w"
      else
        printf '  %-10s %-24s %s\n' "UNTAGGED" "(grandfathered)" "$w"
      fi
    done
    ;;

  sweep)
    force="${1:-}"
    removed=0; kept=0; untagged=0
    git worktree list --porcelain | grep '^worktree ' | sed 's/worktree //' | while read -r w; do
      [ "$w" = "$REPO" ] && continue
      if [ ! -f "$w/$TAG" ]; then
        echo "  KEEP (untagged, not ours): $w"
        continue
      fi
      m=$(grep '^mission=' "$w/$TAG" | cut -d= -f2)
      s=$(grep '^status=' "$w/$TAG" | cut -d= -f2)
      sess=$(grep '^session=' "$w/$TAG" | cut -d= -f2)
      if [ "$m" != "$MISSION" ]; then
        echo "  KEEP (another mission: $m): $w"
      elif [ "$sess" != "$SESSION" ]; then
        # `DS_MISSION` defaults to the branch, so every session on this mission
        # shares it and `--force` used to reach across into a PARALLEL session's
        # OPEN trees. Measured: it removed two of the adversary's live worktrees
        # mid-run. Session is the finer key and --force does not cross it.
        echo "  KEEP (another session: $sess): $w"
      elif [ "$s" != "closed" ] && [ "$force" != "--force" ]; then
        echo "  KEEP (still open): $w"
      else
        git worktree remove --force "$w" 2>/dev/null && echo "  REMOVED: $w"
      fi
    done
    git worktree prune
    echo
    if [ "$force" = "--force" ]; then
      echo "sweep --force: removed CLOSED **and OPEN** trees of mission"
      echo "'$MISSION' belonging to THIS session ($SESSION) only. Other sessions'"
      echo "trees and untagged trees were kept."
    else
      echo "sweep removes only ATTRIBUTED-AND-CLOSED trees of mission '$MISSION'"
      echo "belonging to this session ($SESSION)."
    fi
    echo "Untagged trees are grandfathered and are never removed — attribution"
    echo "cannot be inferred after the fact, and guessing is how you delete"
    echo "somebody else's live work."
    # The closing sentence used to describe ATTRIBUTED-AND-CLOSED on --force runs
    # too, while --force had just removed open trees. A tool reporting an action
    # it did not take is the producer certifying its own work, in the janitor.
    ;;

  *) usage ;;
esac
