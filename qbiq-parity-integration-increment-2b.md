# MISSION: QBIQ PARITY — INTEGRATION 2b. THE CORE FILES, THE LEDGER, THE INHERITANCE, THE VERDICT.

Read `qbiq-parity-endgame.md`, `qbiq-parity-integration-round.md` (still governs),
`reports/INTEGRATION-two-lines.md`, and the ledger tail. This prompt supersedes the
prior "item 2–6" framing on one point of fact, measured at the end of the last session
and stated in §2 below: **the test delta is not "A's three extra tests."** It is seven
in A, four in the merged tree, and three of the seven are the same property B already
has under a different name. Plan for a collapse, not a port.

---

## STATE AT HANDOFF (verify each before trusting it — R19)

| | |
|---|---|
| branch | `integration` @ **`5ef8b76`** |
| increments | `a3d5258` (1/2), `5ef8b76` (2a) — **both signed** (`gpgsig` header present; `%G?` reports `N` only because `gpg.ssh.allowedSignersFile` is unset, which is a verification gap, not an absence — check the object, not the summary) |
| tags | `premerge-line-a` = `048d99e`, `premerge-line-b` = `6e49ba3` |
| board | Rust **200**, battery **53/53** (`--full`, alone, fresh artifacts). Merged **sheet board NOT run since the merge began — not claimed.** |
| worktrees | `/tmp/ds-wt-line-a` is open and attributed (Line A @ 048d99e, deps linked). Reuse it; `bash scripts/worktree.sh done line-a` when finished. |
| disk | ~40 GiB at handoff. Check it; this session hit ENOSPC at 100% once and it broke tooling mid-write. |

**Landed already — do not redo:**
* A's plate ownership: `trace_floor_polygon` **deleted**, its three call sites on A's
  routing, A's `layout/tests.rs`, A's `geometry.rs`/`model.rs`/`grid.rs`/`fixtures.rs`.
* Capacity duplicate collapsed as a **union**: A's `seat_estimate_for_ordering()` (name
  guard) + B's `capacity_from_area(area)` (type guard). B's inline `unassigned` copy
  deleted for A's `unassigned_area` owner.
* Area mechanism: A's `publishedArea.ts` accessors, A's throw replacing B's `NaN` and
  B's silent-empty, one `toFixed` for all areas, A's 1159-check `publishedArea.test.mjs`
  green with two assertions repointed at surviving mechanisms.
* `area-census` register reconciled to the merged population twice.

---

## §1 — PRE-FLIGHT (fail fast)

