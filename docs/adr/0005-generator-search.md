# ADR 0005 — Branch 4a: generator search strategy

**Status:** results in — NULL RESULT; awaiting decision at the merge gate
**Date:** 2026-08-04

**Code anchors:** incumbent `autoGenerate` (`web/src/editor/search.ts`) ·
`STRATEGIES`, `STRATEGY_SEED_STRIDE`, `seedWindowOffset`
(`web/src/editor/strategy.ts`) · the solver `layout::generate`, `layout::score`
(`crates/ds-core/src/layout.rs`) · determinism contract
`tests::golden_generate_output_is_frozen` · harness rules `bench/README.md`

## Scope, and the conflation removed from it before it cost a round

The original Agent-4 list mixed three search strategies with one thing that is
not a search strategy. `validate-repair` guards **LLM-proposed program
parameters before the solver runs**; it composes with every search rather than
competing with any. Scoring it on best-score-within-budget would be scoring it on
not being the thing under consideration — the same conflation that had to be
split in the field for branch 1 (repair vs inference).

- **4a (this ADR)** — search strategies: `baseline`, `evolutionary`,
  `iterative-align`, `hard-constraints`.
- **4b (separate)** — `validate-repair` alone, on its own terms: catch rate on a
  corpus of deliberately bad LLM proposals, false-reject rate on known-good ones,
  repair quality where it repairs rather than rejects. Its bad-proposal corpus is
  built as ground truth **before** the validator exists. Runs after 4a, composes
  with 4a's winner.

**What is NOT in scope: the solver.** `layout::generate` stays exactly as it is,
deterministic per seed. Only the *search over seeds and programs* is swappable.
No candidate may make an LLM emit geometry.

## Seedability — the construction that makes variance definable

Variance-across-runs is undefined for a deterministic incumbent that returns
identical output by design. Rather than exempt one candidate from a metric,
**remove the undefinedness**:

> **Every candidate MUST be seedable: deterministic given a search seed.**

This extends the repo's per-seed determinism up into the search layer. A GA with
a fixed RNG seed is exactly as reproducible as the incumbent. The incumbent
needs no special-casing — `autoGenerate` already takes `opts.seedOffset`, which
*is* its search seed.

"Variance" then means **variance across search seeds at a fixed budget**, which
is defined for every candidate including baseline, and measures
reliability-of-search rather than being a metric one candidate is structurally
excused from.

**HARD GATE — determinism extends to the search layer.** Same
`(program, plate, budget, search-seed)` ⇒ **identical candidate list** (seeds,
strategies, scores, snapshots), for every strategy. A non-deterministic search is
disqualified at any score, exactly as a non-deterministic plate extractor was.

## Budget: fixed `generate()` call count, with wall-clock reported

Wall-clock and iteration-count favour different candidates, so the choice is
justified from measurement rather than taste. On the real 930.1 m² plate:

| | |
|---|---|
| `generate()` | **34.2 ms** |
| `snapshot()` | 0.2 ms |
| `state()` | 0.4 ms |

`generate()` is **161×** the surrounding bookkeeping, and it is the only cost
that scales with search effort.

**Budget = a fixed number of `generate()` calls** (primary), **wall-clock
reported alongside** (secondary, not the score).

- Machine-independent and exactly reproducible, which wall-clock is not.
- It does not hide a candidate's overhead: anything doing enough extra work to
  matter against 34 ms will show it in the wall-clock column.
- It refuses to reward a candidate for calling the solver *less* while claiming
  a better score — the comparison stays "same solver effort, whose search finds
  more".

Budgets: **15, 27 and 51 calls** — the incumbent's own spend at `maxIter` 4, 8
and 16, so the baseline is measured at exactly the budgets it was designed for
rather than at numbers chosen to suit a challenger.

**Loophole closed: work outside `generate()` is invisible to a call-count
budget.** A candidate that improves layouts through the fine-grained mutators
(`move_component`, `resize_zone`) rather than regeneration does real search work
that costs almost nothing in call-count terms. So, pre-registered as a rule
rather than left to the wall-clock column to notice:

> **A candidate whose wall-clock exceeds 2× the incumbent's at equal call count
> triggers a wall-clock-matched re-run, and BOTH results are reported.**

