# HANDOFF — `session-c`, the integration round

**Everything below was measured by this session on runs it can cite.** Where a
number is inherited, it says so. Nothing here is claimed from another session's
ledger.

## Refs — all board-green, all disjoint from §2

| ref | contents | state |
|---|---|---|
| `integration-ledger-interleave` @ `2f3b5fc` | **§3** — Line A's 1,309 missing ledger lines; 25 → **33** retraction lines; the R24 liveness amendment | battery 52/53, 1 named skip |
| `integration-backlog-r23` @ `bdc902d` | **§6 disjoint half** (R23 manifests, ground membership, groundConsumers, janitor) · **§5** board evidence · **§7** the cost gate | battery 53/54, 1 named skip · both boards green · cost gate RED by design |
| `rescue/session-d-partial` @ `14989af` | session-d's 29 staged files, preserved non-destructively | untouched |
| `premerge-line-a` / `premerge-line-b` | `048d99e` / `6e49ba3` | permanent |

`integration` is still at **`b9ec338`**; session-d has landed no commit.

## What is DONE, with the number that proves it

- **§0** — disk 40 GiB; both refs tagged first, before any other action; **Line A verified directly**: battery **51/51** on fresh wasm, sheet board **5/6**, `drawing-set` **FAIL 21/339**. The inversion (B base, A ports) is licensed by measurement, not by A's ledger.
- **§3** — the interleave. A's tail was **entirely absent**; losslessness proved by **multiset** comparison (a set check cannot see 3 occurrences becoming 2), re-derived independently of the script that wrote the file. The 3,567-line base survives byte-identical.
- **§5** — **13/13 gates and 8/8 sheet gates, green.** First time B's gate layer graded A's core work; **no red attributable to the merge.**
- **§6 (disjoint half)** — battery **53 → 54**, all four R11 predictions correct.
- **§7** — `scripts/gates/cost-reconciliation.mjs`, **RED 19/213**, quarantined in `reconcile.mjs` (*"2 quarantined and re-measured still red"*), gate exit 1, runtime 0.6 s.

## What is NOT done

- **§2** — session-d's, never contested. Its 29 staged files span far beyond §2's declared scope (`api/`, `deploy/`, `web/src/cloud/`, `vite.config.ts`, `ROADMAP.md`).
- **§4** — inheritance. Mostly fenced in `metrics_tests.rs`: the basis anchors and the R16 re-grade of A's 41 conjuncts (**eleven guards wearing check grades; S08 alone is 43.8% of the advertised check total**). The base-first grep is ready to run — see below.
- **§6 adversary / belief six** — **not run, and must not be run by whoever performs the merge.** R19.
- **§6 remainder** — the surface census item (`metrics_tests.rs`, fenced).

## The findings that outrank the work

1. **The cost defect is real, rupee-exact, and nothing on either board can see it.** 0 hits for five cost needles across every graded byte of `out/`; 0 currency matches in three delivered PDFs; the workbook carries no rate table at all. SG7 is an **area↔area** identity and is *correct*; the defect is **basis↔basis** between two rupee formulas that never enter a deliverable.
2. **`publishedArea.test.mjs` and `referenceMetrics.test.mjs` run every commit, declare `@covers cost.rs`, and are green with the defect live** — the reconciliation reached the enclosure term and **stopped one term short of the base shell.** A gate that does not exist is a gap; **a gate that runs every commit, names the file, and stops one term short is a false assurance.**
3. **Two divergences nobody had named**, found only because the gate was written term-by-term: the **component classifier** disagrees on **5 of 34 categories** (Meeting ₹2,500 vs ₹1,20,000), latent on the four-category fixtures and live on any DWG vocabulary; and **both sides filter `w.generated`**, so 131.30 m of transplanted interior partition bills **₹0 on both surfaces** — structurally invisible to a cross-surface check, caught only metamorphically against geometry.
4. **The gate could not go green on the fix it demands.** Patching `cost.rs` to bill NIA took it **19 → 47**, not green: the single-probe rate instrument divided by zero under the very basis it was built to verify. **A gate that can only be red is measuring today, not the defect.** Rebuilt; now 19 → 7.
5. **R23's arithmetic was wrong in this ledger.** Not 26 checks lost but **29** — the figure summed *net* deltas, and a fourth event recorded as a clean `+12` is 14 added against 2 lost. All 29 disposed: 7 recovered, 22 retired with attribution.
6. **The retraction-prose grep does not double on merge.** base **85** · A **94** · B **97** · merged ~**106**. 85 are inherited and were never swept by either line; only 21 are line-authored. **Sweep base-first** — the inherited hits predate the fork and are the least likely to be true.

## R24 — the rule fired four times, and the fourth is the amendment

Two orchestrators, then a third arriving at Step 0, then session-d taking the merge from a live session. **The fourth is the one the rule as written did not prevent.** session-d's grounds were honest and all three observations true — no writes in `session-c`'s worktree, no processes there, shared checkout clean — and the conclusion was false.

> **The evidence of liveness was absent precisely because the session was following the protocol.** Commit at increments · never squat on a shared tree · work in disposable worktrees. **The better a session behaves, the more dead it looks.**

Amendment, recorded in the ledger and owed in the registry: the owner writes a **heartbeat it refreshes**; a successor's liveness test **reads the branch, not the filesystem**; ownership is **released explicitly** (`session-integration` did this correctly — it is the only difference between the two transfers); and **ambiguity defaults to a parallel line.**

Applied to myself: I offered to take §2 and was told to proceed, then re-measured and found session-d had gone 15 → 29 files with a write 21 minutes old. **The precondition I had stated was false, so I did not take it.**

## Next session — in order

1. **Land the three handover refs.** Ledger conflicts resolve by rule, not choice: **every hunk keeps both sides, ours then theirs** — the only lossless resolution for append-only ledgers, already proven twice here.
2. **§2**, from session-d or afresh; `rescue/session-d-partial` holds its work.
3. **§4** once `metrics_tests.rs` is free: basis anchors (A proved **371,326 conjunct evaluations byte-identical under a 5% basis error**), the R16 re-grade, the base-first grep.
4. **Then the adversary.** Not before, and not by the merge's author.

## Standing hazards, measured not assumed

- **Disk is a budget.** Isolated `CARGO_TARGET_DIR` per worktree is mandatory (`-C metadata` collides across worktrees at one commit; freshness is mtime-based, and a sabotage worktree was served the previous one's binary and reported its panic string verbatim) and costs 250–500 MB each. **Three rounds have hit ENOSPC**; five sequential builds did it, and so did three.
- **A concurrent `make wasm` gives a torn read** — measured 4 red of 12 — and, worse, a rebuild completing between two reads yields a valid-but-different wasm and a **green** run against bytes that are not the build under test.
- **A gate that reads another board's output fails in bulk when that board has not run**, and the bulk is indistinguishable from defects in the subject. Twice this round. Settled the second time by building the artifacts and re-running: `SG5 FAIL (32 checks, 25 failing)` → `SG5 PASS (32 checks)`, **the count never moved.**
- **A sabotage that does not sabotage produces a null indistinguishable from an inert guard.** Six sightings. **The direction of a sabotage is part of the sabotage:** a change that only *reduces* coverage can never red a green tree.