1. `git log --oneline -3`; confirm `5ef8b76`. Confirm both tags resolve.
2. **Freshness precondition** (standing convention, from this session's two near-misses):
   `make wasm` and `node scripts/gen-zone-domain.mjs` BEFORE any measurement. A stale
   wasm read nearly recorded a false falsification-failure and was caught only by
   surprise at a number; surprise is not a guard.
3. `bash scripts/verify-all.sh --full` — expect **53/53**. If not, stop and diagnose;
   do not start §2 on a red tree.
4. 1Password auto-locks. If a commit dies with `1Password: failed to fill whole buffer`,
   unlock the app (Settings → Developer → "Use SSH agent" on) and retry. Keep history
   signed; `--no-gpg-sign` is last resort and must be noted **in the commit message**.

---

## §2 — THE CORE FILES AND THE TEST DELTA (the measured reality)

### The delta, already measured — use it, verify it, do not re-derive blindly

`cargo test -p ds-core -- --list` on both trees, diffed:

**IN A, NOT IN MERGED (7):**
```
cost::tests::enclosed_premium_reads_the_area_basis
metrics_tests::a_disjoint_neighbouring_loop_is_not_this_plans_floor
metrics_tests::every_conjunct_is_declared_graded_and_reached
metrics_tests::every_published_wasm_surface_is_exercised_or_exempt
metrics_tests::the_area_basis_clips_each_zone_to_the_plate_polygon
metrics_tests::the_published_seat_count_reads_the_area_the_row_bills
tests::no_unregistered_production_site_reads_the_raw_per_zone_areas
```

**IN MERGED, NOT IN A (4):**
```
metrics_tests::every_published_surface_is_classified
metrics_tests::the_basis_conjuncts_are_enumerated
zone::tests::capacity_seats_nobody_exactly_where_the_usable_partition_does
zone::tests::ground_is_never_usable
```

### THREE OF THESE ARE THE SAME PROPERTY TWICE — collapse, do not stack

| property | A's name | B's name | disposition |
|---|---|---|---|
| every published wasm surface is classified/exercised | `every_published_wasm_surface_is_exercised_or_exempt` | `every_published_surface_is_classified` | **ONE survives.** B's anchors on `#[wasm_bindgen]\nimpl Editor {` and the adversary proved it MISSES file-scope exports (`open_share`, `door_depth`, `door_width` are live and unclassified). Check whether A's sees them. **The one that sees more wins; if A's evaluates the compiled surface rather than parsing, A's wins outright (R20).** The loser's distinct assertions fold into the survivor. |
| the basis conjuncts are enumerated (R18) | `every_conjunct_is_declared_graded_and_reached` | `the_basis_conjuncts_are_enumerated` | **ONE survives.** A's name claims a third property B's lacks — *reached*. If A really proves each conjunct is REACHED (not merely declared), that is strictly stronger and B's folds in. Verify by reading, then by sabotage: make a conjunct unreachable and see which reds. |
| the published seat count reads its own row's area | `the_published_seat_count_reads_the_area_the_row_bills` | `capacity_seats_nobody_exactly_where_the_usable_partition_does` | **Probably COMPLEMENTARY, not duplicate** — B's ties the rate table's zero-set to the usable partition; A's ties the published count to the published area. Keep both only after proving they fail on different sabotages; if one subsumes the other, collapse. |

**Genuinely new from A (4) — these must arrive:**
`cost::tests::enclosed_premium_reads_the_area_basis` ·
`a_disjoint_neighbouring_loop_is_not_this_plans_floor` (plate containment — likely the
density-off-1.20 m² family) · `the_area_basis_clips_each_zone_to_the_plate_polygon` ·
`no_unregistered_production_site_reads_the_raw_per_zone_areas` (A's Rust-side census).

**Genuinely B-only (1):** `zone::tests::ground_is_never_usable` (R22's partition guard).

### R11 PREDICTION — declare BEFORE the batch, verify after

The naive "200 → 203" is **wrong if the collapses happen**. Declare the arithmetic
explicitly, e.g. `200 + 4 new + (3 A-names − 3 B-names if collapsed 1:1) = 204`, or
whatever your collapse decisions imply. **State the number and the reasoning before
touching a file**, then verify. A prediction that cannot be wrong is not a prediction.

### The files

`metrics_tests.rs`, `lib.rs`, `quantity.rs`, `cost.rs`, `zone.rs`, the eleven
`web/src/export` conflicts, `ai/engine.ts`, `ai/evaluator.ts`.

**Method that worked twice already:** take A's whole file, let the compiler name what
breaks, then reconcile each break by choosing a mechanism — never by making both
coexist. The census will red as the site population moves; **reconcile the register
after, never before.**

**Every conflict resolved by choosing records WHY in the ledger, one line each.**
Retired mechanisms lose their NAMES (the `trace_floor_polygon` standard). No shadows.

---

## §3 — THE LEDGER INTERLEAVE (the most delicate step; treat it as such)

The ledger is the mission's primary artifact — the retractions more than the fixes.

1. Both sequences chronological, line-tagged `A:` / `B:`.
2. **Zero dropped retractions.** After writing, sample-verify: pick **five** retractions
   from each pre-merge tail (`git show premerge-line-a:docs/audits/LOOP-LEDGER.md`,
   same for `-b`) and confirm verbatim survival. Report the sample, not just the claim.
3. **Independently-earned findings carry BOTH provenances.** Zone 244 and the
   R14-rustc-scope diagnosis were found twice, independently. Say so — replication is
   evidence, and burying it loses the strongest thing the parallel lines produced.
4. **Rule mapping table.** Both lines promoted rules after the fork. Identical semantics
   merge under one number; distinct semantics renumber. A rule's identity is its
   content, not its number. Record the table.
5. A's belief verdicts are recorded as **scoped to A's tree** — they do not cover the
   merge.
6. Record the `paint.ts` finding prominently: A's allowlist said the epsilon was "never
   printed", B found it published as `stat?.area ?? Math.abs(a2)/2`. **Each line held
   half the truth about one file.** That is the merge's justification in one example.

---

## §4 — A's INHERITANCE (against the full merged tree)

1. **HANDOFF REVISION 2's six numbered items** join the backlog in their stated
   dependency order.
2. **A's five live defects, reconciled:**
   * **A.09 is the zone-244 family** — verify the merged fix against A's EXACT repro,
     do not assume coverage.
   * **density-off-1.20 m²** is the plate-collapse family — increment 1 deleted
     `trace_floor_polygon`, which **may already have closed it. Verify, don't assume.**
   * **the 15.28-point un-de-overlapped penalty** — NEW carried item.
   * **five 6 m² workstations in an 8 m² room** — NEW carried item (B closed one face
     of the capacity/area contradiction; A measured another).
3. **The doc-comment grep over the MERGED tree.** *A comment explaining why an old rule
   was wrong means the old rule is live elsewhere.* Both lines' comments now coexist, so
   the yield doubles. Grep shapes: `used to be`, `was a defect`, `deleted rather than`,
   `would clobber`, `must not fire`, `no longer`, `previously`. **Every hit gets
   value-verification (R20)** — read the source, then RUN something that proves the old
   rule is dead.
4. **Basis anchors.** A proved **371 326 conjunct evaluations sit byte-identical under a
   5% basis error** — every conjunct descends from the shared basis, so none can see the
   basis move. Land checks independent of it: hand-computed fixture values, the
   reference's stated areas, physical invariants (`capacity × footprint ≤ room area`).
   **Falsify by injecting a 5% basis error and watching the anchors red where the 371 326
   stayed silent.**
5. **R16 taxonomy over A's 41 conjuncts** — eleven guards wearing check grades;
   **S08 is `Point::dist` retyped and is 43.8% of the advertised check total.** Guards
   leave the check count.

---

## §5 — THE MERGED BOARD, CLAIMED FROM DIRECT RUNS ONLY

Freshness precondition, then: full battery, `scripts/gates/run-all.sh`, and the merged
sheet board (B's SG1–SG7 + the `drawing-set` row) — **now grading A's core work for the
first time.**

**The first-value test.** Does B's cross-surface machinery, now running over A's cost
surfaces, catch A's own rupee-exact defect on its own?

> `stats.ts` bills NIA where `cost.rs` bills GEA — headline − panel = (GEA − NIA) ×
> 14 000, exact to the rupee across 25 states, **−35.75% on F3 unedited**; an imported
> DWG bills **₹0 of partition** in its headline.

**Either outcome is a ledger entry.** A catch proves the mechanisms generalise beyond
the line that built them. A miss is a **gate-scope finding that outranks the cost fix** —
fix the gate first, then the cost.

---

## §6 — CLEAR THE BACKLOG, *THEN* BELIEF ATTEMPT SIX

**Land these BEFORE dispatching.** The established restraint: a verdict with known opens
is theatre, and this session withheld belief twice for exactly that reason.

* **R23 — pins become manifests**, on the merged SG5. A pin is a manifest of named
  members, not a count: 26 checks died in three events masked by larger increases.
  Reconstruct from the bisect table in the ledger; each of the 26 recovered or formally
  retired with attribution. Record the 64-commit false-pass window and the **+39
  outside SG5's own stated window** in the pin's provenance. Falsify: remove one named
  check while adding two — the manifest reds where the count stayed green.
* **The three measured opens:** (1) battery blind to `isGroundZone` narrowing — add a
  ground-MEMBERSHIP mutation class, falsify by narrowing `planGraphic` and watching the
  battery red where 51 steps stayed green; (2) `groundConsumers`' uniform-16 m² fixture
  makes three assertions measure cardinality not membership — break the symmetry, prove
  they distinguish membership by swapping two zones' types; (3) the surface census
  misses file-scope `#[wasm_bindgen]` exports — grow it (or take A's, per §2), classify
  `open_share`, `door_depth`, `door_width`.
* **The janitor's four sabotages** re-run against the hardened `scripts/worktree.sh`:
  cross-session `--force`, `rm -rf` before tag check, unchecked tag write, a report
  describing an untaken action. All four are claimed closed — prove it.

### Then dispatch the ADVERSARY (R19 + R21)

R19: **the producer never certifies its own work.** R21: **the run returns a coverage
statement — every assigned item DONE / FOUND / SKIPPED-because.** An unreported skip
downgrades the verdict's scope by that item; a reported skip costs nothing.

Scope: the integration-specific hunts (**shadowed implementations** — any file where
both lines' mechanisms survive in parallel is the merge's own hiding place; **ledger
sampling**; **the duplicate-collapse sabotage** — sabotage the surviving mechanism and
confirm the retired line's tests left no green shadow; **the cost defect's
disposition**), the domain family, the manifests, the three opens, the janitor, the
standing re-runs, the taxonomy, and the free hunt.

**Eight rounds say the next class is the one nobody lists.**

If BELIEVED: the first believed board — the ledger enumerates the closed classes
(compiler/in-crate, population, surface, language, conjunct, asserting-file,
private-definition, form-reader, authored-domain) plus the tenth if this round closes
one, names the foundations plainly, and says what it does **not** cover. If a survivor:
that is the tenth class and the next session's first work.

---

## §7 — THE ENDGAME (unblocked only by the verdict, on the one tree)

P1 finding 8 + the band → P2 W1 → P3 network → P4 optimizer → P5 alternatives →
P6 BOMA + verifier → P7 wild plates → P8 product-in-use → P9 vocabulary routing →
P10 close-out + G10 → merge-to-main with R11 predictions and a post-merge adversary run.

---

## STANDING CONVENTIONS (all earned in this mission; violations are findings)

* **Observe the thing, not a proxy.** Never judge pass/fail through `tail`/`head`/`grep`
  — read the summary line. `pnpm typecheck` cannot see Node's raw-ESM resolution;
  `%G?` cannot see a signature without `allowedSignersFile`; a grep cannot see
  semantics. **The instrument must be able to SEE the failure mode it certifies
  against**, and be shown red on the broken state in that session.
* **The brief is a hypothesis.** This session's own A-as-base recommendation was
  falsified by measurement. Falsify the brief as readily as the code.
* **Freshness first.** Assert you are measuring what you just built.
* **A digest/pin/claim is a claim.** Provenance is required, not optional.
* **Retired mechanisms lose their names.** No shadows, no deprecations.
* **Never run the battery and the sheet board concurrently** — measured contention
  produces a false red.
* **Disposable worktrees via `scripts/worktree.sh`**, attributed at creation; never
  remove a tree you did not create.
* **Commit at increment boundaries.** Committed green and recoverable beats complete
  and abandoned.

## EXIT

1. Both lines fully on `integration`; no shadowed mechanisms; the test delta resolved by
   collapse-or-port with the R11 prediction verified.
2. One ledger, sampled-verified lossless, rule mapping table recorded.
3. Inheritance landed: grep run with value-verification, anchors in and falsified,
   taxonomy applied, five defects reconciled, HANDOFF REV 2 queued.
4. Merged board green from direct runs; the cross-surface-vs-cost-defect result recorded
   either way.
5. Backlog cleared, then the ADVERSARY's verdict with mechanically-checked coverage.
6. Ledger complete; HANDOFF if context demands.

Begin with §1, then §2's R11 prediction — **name the number and the reasoning before
touching a file.**
