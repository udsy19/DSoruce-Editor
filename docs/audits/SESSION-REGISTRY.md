# Session registry — one writer per branch (R24)

**R24. One writer per branch; concurrent lines declare themselves at birth.**

Two orchestrators wrote one mission without knowing of each other. The cost was
27 conflicting files, two ledgers, and two independent implementations of one
mechanism — none of it wasted, all of it avoidable.

## The protocol

1. A session opening work on a mission branch **reads this file first**.
2. It then **writes its own declaration** here — session id, branch, scope, state —
   and commits that before it commits any work.
3. Finding a **live declaration it did not write** for the branch it wanted, it
   takes a **NEW branch named for its line** and proceeds as a declared parallel
   line. It does not write to the other line's branch or worktree.
4. **Worktree attribution extends to branches.** A worktree is owned by the
   session named in the declaration that claims its branch.
5. **Integration of parallel lines is a NAMED PHASE with a single owner** — never
   an ambient merge. The owner is recorded here before the first port lands.

A declaration is retired by marking it `FINISHED` with its closing state, not by
deletion — a line that ended is evidence, and its pre-merge ref stays tagged and
reachable forever.

## Why the protocol has this shape

The failure was not that two sessions worked at once — parallel lines are useful,
and these two were complementary. The failure was that **neither knew**, so
neither could take the other's findings, and both paid full price for the same two
discoveries (zone 244, and R14's rustc-scope failure). Declaration is cheap;
rediscovery is not.

The corollary is the part that bites: **an integration is itself work on a mission
branch**, so it declares too. This registry was created during the integration
round, when a third session began its Step 0 measurements and found a second
session already committing `Integration 1/2` into the shared checkout — R24 firing
in real time, against the round convened to fix it.

---

## Declarations

### `session-a` — Line A · **FINISHED**

- **Branch:** `qbiq-parity-endgame` · **pre-merge tag:** `premerge-line-a` → `048d99e`
- **Worktree:** `/private/tmp/endgame-int` (retired at closure)
- **Scope:** the area / plate / cost axis. One area definition across the wasm
  boundary; the seat count reading the floor its own row bills; plate-polygon
  ownership; the cross-language quantity census; the basis-clip guard.
- **Closing state (measured, not claimed):** Rust **203** · battery **51/51 `--full`** ·
  board printed **36 CHECKS · 8 GUARDS** · belief **NOT BELIEVED ×5** ·
  HANDOFF REVISION 2 carrying six numbered next items.
- **Declared retroactively.** This line predates R24 and never declared at birth;
  that omission is the cause R24 was promoted from.

### `session-b` — Line B · **FINISHED**

- **Branch:** `qbiq-parity-endgame-session-b` · **pre-merge tag:** `premerge-line-b` → `6e49ba3`
- **Worktree:** `/Users/udsy/PycharmProjects/DSource-Editor` (the shared checkout)
- **Scope:** the gate / board / domain axis. The drawing-set round; R12-amended
  `reconcile`; conjunct enumeration; the surface census; `zone_domain!`; `sg7-area-identity`.
- **Closing state (per its own ledger; not re-measured by session-c):** Rust 200,
  battery 52/52 `--full`.
- **Declared retroactively**, same cause as `session-a`.

### `session-integration` — the merge · **FINISHED (handed off)**

- **Branch:** `integration` (off `6e49ba3`) · commits `a3d5258` (1/2),
  `5ef8b76` (2a), `411b041` (the handoff document itself)
- **Worktree:** `/Users/udsy/PycharmProjects/DSource-Editor`
- **Scope, delivered:** A's plate ownership (`trace_floor_polygon` **deleted**,
  three call sites routed); the capacity duplicate collapsed as a **union** —
  A's `seat_estimate_for_ordering()` name guard **+** B's `capacity_from_area()`
  type guard; the area mechanism reconciled to A's throw over B's `NaN` and
  silent-empty, one `toFixed` for all areas, A's 1159-check parity green; the
  `area-census` register reconciled to the merged population twice.
- **Closing state (its claim, re-measured by `session-c` at takeover and
  CONFIRMED):** Rust 200, battery **53/53 `--full`** on fresh artifacts. Merged
  **sheet board not run since the merge began — not claimed by either session.**
- **Closed by handing off** `qbiq-parity-integration-increment-2b.md`, a 270-line
  continuation brief carrying §2's measured test delta. It declared its own
  successor rather than stopping silently — which is what made the transfer below
  a declaration instead of a second ambient merge.

### `session-c` — merge continuation · **LIVE, OWNER OF THE MERGE**

- **Branch:** `integration` · own line `qbiq-parity-endgame-session-c` @ `c17741f`
  (Step 0 findings + this registry, ported onto `integration`)