Call count stays the primary ruler — machine-independent and reproducible — but
no candidate can smuggle unbounded off-budget work past it.

The incumbent's `target` early-exit is **disabled for benching**: a candidate
that stops early has not spent the budget, and comparing a partial spend to a
full one measures nothing.

## Metric validity per candidate class

| metric | baseline | evolutionary | iterative-align | hard-constraints |
|---|---|---|---|---|
| best `LayoutScore.total` @ budget | ranking | ranking | ranking | ranking |
| circulation score @ budget | ranking | ranking | ranking | ranking |
| placed desks / pax | ranking | ranking | ranking | ranking |
| variance across search seeds | ranking | ranking | ranking | ranking |
| hard-constraint violations | **diagnostic** | **diagnostic** | **diagnostic** | **gate (must be 0)** |
| determinism | gate | gate | gate | gate |
| wall-clock | diagnostic | diagnostic | diagnostic | diagnostic |

Constraint violations are a **gate only for the code-aware candidate**, which
claims to enforce them in-pipeline. For the others the same number is a
diagnostic: they never claimed it, and gating them on it would be the mistake
this campaign has now made three times.

Any metric added after candidates exist is post-hoc, marked, and advisory until
it survives a round it did not shape (ADR 0004 amendment).

## Fixtures — and what stops this being theatre

Branch 1b's lesson was that fixtures the incumbent aces cannot discriminate. The
search-layer analogue is **fixtures that all favour re-seeding**: a plate where
seed variety alone finds a good answer will rank every candidate the same.

| fixture | why it is in the set |
|---|---|
| **real plate 930.1 m², standard program** | primary — the production case |
| real plate, **dense program** (desks 200) | capacity pressure: re-seeding cannot manufacture room, so a smarter search must show up in placed desks |
| real plate, **explicit `rooms` program** | counts are pinned, so search can only vary layout/scoring — isolates search from program luck |
| **small plate** (~90 m²) | the regime where the incumbent historically hit dead zones; little seed variety to exploit |
| **rot17 / tilted plate** | non-axis-aligned, where the packer's oriented path engages |
| **L-shape / notched plate** | concave, where a corrective step should beat a re-roll |
| **high-constraint program** (corridor 1.5 m, clearance 1.2 m) | the case `hard-constraints` exists for; the others should show violations here as a diagnostic |

The set is deliberately weighted toward regimes where **re-seeding has little to
find** — that is precisely where a genuinely better search must separate, and
where a null result would be meaningful rather than an artifact of easy fixtures.

## Predicted outcomes, with mechanism

Scores are `LayoutScore.total` (0–100-ish scale as produced today). Ranges are
deltas against baseline at the same budget, on the primary fixture.

**`baseline` — disjoint-seed-window re-seeding.** Three strategies × N seeds,
each seed an independent draw; no information carries between draws. Its ceiling
is the best of N independent samples, so it improves roughly with log(N) and
plateaus. Measured reference, not a prediction.

**`evolutionary` — multi-objective GA over program/strategy parameters.**
Mechanism: crossover/mutation over the weight vector and room mix, selection on
`LayoutScore`. Predicted **+2 to +6 total at 51 calls, −1 to +2 at 15 calls** —
a GA needs population turnover before it beats sampling, so at small budgets it
should *lose* to plain re-seeding by spending calls on a population it never
exploits. **If it wins at 15 calls, suspect the implementation is re-seeding
with extra steps.** Predicted variance **lower** than baseline at 51 (selection
concentrates), **higher** at 15 (population noise dominates).

**`iterative-align` — corrective step instead of a fresh draw.** Mechanism:
after evaluating, perturb the current best's placement/program locally rather
than re-drawing a new seed. Predicted **+3 to +8 on the concave and small
fixtures**, where the failure is a fixable local defect, and **−1 to +2 on the
primary**, where the plate is forgiving and re-seeding already samples well.
Its predicted signature is *fixture-dependent gains* — a uniform gain across all
fixtures would suggest it is not actually doing local correction.

