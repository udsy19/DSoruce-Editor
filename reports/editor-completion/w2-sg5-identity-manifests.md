# W2 — SG5's eleven count pins become identity manifests

Branch `fix/sg5-manifests` off `d868ec3`. Pre-registration:
`reports/editor-completion/phase0-leftovers.md` (W2 block) — "SG5's G1–G11 pins become
identity manifests (check NAMES, not counts). Falsifier that must go red: swap one
check's identity while keeping the count flat. Expectation: board counts unchanged;
only the pin shape changes."

## What changed

- `scripts/gates/sheets/sg5-board-integrity.mjs` — the eleven count pins (kept) gain a
  per-gate IDENTITY MANIFEST comparison, plus a `--capture-g-manifest` re-pin mode.
- `scripts/fixtures/g-board.manifest.json` — NEW: the pinned check identities, 102 call
  sites across the eleven gate files, with provenance in the file.

## The per-gate parseability finding (why source call sites, not emitted lines)

The mission asked for manifests "derived from each gate's actual emitted check lines".
Measured finding, and it covers ALL ELEVEN gates uniformly: **G1–G11 emit no per-check
identity on a green run.** Both `scripts/gates/lib/gatelib.py` and
`scripts/gates/lib/gatelib.mjs` implement `Gate.check(cond, msg)` as a counter that
surfaces `msg` only on FAILURE; `finish()` prints one scoreboard line
(`G1 PASS  (59 checks)`). There is no `--manifest` mode (that exists only in
`scripts/drawing-set.test.mjs`) and no verbose per-check emission. So on the board SG5
watches, runtime check identity is structurally unparseable — for every gate, not for a
subset — and editing the gates to emit it is outside W2's ownership.

| gate | file | runtime checks (count pin) | check call sites (manifest) | identity surface |
|---|---|---:|---:|---|
| G1 | g1-sheet-structure.py | 59 | 9 | source call sites (py ast) |
| G2 | g2-formula-liveness.py | 17 | 6 | source call sites (py ast) |
| G3 | g3-quantity-truth.py | 92 | 13 | source call sites (py ast) |
| G4 | g4-plan-graphic.py | 18 | 12 | source call sites (py ast) |
| G5 | g5-thumbnails.py | 70 | 7 | source call sites (py ast) |
| G6 | g6-renders.py | 53 | 15 | source call sites (py ast) |
| G7 | g7-video.py | 19 | 13 | source call sites (py ast) |
| G8 | g8-web-viewer.mjs | 9 | 9 | source call sites (js scanner) |
| G9 | g9-roundtrip.py | 24 | 4 | source call sites (py ast) |
| G10 | g10-one-action.mjs | 14 | 6 | source call sites (js scanner) |
| G11 | g11-furniture-agreement.py | 56 | 8 | source call sites (py ast) |

What IS parseable without touching the gates: the `g.check(...)` CALL SITES in each
gate's source bytes. The pinned identity per site is the whitespace-normalized source
text of the `msg` argument — the exact string the gate would print on failure, before
interpolation — which changes precisely when someone edits what a check asserts or says.
Extraction: python via `ast` (`get_source_segment` on the msg arg, exact), the two
`.mjs` gates via a string/template/regex-aware scanner embedded in SG5. Comparison is a
MULTISET in both directions (vanished / gained), so padding the count with a verbatim
duplicate of an existing check is also a named failure.

**Why counts stay:** the manifest pins call sites in the SOURCE; the counts pin
EXECUTIONS at runtime. A data-driven loop that silently iterates fewer rows moves the
count without touching any call site — and a swapped check moves no count. Each pin
covers the other's blind spot; together strictly stronger than either.

