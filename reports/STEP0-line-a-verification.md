# Step 0 — Line A verified directly, and two premises corrected

**Written by `session-c`. No branch was merged, rebased, reset or force-moved.**
The only writes were two tags (`premerge-line-a`, `premerge-line-b`), a new
worktree, and this line's own branch. The shared checkout was not written to.

Every number below came from a run in this session on freshly rebuilt artifacts.
Where a number is inherited rather than measured, it says so.

## 0.1 — Disk

**40 GiB free** at Step 0. The precondition (≥ 8 GiB) is met with room.

The prior rounds' constraint is worth restating rather than assuming retired:
isolated `CARGO_TARGET_DIR` per worktree is **mandatory** (cargo's `-C metadata`
collides across worktrees at one commit and freshness is mtime-based, so a
sabotage worktree gets served the previous one's binary and reports its panic
string verbatim), and each costs 250–500 MB. Three rounds have ended at or near
zero bytes; two lost measured results.

## 0.3 — Both pre-merge states tagged

`premerge-line-a` → `048d99e` · `premerge-line-b` → `6e49ba3`. Done **before** any
other action in this session, so the pre-merge states were unreachable-proof from
the first minute rather than from the end of Step 0.

## 0.2 — Line A, measured

Checked out at `048d99e` in `/private/tmp/ds-wt-line-a`, wasm rebuilt (freshness
precondition satisfied, not assumed), then:

| | result |
|---|---|
| `bash scripts/verify-all.sh --full` | **`VERIFY OK — 51/51 steps green`** |
| `node scripts/gates/sheets/run-all.mjs` | **5/6 passing**, `SG5 Board integrity FAIL (29 checks, 27 failing)` |
| `node scripts/drawing-set.test.mjs` | **`drawing-set FAIL (339 checks)`**, 21 failures |

**Line A's ledger claim is licensed by measurement.** It claimed Rust 203 /
battery 51/51; the battery reproduces exactly. This matters because the
integration plan treats one line as base and the other as the ported side, and
that choice must rest on a run rather than on either line's own account of itself.

**The inversion holds: B is base, A ports on.** A's sheet board is red where B's
unique work is green, and the port is 9 files rather than 24.

## Correction 1 — the drawing-set files are in the MERGE BASE, not unique to B

`reports/INTEGRATION-two-lines.md` lists under *"Work unique to Line B (24 files)
— not present in A at all"*:

> **The whole drawing-set round**: `scripts/drawing-set.test.mjs` (red at base
> with 19 failures for 73 commits), its baseline with per-digest provenance,
> `sg5-board-integrity`, **`sg7-area-identity`**, the sheet board's `drawing-set` row

Measured with `git ls-tree` against all three refs:

| path | base `49502e5` | Line A `048d99e` | Line B `6e49ba3` |
|---|---|---|---|
| `scripts/drawing-set.test.mjs` | **present** | present | present |
| `scripts/fixtures/drawing-set.baseline.json` | **present** | present | present |
| `scripts/gates/sheets/sg5-board-integrity.mjs` | **present** | present | present |
| `docs/design/drawing-set-generator.md` | **present** | present | present |
| `scripts/gates/sheets/sg7-area-identity.mjs` | absent | absent | **present** |

Four of the five predate the fork. **Only `sg7-area-identity.mjs` is a file unique
to Line B.**

This does not weaken B's claim — the report's own parenthesis says the fixture was
*"red at base with 19 failures for 73 commits"*, which is only sayable if it
existed at base. B's unique contribution is **the fix and the provenance-bearing
baseline**, not the fixture's existence. But the distinction changes the port: a
file present on both sides is a **content reconciliation**, not a copy, and the
baseline in particular now has two divergent versions with a shared ancestor. A
port plan that treats these as "B's files, absent from A" would overwrite A's side
silently instead of reconciling it.

## Correction 2 — A's "27 failing" is inflated by absent artifacts, not by Line A

SG5 reported 27 failing of 29 checks on A. They are **two different populations**,
and only one is a Line A property:

- **~25 failures of the form** `G10 check count is 14 — no scoreboard line`,
  `G11 is on the board — no scoreboard line — the gate produced nothing`,
  `the closing integrity pass still runs 12 checks — no integrity line on the
  board`, `the runner reports a gate that exits 0 while printing FAIL as RED — no
  GSELF line`. SG5 reads the **deliverable-pack gates board's** output. I never ran
  `scripts/gates/run-all.sh` in that fresh worktree, so there was no board output
  to read. **These are my setup, not Line A's state.**
- **2 failures that are real Line A state:** `drawing-set.test.mjs passes — it says
  FAIL` and `drawing-set.test.mjs still runs 283 checks — 339 checks now, 283 at
  the baseline`.

The artifact-independent measurement is the fixture run directly: **21 failures
across 339 checks**, distributed `dwg A.01 ×6 · dwg A.02 ×6 · dwg sheets 3,4,5,6,11
· seeded sheets 3,4,6,11`.

**The brief states 19; I measured 21.** Not a contradiction to resolve by
averaging — different trees or different moments. 21 is what `048d99e` produces
now, and it is the number this line will hold the merged tree to.

> **The general form, worth carrying:** a gate that reads another board's output
> fails *loudly and in bulk* when that board has not run, and those failures are
> indistinguishable at a glance from defects in the tree. A board-reading gate
> should assert its input exists before grading it — *a missing input is a
> FAILURE, never a skip*, and it should also never be reported as 25 separate
> defects in the subject. Recorded as an observation about SG5, not fixed by this
> line (session-c writes no source).

## Correction 3 — the exit criterion contradicts Step 1

The round's **Step 1** reads *"B is base, A ports on … A's 9 unique files."* The
round's **Exit criterion 1** reads *"One tree, A-based (or inverted with the
measured reason), B's 24 files ported."*

Step 1 already records the inversion; the exit criterion still carries the
pre-inversion wording. Measurement agrees with Step 1. Flagged so the closing
audit is not run against the stale sentence.

## What session-c did NOT measure

**Clean Line B.** The shared checkout was, at the time I ran there, already
carrying an in-progress port of A's core files onto B — 11 modified paths, staged.
Two numbers I took there (`drawing-set PASS (329 checks)` and sheet board
`7/8 passing`) are therefore **measurements of B-plus-a-partial-port, not of Line
B**, and are recorded here only so nobody later mistakes them for a Line B
baseline. They are not cited as evidence for anything.

That partial port became commit `a3d5258` *"Integration 1/2"* on branch
`integration` while this session was measuring. See `docs/audits/SESSION-REGISTRY.md`.

## Disposition

Step 0 is complete and its preconditions are met. The merge is owned by
`session-integration`; `session-c` does not perform it and takes **Step 3 — belief
attempt six against the merged tree** instead, as a party that did not author the
merge.