**`hard-constraints` — code as in-pipeline constraint (AGPL clean-room).**
Mechanism: NBC 2016 rules as generator constraints rather than post-hoc scoring.
Predicted **0 violations by construction** (its gate) and **−2 to +3 total** —
constraint satisfaction costs search freedom, so a *lower* score at zero
violations is a legitimate, adoptable outcome and must not be read as a loss.
Predicted to win decisively on the high-constraint fixture and to be roughly
neutral elsewhere.

**Licence:** `poolpet/floorplan6` is AGPL-3.0 — **reference only, never
vendored**. Clean-room reimplementation against our own NBC 2016 rules, which
already exist in `layout.rs`/`circulation.rs`.

## Falsification

- `evolutionary`: no gain at 51 calls ⇒ the population never pays for itself at
  the budgets this product actually uses; drop it regardless of asymptotic
  promise.
- `iterative-align`: gains are uniform across fixtures ⇒ it is not doing local
  correction, and the mechanism claim is wrong even if the number is up.
- `hard-constraints`: any violation > 0 ⇒ its one claim is false; drop.
- Any candidate: non-deterministic given a search seed ⇒ disqualified at any
  score.
- All candidates within noise of baseline on every fixture ⇒ **null result**,
  recorded as such. Re-seeding across disjoint windows would then be the right
  design, and knowing that is worth the round.

## Protected invariants

- `layout::generate(program, seed)` unchanged and deterministic; the golden test
  must stay green.
- Claude designs strategy; the solver places every coordinate. No candidate may
  make an LLM emit geometry.
- Consequence-preview-before-apply for AI edits is untouched.

## Note for 4b — corpus provenance tiers

The 4b corpus would otherwise be the synthetic-fixture trap in a new costume: a
validator tested only against failures we imagined scores well and says little
about the failures Claude actually produces. The calibration log's humans-only
discipline does **not** transfer whole — that log needed evidence of human
*trust*, so automation was poison; this corpus needs coverage of Claude's actual
output *distribution*, and a harness driving the real prompt path produces genuine
Claude outputs. **Automation is not the contaminant here; unlabeled provenance
is.** Three tiers, and claims grade by tier:

| tier | source | status |
|---|---|---|
| 1 | hand-authored bad proposals | build-time; scores **advisory only** |
| 2 | harness-elicited across varied briefs (incl. absurd headcounts, contradictory emphasis, tiny plates) | genuine Claude distribution; brief distribution ≠ real users', so labeled |
| 3 | live-session, `isTrusted`-gated, with outcome (applied / rejected / scored-below-base) | **evidentiary** |

Built on 1, validated on 2, **trusted** on 3. Tier 3's outcome label is free
ground truth the refine loop already computes. Corpus size per tier is recorded
so 4b's claims are sized to their evidence.

## Results — a null result, and the metric error that nearly hid it

`node bench/runSearch.mjs`. 4 strategies × 7 fixtures × 3 budgets × 3 search
seeds. Predictions frozen in `9e2a182`.

### The headline metric was invalid, and the first run was a false positive

The first run showed large wins: `iterative-align` +4.1 to +6.8 on the primary,
`evolutionary` +1.6 to +4.8, both far outside their predicted ranges. Checking
*why* before writing it up found the flaw:

> `LayoutScore.total` is a weighted sum **using the program's own weights**
> (`layout/score.rs`: `total = w_capacity·capacity + …`). Two of the four
> candidates MUTATE those weights. They were raising `total` by shifting weight
> onto whatever already scored well — **optimizing the ruler, not the design.**

The fix was already in the codebase: `ai/refine.ts` computes `refScore` against
**fixed** weights for exactly this reason, so an LLM's program change cannot
flatter itself. Every candidate is now scored on the base program's weights
whatever program it searched with.

How much of the apparent gain was ruler-gaming, on `lshape-concave@51`:

| candidate | raw `total` | fixed yardstick | gap |
|---|---|---|---|
| baseline | 90.60 | 88.86 | +1.74 |
| evolutionary | 95.01 | 88.86 | **+6.15** |
| iterative-align | 97.60 | 88.68 | **+8.92** |
| hard-constraints | 90.16 | 88.33 | +1.83 |