- **Scope:** §2–§6 of the continuation brief. **Ownership transferred by
  declaration**, on these grounds, recorded so the transfer is auditable:
  `session-integration` published a handoff naming its successor's work; no live
  session held `integration` (no writes for ~90 min, worktree clean, board green);
  and the pre-flight was re-measured rather than inherited — 53/53 confirmed.
- **The independence this costs, and how it is repaid.** `session-c` was the
  adversary precisely because *a merge audited by its author is a finder-authored
  fix one level up*. Taking the merge forfeits that. It is repaid by **dispatching
  a separate ADVERSARY for §6/Step 3** rather than certifying its own work —
  R19, the producer never certifies its own work. The orchestrator integrates;
  an agent that did not perform the merge returns the verdict. If that adversary
  cannot be run, **the verdict is NOT written**, not written weakly.

### `session-c` — integration audit · **LIVE**

- **Branch:** `qbiq-parity-endgame-session-c` (off `6e49ba3`)
- **Worktree:** `/private/tmp/session-c`
- **Scope:** Step 0 preconditions (disk, ref tagging, direct verification of Line
  A), this registry, and **Step 3 — belief attempt six, ADVERSARY, against the
  merged tree.** Writes no source. Does not write to `integration`.
- **Why this split is better than the brief's default:** the brief has one session
  merge and then adversary its own merge. The mission's own standing rule is that
  *a fix authored by the finder is calibrated to the finding*; a merge audited by
  its author is the same defect one level up. An adversary that did not perform
  the merge cannot be calibrated to it, and the duplicate-fix collapse (Step 3.3 —
  "confirm the retired line's tests didn't leave a green shadow") is exactly the
  check an author is least able to run against themselves.

---

### `session-d` — merge continuation, increment 2b · **LIVE, OWNER OF THE MERGE**

- **Branch:** `integration` (from `b9ec338`) · **Worktree:** the shared checkout
- **Scope:** §2–§6 of `qbiq-parity-integration-increment-2b.md` — the core-file
  integration, the test-delta collapse, the ledger interleave, A's inheritance.
- **Ownership taken by declaration, on the same grounds `session-c` used** — and
  recorded here in the same form, so the transfer is auditable rather than
  ambient:
  - `session-c` committed `b9ec338` at **19:21:59** and showed **no further
    writes**. Measured at 19:32: no files modified in `/private/tmp/session-c`
    within 60 minutes, no live processes under that path, the shared checkout
    left **clean**.
  - `b9ec338` touched **none** of the three files this session had open
    (`lib.rs`, `zone.rs`, `metrics_tests.rs`) — verified by
    `git show --stat b9ec338 -- <those paths>`, which returned empty. The
    collision was one of **ownership, not of text**.
  - The pre-flight was **re-measured, not inherited**: freshness rebuild
    (`make wasm` + `gen-zone-domain.mjs`), battery **53/53 `--full`**, gates board
    **13/13 ALL GATES GREEN** with the integrity snapshot, Rust **200**, both tags
    resolving, both prior increments carrying `gpgsig`.
- **R24 fired against this session too, and that is the point of recording it.**
  This session began work before reading the registry — it could not have read
  it, because the registry arrived *in* `b9ec338`, 45 minutes after the session
  opened against `411b041`. That is not an excuse, it is the **gap in the
  protocol**: R24 tells a session to read the registry first, and cannot tell it
  to re-read a file that did not exist when it started. **A session holding a
  branch for an extended run must re-check the registry before each commit, not
  only at birth.** Recorded as the protocol's fourth firing.
- **The independence cost is inherited, not discharged.** `session-c` forfeited
  its adversary role by taking the merge and undertook to repay it by dispatching
  a separate adversary for §6. **This session inherits that debt**: it is the
  merge's author and therefore may not certify it. The §6 verdict comes from an
  agent that did not perform the merge, or it is not written.

## Branch and tag map

| ref | is | reachable forever |
|---|---|---|
| `premerge-line-a` | tag → `048d99e` | ✔ |
| `premerge-line-b` | tag → `6e49ba3` | ✔ |
| `qbiq-parity-endgame` | Line A's branch, left at `048d99e` | ✔ |
| `qbiq-parity-endgame-session-b` | Line B's branch | ✔ |
| `integration` | the merge — `session-integration` → `session-c` → `session-d`, each by declaration | live |
| `qbiq-parity-endgame-session-c` | this audit line | live |
| `rescue/parallel-session` | an earlier third party's uncommitted work, preserved | ✔ |

`qbiq-parity-endgame` moves to the merged result **only** after the merge is
board-green and Line A's closure is declared. Both pre-merge tags stay forever.