**Stated residual limits** (on the record, not silently accepted):
1. A swap of WHICH FILE `run-all.sh` invokes for a gate id dodges a source pin; SG5 now
   at least asserts the pinned file path equals the path `run-all.sh` uses (mirrored in
   SG5's `GATE_FILES`), and the runtime count + board-green checks still watch that
   surface.
2. A check whose msg argument is a bare variable (none today — all 102 sites are
   literal/f-string/template expressions) would pin only the variable name.
3. Loop-body checks are pinned as ONE site; a change in which rows the loop visits is
   the count pin's job, not the manifest's.

## Fixture provenance

`scripts/fixtures/g-board.manifest.json` was captured with `--capture-g-manifest` on
THIS tree, immediately after the full G1–G11 board ran green on artifacts built via the
sanctioned path (dev server for this worktree on port 5312, `GATE_BASE` pointed at it;
`run-all.sh G1..G11` produced `out/` through G10's one action). Calibrating against a
population explicitly verified clean, per `.claude/rules/gate-independence.md`. No
artifacts were copied from any other worktree; `out/` here was empty before the run.

## Proof transcripts

All sabotage in disposable `git worktree add --detach <scratch> d868ec3` copies with
`web/node_modules` symlinked and `out/` copied in, per the falsification recipe in
`.claude/rules/gate-independence.md`; the protected tree was never mutated. Each scratch
run served ITS OWN tree on port 5312 (my main server stopped first — sequential use of
the one port W2 owns), so `run-all.sh`'s worktree preflight held and G10 rebuilt the
scratch's pack via the sanctioned path.

### Proof 4 — green on the honest tree (run first, the gate's own fail-first direction)

```
$ GATE_BASE=http://localhost:5312 bash scripts/gates/run-all.sh G1 ... G11
  11/11 passing ... ALL GATES GREEN.            # pack built fresh IN THIS worktree
$ node scripts/gates/sheets/sg5-board-integrity.mjs --capture-g-manifest
wrote scripts/fixtures/g-board.manifest.json: G1=9 G2=6 G3=13 G4=12 G5=7 G6=15 G7=13 G8=9 G9=4 G10=6 G11=8
$ GATE_BASE=http://localhost:5312 node scripts/gates/sheets/sg5-board-integrity.mjs
SG5 PASS (67 checks)
```

32 -> 67 checks: +2 (pin present, pins exactly the eleven gates) and +3 per gate
(pinned-file-is-invoked-file, no-vanished, no-unpinned).

### Proof 3 — GSELF survives the change

The runner self-test assertion ("the runner reports a gate that exits 0 while printing
FAIL as RED") is untouched by this change and is one of the 67 passing checks above —
SG5 still spawns `GATE_SELFTEST=1 run-all.sh GSELF` every run and goes red if the board
tallies the liar as passing.

### Proof 1 — the closing sabotage: identity swap, count flat

Scratch `sab1-swap` (detached at d868ec3), sabotage applied by an anchored, re-read
edit script (`assert old in s` before, `assert new in ...read()` after):

```diff
--- a/scripts/gates/g8-web-viewer.mjs
-  g.check(html.length > 200, `share route returned ${html.length} bytes of HTML, looks empty`)
+  g.check(html.length > 0, 'share route returned a non-empty body (swapped-in assertion)')
```

One check's identity replaced by a weaker, different assertion; G8's runtime count stays
9; the board stays green.

**OLD SG5 (as committed at d868ec3, running in the sabotaged scratch):**

```
$ GATE_BASE=http://localhost:5312 node scripts/gates/sheets/sg5-board-integrity.mjs
SG5 PASS (32 checks)        # exit 0, zero FAIL lines on stderr
```

The count pin is blind to the swap — the recorded standing weakness, demonstrated.

**NEW SG5 (same sabotaged scratch, new gate + fixture copied in):**

```
SG5 FAIL (67 checks, 2 failing)
  FAIL G8: no pinned check has VANISHED (9 sites pinned) — 1 gone: `share route returned ${html.length} bytes of HTML, looks empty` — recover it, or re-pin deliberately with --capture-g-manifest after reading what changed. Never drop it silently.
  FAIL G8: no UNPINNED check has appeared — 1 new: 'share route returned a non-empty body (swapped-in assertion)' — re-pin deliberately, having looked at what it asserts.
```

Exactly one sabotage, exactly two named failures (the two directions of the same swap),
zero collateral reds — the other 65 checks, including all eleven count pins, stayed
green, which is the weakness in one sentence: the counts alone certified this tree.

### Proof 2 — vanished check, count padded flat

Scratch `sab2-vanish` (detached at d868ec3):

```diff
--- a/scripts/gates/g5-thumbnails.py
     extra = sorted(set(by_row) - {r for r, _, _ in rows})
-    g.check(not extra, f"column-B thumbnails on non-body rows: {extra[:6]}")
+    g.check(not off_col,
+            f"{len(off_col)} thumbnail(s) anchored outside column B: {off_col[:4]}")
```

A once-executing check REMOVED, and the runtime count padded back to 70 with a VERBATIM
duplicate of an already-pinned, once-executing check — the compensation trick a set
comparison cannot see.

**OLD SG5:** `SG5 PASS (32 checks)`, exit 0, zero FAIL lines — blind.

**NEW SG5:**

```
SG5 FAIL (67 checks, 2 failing)
  FAIL G5: no pinned check has VANISHED (7 sites pinned) — 1 gone: f"column-B thumbnails on non-body rows: {extra[:6]}" — ...
  FAIL G5: no UNPINNED check has appeared — 1 new: f"{len(off_col)} thumbnail(s) anchored outside column B: {off_col[:4]}" — ...
```

The vanished check is named, and the padding duplicate surfaces as an unpinned surplus
because the comparison is a MULTISET: the pin holds one copy of the off_col identity,
the sabotaged source holds two.

### Environmental note from the proof runs (scoped to the scratch runs, not the gate)

Three sab2 attempts before the clean pair above failed with `G10 ... no scoreboard
line — the gate produced nothing`: this machine was running a parallel workstream's
board (fix-dq-strings ffmpeg + chromium at ~125% CPU each, load avg 20+), and each
timed-out G10 leaves the app's server-side walkthrough capture (ffmpeg) running, which
then collides with the next click. After waiting for the other tree's board to go
quiet and killing only MY scratch's stray capture processes (owners identified by cwd
before any kill), the same commands passed deterministically. Nothing in this change
touches G10; the flake reproduces without it (it is a resource-contention property of
running two walkthrough captures at once) and is on record for the loop.

## Closing boards (this tree, manifest live)

```
$ GATE_BASE=http://localhost:5312 node scripts/gates/sheets/run-all.mjs
  SG1 216 · SG2 24 · SG3 283 · SG4 36 · SG5 67 · SG6 16 · SG7 207 · SG8 12 ·
  drawing-set 293 — 9/9 passing (495.2 s) — ALL SHEET GATES GREEN.
$ GATE_BASE=http://localhost:5312 bash scripts/verify-all.sh          # quick form
  VERIFY OK — 61/63 steps green, 2 skipped (named: cargo — no Rust in this
  change; supabase RLS — no reachable Postgres, the standing env skip)
$ cd web && pnpm typecheck                                            # green
```

## Terminal state

**GREEN.** Pre-registration honoured: board counts unchanged (59 17 92 18 70 53 19 9
24 14 56, all matching the 1a2b8d5 baseline on the closing run), only the pin shape
changed — plus the fixture and this report. Scope: `sg5-board-integrity.mjs`,
`scripts/fixtures/g-board.manifest.json`, this file; no gate G1–G13 was edited in this
mission's tree (sabotage edits lived and died in the two scratch worktrees, both
removed).