The two weight-mutating candidates carry 3–5× the baseline's gap. **Their entire
advantage was the metric.**

### On the fixed yardstick — delta vs baseline, all budgets

| fixture | evolutionary | iterative-align | hard-constraints |
|---|---|---|---|
| real/standard | +0.00 | −0.36 | −0.51 |
| **real/dense** | **+1.57 / +1.61 / +1.73** | −0.30 | −0.65 |
| real/pinned-rooms | −0.05 | −0.11 | −0.61 |
| small-90m2 | +0.17 / 0 / 0 | +0.17 / 0 / 0 | −0.83 |
| tilted-17deg | −0.01 | −0.22 | −0.44 |
| lshape-concave | +0.00 | −0.18 | −0.53 |
| high-constraint | +0.00 | −0.30 | +0.00 |

(three numbers = budgets 15 / 27 / 51 where they differ.)

**This is the pre-registered null result.** Falsification said: *"All candidates
within noise of baseline on every fixture ⇒ null result, recorded as such.
Re-seeding across disjoint windows would then be the right design."*

### Mechanism tells, checked explicitly

- **`evolutionary`** predicted −1 to +2 at 15 calls: **in range** (+0.00). Predicted
  +2 to +6 at 51: **below** (+0.00 on the primary). Its one real gain is
  **+1.73 on `real/dense`**, and it *grows with budget* (+1.57 → +1.73) — exactly
  the mechanism working, in the one regime where program tuning has something to
  find, because `cluster_cols`/`bench_pairs` genuinely change packing under
  capacity pressure. Small, real, and confined.
- **`iterative-align`** predicted +3 to +8 on concave/small: **below** (−0.18 on
  lshape, 0 on small). Its registered tell was *"a uniform gain would falsify the
  mechanism"* — the actual is a **uniform slight loss** (−0.11 to −0.36 nearly
  everywhere), which falsifies it just as decisively: holding the seed and
  climbing in program space finds nothing the seed sweep did not.
- **`hard-constraints`** predicted −2 to +3: **in range** (−0.44 to −0.83). It
  costs a little score everywhere, as constraint satisfaction should. But see the
  gate below.

### The constraint gate is UNRESOLVED, not passed or failed

Every candidate — including baseline — reports **2 violations** on
`high-constraint`. A metric that returns the same value for a candidate designed
to eliminate violations and one that never claimed to is not measuring what it
claims.

`violations()` was written **after** the candidates existed, so per the ADR 0004
amendment it is **post-hoc and advisory**. It reads
`CirculationScore.min_corridor_width`, which is a global minimum over the whole
occupancy grid — including pinch points between furniture — not a corridor-width
compliance check. **`hard-constraints`' one claim is therefore untested**, and
this ADR does not record it as passed or failed. A real check needs a
corridor-specific measure the core does not currently expose.

### Variance across search seeds

Near-zero for every candidate on almost every fixture (sd ≤ 0.03 outside
`real/dense`, where evolutionary shows 0.24–0.66). Baseline's own sd is **0.00**:
different seed windows converge on the same best. That is itself the explanation
for the null result — **the solver's output quality is largely insensitive to
seed on these plates**, so there is little for any search to exploit, and
re-seeding is hard to beat because the thing it varies barely matters.

### Determinism gate

All four pass: same `(program, plate, budget, search-seed)` reproduces an
identical candidate list.

### Recommendation

**Adopt nothing.** The incumbent's disjoint-seed-window re-seeding is the right
design at the budgets this product uses, and that is now measured rather than
assumed.

Two things worth keeping from the round:

1. **The yardstick rule is now load-bearing beyond the AI loop.** Any future
   search comparison MUST score on fixed weights. Registering this as a standing
   rule alongside the metric-validity one — the failure mode is identical in
   shape: *a metric read as a score for something it was not defined over*, here
   across programs rather than across candidate classes.
2. **`evolutionary` under capacity pressure** (+1.73 on dense, growing with
   budget) is the only live thread. It is not adoptable as a general search, but
   "tune `cluster_cols`/`bench_pairs` when the program is capacity-bound" is a
   narrower, cheaper intervention that does not need a GA. Worth its own
   pre-registration if dense fit-outs matter commercially.
